import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accounts } from "./accounts.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";
import { shanghaiDay } from "./usage.js";

// 使用度量分两层测：
// 1) UsageMetrics 本身——按北京时间分天、攒批 upsert 只加不覆盖、summary 补零；
// 2) 经 createApp 的埋点——哪些请求计数、哪些不计数，以及管理员接口的返回与权限。

// ---- 1. 按北京时间分天 ----
assert.equal(shanghaiDay(Date.UTC(2026, 9, 10, 15, 59, 59)), "2026-10-10", "UTC 15:59 是北京时间 23:59，仍算当天");
assert.equal(shanghaiDay(Date.UTC(2026, 9, 10, 16, 0, 0)), "2026-10-11", "UTC 16:00 是北京时间次日 0 点");

// ---- 2. UsageMetrics ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-usage-"));
const store = new Store(path.join(dir, "duowei.db"));
await store.init();

const day = Date.UTC(2026, 9, 10, 3, 0, 0); // 北京时间 2026-10-10 11:00
const nextDay = day + 24 * 60 * 60 * 1000;

store.usage.bump("api_calls", 2, day);
store.usage.bump("api_calls", 3, day);
store.usage.bump("record_writes", 1, day);
await store.usage.flush();

const first = await store.usage.summary(3, day);
assert.equal(first.days.length, 3, "近 3 天窗口应补满 3 行");
assert.deepEqual(
  first.days.map((item) => item.day),
  ["2026-10-08", "2026-10-09", "2026-10-10"],
);
assert.equal(first.days[2].apiCalls, 5, "同一天的多次 bump 应合并计数");
assert.equal(first.days[2].recordWrites, 1);
assert.equal(first.days[0].apiCalls, 0, "没有数据的天补 0");
assert.deepEqual(first.totals, {
  apiCalls: 5,
  agentCalls: 0,
  recordWrites: 1,
  docWrites: 0,
  automationRuns: 0,
  automationFailures: 0,
});

// flush 后缓冲清空：再 flush 一次不会把同一批数据写两遍
await store.usage.flush();
const noDup = await store.usage.summary(3, day);
assert.equal(noDup.totals.apiCalls, 5, "重复 flush 不应重复累计");

// 跨批次、跨天：upsert 是加法而不是覆盖
store.usage.bump("api_calls", 1, day);
store.usage.bump("automation_runs", 2, nextDay);
store.usage.bump("automation_failures", 1, nextDay);
await store.usage.flush();
const merged = await store.usage.summary(3, nextDay);
assert.equal(merged.days[1].apiCalls, 6, "新批次应加到已有的日行上");
assert.equal(merged.days[2].automationRuns, 2);
assert.equal(merged.days[2].automationFailures, 1);

// 攒够 50 条会自己触发异步 flush；再显式 flush，一条计数都不能丢
for (let i = 0; i < 120; i += 1) store.usage.bump("doc_writes", 1, day);
await store.usage.flush();
const raced = await store.usage.summary(1, day);
assert.equal(raced.days[0].docWrites, 120, "自动 flush 与显式 flush 并发时不丢计数");

// ---- 3. 经 createApp 的埋点与管理员接口 ----
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-usage-app-"));
process.env.DUOWEI_DEV_CODES = "1";
delete process.env.SMTP_HOST;
const appStore = new Store(path.join(appDir, "duowei.db"));
await appStore.init();
const accounts = new Accounts(appStore.database, appStore, appDir, { devCodes: true, pepper: "usage-pepper" });
const app = createApp(appStore, accounts);

async function json(pathname: string, init?: RequestInit & { cookie?: string; token?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await app.request(pathname, { method: init?.method, body: init?.body, headers });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

type UsageDto = {
  days: Array<Record<string, number | string>>;
  totals: { apiCalls: number; agentCalls: number; recordWrites: number; docWrites: number; automationRuns: number; automationFailures: number };
};

// 管理员会话：bootstrap 成功后填入，usage() 默认用它
let adminCookie = "";

async function usage(days = 3, cookie = adminCookie): Promise<UsageDto> {
  const res = await json(`/api/system/usage?days=${days}`, { cookie });
  assert.equal(res.status, 200);
  return res.data as UsageDto;
}

// 未登录不能看用量
assert.equal((await json("/api/system/usage")).status, 401);
assert.equal((await json("/api/system/usage", { cookie: "session_garbage" })).status, 401);

const registered = await json("/api/auth/bootstrap", {
  method: "POST",
  body: JSON.stringify({ name: "Ada", email: "ada@usage.test", password: "password123" }),
});
assert.equal(registered.status, 201);
assert.equal(registered.data.user.role, "admin");
const admin = registered.cookie!;
adminCookie = admin;

// 非管理员看不出用量
const member = await json("/api/users", {
  method: "POST",
  cookie: admin,
  body: JSON.stringify({ name: "Bob", email: "bob@usage.test", password: "password123", role: "member" }),
});
assert.equal(member.status, 201, "创建普通成员应成功");
const memberLogin = await (async () => {
  const captcha = await json("/api/auth/captcha");
  assert.equal(captcha.status, 200);
  return json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: "bob@usage.test",
      password: "password123",
      captchaId: captcha.data.captchaId,
      captcha: captcha.data.devAnswer,
    }),
  });
})();
assert.ok(memberLogin.cookie, "普通成员应能登录");
assert.equal((await json("/api/system/usage", { cookie: memberLogin.cookie })).status, 403);

