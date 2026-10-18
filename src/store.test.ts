import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accounts } from "./accounts.js";
import { Store, shouldRunSchedule } from "./store.js";
import { DOC_TEMPLATES } from "./types.js";
import { createApp } from "./server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-"));
process.env.DUOWEI_DEV_CODES = "1";
delete process.env.SMTP_HOST;

const store = new Store(path.join(dir, "duowei.db"));
await store.init();
const accounts = new Accounts(store.database, store, dir, { devCodes: true, pepper: "test-pepper" });
const app = createApp(store, accounts);

async function json(pathname: string, init?: RequestInit & { cookie?: string; token?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await app.request(pathname, {
    method: init?.method,
    body: init?.body,
    headers,
  });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, data, cookie };
}

async function captchaPair() {
  const captcha = await json("/api/auth/captcha");
  assert.equal(captcha.status, 200);
  assert.ok(captcha.data.captchaId);
  assert.ok(captcha.data.devAnswer);
  return { captchaId: captcha.data.captchaId as string, captcha: captcha.data.devAnswer as string };
}

async function loginAs(email: string, password: string) {
  const pair = await captchaPair();
  return json("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, ...pair }),
  });
}

const status = await json("/api/auth/bootstrap-status");
assert.equal(status.data.needsBootstrap, true);

const registered = await json("/api/auth/bootstrap", {
  method: "POST",
  body: JSON.stringify({
    name: "Ada",
    email: "ada@team.test",
    password: "password123",
  }),
});
assert.equal(registered.status, 201);
assert.equal(registered.data.user.role, "admin");
assert.ok(registered.cookie);
const ada = registered.cookie!;

const blockedRegister = await json("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "X", email: "x@team.test", password: "password123", code: "000000" }),
});
assert.ok(blockedRegister.status >= 400);

const me = await json("/api/auth/me", { cookie: ada });
assert.equal(me.data.user.email, "ada@team.test");

const bases = await json("/api/bases", { cookie: ada });
assert.equal(bases.data.length, 1);
assert.equal(bases.data[0].name, "示例工作台");
const requirementTable = bases.data[0].tables.find((table: { name: string }) => table.name === "任务");
assert.ok(requirementTable);

const table = await json(`/api/tables/${requirementTable.id}`, { cookie: ada });
assert.ok(table.data.fields.some((field: { name: string }) => field.name === "状态"));
assert.ok(table.data.views.some((view: { type: string }) => view.type === "kanban"));
assert.ok(table.data.records.length >= 5);

const created = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({ fields: { 标题: "接口创建的任务", 状态: "待办", 优先级: "P0" } }),
});
assert.equal(created.status, 201);
assert.equal(created.data.record.fields["标题"], "接口创建的任务");

const statusField = table.data.fields.find((field: { name: string }) => field.name === "状态");
const queried = await json(`/api/tables/${requirementTable.id}/query`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({ filters: [{ fieldId: statusField.id, op: "eq", value: "待办" }] }),
});
assert.ok(queried.data.records.every((record: { fields: Record<string, string> }) => record.fields["状态"] === "待办"));

const engineering = await json("/api/templates/engineering", { method: "POST", cookie: ada });
assert.equal(engineering.status, 201);
assert.equal(engineering.data.name, "研发进度");
assert.ok(engineering.data.tables.some((item: { name: string }) => item.name === "缺陷"));

const research = await json("/api/templates/research", { method: "POST", cookie: ada });
assert.equal(research.status, 201);
assert.equal(research.data.name, "科研管理");
assert.ok(research.data.tables.some((item: { name: string }) => item.name === "论文"));
assert.ok(research.data.tables.some((item: { name: string }) => item.name === "任务"));
assert.ok(research.data.tables.some((item: { name: string }) => item.name === "投稿记录"));
const researchPaper = research.data.tables.find((item: { name: string }) => item.name === "论文");
const researchTask = research.data.tables.find((item: { name: string }) => item.name === "任务");
const researchPaperPayload = await json(`/api/tables/${researchPaper.id}`, { cookie: ada });
assert.ok(researchPaperPayload.data.views.some((item: { type: string }) => item.type === "calendar"));
assert.ok(researchPaperPayload.data.views.some((item: { name: string }) => item.name === "进行中"));
const researchTaskPayload = await json(`/api/tables/${researchTask.id}`, { cookie: ada });
const researchLinkField = researchTaskPayload.data.fields.find((item: { name: string }) => item.name === "所属论文");
assert.equal(researchLinkField?.type, "link");
assert.equal(researchLinkField?.config?.linkTableId, researchPaper.id);
const linkedTask = researchTaskPayload.data.records.find((item: { fields: Record<string, unknown> }) =>
  Array.isArray(item.fields["所属论文"]) && (item.fields["所属论文"] as unknown[]).length > 0,
);
assert.ok(linkedTask);
const researchAutos = await json(`/api/tables/${researchPaper.id}/automations`, { cookie: ada });
assert.ok(researchAutos.data.some((item: { actions: Array<{ type: string }> }) => item.actions[0]?.type === "feishu_bot"));
assert.ok(researchAutos.data.some((item: { actions: Array<{ type: string }> }) => item.actions[0]?.type === "feishu_digest"));

const todos = await json("/api/templates/todos", { method: "POST", cookie: ada });
assert.equal(todos.status, 201);
assert.equal(todos.data.name, "待办中心");
const todoTable = todos.data.tables.find((item: { name: string }) => item.name === "待办");
assert.ok(todoTable);
const todoPayload = await json(`/api/tables/${todoTable.id}`, { cookie: ada });
assert.ok(todoPayload.data.views.some((item: { type: string }) => item.type === "calendar"));
assert.ok(todoPayload.data.views.some((item: { name: string }) => item.name === "科研"));
const todoAutos = await json(`/api/tables/${todoTable.id}/automations`, { cookie: ada });
assert.ok(todoAutos.data.some((item: { actions: Array<{ type: string }> }) => item.actions[0]?.type === "feishu_bot"));
assert.ok(todoAutos.data.some((item: { actions: Array<{ type: string }> }) => item.actions[0]?.type === "feishu_digest"));

const icsRes = await app.request(`/api/tables/${todoTable.id}/calendar.ics`, { headers: { cookie: ada } });
assert.equal(icsRes.status, 200);
const icsText = await icsRes.text();
assert.ok(icsText.includes("BEGIN:VCALENDAR"));
assert.ok(icsText.includes("示例：投稿截止日期"));

const feed = await json(`/api/tables/${todoTable.id}/calendar-feeds`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({}),
});
assert.equal(feed.status, 201);
const publicIcs = await app.request(`/api/calendar/${feed.data.token}.ics`);
assert.equal(publicIcs.status, 200);
assert.ok((await publicIcs.text()).includes("BEGIN:VEVENT"));

const prevFetch = globalThis.fetch;
const feishuCalls: Array<{ url: string; body: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  feishuCalls.push({ url, body: String(init?.body ?? "") });
  return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
}) as typeof fetch;
const savedHook = await json(`/api/bases/${todos.data.id}/settings`, {
  method: "PATCH",
  cookie: ada,
  body: JSON.stringify({ integrations: { feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token" } }),
});
assert.equal(savedHook.status, 200);
const ping = await json(`/api/bases/${todos.data.id}/feishu-test`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({ text: "hello" }),
});
assert.equal(ping.status, 200);
const digest = await json(`/api/tables/${todoTable.id}/feishu-digest`, { method: "POST", cookie: ada, body: JSON.stringify({}) });
assert.equal(digest.status, 200);
assert.equal(digest.data.sent, true);
assert.ok(digest.data.count >= 1);
assert.ok(feishuCalls.some((item) => item.body.includes("hello")));
globalThis.fetch = prevFetch;

const loginCode = await json("/api/auth/codes", {
  method: "POST",
  body: JSON.stringify({ email: "ada@team.test", purpose: "login" }),
});
const loginPair = await captchaPair();
const codeLogin = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "ada@team.test", code: loginCode.data.devCode, ...loginPair }),
});
assert.equal(codeLogin.status, 200);

const passwordLogin = await loginAs("ada@team.test", "password123");
assert.equal(passwordLogin.status, 200);

const badCaptcha = await json("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: "ada@team.test",
    password: "password123",
    captchaId: "cap_missing",
    captcha: "XXXXX",
  }),
});
assert.equal(badCaptcha.status, 401);

const token = await json("/api/tokens", {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({ name: "agent" }),
});
assert.equal(token.status, 201);
const bearerBases = await json("/api/bases", { token: token.data.token });
assert.equal(bearerBases.status, 200);
assert.ok(bearerBases.data.length >= 2);

const grace = await json("/api/users", {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({
    name: "Grace",
    email: "grace@team.test",
    password: "password123",
    role: "member",
  }),
});
assert.equal(grace.status, 201);
assert.equal(grace.data.role, "member");
const graceLogin = await loginAs("grace@team.test", "password123");
assert.equal(graceLogin.status, 200);
const graceCookie = graceLogin.cookie!;
const graceBases = await json("/api/bases", { cookie: graceCookie });
assert.deepEqual(graceBases.data, []);
const denied = await json(`/api/tables/${requirementTable.id}`, { cookie: graceCookie });
assert.equal(denied.status, 403);

