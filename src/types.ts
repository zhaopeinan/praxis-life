export const FIELD_TYPES = [
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
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const SYSTEM_FIELD_TYPES = [
  "auto_number",
  "created_time",
  "updated_time",
  "created_by",
  "formula",
  "lookup",
  "button",
] as const;

export const TAG_COLORS = [
  "gray",
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const FILTER_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
  "is_not_empty",
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

export type SelectOption = {
  id: string;
  name: string;
  color: TagColor;
};

export type AttachmentMeta = {
  name: string;
  url: string;
  mime?: string;
  size?: number;
};

export type ButtonAction =
  | { type: "set_field"; fieldId: string; value: string }
  | { type: "open_url"; url: string }
  | { type: "add_comment"; body: string }
  | { type: "lock_record" }
  | { type: "unlock_record" };

export type FieldConfig = {
  options?: SelectOption[];
  /** rating max, default 5 */
  max?: number;
  /** currency code, default CNY */
  currency?: string;
  /** formula expression, e.g. "{数量}*{单价}" */
  formula?: string;
  /** link / duplex_link: target table id */
  linkTableId?: string;
  /** duplex_link: symmetric field id on the other table */
  symmetricFieldId?: string;
  /** duplex_link: whether this side owns the pair (auto-created counterpart) */
  duplexPrimary?: boolean;
  /** lookup: which link/duplex_link field to follow */
  lookupLinkFieldId?: string;
  /** lookup: which field on the linked table to show */
  lookupTargetFieldId?: string;
  /** auto_number / barcode prefix */
  prefix?: string;
  /** button label */
  buttonLabel?: string;
  /** button click action */
  buttonAction?: ButtonAction;
  /**
   * Option cascade: when this (source) select changes, constrain target select options.
   * map keys/values use option names.
   */
  optionCascade?: {
    targetFieldId: string;
    map: Record<string, string[]>;
  };
  /** text / long_text / email / url / phone: value must be unique within the table (e.g. DOI) */
  unique?: boolean;
};

export type GeoPoint = {
  lat: number;
  lng: number;
  label?: string;
};

export type Field = {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  position: number;
  config: FieldConfig;
};

export type Filter = {
  fieldId: string;
  op: FilterOp;
  value?: string;
};

export type Sort = {
  fieldId: string;
  direction: "asc" | "desc";
};

export type Group = {
  fieldId: string;
};

export type RowHeight = "short" | "medium" | "tall" | "extra";

export type ViewProtection = "public" | "locked" | "personal";

export type ColorRule = {
  id: string;
  fieldId: string;
  op: FilterOp;
  value?: string;
  color: string;
  /** default row */
  target?: "row" | "cell";
};

export type ViewConfig = {
  filters: Filter[];
  conjunction: "and" | "or";
  sorts: Sort[];
  groups: Group[];
  hiddenFieldIds: string[];
  groupFieldId: string | null;
  rowHeight: RowHeight;
  /** calendar/gantt: start date field */
  dateFieldId: string | null;
  /** gallery/form: cover or title field */
  titleFieldId: string | null;
  /** gantt: end date field */
  endDateFieldId: string | null;
  /** gantt: progress field */
  progressFieldId: string | null;
  /** gantt: dependency link field (record ids) */
  dependencyFieldId: string | null;
  /** conditional fill colors */
  colorRules?: ColorRule[];
};

export type ViewType = "grid" | "kanban" | "calendar" | "gallery" | "form" | "gantt";

export type View = {
  id: string;
  tableId: string;
  name: string;
  type: ViewType;
  position: number;
  config: ViewConfig;
  protection: ViewProtection;
  createdBy: string | null;
};

export type DetailPageStyle = "single" | "multi" | "grouped";

export type DetailPageGroup = {
  id: string;
  title: string;
  fieldIds: string[];
};

export type DetailPageConfig = {
  style: DetailPageStyle;
  /** field order for single/multi */
  fieldIds: string[];
  groups: DetailPageGroup[];
  columns?: 1 | 2 | 3;
};

export function emptyDetailPageConfig(): DetailPageConfig {
  return { style: "single", fieldIds: [], groups: [], columns: 1 };
}

export type DisplayValue = string | number | boolean | string[] | AttachmentMeta[] | GeoPoint | null;

export type PublicRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 记录级写保护：锁定时间戳（毫秒），0 / 缺省表示未锁定 */
  lockedAt?: number | null;
  lockedBy?: string | null;
  fields: Record<string, DisplayValue>;
};

export type Comment = {
  id: string;
  recordId: string;
  userId: string;
  userName: string;
  body: string;
  createdAt: number;
};

export type TablePayload = {
  id: string;
  baseId: string;
  name: string;
  fields: Field[];
  views: View[];
  records: PublicRecord[];
};

export type TableSummary = {
  id: string;
  name: string;
};

export type BaseSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tables: TableSummary[];
  timezone?: string;
};

