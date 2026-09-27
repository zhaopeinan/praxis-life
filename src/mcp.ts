import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { accounts, init, store } from "./context.js";
import { assertBaseRole } from "./access.js";
import { createTemplate, TEMPLATES, type TemplateId } from "./templates.js";
import { FIELD_TYPES, FILTER_OPS, type Field, type MemberRole, type PublicUser, type ViewConfig, type ViewType } from "./types.js";

const token = process.env.DUOWEI_TOKEN;
if (!token) {
  console.error("请设置环境变量 DUOWEI_TOKEN 为管理端「Agent 管理」发放的 Agent 令牌（dwa_…）。");
  process.exit(1);
}

await init();
const actor = await accounts.agentFromMcpToken(token);
if (!actor || actor.disabled) {
  console.error("DUOWEI_TOKEN 无效：需要已审批启用的 MCP Agent 令牌，个人访问令牌不能用于 MCP。");
  process.exit(1);
}

const server = new McpServer({ name: "duowei", version: "0.1.0" });
const user: PublicUser = actor;

const fieldType = z.enum(FIELD_TYPES);
const filterOp = z.enum(FILTER_OPS);
const viewType = z.enum(["grid", "kanban", "calendar", "gallery", "form", "gantt"]);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function run(work: () => Promise<unknown>) {
  try {
    return ok(await work());
  } catch (error) {
    return fail(error);
  }
}

async function visibleBases() {
  const bases = await store.listBases();
  if (user.role === "admin" && user.kind !== "agent") return bases;
  const ids = new Set(await accounts.visibleBaseIds(user));
  return bases.filter((base) => ids.has(base.id));
}

async function allowTable(tableId: string, role: MemberRole) {
  const located = await store.locateTable(tableId);
  await assertBaseRole(accounts, user, located.baseId, role);
  return located;
}

async function readTable(tableId: string, query?: Parameters<typeof store.getTable>[1]) {
  const payload = await store.getTable(tableId, query);
  if (user.role === "admin") return payload;
  const acl = await store.getTableAcl(tableId);
  return store.applyAclToPayload(payload, { userId: user.id, name: user.name, email: user.email }, acl);
}

function resolveField(fields: Field[], key: string): Field {
  const byId = fields.find((field) => field.id === key);
  if (byId) return byId;
  const byName = fields.filter((field) => field.name === key);
  if (byName.length === 1) return byName[0];
  throw new Error(byName.length === 0 ? `找不到字段：${key}` : `字段名不唯一：${key}`);
}

server.tool("list_bases", "列出当前账号可见的多维表格和其中的数据表", {}, async () => run(() => visibleBases()));

server.tool("whoami", "当前 MCP 身份（Agent 与角色）", {}, async () =>
  run(async () => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    kind: user.kind ?? "agent",
  })),
);

server.tool("get_limits", "查看 DuoWei 常见上限（表/字段/单元格等）", {}, async () =>
  run(async () => {
    const { getLimitsSnapshot } = await import("./limits.js");
    return getLimitsSnapshot();
  }),
);

server.tool(
  "create_base",
  "新建一个空的多维表格，当前账号成为所有者",
  { name: z.string().describe("多维表格名称") },
  async ({ name }) =>
    run(async () => {
      const base = await store.createBase(name);
      await accounts.addMember(base.id, user.id, "owner");
      return base;
    }),
);

server.tool(
  "rename_base",
  "重命名多维表格（需 owner）",
  { baseId: z.string(), name: z.string() },
  async ({ baseId, name }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "owner");
      return store.renameBase(baseId, name);
    }),
);

server.tool(
  "delete_base",
  "删除整个多维表格及其数据表（不可恢复，需 owner）",
  { baseId: z.string() },
  async ({ baseId }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "owner");
      await store.deleteBase(baseId);
      return { ok: true };
    }),
);

server.tool(
  "create_base_from_template",
  "从模板新建多维表格。requirements 需求管理，engineering 研发进度，todos 个人待办，research 科研管理（论文/任务/投稿）。",
  { template: z.enum(["requirements", "engineering", "todos", "research"]) },
  async ({ template }) =>
    run(async () => {
      const base = await createTemplate(store, template as TemplateId);
      await accounts.addMember(base.id, user.id, "owner");
      return base;
    }),
);

server.tool("list_templates", "列出可一键创建的多维表格模板", {}, async () => run(async () => TEMPLATES));

server.tool(
  "get_table",
  "读取数据表的字段、视图和记录。记录的 fields 以字段名为键，单选值是选项名称。",
  {
    tableId: z.string(),
    viewId: z.string().optional().describe("传入后按该视图的筛选和排序返回"),
  },
  async ({ tableId, viewId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return readTable(tableId, viewId ? { viewId } : undefined);
    }),
);

