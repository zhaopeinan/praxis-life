import type {
  AccessTokenSummary,
  Automation,
  BaseMember,
  BaseSummary,
  Comment,
  DocumentDetail,
  DocumentRevision,
  DocumentSummary,
  Field,
  McpAgent,
  PublicRecord,
  PublicUser,
  RecordDocumentLink,
  TablePayload,
  View,
  ViewType,
} from "../../src/types.js";

export type BackupSettingsDto = {
  enabled: boolean;
  davUrl: string;
  username: string;
  hasPassword: boolean;
  remotePath: string;
  hour: number;
  minute: number;
  keepDays: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

export type BackupLogDto = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "error";
  message: string;
  fileName: string | null;
  fileSize: number | null;
  remotePath: string | null;
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(data.error || "请求失败", response.status);
  return data as T;
}

export const api = {
  me: async () => (await request<{ user: PublicUser }>("/api/auth/me")).user,
  bootstrapStatus: () => request<{ needsBootstrap: boolean }>("/api/auth/bootstrap-status"),
  bootstrap: (body: { name: string; email: string; password: string }) =>
    request<{ user: PublicUser }>("/api/auth/bootstrap", { method: "POST", body: JSON.stringify(body) }),
  captcha: () =>
    request<{ captchaId: string; svg: string; devAnswer?: string }>("/api/auth/captcha"),
  login: (body: {
    email: string;
    password?: string;
    code?: string;
    captchaId: string;
    captcha: string;
  }) => request<{ user: PublicUser }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  bases: () => request<BaseSummary[]>("/api/bases"),
  createBase: (name: string) => request<BaseSummary>("/api/bases", { method: "POST", body: JSON.stringify({ name }) }),
  renameBase: (baseId: string, name: string) =>
    request<BaseSummary>(`/api/bases/${baseId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteBase: (baseId: string) => request(`/api/bases/${baseId}`, { method: "DELETE" }),
  templates: () => request<Array<{ id: string; name: string; description: string }>>("/api/templates"),
  createTemplate: (template: string) => request<BaseSummary>(`/api/templates/${template}`, { method: "POST" }),
  members: (baseId: string) => request<BaseMember[]>(`/api/bases/${baseId}/members`),
  share: (baseId: string, email: string, role: string) =>
    request<BaseMember[]>(`/api/bases/${baseId}/members`, {
      method: "PUT",
      body: JSON.stringify({ email, role }),
    }),
  unshare: (baseId: string, userId: string) =>
    request<BaseMember[]>(`/api/bases/${baseId}/members/${userId}`, { method: "DELETE" }),
  users: () => request<PublicUser[]>("/api/users"),
  createUser: (body: { name: string; email: string; password: string; role?: string }) =>
    request<PublicUser>("/api/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (userId: string, patch: { name?: string; role?: string; disabled?: boolean; password?: string }) =>
    request<PublicUser>(`/api/users/${userId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  mcpAgents: () => request<McpAgent[]>("/api/mcp-agents"),
  createMcpAgent: (body: {
    name: string;
    description?: string;
    contact?: string;
    bases?: Array<{ baseId: string; role: string }>;
  }) =>
    request<{ agent: McpAgent; token: string }>("/api/mcp-agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMcpAgent: (
    agentId: string,
    patch: {
      name?: string;
      description?: string;
      contact?: string;
      status?: string;
      bases?: Array<{ baseId: string; role: string }>;
    },
  ) => request<McpAgent>(`/api/mcp-agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  approveMcpAgent: (agentId: string, bases?: Array<{ baseId: string; role: string }>) =>
    request<{ agent: McpAgent; token: string }>(`/api/mcp-agents/${agentId}/approve`, {
      method: "POST",
      body: JSON.stringify(bases ? { bases } : {}),
    }),
  rotateMcpAgentToken: (agentId: string) =>
    request<{ agent: McpAgent; token: string }>(`/api/mcp-agents/${agentId}/rotate-token`, { method: "POST" }),
  deleteMcpAgent: (agentId: string) => request(`/api/mcp-agents/${agentId}`, { method: "DELETE" }),
  tokens: () => request<AccessTokenSummary[]>("/api/tokens"),
  createToken: (name: string) =>
    request<{ token: string; summary: AccessTokenSummary }>("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteToken: (tokenId: string) => request(`/api/tokens/${tokenId}`, { method: "DELETE" }),
  getTable: (tableId: string) => request<TablePayload>(`/api/tables/${tableId}`),
  createTable: (baseId: string, body: { name: string; fields?: Array<{ name: string; type: string; options?: string[] }>; withKanban?: boolean }) =>
    request<TablePayload>(`/api/bases/${baseId}/tables`, { method: "POST", body: JSON.stringify(body) }),
  renameTable: (tableId: string, name: string) =>
    request<TablePayload>(`/api/tables/${tableId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteTable: (tableId: string) => request(`/api/tables/${tableId}`, { method: "DELETE" }),
  createField: (
    tableId: string,
    body: {
      name: string;
      type: string;
      options?: string[];
      formula?: string;
      linkTableId?: string;
      max?: number;
      currency?: string;
      prefix?: string;
      lookupLinkFieldId?: string;
      lookupTargetFieldId?: string;
      buttonLabel?: string;
      buttonAction?: { type: string; fieldId?: string; value?: string; url?: string; body?: string };
      symmetricFieldName?: string;
    },
  ) => request<Field>(`/api/tables/${tableId}/fields`, { method: "POST", body: JSON.stringify(body) }),
  updateField: (
    fieldId: string,
    body: {
      name?: string;
      options?: string[];
      formula?: string;
      linkTableId?: string;
      buttonLabel?: string;
      buttonAction?: { type: string; fieldId?: string; value?: string; url?: string; body?: string };
      optionCascade?: { targetFieldId: string; map: Record<string, string[]> } | null;
    },
  ) => request<Field>(`/api/fields/${fieldId}`, { method: "PATCH", body: JSON.stringify(body) }),
  changeFieldType: (fieldId: string, type: string) =>
    request<Field>(`/api/fields/${fieldId}/change-type`, { method: "POST", body: JSON.stringify({ type }) }),
  fieldChangeTargets: (fieldId: string) =>
    request<{ targets: string[] }>(`/api/fields/${fieldId}/change-targets`),
  deleteField: (fieldId: string) => request(`/api/fields/${fieldId}`, { method: "DELETE" }),
  limits: () =>
    request<{
      description: string;
      tablesPerBase: number;
      fieldsPerTable: number;
      viewsPerTable: number;
      cellCaps: Array<{ type: string; cap: string }>;
    }>("/api/limits"),
  assistantQuery: (tableId: string, question: string) =>
    request<{ answer: string; suggestions: string[] }>("/api/assistant/query", {
      method: "POST",
      body: JSON.stringify({ tableId, question }),
    }),
  createRecord: (tableId: string, fields: Record<string, unknown>) =>
    request<{ record: PublicRecord; fields: Field[] }>(`/api/tables/${tableId}/records`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    }),
  updateRecord: (recordId: string, fields: Record<string, unknown>) =>
    request<{ record: PublicRecord; fields: Field[] }>(`/api/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ fields }),
    }),
  deleteRecord: (recordId: string) => request(`/api/records/${recordId}`, { method: "DELETE" }),
  createView: (
    tableId: string,
    body: {
      name: string;
      type: ViewType;
      groupField?: string;
      dateField?: string;
      titleField?: string;
      endDateField?: string;
      progressField?: string;
      dependencyField?: string;
    },
  ) => request<View>(`/api/tables/${tableId}/views`, { method: "POST", body: JSON.stringify(body) }),
  updateView: (viewId: string, body: { name?: string; config?: View["config"] }) =>
    request<View>(`/api/views/${viewId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteView: (viewId: string) => request(`/api/views/${viewId}`, { method: "DELETE" }),
  exportCsv: async (tableId: string) => {
    const response = await fetch(`/api/tables/${tableId}/export.csv`, { credentials: "include" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error || "导出失败", response.status);
    }
    return response.text();
  },
  importCsv: (tableId: string, csv: string) =>
    request<{ imported: number }>(`/api/tables/${tableId}/import.csv`, {
      method: "POST",
      body: JSON.stringify({ csv }),
    }),
  comments: (recordId: string) => request<Comment[]>(`/api/records/${recordId}/comments`),
  addComment: (recordId: string, body: string) =>
    request<Comment>(`/api/records/${recordId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
  deleteComment: (commentId: string) => request(`/api/comments/${commentId}`, { method: "DELETE" }),
  history: (recordId: string) =>
    request<Array<{ id: string; action: string; userName: string | null; patch: Record<string, unknown>; createdAt: number }>>(
      `/api/records/${recordId}/history`,
    ),
  automations: (tableId: string) => request<Automation[]>(`/api/tables/${tableId}/automations`),
  createAutomation: (
    tableId: string,
    body: {
      name: string;
      trigger: Automation["trigger"];
      actions: Automation["actions"];
      conditions?: Automation["conditions"];
      enabled?: boolean;
    },
  ) => request<Automation>(`/api/tables/${tableId}/automations`, { method: "POST", body: JSON.stringify(body) }),
  updateAutomation: (automationId: string, body: Partial<Automation>) =>
    request<Automation>(`/api/automations/${automationId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAutomation: (automationId: string) => request(`/api/automations/${automationId}`, { method: "DELETE" }),
  getSettings: (baseId: string) =>
    request<{
      timezone: string;
      integrations?: { feishuWebhookUrl?: string };
      portal: {
        title?: string;
        theme?: string;
        navTableIds?: string[];
        hideChrome?: boolean;
        widgets?: Array<{
          id: string;
          type: "list" | "tags" | "image";
          tableId: string;
          title?: string;
          fieldId?: string;
          attachmentFieldId?: string;
          limit?: number;
          titleFieldId?: string;
        }>;
      };
    }>(`/api/bases/${baseId}/settings`),
  updateSettings: (
    baseId: string,
    body: {
      timezone?: string;
      portal?: {
        title?: string;
        theme?: string;
        navTableIds?: string[];
        hideChrome?: boolean;
        widgets?: Array<{
          id: string;
          type: "list" | "tags" | "image";
          tableId: string;
          title?: string;
          fieldId?: string;
          attachmentFieldId?: string;
          limit?: number;
          titleFieldId?: string;
        }>;
      };
      integrations?: { feishuWebhookUrl?: string };
    },
  ) => request(`/api/bases/${baseId}/settings`, { method: "PATCH", body: JSON.stringify(body) }),
  testFeishu: (baseId: string, body?: { text?: string; webhookUrl?: string }) =>
    request<{ ok: true }>(`/api/bases/${baseId}/feishu-test`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  calendarFeeds: (tableId: string) =>
    request<Array<{ id: string; token: string; dateFieldId: string | null; enabled: boolean }>>(
      `/api/tables/${tableId}/calendar-feeds`,
    ),
  createCalendarFeed: (tableId: string, body?: { dateFieldId?: string; titleFieldId?: string }) =>
    request<{ id: string; token: string }>(`/api/tables/${tableId}/calendar-feeds`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  deleteCalendarFeed: (feedId: string) => request(`/api/calendar-feeds/${feedId}`, { method: "DELETE" }),
  sendFeishuDigest: (tableId: string) =>
    request<{ sent: boolean; count: number }>(`/api/tables/${tableId}/feishu-digest`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  dashboards: (baseId: string) =>
    request<Array<{ id: string; name: string; config: unknown }>>(`/api/bases/${baseId}/dashboards`),
  createDashboard: (baseId: string, body: { name: string; config?: unknown }) =>
    request<{ id: string; name: string; config: unknown }>(`/api/bases/${baseId}/dashboards`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getDashboard: (dashboardId: string, slicers?: Record<string, string[]>) => {
    const q = slicers ? `?slicers=${encodeURIComponent(JSON.stringify(slicers))}` : "";
    return request<{
      id: string;
      name: string;
      charts: Array<{ id: string; title: string; type: string; labels: string[]; values: number[] }>;
      slicers: Array<{ id: string; title: string; tableId: string; fieldId: string; options: string[] }>;
    }>(`/api/dashboards/${dashboardId}${q}`);
  },
  updateDashboard: (dashboardId: string, body: { name?: string; config?: unknown }) =>
    request<{ id: string; name: string; config: unknown }>(`/api/dashboards/${dashboardId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  setViewProtection: (viewId: string, protection: "public" | "locked" | "personal") =>
    request(`/api/views/${viewId}/protection`, { method: "POST", body: JSON.stringify({ protection }) }),
  getDetailPage: (tableId: string) =>
    request<{
      style: "single" | "multi" | "grouped";
      fieldIds: string[];
      groups: Array<{ id: string; title: string; fieldIds: string[] }>;
      columns?: number;
    }>(`/api/tables/${tableId}/detail-page`),
  setDetailPage: (
    tableId: string,
    body: {
      style: "single" | "multi" | "grouped";
      fieldIds: string[];
      groups: Array<{ id: string; title: string; fieldIds: string[] }>;
      columns?: 1 | 2 | 3;
    },
  ) => request(`/api/tables/${tableId}/detail-page`, { method: "PUT", body: JSON.stringify(body) }),
  clickButton: (recordId: string, fieldId: string) =>
    request<{ ok: true; detail?: string }>(`/api/records/${recordId}/buttons/${fieldId}`, { method: "POST" }),
  upload: (filename: string, contentBase64: string, mime?: string, opts?: { baseId?: string; minRole?: string }) =>
    request<{ id: string; name: string; url: string; mime?: string; size: number }>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ filename, contentBase64, mime, baseId: opts?.baseId, minRole: opts?.minRole }),
    }),
  deleteUpload: (uploadId: string) => request(`/api/uploads/${uploadId}`, { method: "DELETE" }),
  documents: (baseId: string, q?: string) =>
    request<DocumentSummary[]>(`/api/bases/${baseId}/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createDocument: (
    baseId: string,
    body: { title?: string; parentId?: string | null; kind?: "doc" | "folder"; bodyMd?: string; template?: string | null },
  ) => request<DocumentDetail>(`/api/bases/${baseId}/documents`, { method: "POST", body: JSON.stringify(body) }),
  getDocument: (documentId: string) => request<DocumentDetail>(`/api/documents/${documentId}`),
  updateDocument: (documentId: string, patch: { title?: string; bodyMd?: string; icon?: string | null }) =>
    request<DocumentDetail>(`/api/documents/${documentId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveDocument: (documentId: string, parentId: string | null, position?: number) =>
    request<DocumentDetail>(`/api/documents/${documentId}/move`, {
      method: "POST",
      body: JSON.stringify({ parentId, position }),
    }),
  deleteDocument: (documentId: string) => request(`/api/documents/${documentId}`, { method: "DELETE" }),
  documentRevisions: (documentId: string) =>
    request<DocumentRevision[]>(`/api/documents/${documentId}/revisions`),
  restoreDocumentRevision: (documentId: string, revisionId: string) =>
    request<DocumentDetail>(`/api/documents/${documentId}/revisions/${revisionId}/restore`, { method: "POST" }),
  linkDocumentRecord: (documentId: string, recordId: string, label?: string | null) =>
    request<DocumentDetail>(`/api/documents/${documentId}/records`, {
      method: "POST",
      body: JSON.stringify({ recordId, label }),
    }),
  unlinkDocumentRecord: (documentId: string, recordId: string) =>
    request<DocumentDetail>(`/api/documents/${documentId}/records/${recordId}`, { method: "DELETE" }),
  recordDocuments: (recordId: string) =>
    request<RecordDocumentLink[]>(`/api/records/${recordId}/documents`),
  backupStatus: () =>
    request<{
      settings: BackupSettingsDto;
      logs: BackupLogDto[];
    }>("/api/system/backup"),
  updateBackup: (body: {
    enabled?: boolean;
    davUrl?: string;
    username?: string;
    password?: string;
    remotePath?: string;
    hour?: number;
    minute?: number;
    keepDays?: number;
  }) => request<{ settings: BackupSettingsDto }>("/api/system/backup", {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  testBackup: () => request<{ ok: true; url: string; remotePath: string }>("/api/system/backup/test", { method: "POST" }),
  runBackup: () => request<{ log: BackupLogDto }>("/api/system/backup/run", { method: "POST" }),
};