export type FieldDraft = {
  name: string;
  type: FieldType;
  options?: Array<string | { name: string; color?: TagColor }>;
  formula?: string;
  linkTableId?: string;
  max?: number;
  currency?: string;
  prefix?: string;
  lookupLinkFieldId?: string;
  lookupTargetFieldId?: string;
  buttonLabel?: string;
  buttonAction?: ButtonAction;
  /** duplex: auto-create reverse field with this name */
  symmetricFieldName?: string;
  /** option cascade from this select field */
  optionCascade?: {
    targetFieldId: string;
    map: Record<string, string[]>;
  };
  /** text / long_text / email / url / phone: value must be unique within the table */
  unique?: boolean;
};

export type RecordQuery = {
  viewId?: string;
  filters?: Filter[];
  conjunction?: "and" | "or";
  sorts?: Sort[];
  limit?: number;
};

export type SystemRole = "admin" | "member";

export type MemberRole = "owner" | "editor" | "viewer";

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  role: SystemRole;
  disabled: boolean;
  createdAt: number;
  /** MCP Agent 身份（非人类登录用户） */
  kind?: "user" | "agent";
};

export type McpAgentStatus = "pending" | "active" | "disabled" | "rejected";

export type McpAgentBaseGrant = {
  baseId: string;
  baseName?: string;
  role: MemberRole;
};

export type McpAgent = {
  id: string;
  name: string;
  description: string;
  contact: string;
  status: McpAgentStatus;
  /** 明文令牌，仅管理员接口返回，便于随时复制；旧版本创建的 Agent 为 null，需轮换一次。 */
  token: string | null;
  tokenPrefix: string | null;
  lastUsedAt: number | null;
  approvedBy: string | null;
  createdAt: number;
  updatedAt: number;
  bases: McpAgentBaseGrant[];
};

export type BaseMember = {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  createdAt: number;
};

export type AccessTokenSummary = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
};

/** Row/column ACL for advanced permissions */
export type RowAccessRule =
  | { type: "all" }
  | { type: "allow_ids"; recordIds: string[] }
  | { type: "created_by" }
  | { type: "person_in"; fieldId: string }
  | { type: "field_equals"; fieldId: string; value: string }
  | { type: "field_in"; fieldId: string; values: string[] };

export type TableAcl = {
  tableId: string;
  /** @deprecated prefer rowRules; userId -> allowed record ids; empty means all */
  rowAllow?: Record<string, string[]>;
  /** userId -> hidden field ids */
  columnDeny?: Record<string, string[]>;
  /** userId -> row visibility rule */
  rowRules?: Record<string, RowAccessRule>;
};

export type AutomationCondition = {
  fieldId: string;
  op: FilterOp;
  /**
   * 比较值。除普通文本/数字外，日期时间字段还支持相对取值，求值时才解析：
   * today、today+N、today-N（天数）、week_start、week_end、month_start、month_end、
   * now、now+Nh、now-Nh（小时，输出「YYYY-MM-DD HH:MM」）。
   * 例：未来 2 天内到期 = gte today + lte today+2；距今超过 90 天未动 = lt today-90。
   * 注意日期比较按 YYYY-MM-DD 文本比较，空值会被视为「小于任何日期」，需要排除空值请追加 is_not_empty 条件。
   */
  value?: string;
};

export type AutomationTrigger =
  | { type: "record_created" }
  | { type: "record_updated"; fieldId?: string }
  | { type: "field_equals"; fieldId: string; value: string }
  | { type: "button"; fieldId: string }
  | { type: "webhook"; secret?: string }
  | { type: "schedule"; cron: string };

