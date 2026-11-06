#!/usr/bin/env tsx
/**
 * 把科研编排契约里的 Skill 落成站内 LLM 智能体（需管理员 dw_ 令牌）。
 *
 *   DUOWEI_BASE_URL=http://47.122.123.1 \
 *   DUOWEI_ADMIN_TOKEN=dw_xxx \
 *   DUOWEI_LLM_BASE_URL=http://…/v1 \
 *   DUOWEI_LLM_MODEL=… \
 *   DUOWEI_LLM_API_KEY=… \
 *   npx tsx ResearchModule/build/setup-research-agents.mts
 *
 * 幂等：同名智能体存在则 PATCH 指令/工具/模式/绑定空间，不重复创建。
 * 不把密钥写入仓库；本脚本只读环境变量。
 */
const BASE_URL = (process.env.DUOWEI_BASE_URL ?? "http://47.122.123.1").replace(/\/+$/, "");
const ADMIN = process.env.DUOWEI_ADMIN_TOKEN?.trim() ?? "";
const LLM_BASE = process.env.DUOWEI_LLM_BASE_URL?.trim() ?? "";
const LLM_MODEL = process.env.DUOWEI_LLM_MODEL?.trim() ?? "";
const LLM_KEY = process.env.DUOWEI_LLM_API_KEY?.trim() ?? "";
const RESEARCH_BASE = "科研方法";

if (!ADMIN) {
  console.error("需要 DUOWEI_ADMIN_TOKEN（管理员个人访问令牌 dw_…）");
  process.exit(1);
}
if (!LLM_BASE || !LLM_MODEL || !LLM_KEY) {
  console.error("需要 DUOWEI_LLM_BASE_URL / DUOWEI_LLM_MODEL / DUOWEI_LLM_API_KEY");
  process.exit(1);
}

type AgentSpec = {
  name: string;
  description: string;
  mode: "tools" | "prompt";
  tools: string[];
  /** 提示词库记录名称；找不到则用 fallbackInstructions */
  promptName: string;
  fallbackInstructions: string;
};

const SPECS: AgentSpec[] = [
  {
    name: "科研协调员",
    description: "Skill coord-research：澄清、定 Tier、建/派交接卡、验收；几乎不写业务字段",
    mode: "tools",
    tools: ["list_tables", "get_table_schema", "query_records", "create_record", "update_record", "add_comment"],
    promptName: "coord-research·科研协调员",
    fallbackInstructions: "你是科研协调员。只操作「科研项目」「交接卡」，特权结论留给人审。",
  },
  {
    name: "问题地图纠偏员",
    description: "Skill m01-matrix-audit：只评论，不改核实状态",
    mode: "tools",
    tools: ["list_tables", "get_table_schema", "query_records", "add_comment"],
    promptName: "问题地图纠偏员·系统提示词",
    fallbackInstructions: "你是问题地图纠偏员。只允许写评论，禁止修改任何字段。",
  },
  {
    name: "红队审查员",
    description: "Skill m01-redteam：写入 09 红队审查（待审定），禁止改假设登记.状态",
    mode: "tools",
    tools: ["list_tables", "get_table_schema", "query_records", "create_record", "add_comment"],
    promptName: "红队审查员·系统提示词",
    fallbackInstructions:
      "你是红队审查员。只在「09 红队审查」建待审定记录或写评论；禁止修改「假设登记」的状态与审定字段。",
  },
  {
    name: "隐藏格探测员",
    description: "Skill m01-hidden-cell：单次生成五问，输出给人判断",
    mode: "prompt",
    tools: [],
    promptName: "隐藏格探测·五问",
    fallbackInstructions: "对给定横轴×纵轴组合输出五问探测，标注需人工核实。",
  },
];

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function loadPromptMap(baseId: string): Promise<Map<string, string>> {
  const bases: Array<{ id: string; tables: Array<{ id: string; name: string }> }> = await api("GET", "/api/bases");
  const base = bases.find((item) => item.id === baseId);
  const promptsTable = base?.tables.find((table) => table.name === "提示词库");
  if (!promptsTable) throw new Error("找不到提示词库");
  const table = await api("GET", `/api/tables/${promptsTable.id}`);
  const map = new Map<string, string>();
  for (const record of table.records ?? []) {
    const name = String(record.fields?.["名称"] ?? "");
    const full = String(record.fields?.["完整提示词"] ?? "");
    if (name && full) map.set(name, full);
  }
  return map;
}

async function main() {
  const me = await api("GET", "/api/auth/me");
  if (me.user?.role !== "admin") throw new Error("令牌对应的用户不是管理员");
  console.log(`管理员：${me.user.name} <${me.user.email}>`);

  const bases: Array<{ id: string; name: string }> = await api("GET", "/api/bases");
  const research = bases.find((item) => item.name === RESEARCH_BASE);
  if (!research) throw new Error(`找不到空间「${RESEARCH_BASE}」`);
  console.log(`空间：${research.name} (${research.id})`);

  const prompts = await loadPromptMap(research.id);
  const existing: Array<{ id: string; name: string }> = await api("GET", `/api/agents?baseId=${research.id}`);
  const byName = new Map(existing.map((item) => [item.name, item]));

  const provider = { baseUrl: LLM_BASE.replace(/\/+$/, ""), model: LLM_MODEL, temperature: 0.2 };

  for (const spec of SPECS) {
    const instructions = prompts.get(spec.promptName) ?? spec.fallbackInstructions;
    if (!prompts.has(spec.promptName)) {
      console.warn(`  ! 提示词库无「${spec.promptName}」，用 fallback 指令`);
    }
    const body = {
      name: spec.name,
      description: spec.description,
      baseId: research.id,
      instructions,
      mode: spec.mode,
      tools: spec.tools,
      provider,
      apiKey: LLM_KEY,
      status: "enabled" as const,
    };
    const found = byName.get(spec.name);
    if (found) {
      await api("PATCH", `/api/agents/${found.id}`, body);
      console.log(`  · 已更新：${spec.name} (${found.id})`);
    } else {
      const created = await api("POST", "/api/agents", body);
      console.log(`  + 已创建：${spec.name} (${created.id})`);
    }
  }

  const listed: Array<{ id: string; name: string; mode: string; tools: string[]; apiKeySet: boolean }> = await api(
    "GET",
    `/api/agents?baseId=${research.id}`,
  );
  console.log("\n当前科研空间智能体：");
  for (const agent of listed.filter((item) => SPECS.some((spec) => spec.name === item.name))) {
    console.log(
      `  - ${agent.name} · ${agent.mode} · tools=[${(agent.tools ?? []).join(",")}] · key=${agent.apiKeySet ? "已配置" : "缺"}`,
    );
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
