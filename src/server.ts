import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { ZodError, z } from "zod";
import { Accounts } from "./accounts.js";
import { assertBaseRole } from "./access.js";
import { BackupService } from "./backup.js";
import { DomainError, type Store } from "./store.js";
import { createTemplate, TEMPLATES, type TemplateId } from "./templates.js";
import {
  FIELD_TYPES,
  FILTER_OPS,
  TAG_COLORS,
  type MemberRole,
  type PublicUser,
  type ViewType,
} from "./types.js";

const COOKIE = "duowei_session";
const VIEW_TYPES = ["grid", "kanban", "calendar", "gallery", "form", "gantt"] as const;

const FieldDraftSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  options: z
    .array(z.union([z.string(), z.object({ name: z.string(), color: z.enum(TAG_COLORS).optional() })]))
    .optional(),
  formula: z.string().optional(),
  linkTableId: z.string().optional(),
  max: z.number().optional(),
  currency: z.string().optional(),
  prefix: z.string().optional(),
  lookupLinkFieldId: z.string().optional(),
  lookupTargetFieldId: z.string().optional(),
  buttonLabel: z.string().optional(),
  buttonAction: z
    .union([
      z.object({ type: z.literal("set_field"), fieldId: z.string(), value: z.string() }),
      z.object({ type: z.literal("open_url"), url: z.string() }),
      z.object({ type: z.literal("add_comment"), body: z.string() }),
    ])
    .optional(),
  symmetricFieldName: z.string().optional(),
  optionCascade: z
    .object({
      targetFieldId: z.string(),
      map: z.record(z.array(z.string())),
    })
    .optional(),
});

const FilterSchema = z.object({
  fieldId: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

const ViewConfigSchema = z.object({
  filters: z.array(FilterSchema).optional(),
  conjunction: z.enum(["and", "or"]).optional(),
  sorts: z.array(z.object({ fieldId: z.string(), direction: z.enum(["asc", "desc"]) })).optional(),
  groups: z.array(z.object({ fieldId: z.string() })).optional(),
  hiddenFieldIds: z.array(z.string()).optional(),
  groupFieldId: z.string().nullable().optional(),
  rowHeight: z.enum(["short", "medium", "tall", "extra"]).optional(),
  dateFieldId: z.string().nullable().optional(),
  titleFieldId: z.string().nullable().optional(),
  endDateFieldId: z.string().nullable().optional(),
  progressFieldId: z.string().nullable().optional(),
  dependencyFieldId: z.string().nullable().optional(),
  colorRules: z
    .array(
      z.object({
        id: z.string(),
        fieldId: z.string(),
        op: z.enum(FILTER_OPS),
        value: z.string().optional(),
        color: z.string(),
        target: z.enum(["row", "cell"]).optional(),
      }),
    )
    .optional(),
});

const DashboardConfigSchema = z.object({
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
});

const AppPortalSchema = z.object({
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
});

const AutomationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("record_created") }),
  z.object({ type: z.literal("record_updated"), fieldId: z.string().optional() }),
  z.object({ type: z.literal("field_equals"), fieldId: z.string(), value: z.string() }),
  z.object({ type: z.literal("button"), fieldId: z.string() }),
  z.object({ type: z.literal("webhook"), secret: z.string().optional() }),
  z.object({ type: z.literal("schedule"), cron: z.string() }),
]);