export type AutomationAction =
  /** value 支持绝对日期 YYYY-MM-DD，也支持 today / today+N / today-N 等相对日期（见 AutomationCondition） */
  | { type: "set_field"; fieldId: string; value: string }
  /**
   * 新建记录。默认写入当前表；tableId 填同库另一张表的 id 或名称时写入该表。
   * fields 的值支持 {字段名} / {recordId} / {tableId} 插值，可把当前记录的内容带进新记录。
   */
  | { type: "create_record"; fields: Record<string, string>; tableId?: string }
  | { type: "add_comment"; body: string }
  | { type: "notify"; message: string; userId?: string }
  | { type: "http_request"; url: string; method?: "GET" | "POST" | "PUT" | "PATCH"; headers?: Record<string, string>; body?: string }
  | { type: "send_email"; to: string; subject: string; text: string }
  | { type: "feishu_bot"; text: string; webhookUrl?: string }
  | {
      type: "feishu_digest";
      text?: string;
      daysAhead?: number;
      dateField?: string;
      excludeStatuses?: string[];
      webhookUrl?: string;
    }
  /** 调用站内 LLM 智能体跑一轮（结果写入智能体运行日志） */
  | { type: "run_agent"; agentId: string; prompt: string }
  /** 锁定触发记录（写保护；解锁需手动或 unlock_record） */
  | { type: "lock_record" }
  | { type: "unlock_record" };

export type BaseIntegrations = {
  feishuWebhookUrl?: string;
};

export type CalendarFeed = {
  id: string;
  tableId: string;
  token: string;
  dateFieldId: string | null;
  titleFieldId: string | null;
  enabled: boolean;
  createdAt: number;
};

export type AutomationRunStatus = "ok" | "failed" | "skipped";

export type AutomationRun = {
  id: string;
  automationId: string;
  tableId: string;
  /** 触发方式：record_created / record_updated / field_equals / button / webhook / schedule */
  trigger: string;
  /** ok：至少一个动作真正送达；failed：有动作失败；skipped：全部动作被跳过（例如未配置飞书 Webhook） */
  status: AutomationRunStatus;
  /** 每个动作的结果摘要，用于界面展示与排障 */
  detail: string;
  recordId: string | null;
  createdAt: number;
};

export type Automation = {
  id: string;
  tableId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** all conditions must match (AND) before actions run */
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  createdAt: number;
  /** 最近一次尝试运行的时间（无论成功、失败还是跳过） */
  lastAttemptAt: number;
  /** 最近一次真正成功运行的时间（跳过与失败不更新） */
  lastRunAt: number;
  /** 最近一次运行状态；从未运行过为 null */
  lastStatus: AutomationRunStatus | null;
  /** 最近一次运行的结果摘要 */
  lastDetail: string | null;
};

/* ——— 站内 LLM 智能体（多维表格智能体） ——— */

/** tools：可调工具的多轮 Agent；prompt：单次生成文本，不调工具 */
export type LlmAgentMode = "tools" | "prompt";

export type LlmAgentStatus = "enabled" | "disabled";

export const LLM_AGENT_TOOLS = [
  "list_tables",
  "get_table_schema",
  "query_records",
  "create_record",
  "update_record",
  "add_comment",
] as const;

export type LlmAgentToolId = (typeof LLM_AGENT_TOOLS)[number];

export const LLM_AGENT_TOOL_LABELS: Record<LlmAgentToolId, string> = {
  list_tables: "列空间与数据表",
  get_table_schema: "读字段与视图",
  query_records: "查记录（只读）",
  create_record: "新建记录",
  update_record: "改记录",
  add_comment: "给记录写评论",
};

/** LLM Provider 配置：OpenAI 兼容的 Chat Completions */
export type LlmProviderConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
};

export type LlmAgent = {
  id: string;
  name: string;
  description: string;
  /** 绑定空间；null 表示按触发者可见范围 */
  baseId: string | null;
  baseName?: string;
  /** 任务指令（系统提示词） */
  instructions: string;
  mode: LlmAgentMode;
  tools: LlmAgentToolId[];
  provider: LlmProviderConfig;
  /** 密钥是否已配置（接口不返回明文） */
  apiKeySet: boolean;
  /** 脱敏后的密钥提示，例如 sk-…cdef */
  apiKeyHint: string | null;
  /** 定时/事件触发时使用的服务身份（创建者） */
  ownerUserId: string;
  ownerName?: string;
  status: LlmAgentStatus;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastRunStatus: LlmAgentRunStatus | null;
  runCount: number;
};

export type LlmAgentRunStatus = "running" | "ok" | "failed";