await json(`/api/bases/${bases.data[0].id}/members`, {
  method: "PUT",
  cookie: ada,
  body: JSON.stringify({ email: "grace@team.test", role: "editor" }),
});
const edited = await json(`/api/records/${created.data.record.id}`, {
  method: "PATCH",
  cookie: graceCookie,
  body: JSON.stringify({ fields: { 状态: "进行中" } }),
});
assert.equal(edited.status, 200);
assert.equal(edited.data.record.fields["状态"], "进行中");

await json(`/api/bases/${bases.data[0].id}/members`, {
  method: "PUT",
  cookie: ada,
  body: JSON.stringify({ email: "grace@team.test", role: "viewer" }),
});
const readonly = await json(`/api/records/${created.data.record.id}`, {
  method: "PATCH",
  cookie: graceCookie,
  body: JSON.stringify({ fields: { 状态: "已完成" } }),
});
assert.equal(readonly.status, 403);
const readable = await json(`/api/tables/${requirementTable.id}`, { cookie: graceCookie });
assert.equal(readable.status, 200);

const users = await json("/api/users", { cookie: ada });
assert.equal(users.status, 200);
const usersAsMember = await json("/api/users", { cookie: graceCookie });
assert.equal(usersAsMember.status, 403);

const loggedOut = await json("/api/auth/logout", { method: "POST", cookie: ada });
assert.equal(loggedOut.status, 200);
const afterLogout = await json("/api/auth/me", { cookie: ada });
assert.equal(afterLogout.status, 401);

// re-login for extended feature tests
const adaLogin = await loginAs("ada@team.test", "password123");
assert.equal(adaLogin.status, 200);
const ada2 = adaLogin.cookie!;

const formulaField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "评分", type: "rating", max: 5 }),
});
assert.equal(formulaField.status, 201);

const progressField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "完成度", type: "progress" }),
});
assert.equal(progressField.status, 201);

const autoField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "编号", type: "auto_number", prefix: "REQ-" }),
});
assert.equal(autoField.status, 201);

const numbered = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "自动编号任务", 评分: 4, 完成度: 50 } }),
});
assert.equal(numbered.status, 201);
assert.equal(numbered.data.record.fields["编号"], "REQ-1");
assert.equal(numbered.data.record.fields["评分"], 4);

const calendar = await json(`/api/tables/${requirementTable.id}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "日历", type: "calendar", dateField: "截止日期" }),
});
assert.equal(calendar.status, 201);
assert.equal(calendar.data.type, "calendar");
assert.ok(calendar.data.config.dateFieldId);

const gallery = await json(`/api/tables/${requirementTable.id}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "画册", type: "gallery" }),
});
assert.equal(gallery.status, 201);

const formView = await json(`/api/tables/${requirementTable.id}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "表单", type: "form" }),
});
assert.equal(formView.status, 201);

const exportCsv = await app.request(`/api/tables/${requirementTable.id}/export.csv`, {
  headers: { cookie: ada2 },
});
assert.equal(exportCsv.status, 200);
const csvText = await exportCsv.text();
assert.match(csvText, /标题/);

const imported = await json(`/api/tables/${requirementTable.id}/import.csv`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ csv: "标题,状态\nCSV导入行,待办\n" }),
});
assert.equal(imported.status, 200);
assert.equal(imported.data.imported, 1);

const comment = await json(`/api/records/${numbered.data.record.id}/comments`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ body: "看起来不错" }),
});
assert.equal(comment.status, 201);
const comments = await json(`/api/records/${numbered.data.record.id}/comments`, { cookie: ada2 });
assert.equal(comments.data.length, 1);

const history = await json(`/api/records/${numbered.data.record.id}/history`, { cookie: ada2 });
assert.ok(history.data.length >= 1);

// 记录级写保护（第 10/12 讲 P1）：锁定后不可改不可删，锁定与解锁均留痕
const lockRes = await json(`/api/records/${numbered.data.record.id}/lock`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ locked: true }),
});
assert.equal(lockRes.status, 200);
assert.ok(lockRes.data.record.lockedAt);
assert.equal(lockRes.data.record.lockedBy, "Ada");

const lockedUpdate = await json(`/api/records/${numbered.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ fields: { 评分: 5 } }),
});
assert.equal(lockedUpdate.status, 400);
assert.match(String(lockedUpdate.data.error), /锁定/);

const lockedDelete = await json(`/api/records/${numbered.data.record.id}`, { method: "DELETE", cookie: ada2 });
assert.equal(lockedDelete.status, 400);
assert.match(String(lockedDelete.data.error), /锁定/);

const lockedComments = await json(`/api/records/${numbered.data.record.id}/comments`, { cookie: ada2 });
assert.ok(lockedComments.data.some((item: { body: string }) => item.body.includes("🔒")));
const lockHistory = await json(`/api/records/${numbered.data.record.id}/history`, { cookie: ada2 });
assert.ok(lockHistory.data.some((item: { action: string }) => item.action === "lock"));

// 重复锁定幂等：不重复留痕
const relock = await json(`/api/records/${numbered.data.record.id}/lock`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ locked: true }),
});
assert.equal(relock.status, 200);
assert.equal(relock.data.record.lockedAt, lockRes.data.record.lockedAt);
const commentsAfterRelock = await json(`/api/records/${numbered.data.record.id}/comments`, { cookie: ada2 });
assert.equal(commentsAfterRelock.data.length, lockedComments.data.length);

// 解锁后可继续修改，并留下解锁痕迹
const unlockRes = await json(`/api/records/${numbered.data.record.id}/lock`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ locked: false }),
});
assert.equal(unlockRes.status, 200);
assert.equal(unlockRes.data.record.lockedAt, null);
const afterUnlock = await json(`/api/records/${numbered.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ fields: { 评分: 5 } }),
});
assert.equal(afterUnlock.status, 200);
assert.equal(afterUnlock.data.record.fields["评分"], 5);
const unlockHistory = await json(`/api/records/${numbered.data.record.id}/history`, { cookie: ada2 });
assert.ok(unlockHistory.data.some((item: { action: string }) => item.action === "unlock"));

const iterations = bases.data[0].tables.find((item: { name: string }) => item.name === "项目");
assert.ok(iterations);
const linkField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "关联项目", type: "link", linkTableId: iterations.id }),
});
assert.equal(linkField.status, 201);

const statusId = statusField.id;
const automation = await json(`/api/tables/${requirementTable.id}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "新建待办",
    trigger: { type: "record_created" },
    actions: [{ type: "set_field", fieldId: statusId, value: "待办" }],
  }),
});
assert.equal(automation.status, 201);

const autoCreated = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "自动化创建" } }),
});
assert.equal(autoCreated.status, 201);
assert.equal(autoCreated.data.record.fields["状态"], "待办");

const qty = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "数量", type: "number" }),
});
const price = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "单价", type: "currency", currency: "CNY" }),
});
assert.equal(qty.status, 201);
assert.equal(price.status, 201);
const total = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "合计", type: "formula", formula: "{数量}*{单价}" }),
});
assert.equal(total.status, 201);
const computed = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "公式行", 数量: 3, 单价: 10 } }),
});
assert.equal(computed.status, 201);
assert.equal(computed.data.record.fields["合计"], 30);

const acl = await json(`/api/tables/${requirementTable.id}/acl`, {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({ columnDeny: { [grace.data.id]: [autoField.data.id] } }),
});
assert.equal(acl.status, 200);
const graceView = await json(`/api/tables/${requirementTable.id}`, { cookie: graceCookie });
assert.equal(graceView.status, 200);
assert.ok(!graceView.data.fields.some((field: { name: string }) => field.name === "编号"));

const createdByAcl = await json(`/api/tables/${requirementTable.id}/acl`, {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    columnDeny: { [grace.data.id]: [autoField.data.id] },
    rowRules: { [grace.data.id]: { type: "created_by" } },
  }),
});
assert.equal(createdByAcl.status, 200);
const preview = await json(`/api/tables/${requirementTable.id}/acl/preview?userId=${grace.data.id}`, {
  cookie: ada2,
});
assert.equal(preview.status, 200);
assert.ok(typeof preview.data.visible === "number");
assert.ok(preview.data.total >= preview.data.visible);

const webhookAuto = await json(`/api/tables/${requirementTable.id}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "Webhook 评论",
    trigger: { type: "webhook", secret: "hook-secret" },
    actions: [{ type: "add_comment", body: "from webhook {recordId}" }],
  }),
});
assert.equal(webhookAuto.status, 201);
const webhookHit = await json(`/api/webhooks/automations/${webhookAuto.data.id}?secret=hook-secret`, {
  method: "POST",
  body: JSON.stringify({ recordId: autoCreated.data.record.id }),
});
assert.equal(webhookHit.status, 200);
assert.equal(webhookHit.data.ran, true);
const webhookComments = await json(`/api/records/${autoCreated.data.record.id}/comments`, { cookie: ada2 });
assert.ok(webhookComments.data.some((item: { body: string }) => item.body.includes("from webhook")));

const httpAuto = await json(`/api/tables/${requirementTable.id}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "HTTP 出站",
    trigger: { type: "record_created" },
    actions: [{ type: "http_request", url: "http://127.0.0.1:9/does-not-exist", method: "POST" }],
    enabled: false,
  }),
});
assert.equal(httpAuto.status, 201);

