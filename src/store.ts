import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyQuery, displayText, evalFormulaCached, matchesFilter } from "./query.js";
import { emitPluginEvent, recentPluginEvents } from "./plugins.js";
import { normalizeFeishuWebhook, sendFeishuText } from "./feishu.js";
import { buildIcsCalendar } from "./ics.js";
import {
  LIMITS,
  canChangeFieldType,
  listChangeTargets,
} from "./limits.js";
import {
  emptyViewConfig,
  SYSTEM_FIELD_TYPES,
  TAG_COLORS,
  type AppPortalConfig,
  type ApprovalStrategy,
  type ApprovalVote,
  type AttachmentMeta,
  type Automation,
  type AutomationAction,
  type AutomationCondition,
  type AutomationTrigger,
  type BaseIntegrations,
  type BaseSummary,
  type CalendarFeed,
  type Comment,
  type DashboardConfig,
  type DetailPageConfig,
  type DisplayValue,
  type Field,
  type FieldConfig,
  type FieldDraft,
  type FieldType,
  type MarketplacePlugin,
  type Notification,
  type PluginHook,
  type PublicRecord,
  type RecordQuery,
  type RowHeight,
  type SelectOption,
  type ShareLink,
  type SyncConflict,
  type SyncJob,
  type SyncMode,
  type SyncRunResult,
  type TableAcl,
  type TablePayload,
  type RowAccessRule,
  type View,
  type ViewConfig,
  type ViewProtection,
  type ViewType,
  type Workflow,
  type WorkflowAuditAction,
  type WorkflowAuditEvent,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowSlaSummary,
  type ApprovalProxy,
  type PublicShare,
  type PublicShareKind,
  type GeoPoint,
  emptyDetailPageConfig,
} from "./types.js";

const SYSTEM_SET = new Set<string>(SYSTEM_FIELD_TYPES);
const VIEW_TYPES: ViewType[] = ["grid", "kanban", "calendar", "gallery", "form", "gantt"];
const ROW_HEIGHTS: RowHeight[] = ["short", "medium", "tall", "extra"];
const FIELD_TYPE_SET = new Set<FieldType>([
  "text",
  "long_text",
  "number",
  "single_select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "person",
  "rating",
  "progress",
  "currency",
  "auto_number",
  "created_time",
  "updated_time",
  "created_by",
  "formula",
  "link",
  "duplex_link",
  "lookup",
  "button",
  "attachment",
  "barcode",
  "geolocation",
  "signature",
  "group",
]);
const LINK_TYPES = new Set(["link", "duplex_link"]);
const VIEW_PROTECTIONS = new Set<ViewProtection>(["public", "locked", "personal"]);

/** Serialize field-type changes on very large tables (Feishu-like constraint). */
const fieldChangeLocks = new Map<string, { fieldId: string; startedAt: number }>();

export class DomainError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DomainError";
    this.status = status;
  }
}

