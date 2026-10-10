/**
 * 站内 LLM 智能体运行时：把「指令 + 工具白名单 + 模型配置」跑成一或多轮工具调用，
 * 并把每一次运行（含每一步工具调用）落进运行日志。
 *
 * 工具一律走 Store，并以「触发者身份」做空间角色与表级行列权限校验，
 * 智能体自己不能越过触发者的权限读或写。
 */

import { chatCompletion, type LlmMessage, type LlmToolSpec } from "./llm.js";
import { DomainError, type Store } from "./store.js";
import {
  FIELD_TYPE_LABELS,
  type Field,
  type LlmAgent,
  type LlmAgentRun,
  type LlmAgentRunStep,
  type LlmAgentRunTrigger,
  type LlmAgentToolId,
  type TablePayload,
} from "./types.js";

/** 一轮运行里最多让模型来回几次（一次 = 一个 assistant 回合） */
const MAX_ROUNDS = 8;
/** 单次工具结果写回模型时的最大字符数，避免上下文爆掉 */
const MAX_TOOL_RESULT_CHARS = 6000;
/** 单轮运行最多执行的工具步数 */
const MAX_STEPS = 24;

export type AgentActor = { userId: string; name: string };

export type AgentToolDeps = {
  store: Store;
  /** 按身份可见范围列出候选数据表 */
  listVisibleTables: (
    actor: AgentActor,
  ) => Promise<Array<{ baseId: string; baseName: string; tableId: string; tableName: string }>>;
  /** 读表，已套用该身份的行列权限 */
  readTable: (tableId: string, actor: AgentActor) => Promise<TablePayload>;
  /** 该身份对指定空间是否有编辑权（写工具用） */
  canWrite: (baseId: string, actor: AgentActor) => Promise<boolean>;
};

export type RunAgentInput = {
  agentId: string;
  /** 本轮要模型做的事（对话时是用户这一句） */
  prompt: string;
  trigger: LlmAgentRunTrigger;
  /** 对话所在的数据表 */
  tableId?: string | null;
  /** 工具执行与鉴权用的身份 */
  actor: AgentActor;
  /** 提示词里的时间描述，例如「2026-10-10 09:00（Asia/Shanghai）」 */
  nowLabel?: string;
  /** 追加给模型的上下文说明，例如对话所在表名 */
  contextNote?: string;
  /** 多轮对话里已有的历史（不含本轮 prompt） */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

const TOOL_SPECS: Record<LlmAgentToolId, { description: string; parameters: Record<string, unknown> }> = {
  list_tables: {
    description: "列出当前身份可见的空间与数据表，返回 baseId / tableId。不知道表 id 时先调它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  get_table_schema: {
    description: "读取一张数据表的字段（名称、类型、单多选选项）与视图清单，用来确认可写哪些字段。",
    parameters: {
      type: "object",
      properties: { tableId: { type: "string", description: "数据表 id" } },
      required: ["tableId"],
      additionalProperties: false,
    },
  },
  query_records: {
    description: "按关键词查询一张表里的记录（只读）。返回记录 id 与字段值，可用于后续 update_record / add_comment。",
    parameters: {
      type: "object",
      properties: {
        tableId: { type: "string", description: "数据表 id" },
        keyword: { type: "string", description: "可选，在所有字段里做包含匹配" },
        limit: { type: "integer", description: "返回条数，默认 20，最大 100" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "可选，只返回这些字段（字段名）",
        },
      },
      required: ["tableId"],
      additionalProperties: false,
    },
  },
  create_record: {
    description:
      "在数据表里新建一条记录。fields 是「字段名 → 值」的对象，字段名取自 get_table_schema。写入会记录在案，请只在指令明确要求时调用。",
    parameters: {
      type: "object",
      properties: {
        tableId: { type: "string", description: "数据表 id" },
        fields: { type: "object", description: "字段名到值的映射", additionalProperties: true },
      },
      required: ["tableId", "fields"],
      additionalProperties: false,
    },
  },
  update_record: {
    description: "修改一条已有记录。只传需要改的字段即可，其余字段保持不变。",
    parameters: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "记录 id" },
        fields: { type: "object", description: "字段名到新值的映射", additionalProperties: true },
      },
      required: ["recordId", "fields"],
      additionalProperties: false,
    },
  },
  add_comment: {
    description: "给一条记录写一条评论，用于留痕或通知协作者。",
    parameters: {
      type: "object",
      properties: {
        recordId: { type: "string", description: "记录 id" },
        body: { type: "string", description: "评论正文" },
      },
      required: ["recordId", "body"],
      additionalProperties: false,
    },
  },
};