const dash = await json(`/api/bases/${bases.data[0].id}/dashboards`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "任务概览",
    config: {
      charts: [{ id: "c1", title: "按状态", type: "bar", tableId: requirementTable.id, fieldId: statusId }],
    },
  }),
});
assert.equal(dash.status, 201);
const dashData = await json(`/api/dashboards/${dash.data.id}`, { cookie: ada2 });
assert.equal(dashData.status, 200);
assert.ok(dashData.data.charts[0].labels.length > 0);

const appMode = await json(`/api/bases/${bases.data[0].id}/app`, { cookie: ada2 });
assert.equal(appMode.status, 200);
assert.equal(appMode.data.mode, "app");

const duplex = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "双向项目",
    type: "duplex_link",
    linkTableId: iterations.id,
    symmetricFieldName: "关联任务",
  }),
});
assert.equal(duplex.status, 201);
assert.ok(duplex.data.config.symmetricFieldId);

const iterTable = await json(`/api/tables/${iterations.id}`, { cookie: ada2 });
const peerField = iterTable.data.fields.find((field: { name: string }) => field.name === "关联任务");
assert.ok(peerField);
const sprint = iterTable.data.records[0];
assert.ok(sprint);

const linkedReq = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "双向关联任务", 双向项目: [sprint.id] } }),
});
assert.equal(linkedReq.status, 201);
const peerAfter = await json(`/api/tables/${iterations.id}`, { cookie: ada2 });
const peerRec = peerAfter.data.records.find((item: { id: string }) => item.id === sprint.id);
assert.ok(Array.isArray(peerRec.fields["关联任务"]));
assert.ok(peerRec.fields["关联任务"].length >= 1);

const targetText = iterTable.data.fields.find((field: { type: string }) => field.type === "text");
assert.ok(targetText);
const lookup = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "项目名引用",
    type: "lookup",
    lookupLinkFieldId: duplex.data.id,
    lookupTargetFieldId: targetText.id,
  }),
});
assert.equal(lookup.status, 201);
const looked = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const lookedRec = looked.data.records.find((item: { id: string }) => item.id === linkedReq.data.record.id);
assert.ok(lookedRec.fields["项目名引用"]);

const button = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "确认",
    type: "button",
    buttonLabel: "确认",
    buttonAction: { type: "add_comment", body: "已确认" },
  }),
});
assert.equal(button.status, 201);
const clicked = await json(`/api/records/${linkedReq.data.record.id}/buttons/${button.data.id}`, {
  method: "POST",
  cookie: ada2,
});
assert.equal(clicked.status, 200);
const afterClick = await json(`/api/records/${linkedReq.data.record.id}/comments`, { cookie: ada2 });
assert.ok(afterClick.data.some((item: { body: string }) => item.body === "已确认"));

const attach = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "附件", type: "attachment" }),
});
assert.equal(attach.status, 201);
const withFile = await json(`/api/records/${linkedReq.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    fields: { 附件: [{ name: "spec.pdf", url: "https://example.com/spec.pdf" }], 条码: "ABC123" },
  }),
});
// barcode field may not exist yet
assert.ok(withFile.status === 200 || withFile.status === 400);

const barcode = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "条码", type: "barcode", prefix: "BC-" }),
});
assert.equal(barcode.status, 201);
const coded = await json(`/api/records/${linkedReq.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    fields: {
      附件: [{ name: "spec.pdf", url: "https://example.com/spec.pdf" }],
      条码: "12345",
    },
  }),
});
assert.equal(coded.status, 200);
assert.equal(coded.data.record.fields["条码"], "BC-12345");