server.tool(
  "query_records",
  "按字段名筛选和排序记录。支持完整筛选运算符。单选请用选项名称。",
  {
    tableId: z.string(),
    filters: z.array(z.object({ field: z.string(), op: filterOp, value: z.string().optional() })).optional(),
    conjunction: z.enum(["and", "or"]).optional(),
    sorts: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ tableId, filters, conjunction, sorts, limit }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      const table = await readTable(tableId);
      return readTable(tableId, {
        filters: filters?.map((filter) => ({
          fieldId: resolveField(table.fields, filter.field).id,
          op: filter.op,
          value: filter.value,
        })),
        sorts: sorts?.map((sort) => ({ fieldId: resolveField(table.fields, sort.field).id, direction: sort.direction })),
        conjunction,
        limit,
      });
    }),
);

server.tool(
  "create_table",
  "在多维表格中新建数据表。withKanban 为 true 时，若存在单选字段会自动生成看板。",
  {
    baseId: z.string(),
    name: z.string(),
    fields: z
      .array(
        z.object({
          name: z.string(),
          type: fieldType,
          options: z.array(z.string()).optional(),
          formula: z.string().optional(),
          linkTableId: z.string().optional(),
          max: z.number().optional(),
          currency: z.string().optional(),
          prefix: z.string().optional(),
        }),
      )
      .optional(),
    withKanban: z.boolean().optional(),
  },
  async ({ baseId, name, fields, withKanban }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "editor");
      return store.createTable(baseId, { name, fields, withKanban });
    }),
);

server.tool(
  "rename_table",
  "重命名数据表",
  { tableId: z.string(), name: z.string() },
  async ({ tableId, name }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      await store.renameTable(tableId, name);
      return readTable(tableId);
    }),
);

server.tool(
  "delete_table",
  "删除数据表（不可恢复，需 owner）",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "owner");
      await store.deleteTable(tableId);
      return { ok: true };
    }),
);

server.tool(
  "create_field",
  "给数据表添加字段。支持人员/评分/进度/货币/公式/关联等类型。",
  {
    tableId: z.string(),
    name: z.string(),
    type: fieldType,
    options: z.array(z.string()).optional(),
    formula: z.string().optional(),
    linkTableId: z.string().optional(),
    max: z.number().optional(),
    currency: z.string().optional(),
    prefix: z.string().optional(),
  },
  async (args) =>
    run(async () => {
      await allowTable(args.tableId, "editor");
      return store.createField(args.tableId, args);
    }),
);

server.tool(
  "update_field",
  "重命名字段，或更新选项/公式/关联等配置",
  {
    fieldId: z.string(),
    name: z.string().optional(),
    options: z.array(z.string()).optional(),
    formula: z.string().optional(),
    linkTableId: z.string().optional(),
    max: z.number().optional(),
    currency: z.string().optional(),
    prefix: z.string().optional(),
  },
  async ({ fieldId, ...patch }) =>
    run(async () => {
      const located = await store.locateField(fieldId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateField(fieldId, patch);
    }),
);

server.tool("delete_field", "删除字段", { fieldId: z.string() }, async ({ fieldId }) =>
  run(async () => {
    const located = await store.locateField(fieldId);
    await assertBaseRole(accounts, user, located.baseId, "editor");
    await store.deleteField(fieldId);
    return { ok: true };
  }),
);

server.tool(
  "list_field_change_targets",
  "列出字段可变更到的目标类型（公式/按钮/系统字段等通常不可改）",
  { fieldId: z.string() },
  async ({ fieldId }) =>
    run(async () => {
      const located = await store.locateField(fieldId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      return { targets: await store.fieldTypeChangeTargets(fieldId) };
    }),
);

server.tool(
  "change_field_type",
  "更改字段类型并尽量转换已有单元格（就地转换有行数上限）",
  { fieldId: z.string(), type: fieldType },
  async ({ fieldId, type }) =>
    run(async () => {
      const located = await store.locateField(fieldId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.changeFieldType(fieldId, type);
    }),
);

server.tool(
  "create_record",
  "新建记录。fields 的键是字段名。",
  { tableId: z.string(), fields: z.record(z.string(), z.unknown()).optional() },
  async ({ tableId, fields }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createRecord(tableId, fields ?? {}, { userId: user.id, userName: user.name });
    }),
);

server.tool(
  "update_record",
  "更新记录的部分字段。把字段值设为 null 可以清空。",
  { recordId: z.string(), fields: z.record(z.string(), z.unknown()) },
  async ({ recordId, fields }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateRecord(recordId, fields, { userId: user.id, userName: user.name });
    }),
);

server.tool("delete_record", "删除记录", { recordId: z.string() }, async ({ recordId }) =>
  run(async () => {
    const located = await store.locateRecord(recordId);
    await assertBaseRole(accounts, user, located.baseId, "editor");
    await store.deleteRecord(recordId);
    return { ok: true };
  }),
);

server.tool(
  "create_view",
  "新建视图：grid/kanban/calendar/gallery/form/gantt",
  {
    tableId: z.string(),
    name: z.string(),
    type: viewType,
    groupField: z.string().optional(),
    dateField: z.string().optional(),
    titleField: z.string().optional(),
  },
  async ({ tableId, name, type, groupField, dateField, titleField }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createView(tableId, {
        name,
        type: type as ViewType,
        groupField,
        dateField,
        titleField,
      });
    }),
);