export type LlmAgentRunStep = {
  /** 工具名；prompt 模式为空数组 */
  tool: string;
  args: string;
  result: string;
  status: "ok" | "failed";
  ms: number;
};

export type LlmAgentRunTrigger = "chat" | "schedule" | "manual" | "retry" | "api" | "automation";

export type LlmAgentRun = {
  id: string;
  agentId: string;
  agentName?: string;
  trigger: LlmAgentRunTrigger;
  status: LlmAgentRunStatus;
  /** 触发输入（用户问题或定时 prompt） */
  input: string;
  output: string;
  error: string | null;
  steps: LlmAgentRunStep[];
  tableId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: number;
  finishedAt: number;
  durationMs: number;
};

export type Notification = {
  id: string;
  userId: string;
  baseId: string;
  tableId: string;
  recordId: string | null;
  message: string;
  read: boolean;
  createdAt: number;
};

export type ShareLink = {
  id: string;
  recordId: string;
  tableId: string;
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
};

/** Public share for a view (readonly) or form (submit). */
export type PublicShareKind = "view" | "form";

export type PublicShare = {
  id: string;
  kind: PublicShareKind;
  tableId: string;
  viewId: string | null;
  token: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
};

export type AppPortalWidget =
  | { id: string; type: "list"; tableId: string; title?: string; limit?: number; titleFieldId?: string }
  | { id: string; type: "image"; tableId: string; title?: string; attachmentFieldId: string; limit?: number }
  | { id: string; type: "tags"; tableId: string; title?: string; fieldId: string };

export type AppPortalConfig = {
  title?: string;
  theme?: "light" | "blue" | "green";
  navTableIds?: string[];
  hideChrome?: boolean;
  widgets?: AppPortalWidget[];
};

export type ChartType = "bar" | "pie" | "count" | "line" | "donut";

export type DashboardChart = {
  id: string;
  title: string;
  type: ChartType;
  tableId: string;
  fieldId: string;
};

export type DashboardSlicer = {
  id: string;
  tableId: string;
  fieldId: string;
  title?: string;
};

export type DashboardConfig = {
  charts: DashboardChart[];
  slicers?: DashboardSlicer[];
};

/** Workflow: ordered nodes trigger → condition* → approval* → action* */
export type ApprovalStrategy = "any" | "all";

export type WorkflowNode =
  | { id: string; type: "trigger"; trigger: AutomationTrigger }
  | { id: string; type: "condition"; conditions: AutomationCondition[]; conjunction?: "and" | "or" }
  | { id: string; type: "action"; action: AutomationAction }
  | {
      id: string;
      type: "approval";
      /** 审批人：用户 id 或显示名；空表示任意编辑者可批 */
      approvers: string[];
      label?: string;
      /** any=任一通过；all=全部通过（默认 any） */
      strategy?: ApprovalStrategy;
      /** 超时小时数；到期标记超时并催办 */
      timeoutHours?: number;
      /** 加签后是否强制改为全部通过（默认 true） */
      forceAllAfterAddSign?: boolean;
    };

export type Workflow = {
  id: string;
  tableId: string;
  name: string;
  enabled: boolean;
  nodes: WorkflowNode[];
  createdAt: number;
};

export type WorkflowRunStatus = "pending" | "approved" | "rejected" | "completed" | "timed_out";

export type ApprovalVote = {
  userId: string;
  userName: string;
  decision: "approve" | "reject";
  comment: string | null;
  at: number;
  /** 若为代理投票，记录被代理人 */
  onBehalfOf?: { userId: string; userName: string } | null;
};

export type WorkflowAuditAction =
  | "created"
  | "approve"
  | "reject"
  | "transfer"
  | "add_sign"
  | "timeout"
  | "proxy_approve"
  | "proxy_reject";

export type WorkflowAuditEvent = {
  id: string;
  runId: string;
  tableId: string;
  recordId: string | null;
  action: WorkflowAuditAction;
  actorUserId: string;
  actorUserName: string;
  /** 代理时的被代理人 */
  onBehalfOfUserId: string | null;
  onBehalfOfUserName: string | null;
  detail: string | null;
  createdAt: number;
};