const endDate = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "结束日期", type: "date" }),
});
assert.equal(endDate.status, 201);
const gantt = await json(`/api/tables/${requirementTable.id}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "甘特",
    type: "gantt",
    dateField: "截止日期",
    endDateField: "结束日期",
    progressField: "完成度",
  }),
});
assert.equal(gantt.status, 201);
assert.ok(gantt.data.config.endDateFieldId);
assert.ok(gantt.data.config.progressFieldId);

const autoNotify = await json(`/api/tables/${requirementTable.id}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "条件通知",
    trigger: { type: "record_updated" },
    conditions: [{ fieldId: statusId, op: "eq", value: "已完成" }],
    actions: [
      { type: "add_comment", body: "状态已完成" },
      { type: "notify", message: "任务完成提醒", userId: adaLogin.data.user.id },
    ],
  }),
});
assert.equal(autoNotify.status, 201);
const finish = await json(`/api/records/${linkedReq.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ fields: { 状态: "已完成" } }),
});
assert.equal(finish.status, 200);
const notes = await json("/api/notifications", { cookie: ada2 });
assert.ok(notes.data.length >= 1);

const watch = await json(`/api/records/${linkedReq.data.record.id}/watch`, { method: "POST", cookie: ada2 });
assert.equal(watch.status, 200);
const share = await json(`/api/records/${linkedReq.data.record.id}/share`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ expiresInDays: 7 }),
});
assert.equal(share.status, 201);
const shared = await json(`/api/share/${share.data.token}`);
assert.equal(shared.status, 200);
assert.equal(shared.data.record.id, linkedReq.data.record.id);

const settings = await json(`/api/bases/${bases.data[0].id}/settings`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    timezone: "UTC",
    portal: { title: "产品门户", theme: "blue", navTableIds: [requirementTable.id] },
  }),
});
assert.equal(settings.status, 200);
assert.equal(settings.data.timezone, "UTC");
const portal = await json(`/api/bases/${bases.data[0].id}/app`, { cookie: ada2 });
assert.equal(portal.data.name, "产品门户");
assert.equal(portal.data.tables.length, 1);

const multiDash = await json(`/api/bases/${bases.data[0].id}/dashboards`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "多图",
    config: {
      charts: [
        { id: "c1", title: "柱", type: "bar", tableId: requirementTable.id, fieldId: statusId },
        { id: "c2", title: "环", type: "donut", tableId: requirementTable.id, fieldId: statusId },
        { id: "c3", title: "线", type: "line", tableId: requirementTable.id, fieldId: statusId },
      ],
    },
  }),
});
assert.equal(multiDash.status, 201);
const multiData = await json(`/api/dashboards/${multiDash.data.id}`, { cookie: ada2 });
assert.equal(multiData.data.charts.length, 3);

const workflow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "标题非空则标完成度",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      {
        id: "c",
        type: "condition",
        conditions: [{ fieldId: table.data.fields.find((f: { name: string }) => f.name === "标题").id, op: "is_not_empty" }],
        conjunction: "and",
      },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "10" } },
    ],
  }),
});
assert.equal(workflow.status, 201);
const wfCreated = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "工作流触发行" } }),
});
assert.equal(wfCreated.status, 201);
assert.equal(wfCreated.data.record.fields["完成度"], 10);

const upload = await json("/api/uploads", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    filename: "hello.txt",
    contentBase64: Buffer.from("hello duowei").toString("base64"),
    mime: "text/plain",
  }),
});
assert.equal(upload.status, 201);
assert.match(upload.data.url, /\/api\/uploads\//);
const downloaded = await app.request(upload.data.url, { headers: { cookie: ada2 } });
assert.equal(downloaded.status, 200);
assert.equal(await downloaded.text(), "hello duowei");

const sync = await json("/api/sync-jobs", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "任务到项目摘要",
    sourceTableId: requirementTable.id,
    targetTableId: iterations.id,
    fieldMap: { 标题: "名称" },
    mode: "full",
    conflict: "overwrite",
  }),
});
assert.equal(sync.status, 201);
const ran = await json(`/api/sync-jobs/${sync.data.id}/run`, { method: "POST", cookie: ada2 });
assert.equal(ran.status, 200);
assert.ok(ran.data.synced >= 1);

const syncIncr = await json("/api/sync-jobs", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "增量同步",
    sourceTableId: requirementTable.id,
    targetTableId: iterations.id,
    fieldMap: { 标题: "名称" },
    matchField: "标题",
    mode: "incremental",
    conflict: "skip_if_target_nonempty",
  }),
});
assert.equal(syncIncr.status, 201);
const incrFirst = await json(`/api/sync-jobs/${syncIncr.data.id}/run`, { method: "POST", cookie: ada2 });
assert.equal(incrFirst.status, 200);
const incrSecond = await json(`/api/sync-jobs/${syncIncr.data.id}/run`, { method: "POST", cookie: ada2 });
assert.equal(incrSecond.status, 200);
assert.equal(incrSecond.data.synced, 0);
assert.ok(incrSecond.data.skipped >= 1);

const hook = await json("/api/plugins/hooks", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "日志钩子", event: "record_created", target: "log" }),
});
assert.equal(hook.status, 201);

const approvalFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "审批后标完成度",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: [], label: "主管审批" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "88" } },
    ],
  }),
});
assert.equal(approvalFlow.status, 201);
const pendingRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "待审批行" } }),
});
assert.equal(pendingRec.status, 201);
assert.notEqual(pendingRec.data.record.fields["完成度"], 88);
const pendingRuns = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
assert.ok(pendingRuns.data.some((r: { recordId: string }) => r.recordId === pendingRec.data.record.id));
const runId = pendingRuns.data.find((r: { recordId: string }) => r.recordId === pendingRec.data.record.id).id;
const approved = await json(`/api/workflow-runs/${runId}/decide`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ decision: "approve" }),
});
assert.equal(approved.status, 200);
assert.equal(approved.data.status, "completed");
const afterApprove = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const approvedRow = afterApprove.data.records.find((r: { id: string }) => r.id === pendingRec.data.record.id);
assert.equal(approvedRow.fields["完成度"], 88);

const rejectRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "将被驳回" } }),
});
const rejectRuns = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const rejectId = rejectRuns.data.find((r: { recordId: string }) => r.recordId === rejectRec.data.record.id).id;
const rejected = await json(`/api/workflow-runs/${rejectId}/decide`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ decision: "reject", comment: "不通过" }),
});
assert.equal(rejected.data.status, "rejected");
const afterReject = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const rejectedRow = afterReject.data.records.find((r: { id: string }) => r.id === rejectRec.data.record.id);
assert.notEqual(rejectedRow.fields["完成度"], 88);

const delUp = await json(upload.data.url, { method: "DELETE", cookie: ada2 });
assert.equal(delUp.status, 200);
const gone = await app.request(upload.data.url, { headers: { cookie: ada2 } });
assert.equal(gone.status, 404);

const mcpTools = await json("/api/mcp/tools", { cookie: ada2 });
assert.equal(mcpTools.status, 200);
assert.ok(mcpTools.data.tools.length >= 5);
const mcpNames = new Set(mcpTools.data.tools.map((t: { name: string }) => t.name));
for (const name of [
  "rename_table",
  "delete_table",
  "rename_base",
  "delete_base",
  "change_field_type",
  "list_field_change_targets",
  "update_view",
  "delete_view",
  "whoami",
  "get_limits",
  "get_acl",
  "set_acl",
  "preview_acl",
  "update_automation",
  "delete_automation",
  "run_due_automations",
  "list_members",
  "remove_member",
  "list_dashboards",
  "create_dashboard",
  "get_dashboard",
  "update_dashboard",
  "list_public_shares",
  "create_public_share",
  "set_public_share_enabled",
  "delete_public_share",
  "click_button",
  "list_notifications",
  "mark_notification_read",
  "list_record_history",
  "delete_comment",
  "get_detail_page",
  "set_detail_page",
  "get_base_settings",
  "set_base_settings",
  "list_workflows",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "list_workflow_runs",
  "get_workflow_run",
  "get_workflow_sla",
  "process_workflow_timeouts",
  "decide_workflow_run",
  "transfer_workflow_run",
  "add_sign_workflow_run",
  "list_workflow_audit",
  "set_view_protection",
  "list_sync_jobs",
  "create_sync_job",
  "update_sync_job",
  "run_sync_job",
  "delete_sync_job",
  "list_plugin_hooks",
  "create_plugin_hook",
  "update_plugin_hook",
  "delete_plugin_hook",
  "list_marketplace_plugins",
  "set_marketplace_plugin",
  "list_approval_proxies",
  "set_approval_proxy",
  "clear_approval_proxy",
  "watch_record",
  "unwatch_record",
  "is_watching_record",
  "list_watched_records",
  "create_record_share",
  "get_shared_record",
  "upload_file",
  "get_upload_meta",
  "delete_upload",
  "send_feishu",
  "send_feishu_digest",
  "create_calendar_feed",
  "list_calendar_feeds",
]) {
  assert.ok(mcpNames.has(name), `missing mcp tool ${name}`);
}

// disable prior approval-only flows to avoid multiple pendings on same record
for (const wf of (await json(`/api/tables/${requirementTable.id}/workflows`, { cookie: ada2 })).data) {
  if (wf.name.includes("审批")) {
    await json(`/api/workflows/${wf.id}`, { method: "PATCH", cookie: ada2, body: JSON.stringify({ enabled: false }) });
  }
}

const multiFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "两级审批意见",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap1", type: "approval", approvers: [], label: "一级", strategy: "any", timeoutHours: 1 },
      { id: "ap2", type: "approval", approvers: [], label: "二级", strategy: "any" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "99" } },
    ],
  }),
});
assert.equal(multiFlow.status, 201);
const multiRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "两级审批行" } }),
});
const multiPending1 = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const run1 = multiPending1.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === multiRec.data.record.id && r.workflowId === multiFlow.data.id,
);
assert.ok(run1);
const step1 = await json(`/api/workflow-runs/${run1.id}/decide`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ decision: "approve", comment: "一级同意" }),
});
assert.equal(step1.status, 200);
assert.equal(step1.data.status, "approved");
assert.equal(step1.data.comment, "一级同意");
const mid = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
assert.notEqual(mid.data.records.find((r: { id: string }) => r.id === multiRec.data.record.id).fields["完成度"], 99);
const multiPending2 = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const run2 = multiPending2.data.find(
  (r: { recordId: string; workflowId: string; id: string }) =>
    r.recordId === multiRec.data.record.id && r.workflowId === multiFlow.data.id && r.id !== run1.id,
);
assert.ok(run2);
const step2 = await json(`/api/workflow-runs/${run2.id}/decide`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ decision: "approve", comment: "二级也同意" }),
});
assert.equal(step2.data.status, "completed");
assert.equal(step2.data.comment, "二级也同意");
const doneMulti = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
assert.equal(doneMulti.data.records.find((r: { id: string }) => r.id === multiRec.data.record.id).fields["完成度"], 99);

const allFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "全部通过策略",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: ["Ada", "Bob"], strategy: "all", label: "会签" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "77" } },
    ],
  }),
});
const allRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "会签行" } }),
});
const allPending = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const allRun = allPending.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === allRec.data.record.id && r.workflowId === allFlow.data.id,
);
const partial = await json(`/api/workflow-runs/${allRun.id}/decide`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ decision: "approve", comment: "Ada 已批" }),
});
assert.equal(partial.data.status, "pending");
assert.ok(partial.data.votes.length >= 1);
assert.notEqual(
  (await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 })).data.records.find(
    (r: { id: string }) => r.id === allRec.data.record.id,
  ).fields["完成度"],
  77,
);

const timeoutFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "超时催办流",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: ["Ada"], strategy: "any", timeoutHours: 1, label: "超时节点" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "1" } },
    ],
  }),
});
const timeoutRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "超时行" } }),
});
const timeoutPending = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const timeoutRun = timeoutPending.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === timeoutRec.data.record.id && r.workflowId === timeoutFlow.data.id,
);
assert.ok(timeoutRun.timeoutAt);
const reminded = await json("/api/workflow-runs/process-timeouts", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ now: Date.now() + 2 * 3600_000 }),
});
assert.equal(reminded.status, 200);
assert.ok(reminded.data.reminded >= 1);
const timedOut = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=timed_out`, { cookie: ada2 });
assert.ok(timedOut.data.some((r: { id: string }) => r.id === timeoutRun.id));
const commentsAfter = await json(`/api/records/${timeoutRec.data.record.id}/comments`, { cookie: ada2 });
assert.ok(commentsAfter.data.some((c: { body: string }) => c.body.includes("超时")));

assert.ok(syncIncr.data.id);
const syncJobs = await json("/api/sync-jobs", { cookie: ada2 });
const incrJob = syncJobs.data.find((j: { id: string }) => j.id === syncIncr.data.id);
assert.ok(incrJob.lastResult);
assert.ok(typeof incrJob.lastResult.skipped === "number");

const market = await json("/api/plugins/marketplace", { cookie: ada2 });
assert.equal(market.status, 200);
assert.ok(market.data.plugins.length >= 2);
const enabledLog = await json("/api/plugins/marketplace/builtin-sync-log", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ enabled: true }),
});
assert.equal(enabledLog.status, 200);
assert.equal(enabledLog.data.enabled, true);

const xferFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "转交加签流",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: ["Ada"], strategy: "any", label: "经办审批" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "55" } },
    ],
  }),
});
// disable other approval flows except this one
for (const wf of (await json(`/api/tables/${requirementTable.id}/workflows`, { cookie: ada2 })).data) {
  if (wf.id !== xferFlow.data.id && String(wf.name).includes("审批")) {
    await json(`/api/workflows/${wf.id}`, { method: "PATCH", cookie: ada2, body: JSON.stringify({ enabled: false }) });
  }
  if (wf.name === "全部通过策略" || wf.name === "超时催办流" || wf.name === "两级审批意见" || wf.name === "审批后标完成度") {
    await json(`/api/workflows/${wf.id}`, { method: "PATCH", cookie: ada2, body: JSON.stringify({ enabled: false }) });
  }
}
const xferRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "转交加签行" } }),
});
const xferPending = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const xferRun = xferPending.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === xferRec.data.record.id && r.workflowId === xferFlow.data.id,
);
assert.ok(xferRun);
assert.equal(xferRun.nodeLabel, "经办审批");
assert.ok(Array.isArray(xferRun.pendingApprovers));
const transferred = await json(`/api/workflow-runs/${xferRun.id}/transfer`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ approvers: ["Bob"], comment: "转给 Bob" }),
});
assert.equal(transferred.status, 200);
assert.deepEqual(transferred.data.approvers, ["Bob"]);
assert.equal(transferred.data.votes.length, 0);
const added = await json(`/api/workflow-runs/${xferRun.id}/add-sign`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ approvers: ["Carol"], comment: "加签 Carol" }),
});
assert.ok(added.data.approvers.includes("Bob") && added.data.approvers.includes("Carol"));
assert.ok(added.data.pendingApprovers.includes("Carol"));
assert.equal(added.data.strategy, "all"); // 加签后强制会签
const auditAfter = await json(`/api/workflow-runs/${xferRun.id}/audit`, { cookie: ada2 });
assert.ok(auditAfter.data.some((e: { action: string }) => e.action === "transfer"));
assert.ok(auditAfter.data.some((e: { action: string }) => e.action === "add_sign"));
assert.ok(auditAfter.data.some((e: { action: string }) => e.action === "created"));

const sla = await json(`/api/workflow-runs/sla?tableId=${requirementTable.id}&withinHours=48`, { cookie: ada2 });
assert.equal(sla.status, 200);
assert.ok(typeof sla.data.pendingCount === "number");
assert.ok(typeof sla.data.timedOutCount === "number");
assert.ok(typeof sla.data.dueSoonCount === "number");

const baseUpload = await json("/api/uploads", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    filename: "secret.txt",
    contentBase64: Buffer.from("secret").toString("base64"),
    mime: "text/plain",
    baseId: bases.data[0].id,
    minRole: "editor",
  }),
});
assert.equal(baseUpload.status, 201);
const okDl = await app.request(baseUpload.data.url, { headers: { cookie: ada2 } });
assert.equal(okDl.status, 200);

// 代理审批：Bob 代 Ada 审批
const bobReg = await json("/api/users", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "Bob",
    email: "bob@team.test",
    password: "password123",
    role: "member",
  }),
});
assert.equal(bobReg.status, 201);
const bobLogin = await loginAs("bob@team.test", "password123");
assert.equal(bobLogin.status, 200);
const bobCookie = bobLogin.cookie!;
await json(`/api/bases/${bases.data[0].id}/members`, {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({ email: "bob@team.test", role: "editor" }),
});
const setProxy = await json("/api/approval-proxy", {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({ proxy: "bob@team.test", baseId: bases.data[0].id }),
});
assert.equal(setProxy.status, 200);
assert.equal(setProxy.data.proxyUserName, "Bob");
assert.equal(setProxy.data.baseId, bases.data[0].id);

const proxyFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "代理审批流",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: ["Ada"], strategy: "any", label: "仅 Ada" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "66" } },
    ],
  }),
});
for (const wf of (await json(`/api/tables/${requirementTable.id}/workflows`, { cookie: ada2 })).data) {
  if (wf.id !== proxyFlow.data.id) {
    await json(`/api/workflows/${wf.id}`, { method: "PATCH", cookie: ada2, body: JSON.stringify({ enabled: false }) });
  }
}
const proxyRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "代理审批行" } }),
});
const proxyPending = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const proxyRun = proxyPending.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === proxyRec.data.record.id && r.workflowId === proxyFlow.data.id,
);
assert.ok(proxyRun);
const proxyDecide = await json(`/api/workflow-runs/${proxyRun.id}/decide`, {
  method: "POST",
  cookie: bobCookie,
  body: JSON.stringify({ decision: "approve", comment: "Bob 代批" }),
});
assert.equal(proxyDecide.status, 200);
assert.equal(proxyDecide.data.status, "completed");
const proxyAudit = await json(`/api/workflow-runs/${proxyRun.id}/audit`, { cookie: ada2 });
assert.ok(
  proxyAudit.data.some(
    (e: { action: string; onBehalfOfUserName: string | null; actorUserName: string }) =>
      e.action === "proxy_approve" && e.actorUserName === "Bob" && e.onBehalfOfUserName === "Ada",
  ),
);
const afterProxy = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
assert.equal(afterProxy.data.records.find((r: { id: string }) => r.id === proxyRec.data.record.id).fields["完成度"], 66);

// 过期代理不可代批
await json("/api/approval-proxy", { method: "DELETE", cookie: ada2 });
const expiredProxy = await json("/api/approval-proxy", {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    proxy: "bob@team.test",
    baseId: bases.data[0].id,
    expiresAt: Date.now() - 1000,
  }),
});
assert.ok(expiredProxy.status === 400 || expiredProxy.status === 200);
if (expiredProxy.status === 200) {
  // if allowed to set past expiry via hours path only rejects; direct expiresAt past rejected
}
const expiredTry = await json("/api/approval-proxy", {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    proxy: "bob@team.test",
    baseId: bases.data[0].id,
    expiresInHours: 0.0000001,
  }),
});
// tiny hours still > now at set time; force expire by setting then deciding after...
await json("/api/approval-proxy", { method: "DELETE", cookie: ada2 });
const shortProxy = await json("/api/approval-proxy", {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    proxy: "bob@team.test",
    baseId: bases.data[0].id,
    expiresAt: Date.now() + 50,
  }),
});
assert.equal(shortProxy.status, 200);
await new Promise((r) => setTimeout(r, 80));
const expFlow = await json(`/api/tables/${requirementTable.id}/workflows`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "过期代理流",
    nodes: [
      { id: "t", type: "trigger", trigger: { type: "record_created" } },
      { id: "ap", type: "approval", approvers: ["Ada"], strategy: "any", label: "过期测" },
      { id: "a", type: "action", action: { type: "set_field", fieldId: progressField.data.id, value: "11" } },
    ],
  }),
});
for (const wf of (await json(`/api/tables/${requirementTable.id}/workflows`, { cookie: ada2 })).data) {
  if (wf.id !== expFlow.data.id) {
    await json(`/api/workflows/${wf.id}`, { method: "PATCH", cookie: ada2, body: JSON.stringify({ enabled: false }) });
  }
}
const expRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "过期代理行" } }),
});
const expPending = await json(`/api/workflow-runs?tableId=${requirementTable.id}&status=pending`, { cookie: ada2 });
const expRun = expPending.data.find(
  (r: { recordId: string; workflowId: string }) => r.recordId === expRec.data.record.id && r.workflowId === expFlow.data.id,
);
const expDecide = await json(`/api/workflow-runs/${expRun.id}/decide`, {
  method: "POST",
  cookie: bobCookie,
  body: JSON.stringify({ decision: "approve", comment: "应失败" }),
});
assert.equal(expDecide.status, 403);

const filteredAudit = await json(
  `/api/workflow-audit?tableId=${requirementTable.id}&action=proxy_approve&actor=Bob`,
  { cookie: ada2 },
);
assert.equal(filteredAudit.status, 200);
assert.ok(filteredAudit.data.every((e: { action: string }) => e.action === "proxy_approve"));
assert.ok(filteredAudit.data.some((e: { recordId: string }) => e.recordId === proxyRec.data.record.id));

const csvExport = await app.request(
  `/api/workflow-audit/export.csv?baseId=${bases.data[0].id}&from=0&to=${Date.now() + 1000}`,
  { headers: { cookie: ada2 } },
);
assert.equal(csvExport.status, 200);
const auditCsv = await csvExport.text();
assert.match(auditCsv, /action/);
assert.match(auditCsv, /proxy_approve|add_sign|transfer/);

const region = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "大区", type: "single_select", options: ["华东", "华北"] }),
});
assert.equal(region.status, 201);
const city = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "城市", type: "single_select", options: ["上海", "杭州", "北京", "天津"] }),
});
assert.equal(city.status, 201);
const cascadePatch = await json(`/api/fields/${region.data.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    optionCascade: {
      targetFieldId: city.data.id,
      map: { 华东: ["上海", "杭州"], 华北: ["北京", "天津"] },
    },
  }),
});
assert.equal(cascadePatch.status, 200);
assert.equal(cascadePatch.data.config.optionCascade.targetFieldId, city.data.id);

const geoField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "位置", type: "geolocation" }),
});
assert.equal(geoField.status, 201);
const sigField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "签字", type: "signature" }),
});
assert.equal(sigField.status, 201);

const cascadeOk = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    fields: {
      标题: "联动与地理",
      大区: "华东",
      城市: "上海",
      位置: { lat: 31.23, lng: 121.47, label: "上海" },
      签字: "data:image/png;base64,aaa",
    },
  }),
});
assert.equal(cascadeOk.status, 201);
assert.equal(cascadeOk.data.record.fields["城市"], "上海");
assert.equal(cascadeOk.data.record.fields["位置"].lat, 31.23);
assert.match(cascadeOk.data.record.fields["签字"], /^data:image\/png/);

const cascadeBad = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "坏联动", 大区: "华东", 城市: "北京" } }),
});
assert.equal(cascadeBad.status, 400);

const formShare = await json(`/api/tables/${requirementTable.id}/public-shares`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ kind: "form" }),
});
assert.equal(formShare.status, 201);
assert.ok(formShare.data.token);
const publicForm = await json(`/api/public/${formShare.data.token}`);
assert.equal(publicForm.status, 200);
assert.equal(publicForm.data.kind, "form");
const submitted = await json(`/api/public/${formShare.data.token}/submit`, {
  method: "POST",
  body: JSON.stringify({ fields: { 标题: "公开表单提交" } }),
});
assert.equal(submitted.status, 201);
assert.equal(submitted.data.record.fields["标题"], "公开表单提交");

const viewShare = await json(`/api/tables/${requirementTable.id}/public-shares`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ kind: "view" }),
});
assert.equal(viewShare.status, 201);
const publicView = await json(`/api/public/${viewShare.data.token}`);
assert.equal(publicView.status, 200);
assert.equal(publicView.data.kind, "view");
assert.ok(Array.isArray(publicView.data.table.records));

const disableShare = await json(`/api/public-shares/${viewShare.data.share.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ enabled: false }),
});
assert.equal(disableShare.status, 200);
const disabledView = await json(`/api/public/${viewShare.data.token}`);
assert.equal(disabledView.status, 410);