server.tool(
  "update_view",
  "更新视图名称或配置（筛选/排序/分组/行高等）",
  {
    viewId: z.string(),
    name: z.string().optional(),
    config: z.record(z.unknown()).optional(),
  },
  async ({ viewId, name, config }) =>
    run(async () => {
      const located = await store.locateView(viewId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateView(viewId, { name, config: config as Partial<ViewConfig> | undefined }, { userId: user.id });
    }),
);

server.tool(
  "delete_view",
  "删除视图（锁定视图不可删；个人视图仅创建者可删）",
  { viewId: z.string() },
  async ({ viewId }) =>
    run(async () => {
      const located = await store.locateView(viewId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      await store.deleteView(viewId, { userId: user.id });
      return { ok: true };
    }),
);

server.tool(
  "export_csv",
  "导出数据表为 CSV 文本",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return { csv: await store.exportCsv(tableId) };
    }),
);

server.tool(
  "import_csv",
  "导入 CSV 文本到数据表。第一行为字段名。",
  { tableId: z.string(), csv: z.string() },
  async ({ tableId, csv }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.importCsv(tableId, csv, { userId: user.id, userName: user.name });
    }),
);

server.tool(
  "list_comments",
  "列出记录评论",
  { recordId: z.string() },
  async ({ recordId }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      return store.listComments(recordId);
    }),
);

server.tool(
  "add_comment",
  "给记录添加评论",
  { recordId: z.string(), body: z.string() },
  async ({ recordId, body }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.addComment(recordId, user.id, user.name, body);
    }),
);

server.tool(
  "list_automations",
  "列出数据表自动化规则",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return store.listAutomations(tableId);
    }),
);

const automationTrigger = z.union([
  z.object({ type: z.literal("record_created") }),
  z.object({ type: z.literal("record_updated"), fieldId: z.string().optional() }),
  z.object({ type: z.literal("field_equals"), fieldId: z.string(), value: z.string() }),
  z.object({ type: z.literal("button"), fieldId: z.string() }),
  z.object({ type: z.literal("webhook"), secret: z.string().optional() }),
  z.object({ type: z.literal("schedule"), cron: z.string() }),
]);

const automationAction = z.union([
  z.object({ type: z.literal("set_field"), fieldId: z.string(), value: z.string() }),
  z.object({ type: z.literal("create_record"), fields: z.record(z.string()) }),
  z.object({ type: z.literal("add_comment"), body: z.string() }),
  z.object({ type: z.literal("notify"), message: z.string(), userId: z.string().optional() }),
  z.object({
    type: z.literal("http_request"),
    url: z.string(),
    method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }),
  z.object({ type: z.literal("send_email"), to: z.string(), subject: z.string(), text: z.string() }),
  z.object({ type: z.literal("feishu_bot"), text: z.string(), webhookUrl: z.string().optional() }),
  z.object({
    type: z.literal("feishu_digest"),
    text: z.string().optional(),
    daysAhead: z.number().optional(),
    dateField: z.string().optional(),
    excludeStatuses: z.array(z.string()).optional(),
    webhookUrl: z.string().optional(),
  }),
]);

server.tool(
  "create_automation",
  "创建自动化。触发含 record_created/updated/field_equals/button/webhook/schedule；动作含 set_field/create_record/add_comment/notify/http_request/send_email/feishu_bot/feishu_digest",
  {
    tableId: z.string(),
    name: z.string(),
    trigger: automationTrigger,
    actions: z.array(automationAction).min(1),
    conditions: z.array(z.object({ fieldId: z.string(), op: filterOp, value: z.string().optional() })).optional(),
    enabled: z.boolean().optional(),
  },
  async ({ tableId, name, trigger, actions, enabled, conditions }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createAutomation(tableId, { name, trigger, actions, enabled, conditions });
    }),
);

server.tool(
  "update_automation",
  "更新自动化（名称/启停/触发/动作/条件）",
  {
    automationId: z.string(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    trigger: automationTrigger.optional(),
    actions: z.array(automationAction).optional(),
    conditions: z.array(z.object({ fieldId: z.string(), op: filterOp, value: z.string().optional() })).optional(),
  },
  async ({ automationId, ...patch }) =>
    run(async () => {
      const located = await store.locateAutomation(automationId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateAutomation(automationId, patch);
    }),
);

server.tool("delete_automation", "删除自动化", { automationId: z.string() }, async ({ automationId }) =>
  run(async () => {
    const located = await store.locateAutomation(automationId);
    await assertBaseRole(accounts, user, located.baseId, "editor");
    await store.deleteAutomation(automationId);
    return { ok: true };
  }),
);

server.tool("run_due_automations", "手动跑一轮到期的定时自动化（仅系统 admin）", {}, async () =>
  run(async () => {
    if (user.role !== "admin") throw new Error("仅管理员可手动触发定时自动化");
    return { ran: await store.runDueSchedules() };
  }),
);

const rowRule = z.union([
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("allow_ids"), recordIds: z.array(z.string()) }),
  z.object({ type: z.literal("created_by") }),
  z.object({ type: z.literal("person_in"), fieldId: z.string() }),
  z.object({ type: z.literal("field_equals"), fieldId: z.string(), value: z.string() }),
  z.object({ type: z.literal("field_in"), fieldId: z.string(), values: z.array(z.string()) }),
]);