export type ApprovalProxy = {
  id: string;
  userId: string;
  userName: string;
  proxyUserId: string;
  proxyUserName: string;
  /** 限定多维表格；null=不限 */
  baseId: string | null;
  /** 限定工作流；null=不限 */
  workflowId: string | null;
  /** 过期时间戳；null=不过期 */
  expiresAt: number | null;
  updatedAt: number;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  tableId: string;
  recordId: string;
  status: WorkflowRunStatus;
  /** 当前阻塞的审批节点下标 */
  pendingNodeIndex: number;
  /** 当前节点标签（会签进度展示） */
  nodeLabel: string | null;
  approvers: string[];
  strategy: ApprovalStrategy;
  /** 加签后是否已强制 all */
  forceAllAfterAddSign: boolean;
  votes: ApprovalVote[];
  decidedBy: string | null;
  decidedAt: number | null;
  /** 最近一次意见 */
  comment: string | null;
  timeoutAt: number | null;
  timedOut: boolean;
  remindedAt: number | null;
  createdAt: number;
  /** 已投票人（展示用） */
  votedApprovers?: string[];
  /** 尚未投票的指定审批人 */
  pendingApprovers?: string[];
};

export type WorkflowSlaSummary = {
  pendingCount: number;
  timedOutCount: number;
  dueSoonCount: number;
  timedOut: WorkflowRun[];
  dueSoon: WorkflowRun[];
  withinHours: number;
};

export type SyncMode = "full" | "incremental";
export type SyncConflict = "skip_if_target_nonempty" | "overwrite";

export type SyncRunResult = {
  at: number;
  synced: number;
  created: number;
  updated: number;
  skipped: number;
  conflict: SyncConflict;
  mode: SyncMode;
};

export type SyncJob = {
  id: string;
  name: string;
  sourceTableId: string;
  targetTableId: string;
  /** source field name -> target field name */
  fieldMap: Record<string, string>;
  /** 匹配键：源字段名；缺省取 fieldMap 第一个源字段 */
  matchField: string | null;
  mode: SyncMode;
  conflict: SyncConflict;
  enabled: boolean;
  lastRunAt: number | null;
  lastResult: SyncRunResult | null;
  createdAt: number;
};

export type PluginHookEvent = "record_created" | "record_updated" | "record_deleted" | "workflow_ran";

export type PluginHook = {
  id: string;
  name: string;
  event: PluginHookEvent;
  /** webhook URL or local handler id */
  target: string;
  enabled: boolean;
  createdAt: number;
};

export type MarketplacePlugin = {
  id: string;
  name: string;
  description: string;
  kind: "webhook" | "log";
  /** default hook event */
  event: PluginHookEvent;
  /** target template: "log" or "https://..." */
  defaultTarget: string;
  enabled: boolean;
  hookId: string | null;
};

export function emptyViewConfig(): ViewConfig {
  return {
    filters: [],
    conjunction: "and",
    sorts: [],
    groups: [],
    hiddenFieldIds: [],
    groupFieldId: null,
    rowHeight: "medium",
    dateFieldId: null,
    titleFieldId: null,
    endDateFieldId: null,
    progressFieldId: null,
    dependencyFieldId: null,
    colorRules: [],
  };
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "文本",
  long_text: "多行文本",
  number: "数字",
  single_select: "单选",
  multi_select: "多选",
  date: "日期",
  checkbox: "复选框",
  url: "超链接",
  email: "邮箱",
  phone: "电话",
  person: "人员",
  rating: "评分",
  progress: "进度",
  currency: "货币",
  auto_number: "自动编号",
  created_time: "创建时间",
  updated_time: "修改时间",
  created_by: "创建人",
  formula: "公式",
  link: "关联",
  duplex_link: "双向关联",
  lookup: "查找引用",
  button: "按钮",
  attachment: "附件",
  barcode: "条码",
  geolocation: "地理位置",
  signature: "签字",
  group: "群组",
};

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  grid: "表格",
  kanban: "看板",
  calendar: "日历",
  gallery: "画册",
  form: "表单",
  gantt: "甘特",
};

/* ——— 文档（Markdown 长文）：实验前思考 / 实验后复盘 ——— */

export type DocumentKind = "doc" | "folder";

/** 列表 / 侧边栏用的文档摘要，不含正文，避免拉全量长文。 */
export type DocumentSummary = {
  id: string;
  baseId: string;
  parentId: string | null;
  kind: DocumentKind;
  title: string;
  icon: string | null;
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** 正文字符数，用于列表显示体量。 */
  bodyLength: number;
  /** 子节点数量（文件夹用）。 */
  childCount: number;
  /** 关联的实验记录条数。 */
  linkCount: number;
};