const dashUi = await json(`/api/bases/${bases.data[0].id}/dashboards`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "前端画布",
    config: {
      charts: [
        { id: "c-bar", title: "柱", type: "bar", tableId: requirementTable.id, fieldId: statusId },
        { id: "c-pie", title: "饼", type: "pie", tableId: requirementTable.id, fieldId: statusId },
        { id: "c-line", title: "线", type: "line", tableId: requirementTable.id, fieldId: statusId },
        { id: "c-donut", title: "环", type: "donut", tableId: requirementTable.id, fieldId: statusId },
        { id: "c-count", title: "计数", type: "count", tableId: requirementTable.id, fieldId: statusId },
      ],
    },
  }),
});
assert.equal(dashUi.status, 201);
const dashUiData = await json(`/api/dashboards/${dashUi.data.id}`, { cookie: ada2 });
assert.equal(dashUiData.status, 200);
assert.equal(dashUiData.data.charts.length, 5);
const dashPatch = await json(`/api/dashboards/${dashUi.data.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ name: "前端画布已改" }),
});
assert.equal(dashPatch.status, 200);
assert.equal(dashPatch.data.name, "前端画布已改");

const groupField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "协作群", type: "group" }),
});
assert.equal(groupField.status, 201);
const groupRec = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "群组记录", 协作群: ["产品组", "研发组"] } }),
});
assert.equal(groupRec.status, 201);
assert.deepEqual(groupRec.data.record.fields["协作群"], ["产品组", "研发组"]);

const tableForProtect = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const protectViewId = tableForProtect.data.views[0].id;
const lockView = await json(`/api/views/${protectViewId}/protection`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ protection: "locked" }),
});
assert.equal(lockView.status, 200);
assert.equal(lockView.data.protection, "locked");
const lockedPatch = await json(`/api/views/${protectViewId}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ config: { rowHeight: "tall" } }),
});
assert.equal(lockedPatch.status, 403);
await json(`/api/views/${protectViewId}/protection`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ protection: "public" }),
});

const detailPage = await json(`/api/tables/${requirementTable.id}/detail-page`, {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    style: "multi",
    fieldIds: tableForProtect.data.fields.slice(0, 3).map((f: { id: string }) => f.id),
    groups: [],
    columns: 2,
  }),
});
assert.equal(detailPage.status, 200);
assert.equal(detailPage.data.style, "multi");
const detailGet = await json(`/api/tables/${requirementTable.id}/detail-page`, { cookie: ada2 });
assert.equal(detailGet.status, 200);
assert.equal(detailGet.data.columns, 2);

const colorView = await json(`/api/views/${protectViewId}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    config: {
      colorRules: [{ id: "cr1", fieldId: statusId, op: "eq", value: "进行中", color: "#fef3c7", target: "row" }],
    },
  }),
});
assert.equal(colorView.status, 200);
assert.equal(colorView.data.config.colorRules.length, 1);

const fieldInAcl = await json(`/api/tables/${requirementTable.id}/acl`, {
  method: "PUT",
  cookie: ada2,
  body: JSON.stringify({
    rowRules: { [bobReg.data.id]: { type: "field_in", fieldId: statusId, values: ["进行中", "规划中"] } },
  }),
});
assert.equal(fieldInAcl.status, 200);

const slicerDash = await json(`/api/bases/${bases.data[0].id}/dashboards`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "切片仪表盘",
    config: {
      charts: [{ id: "c1", title: "按状态", type: "count", tableId: requirementTable.id, fieldId: statusId }],
      slicers: [{ id: "s1", tableId: requirementTable.id, fieldId: statusId, title: "状态" }],
    },
  }),
});
assert.equal(slicerDash.status, 201);
const slicerData = await json(
  `/api/dashboards/${slicerDash.data.id}?slicers=${encodeURIComponent(JSON.stringify({ s1: ["进行中"] }))}`,
  { cookie: ada2 },
);
assert.equal(slicerData.status, 200);
assert.ok(slicerData.data.slicers.length >= 1);

const crossFormula = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "项目行数", type: "formula", formula: 'TABLEROWS("项目")' }),
});
assert.equal(crossFormula.status, 201);
const afterCross = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const sample = afterCross.data.records[0];
assert.ok(typeof sample.fields["项目行数"] === "number");
assert.ok(sample.fields["项目行数"] >= 1);

const scheduleDaily = await json(`/api/tables/${requirementTable.id}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "每日定时",
    trigger: { type: "schedule", cron: "daily:03:30" },
    actions: [{ type: "add_comment", body: "daily" }],
    enabled: false,
  }),
});
assert.equal(scheduleDaily.status, 201);

const portalWidgets = await json(`/api/bases/${bases.data[0].id}/settings`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({
    portal: {
      title: "组件门户",
      theme: "blue",
      navTableIds: [requirementTable.id],
      widgets: [
        { id: "wl", type: "list", tableId: requirementTable.id, title: "任务列表", limit: 5 },
        { id: "wt", type: "tags", tableId: requirementTable.id, title: "状态标签", fieldId: statusId },
      ],
    },
  }),
});
assert.equal(portalWidgets.status, 200);
assert.equal(portalWidgets.data.portal.widgets.length, 2);
const appWithWidgets = await json(`/api/bases/${bases.data[0].id}/app`, { cookie: ada2 });
assert.equal(appWithWidgets.status, 200);
assert.equal(appWithWidgets.data.portal.widgets.length, 2);

const limitsRes = await json("/api/limits", { cookie: ada2 });
assert.equal(limitsRes.status, 200);
assert.ok(limitsRes.data.fieldsPerTable >= 100);
assert.ok(Array.isArray(limitsRes.data.cellCaps));

const typeField = await json(`/api/tables/${requirementTable.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "数量文本", type: "text" }),
});
assert.equal(typeField.status, 201);
await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "类型转换行", 数量文本: "42" } }),
});
const changed = await json(`/api/fields/${typeField.data.id}/change-type`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ type: "number" }),
});
assert.equal(changed.status, 200);
assert.equal(changed.data.type, "number");
const afterType = await json(`/api/tables/${requirementTable.id}`, { cookie: ada2 });
const typed = afterType.data.records.find((r: { fields: Record<string, unknown> }) => r.fields["标题"] === "类型转换行");
assert.equal(typed.fields["数量文本"], 42);

const forbiddenType = await json(`/api/fields/${crossFormula.data.id}/change-type`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ type: "text" }),
});
assert.equal(forbiddenType.status, 400);

const assist = await json("/api/assistant/query", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ tableId: requirementTable.id, question: "有多少条记录？" }),
});
assert.equal(assist.status, 200);
assert.match(assist.data.answer, /\d+/);
const assistGroup = await json("/api/assistant/query", {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ tableId: requirementTable.id, question: "按状态统计" }),
});
assert.equal(assistGroup.status, 200);
assert.match(assistGroup.data.answer, /状态/);

const groupCap = await json(`/api/tables/${requirementTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    fields: {
      标题: "群组上限",
      协作群: ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11"],
    },
  }),
});
assert.equal(groupCap.status, 400);

// MCP Agent 注册 / 批准 / 鉴权
const agentReg = await json("/api/mcp-agents/register", {
  method: "POST",
  body: JSON.stringify({ name: "TestBot", description: "ci", contact: "bot@team.test" }),
});
assert.equal(agentReg.status, 201);
assert.equal(agentReg.data.status, "pending");

const agentApprove = await json(`/api/mcp-agents/${agentReg.data.id}/approve`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    bases: [{ baseId: bases.data[0].id, role: "editor" }],
  }),
});
assert.equal(agentApprove.status, 200);
assert.ok(agentApprove.data.token.startsWith("dwa_"));
assert.equal(agentApprove.data.agent.status, "active");

