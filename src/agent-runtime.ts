/**
 * 把 AgentRuntime 接到真实的 Store / Accounts 上：
 * - 工具读表走「触发者身份 + 表级行列权限」，写表先校验空间编辑权；
 * - run_agent 自动化动作交给同一套运行时执行，并用智能体负责人的身份操作。
 */

import { baseRole } from "./access.js";
import type { Accounts } from "./accounts.js";
import { AgentRuntime } from "./agent.js";
import type { Store } from "./store.js";
import type { LlmAgentRunTrigger, PublicUser } from "./types.js";

function firstLine(text: string, max = 140): string {
  const line = text.trim().split("\n").find((item) => item.trim().length > 0)?.trim() ?? "";
  if (!line) return "（无输出）";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function configureAgentRuntime(input: { store: Store; accounts: Accounts }): AgentRuntime {
  const { store, accounts } = input;
  const userCache = new Map<string, PublicUser | null>();

  const lookupUser = async (userId: string): Promise<PublicUser | null> => {
    if (userCache.has(userId)) return userCache.get(userId) ?? null;
    const users = await accounts.listUsers();
    for (const user of users) userCache.set(user.id, user);
    const found = users.find((user) => user.id === userId) ?? null;
    userCache.set(userId, found);
    return found;
  };

  const runtime = new AgentRuntime({
    store,
    listVisibleTables: async (actor) => {
      const user = await lookupUser(actor.userId);
      const bases = await store.listBases();
      if (!user) return [];
      const ids = await accounts.visibleBaseIds(user);
      const visible = ids === "all" ? bases : bases.filter((base) => ids.includes(base.id));
      return visible.flatMap((base) =>
        base.tables.map((table) => ({
          baseId: base.id,
          baseName: base.name,
          tableId: table.id,
          tableName: table.name,
        })),
      );
    },
    readTable: async (tableId, actor) => {
      const user = await lookupUser(actor.userId);
      const payload = await store.getTable(tableId, undefined, { viewerUserId: actor.userId });
      if (user?.role === "admin" && user.kind !== "agent") return payload;
      const acl = await store.getTableAcl(tableId);
      return store.applyAclToPayload(payload, { userId: actor.userId, name: actor.name, email: user?.email }, acl);
    },
    canWrite: async (baseId, actor) => {
      const user = await lookupUser(actor.userId);
      if (!user) return false;
      const role = await baseRole(accounts, user, baseId);
      return role === "editor" || role === "owner";
    },
  });

  /** 自动化动作 run_agent：用智能体负责人的身份操作，保证定时任务有稳定的数据权限 */
  store.setAgentActionRunner(async ({ agentId, prompt, tableId, actorName, trigger }) => {
    try {
      const agent = await store.getLlmAgent(agentId);
      const owner = await lookupUser(agent.ownerUserId);
      const run = await runtime.run({
        agentId,
        prompt,
        trigger: (trigger ?? "automation") as LlmAgentRunTrigger,
        tableId,
        actor: { userId: agent.ownerUserId, name: owner?.name ?? agentName(agent.name, actorName) },
        contextNote: `由自动化触发（记录表 id：${tableId}）`,
      });
      if (run.status === "ok") {
        return { ok: true, detail: `智能体「${agent.name}」运行成功：${firstLine(run.output)}` };
      }
      return { ok: false, detail: `智能体「${agent.name}」运行失败：${run.error ?? "未知原因"}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: `智能体运行失败：${message.slice(0, 300)}` };
    }
  });

  return runtime;
}

function agentName(name: string, fallback: string): string {
  return name.trim() || fallback;
}