type RawRecord = {
  id: string;
  tableId: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

function nid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function asNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function asString(value: unknown): string {
  return String(value ?? "");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  private db: Client;
  readonly uploadsDir: string;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.uploadsDir = path.join(path.dirname(dbPath), "uploads");
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.db = createClient({ url: `file:${dbPath}` });
  }

  async init(): Promise<void> {
    await this.db.execute("PRAGMA foreign_keys = ON");
    await this.db.execute("PRAGMA journal_mode = WAL");
    const statements = [
      `CREATE TABLE IF NOT EXISTS bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS fields (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        values_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS views (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tables_base ON tables(base_id, position)`,
      `CREATE INDEX IF NOT EXISTS idx_fields_table ON fields(table_id, position)`,
      `CREATE INDEX IF NOT EXISTS idx_records_table ON records(table_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_views_table ON views(table_id, position)`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS verification_codes (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS access_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS mcp_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        contact TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        token_hash TEXT UNIQUE,
        token_prefix TEXT,
        approved_by TEXT,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mcp_agents_status ON mcp_agents(status, created_at)`,
      `CREATE TABLE IF NOT EXISTS mcp_agent_bases (
        agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
        base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        PRIMARY KEY (agent_id, base_id)
      )`,
      `CREATE TABLE IF NOT EXISTS base_members (
        base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (base_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_codes_email ON verification_codes(email, created_at)`,
      `CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_comments_record ON comments(record_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_automations_table ON automations(table_id)`,
      `CREATE TABLE IF NOT EXISTS table_acls (
        table_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
        row_allow TEXT NOT NULL DEFAULT '{}',
        column_deny TEXT NOT NULL DEFAULT '{}',
        row_rules TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE TABLE IF NOT EXISTS record_history (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        table_id TEXT NOT NULL,
        user_id TEXT,
        user_name TEXT,
        action TEXT NOT NULL,
        patch_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_history_record ON record_history(record_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS auto_counters (
        field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
        next_value INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS base_settings (
        base_id TEXT PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        portal_json TEXT NOT NULL DEFAULT '{}',
        integrations_json TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE TABLE IF NOT EXISTS calendar_feeds (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        date_field_id TEXT,
        title_field_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS record_watches (
        user_id TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, record_id)
      )`,
      `CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        table_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS public_shares (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        view_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_public_shares_table ON public_shares(table_id)`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        base_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        record_id TEXT,
        message TEXT NOT NULL,
        read_flag INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        nodes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflows_table ON workflows(table_id)`,
      `CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_table_id TEXT NOT NULL,
        target_table_id TEXT NOT NULL,
        field_map_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_hooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        event TEXT NOT NULL,
        target TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        record_id TEXT NOT NULL,
        status TEXT NOT NULL,
        pending_node_index INTEGER NOT NULL,
        approvers_json TEXT NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        comment TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, created_at)`,
      `CREATE TABLE IF NOT EXISTS workflow_audit (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_user_name TEXT NOT NULL,
        on_behalf_of_user_id TEXT,
        on_behalf_of_user_name TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_audit_run ON workflow_audit(run_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS approval_proxy_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        proxy_user_id TEXT NOT NULL,
        proxy_user_name TEXT NOT NULL,
        base_id TEXT,
        workflow_id TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_rules_proxy ON approval_proxy_rules(proxy_user_id)`,
    ];
    for (const sql of statements) await this.db.execute(sql);
    // migrate automations conditions column if missing
    try {
      await this.db.execute("ALTER TABLE automations ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* already exists */
    }
    for (const sql of [
      "ALTER TABLE sync_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'",
      "ALTER TABLE sync_jobs ADD COLUMN conflict TEXT NOT NULL DEFAULT 'overwrite'",
      "ALTER TABLE sync_jobs ADD COLUMN match_field TEXT",
      "ALTER TABLE sync_jobs ADD COLUMN last_result_json TEXT",
      "ALTER TABLE workflow_runs ADD COLUMN strategy TEXT NOT NULL DEFAULT 'any'",
      "ALTER TABLE workflow_runs ADD COLUMN votes_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE workflow_runs ADD COLUMN timeout_at INTEGER",
      "ALTER TABLE workflow_runs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE workflow_runs ADD COLUMN reminded_at INTEGER",
      "ALTER TABLE workflow_runs ADD COLUMN node_label TEXT",
      "ALTER TABLE uploads ADD COLUMN base_id TEXT",
      "ALTER TABLE uploads ADD COLUMN min_role TEXT NOT NULL DEFAULT 'viewer'",
      "ALTER TABLE workflow_runs ADD COLUMN force_all_after_add_sign INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE workflow_audit ADD COLUMN record_id TEXT",
      "ALTER TABLE table_acls ADD COLUMN row_rules TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE automations ADD COLUMN last_run_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE views ADD COLUMN protection TEXT NOT NULL DEFAULT 'public'",
      "ALTER TABLE views ADD COLUMN created_by TEXT",
      "ALTER TABLE base_settings ADD COLUMN integrations_json TEXT NOT NULL DEFAULT '{}'",
    ]) {
      try {
        await this.db.execute(sql);
      } catch {
        /* already exists */
      }
    }
    try {
      await this.db.execute(`CREATE TABLE IF NOT EXISTS table_detail_pages (
        table_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL DEFAULT '{}'
      )`);
    } catch {
      /* ignore */
    }
  }

  get database(): Client {
    return this.db;
  }

  async listBases(): Promise<BaseSummary[]> {
    const bases = await this.db.execute("SELECT * FROM bases ORDER BY created_at ASC");
    const tables = await this.db.execute("SELECT * FROM tables ORDER BY position ASC");
    const settings = await this.db.execute("SELECT * FROM base_settings");
    const tzMap = new Map(settings.rows.map((row) => [asString(row.base_id), asString(row.timezone)]));
    return bases.rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
      timezone: tzMap.get(asString(row.id)) ?? "Asia/Shanghai",
      tables: tables.rows
        .filter((table) => table.base_id === row.id)
        .map((table) => ({ id: asString(table.id), name: asString(table.name) })),
    }));
  }

  async createBase(name: string): Promise<BaseSummary> {
    const now = Date.now();
    const id = nid("b");
    await this.db.execute({
      sql: "INSERT INTO bases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      args: [id, cleanName(name), now, now],
    });
    await this.db.execute({
      sql: "INSERT INTO base_settings (base_id, timezone, portal_json) VALUES (?, 'Asia/Shanghai', '{}')",
      args: [id],
    });
    return { id, name: cleanName(name), createdAt: now, updatedAt: now, timezone: "Asia/Shanghai", tables: [] };
  }

  async renameBase(baseId: string, name: string): Promise<BaseSummary> {
    await this.requireBase(baseId);
    const now = Date.now();
    await this.db.execute({
      sql: "UPDATE bases SET name = ?, updated_at = ? WHERE id = ?",
      args: [cleanName(name), now, baseId],
    });
    const bases = await this.listBases();
    const base = bases.find((item) => item.id === baseId);
    if (!base) throw new DomainError("找不到多维表格", 404);
    return base;
  }

  async deleteBase(baseId: string): Promise<void> {
    await this.requireBase(baseId);
    await this.db.execute({ sql: "DELETE FROM bases WHERE id = ?", args: [baseId] });
  }

  async createTable(
    baseId: string,
    input: { name: string; fields?: FieldDraft[]; defaultViewName?: string; withKanban?: boolean },
  ): Promise<TablePayload> {
    await this.requireBase(baseId);
    const existing = await this.db.execute({ sql: "SELECT COUNT(*) AS c FROM tables WHERE base_id = ?", args: [baseId] });
    if (asNumber(existing.rows[0]?.c) >= LIMITS.tablesPerBase) {
      throw new DomainError(`每个多维表格最多 ${LIMITS.tablesPerBase} 张数据表`);
    }
    const now = Date.now();
    const tableId = nid("t");
    const position = await this.nextPosition("tables", "base_id", baseId);
    await this.db.execute({
      sql: "INSERT INTO tables (id, base_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [tableId, baseId, cleanName(input.name), position, now, now],
    });

    const drafts = input.fields?.length ? input.fields : [{ name: "标题", type: "text" as const }];
    const fields: Field[] = [];
    for (const draft of drafts) fields.push(await this.createField(tableId, draft));

    await this.createView(tableId, { name: input.defaultViewName?.trim() || "表格", type: "grid" });
    if (input.withKanban) {
      const select = fields.find((field) => field.type === "single_select");
      if (select) {
        await this.createView(tableId, { name: "看板", type: "kanban", groupField: select.id });
      }
    }
    return this.getTable(tableId);
  }

  async renameTable(tableId: string, name: string): Promise<void> {
    await this.requireTable(tableId);
    await this.db.execute({
      sql: "UPDATE tables SET name = ?, updated_at = ? WHERE id = ?",
      args: [cleanName(name), Date.now(), tableId],
    });
  }

  async deleteTable(tableId: string): Promise<void> {
    await this.requireTable(tableId);
    await this.db.execute({ sql: "DELETE FROM tables WHERE id = ?", args: [tableId] });
  }

  async getTable(tableId: string, query?: RecordQuery, opts?: { viewerUserId?: string }): Promise<TablePayload> {
    const table = await this.requireTable(tableId);
    const fields = await this.listFields(tableId);
    const views = await this.listViews(tableId, opts?.viewerUserId);
    const records = await this.listPublicRecords(tableId, fields);
    const view = query?.viewId ? views.find((item) => item.id === query.viewId) : undefined;
    if (query?.viewId && !view) throw new DomainError("找不到视图", 404);

    let filtered = records;
    if (view) {
      filtered = applyQuery(filtered, fields, {
        filters: view.config.filters,
        conjunction: view.config.conjunction,
        sorts: view.config.sorts,
      });
    }
    filtered = applyQuery(filtered, fields, {
      filters: query?.filters,
      conjunction: query?.conjunction,
      sorts: query?.sorts?.length ? query.sorts : undefined,
      limit: query?.limit == null ? 5000 : Math.min(query.limit, 5000),
    });

    return {
      id: table.id,
      baseId: table.baseId,
      name: table.name,
      fields,
      views,
      records: filtered,
    };
  }

  async createField(tableId: string, draft: FieldDraft): Promise<Field> {
    await this.requireTable(tableId);
    const name = cleanName(draft.name);
    const fields = await this.listFields(tableId);
    if (fields.some((field) => field.name === name)) throw new DomainError(`字段已存在：${name}`);
    if (!FIELD_TYPE_SET.has(draft.type)) throw new DomainError(`不支持的字段类型：${draft.type}`);
    if (fields.length >= LIMITS.fieldsPerTable) {
      throw new DomainError(`每个数据表最多 ${LIMITS.fieldsPerTable} 个字段`);
    }
    if (draft.type === "formula" || draft.type === "lookup") {
      const special = fields.filter((item) => item.type === "formula" || item.type === "lookup").length;
      if (special >= LIMITS.formulaAndLookupPerTable) {
        throw new DomainError(`公式与查找引用合计最多 ${LIMITS.formulaAndLookupPerTable} 个`);
      }
    }
    if (
      (draft.type === "single_select" || draft.type === "multi_select") &&
      (draft.options?.length ?? 0) > LIMITS.optionsPerSelect
    ) {
      throw new DomainError(`单选/多选最多 ${LIMITS.optionsPerSelect} 个选项`);
    }
    const now = Date.now();
    const config: FieldConfig = {};
    if (draft.type === "single_select" || draft.type === "multi_select") {
      config.options = buildOptions(draft.options ?? []);
    }
    if (draft.type === "rating") config.max = draft.max && draft.max > 0 ? Math.min(draft.max, 10) : 5;
    if (draft.type === "currency") config.currency = (draft.currency || "CNY").toUpperCase();
    if (draft.type === "formula") {
      if (!draft.formula?.trim()) throw new DomainError("公式字段需要 formula");
      config.formula = draft.formula.trim();
    }
    if (draft.type === "link" || draft.type === "duplex_link") {
      if (!draft.linkTableId) throw new DomainError("关联字段需要 linkTableId");
      const linkTable = await this.requireTable(draft.linkTableId);
      const self = await this.requireTable(tableId);
      if (linkTable.baseId !== self.baseId) throw new DomainError("只能关联同一多维表格内的数据表");
      config.linkTableId = draft.linkTableId;
    }
    if (draft.type === "lookup") {
      if (!draft.lookupLinkFieldId || !draft.lookupTargetFieldId) {
        throw new DomainError("查找引用需要 lookupLinkFieldId 与 lookupTargetFieldId");
      }
      const linkField = fields.find((item) => item.id === draft.lookupLinkFieldId);
      if (!linkField || !LINK_TYPES.has(linkField.type)) throw new DomainError("查找引用必须基于关联字段");
      config.lookupLinkFieldId = draft.lookupLinkFieldId;
      config.lookupTargetFieldId = draft.lookupTargetFieldId;
    }
    if (draft.type === "auto_number" || draft.type === "barcode") config.prefix = draft.prefix?.trim() || "";
    if (draft.type === "button") {
      config.buttonLabel = draft.buttonLabel?.trim() || "执行";
      config.buttonAction = draft.buttonAction ?? { type: "add_comment", body: "按钮已点击" };
    }
    if (
      (draft.type === "single_select" || draft.type === "multi_select") &&
      draft.optionCascade?.targetFieldId &&
      draft.optionCascade.map
    ) {
      config.optionCascade = {
        targetFieldId: draft.optionCascade.targetFieldId,
        map: draft.optionCascade.map,
      };
    }

    const field: Field = {
      id: nid("f"),
      tableId,
      name,
      type: draft.type,
      position: fields.reduce((max, item) => Math.max(max, item.position), -1) + 1,
      config,
    };
    await this.db.execute({
      sql: "INSERT INTO fields (id, table_id, name, type, config, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [field.id, tableId, field.name, field.type, JSON.stringify(field.config), field.position, now, now],
    });
    if (field.type === "auto_number") {
      await this.db.execute({
        sql: "INSERT INTO auto_counters (field_id, next_value) VALUES (?, 1)",
        args: [field.id],
      });
    }
    if (field.type === "duplex_link" && draft.linkTableId) {
      const reverseName = cleanName(draft.symmetricFieldName || `关联-${name}`);
      const peerFields = await this.listFields(draft.linkTableId);
      let peer = peerFields.find(
        (item) => item.type === "duplex_link" && item.config.linkTableId === tableId && item.config.symmetricFieldId === field.id,
      );
      if (!peer) {
        const existingByName = peerFields.find((item) => item.name === reverseName);
        const peerConfig: FieldConfig = {
          linkTableId: tableId,
          symmetricFieldId: field.id,
          duplexPrimary: false,
        };
        if (existingByName && existingByName.type === "duplex_link") {
          peer = existingByName;
          await this.db.execute({
            sql: "UPDATE fields SET config = ?, updated_at = ? WHERE id = ?",
            args: [JSON.stringify({ ...peer.config, ...peerConfig }), Date.now(), peer.id],
          });
          peer = { ...peer, config: { ...peer.config, ...peerConfig } };
        } else {
          peer = {
            id: nid("f"),
            tableId: draft.linkTableId,
            name: existingByName ? `${reverseName}-反` : reverseName,
            type: "duplex_link",
            position: peerFields.reduce((max, item) => Math.max(max, item.position), -1) + 1,
            config: peerConfig,
          };
          await this.db.execute({
            sql: "INSERT INTO fields (id, table_id, name, type, config, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [peer.id, peer.tableId, peer.name, peer.type, JSON.stringify(peer.config), peer.position, now, now],
          });
        }
      }
      field.config.symmetricFieldId = peer.id;
      field.config.duplexPrimary = true;
      await this.db.execute({
        sql: "UPDATE fields SET config = ?, updated_at = ? WHERE id = ?",
        args: [JSON.stringify(field.config), Date.now(), field.id],
      });
    }
    return field;
  }

  async updateField(
    fieldId: string,
    patch: {
      name?: string;
      options?: FieldDraft["options"];
      formula?: string;
      linkTableId?: string;
      max?: number;
      currency?: string;
      prefix?: string;
      optionCascade?: FieldDraft["optionCascade"] | null;
      buttonLabel?: string;
      buttonAction?: FieldDraft["buttonAction"];
    },
  ): Promise<Field> {
    const field = await this.requireField(fieldId);
    const fields = await this.listFields(field.tableId);
    let name = field.name;
    if (patch.name != null) {
      name = cleanName(patch.name);
      if (fields.some((item) => item.id !== field.id && item.name === name)) {
        throw new DomainError(`字段已存在：${name}`);
      }
    }
    let config = { ...field.config };
    if (patch.options && (field.type === "single_select" || field.type === "multi_select")) {
      if (patch.options.length > LIMITS.optionsPerSelect) {
        throw new DomainError(`单选/多选最多 ${LIMITS.optionsPerSelect} 个选项`);
      }
      config = { ...config, options: mergeOptions(field.config.options ?? [], patch.options) };
    }
    if (patch.formula != null && field.type === "formula") config.formula = patch.formula.trim();
    if (patch.linkTableId != null && field.type === "link") {
      const linkTable = await this.requireTable(patch.linkTableId);
      const self = await this.requireTable(field.tableId);
      if (linkTable.baseId !== self.baseId) throw new DomainError("只能关联同一多维表格内的数据表");
      config.linkTableId = patch.linkTableId;
    }
    if (patch.max != null && field.type === "rating") config.max = Math.min(Math.max(patch.max, 1), 10);
    if (patch.currency != null && field.type === "currency") config.currency = patch.currency.toUpperCase();
    if (patch.prefix != null && field.type === "auto_number") config.prefix = patch.prefix.trim();
    if (patch.buttonLabel != null && field.type === "button") config.buttonLabel = patch.buttonLabel.trim() || "执行";
    if (patch.buttonAction != null && field.type === "button") config.buttonAction = patch.buttonAction;
    if (patch.optionCascade !== undefined && (field.type === "single_select" || field.type === "multi_select")) {
      if (patch.optionCascade == null) {
        const { optionCascade: _removed, ...rest } = config;
        config = rest;
      } else {
        config.optionCascade = {
          targetFieldId: patch.optionCascade.targetFieldId,
          map: patch.optionCascade.map,
        };
      }
    }
    await this.db.execute({
      sql: "UPDATE fields SET name = ?, config = ?, updated_at = ? WHERE id = ?",
      args: [name, JSON.stringify(config), Date.now(), fieldId],
    });
    return { ...field, name, config };
  }

  async changeFieldType(fieldId: string, nextType: FieldType): Promise<Field> {
    const field = await this.requireField(fieldId);
    if (field.type === nextType) return field;
    if (!FIELD_TYPE_SET.has(nextType)) throw new DomainError(`不支持的字段类型：${nextType}`);
    if (!canChangeFieldType(field.type, nextType)) {
      throw new DomainError(`不支持将「${field.type}」变更为「${nextType}」`);
    }
    const records = await this.listRawRecords(field.tableId);
    const lock = fieldChangeLocks.get(field.tableId);
    if (records.length >= LIMITS.fieldChangeConstraintMinRows) {
      if (lock && lock.fieldId !== fieldId) {
        throw new DomainError(
          `大于 ${LIMITS.fieldChangeConstraintMinRows} 行的数据表中暂不支持连续变更字段，请等上一次变更完成后重试`,
        );
      }
      fieldChangeLocks.set(field.tableId, { fieldId, startedAt: Date.now() });
    }
    try {
      let config: FieldConfig = {};
      if (nextType === "rating") config.max = 5;
      if (nextType === "currency") config.currency = "CNY";
      if (nextType === "single_select" || nextType === "multi_select") {
        const names = new Set<string>();
        for (const record of records.slice(0, LIMITS.fieldTypeChangeMaxRows)) {
          const raw = record.values[field.id];
          for (const name of toNameList(raw == null ? "" : String(raw))) names.add(name);
        }
        config.options = buildOptions([...names]);
      }
      if (field.type === "link" || field.type === "duplex_link") {
        config.linkTableId = field.config.linkTableId;
        config.symmetricFieldId = field.config.symmetricFieldId;
      }

      const convertLimit = Math.min(records.length, LIMITS.fieldTypeChangeMaxRows);
      for (let i = 0; i < convertLimit; i++) {
        const record = records[i];
        const converted = convertStoredForTypeChange(record.values[field.id], field, nextType, config);
        if (converted === record.values[field.id]) continue;
        const values = { ...record.values, [field.id]: converted };
        await this.writeValues(record.id, values, Date.now());
      }

      await this.db.execute({
        sql: "UPDATE fields SET type = ?, config = ?, updated_at = ? WHERE id = ?",
        args: [nextType, JSON.stringify(config), Date.now(), fieldId],
      });
      return { ...field, type: nextType, config };
    } finally {
      const current = fieldChangeLocks.get(field.tableId);
      if (current?.fieldId === fieldId) fieldChangeLocks.delete(field.tableId);
    }
  }

  fieldTypeChangeTargets(fieldId: string): Promise<FieldType[]> {
    return this.requireField(fieldId).then((field) => listChangeTargets(field.type));
  }

  async deleteField(fieldId: string): Promise<void> {
    const field = await this.requireField(fieldId);
    const records = await this.listRawRecords(field.tableId);
    for (const record of records) {
      if (!(fieldId in record.values)) continue;
      delete record.values[fieldId];
      await this.writeValues(record.id, record.values, record.updatedAt);
    }
    const views = await this.listViews(field.tableId);
    for (const view of views) {
      const config: ViewConfig = {
        ...view.config,
        filters: view.config.filters.filter((filter) => filter.fieldId !== fieldId),
        sorts: view.config.sorts.filter((sort) => sort.fieldId !== fieldId),
        groups: view.config.groups.filter((group) => group.fieldId !== fieldId),
        hiddenFieldIds: view.config.hiddenFieldIds.filter((id) => id !== fieldId),
        groupFieldId: view.config.groupFieldId === fieldId ? null : view.config.groupFieldId,
        dateFieldId: view.config.dateFieldId === fieldId ? null : view.config.dateFieldId,
        titleFieldId: view.config.titleFieldId === fieldId ? null : view.config.titleFieldId,
      };
      await this.writeViewConfig(view.id, config);
    }
    await this.db.execute({ sql: "DELETE FROM fields WHERE id = ?", args: [fieldId] });
  }

  async createRecord(
    tableId: string,
    input: Record<string, unknown>,
    meta?: { userId?: string; userName?: string; skipAutomation?: boolean; skipDuplex?: boolean },
  ): Promise<{ record: PublicRecord; fields: Field[] }> {
    await this.requireTable(tableId);
    let fields = await this.listFields(tableId);
    const values: Record<string, unknown> = {};
    const duplexOps: Array<{ field: Field; ids: string[]; previous: string[] }> = [];
    for (const [key, raw] of Object.entries(input)) {
      const resolved = await this.writeFieldValue(fields, key, raw);
      fields = resolved.fields;
      if (SYSTEM_SET.has(resolved.type)) continue;
      if (resolved.stored === undefined) continue;
      values[resolved.fieldId] = resolved.stored;
      if (resolved.type === "duplex_link" && !meta?.skipDuplex) {
        const field = fields.find((item) => item.id === resolved.fieldId)!;
        duplexOps.push({
          field,
          ids: Array.isArray(resolved.stored) ? resolved.stored.map(String) : [],
          previous: [],
        });
      }
    }
    const now = Date.now();
    for (const field of fields) {
      if (field.type === "auto_number" && values[field.id] == null) {
        values[field.id] = await this.nextAutoNumber(field);
      }
      if (field.type === "created_by" && meta?.userName) {
        values[field.id] = meta.userName;
      }
    }
    this.assertOptionCascades(fields, values);
    const id = nid("r");
    await this.db.execute({
      sql: "INSERT INTO records (id, table_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, tableId, JSON.stringify(values), now, now],
    });
    await this.touchTable(tableId);
    await this.appendHistory({
      recordId: id,
      tableId,
      userId: meta?.userId,
      userName: meta?.userName,
      action: "create",
      patch: input,
    });
    for (const op of duplexOps) {
      await this.syncDuplexLinks(id, op.field, op.ids, op.previous);
    }
    const record = { id, tableId, values, createdAt: now, updatedAt: now };
    if (!meta?.skipAutomation) {
      await this.runAutomations(tableId, "record_created", record, fields, null, meta);
      await this.runWorkflows(tableId, "record_created", record, fields, meta);
      await this.firePluginHooks("record_created", tableId, id);
    }
    const refreshed = await this.requireRecord(id);
    fields = await this.listFields(tableId);
    return { record: await this.toPublic(refreshed, fields), fields };
  }

  async updateRecord(
    recordId: string,
    input: Record<string, unknown>,
    meta?: { userId?: string; userName?: string; skipAutomation?: boolean; skipDuplex?: boolean },
  ): Promise<{ record: PublicRecord; fields: Field[] }> {
    const current = await this.requireRecord(recordId);
    let fields = await this.listFields(current.tableId);
    const values = { ...current.values };
    const changedFieldIds: string[] = [];
    const duplexOps: Array<{ field: Field; ids: string[]; previous: string[] }> = [];
    for (const [key, raw] of Object.entries(input)) {
      const resolved = await this.writeFieldValue(fields, key, raw);
      fields = resolved.fields;
      if (SYSTEM_SET.has(resolved.type) && resolved.type !== "formula") {
        throw new DomainError(`「${resolved.name}」为系统字段，不可直接修改`);
      }
      if (resolved.type === "formula" || resolved.type === "lookup" || resolved.type === "button") {
        throw new DomainError(`「${resolved.name}」不可直接修改`);
      }
      const previous = Array.isArray(values[resolved.fieldId])
        ? (values[resolved.fieldId] as unknown[]).map(String)
        : [];
      if (resolved.stored == null) delete values[resolved.fieldId];
      else values[resolved.fieldId] = resolved.stored;
      changedFieldIds.push(resolved.fieldId);
      if (resolved.type === "duplex_link" && !meta?.skipDuplex) {
        const field = fields.find((item) => item.id === resolved.fieldId)!;
        duplexOps.push({
          field,
          ids: Array.isArray(resolved.stored) ? resolved.stored.map(String) : [],
          previous,
        });
      }
    }
    this.assertOptionCascades(fields, values);
    const updatedAt = Date.now();
    await this.writeValues(recordId, values, updatedAt);
    await this.touchTable(current.tableId);
    await this.appendHistory({
      recordId,
      tableId: current.tableId,
      userId: meta?.userId,
      userName: meta?.userName,
      action: "update",
      patch: input,
    });
    for (const op of duplexOps) {
      await this.syncDuplexLinks(recordId, op.field, op.ids, op.previous);
    }
    const next = { ...current, values, updatedAt };
    if (!meta?.skipAutomation) {
      await this.runAutomations(current.tableId, "record_updated", next, fields, { changedFieldIds, before: current }, meta);
      await this.runWorkflows(current.tableId, "record_updated", next, fields, meta);
      await this.firePluginHooks("record_updated", current.tableId, recordId);
    }
    await this.notifyWatchers(recordId, current.tableId, meta?.userName ?? "有人", "更新了关注的记录");
    const refreshed = await this.requireRecord(recordId);
    fields = await this.listFields(current.tableId);
    return {
      record: await this.toPublic(refreshed, fields),
      fields,
    };
  }

  async deleteRecord(recordId: string): Promise<void> {
    const record = await this.requireRecord(recordId);
    await this.db.execute({ sql: "DELETE FROM records WHERE id = ?", args: [recordId] });
    await this.touchTable(record.tableId);
    await this.firePluginHooks("record_deleted", record.tableId, recordId);
  }

  async createView(
    tableId: string,
    input: {
      name: string;
      type: ViewType;
      groupField?: string;
      dateField?: string;
      titleField?: string;
      endDateField?: string;
      progressField?: string;
      dependencyField?: string;
      createdBy?: string;
    },
  ): Promise<View> {
    await this.requireTable(tableId);
    if (!VIEW_TYPES.includes(input.type)) throw new DomainError(`不支持的视图类型：${input.type}`);
    const existingViews = await this.listViews(tableId);
    if (existingViews.length >= LIMITS.viewsPerTable) {
      throw new DomainError(`每个数据表最多 ${LIMITS.viewsPerTable} 个视图`);
    }
    const fields = await this.listFields(tableId);
    const config = emptyViewConfig();
    if (input.type === "kanban" || input.type === "gantt") {
      const field = input.groupField
        ? this.resolveField(fields, input.groupField)
        : fields.find((item) => item.type === "single_select");
      if (input.type === "kanban") {
        if (!field) throw new DomainError("看板需要一个单选字段作为分组");
        if (field.type !== "single_select") throw new DomainError("看板只能按单选字段分组");
        config.groupFieldId = field.id;
      } else if (field?.type === "single_select") {
        config.groupFieldId = field.id;
      }
    }
    if (input.type === "calendar" || input.type === "gantt") {
      const dateField = input.dateField
        ? this.resolveField(fields, input.dateField)
        : fields.find((item) => item.type === "date");
      if (!dateField || dateField.type !== "date") throw new DomainError("日历/甘特需要一个日期字段");
      config.dateFieldId = dateField.id;
    }
    if (input.type === "gantt") {
      const endField = input.endDateField
        ? this.resolveField(fields, input.endDateField)
        : fields.filter((item) => item.type === "date" && item.id !== config.dateFieldId)[0] ??
          fields.find((item) => item.type === "date");
      if (endField?.type === "date") config.endDateFieldId = endField.id;
      const progress = input.progressField
        ? this.resolveField(fields, input.progressField)
        : fields.find((item) => item.type === "progress" || item.type === "number");
      if (progress) config.progressFieldId = progress.id;
      const dep = input.dependencyField
        ? this.resolveField(fields, input.dependencyField)
        : fields.find((item) => LINK_TYPES.has(item.type));
      if (dep) config.dependencyFieldId = dep.id;
    }
    if (input.type === "gallery" || input.type === "form") {
      const titleField = input.titleField
        ? this.resolveField(fields, input.titleField)
        : fields.find((item) => item.type === "text" || item.type === "long_text") ?? fields[0];
      if (titleField) config.titleFieldId = titleField.id;
    }
    const now = Date.now();
    const view: View = {
      id: nid("v"),
      tableId,
      name: cleanName(input.name),
      type: input.type,
      position: await this.nextPosition("views", "table_id", tableId),
      config,
      protection: "public",
      createdBy: input.createdBy ?? null,
    };
    await this.db.execute({
      sql: "INSERT INTO views (id, table_id, name, type, config, position, created_at, updated_at, protection, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        view.id,
        tableId,
        view.name,
        view.type,
        JSON.stringify(view.config),
        view.position,
        now,
        now,
        view.protection,
        view.createdBy,
      ],
    });
    return view;
  }

  async updateView(
    viewId: string,
    patch: { name?: string; config?: Partial<ViewConfig> },
    meta?: { userId?: string },
  ): Promise<View> {
    const view = await this.requireView(viewId);
    if (view.protection === "locked" && patch.config) {
      throw new DomainError("锁定视图不可修改配置", 403);
    }
    if (view.protection === "personal" && meta?.userId && view.createdBy && view.createdBy !== meta.userId) {
      throw new DomainError("无法修改他人的个人视图", 403);
    }
    const fields = await this.listFields(view.tableId);
    const merged = normalizeViewConfig({
      ...view.config,
      ...patch.config,
      filters: patch.config?.filters ?? view.config.filters,
      sorts: patch.config?.sorts ?? view.config.sorts,
      groups: patch.config?.groups ?? view.config.groups,
      hiddenFieldIds: patch.config?.hiddenFieldIds ?? view.config.hiddenFieldIds,
      conjunction: patch.config?.conjunction ?? view.config.conjunction,
      groupFieldId:
        patch.config && "groupFieldId" in patch.config
          ? patch.config.groupFieldId ?? null
          : view.config.groupFieldId,
      rowHeight: patch.config?.rowHeight ?? view.config.rowHeight,
      dateFieldId:
        patch.config && "dateFieldId" in patch.config
          ? patch.config.dateFieldId ?? null
          : view.config.dateFieldId,
      titleFieldId:
        patch.config && "titleFieldId" in patch.config
          ? patch.config.titleFieldId ?? null
          : view.config.titleFieldId,
      endDateFieldId:
        patch.config && "endDateFieldId" in patch.config
          ? patch.config.endDateFieldId ?? null
          : view.config.endDateFieldId,
      progressFieldId:
        patch.config && "progressFieldId" in patch.config
          ? patch.config.progressFieldId ?? null
          : view.config.progressFieldId,
      dependencyFieldId:
        patch.config && "dependencyFieldId" in patch.config
          ? patch.config.dependencyFieldId ?? null
          : view.config.dependencyFieldId,
      colorRules: patch.config?.colorRules ?? view.config.colorRules,
      fieldOrder: patch.config?.fieldOrder ?? view.config.fieldOrder,
    });
    if (merged.filters.length > LIMITS.filtersPerView) {
      throw new DomainError(`每个视图最多 ${LIMITS.filtersPerView} 个筛选条件`);
    }
    if (merged.groups.length > LIMITS.groupsPerView) {
      throw new DomainError(`每个视图最多 ${LIMITS.groupsPerView} 个分组条件`);
    }
    if (view.type === "kanban" && merged.groupFieldId) {
      const field = fields.find((item) => item.id === merged.groupFieldId);
      if (!field || field.type !== "single_select") throw new DomainError("看板只能按单选字段分组");
    }
    if ((view.type === "calendar" || view.type === "gantt") && merged.dateFieldId) {
      const field = fields.find((item) => item.id === merged.dateFieldId);
      if (!field || field.type !== "date") throw new DomainError("日历/甘特需要日期字段");
    }
    const name = patch.name != null ? cleanName(patch.name) : view.name;
    await this.db.execute({
      sql: "UPDATE views SET name = ?, config = ?, updated_at = ? WHERE id = ?",
      args: [name, JSON.stringify(merged), Date.now(), viewId],
    });
    return { ...view, name, config: merged };
  }

  async setViewProtection(viewId: string, protection: ViewProtection, userId: string): Promise<View> {
    if (!VIEW_PROTECTIONS.has(protection)) throw new DomainError("不支持的视图保护类型");
    const view = await this.requireView(viewId);
    const views = await this.listViews(view.tableId);
    if (protection === "personal") {
      if (view.createdBy && view.createdBy !== userId) {
        throw new DomainError("只能将自己创建的视图设为个人视图", 403);
      }
      const shared = views.filter((item) => item.id !== viewId && item.protection !== "personal");
      if (shared.length === 0) throw new DomainError("至少保留一个公共或锁定视图");
    }
    const createdBy = view.createdBy ?? userId;
    await this.db.execute({
      sql: "UPDATE views SET protection = ?, created_by = COALESCE(created_by, ?), updated_at = ? WHERE id = ?",
      args: [protection, createdBy, Date.now(), viewId],
    });
    return { ...view, protection, createdBy };
  }

  async deleteView(viewId: string, meta?: { userId?: string }): Promise<void> {
    const view = await this.requireView(viewId);
    if (view.protection === "locked") throw new DomainError("锁定视图不可删除", 403);
    if (view.protection === "personal" && meta?.userId && view.createdBy && view.createdBy !== meta.userId) {
      throw new DomainError("无法删除他人的个人视图", 403);
    }
    const views = await this.listViews(view.tableId);
    if (views.length <= 1) throw new DomainError("至少保留一个视图");
    const remainingShared = views.filter((item) => item.id !== viewId && item.protection !== "personal");
    if (remainingShared.length === 0) throw new DomainError("至少保留一个公共或锁定视图");
    await this.db.execute({ sql: "DELETE FROM views WHERE id = ?", args: [viewId] });
  }

  async getDetailPage(tableId: string): Promise<DetailPageConfig> {
    await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT config_json FROM table_detail_pages WHERE table_id = ?",
      args: [tableId],
    });
    const row = result.rows[0];
    if (!row) return emptyDetailPageConfig();
    return normalizeDetailPage(parseJson<Partial<DetailPageConfig>>(row.config_json, {}));
  }

  async setDetailPage(tableId: string, config: DetailPageConfig): Promise<DetailPageConfig> {
    await this.requireTable(tableId);
    const resolved = normalizeDetailPage(config);
    await this.db.execute({
      sql: `INSERT INTO table_detail_pages (table_id, config_json) VALUES (?, ?)
            ON CONFLICT(table_id) DO UPDATE SET config_json = excluded.config_json`,
      args: [tableId, JSON.stringify(resolved)],
    });
    return resolved;
  }

  async locateTable(tableId: string): Promise<{ baseId: string; tableId: string }> {
    const table = await this.requireTable(tableId);
    return { baseId: table.baseId, tableId: table.id };
  }

  async locateField(fieldId: string): Promise<{ baseId: string; tableId: string }> {
    const field = await this.requireField(fieldId);
    return this.locateTable(field.tableId);
  }

  async locateRecord(recordId: string): Promise<{ baseId: string; tableId: string }> {
    const record = await this.requireRecord(recordId);
    return this.locateTable(record.tableId);
  }

  async locateView(viewId: string): Promise<{ baseId: string; tableId: string }> {
    const view = await this.requireView(viewId);
    return this.locateTable(view.tableId);
  }

  async seedDemo(): Promise<void> {
    const base = await this.createBase("示例工作台");
    const tasks = await this.createTable(base.id, {
      name: "任务",
      defaultViewName: "表格",
      fields: [
        { name: "标题", type: "text" },
        { name: "描述", type: "long_text" },
        {
          name: "状态",
          type: "single_select",
          options: [
            { name: "待办", color: "gray" },
            { name: "进行中", color: "blue" },
            { name: "评审中", color: "purple" },
            { name: "已完成", color: "green" },
          ],
        },
        {
          name: "优先级",
          type: "single_select",
          options: [
            { name: "P0", color: "red" },
            { name: "P1", color: "orange" },
            { name: "P2", color: "blue" },
            { name: "P3", color: "gray" },
          ],
        },
        { name: "负责人", type: "text" },
        { name: "截止日期", type: "date" },
        {
          name: "来源",
          type: "single_select",
          options: [
            { name: "内部规划", color: "blue" },
            { name: "用户反馈", color: "cyan" },
            { name: "缺陷", color: "red" },
          ],
        },
      ],
    });
    await this.createView(tasks.id, { name: "看板", type: "kanban", groupField: "状态" });
    await this.createView(tasks.id, { name: "日历", type: "calendar", dateField: "截止日期" });

    const rows: Record<string, unknown>[] = [
      {
        标题: "网格里直接编辑",
        描述: "支持文本、单选、日期等字段的单元格编辑，作为日常录入入口。",
        状态: "已完成",
        优先级: "P0",
        负责人: "研发",
        截止日期: "2026-09-18",
        来源: "内部规划",
      },
      {
        标题: "按状态拖拽看板",
        描述: "看板按「状态」分列，拖拽卡片即更新状态，方便站会同步进度。",
        状态: "进行中",
        优先级: "P0",
        负责人: "产品",
        截止日期: "2026-09-25",
        来源: "内部规划",
      },
      {
        标题: "提供 Agent 可调用的 MCP",
        描述: "让助手能查询、创建和更新记录，例如把所有待办的 P0 标成进行中。",
        状态: "进行中",
        优先级: "P0",
        负责人: "研发",
        截止日期: "2026-09-26",
        来源: "内部规划",
      },
      {
        标题: "筛选进行中的高优先级任务",
        描述: "视图保存筛选和排序，表格与看板共用同一份数据。",
        状态: "待办",
        优先级: "P1",
        负责人: "产品",
        截止日期: "2026-10-03",
        来源: "内部规划",
      },
      {
        标题: "登录页在窄屏下错位",
        描述: "宽度小于 768 时主按钮被遮挡，需要补一个回归用例。",
        状态: "评审中",
        优先级: "P1",
        负责人: "设计",
        截止日期: "2026-09-28",
        来源: "缺陷",
      },
      {
        标题: "任务关联到项目",
        描述: "用关联字段把任务表和项目表连起来，看一个项目承接了哪些任务。",
        状态: "待办",
        优先级: "P2",
        负责人: "研发",
        截止日期: "2026-10-15",
        来源: "用户反馈",
      },
      {
        标题: "成员权限与评论",
        描述: "区分可编辑和只读，并在记录上留下讨论，服务多人协作。",
        状态: "待办",
        优先级: "P2",
        负责人: "产品",
        来源: "用户反馈",
      },
      {
        标题: "导入历史表格",
        描述: "从 CSV 导入现有表格，减少从其他工具迁过来的手工成本。",
        状态: "待办",
        优先级: "P3",
        负责人: "研发",
        来源: "内部规划",
      },
    ];
    for (const row of rows) await this.createRecord(tasks.id, row);

    const projects = await this.createTable(base.id, {
      name: "项目",
      defaultViewName: "表格",
      fields: [
        { name: "名称", type: "text" },
        { name: "周期", type: "text" },
        { name: "目标", type: "long_text" },
        {
          name: "状态",
          type: "single_select",
          options: [
            { name: "规划中", color: "gray" },
            { name: "进行中", color: "blue" },
            { name: "已结束", color: "green" },
          ],
        },
      ],
    });
    await this.createView(projects.id, { name: "看板", type: "kanban", groupField: "状态" });
    await this.createRecord(projects.id, {
      名称: "本周交付",
      周期: "09/15 - 09/26",
      目标: "交付多维表格、看板，以及可供 Agent 调用的接口。",
      状态: "进行中",
    });
    await this.createRecord(projects.id, {
      名称: "下期规划",
      周期: "09/29 - 10/10",
      目标: "补筛选体验、关联字段，并接入团队权限。",
      状态: "规划中",
    });
  }

  private async writeFieldValue(
    fields: Field[],
    key: string,
    raw: unknown,
  ): Promise<{ fields: Field[]; fieldId: string; stored: unknown; type: FieldType; name: string }> {
    const field = this.resolveField(fields, key);
    if (SYSTEM_SET.has(field.type) && field.type !== "created_by") {
      return { fields, fieldId: field.id, stored: undefined, type: field.type, name: field.name };
    }
    if (raw == null || raw === "") return { fields, fieldId: field.id, stored: null, type: field.type, name: field.name };

    if (field.type === "single_select") {
      const name = String(raw).trim();
      if (!name) return { fields, fieldId: field.id, stored: null, type: field.type, name: field.name };
      const ensured = await this.ensureOptions(field, [name]);
      return { fields: ensured.fields, fieldId: field.id, stored: ensured.ids[0], type: field.type, name: field.name };
    }

    if (field.type === "multi_select") {
      const names = toNameList(raw);
      if (names.length === 0) return { fields, fieldId: field.id, stored: null, type: field.type, name: field.name };
      const ensured = await this.ensureOptions(field, names);
      return { fields: ensured.fields, fieldId: field.id, stored: ensured.ids, type: field.type, name: field.name };
    }

    if (field.type === "number" || field.type === "currency" || field.type === "rating" || field.type === "progress") {
      const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(numeric)) throw new DomainError(`「${field.name}」需要数字`);
      if (field.type === "rating") {
        const max = field.config.max ?? 5;
        if (numeric < 0 || numeric > max) throw new DomainError(`「${field.name}」评分需在 0-${max}`);
      }
      if (field.type === "progress") {
        if (numeric < 0 || numeric > 100) throw new DomainError(`「${field.name}」进度需在 0-100`);
      }
      return { fields, fieldId: field.id, stored: numeric, type: field.type, name: field.name };
    }

    if (field.type === "checkbox") {
      return { fields, fieldId: field.id, stored: toBoolean(raw), type: field.type, name: field.name };
    }

    if (field.type === "date") {
      const text = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new DomainError(`「${field.name}」需要 YYYY-MM-DD 日期`);
      return { fields, fieldId: field.id, stored: text, type: field.type, name: field.name };
    }

    if (field.type === "email") {
      const text = String(raw).trim();
      if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new DomainError(`「${field.name}」不是合法邮箱`);
      return { fields, fieldId: field.id, stored: text || null, type: field.type, name: field.name };
    }

    if (field.type === "phone") {
      const text = String(raw).trim();
      if (text.replace(/\D/g, "").length > LIMITS.phoneMaxLen) {
        throw new DomainError(`「${field.name}」电话数字长度不超过 ${LIMITS.phoneMaxLen}`);
      }
      if (text && !/^[\d+\-\s()]{5,64}$/.test(text)) throw new DomainError(`「${field.name}」不是合法电话`);
      return { fields, fieldId: field.id, stored: text || null, type: field.type, name: field.name };
    }

    if (field.type === "person" || field.type === "group") {
      const names = toNameList(raw);
      const cap = field.type === "group" ? LIMITS.groupPerCell : LIMITS.personPerCell;
      if (names.length > cap) throw new DomainError(`「${field.name}」最多 ${cap} 个`);
      return { fields, fieldId: field.id, stored: names.length ? names : null, type: field.type, name: field.name };
    }

    if (field.type === "link" || field.type === "duplex_link") {
      const ids = toNameList(raw);
      if (ids.length > LIMITS.linkPerCell) throw new DomainError(`「${field.name}」最多关联 ${LIMITS.linkPerCell} 条`);
      if (!field.config.linkTableId) throw new DomainError(`「${field.name}」未配置关联表`);
      for (const id of ids) {
        const linked = await this.requireRecord(id).catch(() => null);
        if (!linked || linked.tableId !== field.config.linkTableId) {
          throw new DomainError(`「${field.name}」关联记录无效：${id}`);
        }
      }
      return { fields, fieldId: field.id, stored: ids.length ? ids : null, type: field.type, name: field.name };
    }

    if (field.type === "attachment") {
      const items = parseAttachments(raw);
      if (items.length > LIMITS.attachmentsPerCell) {
        throw new DomainError(`「${field.name}」每个单元格最多 ${LIMITS.attachmentsPerCell} 个附件`);
      }
      return { fields, fieldId: field.id, stored: items.length ? items : null, type: field.type, name: field.name };
    }

    if (field.type === "barcode") {
      const text = String(raw).trim();
      const prefix = field.config.prefix ?? "";
      return { fields, fieldId: field.id, stored: text ? `${prefix}${text.replace(prefix, "")}` : null, type: field.type, name: field.name };
    }

    if (field.type === "geolocation") {
      const point = parseGeoPoint(raw);
      return { fields, fieldId: field.id, stored: point, type: field.type, name: field.name };
    }

    if (field.type === "signature") {
      const text = String(raw).trim();
      if (text && !text.startsWith("data:image/")) {
        throw new DomainError(`「${field.name}」签字需为图片数据`);
      }
      return { fields, fieldId: field.id, stored: text || null, type: field.type, name: field.name };
    }

    if (field.type === "url" || field.type === "text" || field.type === "long_text" || field.type === "created_by") {
      const text = String(raw);
      if ((field.type === "text" || field.type === "long_text") && text.length > LIMITS.textMaxLen) {
        throw new DomainError(`「${field.name}」字数不超过 ${LIMITS.textMaxLen}`);
      }
      return { fields, fieldId: field.id, stored: text, type: field.type, name: field.name };
    }

    return { fields, fieldId: field.id, stored: String(raw), type: field.type, name: field.name };
  }

  private async ensureOptions(
    field: Field,
    names: string[],
  ): Promise<{ fields: Field[]; ids: string[] }> {
    const options = [...(field.config.options ?? [])];
    let changed = false;
    const ids = names.map((name) => {
      const found = options.find((option) => option.id === name || option.name === name);
      if (found) return found.id;
      const created: SelectOption = {
        id: nid("o"),
        name,
        color: TAG_COLORS[options.length % TAG_COLORS.length],
      };
      options.push(created);
      changed = true;
      return created.id;
    });
    if (!changed) return { fields: await this.listFields(field.tableId), ids };
    if (options.length > LIMITS.optionsPerSelect) {
      throw new DomainError(`单选/多选最多 ${LIMITS.optionsPerSelect} 个选项`);
    }
    await this.db.execute({
      sql: "UPDATE fields SET config = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify({ ...field.config, options }), Date.now(), field.id],
    });
    return { fields: await this.listFields(field.tableId), ids };
  }

  private async toPublic(
    record: RawRecord,
    fields: Field[],
    formulaCtx?: { tables?: Record<string, Array<Record<string, DisplayValue>>> },
  ): Promise<PublicRecord> {
    const display: Record<string, DisplayValue> = {};
    for (const field of fields) {
      if (field.type === "formula" || field.type === "lookup") continue;
      display[field.name] = await this.displayValue(field, record);
    }
    for (const field of fields) {
      if (field.type === "lookup") {
        display[field.name] = await this.resolveLookup(field, record);
      }
    }
    for (const field of fields) {
      if (field.type !== "formula") continue;
      display[field.name] = evalFormulaCached(
        field.config.formula ?? "",
        display,
        {
          recordId: record.id,
          fieldId: field.id,
          updatedAt: record.updatedAt,
        },
        formulaCtx,
      );
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fields: display,
    };
  }

  private async formulaContextForTable(tableId: string): Promise<{ tables: Record<string, Array<Record<string, DisplayValue>>> } | undefined> {
    const fields = await this.listFields(tableId);
    const needsCross = fields.some(
      (field) => field.type === "formula" && /TABLE(SUM|COUNT|ROWS)\s*\(/i.test(field.config.formula ?? ""),
    );
    if (!needsCross) return undefined;
    const table = await this.requireTable(tableId);
    const bases = await this.listBases();
    const base = bases.find((item) => item.id === table.baseId);
    const tables: Record<string, Array<Record<string, DisplayValue>>> = {};
    for (const summary of base?.tables ?? []) {
      const peerFields = await this.listFields(summary.id);
      const peerRecords = await this.listRawRecords(summary.id);
      const rows: Array<Record<string, DisplayValue>> = [];
      for (const peer of peerRecords) {
        const row: Record<string, DisplayValue> = {};
        for (const field of peerFields) {
          if (field.type === "formula" || field.type === "lookup") continue;
          row[field.name] = await this.displayValue(field, peer);
        }
        rows.push(row);
      }
      tables[summary.name] = rows;
    }
    return { tables };
  }

  private async resolveLookup(field: Field, record: RawRecord): Promise<DisplayValue> {
    const linkField = (await this.listFields(field.tableId)).find((item) => item.id === field.config.lookupLinkFieldId);
    if (!linkField || !LINK_TYPES.has(linkField.type) || !linkField.config.linkTableId) return null;
    const stored = record.values[linkField.id];
    if (!Array.isArray(stored) || stored.length === 0) return null;
    const targetFields = await this.listFields(linkField.config.linkTableId);
    const target = targetFields.find((item) => item.id === field.config.lookupTargetFieldId);
    if (!target) return null;
    const values: string[] = [];
    for (const id of stored.map(String)) {
      const linked = await this.requireRecord(id).catch(() => null);
      if (!linked) continue;
      const value = await this.displayValue(target, linked);
      const text = displayText(value);
      if (text) values.push(text);
    }
    return values.length ? values : null;
  }

  private async syncDuplexLinks(
    recordId: string,
    field: Field,
    nextIds: string[],
    previousIds: string[],
  ): Promise<void> {
    if (!field.config.symmetricFieldId || !field.config.linkTableId) return;
    const peerField = await this.requireField(field.config.symmetricFieldId);
    const added = nextIds.filter((id) => !previousIds.includes(id));
    const removed = previousIds.filter((id) => !nextIds.includes(id));
    for (const peerId of added) {
      const peer = await this.requireRecord(peerId);
      const current = Array.isArray(peer.values[peerField.id])
        ? (peer.values[peerField.id] as unknown[]).map(String)
        : [];
      if (current.includes(recordId)) continue;
      const values = { ...peer.values, [peerField.id]: [...current, recordId] };
      await this.writeValues(peerId, values, Date.now());
    }
    for (const peerId of removed) {
      const peer = await this.requireRecord(peerId).catch(() => null);
      if (!peer) continue;
      const current = Array.isArray(peer.values[peerField.id])
        ? (peer.values[peerField.id] as unknown[]).map(String)
        : [];
      const values = { ...peer.values, [peerField.id]: current.filter((id) => id !== recordId) };
      if ((values[peerField.id] as string[]).length === 0) delete values[peerField.id];
      await this.writeValues(peerId, values, Date.now());
    }
  }

  private async displayValue(field: Field, record: RawRecord): Promise<DisplayValue> {
    const stored = record.values[field.id];
    if (field.type === "created_time") return formatTs(record.createdAt);
    if (field.type === "updated_time") return formatTs(record.updatedAt);
    if (field.type === "checkbox") return stored === true;
    if (stored == null || stored === "") return null;
    if (field.type === "single_select") {
      const option = field.config.options?.find((item) => item.id === stored);
      return option?.name ?? null;
    }
    if (field.type === "multi_select") {
      if (!Array.isArray(stored)) return null;
      const names = stored
        .map((id) => field.config.options?.find((item) => item.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length ? names : null;
    }
    if (field.type === "person" || field.type === "group") {
      return Array.isArray(stored) ? stored.map(String) : toNameList(stored);
    }
    if (field.type === "link" || field.type === "duplex_link") {
      if (!Array.isArray(stored) || !field.config.linkTableId) return null;
      const titles: string[] = [];
      const linkFields = await this.listFields(field.config.linkTableId);
      const titleField = linkFields.find((item) => item.type === "text" || item.type === "long_text") ?? linkFields[0];
      for (const id of stored.map(String)) {
        const linked = await this.requireRecord(id).catch(() => null);
        if (!linked) continue;
        if (!titleField) {
          titles.push(id);
          continue;
        }
        const label = await this.displayValue(titleField, linked);
        titles.push(displayText(label) || id);
      }
      return titles.length ? titles : null;
    }
    if (field.type === "attachment") {
      if (!Array.isArray(stored)) return null;
      return stored as AttachmentMeta[];
    }
    if (field.type === "geolocation") {
      return parseGeoPoint(stored);
    }
    if (field.type === "signature") {
      return typeof stored === "string" ? stored : null;
    }
    if (field.type === "button") {
      return field.config.buttonLabel ?? "执行";
    }
    if (field.type === "barcode") {
      return typeof stored === "string" ? stored : String(stored);
    }
    if (
      field.type === "number" ||
      field.type === "currency" ||
      field.type === "rating" ||
      field.type === "progress"
    ) {
      return typeof stored === "number" ? stored : Number(stored);
    }
    if (typeof stored === "string" || typeof stored === "number" || typeof stored === "boolean") return stored;
    return String(stored);
  }

  private resolveField(fields: Field[], key: string): Field {
    const byId = fields.find((field) => field.id === key);
    if (byId) return byId;
    const byName = fields.filter((field) => field.name === key);
    if (byName.length === 1) return byName[0];
    if (byName.length === 0) throw new DomainError(`找不到字段：${key}`);
    throw new DomainError(`字段名不唯一：${key}`);
  }

  private async nextAutoNumber(field: Field): Promise<string> {
    const result = await this.db.execute({
      sql: "SELECT next_value FROM auto_counters WHERE field_id = ?",
      args: [field.id],
    });
    let next = asNumber(result.rows[0]?.next_value);
    if (!result.rows[0]) {
      next = 1;
      await this.db.execute({
        sql: "INSERT INTO auto_counters (field_id, next_value) VALUES (?, 2)",
        args: [field.id],
      });
    } else {
      await this.db.execute({
        sql: "UPDATE auto_counters SET next_value = ? WHERE field_id = ?",
        args: [next + 1, field.id],
      });
    }
    const prefix = field.config.prefix ?? "";
    return `${prefix}${next}`;
  }

  private async appendHistory(input: {
    recordId: string;
    tableId: string;
    userId?: string;
    userName?: string;
    action: string;
    patch: Record<string, unknown>;
  }): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO record_history (id, record_id, table_id, user_id, user_name, action, patch_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        nid("h"),
        input.recordId,
        input.tableId,
        input.userId ?? null,
        input.userName ?? null,
        input.action,
        JSON.stringify(input.patch),
        Date.now(),
      ],
    });
  }

  private async runAutomations(
    tableId: string,
    event: "record_created" | "record_updated",
    record: RawRecord,
    fields: Field[],
    ctx: { changedFieldIds: string[]; before: RawRecord } | null,
    meta?: { userId?: string; userName?: string },
  ): Promise<void> {
    const autos = await this.listAutomations(tableId);
    for (const auto of autos) {
      if (!auto.enabled) continue;
      const trigger = auto.trigger;
      let hit = false;
      if (event === "record_created" && trigger.type === "record_created") hit = true;
      if (event === "record_updated" && trigger.type === "record_updated") {
        if (!trigger.fieldId) hit = true;
        else if (ctx?.changedFieldIds.includes(trigger.fieldId)) hit = true;
      }
      if (trigger.type === "field_equals") {
        const field = fields.find((item) => item.id === trigger.fieldId);
        if (field) {
          const value = await this.displayValue(field, record);
          if (displayText(value) === trigger.value) hit = true;
        }
      }
      if (!hit) continue;
      if (auto.conditions.length) {
        const publicRec = await this.toPublic(record, fields);
        const ok = auto.conditions.every((condition) => {
          const field = fields.find((item) => item.id === condition.fieldId);
          if (!field) return false;
          return matchesCondition(publicRec.fields[field.name], condition);
        });
        if (!ok) continue;
      }
      for (const action of auto.actions) {
        await this.applyAutomationAction(tableId, record, fields, action, meta);
      }
    }
  }

  private async applyAutomationAction(
    tableId: string,
    record: RawRecord,
    fields: Field[],
    action: AutomationAction,
    meta?: { userId?: string; userName?: string },
  ): Promise<void> {
    if (action.type === "set_field") {
      const field = fields.find((item) => item.id === action.fieldId);
      if (!field || SYSTEM_SET.has(field.type)) return;
      const resolved = await this.writeFieldValue(fields, field.id, action.value);
      const values = { ...record.values };
      if (resolved.stored == null) delete values[resolved.fieldId];
      else values[resolved.fieldId] = resolved.stored;
      const updatedAt = Date.now();
      await this.writeValues(record.id, values, updatedAt);
      record.values = values;
      record.updatedAt = updatedAt;
      return;
    }
    if (action.type === "create_record") {
      await this.createRecord(tableId, action.fields, { skipAutomation: true });
      return;
    }
    if (action.type === "add_comment") {
      await this.addComment(
        record.id,
        meta?.userId ?? "system",
        meta?.userName ?? "自动化",
        action.body.replaceAll("{recordId}", record.id),
      );
      return;
    }
    if (action.type === "notify") {
      const table = await this.requireTable(tableId);
      const userId = action.userId ?? meta?.userId;
      if (!userId) return;
      await this.createNotification({
        userId,
        baseId: table.baseId,
        tableId,
        recordId: record.id,
        message: action.message,
      });
      return;
    }
    if (action.type === "http_request") {
      const method = action.method ?? "POST";
      const url = await this.interpolateAutomationText(action.url, record, fields);
      const headers = { "content-type": "application/json", ...(action.headers ?? {}) };
      const body =
        method === "GET"
          ? undefined
          : await this.interpolateAutomationText(action.body ?? JSON.stringify({ recordId: record.id, tableId }), record, fields);
      try {
        await fetch(url, { method, headers, body });
      } catch (error) {
        console.error("automation http_request failed", error);
      }
      return;
    }
    if (action.type === "send_email") {
      try {
        const { sendMail, smtpConfigured } = await import("./mailer.js");
        if (!smtpConfigured()) {
          console.warn("automation send_email skipped: SMTP not configured");
          return;
        }
        await sendMail({
          to: await this.interpolateAutomationText(action.to, record, fields),
          subject: await this.interpolateAutomationText(action.subject, record, fields),
          text: await this.interpolateAutomationText(action.text, record, fields),
        });
      } catch (error) {
        console.error("automation send_email failed", error);
      }
      return;
    }
    if (action.type === "feishu_bot") {
      const table = await this.requireTable(tableId);
      const webhook = action.webhookUrl || (await this.getBaseSettings(table.baseId)).integrations.feishuWebhookUrl;
      if (!webhook) {
        console.warn("automation feishu_bot skipped: no webhook");
        return;
      }
      const text = await this.interpolateAutomationText(action.text, record, fields);
      const result = await sendFeishuText(webhook, text);
      if (!result.ok) console.error("automation feishu_bot failed", result.message);
      return;
    }
    if (action.type === "feishu_digest") {
      await this.sendFeishuDigest(tableId, action);
    }
  }

  async runWebhookAutomation(
    automationId: string,
    secret: string | undefined,
    payload: { recordId?: string },
  ): Promise<{ ok: true; ran: boolean }> {
    const auto = await this.requireAutomation(automationId);
    if (!auto.enabled) return { ok: true, ran: false };
    if (auto.trigger.type !== "webhook") throw new DomainError("该自动化不是 Webhook 触发", 400);
    if (auto.trigger.secret && auto.trigger.secret !== secret) throw new DomainError("Webhook 密钥不正确", 401);
    const fields = await this.listFields(auto.tableId);
    let record: RawRecord | null = null;
    if (payload.recordId) record = await this.requireRecord(payload.recordId);
    else {
      const table = await this.getTable(auto.tableId);
      const first = table.records[0];
      if (first) record = await this.requireRecord(first.id);
    }
    if (!record) throw new DomainError("没有可执行的记录", 400);
    if (auto.conditions.length) {
      const publicRec = await this.toPublic(record, fields);
      const ok = auto.conditions.every((condition) => {
        const field = fields.find((item) => item.id === condition.fieldId);
        if (!field) return false;
        return matchesCondition(publicRec.fields[field.name], condition);
      });
      if (!ok) return { ok: true, ran: false };
    }
    for (const action of auto.actions) {
      await this.applyAutomationAction(auto.tableId, record, fields, action, { userId: "system", userName: "Webhook" });
    }
    await this.touchAutomationRun(automationId);
    return { ok: true, ran: true };
  }

  async runButtonAutomations(
    tableId: string,
    fieldId: string,
    record: RawRecord,
    fields: Field[],
    meta?: { userId?: string; userName?: string },
  ): Promise<void> {
    const autos = await this.listAutomations(tableId);
    for (const auto of autos) {
      if (!auto.enabled || auto.trigger.type !== "button" || auto.trigger.fieldId !== fieldId) continue;
      if (auto.conditions.length) {
        const publicRec = await this.toPublic(record, fields);
        const ok = auto.conditions.every((condition) => {
          const field = fields.find((item) => item.id === condition.fieldId);
          if (!field) return false;
          return matchesCondition(publicRec.fields[field.name], condition);
        });
        if (!ok) continue;
      }
      for (const action of auto.actions) {
        await this.applyAutomationAction(tableId, record, fields, action, meta);
      }
      await this.touchAutomationRun(auto.id);
    }
  }

  async runDueSchedules(now = Date.now()): Promise<number> {
    const result = await this.db.execute("SELECT * FROM automations WHERE enabled = 1");
    let ran = 0;
    for (const row of result.rows) {
      const trigger = parseJson<AutomationTrigger>(row.trigger_json, { type: "record_created" });
      if (trigger.type !== "schedule") continue;
      const last = asNumber(row.last_run_at ?? 0);
      if (!shouldRunSchedule(trigger.cron, last, now)) continue;
      const autoId = asString(row.id);
      const tableId = asString(row.table_id);
      const fields = await this.listFields(tableId);
      const table = await this.getTable(tableId);
      const actions = parseJson<AutomationAction[]>(row.actions_json, []);
      const digestOnly = actions.length > 0 && actions.every((item) => item.type === "feishu_digest");
      const record = table.records[0] ? await this.requireRecord(table.records[0].id) : null;
      if (!record && !digestOnly) {
        await this.touchAutomationRun(autoId, now);
        continue;
      }
      for (const action of actions) {
        if (action.type === "feishu_digest") {
          await this.sendFeishuDigest(tableId, action);
          continue;
        }
        if (!record) continue;
        await this.applyAutomationAction(tableId, record, fields, action, { userId: "system", userName: "定时" });
      }
      await this.touchAutomationRun(autoId, now);
      ran += 1;
    }
    return ran;
  }

  private async requireAutomation(automationId: string): Promise<Automation> {
    const result = await this.db.execute({ sql: "SELECT * FROM automations WHERE id = ?", args: [automationId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到自动化", 404);
    return {
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      enabled: asNumber(row.enabled) === 1,
      trigger: parseJson<AutomationTrigger>(row.trigger_json, { type: "record_created" }),
      conditions: parseJson<AutomationCondition[]>(row.conditions_json, []),
      actions: parseJson<AutomationAction[]>(row.actions_json, []),
      createdAt: asNumber(row.created_at),
    };
  }

  private async touchAutomationRun(automationId: string, at = Date.now()): Promise<void> {
    try {
      await this.db.execute({ sql: "UPDATE automations SET last_run_at = ? WHERE id = ?", args: [at, automationId] });
    } catch {
      /* column may not exist yet on very old DBs */
    }
  }

  async exportCsv(tableId: string): Promise<string> {
    const table = await this.getTable(tableId);
    const headers = table.fields.map((field) => field.name);
    const lines = [csvLine(headers)];
    for (const record of table.records) {
      lines.push(csvLine(headers.map((name) => displayText(record.fields[name]))));
    }
    return lines.join("\n");
  }

  private async interpolateAutomationText(template: string, record: RawRecord, fields: Field[]): Promise<string> {
    const publicRec = await this.toPublic(record, fields);
    let text = template
      .replaceAll("{recordId}", record.id)
      .replaceAll("{tableId}", record.tableId)
      .replaceAll("{updatedAt}", String(record.updatedAt));
    for (const field of fields) {
      text = text.replaceAll(`{${field.name}}`, displayText(publicRec.fields[field.name]));
    }
    return text;
  }

  async sendFeishuDigest(
    tableId: string,
    action: Extract<AutomationAction, { type: "feishu_digest" }>,
  ): Promise<{ sent: boolean; count: number }> {
    const table = await this.requireTable(tableId);
    const webhook = action.webhookUrl || (await this.getBaseSettings(table.baseId)).integrations.feishuWebhookUrl;
    if (!webhook) return { sent: false, count: 0 };
    const payload = await this.getTable(tableId);
    const dateField =
      (action.dateField
        ? payload.fields.find((item) => item.id === action.dateField || item.name === action.dateField)
        : payload.fields.find((item) => item.name === "截止日期") ?? payload.fields.find((item) => item.type === "date")) ??
      null;
    const statusField = payload.fields.find((item) => item.name === "状态");
    const titleField = payload.fields.find((item) => item.name === "标题") ?? payload.fields.find((item) => item.type === "text");
    const excluded = new Set((action.excludeStatuses ?? ["已完成", "已搁置"]).map((item) => item.trim()).filter(Boolean));
    const daysAhead = Math.max(0, Math.min(action.daysAhead ?? 2, 30));
    const today = localYmd(new Date());
    const until = addDaysYmd(today, daysAhead);
    const due = payload.records.filter((record) => {
      if (statusField && excluded.has(displayText(record.fields[statusField.name]))) return false;
      if (!dateField) return true;
      const date = displayText(record.fields[dateField.name]);
      return Boolean(date) && date >= today && date <= until;
    });
    const lines = due.map((record) => {
      const title = titleField ? displayText(record.fields[titleField.name]) : record.id;
      const date = dateField ? displayText(record.fields[dateField.name]) : "";
      const domain = displayText(record.fields["领域"]);
      const status = statusField ? displayText(record.fields[statusField.name]) : "";
      return `• ${title}${date ? `（${date}）` : ""}${domain ? ` · ${domain}` : ""}${status ? ` · ${status}` : ""}`;
    });
    const header = action.text?.trim() || `【待办摘要】${today} 起 ${daysAhead} 天内 ${due.length} 项`;
    const text = [header, ...lines].join("\n") || header;
    const result = await sendFeishuText(webhook, text);
    if (!result.ok) console.error("feishu digest failed", result.message);
    return { sent: result.ok, count: due.length };
  }

  async exportIcs(tableId: string, opts?: { dateFieldId?: string; titleFieldId?: string }): Promise<string> {
    const table = await this.getTable(tableId);
    const dateField =
      (opts?.dateFieldId ? table.fields.find((item) => item.id === opts.dateFieldId) : null) ??
      table.fields.find((item) => item.name === "截止日期") ??
      table.fields.find((item) => item.type === "date");
    if (!dateField || dateField.type !== "date") throw new DomainError("该表没有日期字段，无法导出日历");
    const titleField =
      (opts?.titleFieldId ? table.fields.find((item) => item.id === opts.titleFieldId) : null) ??
      table.fields.find((item) => item.name === "标题") ??
      table.fields.find((item) => item.type === "text") ??
      table.fields[0];
    const events = table.records
      .map((record) => {
        const date = displayText(record.fields[dateField.name]);
        if (!date) return null;
        const title = titleField ? displayText(record.fields[titleField.name]) : record.id;
        const extra = ["领域", "状态", "优先级", "说明"]
          .map((name) => {
            const value = displayText(record.fields[name]);
            return value ? `${name}：${value}` : "";
          })
          .filter(Boolean)
          .join("\n");
        return { uid: `${record.id}@duowei`, title, date, description: extra, updatedAt: Date.now() };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return buildIcsCalendar({ name: table.name, events });
  }

  async createCalendarFeed(tableId: string, input?: { dateFieldId?: string; titleFieldId?: string }): Promise<CalendarFeed> {
    await this.requireTable(tableId);
    const fields = await this.listFields(tableId);
    const dateField = input?.dateFieldId
      ? this.resolveField(fields, input.dateFieldId)
      : fields.find((item) => item.name === "截止日期") ?? fields.find((item) => item.type === "date");
    if (!dateField || dateField.type !== "date") throw new DomainError("日历订阅需要日期字段");
    const titleField = input?.titleFieldId ? this.resolveField(fields, input.titleFieldId) : fields.find((item) => item.name === "标题") ?? null;
    const feed: CalendarFeed = {
      id: nid("cal"),
      tableId,
      token: nid("calfeed"),
      dateFieldId: dateField.id,
      titleFieldId: titleField?.id ?? null,
      enabled: true,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO calendar_feeds (id, table_id, token, date_field_id, title_field_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
      args: [feed.id, tableId, feed.token, feed.dateFieldId, feed.titleFieldId, feed.createdAt],
    });
    return feed;
  }

  async listCalendarFeeds(tableId: string): Promise<CalendarFeed[]> {
    await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT * FROM calendar_feeds WHERE table_id = ? ORDER BY created_at DESC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      tableId: asString(row.table_id),
      token: asString(row.token),
      dateFieldId: asString(row.date_field_id) || null,
      titleFieldId: asString(row.title_field_id) || null,
      enabled: asNumber(row.enabled) === 1,
      createdAt: asNumber(row.created_at),
    }));
  }

  async getCalendarFeedByToken(token: string): Promise<CalendarFeed | null> {
    const result = await this.db.execute({ sql: "SELECT * FROM calendar_feeds WHERE token = ?", args: [token] });
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: asString(row.id),
      tableId: asString(row.table_id),
      token: asString(row.token),
      dateFieldId: asString(row.date_field_id) || null,
      titleFieldId: asString(row.title_field_id) || null,
      enabled: asNumber(row.enabled) === 1,
      createdAt: asNumber(row.created_at),
    };
  }

  async requireCalendarFeed(feedId: string): Promise<CalendarFeed> {
    const result = await this.db.execute({ sql: "SELECT * FROM calendar_feeds WHERE id = ?", args: [feedId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到日历订阅", 404);
    return {
      id: asString(row.id),
      tableId: asString(row.table_id),
      token: asString(row.token),
      dateFieldId: asString(row.date_field_id) || null,
      titleFieldId: asString(row.title_field_id) || null,
      enabled: asNumber(row.enabled) === 1,
      createdAt: asNumber(row.created_at),
    };
  }

  async deleteCalendarFeed(feedId: string): Promise<void> {
    await this.requireCalendarFeed(feedId);
    await this.db.execute({ sql: "DELETE FROM calendar_feeds WHERE id = ?", args: [feedId] });
  }

  async importCsv(
    tableId: string,
    csv: string,
    meta?: { userId?: string; userName?: string },
  ): Promise<{ imported: number }> {
    const rows = parseCsv(csv);
    if (rows.length < 2) return { imported: 0 };
    const headers = rows[0].map((item) => item.trim()).filter(Boolean);
    let imported = 0;
    for (const row of rows.slice(1)) {
      if (row.every((cell) => !cell.trim())) continue;
      const fields: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        fields[header] = row[index] ?? "";
      });
      await this.createRecord(tableId, fields, meta);
      imported += 1;
    }
    return { imported };
  }

  async listComments(recordId: string): Promise<Comment[]> {
    await this.requireRecord(recordId);
    const result = await this.db.execute({
      sql: "SELECT * FROM comments WHERE record_id = ? ORDER BY created_at ASC",
      args: [recordId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      recordId: asString(row.record_id),
      userId: asString(row.user_id),
      userName: asString(row.user_name),
      body: asString(row.body),
      createdAt: asNumber(row.created_at),
    }));
  }

  async addComment(recordId: string, userId: string, userName: string, body: string): Promise<Comment> {
    await this.requireRecord(recordId);
    const text = body.trim();
    if (!text) throw new DomainError("评论不能为空");
    if (text.length > 4000) throw new DomainError("评论过长");
    const comment: Comment = {
      id: nid("c"),
      recordId,
      userId,
      userName,
      body: text,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO comments (id, record_id, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [comment.id, recordId, userId, userName, text, comment.createdAt],
    });
    return comment;
  }

  async deleteComment(commentId: string, actor: { userId: string; isAdmin: boolean }): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [commentId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到评论", 404);
    if (!actor.isAdmin && asString(row.user_id) !== actor.userId) throw new DomainError("没有权限", 403);
    await this.db.execute({ sql: "DELETE FROM comments WHERE id = ?", args: [commentId] });
  }

  async getTableAcl(tableId: string): Promise<TableAcl> {
    await this.requireTable(tableId);
    const result = await this.db.execute({ sql: "SELECT * FROM table_acls WHERE table_id = ?", args: [tableId] });
    const row = result.rows[0];
    if (!row) return { tableId, rowAllow: {}, columnDeny: {}, rowRules: {} };
    return {
      tableId,
      rowAllow: parseJson<Record<string, string[]>>(row.row_allow, {}),
      columnDeny: parseJson<Record<string, string[]>>(row.column_deny, {}),
      rowRules: parseJson<Record<string, RowAccessRule>>(row.row_rules ?? "{}", {}),
    };
  }

  async setTableAcl(tableId: string, acl: Omit<TableAcl, "tableId">): Promise<TableAcl> {
    await this.requireTable(tableId);
    await this.db.execute({
      sql: `INSERT INTO table_acls (table_id, row_allow, column_deny, row_rules) VALUES (?, ?, ?, ?)
            ON CONFLICT(table_id) DO UPDATE SET
              row_allow = excluded.row_allow,
              column_deny = excluded.column_deny,
              row_rules = excluded.row_rules`,
      args: [
        tableId,
        JSON.stringify(acl.rowAllow ?? {}),
        JSON.stringify(acl.columnDeny ?? {}),
        JSON.stringify(acl.rowRules ?? {}),
      ],
    });
    return { tableId, rowAllow: acl.rowAllow ?? {}, columnDeny: acl.columnDeny ?? {}, rowRules: acl.rowRules ?? {} };
  }

  async applyAclToPayload(
    payload: TablePayload,
    actor: { userId: string; name?: string; email?: string },
    acl: TableAcl,
  ): Promise<TablePayload> {
    const userId = actor.userId;
    const denied = new Set(acl.columnDeny?.[userId] ?? []);
    const rule = acl.rowRules?.[userId];
    const legacyIds = acl.rowAllow?.[userId];

    let records = payload.records;
    if (rule) {
      records = await this.filterRecordsByRule(payload, records, rule, actor);
    } else if (legacyIds && legacyIds.length > 0) {
      const set = new Set(legacyIds);
      records = records.filter((record) => set.has(record.id));
    }

    const fields = payload.fields.filter((field) => !denied.has(field.id));
    const fieldNames = new Set(fields.map((field) => field.name));
    records = records.map((record) => ({
      ...record,
      fields: Object.fromEntries(Object.entries(record.fields).filter(([name]) => fieldNames.has(name))),
    }));
    return { ...payload, fields, records };
  }

  async previewAcl(
    tableId: string,
    targetUserId: string,
    actorProfile?: { name?: string; email?: string },
  ): Promise<{ total: number; visible: number; hiddenFieldIds: string[]; sampleIds: string[] }> {
    const payload = await this.getTable(tableId);
    const acl = await this.getTableAcl(tableId);
    const filtered = await this.applyAclToPayload(payload, { userId: targetUserId, ...actorProfile }, acl);
    return {
      total: payload.records.length,
      visible: filtered.records.length,
      hiddenFieldIds: acl.columnDeny?.[targetUserId] ?? [],
      sampleIds: filtered.records.slice(0, 20).map((record) => record.id),
    };
  }

  private async filterRecordsByRule(
    payload: TablePayload,
    records: PublicRecord[],
    rule: RowAccessRule,
    actor: { userId: string; name?: string; email?: string },
  ): Promise<PublicRecord[]> {
    if (rule.type === "all") return records;
    if (rule.type === "allow_ids") {
      const set = new Set(rule.recordIds);
      return records.filter((record) => set.has(record.id));
    }
    if (rule.type === "created_by") {
      const creatorByRecord = await this.creatorIdsForRecords(records.map((record) => record.id));
      const aliases = new Set(
        [actor.userId, actor.name, actor.email].filter((item): item is string => Boolean(item)).map((item) => item.toLowerCase()),
      );
      const createdByField = payload.fields.find((field) => field.type === "created_by");
      return records.filter((record) => {
        const fromHistory = creatorByRecord.get(record.id);
        if (fromHistory && aliases.has(fromHistory.toLowerCase())) return true;
        if (createdByField) {
          const value = displayText(record.fields[createdByField.name]).toLowerCase();
          if (value && aliases.has(value)) return true;
        }
        return false;
      });
    }
    if (rule.type === "person_in") {
      const field = payload.fields.find((item) => item.id === rule.fieldId);
      if (!field) return [];
      const aliases = new Set(
        [actor.userId, actor.name, actor.email].filter((item): item is string => Boolean(item)).map((item) => item.toLowerCase()),
      );
      return records.filter((record) => {
        const raw = record.fields[field.name];
        const names = Array.isArray(raw)
          ? raw.map((item) => (typeof item === "string" ? item : item.name).toLowerCase())
          : [displayText(raw).toLowerCase()].filter(Boolean);
        return names.some((name) => aliases.has(name));
      });
    }
    if (rule.type === "field_equals") {
      const field = payload.fields.find((item) => item.id === rule.fieldId);
      if (!field) return [];
      return records.filter((record) => displayText(record.fields[field.name]) === rule.value);
    }
    if (rule.type === "field_in") {
      const field = payload.fields.find((item) => item.id === rule.fieldId);
      if (!field) return [];
      const allowed = new Set(rule.values.map(String));
      return records.filter((record) => {
        const raw = record.fields[field.name];
        if (Array.isArray(raw)) {
          return raw.some((item) => allowed.has(typeof item === "string" ? item : String(item)));
        }
        return allowed.has(displayText(raw));
      });
    }
    return records;
  }

  private async creatorIdsForRecords(recordIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!recordIds.length) return map;
    const placeholders = recordIds.map(() => "?").join(",");
    const result = await this.db.execute({
      sql: `SELECT record_id, user_id FROM record_history
            WHERE action = 'create' AND record_id IN (${placeholders})
            ORDER BY created_at ASC`,
      args: recordIds,
    });
    for (const row of result.rows) {
      const recordId = asString(row.record_id);
      if (!map.has(recordId) && row.user_id) map.set(recordId, asString(row.user_id));
    }
    return map;
  }

  async listAutomations(tableId: string): Promise<Automation[]> {
    await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT * FROM automations WHERE table_id = ? ORDER BY created_at ASC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      enabled: asNumber(row.enabled) === 1,
      trigger: parseJson<AutomationTrigger>(row.trigger_json, { type: "record_created" }),
      conditions: parseJson<AutomationCondition[]>(row.conditions_json, []),
      actions: parseJson<AutomationAction[]>(row.actions_json, []),
      createdAt: asNumber(row.created_at),
    }));
  }

  async createAutomation(
    tableId: string,
    input: {
      name: string;
      trigger: AutomationTrigger;
      actions: AutomationAction[];
      conditions?: AutomationCondition[];
      enabled?: boolean;
    },
  ): Promise<Automation> {
    await this.requireTable(tableId);
    if (!input.actions.length) throw new DomainError("至少配置一个动作");
    const auto: Automation = {
      id: nid("a"),
      tableId,
      name: cleanName(input.name),
      enabled: input.enabled !== false,
      trigger: input.trigger,
      conditions: input.conditions ?? [],
      actions: input.actions,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO automations (id, table_id, name, enabled, trigger_json, conditions_json, actions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        auto.id,
        tableId,
        auto.name,
        auto.enabled ? 1 : 0,
        JSON.stringify(auto.trigger),
        JSON.stringify(auto.conditions),
        JSON.stringify(auto.actions),
        auto.createdAt,
      ],
    });
    return auto;
  }

  async updateAutomation(
    automationId: string,
    patch: Partial<{
      name: string;
      enabled: boolean;
      trigger: AutomationTrigger;
      actions: AutomationAction[];
      conditions: AutomationCondition[];
    }>,
  ): Promise<Automation> {
    const list = await this.db.execute({ sql: "SELECT * FROM automations WHERE id = ?", args: [automationId] });
    const row = list.rows[0];
    if (!row) throw new DomainError("找不到自动化", 404);
    const current: Automation = {
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      enabled: asNumber(row.enabled) === 1,
      trigger: parseJson<AutomationTrigger>(row.trigger_json, { type: "record_created" }),
      conditions: parseJson<AutomationCondition[]>(row.conditions_json, []),
      actions: parseJson<AutomationAction[]>(row.actions_json, []),
      createdAt: asNumber(row.created_at),
    };
    const next: Automation = {
      ...current,
      name: patch.name != null ? cleanName(patch.name) : current.name,
      enabled: patch.enabled ?? current.enabled,
      trigger: patch.trigger ?? current.trigger,
      actions: patch.actions ?? current.actions,
      conditions: patch.conditions ?? current.conditions,
    };
    await this.db.execute({
      sql: "UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, conditions_json = ?, actions_json = ? WHERE id = ?",
      args: [
        next.name,
        next.enabled ? 1 : 0,
        JSON.stringify(next.trigger),
        JSON.stringify(next.conditions),
        JSON.stringify(next.actions),
        automationId,
      ],
    });
    return next;
  }

  async deleteAutomation(automationId: string): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT id FROM automations WHERE id = ?", args: [automationId] });
    if (!result.rows[0]) throw new DomainError("找不到自动化", 404);
    await this.db.execute({ sql: "DELETE FROM automations WHERE id = ?", args: [automationId] });
  }

  async listHistory(recordId: string): Promise<
    Array<{ id: string; action: string; userName: string | null; patch: Record<string, unknown>; createdAt: number }>
  > {
    await this.requireRecord(recordId);
    const result = await this.db.execute({
      sql: "SELECT * FROM record_history WHERE record_id = ? ORDER BY created_at DESC LIMIT 100",
      args: [recordId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      action: asString(row.action),
      userName: row.user_name == null ? null : asString(row.user_name),
      patch: parseJson<Record<string, unknown>>(row.patch_json, {}),
      createdAt: asNumber(row.created_at),
    }));
  }

  async listDashboards(baseId: string): Promise<Array<{ id: string; name: string; config: DashboardConfig }>> {
    await this.requireBase(baseId);
    const result = await this.db.execute({
      sql: "SELECT * FROM dashboards WHERE base_id = ? ORDER BY created_at ASC",
      args: [baseId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      config: parseJson<DashboardConfig>(row.config_json, { charts: [] }),
    }));
  }

  async createDashboard(baseId: string, name: string, config?: DashboardConfig): Promise<{ id: string; name: string; config: DashboardConfig }> {
    await this.requireBase(baseId);
    const now = Date.now();
    const id = nid("d");
    const resolved = config ?? { charts: [] };
    await this.db.execute({
      sql: "INSERT INTO dashboards (id, base_id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [id, baseId, cleanName(name), JSON.stringify(resolved), now, now],
    });
    return { id, name: cleanName(name), config: resolved };
  }

  async getDashboardData(
    dashboardId: string,
    slicerValues?: Record<string, string[]>,
  ): Promise<{
    id: string;
    name: string;
    charts: Array<{ id: string; title: string; type: string; labels: string[]; values: number[] }>;
    slicers: Array<{ id: string; title: string; tableId: string; fieldId: string; options: string[] }>;
  }> {
    const result = await this.db.execute({ sql: "SELECT * FROM dashboards WHERE id = ?", args: [dashboardId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到仪表盘", 404);
    const config = parseJson<DashboardConfig>(row.config_json, { charts: [] });
    const slicers = [];
    for (const slicer of config.slicers ?? []) {
      const table = await this.getTable(slicer.tableId).catch(() => null);
      const field = table?.fields.find((item) => item.id === slicer.fieldId);
      const options = new Set<string>();
      if (table && field) {
        for (const record of table.records) {
          const text = displayText(record.fields[field.name]);
          if (text) options.add(text);
        }
      }
      slicers.push({
        id: slicer.id,
        title: slicer.title || field?.name || "切片器",
        tableId: slicer.tableId,
        fieldId: slicer.fieldId,
        options: [...options],
      });
    }
    const charts = [];
    for (const chart of config.charts) {
      const table = await this.getTable(chart.tableId).catch(() => null);
      if (!table) {
        charts.push({ id: chart.id, title: chart.title, type: chart.type, labels: [], values: [] });
        continue;
      }
      let records = table.records;
      for (const slicer of config.slicers ?? []) {
        if (slicer.tableId !== chart.tableId) continue;
        const selected = slicerValues?.[slicer.id];
        if (!selected?.length) continue;
        const field = table.fields.find((item) => item.id === slicer.fieldId);
        if (!field) continue;
        const allowed = new Set(selected);
        records = records.filter((record) => allowed.has(displayText(record.fields[field.name]) || "(空)"));
      }
      const field = table.fields.find((item) => item.id === chart.fieldId);
      const counts = new Map<string, number>();
      for (const record of records) {
        const raw = field ? record.fields[field.name] : null;
        const label = displayText(raw) || "(空)";
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const labels = [...counts.keys()];
      charts.push({
        id: chart.id,
        title: chart.title,
        type: chart.type,
        labels,
        values: labels.map((label) => counts.get(label) ?? 0),
      });
    }
    return { id: asString(row.id), name: asString(row.name), charts, slicers };
  }

  async locateComment(commentId: string): Promise<{ baseId: string; tableId: string; recordId: string }> {
    const result = await this.db.execute({ sql: "SELECT * FROM comments WHERE id = ?", args: [commentId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到评论", 404);
    const located = await this.locateRecord(asString(row.record_id));
    return { ...located, recordId: asString(row.record_id) };
  }

  async locateAutomation(automationId: string): Promise<{ baseId: string; tableId: string }> {
    const result = await this.db.execute({ sql: "SELECT * FROM automations WHERE id = ?", args: [automationId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到自动化", 404);
    return this.locateTable(asString(row.table_id));
  }

  async locateDashboard(dashboardId: string): Promise<{ baseId: string }> {
    const result = await this.db.execute({ sql: "SELECT base_id FROM dashboards WHERE id = ?", args: [dashboardId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到仪表盘", 404);
    return { baseId: asString(row.base_id) };
  }

  async updateDashboard(
    dashboardId: string,
    patch: { name?: string; config?: DashboardConfig },
  ): Promise<{ id: string; name: string; config: DashboardConfig }> {
    const result = await this.db.execute({ sql: "SELECT * FROM dashboards WHERE id = ?", args: [dashboardId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到仪表盘", 404);
    const name = patch.name != null ? cleanName(patch.name) : asString(row.name);
    const config = patch.config ?? parseJson<DashboardConfig>(row.config_json, { charts: [] });
    await this.db.execute({
      sql: "UPDATE dashboards SET name = ?, config_json = ?, updated_at = ? WHERE id = ?",
      args: [name, JSON.stringify(config), Date.now(), dashboardId],
    });
    return { id: dashboardId, name, config };
  }

  async getBaseSettings(baseId: string): Promise<{ timezone: string; portal: AppPortalConfig; integrations: BaseIntegrations }> {
    await this.requireBase(baseId);
    const result = await this.db.execute({ sql: "SELECT * FROM base_settings WHERE base_id = ?", args: [baseId] });
    const row = result.rows[0];
    if (!row) {
      await this.db.execute({
        sql: "INSERT INTO base_settings (base_id, timezone, portal_json, integrations_json) VALUES (?, 'Asia/Shanghai', '{}', '{}')",
        args: [baseId],
      });
      return { timezone: "Asia/Shanghai", portal: {}, integrations: {} };
    }
    return {
      timezone: asString(row.timezone) || "Asia/Shanghai",
      portal: parseJson<AppPortalConfig>(row.portal_json, {}),
      integrations: parseJson<BaseIntegrations>(row.integrations_json, {}),
    };
  }

  async updateBaseSettings(
    baseId: string,
    patch: { timezone?: string; portal?: AppPortalConfig; integrations?: BaseIntegrations },
  ): Promise<{ timezone: string; portal: AppPortalConfig; integrations: BaseIntegrations }> {
    const current = await this.getBaseSettings(baseId);
    const next = {
      timezone: patch.timezone?.trim() || current.timezone,
      portal: patch.portal ?? current.portal,
      integrations: patch.integrations
        ? {
            feishuWebhookUrl: patch.integrations.feishuWebhookUrl?.trim() || undefined,
          }
        : current.integrations,
    };
    if (next.integrations.feishuWebhookUrl && !normalizeFeishuWebhook(next.integrations.feishuWebhookUrl)) {
      throw new DomainError("请填写有效的飞书自定义机器人 Webhook（open.feishu.cn 或 larksuite.com）");
    }
    await this.db.execute({
      sql: `INSERT INTO base_settings (base_id, timezone, portal_json, integrations_json) VALUES (?, ?, ?, ?)
            ON CONFLICT(base_id) DO UPDATE SET timezone = excluded.timezone, portal_json = excluded.portal_json, integrations_json = excluded.integrations_json`,
      args: [baseId, next.timezone, JSON.stringify(next.portal), JSON.stringify(next.integrations)],
    });
    return next;
  }

  async watchRecord(userId: string, recordId: string): Promise<void> {
    await this.requireRecord(recordId);
    await this.db.execute({
      sql: "INSERT OR IGNORE INTO record_watches (user_id, record_id, created_at) VALUES (?, ?, ?)",
      args: [userId, recordId, Date.now()],
    });
  }

  async unwatchRecord(userId: string, recordId: string): Promise<void> {
    await this.db.execute({
      sql: "DELETE FROM record_watches WHERE user_id = ? AND record_id = ?",
      args: [userId, recordId],
    });
  }

  async listWatchedRecords(userId: string): Promise<string[]> {
    const result = await this.db.execute({
      sql: "SELECT record_id FROM record_watches WHERE user_id = ? ORDER BY created_at DESC",
      args: [userId],
    });
    return result.rows.map((row) => asString(row.record_id));
  }

  async isWatching(userId: string, recordId: string): Promise<boolean> {
    const result = await this.db.execute({
      sql: "SELECT 1 FROM record_watches WHERE user_id = ? AND record_id = ?",
      args: [userId, recordId],
    });
    return Boolean(result.rows[0]);
  }

  private async notifyWatchers(recordId: string, tableId: string, actorName: string, message: string): Promise<void> {
    const table = await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT user_id FROM record_watches WHERE record_id = ?",
      args: [recordId],
    });
    for (const row of result.rows) {
      await this.createNotification({
        userId: asString(row.user_id),
        baseId: table.baseId,
        tableId,
        recordId,
        message: `${actorName}${message}`,
      });
    }
  }

  async createNotification(input: {
    userId: string;
    baseId: string;
    tableId: string;
    recordId: string | null;
    message: string;
  }): Promise<Notification> {
    const item: Notification = {
      id: nid("n"),
      userId: input.userId,
      baseId: input.baseId,
      tableId: input.tableId,
      recordId: input.recordId,
      message: input.message,
      read: false,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO notifications (id, user_id, base_id, table_id, record_id, message, read_flag, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      args: [item.id, item.userId, item.baseId, item.tableId, item.recordId, item.message, item.createdAt],
    });
    return item;
  }

  async listNotifications(userId: string): Promise<Notification[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
      args: [userId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      userId: asString(row.user_id),
      baseId: asString(row.base_id),
      tableId: asString(row.table_id),
      recordId: row.record_id == null ? null : asString(row.record_id),
      message: asString(row.message),
      read: asNumber(row.read_flag) === 1,
      createdAt: asNumber(row.created_at),
    }));
  }

  async markNotificationRead(notificationId: string, userId: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE notifications SET read_flag = 1 WHERE id = ? AND user_id = ?",
      args: [notificationId, userId],
    });
  }

  async createShareLink(
    recordId: string,
    createdBy: string,
    expiresInDays?: number,
  ): Promise<{ share: ShareLink; token: string }> {
    const record = await this.requireRecord(recordId);
    const token = `shr_${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = await hashToken(token);
    const share: ShareLink = {
      id: nid("s"),
      recordId,
      tableId: record.tableId,
      token: token.slice(0, 12),
      createdBy,
      createdAt: Date.now(),
      expiresAt: expiresInDays ? Date.now() + expiresInDays * 86400000 : null,
    };
    await this.db.execute({
      sql: "INSERT INTO share_links (id, record_id, table_id, token_hash, token_prefix, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        share.id,
        share.recordId,
        share.tableId,
        tokenHash,
        share.token,
        createdBy,
        share.createdAt,
        share.expiresAt,
      ],
    });
    return { share, token };
  }

  async getSharedRecord(token: string): Promise<{ table: TablePayload; record: PublicRecord }> {
    const tokenHash = await hashToken(token);
    const result = await this.db.execute({
      sql: "SELECT * FROM share_links WHERE token_hash = ?",
      args: [tokenHash],
    });
    const row = result.rows[0];
    if (!row) throw new DomainError("分享链接无效", 404);
    if (row.expires_at != null && asNumber(row.expires_at) < Date.now()) {
      throw new DomainError("分享链接已过期", 410);
    }
    const table = await this.getTable(asString(row.table_id));
    const record = table.records.find((item) => item.id === asString(row.record_id));
    if (!record) throw new DomainError("记录不存在", 404);
    return { table: { ...table, records: [record] }, record };
  }

  async createPublicShare(
    tableId: string,
    input: { kind: PublicShareKind; viewId?: string | null; expiresInDays?: number },
    createdBy: string,
  ): Promise<{ share: PublicShare; token: string }> {
    await this.requireTable(tableId);
    if (input.kind !== "view" && input.kind !== "form") throw new DomainError("不支持的分享类型");
    let viewId: string | null = input.viewId ?? null;
    if (input.kind === "view") {
      const views = await this.listViews(tableId);
      const view = viewId ? views.find((item) => item.id === viewId) : views[0];
      if (!view) throw new DomainError("找不到视图", 404);
      viewId = view.id;
    } else if (viewId) {
      const views = await this.listViews(tableId);
      const view = views.find((item) => item.id === viewId);
      if (!view) throw new DomainError("找不到视图", 404);
      if (view.type !== "form") throw new DomainError("公开表单需指定表单视图");
    } else {
      const views = await this.listViews(tableId);
      const formView = views.find((item) => item.type === "form");
      viewId = formView?.id ?? null;
    }
    const token = `pub_${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = await hashToken(token);
    const share: PublicShare = {
      id: nid("ps"),
      kind: input.kind,
      tableId,
      viewId,
      token: token.slice(0, 12),
      enabled: true,
      createdBy,
      createdAt: Date.now(),
      expiresAt: input.expiresInDays ? Date.now() + input.expiresInDays * 86400000 : null,
    };
    await this.db.execute({
      sql: "INSERT INTO public_shares (id, kind, table_id, view_id, token_hash, token_prefix, enabled, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      args: [
        share.id,
        share.kind,
        share.tableId,
        share.viewId,
        tokenHash,
        share.token,
        createdBy,
        share.createdAt,
        share.expiresAt,
      ],
    });
    return { share, token };
  }

  async listPublicShares(tableId: string): Promise<PublicShare[]> {
    await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT * FROM public_shares WHERE table_id = ? ORDER BY created_at DESC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      kind: asString(row.kind) as PublicShareKind,
      tableId: asString(row.table_id),
      viewId: row.view_id == null ? null : asString(row.view_id),
      token: asString(row.token_prefix),
      enabled: asNumber(row.enabled) === 1,
      createdBy: asString(row.created_by),
      createdAt: asNumber(row.created_at),
      expiresAt: row.expires_at == null ? null : asNumber(row.expires_at),
    }));
  }

  async setPublicShareEnabled(shareId: string, enabled: boolean): Promise<PublicShare> {
    const result = await this.db.execute({ sql: "SELECT * FROM public_shares WHERE id = ?", args: [shareId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到公开分享", 404);
    await this.db.execute({
      sql: "UPDATE public_shares SET enabled = ? WHERE id = ?",
      args: [enabled ? 1 : 0, shareId],
    });
    return {
      id: asString(row.id),
      kind: asString(row.kind) as PublicShareKind,
      tableId: asString(row.table_id),
      viewId: row.view_id == null ? null : asString(row.view_id),
      token: asString(row.token_prefix),
      enabled,
      createdBy: asString(row.created_by),
      createdAt: asNumber(row.created_at),
      expiresAt: row.expires_at == null ? null : asNumber(row.expires_at),
    };
  }

  async deletePublicShare(shareId: string): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT id FROM public_shares WHERE id = ?", args: [shareId] });
    if (!result.rows[0]) throw new DomainError("找不到公开分享", 404);
    await this.db.execute({ sql: "DELETE FROM public_shares WHERE id = ?", args: [shareId] });
  }

  async locatePublicShare(shareId: string): Promise<{ baseId: string; tableId: string }> {
    const result = await this.db.execute({ sql: "SELECT table_id FROM public_shares WHERE id = ?", args: [shareId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到公开分享", 404);
    return this.locateTable(asString(row.table_id));
  }

  async getPublicShare(token: string): Promise<{
    kind: PublicShareKind;
    table: { id: string; name: string; fields: Field[]; views: View[]; records: PublicRecord[] };
    viewId: string | null;
  }> {
    const row = await this.requirePublicShareRow(token);
    const table = await this.getTable(asString(row.table_id), row.view_id ? { viewId: asString(row.view_id) } : undefined);
    const kind = asString(row.kind) as PublicShareKind;
    if (kind === "form") {
      return {
        kind,
        viewId: row.view_id == null ? null : asString(row.view_id),
        table: { ...table, records: [] },
      };
    }
    return {
      kind,
      viewId: row.view_id == null ? null : asString(row.view_id),
      table,
    };
  }

  async submitPublicForm(token: string, fields: Record<string, unknown>): Promise<PublicRecord> {
    const row = await this.requirePublicShareRow(token);
    if (asString(row.kind) !== "form") throw new DomainError("该分享不接受提交", 405);
    const created = await this.createRecord(asString(row.table_id), fields, {
      userId: "public",
      userName: "公开表单",
    });
    return created.record;
  }

  private async requirePublicShareRow(token: string) {
    const tokenHash = await hashToken(token);
    const result = await this.db.execute({
      sql: "SELECT * FROM public_shares WHERE token_hash = ?",
      args: [tokenHash],
    });
    const row = result.rows[0];
    if (!row) throw new DomainError("分享链接无效", 404);
    if (asNumber(row.enabled) !== 1) throw new DomainError("分享已关闭", 410);
    if (row.expires_at != null && asNumber(row.expires_at) < Date.now()) {
      throw new DomainError("分享链接已过期", 410);
    }
    return row;
  }

  private assertOptionCascades(fields: Field[], values: Record<string, unknown>): void {
    for (const source of fields) {
      const cascade = source.config.optionCascade;
      if (!cascade?.targetFieldId) continue;
      const target = fields.find((item) => item.id === cascade.targetFieldId);
      if (!target || (target.type !== "single_select" && target.type !== "multi_select")) continue;
      const sourceStored = values[source.id];
      if (sourceStored == null || sourceStored === "") continue;
      const sourceName =
        source.config.options?.find((item) => item.id === sourceStored)?.name ??
        (typeof sourceStored === "string" ? sourceStored : null);
      if (!sourceName) continue;
      const allowed = cascade.map[sourceName];
      if (!allowed) continue;
      const targetStored = values[target.id];
      if (targetStored == null || targetStored === "") continue;
      const names = Array.isArray(targetStored)
        ? targetStored
            .map((id) => target.config.options?.find((item) => item.id === id)?.name)
            .filter((name): name is string => Boolean(name))
        : [
            target.config.options?.find((item) => item.id === targetStored)?.name ??
              (typeof targetStored === "string" ? targetStored : null),
          ].filter((name): name is string => Boolean(name));
      for (const name of names) {
        if (!allowed.includes(name)) {
          throw new DomainError(`「${target.name}」选项「${name}」不在「${source.name}=${sourceName}」允许范围内`);
        }
      }
    }
  }

  async clickButton(
    recordId: string,
    fieldId: string,
    meta?: { userId?: string; userName?: string },
  ): Promise<{ ok: true; detail?: string }> {
    const record = await this.requireRecord(recordId);
    const field = await this.requireField(fieldId);
    if (field.tableId !== record.tableId) throw new DomainError("字段不属于该记录");
    if (field.type !== "button") throw new DomainError("不是按钮字段");
    const action = field.config.buttonAction;
    const fields = await this.listFields(record.tableId);
    let detail: string | undefined;
    if (action?.type === "set_field") {
      await this.updateRecord(recordId, { [action.fieldId]: action.value }, { ...meta, skipAutomation: false });
      detail = "已更新字段";
    } else if (action?.type === "add_comment") {
      await this.addComment(recordId, meta?.userId ?? "system", meta?.userName ?? "按钮", action.body);
      detail = "已添加评论";
    } else if (action?.type === "open_url") {
      detail = action.url;
    }
    await this.runButtonAutomations(record.tableId, fieldId, record, fields, meta);
    return { ok: true, detail };
  }

  async getAppPortal(baseId: string): Promise<{
    id: string;
    name: string;
    mode: "app";
    portal: AppPortalConfig;
    timezone: string;
    tables: Array<{ id: string; name: string; fields: Array<{ id: string; name: string; type: string }>; records: PublicRecord[] }>;
  }> {
    const bases = await this.listBases();
    const base = bases.find((item) => item.id === baseId);
    if (!base) throw new DomainError("找不到多维表格", 404);
    const settings = await this.getBaseSettings(baseId);
    const allowed = new Set(settings.portal.navTableIds ?? base.tables.map((t) => t.id));
    const tables = [];
    for (const table of base.tables) {
      if (!allowed.has(table.id)) continue;
      const payload = await this.getTable(table.id);
      tables.push({
        id: payload.id,
        name: payload.name,
        fields: payload.fields.map((field) => ({ id: field.id, name: field.name, type: field.type })),
        records: payload.records,
      });
    }
    return {
      id: base.id,
      name: settings.portal.title || base.name,
      mode: "app",
      portal: settings.portal,
      timezone: settings.timezone,
      tables,
    };
  }

  private async runWorkflows(
    tableId: string,
    event: "record_created" | "record_updated",
    record: RawRecord,
    fields: Field[],
    meta?: { userId?: string; userName?: string },
  ): Promise<void> {
    const flows = await this.listWorkflows(tableId);
    for (const flow of flows) {
      if (!flow.enabled || flow.nodes.length === 0) continue;
      const triggerNode = flow.nodes.find((node) => node.type === "trigger");
      if (!triggerNode || triggerNode.type !== "trigger") continue;
      const trigger = triggerNode.trigger;
      let hit = false;
      if (event === "record_created" && trigger.type === "record_created") hit = true;
      if (event === "record_updated" && trigger.type === "record_updated") hit = true;
      if (trigger.type === "field_equals") {
        const field = fields.find((item) => item.id === trigger.fieldId);
        if (field) {
          const value = await this.displayValue(field, record);
          if (displayText(value) === trigger.value) hit = true;
        }
      }
      if (!hit) continue;

      const outcome = await this.executeWorkflowNodes(flow, record, fields, 0, meta);
      if (outcome === "completed") {
        await this.firePluginHooks("workflow_ran", tableId, record.id, { workflowId: flow.id });
      }
    }
  }

  /** Run nodes from startIndex; returns completed | blocked | stopped */
  private async executeWorkflowNodes(
    flow: Workflow,
    record: RawRecord,
    fields: Field[],
    startIndex: number,
    meta?: { userId?: string; userName?: string },
  ): Promise<"completed" | "blocked" | "stopped"> {
    for (let i = startIndex; i < flow.nodes.length; i++) {
      const node = flow.nodes[i];
      if (node.type === "trigger") continue;
      if (node.type === "condition") {
        const publicRec = await this.toPublic(record, fields);
        const checks = node.conditions.map((condition) => {
          const field = fields.find((item) => item.id === condition.fieldId);
          if (!field) return false;
          return matchesFilter(publicRec.fields[field.name], condition);
        });
        const pass = (node.conjunction ?? "and") === "or" ? checks.some(Boolean) : checks.every(Boolean);
        if (!pass) return "stopped";
        continue;
      }
      if (node.type === "approval") {
        const strategy: ApprovalStrategy = node.strategy === "all" ? "all" : "any";
        const hours = typeof node.timeoutHours === "number" && node.timeoutHours > 0 ? node.timeoutHours : null;
        await this.createWorkflowRun({
          workflowId: flow.id,
          tableId: flow.tableId,
          recordId: record.id,
          pendingNodeIndex: i,
          approvers: node.approvers ?? [],
          strategy,
          timeoutHours: hours,
          nodeLabel: node.label ?? `审批节点 #${i}`,
          forceAllAfterAddSign: node.forceAllAfterAddSign !== false,
        });
        return "blocked";
      }
      if (node.type === "action") {
        await this.applyAutomationAction(flow.tableId, record, fields, node.action, meta);
      }
    }
    return "completed";
  }

  private mapWorkflowRun(row: Record<string, unknown>): WorkflowRun {
    const approvers = parseJson<string[]>(row.approvers_json, []);
    const votes = parseJson<ApprovalVote[]>(row.votes_json, []);
    const votedApprovers = votes.map((v) => v.onBehalfOf?.userName ?? v.userName);
    const votedKeys = new Set(
      votes.flatMap((v) => {
        const keys = [v.userId, v.userName, v.userName.toLowerCase()];
        if (v.onBehalfOf) keys.push(v.onBehalfOf.userId, v.onBehalfOf.userName, v.onBehalfOf.userName.toLowerCase());
        return keys;
      }),
    );
    const pendingApprovers = approvers.filter(
      (a) => !votedKeys.has(a) && !votedKeys.has(a.toLowerCase()),
    );
    return {
      id: asString(row.id),
      workflowId: asString(row.workflow_id),
      tableId: asString(row.table_id),
      recordId: asString(row.record_id),
      status: asString(row.status) as WorkflowRun["status"],
      pendingNodeIndex: asNumber(row.pending_node_index),
      nodeLabel: row.node_label == null ? null : asString(row.node_label),
      approvers,
      strategy: (row.strategy == null || asString(row.strategy) !== "all" ? "any" : "all") as ApprovalStrategy,
      forceAllAfterAddSign: asNumber(row.force_all_after_add_sign ?? 1) === 1,
      votes,
      decidedBy: row.decided_by == null ? null : asString(row.decided_by),
      decidedAt: row.decided_at == null ? null : asNumber(row.decided_at),
      comment: row.comment == null ? null : asString(row.comment),
      timeoutAt: row.timeout_at == null ? null : asNumber(row.timeout_at),
      timedOut: asNumber(row.timed_out ?? 0) === 1,
      remindedAt: row.reminded_at == null ? null : asNumber(row.reminded_at),
      createdAt: asNumber(row.created_at),
      votedApprovers,
      pendingApprovers,
    };
  }

  private async createWorkflowRun(input: {
    workflowId: string;
    tableId: string;
    recordId: string;
    pendingNodeIndex: number;
    approvers: string[];
    strategy: ApprovalStrategy;
    timeoutHours: number | null;
    nodeLabel: string;
    forceAllAfterAddSign: boolean;
  }): Promise<WorkflowRun> {
    const now = Date.now();
    const run: WorkflowRun = {
      id: nid("wr"),
      workflowId: input.workflowId,
      tableId: input.tableId,
      recordId: input.recordId,
      status: "pending",
      pendingNodeIndex: input.pendingNodeIndex,
      nodeLabel: input.nodeLabel,
      approvers: input.approvers,
      strategy: input.strategy,
      forceAllAfterAddSign: input.forceAllAfterAddSign,
      votes: [],
      decidedBy: null,
      decidedAt: null,
      comment: null,
      timeoutAt: input.timeoutHours != null ? now + input.timeoutHours * 3600_000 : null,
      timedOut: false,
      remindedAt: null,
      createdAt: now,
      votedApprovers: [],
      pendingApprovers: input.approvers,
    };
    await this.db.execute({
      sql: "INSERT INTO workflow_runs (id, workflow_id, table_id, record_id, status, pending_node_index, approvers_json, decided_by, decided_at, comment, created_at, strategy, votes_json, timeout_at, timed_out, reminded_at, node_label, force_all_after_add_sign) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, '[]', ?, 0, NULL, ?, ?)",
      args: [
        run.id,
        run.workflowId,
        run.tableId,
        run.recordId,
        run.status,
        run.pendingNodeIndex,
        JSON.stringify(run.approvers),
        run.createdAt,
        run.strategy,
        run.timeoutAt,
        run.nodeLabel,
        run.forceAllAfterAddSign ? 1 : 0,
      ],
    });
    await this.appendWorkflowAudit({
      runId: run.id,
      tableId: run.tableId,
      recordId: run.recordId,
      action: "created",
      actorUserId: "system",
      actorUserName: "系统",
      detail: `进入审批「${run.nodeLabel}」strategy=${run.strategy}`,
    });
    return run;
  }

  private async appendWorkflowAudit(input: {
    runId: string;
    tableId: string;
    recordId?: string | null;
    action: WorkflowAuditAction;
    actorUserId: string;
    actorUserName: string;
    onBehalfOfUserId?: string | null;
    onBehalfOfUserName?: string | null;
    detail?: string | null;
  }): Promise<WorkflowAuditEvent> {
    let recordId = input.recordId ?? null;
    if (recordId == null) {
      const run = await this.getWorkflowRun(input.runId).catch(() => null);
      recordId = run?.recordId ?? null;
    }
    const event: WorkflowAuditEvent = {
      id: nid("wa"),
      runId: input.runId,
      tableId: input.tableId,
      recordId,
      action: input.action,
      actorUserId: input.actorUserId,
      actorUserName: input.actorUserName,
      onBehalfOfUserId: input.onBehalfOfUserId ?? null,
      onBehalfOfUserName: input.onBehalfOfUserName ?? null,
      detail: input.detail ?? null,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO workflow_audit (id, run_id, table_id, action, actor_user_id, actor_user_name, on_behalf_of_user_id, on_behalf_of_user_name, detail, created_at, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        event.id,
        event.runId,
        event.tableId,
        event.action,
        event.actorUserId,
        event.actorUserName,
        event.onBehalfOfUserId,
        event.onBehalfOfUserName,
        event.detail,
        event.createdAt,
        event.recordId,
      ],
    });
    return event;
  }

  async listWorkflowAudit(opts: {
    runId?: string;
    tableId?: string;
    baseId?: string;
    action?: string;
    actor?: string;
    recordId?: string;
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<WorkflowAuditEvent[]> {
    let sql = `SELECT a.* FROM workflow_audit a WHERE 1=1`;
    const args: Array<string | number> = [];
    if (opts.runId) {
      sql += " AND a.run_id = ?";
      args.push(opts.runId);
    }
    if (opts.tableId) {
      sql += " AND a.table_id = ?";
      args.push(opts.tableId);
    }
    if (opts.baseId) {
      sql += " AND a.table_id IN (SELECT id FROM tables WHERE base_id = ?)";
      args.push(opts.baseId);
    }
    if (opts.action) {
      sql += " AND a.action = ?";
      args.push(opts.action);
    }
    if (opts.actor) {
      sql += " AND (a.actor_user_id = ? OR lower(a.actor_user_name) = lower(?))";
      args.push(opts.actor, opts.actor);
    }
    if (opts.recordId) {
      sql += " AND (a.record_id = ? OR a.run_id IN (SELECT id FROM workflow_runs WHERE record_id = ?))";
      args.push(opts.recordId, opts.recordId);
    }
    if (opts.from != null) {
      sql += " AND a.created_at >= ?";
      args.push(opts.from);
    }
    if (opts.to != null) {
      sql += " AND a.created_at <= ?";
      args.push(opts.to);
    }
    sql += " ORDER BY a.created_at ASC";
    if (opts.limit) {
      sql += " LIMIT ?";
      args.push(opts.limit);
    }
    const result = await this.db.execute({ sql, args });
    return result.rows.map((row) => ({
      id: asString(row.id),
      runId: asString(row.run_id),
      tableId: asString(row.table_id),
      recordId: row.record_id == null ? null : asString(row.record_id),
      action: asString(row.action) as WorkflowAuditAction,
      actorUserId: asString(row.actor_user_id),
      actorUserName: asString(row.actor_user_name),
      onBehalfOfUserId: row.on_behalf_of_user_id == null ? null : asString(row.on_behalf_of_user_id),
      onBehalfOfUserName: row.on_behalf_of_user_name == null ? null : asString(row.on_behalf_of_user_name),
      detail: row.detail == null ? null : asString(row.detail),
      createdAt: asNumber(row.created_at),
    }));
  }

  exportWorkflowAuditCsv(events: WorkflowAuditEvent[]): string {
    const headers = [
      "id",
      "createdAt",
      "action",
      "actorUserName",
      "actorUserId",
      "onBehalfOfUserName",
      "runId",
      "tableId",
      "recordId",
      "detail",
    ];
    const lines = [csvLine(headers)];
    for (const e of events) {
      lines.push(
        csvLine([
          e.id,
          new Date(e.createdAt).toISOString(),
          e.action,
          e.actorUserName,
          e.actorUserId,
          e.onBehalfOfUserName ?? "",
          e.runId,
          e.tableId,
          e.recordId ?? "",
          e.detail ?? "",
        ]),
      );
    }
    return lines.join("\n");
  }

  async listWorkflowRuns(opts?: { tableId?: string; status?: WorkflowRun["status"] }): Promise<WorkflowRun[]> {
    let sql = "SELECT * FROM workflow_runs WHERE 1=1";
    const args: Array<string | number> = [];
    if (opts?.tableId) {
      sql += " AND table_id = ?";
      args.push(opts.tableId);
    }
    if (opts?.status) {
      sql += " AND status = ?";
      args.push(opts.status);
    }
    sql += " ORDER BY created_at DESC";
    const result = await this.db.execute({ sql, args });
    return result.rows.map((row) => this.mapWorkflowRun(row as Record<string, unknown>));
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRun> {
    const result = await this.db.execute({ sql: "SELECT * FROM workflow_runs WHERE id = ?", args: [runId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到审批任务", 404);
    return this.mapWorkflowRun(row as Record<string, unknown>);
  }

  async locateWorkflowRun(runId: string): Promise<{ baseId: string; tableId: string }> {
    const run = await this.getWorkflowRun(runId);
    return this.locateTable(run.tableId);
  }

  async decideWorkflowRun(
    runId: string,
    decision: "approve" | "reject",
    meta: { userId: string; userName: string; comment?: string },
  ): Promise<WorkflowRun> {
    const run = await this.getWorkflowRun(runId);
    if (run.status !== "pending" && run.status !== "timed_out") throw new DomainError("该审批已处理");

    let onBehalfOf: { userId: string; userName: string } | null = null;
    let actingAsApprover = {
      userId: meta.userId,
      userName: meta.userName,
    };

    if (run.approvers.length) {
      const selfAllowed =
        run.approvers.includes(meta.userId) ||
        run.approvers.includes(meta.userName) ||
        run.approvers.some((item) => item.toLowerCase() === meta.userName.toLowerCase());
      if (!selfAllowed) {
        const located = await this.locateTable(run.tableId);
        const principals = await this.listPrincipalsForProxy(meta.userId, {
          baseId: located.baseId,
          workflowId: run.workflowId,
          now: Date.now(),
        });
        const match = principals.find(
          (p) =>
            run.approvers.includes(p.userId) ||
            run.approvers.includes(p.userName) ||
            run.approvers.some((a) => a.toLowerCase() === p.userName.toLowerCase()),
        );
        if (!match) throw new DomainError("你不是指定审批人（也非有效代理人）", 403);
        onBehalfOf = { userId: match.userId, userName: match.userName };
        actingAsApprover = match;
      }
    }

    const now = Date.now();
    const comment = meta.comment?.trim() || null;
    const vote: ApprovalVote = {
      userId: meta.userId,
      userName: meta.userName,
      decision,
      comment,
      at: now,
      onBehalfOf,
    };
    // 按被代理人身份去重投票（代理时占被代理人名额）
    const voteKey = onBehalfOf?.userId ?? meta.userId;
    const votes = [
      ...run.votes.filter((v) => {
        const key = v.onBehalfOf?.userId ?? v.userId;
        return key !== voteKey && v.userName !== actingAsApprover.userName;
      }),
      vote,
    ];

    const auditAction: WorkflowAuditAction = onBehalfOf
      ? decision === "approve"
        ? "proxy_approve"
        : "proxy_reject"
      : decision === "approve"
        ? "approve"
        : "reject";

    if (decision === "reject") {
      await this.db.execute({
        sql: "UPDATE workflow_runs SET status = ?, decided_by = ?, decided_at = ?, comment = ?, votes_json = ? WHERE id = ?",
        args: ["rejected", meta.userName, now, comment, JSON.stringify(votes), runId],
      });
      await this.appendWorkflowAudit({
        runId,
        tableId: run.tableId,
        action: auditAction,
        actorUserId: meta.userId,
        actorUserName: meta.userName,
        onBehalfOfUserId: onBehalfOf?.userId,
        onBehalfOfUserName: onBehalfOf?.userName,
        detail: comment,
      });
      return this.getWorkflowRun(runId);
    }

    if (run.strategy === "all" && run.approvers.length > 0) {
      const approvedIds = new Set(
        votes
          .filter((v) => v.decision === "approve")
          .flatMap((v) => {
            const who = v.onBehalfOf ?? { userId: v.userId, userName: v.userName };
            return [who.userId, who.userName];
          }),
      );
      const allPassed = run.approvers.every(
        (a) => approvedIds.has(a) || [...approvedIds].some((id) => id.toLowerCase() === a.toLowerCase()),
      );
      if (!allPassed) {
        await this.db.execute({
          sql: "UPDATE workflow_runs SET votes_json = ?, comment = ?, decided_by = ?, decided_at = ? WHERE id = ?",
          args: [
            JSON.stringify(votes),
            comment ??
              `已通过 ${votes.filter((v) => v.decision === "approve").length}/${run.approvers.length}`,
            meta.userName,
            now,
            runId,
          ],
        });
        await this.appendWorkflowAudit({
          runId,
          tableId: run.tableId,
          action: auditAction,
          actorUserId: meta.userId,
          actorUserName: meta.userName,
          onBehalfOfUserId: onBehalfOf?.userId,
          onBehalfOfUserName: onBehalfOf?.userName,
          detail: comment ?? "会签部分通过",
        });
        return this.getWorkflowRun(runId);
      }
    }

    const flows = await this.listWorkflows(run.tableId);
    const flow = flows.find((item) => item.id === run.workflowId);
    if (!flow) throw new DomainError("工作流已删除", 404);
    const record = await this.requireRecord(run.recordId);
    const fields = await this.listFields(run.tableId);
    const outcome = await this.executeWorkflowNodes(flow, record, fields, run.pendingNodeIndex + 1, meta);
    if (outcome === "blocked") {
      await this.db.execute({
        sql: "UPDATE workflow_runs SET status = ?, decided_by = ?, decided_at = ?, comment = ?, votes_json = ? WHERE id = ?",
        args: ["approved", meta.userName, now, comment ?? "已通过，进入下一审批", JSON.stringify(votes), runId],
      });
      await this.appendWorkflowAudit({
        runId,
        tableId: run.tableId,
        action: auditAction,
        actorUserId: meta.userId,
        actorUserName: meta.userName,
        onBehalfOfUserId: onBehalfOf?.userId,
        onBehalfOfUserName: onBehalfOf?.userName,
        detail: comment ?? "进入下一审批",
      });
      return this.getWorkflowRun(runId);
    }
    const status = outcome === "completed" ? "completed" : "approved";
    await this.db.execute({
      sql: "UPDATE workflow_runs SET status = ?, decided_by = ?, decided_at = ?, comment = ?, votes_json = ? WHERE id = ?",
      args: [status, meta.userName, now, comment, JSON.stringify(votes), runId],
    });
    await this.appendWorkflowAudit({
      runId,
      tableId: run.tableId,
      action: auditAction,
      actorUserId: meta.userId,
      actorUserName: meta.userName,
      onBehalfOfUserId: onBehalfOf?.userId,
      onBehalfOfUserName: onBehalfOf?.userName,
      detail: comment,
    });
    if (outcome === "completed") {
      await this.firePluginHooks("workflow_ran", run.tableId, run.recordId, { workflowId: flow.id, runId });
    }
    return this.getWorkflowRun(runId);
  }

  /** Mark timed-out pending approvals and write reminder comment/notification. */
  async processWorkflowTimeouts(now = Date.now()): Promise<{ reminded: number }> {
    const pending = await this.listWorkflowRuns({ status: "pending" });
    let reminded = 0;
    for (const run of pending) {
      if (run.timeoutAt == null || run.timeoutAt > now) continue;
      if (run.remindedAt != null) continue;
      const table = await this.requireTable(run.tableId);
      const msg = `审批超时催办：工作流节点 #${run.pendingNodeIndex}（记录 ${run.recordId}）已超过时限`;
      await this.addComment(run.recordId, "system", "工作流", msg);
      if (run.approvers.length) {
        for (const approver of run.approvers) {
          await this.createNotification({
            userId: approver,
            baseId: table.baseId,
            tableId: run.tableId,
            recordId: run.recordId,
            message: msg,
          });
        }
      }
      await this.db.execute({
        sql: "UPDATE workflow_runs SET timed_out = 1, reminded_at = ?, status = ?, comment = ? WHERE id = ?",
        args: [now, "timed_out", msg, run.id],
      });
      await this.appendWorkflowAudit({
        runId: run.id,
        tableId: run.tableId,
        action: "timeout",
        actorUserId: "system",
        actorUserName: "系统",
        detail: msg,
      });
      reminded += 1;
    }
    return { reminded };
  }

  /** 转交：替换当前审批人为指定人员（清空未决投票）。 */
  async transferWorkflowRun(
    runId: string,
    toApprovers: string[],
    meta: { userId: string; userName: string; comment?: string },
  ): Promise<WorkflowRun> {
    const run = await this.getWorkflowRun(runId);
    if (run.status !== "pending" && run.status !== "timed_out") throw new DomainError("该审批已处理");
    const next = toApprovers.map((item) => item.trim()).filter(Boolean);
    if (!next.length) throw new DomainError("转交目标不能为空");
    const note = meta.comment?.trim() || `由 ${meta.userName} 转交`;
    await this.db.execute({
      sql: "UPDATE workflow_runs SET approvers_json = ?, votes_json = '[]', comment = ?, timed_out = 0, status = 'pending' WHERE id = ?",
      args: [JSON.stringify(next), note, runId],
    });
    await this.appendWorkflowAudit({
      runId,
      tableId: run.tableId,
      action: "transfer",
      actorUserId: meta.userId,
      actorUserName: meta.userName,
      detail: `${note} → ${next.join(", ")}`,
    });
    return this.getWorkflowRun(runId);
  }

  /** 加签：追加审批人；默认强制 strategy=all（节点 forceAllAfterAddSign）。 */
  async addSignWorkflowRun(
    runId: string,
    addApprovers: string[],
    meta: { userId: string; userName: string; comment?: string },
  ): Promise<WorkflowRun> {
    const run = await this.getWorkflowRun(runId);
    if (run.status !== "pending" && run.status !== "timed_out") throw new DomainError("该审批已处理");
    const extra = addApprovers.map((item) => item.trim()).filter(Boolean);
    if (!extra.length) throw new DomainError("加签人不能为空");
    const merged = [...run.approvers];
    for (const person of extra) {
      if (!merged.some((a) => a.toLowerCase() === person.toLowerCase())) merged.push(person);
    }
    const forceAll = run.forceAllAfterAddSign;
    const nextStrategy: ApprovalStrategy = forceAll ? "all" : run.strategy;
    const note =
      meta.comment?.trim() ||
      `由 ${meta.userName} 加签：${extra.join(", ")}${forceAll ? "（已强制全部通过）" : ""}`;
    await this.db.execute({
      sql: "UPDATE workflow_runs SET approvers_json = ?, comment = ?, status = 'pending', timed_out = 0, strategy = ? WHERE id = ?",
      args: [JSON.stringify(merged), note, nextStrategy, runId],
    });
    await this.appendWorkflowAudit({
      runId,
      tableId: run.tableId,
      action: "add_sign",
      actorUserId: meta.userId,
      actorUserName: meta.userName,
      detail: `${note}; strategy=${nextStrategy}`,
    });
    return this.getWorkflowRun(runId);
  }

  async setApprovalProxy(input: {
    userId: string;
    userName: string;
    proxyUserId: string;
    proxyUserName: string;
    baseId?: string | null;
    workflowId?: string | null;
    expiresAt?: number | null;
  }): Promise<ApprovalProxy> {
    if (input.userId === input.proxyUserId) throw new DomainError("不能将自己设为代理人");
    if (input.expiresAt != null && input.expiresAt <= Date.now()) {
      throw new DomainError("有效期必须大于当前时间");
    }
    if (input.baseId) await this.requireBase(input.baseId);
    if (input.workflowId) {
      const located = await this.locateWorkflow(input.workflowId);
      if (input.baseId && located.baseId !== input.baseId) {
        throw new DomainError("工作流不属于指定的多维表格");
      }
    }
    const row: ApprovalProxy = {
      id: nid("apr"),
      userId: input.userId,
      userName: input.userName,
      proxyUserId: input.proxyUserId,
      proxyUserName: input.proxyUserName,
      baseId: input.baseId?.trim() || null,
      workflowId: input.workflowId?.trim() || null,
      expiresAt: input.expiresAt ?? null,
      updatedAt: Date.now(),
    };
    await this.db.execute({
      sql: `INSERT INTO approval_proxy_rules (id, user_id, user_name, proxy_user_id, proxy_user_name, base_id, workflow_id, expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.userId,
        row.userName,
        row.proxyUserId,
        row.proxyUserName,
        row.baseId,
        row.workflowId,
        row.expiresAt,
        row.updatedAt,
      ],
    });
    return row;
  }

  async clearApprovalProxy(userId: string, proxyId?: string): Promise<void> {
    if (proxyId) {
      await this.db.execute({
        sql: "DELETE FROM approval_proxy_rules WHERE id = ? AND user_id = ?",
        args: [proxyId, userId],
      });
      return;
    }
    await this.db.execute({ sql: "DELETE FROM approval_proxy_rules WHERE user_id = ?", args: [userId] });
  }

  async listApprovalProxies(userId: string): Promise<ApprovalProxy[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM approval_proxy_rules WHERE user_id = ? ORDER BY updated_at DESC",
      args: [userId],
    });
    return result.rows.map((row) => this.mapApprovalProxy(row as Record<string, unknown>));
  }

  /** @deprecated use listApprovalProxies; 返回最新一条以兼容旧 UI */
  async getApprovalProxy(userId: string): Promise<ApprovalProxy | null> {
    const list = await this.listApprovalProxies(userId);
    return list[0] ?? null;
  }

  private mapApprovalProxy(row: Record<string, unknown>): ApprovalProxy {
    return {
      id: asString(row.id),
      userId: asString(row.user_id),
      userName: asString(row.user_name),
      proxyUserId: asString(row.proxy_user_id),
      proxyUserName: asString(row.proxy_user_name),
      baseId: row.base_id == null ? null : asString(row.base_id),
      workflowId: row.workflow_id == null ? null : asString(row.workflow_id),
      expiresAt: row.expires_at == null ? null : asNumber(row.expires_at),
      updatedAt: asNumber(row.updated_at),
    };
  }

  /** 列出将当前用户设为代理人、且在范围内的委托方 */
  async listPrincipalsForProxy(
    proxyUserId: string,
    scope?: { baseId?: string; workflowId?: string; now?: number },
  ): Promise<Array<{ userId: string; userName: string }>> {
    const now = scope?.now ?? Date.now();
    const result = await this.db.execute({
      sql: "SELECT * FROM approval_proxy_rules WHERE proxy_user_id = ?",
      args: [proxyUserId],
    });
    const matched = result.rows
      .map((row) => this.mapApprovalProxy(row as Record<string, unknown>))
      .filter((rule) => {
        if (rule.expiresAt != null && rule.expiresAt <= now) return false;
        if (rule.baseId != null && rule.baseId !== scope?.baseId) return false;
        if (rule.workflowId != null && rule.workflowId !== scope?.workflowId) return false;
        return true;
      });
    const seen = new Set<string>();
    const out: Array<{ userId: string; userName: string }> = [];
    for (const rule of matched) {
      if (seen.has(rule.userId)) continue;
      seen.add(rule.userId);
      out.push({ userId: rule.userId, userName: rule.userName });
    }
    return out;
  }

  async getWorkflowSla(opts?: { tableId?: string; withinHours?: number; now?: number }): Promise<WorkflowSlaSummary> {
    const withinHours = opts?.withinHours && opts.withinHours > 0 ? opts.withinHours : 24;
    const now = opts?.now ?? Date.now();
    const horizon = now + withinHours * 3600_000;
    const pending = await this.listWorkflowRuns({ tableId: opts?.tableId, status: "pending" });
    const timedOutListed = await this.listWorkflowRuns({ tableId: opts?.tableId, status: "timed_out" });
    const dueSoon = pending.filter((run) => run.timeoutAt != null && run.timeoutAt > now && run.timeoutAt <= horizon);
    const timedOut = [
      ...timedOutListed,
      ...pending.filter((run) => run.timeoutAt != null && run.timeoutAt <= now),
    ];
    return {
      pendingCount: pending.length,
      timedOutCount: timedOut.length,
      dueSoonCount: dueSoon.length,
      timedOut,
      dueSoon,
      withinHours,
    };
  }

  private async firePluginHooks(
    event: PluginHook["event"],
    tableId: string,
    recordId?: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await this.listPluginHooks();
    const targets = hooks.filter((hook) => hook.enabled && hook.event === event).map((hook) => hook.target);
    if (!targets.length) return;
    await emitPluginEvent({ event, tableId, recordId, at: Date.now(), detail }, targets);
  }

  async listWorkflows(tableId: string): Promise<Workflow[]> {
    await this.requireTable(tableId);
    const result = await this.db.execute({
      sql: "SELECT * FROM workflows WHERE table_id = ? ORDER BY created_at ASC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      enabled: asNumber(row.enabled) === 1,
      nodes: parseJson<WorkflowNode[]>(row.nodes_json, []),
      createdAt: asNumber(row.created_at),
    }));
  }

  async createWorkflow(
    tableId: string,
    input: { name: string; nodes: WorkflowNode[]; enabled?: boolean },
  ): Promise<Workflow> {
    await this.requireTable(tableId);
    if (!input.nodes.some((node) => node.type === "trigger")) throw new DomainError("工作流需要触发节点");
    const hasAction = input.nodes.some((node) => node.type === "action");
    const hasApproval = input.nodes.some((node) => node.type === "approval");
    if (!hasAction && !hasApproval) throw new DomainError("工作流需要动作或审批节点");
    const flow: Workflow = {
      id: nid("w"),
      tableId,
      name: cleanName(input.name),
      enabled: input.enabled !== false,
      nodes: input.nodes,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO workflows (id, table_id, name, enabled, nodes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [flow.id, tableId, flow.name, flow.enabled ? 1 : 0, JSON.stringify(flow.nodes), flow.createdAt],
    });
    return flow;
  }

  async updateWorkflow(
    workflowId: string,
    patch: Partial<{ name: string; enabled: boolean; nodes: WorkflowNode[] }>,
  ): Promise<Workflow> {
    const result = await this.db.execute({ sql: "SELECT * FROM workflows WHERE id = ?", args: [workflowId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到工作流", 404);
    const current: Workflow = {
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      enabled: asNumber(row.enabled) === 1,
      nodes: parseJson<WorkflowNode[]>(row.nodes_json, []),
      createdAt: asNumber(row.created_at),
    };
    const next: Workflow = {
      ...current,
      name: patch.name != null ? cleanName(patch.name) : current.name,
      enabled: patch.enabled ?? current.enabled,
      nodes: patch.nodes ?? current.nodes,
    };
    await this.db.execute({
      sql: "UPDATE workflows SET name = ?, enabled = ?, nodes_json = ? WHERE id = ?",
      args: [next.name, next.enabled ? 1 : 0, JSON.stringify(next.nodes), workflowId],
    });
    return next;
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT id FROM workflows WHERE id = ?", args: [workflowId] });
    if (!result.rows[0]) throw new DomainError("找不到工作流", 404);
    await this.db.execute({ sql: "DELETE FROM workflows WHERE id = ?", args: [workflowId] });
  }

  async locateWorkflow(workflowId: string): Promise<{ baseId: string; tableId: string }> {
    const result = await this.db.execute({ sql: "SELECT table_id FROM workflows WHERE id = ?", args: [workflowId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到工作流", 404);
    return this.locateTable(asString(row.table_id));
  }

  async listSyncJobs(): Promise<SyncJob[]> {
    const result = await this.db.execute("SELECT * FROM sync_jobs ORDER BY created_at ASC");
    return result.rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      sourceTableId: asString(row.source_table_id),
      targetTableId: asString(row.target_table_id),
      fieldMap: parseJson<Record<string, string>>(row.field_map_json, {}),
      matchField: row.match_field == null ? null : asString(row.match_field),
      mode: (row.mode == null ? "full" : asString(row.mode)) as SyncMode,
      conflict: (row.conflict == null ? "overwrite" : asString(row.conflict)) as SyncConflict,
      enabled: asNumber(row.enabled) === 1,
      lastRunAt: row.last_run_at == null ? null : asNumber(row.last_run_at),
      lastResult: parseJson<SyncRunResult | null>(row.last_result_json, null),
      createdAt: asNumber(row.created_at),
    }));
  }

  async createSyncJob(input: {
    name: string;
    sourceTableId: string;
    targetTableId: string;
    fieldMap: Record<string, string>;
    matchField?: string | null;
    mode?: SyncMode;
    conflict?: SyncConflict;
    enabled?: boolean;
  }): Promise<SyncJob> {
    const source = await this.requireTable(input.sourceTableId);
    const target = await this.requireTable(input.targetTableId);
    if (source.baseId === target.baseId && source.id === target.id) {
      throw new DomainError("不能同步到同一张表");
    }
    const mode: SyncMode = input.mode === "incremental" ? "incremental" : "full";
    const conflict: SyncConflict =
      input.conflict === "skip_if_target_nonempty" ? "skip_if_target_nonempty" : "overwrite";
    const job: SyncJob = {
      id: nid("sync"),
      name: cleanName(input.name),
      sourceTableId: input.sourceTableId,
      targetTableId: input.targetTableId,
      fieldMap: input.fieldMap,
      matchField: input.matchField?.trim() || null,
      mode,
      conflict,
      enabled: input.enabled !== false,
      lastRunAt: null,
      lastResult: null,
      createdAt: Date.now(),
    };
    await this.db.execute({
      sql: "INSERT INTO sync_jobs (id, name, source_table_id, target_table_id, field_map_json, enabled, last_run_at, created_at, mode, conflict, match_field, last_result_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)",
      args: [
        job.id,
        job.name,
        job.sourceTableId,
        job.targetTableId,
        JSON.stringify(job.fieldMap),
        job.enabled ? 1 : 0,
        job.createdAt,
        job.mode,
        job.conflict,
        job.matchField,
      ],
    });
    return job;
  }

  async updateSyncJob(
    jobId: string,
    patch: Partial<{ conflict: SyncConflict; mode: SyncMode; enabled: boolean; name: string }>,
  ): Promise<SyncJob> {
    const jobs = await this.listSyncJobs();
    const current = jobs.find((item) => item.id === jobId);
    if (!current) throw new DomainError("找不到同步任务", 404);
    const next: SyncJob = {
      ...current,
      name: patch.name != null ? cleanName(patch.name) : current.name,
      conflict:
        patch.conflict === "skip_if_target_nonempty" || patch.conflict === "overwrite"
          ? patch.conflict
          : current.conflict,
      mode: patch.mode === "incremental" || patch.mode === "full" ? patch.mode : current.mode,
      enabled: patch.enabled ?? current.enabled,
    };
    await this.db.execute({
      sql: "UPDATE sync_jobs SET name = ?, conflict = ?, mode = ?, enabled = ? WHERE id = ?",
      args: [next.name, next.conflict, next.mode, next.enabled ? 1 : 0, jobId],
    });
    return next;
  }

  async runSyncJob(jobId: string): Promise<SyncRunResult & { synced: number }> {
    const jobs = await this.listSyncJobs();
    const job = jobs.find((item) => item.id === jobId);
    if (!job) throw new DomainError("找不到同步任务", 404);
    if (!job.enabled) throw new DomainError("同步任务已停用");
    const source = await this.getTable(job.sourceTableId);
    const target = await this.getTable(job.targetTableId);
    const matchSourceField =
      job.matchField && job.fieldMap[job.matchField]
        ? job.matchField
        : Object.keys(job.fieldMap)[0];
    if (!matchSourceField) throw new DomainError("同步字段映射为空");
    const matchTargetField = job.fieldMap[matchSourceField];
    const since = job.mode === "incremental" && job.lastRunAt != null ? job.lastRunAt : 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of source.records) {
      if (job.mode === "incremental" && record.updatedAt <= since) {
        skipped += 1;
        continue;
      }
      const key = displayText(record.fields[matchSourceField]);
      const existing = key
        ? target.records.find((item) => displayText(item.fields[matchTargetField]) === key)
        : undefined;

      if (!existing) {
        const fields: Record<string, unknown> = {};
        for (const [from, to] of Object.entries(job.fieldMap)) {
          fields[to] = record.fields[from] ?? null;
        }
        await this.createRecord(job.targetTableId, fields, { skipAutomation: true, skipDuplex: true });
        created += 1;
        continue;
      }

      const patch: Record<string, unknown> = {};
      let touched = false;
      for (const [from, to] of Object.entries(job.fieldMap)) {
        const nextVal = record.fields[from] ?? null;
        const curVal = existing.fields[to];
        if (job.conflict === "skip_if_target_nonempty" && !isEmptyDisplay(curVal)) {
          skipped += 1;
          continue;
        }
        patch[to] = nextVal;
        touched = true;
      }
      if (touched) {
        await this.updateRecord(existing.id, patch, { skipAutomation: true, skipDuplex: true });
        existing.fields = {
          ...existing.fields,
          ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v as DisplayValue])),
        };
        updated += 1;
      }
    }

    const at = Date.now();
    const result: SyncRunResult = {
      at,
      synced: created + updated,
      created,
      updated,
      skipped,
      conflict: job.conflict,
      mode: job.mode,
    };
    await this.db.execute({
      sql: "UPDATE sync_jobs SET last_run_at = ?, last_result_json = ? WHERE id = ?",
      args: [at, JSON.stringify(result), jobId],
    });
    return result;
  }

  async deleteSyncJob(jobId: string): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM sync_jobs WHERE id = ?", args: [jobId] });
  }

  async listPluginHooks(): Promise<PluginHook[]> {
    const result = await this.db.execute("SELECT * FROM plugin_hooks ORDER BY created_at ASC");
    return result.rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      event: asString(row.event) as PluginHook["event"],
      target: asString(row.target),
      enabled: asNumber(row.enabled) === 1,
      createdAt: asNumber(row.created_at),
    }));
  }

  async createPluginHook(input: {
    name: string;
    event: PluginHook["event"];
    target: string;
    enabled?: boolean;
  }): Promise<PluginHook> {
    const hook: PluginHook = {
      id: nid("ph"),
      name: cleanName(input.name),
      event: input.event,
      target: input.target.trim(),
      enabled: input.enabled !== false,
      createdAt: Date.now(),
    };
    if (!hook.target) throw new DomainError("插件目标不能为空");
    await this.db.execute({
      sql: "INSERT INTO plugin_hooks (id, name, event, target, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [hook.id, hook.name, hook.event, hook.target, hook.enabled ? 1 : 0, hook.createdAt],
    });
    return hook;
  }

  async deletePluginHook(hookId: string): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM plugin_hooks WHERE id = ?", args: [hookId] });
  }

  async updatePluginHook(hookId: string, patch: Partial<{ enabled: boolean; target: string; name: string }>): Promise<PluginHook> {
    const hooks = await this.listPluginHooks();
    const current = hooks.find((item) => item.id === hookId);
    if (!current) throw new DomainError("找不到插件钩子", 404);
    const next: PluginHook = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      target: patch.target?.trim() || current.target,
      name: patch.name != null ? cleanName(patch.name) : current.name,
    };
    await this.db.execute({
      sql: "UPDATE plugin_hooks SET name = ?, target = ?, enabled = ? WHERE id = ?",
      args: [next.name, next.target, next.enabled ? 1 : 0, hookId],
    });
    return next;
  }

  private static readonly MARKETPLACE_CATALOG: Array<Omit<MarketplacePlugin, "enabled" | "hookId">> = [
    {
      id: "builtin-webhook",
      name: "Webhook 出站",
      description: "记录创建/更新时向配置的 URL POST 事件 JSON",
      kind: "webhook",
      event: "record_created",
      defaultTarget: "https://example.com/duowei-hook",
    },
    {
      id: "builtin-sync-log",
      name: "同步与事件日志",
      description: "启用后把插件事件写入进程内日志，可在市场查看最近记录",
      kind: "log",
      event: "record_created",
      defaultTarget: "log",
    },
  ];

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    const hooks = await this.listPluginHooks();
    return Store.MARKETPLACE_CATALOG.map((item) => {
      const hook = hooks.find((h) => h.name === item.name || h.target === item.defaultTarget && item.kind === "log");
      const byMeta = hooks.find((h) => h.name.startsWith(`[market:${item.id}]`));
      const matched = byMeta ?? hook;
      return {
        ...item,
        enabled: matched?.enabled === true,
        hookId: matched?.id ?? null,
      };
    });
  }

  async setMarketplacePlugin(
    pluginId: string,
    enabled: boolean,
    opts?: { webhookUrl?: string },
  ): Promise<MarketplacePlugin> {
    const catalog = Store.MARKETPLACE_CATALOG.find((item) => item.id === pluginId);
    if (!catalog) throw new DomainError("找不到内置插件", 404);
    const name = `[market:${catalog.id}] ${catalog.name}`;
    const hooks = await this.listPluginHooks();
    let hook = hooks.find((h) => h.name.startsWith(`[market:${catalog.id}]`));
    const target =
      catalog.kind === "webhook"
        ? (opts?.webhookUrl?.trim() || hook?.target || catalog.defaultTarget)
        : catalog.defaultTarget;
    if (!hook) {
      hook = await this.createPluginHook({
        name,
        event: catalog.event,
        target,
        enabled,
      });
    } else {
      hook = await this.updatePluginHook(hook.id, { enabled, target, name });
    }
    const listed = await this.listMarketplacePlugins();
    return listed.find((item) => item.id === pluginId)!;
  }

  listPluginEventLog(limit = 30) {
    return recentPluginEvents(limit);
  }

  async saveUpload(input: {
    filename: string;
    bytes: Buffer;
    mime?: string;
    createdBy?: string;
    baseId?: string;
    minRole?: "viewer" | "editor" | "owner";
  }): Promise<AttachmentMeta & { id: string; baseId?: string; minRole: string }> {
    const id = nid("up");
    const safe = input.filename.replace(/[^\w.\-\u4e00-\u9fff]/g, "_") || "file";
    const storedName = `${id}_${safe}`;
    const full = path.join(this.uploadsDir, storedName);
    const minRole = input.minRole ?? "viewer";
    await fs.promises.writeFile(full, input.bytes);
    await this.db.execute({
      sql: "INSERT INTO uploads (id, filename, stored_name, mime, size, created_by, created_at, base_id, min_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        id,
        input.filename,
        storedName,
        input.mime ?? null,
        input.bytes.length,
        input.createdBy ?? null,
        Date.now(),
        input.baseId ?? null,
        minRole,
      ],
    });
    return {
      id,
      name: input.filename,
      url: `/api/uploads/${id}`,
      mime: input.mime,
      size: input.bytes.length,
      baseId: input.baseId,
      minRole,
    };
  }

  async getUpload(uploadId: string): Promise<{
    meta: AttachmentMeta & { id: string; baseId?: string; minRole: string; createdBy?: string };
    path: string;
  }> {
    const result = await this.db.execute({ sql: "SELECT * FROM uploads WHERE id = ?", args: [uploadId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到附件", 404);
    const stored = asString(row.stored_name);
    const full = path.join(this.uploadsDir, stored);
    if (!fs.existsSync(full)) throw new DomainError("附件文件丢失", 404);
    return {
      meta: {
        id: asString(row.id),
        name: asString(row.filename),
        url: `/api/uploads/${asString(row.id)}`,
        mime: row.mime == null ? undefined : asString(row.mime),
        size: asNumber(row.size),
        baseId: row.base_id == null ? undefined : asString(row.base_id),
        minRole: row.min_role == null ? "viewer" : asString(row.min_role),
        createdBy: row.created_by == null ? undefined : asString(row.created_by),
      },
      path: full,
    };
  }

  async deleteUpload(uploadId: string): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT * FROM uploads WHERE id = ?", args: [uploadId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到附件", 404);
    const stored = asString(row.stored_name);
    const full = path.join(this.uploadsDir, stored);
    try {
      await fs.promises.unlink(full);
    } catch {
      /* file may already be gone */
    }
    await this.db.execute({ sql: "DELETE FROM uploads WHERE id = ?", args: [uploadId] });
  }

  private async listFields(tableId: string): Promise<Field[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM fields WHERE table_id = ? ORDER BY position ASC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      type: asString(row.type) as FieldType,
      position: asNumber(row.position),
      config: parseJson<FieldConfig>(row.config, {}),
    }));
  }

  private async listViews(tableId: string, viewerUserId?: string): Promise<View[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM views WHERE table_id = ? ORDER BY position ASC",
      args: [tableId],
    });
    const views = result.rows.map((row) => mapViewRow(row));
    if (!viewerUserId) return views;
    return views.filter((view) => view.protection !== "personal" || view.createdBy === viewerUserId);
  }

  private async listRawRecords(tableId: string): Promise<RawRecord[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM records WHERE table_id = ? ORDER BY created_at ASC",
      args: [tableId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      tableId: asString(row.table_id),
      values: parseJson<Record<string, unknown>>(row.values_json, {}),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
    }));
  }

  private async listPublicRecords(tableId: string, fields: Field[]): Promise<PublicRecord[]> {
    const records = await this.listRawRecords(tableId);
    const formulaCtx = await this.formulaContextForTable(tableId);
    const out: PublicRecord[] = [];
    for (const record of records) out.push(await this.toPublic(record, fields, formulaCtx));
    return out;
  }

  private async requireBase(baseId: string): Promise<void> {
    const result = await this.db.execute({ sql: "SELECT id FROM bases WHERE id = ?", args: [baseId] });
    if (!result.rows[0]) throw new DomainError("找不到多维表格", 404);
  }

  private async requireTable(tableId: string): Promise<{ id: string; baseId: string; name: string }> {
    const result = await this.db.execute({ sql: "SELECT * FROM tables WHERE id = ?", args: [tableId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到数据表", 404);
    return { id: asString(row.id), baseId: asString(row.base_id), name: asString(row.name) };
  }

  private async requireField(fieldId: string): Promise<Field> {
    const result = await this.db.execute({ sql: "SELECT * FROM fields WHERE id = ?", args: [fieldId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到字段", 404);
    return {
      id: asString(row.id),
      tableId: asString(row.table_id),
      name: asString(row.name),
      type: asString(row.type) as FieldType,
      position: asNumber(row.position),
      config: parseJson<FieldConfig>(row.config, {}),
    };
  }

  private async requireRecord(recordId: string): Promise<RawRecord> {
    const result = await this.db.execute({ sql: "SELECT * FROM records WHERE id = ?", args: [recordId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到记录", 404);
    return {
      id: asString(row.id),
      tableId: asString(row.table_id),
      values: parseJson<Record<string, unknown>>(row.values_json, {}),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
    };
  }

  private async requireView(viewId: string): Promise<View> {
    const result = await this.db.execute({ sql: "SELECT * FROM views WHERE id = ?", args: [viewId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到视图", 404);
    return mapViewRow(row);
  }

  private async nextPosition(table: "tables" | "views", column: "base_id" | "table_id", id: string): Promise<number> {
    const result = await this.db.execute({
      sql: `SELECT COALESCE(MAX(position), -1) AS max_position FROM ${table} WHERE ${column} = ?`,
      args: [id],
    });
    return asNumber(result.rows[0]?.max_position) + 1;
  }

  private async writeValues(recordId: string, values: Record<string, unknown>, updatedAt: number): Promise<void> {
    await this.db.execute({
      sql: "UPDATE records SET values_json = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify(values), updatedAt, recordId],
    });
  }

  private async writeViewConfig(viewId: string, config: ViewConfig): Promise<void> {
    await this.db.execute({
      sql: "UPDATE views SET config = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify(config), Date.now(), viewId],
    });
  }

  private async touchTable(tableId: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE tables SET updated_at = ? WHERE id = ?",
      args: [Date.now(), tableId],
    });
  }
}

function matchesCondition(value: DisplayValue | undefined, condition: AutomationCondition): boolean {
  return matchesFilter(value, { fieldId: condition.fieldId, op: condition.op, value: condition.value });
}


function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(y, (m ?? 1) - 1, (d ?? 1) + days);
  return localYmd(next);
}

/** Accept every:N, daily:HH:MM, weekly:D:HH:MM, hourly, or plain minutes. */
function parseScheduleMs(cron: string): number | null {
  const text = cron.trim();
  const every = text.match(/^every:(\d+)$/i);
  if (every) {
    const minutes = Number(every[1]);
    return minutes > 0 ? minutes * 60_000 : null;
  }
  if (/^hourly$/i.test(text)) return 60 * 60_000;
  if (/^\d+$/.test(text)) {
    const minutes = Number(text);
    return minutes > 0 ? minutes * 60_000 : null;
  }
  return null;
}

function shouldRunSchedule(cron: string, lastRunAt: number, now: number): boolean {
  const everyMs = parseScheduleMs(cron);
  if (everyMs) return now - lastRunAt >= everyMs;
  const text = cron.trim();
  const daily = text.match(/^daily:(\d{1,2}):(\d{2})$/i);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return false;
    const d = new Date(now);
    if (d.getHours() !== hour || d.getMinutes() !== minute) return false;
    return now - lastRunAt >= 60_000;
  }
  const weekly = text.match(/^weekly:([0-6]):(\d{1,2}):(\d{2})$/i);
  if (weekly) {
    const dow = Number(weekly[1]);
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    const d = new Date(now);
    if (d.getDay() !== dow || d.getHours() !== hour || d.getMinutes() !== minute) return false;
    return now - lastRunAt >= 60_000;
  }
  // simple cron: m h * * *
  const parts = text.split(/\s+/);
  if (parts.length === 5) {
    const [m, h] = parts;
    const d = new Date(now);
    if (m !== "*" && Number(m) !== d.getMinutes()) return false;
    if (h !== "*" && Number(h) !== d.getHours()) return false;
    return now - lastRunAt >= 60_000;
  }
  return false;
}

function mapViewRow(row: Record<string, unknown> | { [key: string]: unknown }): View {
  const protectionRaw = row.protection == null ? "public" : asString(row.protection);
  const protection = VIEW_PROTECTIONS.has(protectionRaw as ViewProtection)
    ? (protectionRaw as ViewProtection)
    : "public";
  return {
    id: asString(row.id),
    tableId: asString(row.table_id),
    name: asString(row.name),
    type: asString(row.type) as ViewType,
    position: asNumber(row.position),
    config: normalizeViewConfig(parseJson<Partial<ViewConfig>>(row.config, {})),
    protection,
    createdBy: row.created_by == null ? null : asString(row.created_by),
  };
}

function normalizeDetailPage(config: Partial<DetailPageConfig>): DetailPageConfig {
  const base = emptyDetailPageConfig();
  const style = config.style === "multi" || config.style === "grouped" ? config.style : "single";
  return {
    style,
    fieldIds: Array.isArray(config.fieldIds) ? config.fieldIds.map(String) : base.fieldIds,
    groups: Array.isArray(config.groups)
      ? config.groups.map((group, index) => ({
          id: group.id || `g${index}`,
          title: group.title || `分组 ${index + 1}`,
          fieldIds: Array.isArray(group.fieldIds) ? group.fieldIds.map(String) : [],
        }))
      : base.groups,
    columns: config.columns === 2 || config.columns === 3 ? config.columns : 1,
  };
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseGeoPoint(raw: unknown): GeoPoint | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      return parseGeoPoint(JSON.parse(raw));
    } catch {
      const parts = raw.split(",").map((item) => item.trim());
      if (parts.length >= 2) {
        const lat = Number(parts[0]);
        const lng = Number(parts[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng, label: parts.slice(2).join(",").trim() || undefined };
        }
      }
      throw new DomainError("地理位置格式无效");
    }
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const lat = typeof obj.lat === "number" ? obj.lat : Number(obj.lat);
    const lng = typeof obj.lng === "number" ? obj.lng : Number(obj.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new DomainError("地理位置需要有效经纬度");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new DomainError("地理位置经纬度超出范围");
    const label = typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : undefined;
    return { lat, lng, label };
  }
  throw new DomainError("地理位置格式无效");
}

function parseAttachments(raw: unknown): AttachmentMeta[] {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parseAttachments(parsed);
    } catch {
      if (raw.trim()) return [{ name: raw.split("/").pop() || "file", url: raw }];
      return [];
    }
  }
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === "object" && "url" in (raw as object)) {
      const item = raw as AttachmentMeta;
      return item.url ? [{ name: item.name || "file", url: item.url, mime: item.mime, size: item.size }] : [];
    }
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item === "string") return { name: item.split("/").pop() || "file", url: item };
      if (item && typeof item === "object" && "url" in item) {
        const meta = item as AttachmentMeta;
        return { name: meta.name || "file", url: String(meta.url), mime: meta.mime, size: meta.size };
      }
      return null;
    })
    .filter((item): item is AttachmentMeta => Boolean(item?.url));
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError("名称不能为空");
  if (trimmed.length > 80) throw new DomainError("名称不能超过 80 个字符");
  return trimmed;
}

function isEmptyDisplay(value: DisplayValue | undefined): boolean {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toBoolean(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const text = String(raw).trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "是";
}

function toNameList(raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw.map((item) => String(item)) : String(raw).split(/[,，]/);
  return source.map((item) => item.trim()).filter(Boolean);
}

function convertStoredForTypeChange(
  raw: unknown,
  from: Field,
  toType: FieldType,
  nextConfig: FieldConfig,
): unknown {
  if (raw == null || raw === "") return null;
  if (from.type === "single_select" || from.type === "multi_select") {
    const options = from.config.options ?? [];
    const ids = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const names = ids.map((id) => options.find((item) => item.id === id)?.name ?? id);
    if (toType === "multi_select") {
      return names
        .map((name) => nextConfig.options?.find((item) => item.name === name)?.id)
        .filter(Boolean);
    }
    if (toType === "single_select") {
      const name = names[0];
      return nextConfig.options?.find((item) => item.name === name)?.id ?? null;
    }
    if (toType === "text" || toType === "long_text") return names.join(", ");
  }
  if (toType === "number" || toType === "currency" || toType === "rating" || toType === "progress") {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (toType === "checkbox") return toBoolean(raw);
  if (toType === "single_select") {
    const name = String(Array.isArray(raw) ? raw[0] : raw).trim();
    return nextConfig.options?.find((item) => item.name === name)?.id ?? nextConfig.options?.[0]?.id ?? null;
  }
  if (toType === "multi_select") {
    const names = toNameList(raw);
    return names
      .map((name) => nextConfig.options?.find((item) => item.name === name)?.id)
      .filter(Boolean);
  }
  if (toType === "text" || toType === "long_text" || toType === "url" || toType === "email" || toType === "phone" || toType === "barcode") {
    if (Array.isArray(raw)) return raw.join(", ");
    if (typeof raw === "object") return JSON.stringify(raw);
    return String(raw);
  }
  if (toType === "person" || toType === "group") return toNameList(raw);
  return raw;
}

function buildOptions(incoming: NonNullable<FieldDraft["options"]>): SelectOption[] {
  return mergeOptions([], incoming);
}

function mergeOptions(existing: SelectOption[], incoming: NonNullable<FieldDraft["options"]>): SelectOption[] {
  return incoming
    .map((item, index) => {
      const name = (typeof item === "string" ? item : item.name).trim();
      const requested = typeof item === "string" ? undefined : item.color;
      const prev = existing.find((option) => option.name === name);
      return {
        id: prev?.id ?? nid("o"),
        name,
        color: requested ?? prev?.color ?? TAG_COLORS[index % TAG_COLORS.length],
      } satisfies SelectOption;
    })
    .filter((option) => option.name);
}

function normalizeViewConfig(config: Partial<ViewConfig>): ViewConfig {
  const base = emptyViewConfig();
  return {
    filters: Array.isArray(config.filters) ? config.filters : base.filters,
    conjunction: config.conjunction === "or" ? "or" : "and",
    sorts: Array.isArray(config.sorts) ? config.sorts : base.sorts,
    groups: Array.isArray(config.groups) ? config.groups : base.groups,
    hiddenFieldIds: Array.isArray(config.hiddenFieldIds) ? config.hiddenFieldIds : base.hiddenFieldIds,
    groupFieldId: config.groupFieldId ?? null,
    rowHeight: ROW_HEIGHTS.includes(config.rowHeight as RowHeight) ? (config.rowHeight as RowHeight) : base.rowHeight,
    dateFieldId: config.dateFieldId ?? null,
    titleFieldId: config.titleFieldId ?? null,
    endDateFieldId: config.endDateFieldId ?? null,
    progressFieldId: config.progressFieldId ?? null,
    dependencyFieldId: config.dependencyFieldId ?? null,
    colorRules: Array.isArray(config.colorRules) ? config.colorRules : base.colorRules,
    fieldOrder: Array.isArray(config.fieldOrder) ? config.fieldOrder : base.fieldOrder,
  };
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function csvLine(cells: string[]): string {
  return cells
    .map((cell) => {
      const text = cell ?? "";
      if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
      return text;
    })
    .join(",");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