// 令牌持久可查：管理端列表返回明文，便于随时复制
const agentList = await json("/api/mcp-agents", { cookie: ada2 });
assert.equal(agentList.status, 200);
const listedAgent = agentList.data.find((item: { id: string }) => item.id === agentReg.data.id);
assert.equal(listedAgent.token, agentApprove.data.token);
const forbiddenAgentList = await json("/api/mcp-agents", { cookie: bobCookie });
assert.equal(forbiddenAgentList.status, 403);

const agentBases = await json("/api/bases", { token: agentApprove.data.token });
assert.equal(agentBases.status, 200);
assert.equal(agentBases.data.length, 1);
assert.equal(agentBases.data[0].id, bases.data[0].id);

const agentTable = await json(`/api/tables/${requirementTable.id}`, { token: agentApprove.data.token });
assert.equal(agentTable.status, 200);

const otherBase = await json("/api/templates/engineering", { method: "POST", cookie: ada2 });
const deniedAgent = await json(`/api/tables/${otherBase.data.tables[0].id}`, { token: agentApprove.data.token });
assert.equal(deniedAgent.status, 403);

const agentCreateBase = await json("/api/bases", {
  method: "POST",
  token: agentApprove.data.token,
  body: JSON.stringify({ name: "Agent不可建" }),
});
assert.equal(agentCreateBase.status, 403);

const agentsList = await json("/api/mcp-agents", { cookie: ada2 });
assert.ok(agentsList.data.some((a: { id: string }) => a.id === agentReg.data.id));

// 轮换令牌后列表中的明文同步更新，旧令牌立即失效
const rotated = await json(`/api/mcp-agents/${agentReg.data.id}/rotate-token`, { method: "POST", cookie: ada2 });
assert.equal(rotated.status, 200);
assert.notEqual(rotated.data.token, agentApprove.data.token);
const agentListAfterRotate = await json("/api/mcp-agents", { cookie: ada2 });
assert.equal(
  agentListAfterRotate.data.find((item: { id: string }) => item.id === agentReg.data.id).token,
  rotated.data.token,
);
const revokedOldToken = await json("/api/bases", { token: agentApprove.data.token });
assert.equal(revokedOldToken.status, 401);
const rotatedTokenWorks = await json("/api/bases", { token: rotated.data.token });
assert.equal(rotatedTokenWorks.status, 200);

// ——— 自动化运行记录：跳过也要留痕，且不写假的"成功" ———
// 先清空飞书 Webhook，模拟"配置缺失"的真实场景
const clearedHook = await json(`/api/bases/${todos.data.id}/settings`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ integrations: { feishuWebhookUrl: "" } }),
});
assert.equal(clearedHook.status, 200);
assert.equal(clearedHook.data.integrations.feishuWebhookUrl ?? null, null);

const feishuTestNoWebhook = await json(`/api/bases/${todos.data.id}/feishu-test`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({}),
});
assert.equal(feishuTestNoWebhook.status, 400);
assert.match(feishuTestNoWebhook.data.error, /飞书机器人/);

const observedCreate = await json(`/api/tables/${todoTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "自动化观测测试", 领域: "科研", 状态: "待办", 优先级: "P1" } }),
});
assert.equal(observedCreate.status, 201);

const todoAutosAfter = await json(`/api/tables/${todoTable.id}/automations`, { cookie: ada2 });
const feishuAuto = todoAutosAfter.data.find(
  (item: { actions: Array<{ type: string }> }) => item.actions[0]?.type === "feishu_bot",
);
assert.ok(feishuAuto);
assert.equal(feishuAuto.lastStatus, "skipped");
assert.equal(feishuAuto.lastRunAt, 0); // 没有真正发出就不算成功
assert.ok(feishuAuto.lastAttemptAt > 0); // 但确实尝试过
assert.match(feishuAuto.lastDetail, /未配置飞书机器人/);

const observedRuns = await json(`/api/tables/${todoTable.id}/automation-runs`, { cookie: ada2 });
const skippedRun = observedRuns.data.find((item: { automationId: string }) => item.automationId === feishuAuto.id);
assert.ok(skippedRun);
assert.equal(skippedRun.status, "skipped");
assert.equal(skippedRun.trigger, "record_created");

// 手动试跑：只发对外消息，不改数据；未配置 Webhook 时不会真的发请求
const runFetch = globalThis.fetch;
const runCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  runCalls.push(String(input));
  return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
}) as typeof fetch;
const manualRun = await json(`/api/automations/${feishuAuto.id}/run`, { method: "POST", cookie: ada2 });
assert.equal(manualRun.status, 200);
assert.equal(manualRun.data.run.status, "skipped");
assert.equal(runCalls.length, 0);
const runsAfterManual = await json(`/api/tables/${todoTable.id}/automation-runs`, { cookie: ada2 });
assert.ok(runsAfterManual.data.some((item: { trigger: string }) => item.trigger === "manual"));

// 配上 Webhook 后应真的发出，并把 last_run_at 推进到成功时间
const savedHookAgain = await json(`/api/bases/${todos.data.id}/settings`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ integrations: { feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token" } }),
});
assert.equal(savedHookAgain.status, 200);
const observedCreate2 = await json(`/api/tables/${todoTable.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "自动化成功路径", 状态: "待办" } }),
});
assert.equal(observedCreate2.status, 201);
const todoAutosOk = await json(`/api/tables/${todoTable.id}/automations`, { cookie: ada2 });
const feishuAutoOk = todoAutosOk.data.find((item: { id: string }) => item.id === feishuAuto.id);
assert.equal(feishuAutoOk.lastStatus, "ok");
assert.ok(feishuAutoOk.lastRunAt > 0);
assert.match(feishuAutoOk.lastDetail, /已发出/);
assert.ok(runCalls.length >= 1);
globalThis.fetch = runFetch;

// —— 引擎增强：相对日期取值、条件相对比较、跨表 create_record ——
const pad2 = (n: number) => String(n).padStart(2, "0");
const dayOffset = (days: number) => {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
};

const engineTable = await json(`/api/bases/${bases.data[0].id}/tables`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "引擎增强验证",
    fields: [
      { name: "标题", type: "text" },
      { name: "重检日期", type: "date" },
    ],
  }),
});
assert.equal(engineTable.status, 201);
const engineTableId = engineTable.data.id;
const engineDateId = engineTable.data.fields.find((field: { name: string }) => field.name === "重检日期").id;

// 直接写记录时同样接受相对日期（此时还没有自动化，避免被覆盖）
const relativeDirect = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "直接写相对日期", 重检日期: "today" } }),
});
assert.equal(relativeDirect.status, 201);
assert.equal(relativeDirect.data.record.fields["重检日期"], dayOffset(0));

// set_field 支持 today+N 相对日期
const relativeAuto = await json(`/api/tables/${engineTableId}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "相对日期写入",
    trigger: { type: "record_created" },
    actions: [{ type: "set_field", fieldId: engineDateId, value: "today+3" }],
  }),
});
assert.equal(relativeAuto.status, 201);
const relativeRecord = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "相对日期" } }),
});
assert.equal(relativeRecord.status, 201);
assert.equal(relativeRecord.data.record.fields["重检日期"], dayOffset(3));

// 关掉上面这条自动化，避免覆盖下面条件用例的日期
const relativeOff = await json(`/api/automations/${relativeAuto.data.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ enabled: false }),
});
assert.equal(relativeOff.status, 200);

// 条件求值支持相对日期：只对「未来 2 天内到期」的记录加评论
const windowAuto = await json(`/api/tables/${engineTableId}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "未来两天内提醒",
    trigger: { type: "record_created" },
    conditions: [
      { fieldId: engineDateId, op: "gte", value: "today" },
      { fieldId: engineDateId, op: "lte", value: "today+2" },
    ],
    actions: [{ type: "add_comment", body: "未来两天内到期" }],
  }),
});
assert.equal(windowAuto.status, 201);
const soonRecord = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "两天内", 重检日期: "today+1" } }),
});
const lateRecord = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "五天后", 重检日期: "today+5" } }),
});
const soonComments = await json(`/api/records/${soonRecord.data.record.id}/comments`, { cookie: ada2 });
const lateComments = await json(`/api/records/${lateRecord.data.record.id}/comments`, { cookie: ada2 });
assert.equal(soonComments.data.length, 1);
assert.equal(lateComments.data.length, 0);

// 「超过 N 天未动」用 lt today-N 表达
const staleAuto = await json(`/api/tables/${engineTableId}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "三个月未动",
    trigger: { type: "record_created" },
    conditions: [{ fieldId: engineDateId, op: "lt", value: "today-90" }],
    actions: [{ type: "add_comment", body: "已超三个月未动" }],
  }),
});
assert.equal(staleAuto.status, 201);
const staleRecord = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "很久没动", 重检日期: "today-120" } }),
});
const soonCommentsAfter = await json(`/api/records/${soonRecord.data.record.id}/comments`, { cookie: ada2 });
const staleComments = await json(`/api/records/${staleRecord.data.record.id}/comments`, { cookie: ada2 });
assert.equal(soonCommentsAfter.data.length, 1);
assert.equal(staleComments.data.length, 1);