/** 直接读存储里的用量，不经过 /api；否则"读数"本身也会被计进接口用量。 */
async function snap(): Promise<UsageDto> {
  return (await appStore.usage.summary(3)) as unknown as UsageDto;
}

const before = await snap();

// 不计数：健康检查、未鉴权的 401、不存在的 404 —— 探活与公网扫描不该冲花"真实用量"
for (let i = 0; i < 3; i += 1) assert.equal((await app.request("/api/health")).status, 200);
assert.equal((await app.request("/api/bases")).status, 401);
assert.equal((await app.request("/api/not-a-route")).status, 404);

// 计数：一次成功的接口调用（人类）
assert.equal((await json("/api/bases", { cookie: admin })).status, 200);
const afterHuman = await snap();
assert.equal(afterHuman.totals.apiCalls - before.totals.apiCalls, 1, "成功调用记 1 次接口用量");
assert.equal(afterHuman.totals.agentCalls - before.totals.agentCalls, 0, "人类调用不记 Agent 用量");

// 计数：Agent 令牌（dwa_…）的调用单独记，并从接口用量里能对上
const agentReg = await json("/api/mcp-agents/register", {
  method: "POST",
  body: JSON.stringify({ name: "UsageBot", description: "usage test", contact: "bot@usage.test" }),
});
assert.equal(agentReg.status, 201);
const agentApprove = await json(`/api/mcp-agents/${agentReg.data.id}/approve`, {
  method: "POST",
  cookie: admin,
});
assert.equal(agentApprove.status, 200);
assert.ok(String(agentApprove.data.token).startsWith("dwa_"));
const beforeAgent = await snap();
assert.equal((await json("/api/bases", { token: agentApprove.data.token })).status, 200);
const afterAgent = await snap();
assert.equal(afterAgent.totals.apiCalls - beforeAgent.totals.apiCalls, 1);
assert.equal(afterAgent.totals.agentCalls - beforeAgent.totals.agentCalls, 1, "带 Agent 令牌的调用单独记一笔");

// 计数：记录写入与文档写入埋在 store 的写路径上，与接口调用分开可见
const bases = await json("/api/bases", { cookie: admin });
const usageBase = bases.data[0];
const tablePayload = await json(`/api/tables/${usageBase.tables[0].id}`, { cookie: admin });
const textField = tablePayload.data.fields.find((field: { type: string }) => field.type === "text") as { name: string };
assert.ok(textField, "示例空间的表里应有文本字段");
const beforeWrites = await snap();
const createdRecord = await json(`/api/tables/${usageBase.tables[0].id}/records`, {
  method: "POST",
  cookie: admin,
  body: JSON.stringify({ fields: { [textField.name]: "使用度量埋点" } }),
});
assert.equal(createdRecord.status, 201);
const createdDoc = await json(`/api/bases/${usageBase.id}/documents`, {
  method: "POST",
  cookie: admin,
  body: JSON.stringify({ title: "使用度量埋点", bodyMd: "body" }),
});
assert.equal(createdDoc.status, 201);
const afterWrites = await snap();
assert.equal(afterWrites.totals.recordWrites - beforeWrites.totals.recordWrites, 1, "建一条记录记 1 次记录写入");
assert.equal(afterWrites.totals.docWrites - beforeWrites.totals.docWrites, 1, "建一篇文档记 1 次文档写入");

// 到此为止成功的 /api 调用应恰好 12 次：bootstrap、建成员、验证码、成员登录、
// 管理员取空间、Agent 注册、Agent 批准、Agent 取空间、管理员取空间、取表结构、建记录、建文档。
// 中间的 401/403/404、三次健康检查都没算进来。
assert.equal(afterWrites.totals.apiCalls, 12, "接口用量应等于成功调用的次数");
assert.equal(afterWrites.totals.agentCalls, 1, "其中 Agent 调用 1 次");

// 窗口参数：默认 14 天，非法值回落到 14，上限 90
assert.equal((await usage(14)).days.length, 14);
assert.equal((await usage(Number.NaN)).days.length, 14);
assert.equal((await usage(999)).days.length, 90, "超过 90 天的窗口应被截到 90");
assert.equal((await usage(1)).days[0].day, shanghaiDay(), "窗口最后一天应是北京时间今天");

await store.usage.flush();
await appStore.usage.flush();
console.log("duowei usage tests passed");