export type DocumentDetail = {
  id: string;
  baseId: string;
  parentId: string | null;
  kind: DocumentKind;
  title: string;
  icon: string | null;
  position: number;
  bodyMd: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  links: DocumentRecordLink[];
};

/** 文档与实验记录的挂靠关系。label 便于区分「实验前思考」「实验复盘」。 */
export type DocumentRecordLink = {
  documentId: string;
  recordId: string;
  tableId: string;
  label: string | null;
  createdAt: number;
  /** 便于展示：记录所在清单名。 */
  tableName?: string;
  /** 便于展示：记录的标题（首个文本字段）。 */
  recordTitle?: string;
};

export type DocumentRevision = {
  id: string;
  documentId: string;
  title: string;
  bodyMd: string;
  userId: string;
  userName: string;
  createdAt: number;
};

/** 记录详情页「相关文档」用的轻量条目。 */
export type RecordDocumentLink = {
  id: string;
  baseId: string;
  title: string;
  kind: DocumentKind;
  icon: string | null;
  label: string | null;
  updatedAt: number;
};

export type DocumentTemplate = {
  id: string;
  name: string;
  description: string;
  title: string;
  bodyMd: string;
};

export const DOC_TEMPLATES: DocumentTemplate[] = [
  {
    id: "experiment-plan",
    name: "实验前思考",
    description: "要回答的问题、假设、变量设计、成功判据与风险。",
    title: "实验前思考",
    bodyMd: `# 实验前思考

## 要回答的问题

-

## 假设

-

## 变量与设计

- 自变量：
- 因变量：
- 控制变量：
- 对照与重复：

## 成功 / 失败的判据

-

## 风险与备选方案

-
`,
  },
  {
    id: "experiment-review",
    name: "实验后复盘",
    description: "结论、关键数据、意外与偏差、原因分析、下一步。",
    title: "实验后复盘",
    bodyMd: `# 实验复盘

## 结论

-

## 关键数据

-

## 意外与偏差

-

## 原因分析

-

## 下一步

-
`,
  },
  {
    id: "research-note",
    name: "研究笔记",
    description: "自由体：背景、要点、待办。",
    title: "研究笔记",
    bodyMd: `# 研究笔记

## 背景

-

## 要点

-

## 待办

- [ ]
`,
  },
  {
    id: "feasibility-report",
    name: "可行性速报",
    description: "72 小时冲刺产物，不超过两页：三段对三天（数据探针 / 基线参考 / MVE 与结论）。",
    title: "可行性速报",
    bodyMd: `# 可行性速报

> 不超过两页。三段对三天：数据探针 → 基线参考 → MVE 结果与结论。到点就停，无论做到哪一步。

## 一、数据探针记录（第 1 天）

- 目标数据的可及性：
- 下载耗时 / 样本规模：
- 许可与使用限制：

## 二、基线参考指标（第 2 天）

- 参照工作与评测协议：
- 基线指标：
- 与近作对比的预算对齐情况：

## 三、MVE 结果与结论（第 3 天）

- 最小可行实验设计：
- 结果与证伪条件对照：
- 结论：继续 / 修订后再冲 / 果断放弃
- 第一个卡壳点：
`,
  },
  {
    id: "abandon-memo",
    name: "放弃备忘录",
    description: "一次放弃的存档：已验证的事实、被证伪的假设、遗留线索（禁空）与下次启用条件。",
    title: "放弃备忘录",
    bodyMd: `# 放弃备忘录

> 放弃不是失败，是把负结果转成下一个选题的资产。「遗留线索」是唯一不允许为空的字段。

## 已验证的事实

-

## 被证伪的假设

-

## 遗留线索（必填）

-

## 下次启用条件

-
`,
  },
  {
    id: "taxonomy-note",
    name: "分类学说明",
    description: "综述/开题的分类学正文：每个类别的判据与边界案例；分类学只在此文档与聚类方案表维护。",
    title: "分类学说明",
    bodyMd: `# 分类学说明

> 单一事实来源：分类学只在本文档与 \`07 聚类方案\` 维护；论文正文里的分类表述从表回填，不另立类别名。

## 主类别

### 类别 1

- 名称：
- 可操作判据：
- 边界案例：

### 类别 2

- 名称：
- 可操作判据：
- 边界案例：

## 交叉与例外

- 交叉工作：
- 暂不归类：

## 变更记录

-
`,
  },
  {
    id: "paper-draft",
    name: "论文初稿",
    description: "八道工序小节骨架；每完成一道工序回头修订一次摘要（摘要修订轮次 +1）。",
    title: "论文初稿",
    bodyMd: `# 论文初稿

> 按八道工序推进；每完成一道工序回头修订一次摘要，并在 \`稿件.摘要修订轮次\` 上 +1。

## ① 标题与一句话贡献

## ② 摘要

## ③ 图表

## ④ 方法

## ⑤ 实验

## ⑥ 引言

## ⑦ 相关工作

## ⑧ 结论
`,
  },
  {
    id: "disclosure-statement",
    name: "披露声明",
    description: "AI 使用披露声明的三个粒度（A 工具性 / B 实质性 / C 方法学），四要素齐备。",
    title: "披露声明",
    bodyMd: `# 披露声明

> 位置：致谢之后、参考文献之前。英文期刊用英文声明；有官方句式以官方为准；时态用过去时。
> 每一句都要能在 \`AI 使用日志\` 里找到对应行；每更换一次投稿目标，按新政策重新核对格式与位置。

## 模板 A · 仅工具性润色

在本文写作过程中，作者使用了【工具名称及版本】辅助进行语言润色与语法检查。该工具未参与研究设计、数据分析与内容创作。论文全部内容由作者撰写并审定，作者对本文内容承担完全责任。

## 模板 B · 含实质性辅助

在本文写作过程中，作者使用了【工具名称及版本】辅助完成以下工作：【逐条如实列举：环节 + 涉及位置】。所有 AI 生成的内容均经作者逐句审核、修改与确认，其中涉及的文献与数据已由作者对照原始来源逐一核验。作者对本文全部内容承担完全责任。

## 模板 C · 方法学中使用 AI（须进方法节）

- 模型名称与版本：
- 访问方式与时间：
- 完整提示词：
- 人工校验流程与抽样比例：

## 投稿前自检

- [ ] 四要素齐备：工具、用途、范围、核查承诺
- [ ] 两头都不失信：没漏报，也没夸大
- [ ] 与目标出版方现行政策（或编辑书面答复）一致
`,
  },
  {
    id: "cover-letter",
    name: "Cover Letter",
    description: "投稿信四段结构（问题 / 方法 / 结果 / 适配），≤1 页 300–400 词，三个写作纪律在头部。",
    title: "Cover Letter",
    bodyMd: `# Cover Letter

> 回答一个问题：为什么这篇论文值得占用本刊三位审稿人的时间。
> 三条纪律：① 数字与摘要逐字一致；② 适配段必须引用该刊近期真实发表的同类论文；③ 不出现「重大突破」「国际领先」这类自我评价。全文不超过一页，300–400 词。

## 一、问题（Problem）

## 二、方法（Method）

## 三、结果（Results）

## 四、适配（Fit）

## 提交前自检

- [ ] 数字与摘要逐字一致
- [ ] 适配段引用了真实文献
- [ ] 全文无自我评价词
- [ ] ≤ 1 页 / 300–400 词
`,
  },
  {
    id: "response-letter",
    name: "回应信",
    description: "审稿意见逐条回应：四段结构（感谢 / 重述 / 行动 / 定位），与修改稿同步冻结。",
    title: "回应信",
    bodyMd: `# 回应信

> 每条意见按四段结构回应：感谢 → 重述 → 行动 → 定位。意见原文逐字引用，不改写。
> 修改处标蓝并给出坐标（第 X 节第 Y 段 / 表 Z / 修改稿第 N 页）；回应信与修改稿同步冻结后再提交。

## 对第 1 条意见的回应

- 意见原文（逐字引用）：
- **感谢**：
- **重述**：
- **行动**：
- **定位**：

## 对第 2 条意见的回应

- 意见原文（逐字引用）：
- **感谢**：
- **重述**：
- **行动**：
- **定位**：

## 冻结前自检

- [ ] 每条意见都有完整四段
- [ ] 所有坐标与修改稿页码、图表编号核对一致
- [ ] 事实核查：技术陈述逐句对照修改记录
- [ ] 语气通读：不会在学术会议上当面对人说的话已删掉
`,
  },
];

export function findDocTemplate(id: string | null | undefined): DocumentTemplate | null {
  if (!id) return null;
  return DOC_TEMPLATES.find((item) => item.id === id) ?? null;
}