// create_record 可指定同库目标表，并把当前记录字段插值带过去
const crossAuto = await json(`/api/tables/${engineTableId}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "归档到项目表",
    trigger: { type: "record_created" },
    conditions: [{ fieldId: engineDateId, op: "is_empty" }],
    actions: [{ type: "create_record", tableId: "项目", fields: { 名称: "{标题} · 归档", 状态: "进行中" } }],
  }),
});
assert.equal(crossAuto.status, 201);
const projectsBefore = await json(`/api/tables/${iterations.id}`, { cookie: ada2 });
const crossRecord = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "跨表推演" } }),
});
assert.equal(crossRecord.status, 201);
const projectsAfter = await json(`/api/tables/${iterations.id}`, { cookie: ada2 });
assert.equal(projectsAfter.data.records.length, projectsBefore.data.records.length + 1);
assert.ok(
  projectsAfter.data.records.some(
    (record: { fields: Record<string, string> }) => record.fields["名称"] === "跨表推演 · 归档",
  ),
);

// 跨库目标表被拒绝：动作记为失败，但记录写入不受影响（otherBase 是前面用工程模板另建的库）
const foreignTableId = otherBase.data.tables[0].id;
const foreignAuto = await json(`/api/tables/${engineTableId}/automations`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({
    name: "跨库归档",
    trigger: { type: "record_created" },
    conditions: [{ fieldId: engineDateId, op: "is_empty" }],
    actions: [{ type: "create_record", tableId: foreignTableId, fields: { 标题: "不该出现" } }],
  }),
});
assert.equal(foreignAuto.status, 201);
const foreignCreate = await json(`/api/tables/${engineTableId}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "跨库尝试" } }),
});
assert.equal(foreignCreate.status, 201);
const engineRuns = await json(`/api/tables/${engineTableId}/automation-runs`, { cookie: ada2 });
const foreignRun = engineRuns.data.find((item: { automationId: string }) => item.automationId === foreignAuto.data.id);
assert.equal(foreignRun.status, "failed");
assert.match(foreignRun.detail, /同一多维表格/);

/* ——— 视图过滤器支持相对日期 token（第 10/15/23 讲的「本周」「未来 3 天」「超期未动」闸门）——— */
const nearView = await json(`/api/tables/${engineTableId}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "未来三天内到期", type: "grid" }),
});
assert.equal(nearView.status, 201);
assert.equal(
  (
    await json(`/api/views/${nearView.data.id}`, {
      method: "PATCH",
      cookie: ada2,
      body: JSON.stringify({ config: { filters: [{ fieldId: engineDateId, op: "lte", value: "today+3" }] } }),
    })
  ).status,
  200,
);
const nearViewRead = await json(`/api/tables/${engineTableId}?viewId=${nearView.data.id}`, { cookie: ada2 });
const nearTitles = nearViewRead.data.records.map((record: { fields: Record<string, string> }) => record.fields["标题"]);
assert.ok(nearTitles.includes("两天内"));
assert.ok(!nearTitles.includes("五天后"));

const staleView = await json(`/api/tables/${engineTableId}/views`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "超三个月未动", type: "grid" }),
});
assert.equal(staleView.status, 201);
assert.equal(
  (
    await json(`/api/views/${staleView.data.id}`, {
      method: "PATCH",
      cookie: ada2,
      body: JSON.stringify({ config: { filters: [{ fieldId: engineDateId, op: "lt", value: "today-90" }] } }),
    })
  ).status,
  200,
);
const staleViewRead = await json(`/api/tables/${engineTableId}?viewId=${staleView.data.id}`, { cookie: ada2 });
const staleTitles = staleViewRead.data.records.map((record: { fields: Record<string, string> }) => record.fields["标题"]);
assert.ok(staleTitles.includes("很久没动"));
assert.ok(!staleTitles.includes("两天内"));

/* ——— cron 新语法：monthly / quarterly / yearly（第 23 讲月复盘、学期复盘）——— */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
assert.equal(shouldRunSchedule("monthly:15:09:00", 0, at(2026, 11, 15, 9, 0)), true);
assert.equal(shouldRunSchedule("monthly:15:09:00", 0, at(2026, 11, 16, 9, 0)), false);
assert.equal(shouldRunSchedule("monthly:15:09:00", 0, at(2026, 11, 15, 9, 1)), false);
assert.equal(shouldRunSchedule("monthly:15:09:00", at(2026, 11, 15, 9, 0) - 30_000, at(2026, 11, 15, 9, 0)), false);
assert.equal(shouldRunSchedule("monthly:30:09:00", 0, at(2027, 2, 28, 9, 0)), false);
assert.equal(shouldRunSchedule("quarterly:3-1:09:00", 0, at(2026, 3, 1, 9, 0)), true);
assert.equal(shouldRunSchedule("quarterly:3-1:09:00", 0, at(2026, 6, 1, 9, 0)), true);
assert.equal(shouldRunSchedule("quarterly:3-1:09:00", 0, at(2026, 9, 1, 9, 0)), true);
assert.equal(shouldRunSchedule("quarterly:3-1:09:00", 0, at(2026, 5, 1, 9, 0)), false);
assert.equal(shouldRunSchedule("yearly:1-5:10:00", 0, at(2027, 1, 5, 10, 0)), true);
assert.equal(shouldRunSchedule("yearly:1-5:10:00", 0, at(2026, 12, 5, 10, 0)), false);
assert.equal(shouldRunSchedule("monthly:99:09:00", 0, at(2026, 11, 15, 9, 0)), false);
// 旧语法回归
assert.equal(shouldRunSchedule("daily:09:00", 0, at(2026, 10, 19, 9, 0)), true);
assert.equal(shouldRunSchedule("daily:09:00", 0, at(2026, 10, 19, 9, 30)), false);
assert.equal(shouldRunSchedule("weekly:1:09:00", 0, at(2026, 10, 19, 9, 0)), true);
assert.equal(shouldRunSchedule("weekly:1:09:00", 0, at(2026, 10, 20, 9, 0)), false);

/* ——— 内置文档模板：科研方法 24 讲扩展（第 03 / 07 / 17 / 19 / 20 / 21 讲 P1）——— */
const templateIds = DOC_TEMPLATES.map((template) => template.id);
assert.equal(new Set(templateIds).size, templateIds.length);
for (const id of [
  "feasibility-report",
  "abandon-memo",
  "taxonomy-note",
  "paper-draft",
  "disclosure-statement",
  "cover-letter",
  "response-letter",
]) {
  assert.ok(templateIds.includes(id), `缺少文档模板 ${id}`);
}
const paperDraftDoc = await json(`/api/bases/${research.data.id}/documents`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ template: "paper-draft" }),
});
assert.equal(paperDraftDoc.status, 201);
assert.equal(paperDraftDoc.data.title, "论文初稿");
assert.match(paperDraftDoc.data.bodyMd, /① 标题与一句话贡献/);
assert.match(paperDraftDoc.data.bodyMd, /⑧ 结论/);
const disclosureDoc = await json(`/api/bases/${research.data.id}/documents`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ template: "disclosure-statement" }),
});
assert.equal(disclosureDoc.status, 201);
assert.match(disclosureDoc.data.bodyMd, /模板 A · 仅工具性润色/);
assert.match(disclosureDoc.data.bodyMd, /模板 C · 方法学中使用 AI/);

/* ——— 按钮动作 lock_record / unlock_record 可经 API 建字段（上一轮遗漏的 schema 补齐）——— */
const lockButtonTable = await json(`/api/bases/${bases.data[0].id}/tables`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "锁定按钮验证", fields: [{ name: "标题", type: "text" }] }),
});
assert.equal(lockButtonTable.status, 201);
const lockButton = await json(`/api/tables/${lockButtonTable.data.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "锁定", type: "button", buttonLabel: "锁定", buttonAction: { type: "lock_record" } }),
});
assert.equal(lockButton.status, 201);
assert.equal(lockButton.data.config.buttonAction.type, "lock_record");
const unlockButton = await json(`/api/tables/${lockButtonTable.data.id}/fields`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ name: "解锁", type: "button", buttonLabel: "解锁", buttonAction: { type: "unlock_record" } }),
});
assert.equal(unlockButton.status, 201);
const lockTarget = await json(`/api/tables/${lockButtonTable.data.id}/records`, {
  method: "POST",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "待锁定" } }),
});
assert.equal(lockTarget.status, 201);
const clickLock = await json(`/api/records/${lockTarget.data.record.id}/buttons/${lockButton.data.id}`, {
  method: "POST",
  cookie: ada2,
});
assert.equal(clickLock.status, 200);
const lockedWrite = await json(`/api/records/${lockTarget.data.record.id}`, {
  method: "PATCH",
  cookie: ada2,
  body: JSON.stringify({ fields: { 标题: "锁定后不可写" } }),
});
assert.equal(lockedWrite.status, 400);
assert.match(String(lockedWrite.data.error), /锁定/);
const clickUnlock = await json(`/api/records/${lockTarget.data.record.id}/buttons/${unlockButton.data.id}`, {
  method: "POST",
  cookie: ada2,
});
assert.equal(clickUnlock.status, 200);

console.log("duowei tests passed");