server.tool(
  "get_acl",
  "读取数据表高级权限（需 owner）",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "owner");
      return store.getTableAcl(tableId);
    }),
);

server.tool(
  "set_acl",
  "设置数据表行列权限（需 owner）。rowRules/columnDeny 的键为 userId",
  {
    tableId: z.string(),
    rowAllow: z.record(z.array(z.string())).optional(),
    columnDeny: z.record(z.array(z.string())).optional(),
    rowRules: z.record(rowRule).optional(),
  },
  async ({ tableId, ...body }) =>
    run(async () => {
      await allowTable(tableId, "owner");
      return store.setTableAcl(tableId, body);
    }),
);

server.tool(
  "preview_acl",
  "预览某成员在表上的可见行数与隐藏列（需 owner）",
  { tableId: z.string(), userId: z.string() },
  async ({ tableId, userId }) =>
    run(async () => {
      await allowTable(tableId, "owner");
      const users = await accounts.listUsers();
      const found = users.find((item) => item.id === userId);
      return store.previewAcl(tableId, userId, { name: found?.name, email: found?.email });
    }),
);

server.tool(
  "list_members",
  "列出多维表格成员",
  { baseId: z.string() },
  async ({ baseId }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "viewer");
      return accounts.listMembers(baseId);
    }),
);

server.tool(
  "share_base",
  "把多维表格分享给已注册用户。role 为 owner、editor 或 viewer。",
  {
    baseId: z.string(),
    email: z.string(),
    role: z.enum(["owner", "editor", "viewer"]),
  },
  async ({ baseId, email, role }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "owner");
      return accounts.setMember(baseId, email, role);
    }),
);

server.tool(
  "remove_member",
  "移除多维表格成员（需 owner）",
  { baseId: z.string(), userId: z.string() },
  async ({ baseId, userId }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "owner");
      return accounts.removeMember(baseId, userId);
    }),
);

server.tool(
  "list_dashboards",
  "列出 base 下仪表盘",
  { baseId: z.string() },
  async ({ baseId }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "viewer");
      return store.listDashboards(baseId);
    }),
);

server.tool(
  "create_dashboard",
  "创建仪表盘。charts: bar/pie/count/line/donut；可带 slicers",
  {
    baseId: z.string(),
    name: z.string(),
    config: z
      .object({
        charts: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            type: z.enum(["bar", "pie", "count", "line", "donut"]),
            tableId: z.string(),
            fieldId: z.string(),
          }),
        ),
        slicers: z
          .array(
            z.object({
              id: z.string(),
              tableId: z.string(),
              fieldId: z.string(),
              title: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  },
  async ({ baseId, name, config }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "editor");
      return store.createDashboard(baseId, name, config);
    }),
);