function clampText(value: string, max = MAX_TOOL_RESULT_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…（已截断，共 ${value.length} 字）`;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return clampText(value);
  try {
    return clampText(JSON.stringify(value, null, 1));
  } catch {
    return clampText(String(value));
  }
}

/** 解析模型给的工具参数：可能是 JSON 字符串，也可能是已经解析好的对象 */
function parseArgs(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    throw new Error(`工具参数不是合法 JSON：${text.slice(0, 200)}`);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function schemaSummary(fields: Field[]): Array<Record<string, unknown>> {
  return fields
    .filter((field) => field.type !== "button")
    .map((field) => {
      const item: Record<string, unknown> = {
        id: field.id,
        name: field.name,
        type: FIELD_TYPE_LABELS[field.type] ?? field.type,
      };
      const options = field.config?.options;
      if (options?.length) item.options = options.map((option) => option.name);
      return item;
    });
}

export class AgentRuntime {
  constructor(private readonly deps: AgentToolDeps) {}

  /** 跑一轮智能体：建运行记录 → 循环调用模型与工具 → 收尾写回日志 */
  async run(input: RunAgentInput): Promise<LlmAgentRun> {
    const { agent, apiKey } = await this.deps.store.getLlmAgentSecret(input.agentId);
    const run = await this.deps.store.createLlmAgentRun({
      agentId: agent.id,
      trigger: input.trigger,
      input: input.prompt,
      tableId: input.tableId ?? null,
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
    });
    const startedAt = Date.now();
    const steps: LlmAgentRunStep[] = [];
    try {
      if (agent.status === "disabled") throw new Error("智能体已停用，未运行");
      if (!agent.provider.baseUrl.trim()) throw new Error("未配置模型地址");
      if (!agent.provider.model.trim()) throw new Error("未配置模型名称");
      if (!apiKey.trim()) throw new Error("未配置模型密钥");
      const effective: RunAgentInput = {
        ...input,
        nowLabel: input.nowLabel ?? (await this.timeLabel(agent)),
      };
      const output = await this.execute(agent, apiKey, effective, steps);
      return await this.deps.store.finishLlmAgentRun(run.id, { status: "ok", output, steps });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`llm agent ${agent.id} run failed`, error);
      return await this.deps.store.finishLlmAgentRun(run.id, {
        status: "failed",
        output: steps.length ? "（运行中途失败，已完成部分工具调用）" : "",
        error: message.slice(0, 2000),
        steps,
      }).catch(() => ({
        ...run,
        status: "failed" as const,
        error: message,
        steps,
        durationMs: Date.now() - startedAt,
      }));
    }
  }

  /** 重试一次失败的运行：沿用原来的输入与触发方式 */
  async retry(runId: string, actor?: AgentActor): Promise<LlmAgentRun> {
    const previous = await this.deps.store.requireLlmAgentRun(runId);
    const agent = await this.deps.store.getLlmAgent(previous.agentId);
    const retryActor: AgentActor =
      actor ??
      (previous.actorUserId
        ? { userId: previous.actorUserId, name: previous.actorName ?? "触发者" }
        : { userId: agent.ownerUserId, name: "智能体负责人" });
    return this.run({
      agentId: previous.agentId,
      prompt: previous.input,
      trigger: "retry",
      tableId: previous.tableId,
      actor: retryActor,
    });
  }

  /** 提示词里的当前时间：优先用绑定空间的时区 */
  private async timeLabel(agent: LlmAgent): Promise<string> {
    let timezone = "Asia/Shanghai";
    if (agent.baseId) {
      try {
        timezone = (await this.deps.store.getBaseSettings(agent.baseId)).timezone || timezone;
      } catch {
        /* 空间被删或读不到，退回默认时区 */
      }
    }
    const now = new Date();
    try {
      const text = new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      return `${text}（${timezone}）`;
    } catch {
      return now.toISOString();
    }
  }

  /** prompt 模式：不调工具，单次生成 */
  private async executePromptOnly(
    agent: LlmAgent,
    apiKey: string,
    input: RunAgentInput,
  ): Promise<string> {
    const result = await chatCompletion({
      ...agent.provider,
      apiKey,
      messages: this.buildMessages(agent, input, []),
    });
    return result.content || "（模型没有返回内容）";
  }

  private async execute(
    agent: LlmAgent,
    apiKey: string,
    input: RunAgentInput,
    steps: LlmAgentRunStep[],
  ): Promise<string> {
    const tools = this.resolveTools(agent);
    if (agent.mode === "prompt" || tools.length === 0) {
      return this.executePromptOnly(agent, apiKey, input);
    }
    const messages = this.buildMessages(agent, input, tools);
    let lastContent = "";
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const reply = await chatCompletion({ ...agent.provider, apiKey, messages, tools });
      if (reply.content) lastContent = reply.content;
      if (reply.toolCalls.length === 0) {
        return reply.content || lastContent || "（模型没有返回内容）";
      }
      messages.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        if (steps.length >= MAX_STEPS) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "已达单次运行的工具调用上限，请基于已有结果作答。",
          });
          continue;
        }
        const step = await this.executeTool(agent, input.actor, call.function.name, call.function.arguments, input.tableId ?? null);
        steps.push(step);
        messages.push({ role: "tool", tool_call_id: call.id, content: step.result });
      }
    }
    // 轮次用尽：要一段收口说明，避免把中间态当结论
    messages.push({ role: "user", content: "请基于以上工具结果，直接给出最终答复，不要再调用工具。" });
    const finalReply = await chatCompletion({
      ...agent.provider,
      apiKey,
      messages: messages.filter((message) => message.role !== "system"),
    });
    return finalReply.content || lastContent || "（模型没有返回内容）";
  }

  private resolveTools(agent: LlmAgent): LlmToolSpec[] {
    if (agent.mode !== "tools") return [];
    const allowed = agent.tools.filter((tool): tool is LlmAgentToolId => tool in TOOL_SPECS);
    return allowed.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool,
        description: TOOL_SPECS[tool].description,
        parameters: TOOL_SPECS[tool].parameters,
      },
    }));
  }

  private buildMessages(agent: LlmAgent, input: RunAgentInput, tools: LlmToolSpec[]): LlmMessage[] {
    const lines = [
      `你是「${agent.name}」，知行人生（DuoWei）多维表格里的智能体。`,
      agent.description ? `简介：${agent.description}` : "",
      "",
      "## 任务指令",
      agent.instructions.trim() || "（未填写指令，按用户的要求作答。）",
      "",
      "## 运行环境",
      `- 当前时间：${input.nowLabel ?? new Date().toISOString()}`,
      `- 触发方式：${TRIGGER_LABELS[input.trigger] ?? input.trigger}`,
      `- 操作者：${input.actor.name}`,
      agent.baseId ? `- 绑定空间：${agent.baseName ?? agent.baseId}（只能操作该空间内的数据）` : "- 绑定空间：不限，按操作者可见范围",
      input.contextNote ? `- 上下文：${input.contextNote}` : "",
    ].filter((line) => line !== "");
    if (tools.length) {
      lines.push(
        "",
        "## 工具使用要求",
        "- 需要表内数据时先调用工具查询，不要凭猜测编造记录内容或字段名。",
        "- 不知道 tableId / recordId 时先用 list_tables / query_records 查出来。",
        "- 只在指令或用户明确要求时才写入、修改数据；写完后在答复里说明改了什么。",
        "- 工具报错时把错误如实告诉用户，不要假装成功。",
      );
    } else {
      lines.push("", "本次不提供工具，请直接依据指令与输入作答。");
    }
    const messages: LlmMessage[] = [{ role: "system", content: lines.join("\n") }];
    for (const turn of (input.history ?? []).slice(-10)) {
      if (!turn.content.trim()) continue;
      messages.push({ role: turn.role, content: turn.content.slice(0, 4000) });
    }
    messages.push({ role: "user", content: input.prompt });
    return messages;
  }

  private async executeTool(
    agent: LlmAgent,
    actor: AgentActor,
    name: string,
    rawArgs: string,
    contextTableId: string | null,
  ): Promise<LlmAgentRunStep> {
    const startedAt = Date.now();
    const base = { tool: name, args: clampText(rawArgs, 600) };
    if (!agent.tools.includes(name as LlmAgentToolId) || !(name in TOOL_SPECS)) {
      return {
        ...base,
        status: "failed",
        result: `工具「${name}」不在该智能体的白名单里`,
        ms: Date.now() - startedAt,
      };
    }
    try {
      const args = parseArgs(rawArgs);
      const result = await this.dispatch(agent, actor, name as LlmAgentToolId, args, contextTableId);
      return { ...base, status: "ok", result: clampText(result), ms: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, status: "failed", result: `执行失败：${message}`, ms: Date.now() - startedAt };
    }
  }

  /** 校验目标表在智能体绑定范围内，并返回所在空间 */
  private async resolveScope(agent: LlmAgent, tableId: string): Promise<{ baseId: string; tableId: string }> {
    if (!tableId) throw new Error("缺少 tableId");
    let located: { baseId: string; tableId: string };
    try {
      located = await this.deps.store.locateTable(tableId);
    } catch {
      throw new Error(`找不到数据表：${tableId}`);
    }
    if (agent.baseId && located.baseId !== agent.baseId) {
      throw new Error("该数据表不在智能体绑定的空间内，已拒绝");
    }
    return located;
  }

  private async assertWrite(agent: LlmAgent, actor: AgentActor, tableId: string): Promise<void> {
    const located = await this.resolveScope(agent, tableId);
    const allowed = await this.deps.canWrite(located.baseId, actor);
    if (!allowed) throw new Error("操作者没有该空间的编辑权限，已拒绝写入");
  }

  private async dispatch(
    agent: LlmAgent,
    actor: AgentActor,
    tool: LlmAgentToolId,
    args: Record<string, unknown>,
    contextTableId: string | null,
  ): Promise<string> {
    const store = this.deps.store;
    if (tool === "list_tables") {
      const tables = await this.deps.listVisibleTables(actor);
      const scoped = agent.baseId ? tables.filter((table) => table.baseId === agent.baseId) : tables;
      if (!scoped.length) return stringifyToolResult({ tables: [], note: "当前身份没有可见的数据表" });
      return stringifyToolResult({ tables: scoped });
    }
    if (tool === "get_table_schema") {
      const tableId = asString(args.tableId) || contextTableId || "";
      await this.resolveScope(agent, tableId);
      const payload = await this.deps.readTable(tableId, actor);
      return stringifyToolResult({
        tableId: payload.id,
        name: payload.name,
        recordCount: payload.records.length,
        fields: schemaSummary(payload.fields),
        views: payload.views.map((view) => ({ id: view.id, name: view.name, type: view.type })),
      });
    }
    if (tool === "query_records") {
      const tableId = asString(args.tableId) || contextTableId || "";
      await this.resolveScope(agent, tableId);
      const payload = await this.deps.readTable(tableId, actor);
      const keyword = asString(args.keyword).toLowerCase();
      const wanted = Array.isArray(args.fields) ? args.fields.map((item) => asString(item)).filter(Boolean) : [];
      const limitRaw = Number(args.limit);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20;
      const names = payload.fields.map((field) => field.name);
      const keep = wanted.length ? names.filter((name) => wanted.includes(name)) : names;
      const matched = payload.records.filter((record) => {
        if (!keyword) return true;
        return Object.values(record.fields).some((value) => String(value ?? "").toLowerCase().includes(keyword));
      });
      const records = matched.slice(0, limit).map((record) => {
        const fields: Record<string, unknown> = {};
        for (const name of keep) {
          const value = record.fields[name];
          if (value != null && value !== "") fields[name] = value;
        }
        return { id: record.id, updatedAt: new Date(record.updatedAt).toISOString(), fields };
      });
      return stringifyToolResult({
        tableId: payload.id,
        table: payload.name,
        matched: matched.length,
        returned: records.length,
        records,
      });
    }
    if (tool === "create_record") {
      const tableId = asString(args.tableId) || contextTableId || "";
      await this.assertWrite(agent, actor, tableId);
      const fields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
        ? (args.fields as Record<string, unknown>)
        : null;
      if (!fields || Object.keys(fields).length === 0) throw new Error("fields 不能为空");
      const created = await store.createRecord(tableId, fields, {
        userId: actor.userId,
        userName: actor.name,
        // 智能体写入不触发自动化，避免「自动化 → 智能体 → 自动化」互相触发
        skipAutomation: true,
      });
      return stringifyToolResult({ ok: true, recordId: created.record.id, fields: created.record.fields });
    }
    if (tool === "update_record") {
      const recordId = asString(args.recordId);
      if (!recordId) throw new Error("缺少 recordId");
      let located: { baseId: string; tableId: string };
      try {
        located = await store.locateRecord(recordId);
      } catch {
        throw new Error(`找不到记录：${recordId}`);
      }
      await this.assertWrite(agent, actor, located.tableId);
      const fields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
        ? (args.fields as Record<string, unknown>)
        : null;
      if (!fields || Object.keys(fields).length === 0) throw new Error("fields 不能为空");
      const updated = await store.updateRecord(recordId, fields, {
        userId: actor.userId,
        userName: actor.name,
        skipAutomation: true,
      });
      return stringifyToolResult({ ok: true, recordId, fields: updated.record.fields });
    }
    if (tool === "add_comment") {
      const recordId = asString(args.recordId);
      if (!recordId) throw new Error("缺少 recordId");
      const body = asString(args.body);
      if (!body) throw new Error("评论内容不能为空");
      let located: { baseId: string; tableId: string };
      try {
        located = await store.locateRecord(recordId);
      } catch {
        throw new Error(`找不到记录：${recordId}`);
      }
      await this.assertWrite(agent, actor, located.tableId);
      const comment = await store.addComment(recordId, actor.userId, actor.name, body);
      return stringifyToolResult({ ok: true, commentId: comment.id, recordId });
    }
    throw new DomainError(`不支持的工具：${tool}`);
  }
}

const TRIGGER_LABELS: Record<string, string> = {
  chat: "表内对话",
  schedule: "定时自动化",
  manual: "手动运行",
  retry: "失败重试",
  api: "接口调用",
  automation: "记录/事件自动化",
};

export type { LlmAgentRunStep };
