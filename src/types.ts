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
  | { type: "add_comment"; body: string };

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
  /** optional field display order for this view */
  fieldOrder?: string[];
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
  | { type: "set_field"; fieldId: string; value: string }
  | { type: "create_record"; fields: Record<string, string> }
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
    };

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
    fieldOrder: [],
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