server.tool(
  "get_dashboard",
  "读取仪表盘聚合数据；slicers 为 { slicerId: [选项…] }",
  {
    dashboardId: z.string(),
    slicers: z.record(z.array(z.string())).optional(),
  },
  async ({ dashboardId, slicers }) =>
    run(async () => {
      const located = await store.locateDashboard(dashboardId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      return store.getDashboardData(dashboardId, slicers);
    }),
);

server.tool(
  "update_dashboard",
  "更新仪表盘名称或配置",
  {
    dashboardId: z.string(),
    name: z.string().optional(),
    config: z
      .object({
        charts: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            type: z.enum(["bar", "pie", "count", "line", "donut"]),
            tableId: z.string(),
            fieldId: z.string(),
          }),
        ),
        slicers: z
          .array(
            z.object({
              id: z.string(),
              tableId: z.string(),
              fieldId: z.string(),
              title: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  },
  async ({ dashboardId, name, config }) =>
    run(async () => {
      const located = await store.locateDashboard(dashboardId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateDashboard(dashboardId, { name, config });
    }),
);

server.tool(
  "list_public_shares",
  "列出表的公开分享（视图只读 / 表单）",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.listPublicShares(tableId);
    }),
);

server.tool(
  "create_public_share",
  "创建公开分享。kind=view|form；返回完整 token（仅此一次）",
  {
    tableId: z.string(),
    kind: z.enum(["view", "form"]),
    viewId: z.string().nullable().optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  },
  async ({ tableId, kind, viewId, expiresInDays }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createPublicShare(tableId, { kind, viewId, expiresInDays }, user.id);
    }),
);

server.tool(
  "set_public_share_enabled",
  "启用或关闭公开分享",
  { shareId: z.string(), enabled: z.boolean() },
  async ({ shareId, enabled }) =>
    run(async () => {
      const located = await store.locatePublicShare(shareId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.setPublicShareEnabled(shareId, enabled);
    }),
);

server.tool("delete_public_share", "删除公开分享", { shareId: z.string() }, async ({ shareId }) =>
  run(async () => {
    const located = await store.locatePublicShare(shareId);
    await assertBaseRole(accounts, user, located.baseId, "editor");
    await store.deletePublicShare(shareId);
    return { ok: true };
  }),
);

server.tool(
  "click_button",
  "点击记录上的按钮字段（执行按钮动作并触发相关自动化）",
  { recordId: z.string(), fieldId: z.string() },
  async ({ recordId, fieldId }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.clickButton(recordId, fieldId, { userId: user.id, userName: user.name });
    }),
);

server.tool("list_notifications", "列出当前用户通知", {}, async () =>
  run(async () => store.listNotifications(user.id)),
);

server.tool(
  "mark_notification_read",
  "将通知标为已读",
  { notificationId: z.string() },
  async ({ notificationId }) =>
    run(async () => {
      await store.markNotificationRead(notificationId, user.id);
      return { ok: true };
    }),
);

server.tool(
  "list_record_history",
  "查看记录变更历史",
  { recordId: z.string() },
  async ({ recordId }) =>
    run(async () => {
      await allowTable((await store.locateRecord(recordId)).tableId, "viewer");
      return store.listHistory(recordId);
    }),
);

server.tool(
  "delete_comment",
  "删除评论（本人或系统 admin）",
  { commentId: z.string() },
  async ({ commentId }) =>
    run(async () => {
      const located = await store.locateComment(commentId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      await store.deleteComment(commentId, { userId: user.id, isAdmin: user.role === "admin" });
      return { ok: true };
    }),
);

server.tool(
  "get_detail_page",
  "读取表的记录详情页布局",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return store.getDetailPage(tableId);
    }),
);

server.tool(
  "set_detail_page",
  "设置记录详情页布局（style: single/multi/grouped）",
  {
    tableId: z.string(),
    style: z.enum(["single", "multi", "grouped"]),
    fieldIds: z.array(z.string()),
    groups: z.array(z.object({ id: z.string(), title: z.string(), fieldIds: z.array(z.string()) })),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  },
  async ({ tableId, style, fieldIds, groups, columns }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.setDetailPage(tableId, { style, fieldIds, groups, columns });
    }),
);

server.tool(
  "get_base_settings",
  "读取多维表格时区与应用门户配置",
  { baseId: z.string() },
  async ({ baseId }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "viewer");
      return store.getBaseSettings(baseId);
    }),
);

server.tool(
  "set_base_settings",
  "更新时区或应用门户（需 owner）",
  {
    baseId: z.string(),
    timezone: z.string().optional(),
    portal: z
      .object({
        title: z.string().optional(),
        theme: z.enum(["light", "blue", "green"]).optional(),
        navTableIds: z.array(z.string()).optional(),
        hideChrome: z.boolean().optional(),
        widgets: z
          .array(
            z.discriminatedUnion("type", [
              z.object({
                id: z.string(),
                type: z.literal("list"),
                tableId: z.string(),
                title: z.string().optional(),
                limit: z.number().optional(),
                titleFieldId: z.string().optional(),
              }),
              z.object({
                id: z.string(),
                type: z.literal("image"),
                tableId: z.string(),
                title: z.string().optional(),
                attachmentFieldId: z.string(),
                limit: z.number().optional(),
              }),
              z.object({
                id: z.string(),
                type: z.literal("tags"),
                tableId: z.string(),
                title: z.string().optional(),
                fieldId: z.string(),
              }),
            ]),
          )
          .optional(),
      })
      .optional(),
    integrations: z.object({ feishuWebhookUrl: z.string().optional() }).optional(),
  },
  async ({ baseId, timezone, portal, integrations }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "owner");
      return store.updateBaseSettings(baseId, { timezone, portal, integrations });
    }),
);

server.tool(
  "send_feishu",
  "向当前多维表格配置的飞书自定义机器人发送一条文本。可临时覆盖 webhookUrl。",
  { baseId: z.string(), text: z.string(), webhookUrl: z.string().optional() },
  async ({ baseId, text, webhookUrl }) =>
    run(async () => {
      await assertBaseRole(accounts, user, baseId, "editor");
      const { sendFeishuText } = await import("./feishu.js");
      const settings = await store.getBaseSettings(baseId);
      const webhook = webhookUrl || settings.integrations.feishuWebhookUrl;
      if (!webhook) throw new Error("请先在设置里填写飞书机器人 Webhook");
      const result = await sendFeishuText(webhook, text);
      if (!result.ok) throw new Error(result.message || "飞书发送失败");
      return { ok: true };
    }),
);

server.tool(
  "send_feishu_digest",
  "把表内即将到期的待办汇总推到飞书。默认看截止日期、排除已完成/已搁置。",
  {
    tableId: z.string(),
    daysAhead: z.number().optional(),
    dateField: z.string().optional(),
    excludeStatuses: z.array(z.string()).optional(),
    text: z.string().optional(),
  },
  async ({ tableId, daysAhead, dateField, excludeStatuses, text }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.sendFeishuDigest(tableId, { type: "feishu_digest", daysAhead, dateField, excludeStatuses, text });
    }),
);