const AutomationActionSchema = z.discriminatedUnion("type", [
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

const AutomationConditionSchema = z.object({
  fieldId: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

export function createApp(store: Store, accounts: Accounts, backupService?: BackupService) {
  const backup = backupService ?? new BackupService(store.database, path.dirname(store.uploadsDir));
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ZodError) {
      return c.json({ error: err.issues.map((issue) => issue.message).join("；") || "请求参数不正确" }, 400);
    }
    console.error(err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/system/backup", async (c) => {
    await requireAdmin(c);
    return c.json({
      settings: await backup.getSettings(),
      logs: await backup.listLogs(50),
    });
  });

  app.put("/api/system/backup", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        davUrl: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        remotePath: z.string().optional(),
        hour: z.number().int().min(0).max(23).optional(),
        minute: z.number().int().min(0).max(59).optional(),
        keepDays: z.number().int().min(1).max(30).optional(),
      })
      .parse(await readBody(c));
    return c.json({ settings: await backup.updateSettings(body) });
  });

  app.post("/api/system/backup/test", async (c) => {
    await requireAdmin(c);
    return c.json(await backup.testConnection());
  });

  app.post("/api/system/backup/run", async (c) => {
    await requireAdmin(c);
    return c.json({ log: await backup.runBackup("manual") });
  });

  app.get("/api/system/backup/logs", async (c) => {
    await requireAdmin(c);
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(await backup.listLogs(Number.isFinite(limit) ? limit : 50));
  });
  app.get("/api/templates", (c) => c.json(TEMPLATES));
  app.get("/api/limits", async (c) => {
    await requireUser(c);
    const { getLimitsSnapshot } = await import("./limits.js");
    return c.json(getLimitsSnapshot());
  });

  app.post("/api/assistant/query", async (c) => {
    const body = z.object({ tableId: z.string(), question: z.string() }).parse(await readBody(c));
    const located = await store.locateTable(body.tableId);
    await requireBase(c, located.baseId, "viewer");
    const { runAssistantQuery } = await import("./assistant.js");
    return c.json(await runAssistantQuery(store, body.tableId, body.question));
  });

  app.get("/api/auth/bootstrap-status", async (c) => {
    const empty = (await accounts.userCount()) === 0;
    return c.json({ needsBootstrap: empty });
  });

  app.post("/api/auth/bootstrap", async (c) => {
    const body = z
      .object({ name: z.string(), email: z.string(), password: z.string() })
      .parse(await readBody(c));
    const result = await accounts.bootstrapAdmin(body);
    setSession(c, result.token);
    return c.json({ user: result.user }, 201);
  });

  app.get("/api/auth/captcha", async (c) => c.json(accounts.createCaptcha()));

  app.post("/api/auth/codes", async (c) => {
    const body = z.object({ email: z.string(), purpose: z.literal("login").optional() }).parse(await readBody(c));
    return c.json(await accounts.sendCode(body.email, "login"));
  });

  app.post("/api/auth/login", async (c) => {
    const body = z
      .object({
        email: z.string(),
        password: z.string().optional(),
        code: z.string().optional(),
        captchaId: z.string(),
        captcha: z.string(),
      })
      .parse(await readBody(c));
    const result = await accounts.login(body);
    setSession(c, result.token);
    return c.json({ user: result.user });
  });

  app.post("/api/auth/logout", async (c) => {
    await accounts.logout(readSecret(c));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => c.json({ user: await requireUser(c) }));

  app.get("/api/users", async (c) => {
    await requireAdmin(c);
    return c.json(await accounts.listUsers());
  });

  app.post("/api/users", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        name: z.string(),
        email: z.string(),
        password: z.string(),
        role: z.enum(["admin", "member"]).optional(),
      })
      .parse(await readBody(c));
    return c.json(await accounts.createUser(body), 201);
  });

  app.patch("/api/users/:userId", async (c) => {
    const actor = await requireAdmin(c);
    const body = z
      .object({
        name: z.string().optional(),
        role: z.enum(["admin", "member"]).optional(),
        disabled: z.boolean().optional(),
        password: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(await accounts.updateUser(actor.id, c.req.param("userId"), body));
  });

  app.get("/api/tokens", async (c) => {
    const user = await requireUser(c);
    return c.json(await accounts.listAccessTokens(user.id));
  });

  app.post("/api/tokens", async (c) => {
    const user = await requireUser(c);
    const body = z.object({ name: z.string() }).parse(await readBody(c));
    const created = await accounts.createAccessToken(user.id, body.name);
    return c.json(created, 201);
  });

  app.delete("/api/tokens/:tokenId", async (c) => {
    const user = await requireUser(c);
    await accounts.deleteAccessToken(user.id, c.req.param("tokenId"));
    return c.json({ ok: true });
  });

  app.post("/api/mcp-agents/register", async (c) => {
    const body = z
      .object({
        name: z.string(),
        description: z.string().optional(),
        contact: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(await accounts.registerMcpAgent(body), 201);
  });

  app.get("/api/mcp-agents", async (c) => {
    await requireAdmin(c);
    return c.json(await accounts.listMcpAgents());
  });

  app.post("/api/mcp-agents", async (c) => {
    const actor = await requireAdmin(c);
    const body = z
      .object({
        name: z.string(),
        description: z.string().optional(),
        contact: z.string().optional(),
        bases: z
          .array(z.object({ baseId: z.string(), role: z.enum(["owner", "editor", "viewer"]) }))
          .optional(),
      })
      .parse(await readBody(c));
    return c.json(await accounts.createMcpAgent(actor.id, body), 201);
  });

  app.get("/api/mcp-agents/:agentId", async (c) => {
    await requireAdmin(c);
    return c.json(await accounts.getMcpAgent(c.req.param("agentId")));
  });

  app.patch("/api/mcp-agents/:agentId", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        contact: z.string().optional(),
        status: z.enum(["active", "disabled", "rejected"]).optional(),
        bases: z
          .array(z.object({ baseId: z.string(), role: z.enum(["owner", "editor", "viewer"]) }))
          .optional(),
      })
      .parse(await readBody(c));
    const agentId = c.req.param("agentId");
    if (body.bases) await accounts.setMcpAgentBases(agentId, body.bases);
    if (body.status) await accounts.setMcpAgentStatus(agentId, body.status);
    if (body.name != null || body.description != null || body.contact != null) {
      await accounts.updateMcpAgent(agentId, body);
    }
    return c.json(await accounts.getMcpAgent(agentId));
  });

  app.post("/api/mcp-agents/:agentId/approve", async (c) => {
    const actor = await requireAdmin(c);
    let bases: Array<{ baseId: string; role: "owner" | "editor" | "viewer" }> | undefined;
    try {
      const body = z
        .object({
          bases: z
            .array(z.object({ baseId: z.string(), role: z.enum(["owner", "editor", "viewer"]) }))
            .optional(),
        })
        .parse(await readBody(c));
      bases = body.bases;
    } catch {
      /* empty body ok */
    }
    return c.json(await accounts.approveMcpAgent(c.req.param("agentId"), actor.id, bases));
  });

  app.post("/api/mcp-agents/:agentId/rotate-token", async (c) => {
    await requireAdmin(c);
    return c.json(await accounts.rotateMcpAgentToken(c.req.param("agentId")));
  });

  app.delete("/api/mcp-agents/:agentId", async (c) => {
    await requireAdmin(c);
    await accounts.deleteMcpAgent(c.req.param("agentId"));
    return c.json({ ok: true });
  });

  app.get("/api/bases", async (c) => {
    const user = await requireUser(c);
    return c.json(await visibleBases(user));
  });

  app.post("/api/bases", async (c) => {
    const user = await requireUser(c);
    if (user.kind === "agent") throw new DomainError("Agent 不能创建多维表格，请在管理端授权已有表格", 403);
    const body = z.object({ name: z.string() }).parse(await readBody(c));
    const base = await store.createBase(body.name);
    await accounts.addMember(base.id, user.id, "owner");
    return c.json(base, 201);
  });

  app.post("/api/templates/:template", async (c) => {
    const user = await requireUser(c);
    if (user.kind === "agent") throw new DomainError("Agent 不能创建多维表格，请在管理端授权已有表格", 403);
    const template = c.req.param("template");
    if (!TEMPLATES.some((item) => item.id === template)) throw new DomainError("找不到模板", 404);
    const base = await createTemplate(store, template as TemplateId);
    await accounts.addMember(base.id, user.id, "owner");
    return c.json(base, 201);
  });

  app.patch("/api/bases/:baseId", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "owner");
    const body = z.object({ name: z.string() }).parse(await readBody(c));
    return c.json(await store.renameBase(baseId, body.name));
  });

  app.delete("/api/bases/:baseId", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "owner");
    await store.deleteBase(baseId);
    return c.json({ ok: true });
  });

  app.get("/api/bases/:baseId/members", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "viewer");
    return c.json(await accounts.listMembers(baseId));
  });

  app.put("/api/bases/:baseId/members", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "owner");
    const body = z.object({ email: z.string(), role: z.enum(["owner", "editor", "viewer"]) }).parse(await readBody(c));
    return c.json(await accounts.setMember(baseId, body.email, body.role));
  });

  app.delete("/api/bases/:baseId/members/:userId", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "owner");
    return c.json(await accounts.removeMember(baseId, c.req.param("userId")));
  });

  app.get("/api/bases/:baseId/dashboards", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "viewer");
    return c.json(await store.listDashboards(baseId));
  });

  app.post("/api/bases/:baseId/dashboards", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "editor");
    const body = z
      .object({
        name: z.string(),
        config: DashboardConfigSchema.optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createDashboard(baseId, body.name, body.config), 201);
  });

  app.get("/api/dashboards/:dashboardId", async (c) => {
    const located = await store.locateDashboard(c.req.param("dashboardId"));
    await requireBase(c, located.baseId, "viewer");
    let slicerValues: Record<string, string[]> | undefined;
    const raw = c.req.query("slicers");
    if (raw) {
      try {
        slicerValues = z.record(z.array(z.string())).parse(JSON.parse(raw));
      } catch {
        throw new DomainError("slicers 参数无效");
      }
    }
    return c.json(await store.getDashboardData(c.req.param("dashboardId"), slicerValues));
  });

  app.get("/api/bases/:baseId/app", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "viewer");
    return c.json(await store.getAppPortal(baseId));
  });

  app.get("/api/bases/:baseId/settings", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "viewer");
    return c.json(await store.getBaseSettings(baseId));
  });

  app.patch("/api/bases/:baseId/settings", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "owner");
    const body = z
      .object({
        timezone: z.string().optional(),
        portal: AppPortalSchema.optional(),
        integrations: z.object({ feishuWebhookUrl: z.string().optional() }).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateBaseSettings(baseId, body));
  });

  app.post("/api/bases/:baseId/feishu-test", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "editor");
    const body = z.object({ text: z.string().optional(), webhookUrl: z.string().optional() }).parse(await readBody(c));
    const settings = await store.getBaseSettings(baseId);
    const webhook = body.webhookUrl || settings.integrations.feishuWebhookUrl;
    if (!webhook) throw new DomainError("请先配置飞书机器人 Webhook");
    const { sendFeishuText } = await import("./feishu.js");
    const result = await sendFeishuText(webhook, body.text || "知行人生测试：飞书机器人已连通。");
    if (!result.ok) throw new DomainError(result.message || "飞书发送失败", 400);
    return c.json({ ok: true });
  });

  app.patch("/api/dashboards/:dashboardId", async (c) => {
    const located = await store.locateDashboard(c.req.param("dashboardId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string().optional(),
        config: DashboardConfigSchema.optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateDashboard(c.req.param("dashboardId"), body));
  });

  app.get("/api/bases/:baseId/documents", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "viewer");
    const q = c.req.query("q") || undefined;
    return c.json(await store.listDocuments(baseId, { q }));
  });

  app.post("/api/bases/:baseId/documents", async (c) => {
    const baseId = c.req.param("baseId");
    const user = await requireBase(c, baseId, "editor");
    const body = z
      .object({
        title: z.string().optional(),
        parentId: z.string().nullable().optional(),
        kind: z.enum(["doc", "folder"]).optional(),
        bodyMd: z.string().optional(),
        template: z.string().nullable().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createDocument(baseId, { ...body, createdBy: user.id }), 201);
  });

  app.get("/api/documents/:documentId", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.getDocument(documentId));
  });

  app.patch("/api/documents/:documentId", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    const user = await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        title: z.string().optional(),
        bodyMd: z.string().optional(),
        icon: z.string().nullable().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateDocument(documentId, body, { id: user.id, name: user.name }));
  });

  app.post("/api/documents/:documentId/move", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "editor");
    const body = z.object({ parentId: z.string().nullable(), position: z.number().optional() }).parse(await readBody(c));
    return c.json(await store.moveDocument(documentId, body.parentId, body.position));
  });

  app.delete("/api/documents/:documentId", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "editor");
    await store.deleteDocument(documentId);
    return c.json({ ok: true });
  });

  app.get("/api/documents/:documentId/revisions", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listDocumentRevisions(documentId));
  });

  app.post("/api/documents/:documentId/revisions/:revisionId/restore", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    const user = await requireBase(c, located.baseId, "editor");
    return c.json(
      await store.restoreDocumentRevision(documentId, c.req.param("revisionId"), { id: user.id, name: user.name }),
    );
  });

  app.post("/api/documents/:documentId/records", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "editor");
    const body = z.object({ recordId: z.string(), label: z.string().nullable().optional() }).parse(await readBody(c));
    return c.json(await store.linkDocumentRecord(documentId, body.recordId, body.label ?? null));
  });

  app.delete("/api/documents/:documentId/records/:recordId", async (c) => {
    const documentId = c.req.param("documentId");
    const located = await store.locateDocument(documentId);
    await requireBase(c, located.baseId, "editor");
    return c.json(await store.unlinkDocumentRecord(documentId, c.req.param("recordId")));
  });

  app.get("/api/records/:recordId/documents", async (c) => {
    const recordId = c.req.param("recordId");
    const located = await store.locateRecord(recordId);
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listRecordDocuments(recordId));
  });

  app.post("/api/bases/:baseId/tables", async (c) => {
    const baseId = c.req.param("baseId");
    await requireBase(c, baseId, "editor");
    const body = z
      .object({
        name: z.string(),
        fields: z.array(FieldDraftSchema).optional(),
        defaultViewName: z.string().optional(),
        withKanban: z.boolean().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createTable(baseId, body), 201);
  });

  app.patch("/api/tables/:tableId", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z.object({ name: z.string() }).parse(await readBody(c));
    await store.renameTable(located.tableId, body.name);
    return c.json(await readTable(c, located.tableId));
  });

  app.delete("/api/tables/:tableId", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "owner");
    await store.deleteTable(located.tableId);
    return c.json({ ok: true });
  });

  app.get("/api/tables/:tableId", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    const viewId = c.req.query("viewId");
    return c.json(await readTable(c, located.tableId, viewId ? { viewId } : undefined));
  });

  app.post("/api/tables/:tableId/query", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    const body = z
      .object({
        viewId: z.string().optional(),
        filters: z.array(FilterSchema).optional(),
        conjunction: z.enum(["and", "or"]).optional(),
        sorts: z.array(z.object({ fieldId: z.string(), direction: z.enum(["asc", "desc"]) })).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      })
      .parse(await readBody(c));
    return c.json(await readTable(c, located.tableId, body));
  });

  app.get("/api/tables/:tableId/calendar.ics", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    const ics = await store.exportIcs(located.tableId, {
      dateFieldId: c.req.query("dateFieldId") || undefined,
      titleFieldId: c.req.query("titleFieldId") || undefined,
    });
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="duowei-${located.tableId}.ics"`,
      },
    });
  });

  app.get("/api/tables/:tableId/calendar-feeds", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listCalendarFeeds(located.tableId));
  });

  app.post("/api/tables/:tableId/calendar-feeds", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({ dateFieldId: z.string().optional(), titleFieldId: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await store.createCalendarFeed(located.tableId, body), 201);
  });

  app.delete("/api/calendar-feeds/:feedId", async (c) => {
    const feed = await store.requireCalendarFeed(c.req.param("feedId"));
    const located = await store.locateTable(feed.tableId);
    await requireBase(c, located.baseId, "editor");
    await store.deleteCalendarFeed(feed.id);
    return c.json({ ok: true });
  });

  app.get("/api/calendar/:token", async (c) => {
    const raw = c.req.param("token") ?? "";
    const token = raw.replace(/\.ics$/i, "");
    const feed = await store.getCalendarFeedByToken(token);
    if (!feed || !feed.enabled) throw new DomainError("找不到日历订阅", 404);
    const ics = await store.exportIcs(feed.tableId, {
      dateFieldId: feed.dateFieldId ?? undefined,
      titleFieldId: feed.titleFieldId ?? undefined,
    });
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  });

  app.post("/api/tables/:tableId/feishu-digest", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        daysAhead: z.number().optional(),
        dateField: z.string().optional(),
        excludeStatuses: z.array(z.string()).optional(),
        webhookUrl: z.string().optional(),
        text: z.string().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await store.sendFeishuDigest(located.tableId, { type: "feishu_digest", ...body }));
  });

  app.get("/api/tables/:tableId/export.csv", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    const csv = await store.exportCsv(located.tableId);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="table-${located.tableId}.csv"`,
      },
    });
  });

  app.post("/api/tables/:tableId/import.csv", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ csv: z.string() }).parse(await readBody(c));
    return c.json(await store.importCsv(located.tableId, body.csv, { userId: user.id, userName: user.name }));
  });

  app.get("/api/tables/:tableId/acl", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "owner");
    return c.json(await store.getTableAcl(located.tableId));
  });

  app.put("/api/tables/:tableId/acl", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "owner");
    const RowRuleSchema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("all") }),
      z.object({ type: z.literal("allow_ids"), recordIds: z.array(z.string()) }),
      z.object({ type: z.literal("created_by") }),
      z.object({ type: z.literal("person_in"), fieldId: z.string() }),
      z.object({ type: z.literal("field_equals"), fieldId: z.string(), value: z.string() }),
      z.object({ type: z.literal("field_in"), fieldId: z.string(), values: z.array(z.string()) }),
    ]);
    const body = z
      .object({
        rowAllow: z.record(z.array(z.string())).optional(),
        columnDeny: z.record(z.array(z.string())).optional(),
        rowRules: z.record(RowRuleSchema).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.setTableAcl(located.tableId, body));
  });

  app.get("/api/tables/:tableId/acl/preview", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "owner");
    const userId = c.req.query("userId");
    if (!userId) throw new DomainError("请指定 userId");
    const users = await accounts.listUsers();
    const found = users.find((item) => item.id === userId);
    return c.json(
      await store.previewAcl(located.tableId, userId, {
        name: found?.name,
        email: found?.email,
      }),
    );
  });

  app.get("/api/tables/:tableId/automations", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listAutomations(located.tableId));
  });

  app.get("/api/tables/:tableId/automation-runs", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(await store.listAutomationRuns(located.tableId, Number.isFinite(limit) ? limit : 50));
  });

  app.post("/api/automations/:automationId/run", async (c) => {
    const located = await store.locateAutomation(c.req.param("automationId"));
    await requireBase(c, located.baseId, "editor");
    return c.json(await store.runAutomationNow(c.req.param("automationId")));
  });

  app.post("/api/tables/:tableId/automations", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string(),
        trigger: AutomationTriggerSchema,
        actions: z.array(AutomationActionSchema).min(1),
        conditions: z.array(AutomationConditionSchema).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createAutomation(located.tableId, body), 201);
  });

  app.patch("/api/automations/:automationId", async (c) => {
    const located = await store.locateAutomation(c.req.param("automationId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        trigger: AutomationTriggerSchema.optional(),
        actions: z.array(AutomationActionSchema).optional(),
        conditions: z.array(AutomationConditionSchema).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateAutomation(c.req.param("automationId"), body));
  });

  app.delete("/api/automations/:automationId", async (c) => {
    const located = await store.locateAutomation(c.req.param("automationId"));
    await requireBase(c, located.baseId, "editor");
    await store.deleteAutomation(c.req.param("automationId"));
    return c.json({ ok: true });
  });

  app.post("/api/webhooks/automations/:automationId", async (c) => {
    const secret = c.req.query("secret") ?? c.req.header("x-duowei-secret") ?? undefined;
    const body = z.object({ recordId: z.string().optional() }).parse(await readBody(c).catch(() => ({})));
    return c.json(await store.runWebhookAutomation(c.req.param("automationId"), secret, body));
  });

  app.post("/api/automations/run-due", async (c) => {
    await requireUser(c);
    const user = await requireUser(c);
    if (user.role !== "admin") throw new DomainError("仅管理员可手动触发定时自动化", 403);
    return c.json({ ran: await store.runDueSchedules() });
  });

  app.post("/api/tables/:tableId/fields", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = FieldDraftSchema.parse(await readBody(c));
    return c.json(await store.createField(located.tableId, body), 201);
  });

  app.patch("/api/fields/:fieldId", async (c) => {
    const located = await store.locateField(c.req.param("fieldId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string().optional(),
        options: FieldDraftSchema.shape.options,
        formula: z.string().optional(),
        linkTableId: z.string().optional(),
        max: z.number().optional(),
        currency: z.string().optional(),
        prefix: z.string().optional(),
        buttonLabel: z.string().optional(),
        buttonAction: FieldDraftSchema.shape.buttonAction,
        optionCascade: z
          .object({
            targetFieldId: z.string(),
            map: z.record(z.array(z.string())),
          })
          .nullable()
          .optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateField(c.req.param("fieldId"), body));
  });

  app.get("/api/fields/:fieldId/change-targets", async (c) => {
    const located = await store.locateField(c.req.param("fieldId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json({ targets: await store.fieldTypeChangeTargets(c.req.param("fieldId")) });
  });

  app.post("/api/fields/:fieldId/change-type", async (c) => {
    const located = await store.locateField(c.req.param("fieldId"));
    await requireBase(c, located.baseId, "editor");
    const body = z.object({ type: z.enum(FIELD_TYPES) }).parse(await readBody(c));
    return c.json(await store.changeFieldType(c.req.param("fieldId"), body.type));
  });

  app.delete("/api/fields/:fieldId", async (c) => {
    const located = await store.locateField(c.req.param("fieldId"));
    await requireBase(c, located.baseId, "editor");
    await store.deleteField(c.req.param("fieldId"));
    return c.json({ ok: true });
  });

  app.post("/api/tables/:tableId/records", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ fields: z.record(z.unknown()).optional() }).parse(await readBody(c));
    return c.json(
      await store.createRecord(located.tableId, body.fields ?? {}, { userId: user.id, userName: user.name }),
      201,
    );
  });

  app.patch("/api/records/:recordId", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ fields: z.record(z.unknown()) }).parse(await readBody(c));
    return c.json(await store.updateRecord(c.req.param("recordId"), body.fields, { userId: user.id, userName: user.name }));
  });

  app.delete("/api/records/:recordId", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    await requireBase(c, located.baseId, "editor");
    await store.deleteRecord(c.req.param("recordId"));
    return c.json({ ok: true });
  });

  app.get("/api/records/:recordId/comments", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listComments(c.req.param("recordId")));
  });

  app.post("/api/records/:recordId/comments", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ body: z.string() }).parse(await readBody(c));
    return c.json(await store.addComment(c.req.param("recordId"), user.id, user.name, body.body), 201);
  });

  app.delete("/api/comments/:commentId", async (c) => {
    const located = await store.locateComment(c.req.param("commentId"));
    const user = await requireBase(c, located.baseId, "editor");
    await store.deleteComment(c.req.param("commentId"), { userId: user.id, isAdmin: user.role === "admin" });
    return c.json({ ok: true });
  });

  app.get("/api/records/:recordId/history", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listHistory(c.req.param("recordId")));
  });

  app.post("/api/records/:recordId/watch", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "viewer");
    await store.watchRecord(user.id, c.req.param("recordId"));
    return c.json({ ok: true });
  });

  app.delete("/api/records/:recordId/watch", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "viewer");
    await store.unwatchRecord(user.id, c.req.param("recordId"));
    return c.json({ ok: true });
  });

  app.get("/api/records/:recordId/watching", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "viewer");
    return c.json({ watching: await store.isWatching(user.id, c.req.param("recordId")) });
  });

  app.post("/api/records/:recordId/share", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "editor");
    let raw: unknown = {};
    try {
      raw = await readBody(c);
    } catch {
      raw = {};
    }
    const body = z.object({ expiresInDays: z.number().int().min(1).max(365).optional() }).parse(raw ?? {});
    return c.json(await store.createShareLink(c.req.param("recordId"), user.id, body.expiresInDays), 201);
  });

  app.get("/api/share/:token", async (c) => c.json(await store.getSharedRecord(c.req.param("token"))));

  app.get("/api/tables/:tableId/public-shares", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    return c.json(await store.listPublicShares(c.req.param("tableId")));
  });

  app.post("/api/tables/:tableId/public-shares", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        kind: z.enum(["view", "form"]),
        viewId: z.string().nullable().optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createPublicShare(c.req.param("tableId"), body, user.id), 201);
  });

  app.patch("/api/public-shares/:shareId", async (c) => {
    const located = await store.locatePublicShare(c.req.param("shareId"));
    await requireBase(c, located.baseId, "editor");
    const body = z.object({ enabled: z.boolean() }).parse(await readBody(c));
    return c.json(await store.setPublicShareEnabled(c.req.param("shareId"), body.enabled));
  });

  app.delete("/api/public-shares/:shareId", async (c) => {
    const located = await store.locatePublicShare(c.req.param("shareId"));
    await requireBase(c, located.baseId, "editor");
    await store.deletePublicShare(c.req.param("shareId"));
    return c.json({ ok: true });
  });

  app.get("/api/public/:token", async (c) => c.json(await store.getPublicShare(c.req.param("token"))));

  app.post("/api/public/:token/submit", async (c) => {
    const body = z.object({ fields: z.record(z.unknown()) }).parse(await readBody(c));
    return c.json({ record: await store.submitPublicForm(c.req.param("token"), body.fields) }, 201);
  });

  app.post("/api/records/:recordId/buttons/:fieldId", async (c) => {
    const located = await store.locateRecord(c.req.param("recordId"));
    const user = await requireBase(c, located.baseId, "editor");
    return c.json(await store.clickButton(c.req.param("recordId"), c.req.param("fieldId"), { userId: user.id, userName: user.name }));
  });

  app.get("/api/notifications", async (c) => {
    const user = await requireUser(c);
    return c.json(await store.listNotifications(user.id));
  });

  app.post("/api/notifications/:id/read", async (c) => {
    const user = await requireUser(c);
    await store.markNotificationRead(c.req.param("id"), user.id);
    return c.json({ ok: true });
  });

  app.post("/api/tables/:tableId/views", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string(),
        type: z.enum(VIEW_TYPES),
        groupField: z.string().optional(),
        dateField: z.string().optional(),
        titleField: z.string().optional(),
        endDateField: z.string().optional(),
        progressField: z.string().optional(),
        dependencyField: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(
      await store.createView(located.tableId, {
        ...body,
        type: body.type as ViewType,
        createdBy: user.id,
      }),
      201,
    );
  });

  app.patch("/api/views/:viewId", async (c) => {
    const located = await store.locateView(c.req.param("viewId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ name: z.string().optional(), config: ViewConfigSchema.optional() }).parse(await readBody(c));
    return c.json(await store.updateView(c.req.param("viewId"), body, { userId: user.id }));
  });

  app.post("/api/views/:viewId/protection", async (c) => {
    const located = await store.locateView(c.req.param("viewId"));
    const user = await requireBase(c, located.baseId, "editor");
    const body = z.object({ protection: z.enum(["public", "locked", "personal"]) }).parse(await readBody(c));
    return c.json(await store.setViewProtection(c.req.param("viewId"), body.protection, user.id));
  });

  app.delete("/api/views/:viewId", async (c) => {
    const located = await store.locateView(c.req.param("viewId"));
    const user = await requireBase(c, located.baseId, "editor");
    await store.deleteView(c.req.param("viewId"), { userId: user.id });
    return c.json({ ok: true });
  });

  app.get("/api/tables/:tableId/detail-page", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.getDetailPage(located.tableId));
  });

  app.put("/api/tables/:tableId/detail-page", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        style: z.enum(["single", "multi", "grouped"]),
        fieldIds: z.array(z.string()),
        groups: z.array(z.object({ id: z.string(), title: z.string(), fieldIds: z.array(z.string()) })),
        columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.setDetailPage(located.tableId, body));
  });

  app.get("/api/tables/:tableId/workflows", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listWorkflows(located.tableId));
  });

  app.post("/api/tables/:tableId/workflows", async (c) => {
    const located = await store.locateTable(c.req.param("tableId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string(),
        enabled: z.boolean().optional(),
        nodes: z.array(z.record(z.unknown())).min(2),
      })
      .parse(await readBody(c));
    return c.json(await store.createWorkflow(located.tableId, body as never), 201);
  });

  app.patch("/api/workflows/:workflowId", async (c) => {
    const located = await store.locateWorkflow(c.req.param("workflowId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        nodes: z.array(z.record(z.unknown())).optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateWorkflow(c.req.param("workflowId"), body as never));
  });

  app.delete("/api/workflows/:workflowId", async (c) => {
    const located = await store.locateWorkflow(c.req.param("workflowId"));
    await requireBase(c, located.baseId, "editor");
    await store.deleteWorkflow(c.req.param("workflowId"));
    return c.json({ ok: true });
  });

  app.get("/api/workflow-runs", async (c) => {
    await requireUser(c);
    const tableId = c.req.query("tableId") || undefined;
    const status = c.req.query("status") as "pending" | "approved" | "rejected" | "completed" | undefined;
    if (tableId) {
      const located = await store.locateTable(tableId);
      await requireBase(c, located.baseId, "viewer");
    }
    return c.json(await store.listWorkflowRuns({ tableId, status }));
  });

  app.post("/api/workflow-runs/:runId/decide", async (c) => {
    const user = await requireUser(c);
    const located = await store.locateWorkflowRun(c.req.param("runId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        decision: z.enum(["approve", "reject"]),
        comment: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(
      await store.decideWorkflowRun(c.req.param("runId"), body.decision, {
        userId: user.id,
        userName: user.name,
        comment: body.comment,
      }),
    );
  });

  app.post("/api/workflow-runs/:runId/transfer", async (c) => {
    const user = await requireUser(c);
    const located = await store.locateWorkflowRun(c.req.param("runId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        approvers: z.array(z.string()).min(1),
        comment: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(
      await store.transferWorkflowRun(c.req.param("runId"), body.approvers, {
        userId: user.id,
        userName: user.name,
        comment: body.comment,
      }),
    );
  });

  app.post("/api/workflow-runs/:runId/add-sign", async (c) => {
    const user = await requireUser(c);
    const located = await store.locateWorkflowRun(c.req.param("runId"));
    await requireBase(c, located.baseId, "editor");
    const body = z
      .object({
        approvers: z.array(z.string()).min(1),
        comment: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(
      await store.addSignWorkflowRun(c.req.param("runId"), body.approvers, {
        userId: user.id,
        userName: user.name,
        comment: body.comment,
      }),
    );
  });

  app.get("/api/workflow-runs/:runId/audit", async (c) => {
    const located = await store.locateWorkflowRun(c.req.param("runId"));
    await requireBase(c, located.baseId, "viewer");
    return c.json(await store.listWorkflowAudit({ runId: c.req.param("runId") }));
  });

  app.get("/api/workflow-audit", async (c) => {
    await requireUser(c);
    const tableId = c.req.query("tableId") || undefined;
    const baseId = c.req.query("baseId") || undefined;
    if (tableId) {
      const located = await store.locateTable(tableId);
      await requireBase(c, located.baseId, "viewer");
    }
    if (baseId) await requireBase(c, baseId, "viewer");
    const from = c.req.query("from") ? Number(c.req.query("from")) : undefined;
    const to = c.req.query("to") ? Number(c.req.query("to")) : undefined;
    const limit = Number(c.req.query("limit") || "200");
    return c.json(
      await store.listWorkflowAudit({
        tableId,
        baseId,
        action: c.req.query("action") || undefined,
        actor: c.req.query("actor") || undefined,
        recordId: c.req.query("recordId") || undefined,
        from: from != null && Number.isFinite(from) ? from : undefined,
        to: to != null && Number.isFinite(to) ? to : undefined,
        limit: Number.isFinite(limit) ? limit : 200,
      }),
    );
  });

  app.get("/api/workflow-audit/export.csv", async (c) => {
    await requireUser(c);
    const tableId = c.req.query("tableId") || undefined;
    const baseId = c.req.query("baseId") || undefined;
    if (tableId) {
      const located = await store.locateTable(tableId);
      await requireBase(c, located.baseId, "viewer");
    }
    if (baseId) await requireBase(c, baseId, "viewer");
    const from = c.req.query("from") ? Number(c.req.query("from")) : undefined;
    const to = c.req.query("to") ? Number(c.req.query("to")) : undefined;
    const events = await store.listWorkflowAudit({
      tableId,
      baseId,
      action: c.req.query("action") || undefined,
      actor: c.req.query("actor") || undefined,
      recordId: c.req.query("recordId") || undefined,
      from: from != null && Number.isFinite(from) ? from : undefined,
      to: to != null && Number.isFinite(to) ? to : undefined,
      limit: 5000,
    });
    const csv = store.exportWorkflowAuditCsv(events);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="workflow-audit.csv"`,
      },
    });
  });

  app.get("/api/approval-proxy", async (c) => {
    const user = await requireUser(c);
    const proxies = await store.listApprovalProxies(user.id);
    return c.json({ proxies, proxy: proxies[0] ?? null });
  });

  app.put("/api/approval-proxy", async (c) => {
    const user = await requireUser(c);
    const body = z
      .object({
        proxy: z.string(),
        baseId: z.string().optional().nullable(),
        workflowId: z.string().optional().nullable(),
        expiresAt: z.number().optional().nullable(),
        expiresInHours: z.number().optional().nullable(),
      })
      .parse(await readBody(c));
    const target = await accounts.findPublicByNameOrEmail(body.proxy);
    if (!target) throw new DomainError("找不到代理人用户（请用邮箱或唯一用户名）", 404);
    let expiresAt = body.expiresAt ?? null;
    if (body.expiresInHours != null && body.expiresInHours > 0) {
      expiresAt = Date.now() + body.expiresInHours * 3600_000;
    }
    if (body.baseId) await requireBase(c, body.baseId, "editor");
    return c.json(
      await store.setApprovalProxy({
        userId: user.id,
        userName: user.name,
        proxyUserId: target.id,
        proxyUserName: target.name,
        baseId: body.baseId,
        workflowId: body.workflowId,
        expiresAt,
      }),
    );
  });

  app.delete("/api/approval-proxy", async (c) => {
    const user = await requireUser(c);
    const id = c.req.query("id") || undefined;
    await store.clearApprovalProxy(user.id, id);
    return c.json({ ok: true });
  });

  app.get("/api/workflow-runs/sla", async (c) => {
    await requireUser(c);
    const tableId = c.req.query("tableId") || undefined;
    const withinHours = Number(c.req.query("withinHours") || "24");
    if (tableId) {
      const located = await store.locateTable(tableId);
      await requireBase(c, located.baseId, "viewer");
    }
    return c.json(await store.getWorkflowSla({ tableId, withinHours: Number.isFinite(withinHours) ? withinHours : 24 }));
  });

  app.post("/api/workflow-runs/process-timeouts", async (c) => {
    await requireAdmin(c);
    let now: number | undefined;
    try {
      const body = z.object({ now: z.number().optional() }).parse(await readBody(c));
      now = body.now;
    } catch {
      /* empty ok */
    }
    return c.json(await store.processWorkflowTimeouts(now));
  });

  app.get("/api/sync-jobs", async (c) => {
    await requireUser(c);
    return c.json(await store.listSyncJobs());
  });

  app.post("/api/sync-jobs", async (c) => {
    const user = await requireUser(c);
    const body = z
      .object({
        name: z.string(),
        sourceTableId: z.string(),
        targetTableId: z.string(),
        fieldMap: z.record(z.string()),
        matchField: z.string().optional().nullable(),
        mode: z.enum(["full", "incremental"]).optional(),
        conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(await readBody(c));
    const source = await store.locateTable(body.sourceTableId);
    await assertBaseRole(accounts, user, source.baseId, "editor");
    const target = await store.locateTable(body.targetTableId);
    await assertBaseRole(accounts, user, target.baseId, "editor");
    return c.json(await store.createSyncJob(body), 201);
  });

  app.patch("/api/sync-jobs/:jobId", async (c) => {
    await requireUser(c);
    const body = z
      .object({
        name: z.string().optional(),
        conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional(),
        mode: z.enum(["full", "incremental"]).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updateSyncJob(c.req.param("jobId"), body));
  });

  app.post("/api/sync-jobs/:jobId/run", async (c) => {
    await requireUser(c);
    let conflict: "skip_if_target_nonempty" | "overwrite" | undefined;
    try {
      const body = z
        .object({ conflict: z.enum(["skip_if_target_nonempty", "overwrite"]).optional() })
        .parse(await readBody(c));
      conflict = body.conflict;
    } catch {
      /* empty body ok */
    }
    if (conflict) await store.updateSyncJob(c.req.param("jobId"), { conflict });
    return c.json(await store.runSyncJob(c.req.param("jobId")));
  });

  app.delete("/api/sync-jobs/:jobId", async (c) => {
    await requireUser(c);
    await store.deleteSyncJob(c.req.param("jobId"));
    return c.json({ ok: true });
  });

  app.get("/api/plugins/hooks", async (c) => {
    await requireUser(c);
    return c.json(await store.listPluginHooks());
  });

  app.post("/api/plugins/hooks", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        name: z.string(),
        event: z.enum(["record_created", "record_updated", "record_deleted", "workflow_ran"]),
        target: z.string(),
        enabled: z.boolean().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.createPluginHook(body), 201);
  });

  app.patch("/api/plugins/hooks/:hookId", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        target: z.string().optional(),
        name: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.updatePluginHook(c.req.param("hookId"), body));
  });

  app.delete("/api/plugins/hooks/:hookId", async (c) => {
    await requireAdmin(c);
    await store.deletePluginHook(c.req.param("hookId"));
    return c.json({ ok: true });
  });

  app.get("/api/plugins/marketplace", async (c) => {
    await requireUser(c);
    return c.json({
      plugins: await store.listMarketplacePlugins(),
      recentEvents: store.listPluginEventLog(20),
    });
  });

  app.post("/api/plugins/marketplace/:pluginId", async (c) => {
    await requireAdmin(c);
    const body = z
      .object({
        enabled: z.boolean(),
        webhookUrl: z.string().optional(),
      })
      .parse(await readBody(c));
    return c.json(await store.setMarketplacePlugin(c.req.param("pluginId"), body.enabled, { webhookUrl: body.webhookUrl }));
  });

  app.get("/api/mcp/tools", async (c) => {
    await requireUser(c);
    const { MCP_TOOL_CATALOG } = await import("./mcp-catalog.js");
    return c.json({
      tools: MCP_TOOL_CATALOG,
      hint: "MCP 须使用已审批的 Agent 令牌：在管理端「Agent 管理」创建/批准后，设置 DUOWEI_TOKEN=dwa_… 再执行 npx tsx src/mcp.ts",
    });
  });

  app.post("/api/uploads", async (c) => {
    const user = await requireUser(c);
    const body = z
      .object({
        filename: z.string(),
        contentBase64: z.string(),
        mime: z.string().optional(),
        baseId: z.string().optional(),
        minRole: z.enum(["viewer", "editor", "owner"]).optional(),
      })
      .parse(await readBody(c));
    if (body.baseId) await requireBase(c, body.baseId, "editor");
    const bytes = Buffer.from(body.contentBase64, "base64");
    if (bytes.length > 8 * 1024 * 1024) throw new DomainError("附件不能超过 8MB");
    return c.json(
      await store.saveUpload({
        filename: body.filename,
        bytes,
        mime: body.mime,
        createdBy: user.id,
        baseId: body.baseId,
        minRole: body.minRole,
      }),
      201,
    );
  });

  app.get("/api/uploads/:uploadId", async (c) => {
    const user = await requireUser(c);
    const file = await store.getUpload(c.req.param("uploadId"));
    if (file.meta.baseId) {
      const needed = (file.meta.minRole as MemberRole) || "viewer";
      await requireBase(c, file.meta.baseId, needed);
    } else if (user.role !== "admin" && file.meta.createdBy && file.meta.createdBy !== user.id) {
      // 未绑定 base 的附件：仅上传者或管理员可下
      throw new DomainError("无权下载该附件", 403);
    }
    const data = await fs.promises.readFile(file.path);
    return new Response(data, {
      headers: {
        "content-type": file.meta.mime || "application/octet-stream",
        "content-disposition": `inline; filename="${encodeURIComponent(file.meta.name)}"`,
      },
    });
  });

  app.delete("/api/uploads/:uploadId", async (c) => {
    const user = await requireUser(c);
    const file = await store.getUpload(c.req.param("uploadId"));
    if (file.meta.baseId) {
      await requireBase(c, file.meta.baseId, "editor");
    } else if (user.role !== "admin" && file.meta.createdBy && file.meta.createdBy !== user.id) {
      throw new DomainError("无权删除该附件", 403);
    }
    await store.deleteUpload(c.req.param("uploadId"));
    return c.json({ ok: true });
  });

  async function readTable(c: Context, tableId: string, query?: Parameters<Store["getTable"]>[1]) {
    const user = await requireUser(c);
    const payload = await store.getTable(tableId, query, { viewerUserId: user.id });
    if (user.role === "admin") return payload;
    const acl = await store.getTableAcl(tableId);
    return store.applyAclToPayload(payload, { userId: user.id, name: user.name, email: user.email }, acl);
  }

  async function visibleBases(user: PublicUser) {
    const bases = await store.listBases();
    if (user.role === "admin" && user.kind !== "agent") return bases;
    const ids = new Set(await accounts.visibleBaseIds(user));
    return bases.filter((base) => ids.has(base.id));
  }

  async function requireUser(c: Context): Promise<PublicUser> {
    const user = await accounts.userFromSecret(readSecret(c));
    if (!user) throw new DomainError("请先登录", 401);
    if (user.disabled) throw new DomainError("账号已停用", 403);
    return user;
  }

  async function requireAdmin(c: Context): Promise<PublicUser> {
    const user = await requireUser(c);
    if (user.role !== "admin") throw new DomainError("需要管理员权限", 403);
    return user;
  }

  async function requireBase(c: Context, baseId: string, role: MemberRole): Promise<PublicUser> {
    const user = await requireUser(c);
    await assertBaseRole(accounts, user, baseId, role);
    return user;
  }

  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(
      "/*",
      serveStatic({
        root: webRoot,
        rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
      }),
    );
    app.notFound(async (c) => {
      if (c.req.path.startsWith("/api")) return c.json({ error: "未找到接口" }, 404);
      const index = path.join(webRoot, "index.html");
      const html = await fs.promises.readFile(index, "utf8");
      return c.html(html);
    });
  }

  return app;
}

function resolveWebRoot(): string | null {
  const configured = process.env.DUOWEI_WEB_ROOT?.trim();
  if (configured) {
    return fs.existsSync(path.join(configured, "index.html")) ? configured : null;
  }
  // 开发态不自动挂载 dist-web，避免干扰 Vite；生产构建目录仅在 NODE_ENV=production 时启用
  if (process.env.NODE_ENV !== "production") return null;
  for (const dir of [path.resolve("dist-web"), path.resolve("web/dist")]) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function readSecret(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return getCookie(c, COOKIE);
}

function setSession(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 14 * 24 * 60 * 60,
    secure: process.env.DUOWEI_COOKIE_SECURE === "1",
  });
}

async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("请求体不是合法 JSON");
  }
}