server.tool(
  "create_calendar_feed",
  "为数据表创建可订阅的 ICS 日历链接（苹果日历 / Google / 飞书日历均可订阅）。",
  { tableId: z.string(), dateFieldId: z.string().optional(), titleFieldId: z.string().optional() },
  async ({ tableId, dateFieldId, titleFieldId }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createCalendarFeed(tableId, { dateFieldId, titleFieldId });
    }),
);

server.tool(
  "list_calendar_feeds",
  "列出数据表的 ICS 日历订阅",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return store.listCalendarFeeds(tableId);
    }),
);

server.tool(
  "list_workflows",
  "列出数据表工作流",
  { tableId: z.string() },
  async ({ tableId }) =>
    run(async () => {
      await allowTable(tableId, "viewer");
      return store.listWorkflows(tableId);
    }),
);

server.tool(
  "create_workflow",
  "创建工作流。nodes 至少含 trigger，以及 action 或 approval",
  {
    tableId: z.string(),
    name: z.string(),
    enabled: z.boolean().optional(),
    nodes: z.array(z.record(z.unknown())).min(2),
  },
  async ({ tableId, name, enabled, nodes }) =>
    run(async () => {
      await allowTable(tableId, "editor");
      return store.createWorkflow(tableId, { name, enabled, nodes: nodes as never });
    }),
);

server.tool(
  "update_workflow",
  "更新工作流名称/启停/节点",
  {
    workflowId: z.string(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    nodes: z.array(z.record(z.unknown())).optional(),
  },
  async ({ workflowId, name, enabled, nodes }) =>
    run(async () => {
      const located = await store.locateWorkflow(workflowId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.updateWorkflow(workflowId, { name, enabled, nodes: nodes as never });
    }),
);

server.tool("delete_workflow", "删除工作流", { workflowId: z.string() }, async ({ workflowId }) =>
  run(async () => {
    const located = await store.locateWorkflow(workflowId);
    await assertBaseRole(accounts, user, located.baseId, "editor");
    await store.deleteWorkflow(workflowId);
    return { ok: true };
  }),
);

server.tool(
  "list_workflow_runs",
  "列出审批运行。status: pending/approved/rejected/completed/timed_out",
  {
    tableId: z.string().optional(),
    status: z.enum(["pending", "approved", "rejected", "completed", "timed_out"]).optional(),
  },
  async ({ tableId, status }) =>
    run(async () => {
      if (tableId) await allowTable(tableId, "viewer");
      return store.listWorkflowRuns({ tableId, status });
    }),
);

server.tool(
  "get_workflow_run",
  "读取单条审批运行详情",
  { runId: z.string() },
  async ({ runId }) =>
    run(async () => {
      const located = await store.locateWorkflowRun(runId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      return store.getWorkflowRun(runId);
    }),
);

server.tool(
  "get_workflow_sla",
  "审批 SLA 概览：待办、即将超时、已超时",
  {
    tableId: z.string().optional(),
    withinHours: z.number().positive().optional(),
  },
  async ({ tableId, withinHours }) =>
    run(async () => {
      if (tableId) await allowTable(tableId, "viewer");
      return store.getWorkflowSla({ tableId, withinHours });
    }),
);

server.tool(
  "process_workflow_timeouts",
  "处理审批超时与催办（仅系统 admin）",
  { now: z.number().optional() },
  async ({ now }) =>
    run(async () => {
      if (user.role !== "admin") throw new Error("需要系统 admin");
      return store.processWorkflowTimeouts(now);
    }),
);

server.tool(
  "decide_workflow_run",
  "审批通过或拒绝",
  {
    runId: z.string(),
    decision: z.enum(["approve", "reject"]),
    comment: z.string().optional(),
  },
  async ({ runId, decision, comment }) =>
    run(async () => {
      const located = await store.locateWorkflowRun(runId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.decideWorkflowRun(runId, decision, { userId: user.id, userName: user.name, comment });
    }),
);

server.tool(
  "transfer_workflow_run",
  "转交审批给其他人",
  {
    runId: z.string(),
    approvers: z.array(z.string()).min(1),
    comment: z.string().optional(),
  },
  async ({ runId, approvers, comment }) =>
    run(async () => {
      const located = await store.locateWorkflowRun(runId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.transferWorkflowRun(runId, approvers, { userId: user.id, userName: user.name, comment });
    }),
);

server.tool(
  "add_sign_workflow_run",
  "加签：追加审批人",
  {
    runId: z.string(),
    approvers: z.array(z.string()).min(1),
    comment: z.string().optional(),
  },
  async ({ runId, approvers, comment }) =>
    run(async () => {
      const located = await store.locateWorkflowRun(runId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.addSignWorkflowRun(runId, approvers, { userId: user.id, userName: user.name, comment });
    }),
);

server.tool(
  "list_workflow_audit",
  "查询工作流审计日志",
  {
    runId: z.string().optional(),
    tableId: z.string().optional(),
    baseId: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ runId, tableId, baseId, limit }) =>
    run(async () => {
      if (tableId) await allowTable(tableId, "viewer");
      if (baseId) await assertBaseRole(accounts, user, baseId, "viewer");
      return store.listWorkflowAudit({ runId, tableId, baseId, limit });
    }),
);

server.tool(
  "set_view_protection",
  "设置视图保护：public / locked / personal",
  { viewId: z.string(), protection: z.enum(["public", "locked", "personal"]) },
  async ({ viewId, protection }) =>
    run(async () => {
      const located = await store.locateView(viewId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.setViewProtection(viewId, protection, user.id);
    }),
);

server.tool("list_sync_jobs", "列出字段映射同步任务", {}, async () => run(async () => store.listSyncJobs()));

server.tool(
  "create_sync_job",
  "创建表间同步任务。fieldMap: 源字段名/id → 目标字段名/id",
  {
    name: z.string(),
    sourceTableId: z.string(),
    targetTableId: z.string(),
    fieldMap: z.record(z.string()),
    matchField: z.string().nullable().optional(),
    mode: z.enum(["full", "incremental"]).optional(),
    conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional(),
    enabled: z.boolean().optional(),
  },
  async (body) =>
    run(async () => {
      await allowTable(body.sourceTableId, "editor");
      await allowTable(body.targetTableId, "editor");
      return store.createSyncJob(body);
    }),
);

server.tool(
  "update_sync_job",
  "更新同步任务",
  {
    jobId: z.string(),
    name: z.string().optional(),
    mode: z.enum(["full", "incremental"]).optional(),
    conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional(),
    enabled: z.boolean().optional(),
  },
  async ({ jobId, ...patch }) =>
    run(async () => {
      const job = (await store.listSyncJobs()).find((item) => item.id === jobId);
      if (!job) throw new Error("找不到同步任务");
      await allowTable(job.sourceTableId, "editor");
      return store.updateSyncJob(jobId, patch);
    }),
);

server.tool(
  "run_sync_job",
  "立即执行同步任务",
  {
    jobId: z.string(),
    conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional(),
  },
  async ({ jobId, conflict }) =>
    run(async () => {
      const job = (await store.listSyncJobs()).find((item) => item.id === jobId);
      if (!job) throw new Error("找不到同步任务");
      await allowTable(job.sourceTableId, "editor");
      if (conflict) await store.updateSyncJob(jobId, { conflict });
      return store.runSyncJob(jobId);
    }),
);

server.tool("delete_sync_job", "删除同步任务", { jobId: z.string() }, async ({ jobId }) =>
  run(async () => {
    const job = (await store.listSyncJobs()).find((item) => item.id === jobId);
    if (!job) throw new Error("找不到同步任务");
    await allowTable(job.sourceTableId, "editor");
    await store.deleteSyncJob(jobId);
    return { ok: true };
  }),
);

server.tool("list_plugin_hooks", "列出插件钩子", {}, async () => run(async () => store.listPluginHooks()));

server.tool(
  "create_plugin_hook",
  "创建插件钩子（仅系统 admin）",
  {
    name: z.string(),
    event: z.enum(["record_created", "record_updated", "record_deleted", "workflow_ran"]),
    target: z.string(),
    enabled: z.boolean().optional(),
  },
  async (body) =>
    run(async () => {
      if (user.role !== "admin") throw new Error("需要系统 admin");
      return store.createPluginHook(body);
    }),
);

server.tool(
  "update_plugin_hook",
  "更新插件钩子（仅系统 admin）",
  {
    hookId: z.string(),
    name: z.string().optional(),
    target: z.string().optional(),
    enabled: z.boolean().optional(),
  },
  async ({ hookId, ...patch }) =>
    run(async () => {
      if (user.role !== "admin") throw new Error("需要系统 admin");
      return store.updatePluginHook(hookId, patch);
    }),
);

server.tool("delete_plugin_hook", "删除插件钩子（仅系统 admin）", { hookId: z.string() }, async ({ hookId }) =>
  run(async () => {
    if (user.role !== "admin") throw new Error("需要系统 admin");
    await store.deletePluginHook(hookId);
    return { ok: true };
  }),
);

server.tool("list_marketplace_plugins", "列出内置插件市场与最近事件", {}, async () =>
  run(async () => ({
    plugins: await store.listMarketplacePlugins(),
    recentEvents: store.listPluginEventLog(20),
  })),
);

server.tool(
  "set_marketplace_plugin",
  "启用/关闭市场插件（仅系统 admin）",
  {
    pluginId: z.string(),
    enabled: z.boolean(),
    webhookUrl: z.string().optional(),
  },
  async ({ pluginId, enabled, webhookUrl }) =>
    run(async () => {
      if (user.role !== "admin") throw new Error("需要系统 admin");
      return store.setMarketplacePlugin(pluginId, enabled, { webhookUrl });
    }),
);

server.tool("list_approval_proxies", "列出我设置的审批代理规则", {}, async () =>
  run(async () => {
    const proxies = await store.listApprovalProxies(user.id);
    return { proxies, proxy: proxies[0] ?? null };
  }),
);

server.tool(
  "set_approval_proxy",
  "设置审批代理人（邮箱或用户名）",
  {
    proxy: z.string(),
    baseId: z.string().nullable().optional(),
    workflowId: z.string().nullable().optional(),
    expiresAt: z.number().nullable().optional(),
    expiresInHours: z.number().nullable().optional(),
  },
  async ({ proxy, baseId, workflowId, expiresAt, expiresInHours }) =>
    run(async () => {
      const target = await accounts.findPublicByNameOrEmail(proxy);
      if (!target) throw new Error("找不到代理人用户（请用邮箱或唯一用户名）");
      let resolvedExpires = expiresAt ?? null;
      if (expiresInHours != null && expiresInHours > 0) {
        resolvedExpires = Date.now() + expiresInHours * 3600_000;
      }
      if (baseId) await assertBaseRole(accounts, user, baseId, "editor");
      return store.setApprovalProxy({
        userId: user.id,
        userName: user.name,
        proxyUserId: target.id,
        proxyUserName: target.name,
        baseId,
        workflowId,
        expiresAt: resolvedExpires,
      });
    }),
);

server.tool(
  "clear_approval_proxy",
  "清除审批代理；可指定规则 id，否则清除全部",
  { proxyId: z.string().optional() },
  async ({ proxyId }) =>
    run(async () => {
      await store.clearApprovalProxy(user.id, proxyId);
      return { ok: true };
    }),
);

server.tool(
  "watch_record",
  "关注记录（变更时通知）",
  { recordId: z.string() },
  async ({ recordId }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      await store.watchRecord(user.id, recordId);
      return { ok: true };
    }),
);

server.tool(
  "unwatch_record",
  "取消关注记录",
  { recordId: z.string() },
  async ({ recordId }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      await store.unwatchRecord(user.id, recordId);
      return { ok: true };
    }),
);

server.tool(
  "is_watching_record",
  "是否正在关注某条记录",
  { recordId: z.string() },
  async ({ recordId }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "viewer");
      return { watching: await store.isWatching(user.id, recordId) };
    }),
);

server.tool("list_watched_records", "列出我关注的记录 id", {}, async () =>
  run(async () => store.listWatchedRecords(user.id)),
);

server.tool(
  "create_record_share",
  "创建单记录分享链接（返回完整 token，仅此一次）",
  {
    recordId: z.string(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  },
  async ({ recordId, expiresInDays }) =>
    run(async () => {
      const located = await store.locateRecord(recordId);
      await assertBaseRole(accounts, user, located.baseId, "editor");
      return store.createShareLink(recordId, user.id, expiresInDays);
    }),
);

server.tool(
  "get_shared_record",
  "通过分享 token 读取单记录（公开）",
  { token: z.string() },
  async ({ token }) => run(async () => store.getSharedRecord(token)),
);

server.tool(
  "upload_file",
  "上传附件（contentBase64，最大 8MB）。返回可写入附件字段的 url/meta",
  {
    filename: z.string(),
    contentBase64: z.string(),
    mime: z.string().optional(),
    baseId: z.string().optional(),
    minRole: z.enum(["viewer", "editor", "owner"]).optional(),
  },
  async ({ filename, contentBase64, mime, baseId, minRole }) =>
    run(async () => {
      if (baseId) await assertBaseRole(accounts, user, baseId, "editor");
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.length > 8 * 1024 * 1024) throw new Error("附件不能超过 8MB");
      return store.saveUpload({
        filename,
        bytes,
        mime,
        createdBy: user.id,
        baseId,
        minRole,
      });
    }),
);

server.tool(
  "get_upload_meta",
  "读取附件元信息（不含文件内容）",
  { uploadId: z.string() },
  async ({ uploadId }) =>
    run(async () => {
      const file = await store.getUpload(uploadId);
      if (file.meta.baseId) {
        const needed = (file.meta.minRole as "viewer" | "editor" | "owner") || "viewer";
        await assertBaseRole(accounts, user, file.meta.baseId, needed);
      } else if (user.role !== "admin" && file.meta.createdBy && file.meta.createdBy !== user.id) {
        throw new Error("没有权限查看该附件");
      }
      return file.meta;
    }),
);

server.tool("delete_upload", "删除附件", { uploadId: z.string() }, async ({ uploadId }) =>
  run(async () => {
    const file = await store.getUpload(uploadId);
    if (file.meta.baseId) {
      await assertBaseRole(accounts, user, file.meta.baseId, "editor");
    } else if (user.role !== "admin" && file.meta.createdBy && file.meta.createdBy !== user.id) {
      throw new Error("没有权限删除该附件");
    }
    await store.deleteUpload(uploadId);
    return { ok: true };
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
