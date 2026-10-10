import { useEffect, useMemo, useRef, useState } from "react";
import { applyQuery } from "../../src/query.js";
import type { Automation, AutomationRun, BaseMember, BaseSummary, DisplayValue, DocumentSummary, Field, LlmAgent, LlmAgentRun, LlmAgentToolId, McpAgent, PublicRecord, PublicUser, RecordDocumentLink, TablePayload, View, ViewType } from "../../src/types.js";
import { DOC_TEMPLATES, FIELD_TYPE_LABELS, LLM_AGENT_TOOL_LABELS, LLM_AGENT_TOOLS, VIEW_TYPE_LABELS } from "../../src/types.js";
import { api, type BackupLogDto, type BackupSettingsDto } from "./api";
import { AuthScreen } from "./AuthScreen";
import { DashboardView } from "./DashboardView";
import { DocumentsView, DocumentTree } from "./DocumentsView";
import { CalendarView, GalleryView, GanttView } from "./ExtraViews";
import { Cell, GridView } from "./GridView";
import { KanbanView } from "./KanbanView";
import { BottomBar, MobileAgenda, MobileKanban, RecordCardList } from "./mobile";
import { PaneHandle, readFlag, readList, usePaneWidth, writeFlag, writeList } from "./paneResize";
import { StageEmpty } from "./StageEmpty";
import { DEFAULT_STATUS_FIELD, DEFAULT_STATUS_OPTIONS, pickStatusField } from "./statusField";
import { DropMenu, FancySelect, useMediaQuery } from "./ui";

const FIELD_TYPES = (Object.keys(FIELD_TYPE_LABELS) as Field["type"][]).map((id) => ({
  id,
  label: FIELD_TYPE_LABELS[id],
}));

/**
 * 新建字段时优先给的常用类型。线上数据里实际被用过的只有文本 / 单选 / 日期 / 多行 /
 * 关联 / 数字 / 人员 / 进度 这几种；公式、查找引用、条码、签字等收进「更多类型」，
 * 避免 29 个选项平铺造成选择过载。
 */
const COMMON_FIELD_TYPES: ReadonlyArray<Field["type"]> = [
  "text",
  "long_text",
  "number",
  "single_select",
  "multi_select",
  "date",
  "checkbox",
  "person",
  "progress",
  "link",
];

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="boot">正在打开知行人生…</div>;
  if (!user) return <AuthScreen onUser={setUser} />;
  return <Workspace user={user} onUser={setUser} onLogout={() => setUser(null)} />;
}

function Workspace({ user, onUser, onLogout }: { user: PublicUser; onUser: (user: PublicUser) => void; onLogout: () => void }) {
  const [bases, setBases] = useState<BaseSummary[]>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [payload, setPayload] = useState<TablePayload | null>(null);
  const [members, setMembers] = useState<BaseMember[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<string | null>(null);
  const [optionField, setOptionField] = useState<Field | null>(null);
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [kanbanPrompt, setKanbanPrompt] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  // 文档页的栏目布局偏好：宽度走 CSS 变量（拖拽时不触发重渲染），收起态走 state。
  const appRef = useRef<HTMLDivElement>(null);
  const [navCollapsed, setNavCollapsed] = useState(() => readFlag("duowei:ui:nav-collapsed"));
  const [docsSideCollapsed, setDocsSideCollapsed] = useState(() => readFlag("duowei:ui:docs-side-collapsed"));
  // 侧边栏里哪些空间是展开的。默认全部收起，只列空间名，避免一屏塞满清单。
  const [openBases, setOpenBases] = useState<string[]>(() => readList("duowei:ui:open-bases"));
  const navPane = usePaneWidth({
    storageKey: "duowei:ui:nav-width",
    defaultWidth: 248,
    min: 200,
    max: 420,
    cssVar: "--nav-w",
    varTargetRef: appRef,
  });
  const detailPushed = useRef(false);
  const dialogPushed = useRef(false);

  useEffect(() => writeFlag("duowei:ui:nav-collapsed", navCollapsed), [navCollapsed]);
  useEffect(() => writeFlag("duowei:ui:docs-side-collapsed", docsSideCollapsed), [docsSideCollapsed]);
  useEffect(() => writeList("duowei:ui:open-bases", openBases), [openBases]);

  function toggleBase(id: string) {
    setOpenBases((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  }

  function closeDetail() {
    if (detailPushed.current) {
      detailPushed.current = false;
      window.history.back();
    }
    setDetailRecordId(null);
  }

  function closeDialog() {
    if (dialogPushed.current) {
      dialogPushed.current = false;
      window.history.back();
    }
    setDialog(null);
  }

  useEffect(() => {
    if (detailRecordId && !detailPushed.current) {
      detailPushed.current = true;
      window.history.pushState({ dwDetail: true }, "");
    } else if (!detailRecordId) {
      detailPushed.current = false;
    }
  }, [detailRecordId]);

  useEffect(() => {
    if (dialog && !dialogPushed.current) {
      dialogPushed.current = true;
      window.history.pushState({ dwDialog: true }, "");
    } else if (!dialog) {
      dialogPushed.current = false;
    }
  }, [dialog]);

  useEffect(() => {
    function onPopState() {
      if (dialogPushed.current) {
        dialogPushed.current = false;
        setDialog(null);
        return;
      }
      if (detailPushed.current) {
        detailPushed.current = false;
        setDetailRecordId(null);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const base = bases.find((item) => item.id === baseId) ?? null;
  const view = payload?.views.find((item) => item.id === viewId) ?? payload?.views[0] ?? null;
  const docsMode = Boolean(docsOpen && base);
  const myRole = !base
    ? null
    : user.role === "admin"
      ? "owner"
      : members.find((item) => item.userId === user.id)?.role ?? null;
  const canEdit = myRole === "owner" || myRole === "editor";
  const canOwn = myRole === "owner";

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // 正在输入时不要抢按键：Markdown 正文里 [ ] 太常见了。
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key === "\\") {
        event.preventDefault();
        // 有任意一栏打开时全部收起，否则全部恢复。
        const anyOpen = !navCollapsed || (docsMode && !docsSideCollapsed);
        setNavCollapsed(anyOpen);
        if (docsMode) setDocsSideCollapsed(anyOpen);
        return;
      }
      if (!mod && event.key === "[") {
        event.preventDefault();
        setNavCollapsed((value) => !value);
        return;
      }
      if (!mod && event.key === "]" && docsMode) {
        event.preventDefault();
        setDocsSideCollapsed((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docsMode, navCollapsed, docsSideCollapsed]);

  async function refreshBases(prefer?: { baseId?: string | null; tableId?: string | null }) {
    const list = await api.bases();
    setBases(list);
    const nextBase = list.find((item) => item.id === prefer?.baseId) ?? list[0] ?? null;
    const nextTable = nextBase?.tables.find((item) => item.id === prefer?.tableId) ?? nextBase?.tables[0] ?? null;
    setBaseId(nextBase?.id ?? null);
    setTableId(nextTable?.id ?? null);
    if (prefer?.tableId == null || nextTable?.id !== tableId) setViewId(null);
    if (prefer?.baseId !== undefined && prefer.baseId !== nextBase?.id) closeDocs();
  }

  async function reloadTable(id = tableId) {
    if (!id) {
      setPayload(null);
      return;
    }
    const data = await api.getTable(id);
    setPayload(data);
    setViewId((current) => (current && data.views.some((item) => item.id === current) ? current : data.views[0]?.id ?? null));
  }

  async function reloadDocuments(id = baseId) {
    if (!id) {
      setDocuments([]);
      return;
    }
    try {
      setDocuments(await api.documents(id));
    } catch (err) {
      setDocuments([]);
      setError(message(err));
    }
  }

  function openDocument(id: string | null) {
    // 进文档页就把左侧导航栏收起来，把宽度让给正文；文档页内切换文档不再动它（用户可能刚手动展开过）。
    if (!docsOpen) setNavCollapsed(true);
    setDocsOpen(true);
    setDocId(id);
    setViewId(null);
    setShowDashboard(false);
    if (id) setNavOpen(false);
  }

  /** 回到「文档」首页：保留文档树，主区域显示最近更新与新建入口。 */
  function openDocsHome() {
    openDocument(null);
  }

  /** 离开文档页（切清单 / 切空间 / 打开记录时调用）。 */
  function closeDocs() {
    setDocsOpen(false);
    setDocId(null);
  }

  function openRecordFromDocument(recordId: string, targetTableId: string) {
    closeDocs();
    setTableId(targetTableId);
    setViewId(null);
    setDetailRecordId(recordId);
  }

  /** 从记录详情里打开（或新建后打开）文档：先关掉详情，再刷新文档树，最后切到文档页。 */
  async function openDocumentFromRecord(documentId: string) {
    closeDetail();
    if (baseId) await reloadDocuments(baseId);
    openDocument(documentId);
  }

  async function deleteCurrentTable() {
    if (!payload || !canOwn) return;
    const tables = base?.tables ?? [];
    if (
      !window.confirm(
        tables.length <= 1
                          ? `删除清单「${payload.name}」？这是当前空间下的最后一张表，内容都会去掉。`
          : `删除清单「${payload.name}」？表内记录与视图都会去掉。`,
      )
    ) {
      return;
    }
    const remaining = tables.find((item) => item.id !== payload.id);
    await api.deleteTable(payload.id);
    await refreshBases({ baseId, tableId: remaining?.id ?? null });
    if (!remaining) setPayload(null);
  }

  /**
   * 一键转看板。优先级：
   * 1. 已经有看板视图 → 直接切过去（不重复建）；
   * 2. 有单选字段 → 挑一个最像「状态」的，按它建看板并切过去；
   * 3. 一个单选字段都没有 → 弹窗问是否补一个「状态」字段。
   */
  async function convertToKanban() {
    if (!payload || !view) return;
    setError(null);
    try {
      const field = pickStatusField(payload.fields);

      // 当前已经在看板上，只是缺分组字段：直接补上，不再新建视图
      if (view.type === "kanban") {
        if (!field) {
          setKanbanPrompt(true);
          return;
        }
        await patchView(await api.updateView(view.id, { config: { ...view.config, groupFieldId: field.id } }));
        setNotice(`已按「${field.name}」分组。左右拖动卡片即可改状态。`);
        return;
      }

      // 表里已经有看板视图：切过去；若那个看板也没分组，顺手补上
      const existing = payload.views.find((item) => item.type === "kanban");
      if (existing) {
        if (!existing.config.groupFieldId && field) {
          await api.updateView(existing.id, { config: { ...existing.config, groupFieldId: field.id } });
          await reloadTable();
        }
        setViewId(existing.id);
        setNotice(`已切到看板视图「${existing.name}」。左右拖动卡片就能改状态。`);
        return;
      }

      if (!field) {
        setKanbanPrompt(true);
        return;
      }
      const created = await api.createView(payload.id, {
        name: `${field.name}看板`,
        type: "kanban",
        groupField: field.name,
      });
      await reloadTable();
      setViewId(created.id);
      setNotice(`已按「${field.name}」生成看板。左右拖动卡片即可改状态。`);
    } catch (err) {
      fail(err);
    }
  }

  /** 表里没有单选字段时，补一个「状态」字段再转看板 */
  async function createStatusFieldAndKanban() {
    if (!payload) return;
    setKanbanPrompt(false);
    setError(null);
    try {
      const field = await api.createField(payload.id, {
        name: DEFAULT_STATUS_FIELD,
        type: "single_select",
        options: DEFAULT_STATUS_OPTIONS,
      });
      const created = await api.createView(payload.id, {
        name: "看板",
        type: "kanban",
        groupField: field.name,
      });
      await reloadTable();
      setViewId(created.id);
      setNotice(`已新建「${field.name}」字段并生成看板，选项可随时调整。`);
    } catch (err) {
      fail(err);
    }
  }

  function renameCurrentBase(item: BaseSummary) {
    const name = window.prompt("重命名空间", item.name);
    if (!name || name === item.name) return;
    api.renameBase(item.id, name).then(() => refreshBases({ baseId: item.id, tableId })).catch(fail);
  }

  async function deleteCurrentView() {
    if (!payload || !view || !canEdit) return;
    if (view.protection === "locked") {
      setError("锁定视图不可删除，请先改为公共或个人视图");
      return;
    }
    if (payload.views.length <= 1) {
      setError("至少保留一个视图");
      return;
    }
    if (!window.confirm(`删除视图「${view.name}」？`)) return;
    const nextId = payload.views.find((item) => item.id !== view.id)?.id ?? null;
    await api.deleteView(view.id);
    setViewId(nextId);
    await reloadTable();
  }

  useEffect(() => {
    refreshBases().catch((err) => setError(message(err))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (event.target as HTMLElement)?.isContentEditable;
      if (event.key === "Escape") {
        if (dialog) closeDialog();
        else if (detailRecordId) closeDetail();
        else if (showDashboard) setShowDashboard(false);
        else if (navOpen) setNavOpen(false);
        return;
      }
      if (typing || !canEdit || !payload) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setDialog("filter");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, detailRecordId, showDashboard, navOpen, canEdit, payload]);

  useEffect(() => {
    if (!tableId) {
      setPayload(null);
      return;
    }
    let cancel = false;
    setLoading(true);
    api.getTable(tableId)
      .then((data) => {
        if (cancel) return;
        setPayload(data);
        setViewId((current) => (current && data.views.some((item) => item.id === current) ? current : data.views[0]?.id ?? null));
      })
      .catch((err) => {
        if (!cancel) setError(message(err));
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [tableId]);

  useEffect(() => {
    if (!baseId) {
      setMembers([]);
      return;
    }
    api.members(baseId).then(setMembers).catch(() => setMembers([]));
  }, [baseId]);

  useEffect(() => {
    // 换空间时清掉选中的文档：docId 可能残留指向别个空间的文档。
    // docsOpen 保持不动，这样从侧边栏点另一个空间的「文档」还能直接落在文档页。
    setDocId(null);
    if (!baseId) {
      setDocuments([]);
      return;
    }
    let cancel = false;
    api
      .documents(baseId)
      .then((list) => {
        if (!cancel) setDocuments(list);
      })
      .catch(() => {
        if (!cancel) setDocuments([]);
      });
    return () => {
      cancel = true;
    };
  }, [baseId]);

  const visibleFields = useMemo(() => {
    if (!payload || !view) return payload?.fields ?? [];
    const hidden = new Set(view.config.hiddenFieldIds);
    return payload.fields.filter((field) => !hidden.has(field.id));
  }, [payload, view]);

  const records = useMemo(() => {
    if (!payload || !view) return [];
    const queried = applyQuery(payload.records, payload.fields, view.config);
    const keyword = search.trim().toLowerCase();
    if (!keyword) return queried;
    return queried.filter((record) =>
      Object.values(record.fields).some((value) => String(value ?? "").toLowerCase().includes(keyword)),
    );
  }, [payload, view, search]);

  function fail(err: unknown) {
    setError(message(err));
  }

  async function patchView(next: View) {
    setPayload((current) =>
      current ? { ...current, views: current.views.map((item) => (item.id === next.id ? next : item)) } : current,
    );
  }

  async function onSort(fieldId: string) {
    if (!view || !canEdit) return;
    const current = view.config.sorts.find((item) => item.fieldId === fieldId);
    const sorts = !current
      ? [{ fieldId, direction: "asc" as const }]
      : current.direction === "asc"
        ? [{ fieldId, direction: "desc" as const }]
        : [];
    try {
      patchView(await api.updateView(view.id, { config: { ...view.config, sorts } }));
    } catch (err) {
      fail(err);
    }
  }

  async function onChange(recordId: string, fieldName: string, value: unknown) {
    try {
      const field = payload?.fields.find((item) => item.name === fieldName);
      if (field?.type === "button" && value === "__click__") {
        const result = await api.clickButton(recordId, field.id);
        if (result.detail?.startsWith("http")) window.open(result.detail, "_blank");
        await reloadTable();
        return;
      }
      const result = await api.updateRecord(recordId, { [fieldName]: value });
      setPayload((current) =>
        current
          ? {
              ...current,
              fields: result.fields,
              records: current.records.map((record) => (record.id === result.record.id ? result.record : record)),
            }
          : current,
      );
    } catch (err) {
      fail(err);
    }
  }

  const groupField = payload?.fields.find((field) => field.id === view?.config.groupFieldId && field.type === "single_select");
  /** 表里所有能当日期轴的字段，供日历 / 甘特一键配置 */
  const dateFields = payload?.fields.filter((field) => field.type === "date") ?? [];
  const dateField = payload?.fields.find((field) => field.id === view?.config.dateFieldId && field.type === "date") ?? null;
  /** 表里所有能当分组（看板列 / 甘特泳道）的单选字段 */
  const selectFields = payload?.fields.filter((field) => field.type === "single_select") ?? [];
  /** 一键转看板时默认挑中的那个「状态类」单选字段 */
  const kanbanCandidate = payload ? pickStatusField(payload.fields) : null;

  /** 把当前视图的某个配置项改掉（日历/甘特的日期字段、看板分组等） */
  async function patchViewConfig(patch: Partial<View["config"]>) {
    if (!view) return;
    try {
      patchView(await api.updateView(view.id, { config: { ...view.config, ...patch } }));
    } catch (err) {
      fail(err);
    }
  }

  const searchInput = (
    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索记录" aria-label="搜索记录" />
  );
  const filterButton = canEdit && view ? (
    <button type="button" onClick={() => setDialog("filter")}>
      筛选{view.config.filters.length ? ` ${view.config.filters.length}` : ""}
    </button>
  ) : null;
  const gridTuning = payload && view?.type === "grid" && canEdit ? (
    <>
      <label className="inline-select">
        分组
        <FancySelect
          compact
          aria-label="分组"
          value={view.config.groups[0]?.fieldId ?? ""}
          placeholder="无"
          options={[
            { value: "", label: "无" },
            ...payload.fields.map((field) => ({ value: field.id, label: field.name })),
          ]}
          onChange={(fieldId) => {
            api
              .updateView(view.id, {
                config: { ...view.config, groups: fieldId ? [{ fieldId }] : [] },
              })
              .then(patchView)
              .catch(fail);
          }}
        />
      </label>
      <label className="inline-select">
        行高
        <FancySelect
          compact
          aria-label="行高"
          value={view.config.rowHeight}
          options={[
            { value: "short", label: "矮" },
            { value: "medium", label: "中" },
            { value: "tall", label: "高" },
            { value: "extra", label: "超高" },
          ]}
          onChange={(value) => {
            api
              .updateView(view.id, {
                config: {
                  ...view.config,
                  rowHeight: value as View["config"]["rowHeight"],
                },
              })
              .then(patchView)
              .catch(fail);
          }}
        />
      </label>
    </>
  ) : null;
  const kanbanTuning = payload && view?.type === "kanban" && canEdit ? (
    <label className="inline-select">
      看板分组
      <FancySelect
        compact
        aria-label="看板分组"
        value={view.config.groupFieldId ?? ""}
        options={payload.fields
          .filter((field) => field.type === "single_select")
          .map((field) => ({ value: field.id, label: field.name }))}
        onChange={(value) => {
          api
            .updateView(view.id, { config: { ...view.config, groupFieldId: value || null } })
            .then(patchView)
            .catch(fail);
        }}
      />
    </label>
  ) : null;
  const dateTuning = payload && (view?.type === "calendar" || view?.type === "gantt") && canEdit ? (
    <label className="inline-select">
      日期字段
      <FancySelect
        compact
        aria-label="日期字段"
        value={view.config.dateFieldId ?? ""}
        options={payload.fields
          .filter((field) => field.type === "date")
          .map((field) => ({ value: field.id, label: field.name }))}
        onChange={(value) => {
          api
            .updateView(view.id, { config: { ...view.config, dateFieldId: value || null } })
            .then(patchView)
            .catch(fail);
        }}
      />
    </label>
  ) : null;
  // 顶栏只留高频入口；仪表盘、成员分享、导出 / 导入 / 自动化、日历飞书统一收进「更多」。
  const exportCsv = async () => {
    if (!payload) return;
    try {
      const csv = await api.exportCsv(payload.id);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${payload.name}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      fail(err);
    }
  };
  const mainCluster = (
    <div className="toolbar-cluster">
      <button type="button" onClick={() => setDialog("assistant")}>
        数据助手
      </button>
      <DropMenu label="更多" ariaLabel="更多操作">
        {base && (
          <button type="button" onClick={() => setShowDashboard(true)}>
            仪表盘
          </button>
        )}
        {canOwn && <button type="button" onClick={() => setDialog("share")}>分享给成员</button>}
        {base && canEdit && <hr className="menu-sep" />}
        {canEdit && (
          <>
            <button type="button" onClick={exportCsv}>
              导出 CSV
            </button>
            <button type="button" onClick={() => setDialog("import")}>
              导入
            </button>
            <button type="button" onClick={() => setDialog("automations")}>
              自动化
            </button>
          </>
        )}
        {canEdit && payload && <hr className="menu-sep" />}
        {canEdit && payload && (
          <button type="button" onClick={() => setDialog("calendar-feishu")}>日历 / 飞书</button>
        )}
      </DropMenu>
    </div>
  );

  const viewTabs =
    payload?.views.map((item) => (
      <button type="button" key={item.id} className={item.id === view?.id ? "on" : ""} onClick={() => setViewId(item.id)}>
        {item.name}
        {item.protection === "locked" ? " 🔒" : item.protection === "personal" ? " 👤" : ""}
      </button>
    )) ?? null;
  const viewMiscControls = payload && view ? (
    <>
      {canEdit && (
        <button type="button" className="ghost" onClick={() => setDialog("view")}>
          + 视图
        </button>
      )}
      {canEdit && view.type !== "kanban" && (
        <button
          type="button"
          className="ghost"
          title="按状态字段分列，左右拖动卡片即可改状态"
          onClick={() => void convertToKanban()}
        >
          转看板
        </button>
      )}
      {canEdit && (
        <FancySelect
          compact
          aria-label="视图保护"
          value={view.protection ?? "public"}
          options={[
            { value: "public", label: "公共视图" },
            { value: "personal", label: "个人视图" },
          ]}
          onChange={(value) => {
            api
              .setViewProtection(view.id, value as "public" | "locked" | "personal")
              .then(() => reloadTable())
              .catch(fail);
          }}
        />
      )}
      {canEdit && (
        <button
          type="button"
          className="ghost danger-text"
          disabled={view.protection === "locked" || payload.views.length <= 1}
          title={
            view.protection === "locked"
              ? "锁定视图不可删除"
              : payload.views.length <= 1
                ? "至少保留一个视图"
                : "删除当前视图"
          }
          onClick={() => deleteCurrentView().catch(fail)}
        >
          删除视图
        </button>
      )}
      {canEdit && (
        <button type="button" onClick={() => setDialog("detail-page")}>
          详情页
        </button>
      )}
      {canEdit && view.type === "grid" && (
        <button type="button" onClick={() => setDialog("color-rules")}>
          填色{view.config.colorRules?.length ? ` ${view.config.colorRules.length}` : ""}
        </button>
      )}
    </>
  ) : null;

  return (
    <div className={navCollapsed ? "app nav-collapsed" : "app"} ref={appRef}>
      {isMobile && navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={isMobile && navOpen ? "sidebar open" : "sidebar"}>
        {!isMobile && (
          <PaneHandle
            label="导航栏宽度"
            onPointerDown={navPane.startResize}
            onReset={navPane.resetWidth}
            onNudge={navPane.nudge}
          />
        )}
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          知行人生
        </div>
        <div className="side-scroll">
          {bases.map((item) => {
            const isActive = item.id === baseId;
            const isOpen = openBases.includes(item.id);
            return (
            <div key={item.id} className="base">
              <div className={isActive ? "base-head active" : "base-head"}>
                <button
                  type="button"
                  className="base-toggle"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "收起" : "展开"}空间 ${item.name}`}
                  title={isOpen ? "收起空间" : "展开空间"}
                  onClick={() => toggleBase(item.id)}
                >
                  <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                </button>
                <button
                  type="button"
                  className="base-name"
                  onClick={() => {
                    if (!isOpen) toggleBase(item.id);
                    setBaseId(item.id);
                    setTableId(item.tables[0]?.id ?? null);
                    setViewId(null);
                    closeDocs();
                    setNavOpen(false);
                  }}
                  onDoubleClick={() => {
                    if (!canOwn || item.id !== baseId) return;
                    renameCurrentBase(item);
                  }}
                >
                  {item.name}
                </button>
                {canOwn && item.id === baseId && (
                  <DropMenu label="⋯" ariaLabel={`空间 ${item.name} 操作`} className="base-menu">
                    <button type="button" onClick={() => renameCurrentBase(item)}>
                      重命名空间
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={() => {
                        if (!window.confirm(`删除空间「${item.name}」？其中的清单和记录都会去掉。`)) return;
                        api
                          .deleteBase(item.id)
                          .then(() => refreshBases())
                          .catch(fail);
                      }}
                    >
                      删除空间
                    </button>
                  </DropMenu>
                )}
              </div>
              {isOpen && item.tables.map((table) => (
                <div key={table.id} className={table.id === tableId ? "table-row on" : "table-row"}>
                  <button
                    type="button"
                    className="table-link"
                    onClick={() => {
                      setBaseId(item.id);
                      setTableId(table.id);
                      setViewId(null);
                      closeDocs();
                      setSearch("");
                      setNavOpen(false);
                    }}
                  >
                    {table.name}
                  </button>
                  {canOwn && item.id === baseId && (
                    <button
                      type="button"
                      className="table-delete"
                      title="删除清单"
                      aria-label={`删除清单 ${table.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (
                          !window.confirm(
                            item.tables.length <= 1
                              ? `删除清单「${table.name}」？这是当前空间下的最后一张表，内容都会去掉。`
                              : `删除清单「${table.name}」？表内记录与视图都会去掉。`,
                          )
                        ) {
                          return;
                        }
                        const remaining = item.tables.find((entry) => entry.id !== table.id);
                        api
                          .deleteTable(table.id)
                          .then(() => refreshBases({ baseId: item.id, tableId: remaining?.id ?? null }))
                          .then(() => {
                            if (!remaining) setPayload(null);
                          })
                          .catch(fail);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {isOpen && item.id === baseId && (
                <div className="side-docs">
                  <div className="side-docs-head">
                    <button
                      type="button"
                      className={docsMode && !docId ? "side-docs-title on" : "side-docs-title"}
                      onClick={() => {
                        if (item.id !== baseId) {
                          setBaseId(item.id);
                          setTableId(item.tables[0]?.id ?? null);
                          setViewId(null);
                          setSearch("");
                        }
                        openDocsHome();
                      }}
                    >
                      文档
                    </button>
                    {canEdit && (
                      <DropMenu label="＋" ariaLabel="新建文档" className="side-docs-add">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const created = await api.createDocument(item.id, {});
                              await reloadDocuments(item.id);
                              openDocument(created.id);
                            } catch (err) {
                              fail(err);
                            }
                          }}
                        >
                          空白文档
                        </button>
                        {DOC_TEMPLATES.map((template) => (
                          <button
                            key={template.id}
                            type="button"
                            onClick={async () => {
                              try {
                                const created = await api.createDocument(item.id, { template: template.id });
                                await reloadDocuments(item.id);
                                openDocument(created.id);
                              } catch (err) {
                                fail(err);
                              }
                            }}
                          >
                            {template.name}
                          </button>
                        ))}
                        <hr className="menu-sep" />
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const created = await api.createDocument(item.id, { kind: "folder" });
                              await reloadDocuments(item.id);
                              openDocument(created.id);
                            } catch (err) {
                              fail(err);
                            }
                          }}
                        >
                          新建文件夹
                        </button>
                      </DropMenu>
                    )}
                  </div>
                  {!docsMode && (
                    <DocumentTree
                      baseId={item.id}
                      documents={documents}
                      selectedId={docId}
                      onSelect={(id) => openDocument(id)}
                      canEdit={canEdit}
                      onChanged={() => reloadDocuments(item.id)}
                      onError={fail}
                      onNotice={setNotice}
                    />
                  )}
                </div>
              )}
            </div>
            );
          })}
          {bases.length === 0 && <p className="side-empty">还没有空间。可以从模板开始，或新建一个空白空间。</p>}
        </div>
        <div className="side-actions">
          <button type="button" onClick={() => { setNavOpen(false); setDialog("template"); }}>＋ 从模板新建</button>
          <button type="button" onClick={() => { setNavOpen(false); setDialog("base"); }}>＋ 新建空间</button>
          {base && canEdit && <button type="button" onClick={() => { setNavOpen(false); setDialog("table"); }}>＋ 新建清单</button>}
        </div>
      </aside>
      <section className="main">
        <header className="topbar">
          {isMobile && (
            <button type="button" className="nav-toggle" aria-label="打开导航" onClick={() => setNavOpen(true)}>
              ☰
            </button>
          )}
          {!isMobile && (
            <button
              type="button"
              className="ghost pane-toggle"
              aria-label={navCollapsed ? "展开导航栏" : "收起导航栏"}
              aria-expanded={!navCollapsed}
              title={`${navCollapsed ? "展开" : "收起"}导航栏（Ctrl/⌘ + [）`}
              onClick={() => setNavCollapsed((value) => !value)}
            >
              {navCollapsed ? "»" : "«"}
            </button>
          )}
          <div className="top-title">
            {docsMode ? (
              <>
                <strong className="top-docs-title">文档</strong>
                {base && <span className="role-pill">{base.name}</span>}
              </>
            ) : (
              <>
                <input
                  value={payload?.name ?? ""}
                  aria-label="清单名称"
                  disabled={!payload || !canEdit}
                  onChange={(event) => setPayload((current) => (current ? { ...current, name: event.target.value } : current))}
                  onBlur={(event) => {
                    if (!payload || event.target.value.trim() === payload.name) return;
                    api.renameTable(payload.id, event.target.value).then(() => refreshBases({ baseId, tableId: payload.id })).catch(fail);
                  }}
                />
                {myRole && <span className="role-pill">{roleLabel(myRole)}</span>}
                {payload && canOwn && !isMobile && (
                  <button
                    type="button"
                    className="ghost danger-text"
                    onClick={() => deleteCurrentTable().catch(fail)}
                  >
                    删除清单
                  </button>
                )}
              </>
            )}
          </div>
          {!isMobile && (
            <div className="top-user">
              <button type="button" className="secondary" onClick={() => setDialog("tokens")}>访问令牌</button>
              <button type="button" className="secondary" onClick={() => setDialog("agent-brief")}>给 Agent</button>
              <button type="button" className="secondary" onClick={() => setDialog("help")}>使用说明</button>
              {user.role === "admin" && <button type="button" className="secondary" onClick={() => setDialog("admin")}>用户管理</button>}
              {user.role === "admin" && <button type="button" className="secondary" onClick={() => setDialog("backup")}>数据备份</button>}
              {user.role === "admin" && <button type="button" className="secondary" onClick={() => setDialog("agents")}>Agent 管理</button>}
              {user.role === "admin" && <button type="button" className="secondary" onClick={() => setDialog("smart-agents")}>智能体</button>}
              <span>{user.name}</span>
              <button
                type="button"
                className="ghost"
                onClick={() => api.logout().finally(onLogout)}
              >
                退出
              </button>
            </div>
          )}
          {isMobile && (
            <div className="top-user">
              <DropMenu ariaLabel="用户与设置">
                <div className="menu-user">{user.name}</div>
                <button type="button" onClick={() => setDialog("tokens")}>访问令牌</button>
                <button type="button" onClick={() => setDialog("agent-brief")}>给 Agent</button>
                <button type="button" onClick={() => setDialog("help")}>使用说明</button>
                {user.role === "admin" && <button type="button" onClick={() => setDialog("admin")}>用户管理</button>}
                {user.role === "admin" && <button type="button" onClick={() => setDialog("backup")}>数据备份</button>}
                {user.role === "admin" && <button type="button" onClick={() => setDialog("agents")}>Agent 管理</button>}
                {payload && canOwn && (
                  <button type="button" className="danger-text" onClick={() => deleteCurrentTable().catch(fail)}>
                    删除清单
                  </button>
                )}
                <hr className="menu-sep" />
                <button type="button" onClick={() => api.logout().finally(onLogout)}>退出登录</button>
              </DropMenu>
            </div>
          )}
        </header>
        {docsMode && navCollapsed && docsSideCollapsed && (
          <button
            type="button"
            className="pane-restore"
            onClick={() => {
              setNavCollapsed(false);
              setDocsSideCollapsed(false);
            }}
          >
            » 展开侧栏
          </button>
        )}
        {error && (
          <div className="banner">
            {error}
            <button type="button" onClick={() => setError(null)} aria-label="关闭提示">×</button>
          </div>
        )}
        {notice && (
          <div className="banner info">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
          </div>
        )}
        {payload && view && !showDashboard && !docsMode && (
          <div className="toolbar">
            {!isMobile && (
              <div className="views">
                {viewTabs}
                {viewMiscControls}
              </div>
            )}
            {!isMobile && (
              <div className="toolbar-right">
                {searchInput}
                {filterButton}
                {gridTuning}
                {kanbanTuning}
                {dateTuning}
                {mainCluster}
                <span className="count">{records.length} 条</span>
              </div>
            )}
            {isMobile && (
              <div className="toolbar-right">
                {mobileSearch || search ? searchInput : null}
                {filterButton}
                <button type="button" onClick={() => setDialog("assistant")}>
                  数据助手
                </button>
                <DropMenu ariaLabel="更多操作" panelClassName="toolbar-more">
                  {viewMiscControls}
                  {gridTuning}
                  {kanbanTuning}
                  {dateTuning}
                  {mainCluster}
                </DropMenu>
                <span className="count">{records.length} 条</span>
              </div>
            )}
          </div>
        )}
        {docsMode && base ? (
          <div className="stage docs-stage">
            <DocumentsView
              baseId={base.id}
              tables={base.tables}
              canEdit={canEdit}
              documents={documents}
              selectedId={docId}
              onSelect={openDocument}
              onReload={() => reloadDocuments(base.id)}
              sideCollapsed={docsSideCollapsed}
              onToggleSide={() => setDocsSideCollapsed((value) => !value)}
              onError={fail}
              onNotice={setNotice}
              onOpenRecord={openRecordFromDocument}
            />
          </div>
        ) : showDashboard && base ? (
          <DashboardView baseId={base.id} tables={base.tables} onClose={() => setShowDashboard(false)} />
        ) : (        <div className="stage">
          {loading && <p className="stage-note">加载中…</p>}
          {!loading && !payload && (
            <StageEmpty
              icon="▥"
              title="先选一张数据表"
              description="左侧是当前空间下的清单。选中一张就能看到它的表格、看板或日历视图。"
              tone="calm"
              actions={
                canEdit ? (
                  <button type="button" className="primary" onClick={() => setDialog("table")}>
                    ＋ 新建数据表
                  </button>
                ) : undefined
              }
            />
          )}
          {payload && view?.type === "grid" &&
            (isMobile ? (
              <RecordCardList
                fields={visibleFields}
                records={records}
                groups={view.config.groups}
                readOnly={!canEdit}
                onOpenRecord={setDetailRecordId}
                onAdd={() => payload && api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
              />
            ) : (
              <GridView
              fields={visibleFields}
              allFields={payload.fields}
              records={records}
              sorts={view.config.sorts}
              groups={view.config.groups}
              colorRules={view.config.colorRules}
              rowHeight={view.config.rowHeight}
              readOnly={!canEdit}
              tableId={payload.id}
              baseId={base?.id}
              onSort={onSort}
              onChange={onChange}
              onDelete={(recordId) => api.deleteRecord(recordId).then(() => reloadTable()).catch(fail)}
              onAdd={() => payload && api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
              onAddField={() => setDialog("field")}
              onRenameField={(fieldId, name) => api.updateField(fieldId, { name }).then(() => reloadTable()).catch(fail)}
              onEditOptions={(field) => {
                setOptionField(field);
                setDialog("options");
              }}
              onChangeType={(field) => {
                setOptionField(field);
                setDialog("change-type");
              }}
              onDeleteField={(field) => {
                if (!window.confirm(`删除字段「${field.name}」？已填写的内容会一起去掉。`)) return;
                api.deleteField(field.id).then(() => reloadTable()).catch(fail);
              }}
              onOpenRecord={setDetailRecordId}
              onDuplicate={(record) => {
                const input: Record<string, unknown> = {};
                for (const field of payload.fields) {
                  if (["formula", "lookup", "auto_number", "created_time", "updated_time", "created_by", "button"].includes(field.type)) continue;
                  const value = record.fields[field.name];
                  if (value != null && value !== "") input[field.name] = value;
                }
                api.createRecord(payload.id, input).then(() => reloadTable()).catch(fail);
              }}
              onFilterBy={(record, field) => {
                const raw = record.fields[field.name];
                const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
                if (!value) return;
                const config = { ...view.config, filters: [...view.config.filters, { fieldId: field.id, op: "eq" as const, value }] };
                api.updateView(view.id, { config }).then(patchView).catch(fail);
              }}
            />
            ))}
          {payload && view?.type === "kanban" && groupField &&
            (isMobile ? (
              <MobileKanban
                fields={visibleFields}
                records={records}
                groupField={groupField}
                readOnly={!canEdit}
                onChange={onChange}
                onAdd={(optionName) =>
                  api.createRecord(payload.id, optionName ? { [groupField.name]: optionName } : {}).then(() => reloadTable()).catch(fail)
                }
                onOpenRecord={setDetailRecordId}
              />
            ) : (
              <KanbanView
                fields={visibleFields}
                records={records}
                groupField={groupField}
                readOnly={!canEdit}
                onChange={onChange}
                onDelete={(recordId) => api.deleteRecord(recordId).then(() => reloadTable()).catch(fail)}
                onOpenRecord={setDetailRecordId}
                onAdd={(optionName) =>
                  api.createRecord(payload.id, optionName ? { [groupField.name]: optionName } : {}).then(() => reloadTable()).catch(fail)
                }
              />
            ))}
          {payload && view?.type === "kanban" && !groupField && (
            <StageEmpty
              icon="▦"
              title="看板还没有分组字段"
              description="看板按一个单选字段分列。选好之后，左右拖动卡片就会直接改写这个字段的值。"
              actions={
                canEdit ? (
                  <>
                    {kanbanCandidate && (
                      <button type="button" className="primary" onClick={() => void patchViewConfig({ groupFieldId: kanbanCandidate.id })}>
                        按「{kanbanCandidate.name}」分组
                      </button>
                    )}
                    {!kanbanCandidate && (
                      <button type="button" className="primary" onClick={() => void createStatusFieldAndKanban()}>
                        新建「{DEFAULT_STATUS_FIELD}」字段并分组
                      </button>
                    )}
                  </>
                ) : undefined
              }
            />
          )}
          {payload && view?.type === "calendar" &&
            (!dateField ? (
              <StageEmpty
                icon="▤"
                title="这个日历还没有日期字段"
                description="日历会把带日期的记录摆到对应的日子上，拖动记录就能直接改日期。"
                tone={canEdit ? "warn" : "calm"}
                actions={
                  canEdit ? (
                    <>
                      {dateFields[0] && (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void patchViewConfig({ dateFieldId: dateFields[0].id })}
                        >
                          用「{dateFields[0].name}」显示
                        </button>
                      )}
                      <button type="button" className="secondary" onClick={() => setDialog("field")}>
                        ＋ 新建日期字段
                      </button>
                    </>
                  ) : undefined
                }
              />
            ) : isMobile ? (
              <MobileAgenda
                fields={visibleFields}
                records={records}
                dateFieldId={view.config.dateFieldId}
                titleFieldId={view.config.titleFieldId}
                onOpen={setDetailRecordId}
              />
            ) : (
              <CalendarView
                fields={visibleFields}
                records={records}
                dateFieldId={view.config.dateFieldId}
                titleFieldId={view.config.titleFieldId}
                readOnly={!canEdit}
                onChange={onChange}
                onOpen={setDetailRecordId}
              />
            ))}
          {payload && view?.type === "gantt" &&
            (!dateField ? (
              <StageEmpty
                icon="▭"
                title="这个甘特图还没有开始日期"
                description="甘特图用开始/结束日期把记录画成时间条，进度字段决定条内填充多少。"
                tone={canEdit ? "warn" : "calm"}
                actions={
                  canEdit ? (
                    <>
                      {dateFields[0] && (
                        <button
                          type="button"
                          className="primary"
                          onClick={() =>
                            void patchViewConfig({
                              dateFieldId: dateFields[0].id,
                              endDateFieldId: dateFields[1]?.id ?? dateFields[0].id,
                            })
                          }
                        >
                          用「{dateFields[0].name}」显示
                        </button>
                      )}
                      <button type="button" className="secondary" onClick={() => setDialog("field")}>
                        ＋ 新建日期字段
                      </button>
                    </>
                  ) : undefined
                }
              />
            ) : (
              <GanttView
                fields={visibleFields}
                records={records}
                dateFieldId={view.config.dateFieldId}
                endDateFieldId={view.config.endDateFieldId}
                progressFieldId={view.config.progressFieldId}
                dependencyFieldId={view.config.dependencyFieldId}
                titleFieldId={view.config.titleFieldId}
                readOnly={!canEdit}
                onChange={onChange}
                onOpen={setDetailRecordId}
              />
            ))}
          {payload && view?.type === "gallery" &&
            (records.length === 0 ? (
              payload.records.length === 0 ? (
                <StageEmpty
                  icon="▨"
                  title="画册还是空的"
                  description="每一条记录会变成一张卡片。想先有内容，可以直接添加一条记录。"
                  steps={["挑一个标题字段", "需要时把图片字段作为封面", "填几条记录就有画面了"]}
                  tone="calm"
                  actions={
                    canEdit ? (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
                      >
                        ＋ 添加记录
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <StageEmpty
                  icon="◎"
                  title="没有符合条件的卡片"
                  description="当前搜索或筛选条件下没有记录。清空条件就能看到全部卡片。"
                  tone="calm"
                  actions={
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setSearch("");
                        if (view) void patchViewConfig({ filters: [] });
                      }}
                    >
                      清空搜索与筛选
                    </button>
                  }
                />
              )
            ) : (
              <GalleryView
                fields={visibleFields}
                records={records}
                titleFieldId={view.config.titleFieldId}
                readOnly={!canEdit}
                onOpen={setDetailRecordId}
                onAdd={() => api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
              />
            ))}
        </div>
        )}
      </section>
      {isMobile && !showDashboard && payload && view && (
        <BottomBar
          canAdd={canEdit}
          searchActive={mobileSearch || Boolean(search)}
          onNav={() => setNavOpen(true)}
          onAdd={() => api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
          onSearch={() => setMobileSearch((value) => !value)}
          onFilter={() => setDialog("filter")}
          onViews={() => setDialog("views")}
        />
      )}
      {dialog === "views" && payload && view && (
        <Modal title="切换视图" onClose={closeDialog}>
          <div className="m-view-list">
            {payload.views.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === view.id ? "on" : ""}
                onClick={() => {
                  setViewId(item.id);
                  closeDialog();
                }}
              >
                <strong>{item.name}</strong>
                <span>
                  {VIEW_TYPE_LABELS[item.type]}
                  {item.protection === "locked" ? " · 🔒" : item.protection === "personal" ? " · 👤" : ""}
                </span>
              </button>
            ))}
          </div>
          {canEdit && (
            <div className="dialog-actions">
              <button type="button" className="primary" onClick={() => setDialog("view")}>
                ＋ 新建视图
              </button>
            </div>
          )}
        </Modal>
      )}
      {kanbanPrompt && payload && (
        <Modal title="转看板" onClose={() => setKanbanPrompt(false)}>
          <p className="fine">
            看板需要一个「单选」字段来分列，比如「状态」。这张表
            {selectFields.length > 0 ? "有单选字段但还没选中，可以先在上方「看板分组」里挑一个。" : "还没有单选字段。"}
          </p>
          {selectFields.length === 0 && (
            <>
              <p className="fine">
                可以直接新建一个「{DEFAULT_STATUS_FIELD}」字段，选项默认是
                {DEFAULT_STATUS_OPTIONS.join(" / ")}，建完马上就能拖动卡片改状态。
              </p>
              <div className="dialog-actions">
                <button type="button" className="primary" onClick={() => void createStatusFieldAndKanban()}>
                  新建「{DEFAULT_STATUS_FIELD}」字段并转看板
                </button>
                <button type="button" onClick={() => setKanbanPrompt(false)}>
                  取消
                </button>
              </div>
            </>
          )}
          {selectFields.length > 0 && (
            <div className="dialog-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setKanbanPrompt(false);
                  if (kanbanCandidate) void patchViewConfig({ groupFieldId: kanbanCandidate.id });
                }}
              >
                按「{kanbanCandidate?.name}」分组
              </button>
              <button type="button" onClick={() => setKanbanPrompt(false)}>
                取消
              </button>
            </div>
          )}
        </Modal>
      )}
      {dialog === "base" && (
        <NameDialog title="新建空间" label="名称" onClose={closeDialog} onSubmit={async (name) => {
          const created = await api.createBase(name);
          await refreshBases({ baseId: created.id });
        }} />
      )}
      {dialog === "table" && base && (
        <TableDialog
          onClose={closeDialog}
          onSubmit={async (input) => {
            const created = await api.createTable(base.id, input);
            await refreshBases({ baseId: base.id, tableId: created.id });
          }}
        />
      )}
      {dialog === "field" && payload && (
        <FieldDialog
          tables={base?.tables ?? []}
          fields={payload.fields}
          onClose={closeDialog}
          onSubmit={async (input) => {
            await api.createField(payload.id, input);
            await reloadTable();
          }}
        />
      )}
      {dialog === "options" && optionField && payload && (
        <OptionsDialog
          field={optionField}
          fields={payload.fields}
          onClose={closeDialog}
          onSubmit={async (options, optionCascade) => {
            await api.updateField(optionField.id, { options, optionCascade });
            await reloadTable();
          }}
        />
      )}
      {dialog === "change-type" && optionField && (
        <ChangeTypeDialog
          field={optionField}
          onClose={closeDialog}
          onSubmit={async (type) => {
            await api.changeFieldType(optionField.id, type);
            await reloadTable();
          }}
        />
      )}
      {dialog === "help" && <HelpDialog onClose={closeDialog} />}
      {dialog === "agent-brief" && (
        <AgentBriefDialog isAdmin={user.role === "admin"} onClose={closeDialog} />
      )}
      {dialog === "view" && payload && (
        <ViewDialog
          fields={payload.fields}
          onClose={closeDialog}
          onSubmit={async (input) => {
            const created = await api.createView(payload.id, input);
            await reloadTable();
            setViewId(created.id);
          }}
        />
      )}
      {dialog === "import" && payload && (
        <ImportDialog
          onClose={closeDialog}
          onSubmit={async (csv) => {
            await api.importCsv(payload.id, csv);
            await reloadTable();
          }}
        />
      )}
      {dialog === "automations" && payload && (
        <AutomationDialog
          tableId={payload.id}
          baseId={base?.id ?? null}
          canOwn={canOwn}
          fields={payload.fields}
          onClose={closeDialog}
        />
      )}
      {dialog === "assistant" && payload && (
        <AssistantPanel tableId={payload.id} tableName={payload.name} onClose={closeDialog} />
      )}
      {dialog === "calendar-feishu" && base && payload && (
        <CalendarFeishuDialog
          baseId={base.id}
          tableId={payload.id}
          fields={payload.fields}
          canOwn={canOwn}
          onClose={closeDialog}
        />
      )}
      {detailRecordId && payload && (
        <RecordDetailDialog
          recordId={detailRecordId}
          tableId={payload.id}
          baseId={base?.id ?? null}
          fields={payload.fields}
          record={payload.records.find((item) => item.id === detailRecordId) ?? null}
          canEdit={canEdit}
          fullScreen={isMobile}
          onClose={closeDetail}
          onChange={onChange}
          onOpenDocument={(documentId) => void openDocumentFromRecord(documentId)}
          onDelete={() => {
            api
              .deleteRecord(detailRecordId)
              .then(() => {
                closeDetail();
                reloadTable();
              })
              .catch(fail);
          }}
        />
      )}
      {dialog === "detail-page" && payload && (
        <DetailPageDialog
          tableId={payload.id}
          fields={payload.fields}
          onClose={closeDialog}
        />
      )}
      {dialog === "color-rules" && payload && view && (
        <ColorRulesDialog
          fields={payload.fields}
          view={view}
          onClose={closeDialog}
          onSubmit={async (colorRules) => {
            patchView(await api.updateView(view.id, { config: { ...view.config, colorRules } }));
          }}
        />
      )}
      {dialog === "filter" && view && payload && (
        <FilterDialog
          fields={payload.fields}
          view={view}
          onClose={closeDialog}
          onSubmit={async (config) => {
            patchView(await api.updateView(view.id, { config }));
          }}
        />
      )}
      {dialog === "template" && (
        <TemplateDialog
          onClose={closeDialog}
          onSubmit={async (template) => {
            const created = await api.createTemplate(template);
            await refreshBases({ baseId: created.id, tableId: created.tables[0]?.id });
          }}
        />
      )}
      {dialog === "share" && base && (
        <ShareDialog
          baseId={base.id}
          members={members}
          onClose={closeDialog}
          onChange={setMembers}
          onDelete={async () => {
            await api.deleteBase(base.id);
            closeDialog();
            await refreshBases();
          }}
        />
      )}
      {dialog === "tokens" && <TokenDialog onClose={closeDialog} />}
      {dialog === "admin" && <AdminDialog selfId={user.id} onSelf={onUser} onClose={closeDialog} />}
      {dialog === "backup" && user.role === "admin" && <BackupDialog onClose={closeDialog} />}
      {dialog === "agents" && user.role === "admin" && (
        <AgentManageDialog bases={bases} onClose={closeDialog} />
      )}
      {dialog === "smart-agents" && user.role === "admin" && (
        <SmartAgentDialog bases={bases} onClose={closeDialog} />
      )}
    </div>
  );
}

function NameDialog({ title, label, onClose, onSubmit }: { title: string; label: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit(name);
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          {label}
          <input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">创建</button>
        </div>
      </form>
    </Modal>
  );
}

function TableDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { name: string; withKanban?: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [withKanban, setWithKanban] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="新建清单" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit({ name, withKanban });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </label>
        <label className="check-line">
          <input type="checkbox" checked={withKanban} onChange={(event) => setWithKanban(event.target.checked)} />
          如果有单选字段，同时生成看板
        </label>
        <p className="fine">新建后默认有一个「标题」字段，可以继续加字段。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">创建</button>
        </div>
      </form>
    </Modal>
  );
}

function FieldDialog({
  tables,
  fields,
  onClose,
  onSubmit,
}: {
  tables: Array<{ id: string; name: string }>;
  fields?: Field[];
  onClose: () => void;
  onSubmit: (input: {
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
    buttonAction?: { type: "add_comment"; body: string } | { type: "set_field"; fieldId: string; value: string } | { type: "open_url"; url: string };
    symmetricFieldName?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<Field["type"]>("text");
  const [options, setOptions] = useState("待办\n进行中\n已完成");
  const [formula, setFormula] = useState("{数量}*{单价}");
  const [linkTableId, setLinkTableId] = useState(tables[0]?.id ?? "");
  const [lookupLinkFieldId, setLookupLinkFieldId] = useState("");
  const [lookupTargetFieldId, setLookupTargetFieldId] = useState("");
  const [symmetricFieldName, setSymmetricFieldName] = useState("");
  const [buttonLabel, setButtonLabel] = useState("执行");
  const [buttonActionType, setButtonActionType] = useState<"add_comment" | "set_field" | "open_url">("add_comment");
  const [buttonComment, setButtonComment] = useState("按钮已点击");
  const [buttonSetFieldId, setButtonSetFieldId] = useState(fields?.[0]?.id ?? "");
  const [buttonSetValue, setButtonSetValue] = useState("");
  const [buttonUrl, setButtonUrl] = useState("https://");
  const [max, setMax] = useState(5);
  const [currency, setCurrency] = useState("CNY");
  const [prefix, setPrefix] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const selectable = type === "single_select" || type === "multi_select";
  const linkFields = (fields ?? []).filter((field) => field.type === "link" || field.type === "duplex_link");
  const typeOptions = showAllTypes
    ? FIELD_TYPES
    : FIELD_TYPES.filter((item) => COMMON_FIELD_TYPES.includes(item.id) || item.id === type);
  return (
    <Modal title="添加字段" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const buttonAction =
              type !== "button"
                ? undefined
                : buttonActionType === "set_field"
                  ? { type: "set_field" as const, fieldId: buttonSetFieldId, value: buttonSetValue }
                  : buttonActionType === "open_url"
                    ? { type: "open_url" as const, url: buttonUrl }
                    : { type: "add_comment" as const, body: buttonComment };
            await onSubmit({
              name,
              type,
              options: selectable ? options.split(/\n+/).map((item) => item.trim()).filter(Boolean) : undefined,
              formula: type === "formula" ? formula : undefined,
              linkTableId: type === "link" || type === "duplex_link" ? linkTableId : undefined,
              max: type === "rating" ? max : undefined,
              currency: type === "currency" ? currency : undefined,
              prefix: type === "auto_number" || type === "barcode" ? prefix : undefined,
              lookupLinkFieldId: type === "lookup" ? lookupLinkFieldId : undefined,
              lookupTargetFieldId: type === "lookup" ? lookupTargetFieldId : undefined,
              buttonLabel: type === "button" ? buttonLabel : undefined,
              buttonAction,
              symmetricFieldName: type === "duplex_link" ? symmetricFieldName || undefined : undefined,
            });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          字段名
          <input value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </label>
        <label>
          类型
          <FancySelect
            value={type}
            required
            onChange={(next) => setType(next as Field["type"])}
            options={typeOptions.map((item) => ({ value: item.id, label: item.label }))}
          />
        </label>
        {!showAllTypes && (
          <p className="fine">
            先给常用类型。{" "}
            <button type="button" className="text-button" onClick={() => setShowAllTypes(true)}>
              显示公式、查找引用等更多类型
            </button>
          </p>
        )}
        {selectable && (
          <label>
            选项，每行一个
            <textarea value={options} onChange={(event) => setOptions(event.target.value)} rows={5} />
          </label>
        )}
        {type === "formula" && (
          <label>
            公式
            <input value={formula} onChange={(event) => setFormula(event.target.value)} required />
          </label>
        )}
        {(type === "link" || type === "duplex_link") && (
          <label>
            关联数据表
            <FancySelect
              value={linkTableId}
              required
              onChange={setLinkTableId}
              options={tables.map((table) => ({ value: table.id, label: table.name }))}
            />
          </label>
        )}
        {type === "duplex_link" && (
          <label>
            对方字段名（可选）
            <input value={symmetricFieldName} onChange={(event) => setSymmetricFieldName(event.target.value)} />
          </label>
        )}
        {type === "lookup" && (
          <>
            <label>
              关联字段
              <FancySelect
                value={lookupLinkFieldId}
                required
                placeholder="选择"
                onChange={setLookupLinkFieldId}
                options={[
                  { value: "", label: "选择" },
                  ...linkFields.map((field) => ({ value: field.id, label: field.name })),
                ]}
              />
            </label>
            <label>
              目标字段 ID
              <input value={lookupTargetFieldId} onChange={(event) => setLookupTargetFieldId(event.target.value)} required placeholder="对方表字段 id" />
            </label>
          </>
        )}
        {type === "button" && (
          <>
            <label>
              按钮文案
              <input value={buttonLabel} onChange={(event) => setButtonLabel(event.target.value)} />
            </label>
            <label>
              动作（关联当前记录）
              <FancySelect
                value={buttonActionType}
                onChange={(v) => setButtonActionType(v as typeof buttonActionType)}
                options={[
                  { value: "add_comment", label: "添加评论" },
                  { value: "set_field", label: "设置字段" },
                  { value: "open_url", label: "打开链接" },
                ]}
              />
            </label>
            {buttonActionType === "add_comment" && (
              <label>
                评论内容
                <input value={buttonComment} onChange={(event) => setButtonComment(event.target.value)} />
              </label>
            )}
            {buttonActionType === "set_field" && (
              <>
                <label>
                  目标字段
                  <FancySelect
                    value={buttonSetFieldId}
                    onChange={setButtonSetFieldId}
                    options={(fields ?? []).map((field) => ({ value: field.id, label: field.name }))}
                  />
                </label>
                <label>
                  值
                  <input value={buttonSetValue} onChange={(event) => setButtonSetValue(event.target.value)} />
                </label>
              </>
            )}
            {buttonActionType === "open_url" && (
              <label>
                URL
                <input value={buttonUrl} onChange={(event) => setButtonUrl(event.target.value)} />
              </label>
            )}
            <p className="fine">数据表按钮关联当前行；仪表盘按钮不关联记录。</p>
          </>
        )}
        {type === "rating" && (
          <label>
            最高分
            <input type="number" min={1} max={10} value={max} onChange={(event) => setMax(Number(event.target.value))} />
          </label>
        )}
        {type === "currency" && (
          <label>
            币种
            <input value={currency} onChange={(event) => setCurrency(event.target.value)} />
          </label>
        )}
        {(type === "auto_number" || type === "barcode") && (
          <label>
            前缀
            <input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">添加</button>
        </div>
      </form>
    </Modal>
  );
}

function OptionsDialog({
  field,
  fields,
  onClose,
  onSubmit,
}: {
  field: Field;
  fields: Field[];
  onClose: () => void;
  onSubmit: (
    options: string[],
    optionCascade: { targetFieldId: string; map: Record<string, string[]> } | null,
  ) => Promise<void>;
}) {
  const [options, setOptions] = useState((field.config.options ?? []).map((item) => item.name).join("\n"));
  const [targetFieldId, setTargetFieldId] = useState(field.config.optionCascade?.targetFieldId ?? "");
  const [cascadeText, setCascadeText] = useState(() => {
    const map = field.config.optionCascade?.map ?? {};
    return Object.entries(map)
      .map(([key, values]) => `${key}=${values.join(",")}`)
      .join("\n");
  });
  const [error, setError] = useState<string | null>(null);
  const targets = fields.filter(
    (item) => item.id !== field.id && (item.type === "single_select" || item.type === "multi_select"),
  );
  return (
    <Modal title={`编辑「${field.name}」选项`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const optionNames = options.split(/\n+/).map((item) => item.trim()).filter(Boolean);
            let optionCascade: { targetFieldId: string; map: Record<string, string[]> } | null = null;
            if (targetFieldId.trim()) {
              const map: Record<string, string[]> = {};
              for (const line of cascadeText.split(/\n+/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const sep = trimmed.indexOf("=");
                if (sep < 0) continue;
                const key = trimmed.slice(0, sep).trim();
                const values = trimmed
                  .slice(sep + 1)
                  .split(/[,，]/)
                  .map((item) => item.trim())
                  .filter(Boolean);
                if (key) map[key] = values;
              }
              optionCascade = { targetFieldId: targetFieldId.trim(), map };
            }
            await onSubmit(optionNames, optionCascade);
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          每行一个选项
          <textarea value={options} onChange={(event) => setOptions(event.target.value)} rows={6} />
        </label>
        <label>
          选项联动目标字段（可选）
          <FancySelect
            value={targetFieldId}
            placeholder="不启用"
            onChange={setTargetFieldId}
            options={[
              { value: "", label: "不启用" },
              ...targets.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
        </label>
        {targetFieldId && (
          <label>
            联动映射（每行：源选项=目标1,目标2）
            <textarea
              value={cascadeText}
              onChange={(event) => setCascadeText(event.target.value)}
              rows={5}
              placeholder={"华东=上海,杭州\n华北=北京,天津"}
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </Modal>
  );
}

function ViewDialog({
  fields,
  onClose,
  onSubmit,
}: {
  fields: Field[];
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    type: ViewType;
    groupField?: string;
    dateField?: string;
    titleField?: string;
    endDateField?: string;
    progressField?: string;
    dependencyField?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("看板");
  const [type, setType] = useState<ViewType>("kanban");
  const [showMoreTypes, setShowMoreTypes] = useState(false);
  const selects = fields.filter((field) => field.type === "single_select");
  const dates = fields.filter((field) => field.type === "date");
  const titles = fields.filter((field) => field.type === "text" || field.type === "long_text");
  const progresses = fields.filter((field) => field.type === "progress" || field.type === "number");
  const links = fields.filter((field) => field.type === "link" || field.type === "duplex_link");
  /** 新建视图默认只给三类高频视图，画册 / 甘特收进「更多」；表单视图已随公开分享一并下线。 */
  const typeIds: ViewType[] = showMoreTypes
    ? ["grid", "kanban", "calendar", "gallery", "gantt"]
    : ["grid", "kanban", "calendar"];
  const typeOptions = typeIds.map((id) => ({ value: id, label: VIEW_TYPE_LABELS[id] }));
  const [groupField, setGroupField] = useState(selects[0]?.name ?? "");
  const [dateField, setDateField] = useState(dates[0]?.name ?? "");
  const [endDateField, setEndDateField] = useState(dates[1]?.name ?? dates[0]?.name ?? "");
  const [progressField, setProgressField] = useState(progresses[0]?.name ?? "");
  const [dependencyField, setDependencyField] = useState(links[0]?.name ?? "");
  const [titleField, setTitleField] = useState(titles[0]?.name ?? fields[0]?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="新建视图" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit({
              name,
              type,
              groupField: type === "kanban" || type === "gantt" ? groupField || undefined : undefined,
              dateField: type === "calendar" || type === "gantt" ? dateField || undefined : undefined,
              endDateField: type === "gantt" ? endDateField || undefined : undefined,
              progressField: type === "gantt" ? progressField || undefined : undefined,
              dependencyField: type === "gantt" ? dependencyField || undefined : undefined,
              titleField: type === "gallery" || type === "gantt" ? titleField || undefined : undefined,
            });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          类型
          <FancySelect
            value={type}
            onChange={(v) => {
              const next = v as ViewType;
              setType(next);
              setName(VIEW_TYPE_LABELS[next]);
            }}
            options={typeOptions}
          />
        </label>
        {!showMoreTypes && (
          <p className="fine">
            默认只列表格 / 看板 / 日历。{" "}
            <button type="button" className="text-button" onClick={() => setShowMoreTypes(true)}>
              显示画册、甘特等更多类型
            </button>
          </p>
        )}
        {(type === "kanban" || type === "gantt") && (
          <label>
            分组字段
            <FancySelect
              value={groupField}
              onChange={setGroupField}
              options={selects.map((field) => ({ value: field.name, label: field.name }))}
            />
          </label>
        )}
        {(type === "calendar" || type === "gantt") && (
          <label>
            开始日期字段
            <FancySelect
              value={dateField}
              required
              onChange={setDateField}
              options={dates.map((field) => ({ value: field.name, label: field.name }))}
            />
          </label>
        )}
        {type === "gantt" && (
          <>
            <label>
              结束日期字段
              <FancySelect
                value={endDateField}
                onChange={setEndDateField}
                options={dates.map((field) => ({ value: field.name, label: field.name }))}
              />
            </label>
            <label>
              进度字段
              <FancySelect
                value={progressField}
                placeholder="无"
                onChange={setProgressField}
                options={[
                  { value: "", label: "无" },
                  ...progresses.map((field) => ({ value: field.name, label: field.name })),
                ]}
              />
            </label>
            <label>
              依赖字段
              <FancySelect
                value={dependencyField}
                placeholder="无"
                onChange={setDependencyField}
                options={[
                  { value: "", label: "无" },
                  ...links.map((field) => ({ value: field.name, label: field.name })),
                ]}
              />
            </label>
          </>
        )}
        {(type === "gallery" || type === "gantt") && (
          <label>
            标题字段
            <FancySelect
              value={titleField}
              onChange={setTitleField}
              options={fields.map((field) => ({ value: field.name, label: field.name }))}
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">创建</button>
        </div>
      </form>
    </Modal>
  );
}

function FilterDialog({
  fields,
  view,
  onClose,
  onSubmit,
}: {
  fields: Field[];
  view: View;
  onClose: () => void;
  onSubmit: (config: View["config"]) => Promise<void>;
}) {
  const [filters, setFilters] = useState(view.config.filters.length ? view.config.filters : [{ fieldId: fields[0]?.id ?? "", op: "eq" as const, value: "" }]);
  const [conjunction, setConjunction] = useState(view.config.conjunction);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="筛选" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit({
              ...view.config,
              conjunction,
              filters: filters.filter((item) => item.fieldId && (item.op === "is_empty" || item.op === "is_not_empty" || item.value)),
            });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          条件关系
          <FancySelect
            value={conjunction}
            onChange={(v) => setConjunction(v as "and" | "or")}
            options={[
              { value: "and", label: "满足全部" },
              { value: "or", label: "满足任一" },
            ]}
          />
        </label>
        {filters.map((filter, index) => (
          <div className="filter-row" key={index}>
            <FancySelect
              compact
              value={filter.fieldId}
              onChange={(fieldId) => setFilters((current) => current.map((item, i) => (i === index ? { ...item, fieldId } : item)))}
              options={fields.map((field) => ({ value: field.id, label: field.name }))}
            />
            <FancySelect
              compact
              value={filter.op}
              onChange={(op) => setFilters((current) => current.map((item, i) => (i === index ? { ...item, op: op as typeof filter.op } : item)))}
              options={[
                { value: "eq", label: "等于" },
                { value: "neq", label: "不等于" },
                { value: "contains", label: "包含" },
                { value: "is_empty", label: "为空" },
                { value: "is_not_empty", label: "不为空" },
              ]}
            />
            {filter.op !== "is_empty" && filter.op !== "is_not_empty" && (
              <input
                value={filter.value ?? ""}
                onChange={(event) => setFilters((current) => current.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
              />
            )}
          </div>
        ))}
        <button type="button" className="text-button" onClick={() => setFilters((current) => [...current, { fieldId: fields[0]?.id ?? "", op: "eq", value: "" }])}>
          + 添加条件
        </button>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            onClick={async () => {
              await onSubmit({ ...view.config, filters: [] });
              onClose();
            }}
          >
            清除
          </button>
          <button type="submit" className="primary">应用</button>
        </div>
      </form>
    </Modal>
  );
}

function TemplateDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (template: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.templates().then(setTemplates).catch((err) => setError(message(err)));
  }, []);
  return (
    <Modal title="从模板新建" onClose={onClose}>
      <div className="template-list">
        {templates.map((template) => (
          <button
            type="button"
            key={template.id}
            onClick={async () => {
              try {
                await onSubmit(template.id);
                onClose();
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            <strong>{template.name}</strong>
            <span>{template.description}</span>
          </button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function ShareDialog({
  baseId,
  members,
  onClose,
  onChange,
  onDelete,
}: {
  baseId: string;
  members: BaseMember[];
  onClose: () => void;
  onChange: (members: BaseMember[]) => void;
  onDelete: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="分享" onClose={onClose}>
      <form
        className="share-add"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            onChange(await api.share(baseId, email, role));
            setEmail("");
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required placeholder="已开通账号的邮箱" />
        <FancySelect
          value={role}
          compact
          onChange={setRole}
          options={[
            { value: "owner", label: "所有者" },
            { value: "editor", label: "可编辑" },
            { value: "viewer", label: "可查看" },
          ]}
        />
        <button type="submit" className="primary">添加</button>
      </form>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.userId}>
            <div>
              <strong>{member.name}</strong>
              <span>{member.email}</span>
            </div>
            <FancySelect
              compact
              value={member.role}
              onChange={async (value) => {
                try {
                  onChange(await api.share(baseId, member.email, value));
                } catch (err) {
                  setError(message(err));
                }
              }}
              options={[
                { value: "owner", label: "所有者" },
                { value: "editor", label: "可编辑" },
                { value: "viewer", label: "可查看" },
              ]}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  onChange(await api.unshare(baseId, member.userId));
                } catch (err) {
                  setError(message(err));
                }
              }}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="danger-text"
          onClick={() => {
            if (window.confirm("删除整个空间？其中的清单和记录都会去掉。")) onDelete().catch((err) => setError(message(err)));
          }}
        >
          删除空间
        </button>
        <button type="button" onClick={onClose}>完成</button>
      </div>
    </Modal>
  );
}

function TokenDialog({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; prefix: string }>>([]);
  const [name, setName] = useState("脚本");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.tokens().then(setTokens).catch((err) => setError(message(err)));
  }, []);
  return (
    <Modal title="个人访问令牌" onClose={onClose}>
      <p className="fine">
        仅用于 REST / 脚本。MCP 请到「Agent 管理」注册并获取 <code>dwa_…</code> 令牌。
      </p>
      <form
        className="share-add"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const created = await api.createToken(name);
            setFresh(created.token);
            setTokens(await api.tokens());
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <input value={name} onChange={(event) => setName(event.target.value)} required />
        <button type="submit" className="primary">创建</button>
      </form>
      {fresh && (
        <p className="dev-code">
          请立即复制：<code>{fresh}</code>
        </p>
      )}
      <ul className="member-list">
        {tokens.map((token) => (
          <li key={token.id}>
            <div>
              <strong>{token.name}</strong>
              <span>{token.prefix}…</span>
            </div>
            <button
              type="button"
              onClick={async () => {
                await api.deleteToken(token.id);
                setTokens(await api.tokens());
              }}
            >
              吊销
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

const AGENT_ROLE_OPTIONS = [
  { value: "viewer", label: "可查看" },
  { value: "editor", label: "可编辑" },
  { value: "owner", label: "所有者" },
];

const AGENT_STATUS_LABEL: Record<McpAgent["status"], string> = {
  pending: "待审批",
  active: "已启用",
  disabled: "已停用",
  rejected: "已拒绝",
};

function agentStatusTone(status: McpAgent["status"]) {
  if (status === "active") return "agent-status is-active";
  if (status === "pending") return "agent-status is-pending";
  if (status === "rejected") return "agent-status is-rejected";
  return "agent-status is-off";
}

type AgentRole = "viewer" | "editor" | "owner";

function grantsFrom(agent: McpAgent): Record<string, AgentRole> {
  const next: Record<string, AgentRole> = {};
  for (const grant of agent.bases) next[grant.baseId] = grant.role;
  return next;
}

/** 比较两份授权是否等价；按 baseId 排序后再比，避免勾选后又取消仍被判为「有改动」。 */
function grantsEqual(a: Record<string, AgentRole>, b: Record<string, AgentRole>): boolean {
  const left = Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const right = Object.entries(b).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return (
    left.length === right.length &&
    left.every(([baseId, role], index) => right[index][0] === baseId && right[index][1] === role)
  );
}

function AgentTokenRow({ agent, onError }: { agent: McpAgent; onError: (text: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const token = agent.token;

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("复制失败，请点「显示」后手动选中令牌复制");
    }
  }

  if (!token) {
    const text =
      agent.status === "pending"
        ? "批准该申请时会自动生成令牌，之后可随时查看与复制。"
        : agent.status === "rejected"
          ? "该申请已被拒绝，没有令牌。"
          : "此令牌由旧版本生成，明文已无法找回。点「轮换令牌」生成新令牌，之后即可随时查看与复制。";
    return <p className="agent-token-hint">{text}</p>;
  }

  return (
    <div className="agent-token">
      <code className="agent-token-value">
        {revealed ? token : `${token.slice(0, 14)}${"•".repeat(10)}`}
      </code>
      <button type="button" onClick={() => setRevealed((value) => !value)}>
        {revealed ? "隐藏" : "显示"}
      </button>
      <button type="button" className="secondary" onClick={() => void copy()}>
        {copied ? "已复制" : "复制令牌"}
      </button>
    </div>
  );
}

function AgentGrantPicker({
  bases,
  agent,
  grants,
  onChange,
}: {
  bases: BaseSummary[];
  agent: McpAgent;
  grants: Record<string, AgentRole>;
  onChange: (next: Record<string, AgentRole>) => void;
}) {
  const [query, setQuery] = useState("");
  const ordered = useMemo(
    () => [...bases].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    [bases],
  );
  const known = useMemo(() => new Set(bases.map((base) => base.id)), [bases]);
  const staleCount = agent.bases.filter((grant) => !known.has(grant.baseId)).length;
  const needle = query.trim().toLowerCase();
  const shown = needle ? ordered.filter((base) => base.name.toLowerCase().includes(needle)) : ordered;
  const selectedCount = Object.keys(grants).length;

  function toggle(baseId: string) {
    const next = { ...grants };
    if (next[baseId]) delete next[baseId];
    else next[baseId] = "editor";
    onChange(next);
  }

  return (
    <div className="agent-picker-block">
      <div className="agent-picker-tools">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索空间名称"
          aria-label="搜索空间"
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const next = { ...grants };
            for (const base of shown) if (!next[base.id]) next[base.id] = "editor";
            onChange(next);
          }}
          disabled={!shown.length || shown.every((base) => grants[base.id])}
        >
          {needle ? "选中搜索结果" : "全选"}
        </button>
        <button type="button" className="secondary" onClick={() => onChange({})} disabled={!selectedCount}>
          清空
        </button>
      </div>
      <div className="agent-picker">
        {shown.map((base) => {
          const role = grants[base.id];
          return (
            <div key={base.id} className={role ? "agent-picker-row is-on" : "agent-picker-row"}>
              <label className="agent-picker-label">
                <input type="checkbox" checked={Boolean(role)} onChange={() => toggle(base.id)} />
                <span className="agent-picker-name" title={base.name}>
                  {base.name}
                </span>
              </label>
              <div className="agent-picker-side">
                <span className="agent-picker-count">{base.tables.length} 张清单</span>
                {role && (
                  <FancySelect
                    compact
                    value={role}
                    aria-label={`${base.name} 的权限`}
                    onChange={(value) => onChange({ ...grants, [base.id]: value as AgentRole })}
                    options={AGENT_ROLE_OPTIONS}
                  />
                )}
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="fine agent-empty">没有匹配的空间。</p>}
      </div>
      {staleCount > 0 && (
        <p className="fine agent-stale-note">
          另有 {staleCount} 项授权指向已删除的空间，保存后会被一并清除。
        </p>
      )}
    </div>
  );
}

function AgentEditPanel({
  initial,
  bases,
  onBack,
  onSaved,
  onAgent,
}: {
  initial: McpAgent;
  bases: BaseSummary[];
  onBack: () => void;
  onSaved: () => Promise<void>;
  onAgent: (agent: McpAgent) => void;
}) {
  const [agent, setAgent] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [contact, setContact] = useState(initial.contact);
  const [description, setDescription] = useState(initial.description);
  const [grants, setGrants] = useState<Record<string, AgentRole>>(() => grantsFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty =
    name !== agent.name ||
    contact !== agent.contact ||
    description !== agent.description ||
    !grantsEqual(grants, grantsFrom(agent));

  function payloadBases() {
    return Object.entries(grants).map(([baseId, role]) => ({ baseId, role }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMcpAgent(agent.id, {
        name,
        contact,
        description,
        bases: payloadBases(),
      });
      setAgent(updated);
      onAgent(updated);
      setName(updated.name);
      setContact(updated.contact);
      setDescription(updated.description);
      setGrants(grantsFrom(updated));
      await onSaved();
      onBack();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.approveMcpAgent(agent.id, payloadBases());
      setAgent(result.agent);
      onAgent(result.agent);
      setGrants(grantsFrom(result.agent));
      await onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMcpAgent(agent.id, { status: "rejected" });
      onAgent(updated);
      await onSaved();
      onBack();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!window.confirm("轮换后旧令牌立即失效，需同步更新该 Agent 的环境变量。继续？")) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.rotateMcpAgentToken(agent.id);
      setAgent(result.agent);
      onAgent(result.agent);
      await onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="agent-back" onClick={onBack}>
        ← 返回 Agent 列表
      </button>

      <div className="agent-edit-head">
        <strong>{agent.name}</strong>
        <em className={agentStatusTone(agent.status)}>{AGENT_STATUS_LABEL[agent.status]}</em>
        {agent.tokenPrefix && <span className="fine">前缀 {agent.tokenPrefix}…</span>}
      </div>

      <section className="agent-edit-section">
        <h3 className="section-title">基本信息</h3>
        <div className="agent-field-grid">
          <label>
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            联系方式
            <input
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              placeholder="邮箱或备注"
            />
          </label>
        </div>
        <label>
          说明
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="用途，例如「多模态文档检索」"
          />
        </label>
      </section>

      <section className="agent-edit-section">
        <h3 className="section-title">令牌</h3>
        <AgentTokenRow agent={agent} onError={setError} />
        {(agent.status === "active" || agent.status === "disabled") && (
          <div className="agent-inline-actions">
            <button type="button" className="secondary" onClick={() => void rotate()} disabled={busy}>
              轮换令牌
            </button>
            <span className="fine">轮换会立即作废旧令牌，请同步更新该 Agent 的 DUOWEI_TOKEN。</span>
          </div>
        )}
      </section>

      <section className="agent-edit-section">
        <div className="agent-section-head">
          <h3 className="section-title">可访问的空间</h3>
          <span className="fine">
            已选 {Object.keys(grants).length} / {bases.length}
          </span>
        </div>
        <AgentGrantPicker bases={bases} agent={agent} grants={grants} onChange={setGrants} />
      </section>

      {error && <p className="form-error">{error}</p>}

      <div className="dialog-actions">
        {agent.status === "pending" ? (
          <>
            <button type="button" className="danger-text" onClick={() => void reject()} disabled={busy}>
              拒绝申请
            </button>
            <button type="button" className="primary" onClick={() => void approve()} disabled={busy}>
              批准并授权
            </button>
          </>
        ) : (
          <>
            <button type="button" className="secondary" onClick={onBack}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={busy || !name.trim() || !dirty}
            >
              {dirty ? "保存" : "已保存"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function AgentManageDialog({ bases, onClose }: { bases: BaseSummary[]; onClose: () => void }) {
  const [agents, setAgents] = useState<McpAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpAgent | null>(null);
  const [freshToken, setFreshToken] = useState<{ label: string; token: string } | null>(null);
  const [copiedFresh, setCopiedFresh] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | McpAgent["status"]>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload() {
    setAgents(await api.mcpAgents());
  }

  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, []);

  function rememberFresh(label: string, token: string) {
    setFreshToken({ label, token });
    setCopiedFresh(false);
  }

  async function runOn(agentId: string, work: () => Promise<void>) {
    setBusyId(agentId);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  }

  async function copyFresh() {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken.token);
      setCopiedFresh(true);
      window.setTimeout(() => setCopiedFresh(false), 2000);
    } catch {
      setError("复制失败，请手动选中令牌复制");
    }
  }

  const needle = query.trim().toLowerCase();
  const filtered = agents.filter((agent) => {
    if (statusFilter !== "all" && agent.status !== statusFilter) return false;
    if (!needle) return true;
    const haystack = `${agent.name} ${agent.contact} ${agent.description} ${agent.tokenPrefix ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });

  const counts = {
    all: agents.length,
    active: agents.filter((agent) => agent.status === "active").length,
    pending: agents.filter((agent) => agent.status === "pending").length,
    disabled: agents.filter((agent) => agent.status === "disabled").length,
  };

  if (editing) {
    return (
      <Modal key={`agent-edit-${editing.id}`} title={`编辑 Agent · ${editing.name}`} onClose={onClose} size="wide">
        <AgentEditPanel
          initial={editing}
          bases={bases}
          onBack={() => setEditing(null)}
          onSaved={reload}
          onAgent={setEditing}
        />
      </Modal>
    );
  }

  return (
    <Modal key="agent-list" title="Agent 管理" onClose={onClose} size="wide">
      <p className="fine">
        外部 AI Agent 须先注册并获批后才能使用 MCP。令牌（<code>dwa_…</code>）在列表里随时可查看和复制，填入 Agent 的环境变量{" "}
        <code>DUOWEI_TOKEN</code>。权限与信息点每个 Agent 的「编辑」逐个调整。
      </p>

      {freshToken && (
        <p className="dev-code agent-fresh">
          <span>{freshToken.label} 的令牌：</span>
          <code>{freshToken.token}</code>
          <button type="button" className="secondary" onClick={() => void copyFresh()}>
            {copiedFresh ? "已复制" : "复制"}
          </button>
          <button type="button" className="secondary" onClick={() => setFreshToken(null)}>
            知道了
          </button>
        </p>
      )}

      <form
        className="admin-create"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const created = await api.createMcpAgent({ name, description, contact });
            rememberFresh(`Agent「${created.agent.name}」`, created.token);
            setName("");
            setDescription("");
            setContact("");
            await reload();
            setEditing(created.agent);
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} required placeholder="如 Cursor-生产" />
        </label>
        <label>
          联系方式
          <input value={contact} onChange={(event) => setContact(event.target.value)} placeholder="邮箱或备注" />
        </label>
        <label>
          说明
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途" />
        </label>
        <button type="submit" className="primary">
          直接创建并启用
        </button>
      </form>

      <div className="agent-toolbar">
        <input
          className="agent-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称 / 联系方式 / 说明 / 令牌前缀"
          aria-label="搜索 Agent"
        />
        <div className="agent-filters">
          {([
            ["all", `全部 ${counts.all}`],
            ["active", `已启用 ${counts.active}`],
            ["pending", `待审批 ${counts.pending}`],
            ["disabled", `已停用 ${counts.disabled}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={statusFilter === value ? "is-on" : undefined}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ul className="agent-cards">
        {filtered.map((agent) => (
          <li key={agent.id} className="agent-card">
            <div className="agent-card-head">
              <div className="agent-card-title">
                <strong>{agent.name}</strong>
                <em className={agentStatusTone(agent.status)}>{AGENT_STATUS_LABEL[agent.status]}</em>
              </div>
              <div className="agent-actions">
                {agent.status !== "pending" && (
                  <button type="button" className="secondary" onClick={() => setEditing(agent)}>
                    编辑
                  </button>
                )}
                {agent.status === "pending" && (
                  <button type="button" className="primary" onClick={() => setEditing(agent)}>
                    审批并授权
                  </button>
                )}
                {agent.status === "active" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busyId === agent.id}
                    onClick={() =>
                      void runOn(agent.id, async () => {
                        await api.updateMcpAgent(agent.id, { status: "disabled" });
                        await reload();
                      })
                    }
                  >
                    停用
                  </button>
                )}
                {agent.status === "disabled" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busyId === agent.id}
                    onClick={() =>
                      void runOn(agent.id, async () => {
                        await api.updateMcpAgent(agent.id, { status: "active" });
                        await reload();
                      })
                    }
                  >
                    启用
                  </button>
                )}
                <button
                  type="button"
                  className="danger-text"
                  disabled={busyId === agent.id}
                  onClick={() =>
                    void runOn(agent.id, async () => {
                      if (!window.confirm(`删除 Agent「${agent.name}」？该令牌将立即失效。`)) return;
                      await api.deleteMcpAgent(agent.id);
                      await reload();
                    })
                  }
                >
                  删除
                </button>
              </div>
            </div>

            <p className="agent-card-meta">
              {agent.contact || "无联系方式"}
              {agent.description ? ` · ${agent.description}` : ""}
              {agent.tokenPrefix ? ` · ${agent.tokenPrefix}…` : ""}
            </p>

            <div className="agent-grants">
              {agent.bases.length ? (
                agent.bases.map((grant) => (
                  <span className="grant-chip" key={grant.baseId}>
                    <span title={grant.baseName ?? grant.baseId}>{grant.baseName ?? grant.baseId}</span>
                    <em>{roleLabel(grant.role)}</em>
                  </span>
                ))
              ) : (
                <span className="fine">未授权任何空间（点「编辑」勾选）</span>
              )}
            </div>

            <AgentTokenRow agent={agent} onError={setError} />
          </li>
        ))}
        {!filtered.length && (
          <li className="agent-card agent-card-empty">
            <span className="fine">
              {agents.length ? "没有匹配的 Agent。" : "还没有 Agent。用上方表单创建第一个。"}
            </span>
          </li>
        )}
      </ul>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

const LLM_AGENT_MODE_LABELS: Record<LlmAgent["mode"], string> = {
  tools: "工具调用",
  prompt: "纯提示词",
};

const LLM_AGENT_STATUS_LABELS: Record<LlmAgent["status"], string> = {
  enabled: "已启用",
  disabled: "已停用",
};

const LLM_RUN_TRIGGER_LABELS: Record<LlmAgentRun["trigger"], string> = {
  chat: "表内对话",
  schedule: "定时",
  manual: "手动",
  retry: "重试",
  api: "接口",
  automation: "自动化",
};

const LLM_RUN_STATUS_LABELS: Record<LlmAgentRun["status"], string> = {
  running: "运行中",
  ok: "成功",
  failed: "失败",
};

function llmRunStatusTone(status: LlmAgentRun["status"]) {
  if (status === "ok") return "green";
  if (status === "failed") return "red";
  return "gray";
}

function llmRunTriggerLabel(trigger: LlmAgentRun["trigger"]) {
  return LLM_RUN_TRIGGER_LABELS[trigger] ?? trigger;
}

type AgentFormState = {
  name: string;
  description: string;
  baseId: string;
  instructions: string;
  mode: LlmAgent["mode"];
  tools: LlmAgentToolId[];
  providerBaseUrl: string;
  providerModel: string;
  temperature: string;
  apiKey: string;
  status: LlmAgent["status"];
};

function emptyAgentForm(): AgentFormState {
  return {
    name: "",
    description: "",
    baseId: "",
    instructions:
      "你是这个空间里的助理。先读表了解现状，再按指令执行；写记录或评论前先确认字段存在，汇报时用简短中文说明做了什么。",
    mode: "tools",
    tools: ["list_tables", "get_table_schema", "query_records"],
    providerBaseUrl: "",
    providerModel: "",
    temperature: "0.2",
    apiKey: "",
    status: "enabled",
  };
}

function agentFormFrom(agent: LlmAgent): AgentFormState {
  return {
    name: agent.name,
    description: agent.description,
    baseId: agent.baseId ?? "",
    instructions: agent.instructions,
    mode: agent.mode,
    tools: [...agent.tools],
    providerBaseUrl: agent.provider.baseUrl,
    providerModel: agent.provider.model,
    temperature: String(agent.provider.temperature),
    apiKey: "",
    status: agent.status,
  };
}

function SmartAgentDialog({ bases, onClose }: { bases: BaseSummary[]; onClose: () => void }) {
  const [agents, setAgents] = useState<LlmAgent[]>([]);
  const [runs, setRuns] = useState<LlmAgentRun[]>([]);
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runFor, setRunFor] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState("");
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [logAgentId, setLogAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload() {
    const [list, history] = await Promise.all([api.llmAgents(), api.llmAgentRuns()]);
    setAgents(list);
    setRuns(history);
  }

  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, []);

  function startCreate() {
    setForm(emptyAgentForm());
    setEditingId(null);
    setError(null);
    setNotice(null);
  }

  function startEdit(agent: LlmAgent) {
    setForm(agentFormFrom(agent));
    setEditingId(agent.id);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setError("请填写智能体名称");
      return;
    }
    const body = {
      name,
      description: form.description.trim(),
      baseId: form.baseId || null,
      instructions: form.instructions,
      mode: form.mode,
      tools: form.mode === "tools" ? form.tools : [],
      provider: {
        baseUrl: form.providerBaseUrl.trim(),
        model: form.providerModel.trim(),
        temperature: Number(form.temperature) || 0,
      },
      status: form.status,
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editingId) {
        const patch = form.apiKey.trim() ? { ...body, apiKey: form.apiKey.trim() } : body;
        await api.updateLlmAgent(editingId, patch);
        setNotice(`已保存「${name}」`);
      } else {
        await api.createLlmAgent(form.apiKey.trim() ? { ...body, apiKey: form.apiKey.trim() } : body);
        setNotice(`已创建「${name}」`);
      }
      setForm(null);
      setEditingId(null);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAgent(agent: LlmAgent, prompt: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await api.runLlmAgent(agent.id, prompt);
      setNotice(
        run.status === "ok"
          ? `「${agent.name}」运行成功：${firstLineOf(run.output)}`
          : `「${agent.name}」运行失败：${run.error ?? "未知原因"}`,
      );
      setOpenRun(run.id);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function retryRun(run: LlmAgentRun) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.retryLlmAgentRun(run.id);
      setNotice(next.status === "ok" ? "重试成功。" : `重试失败：${next.error ?? "未知原因"}`);
      setOpenRun(next.id);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const visibleRuns = logAgentId ? runs.filter((run) => run.agentId === logAgentId) : runs;

  return (
    <Modal title="智能体（LLM Agent）" onClose={onClose} size="wide">
      <p className="fine">
        智能体 = 任务指令 + 工具白名单 + 模型配置。表内对话、定时自动化（动作「调用智能体」）和这里的手动试跑共用同一条运行时，
        工具读写都按触发者身份过表级行列权限，每次运行都留下日志。
      </p>

      <div className="agent-toolbar">
        <button type="button" className="primary" onClick={startCreate} disabled={busy}>
          ＋ 新建智能体
        </button>
        <button type="button" onClick={() => reload().catch((err) => setError(message(err)))} disabled={busy}>
          刷新
        </button>
        <span className="fine">共 {agents.length} 个</span>
      </div>

      {form && (
        <form
          className="smart-agent-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>{editingId ? "编辑智能体" : "新建智能体"}</h3>
          <div className="smart-agent-grid">
            <label>
              名称
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="例如：每日进度汇总"
                required
              />
            </label>
            <label>
              绑定空间
              <FancySelect
                value={form.baseId}
                onChange={(value) => setForm({ ...form, baseId: value })}
                options={[
                  { value: "", label: "不限（按触发者可见范围）" },
                  ...bases.map((base) => ({ value: base.id, label: base.name })),
                ]}
              />
            </label>
          </div>
          <label>
            描述
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="给协作者看的一句话说明"
            />
          </label>
          <label>
            任务指令（系统提示词）
            <textarea
              value={form.instructions}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              rows={5}
            />
          </label>
          <div className="smart-agent-grid">
            <label>
              运行模式
              <FancySelect
                value={form.mode}
                onChange={(value) => setForm({ ...form, mode: value as LlmAgent["mode"] })}
                options={[
                  { value: "tools", label: "工具调用（可读写表）" },
                  { value: "prompt", label: "纯提示词（只答不算）" },
                ]}
              />
            </label>
            <label>
              状态
              <FancySelect
                value={form.status}
                onChange={(value) => setForm({ ...form, status: value as LlmAgent["status"] })}
                options={[
                  { value: "enabled", label: "启用" },
                  { value: "disabled", label: "停用" },
                ]}
              />
            </label>
          </div>
          <div>
            <span className="smart-agent-label">工具白名单</span>
            <div className="smart-agent-tools">
              {LLM_AGENT_TOOLS.map((tool) => {
                const checked = form.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    className={["tool-chip", checked ? "is-on" : "", form.mode !== "tools" ? "is-off" : ""]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={form.mode !== "tools"}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          tools: event.target.checked
                            ? [...form.tools, tool]
                            : form.tools.filter((item) => item !== tool),
                        })
                      }
                    />
                    {LLM_AGENT_TOOL_LABELS[tool]}
                  </label>
                );
              })}
            </div>
            {form.mode !== "tools" && <p className="fine">纯提示词模式不会调用任何工具。</p>}
          </div>
          <div className="smart-agent-grid">
            <label>
              模型地址（OpenAI 兼容）
              <input
                value={form.providerBaseUrl}
                onChange={(event) => setForm({ ...form, providerBaseUrl: event.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </label>
            <label>
              模型名称
              <input
                value={form.providerModel}
                onChange={(event) => setForm({ ...form, providerModel: event.target.value })}
                placeholder="deepseek-chat"
              />
            </label>
          </div>
          <div className="smart-agent-grid">
            <label>
              温度
              <input
                value={form.temperature}
                onChange={(event) => setForm({ ...form, temperature: event.target.value })}
                placeholder="0.2"
              />
            </label>
            <label>
              模型密钥
              <input
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={editingId ? "留空表示不修改" : "sk-…"}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="smart-agent-form-actions">
            <button type="submit" className="primary" disabled={busy}>
              {editingId ? "保存" : "创建"}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(null);
                setEditingId(null);
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </form>
      )}

      <ul className="agent-cards">
        {agents.length === 0 && !form && (
          <li className="agent-card agent-card-empty">
            <p className="fine">还没有智能体。新建一个，填上模型地址与密钥，就能在表内对话里用起来。</p>
          </li>
        )}
        {agents.map((agent) => {
          const baseName = agent.baseId ? (bases.find((base) => base.id === agent.baseId)?.name ?? agent.baseName ?? agent.baseId) : "不限空间";
          const agentRuns = runs.filter((run) => run.agentId === agent.id).slice(0, 5);
          return (
            <li key={agent.id} className="agent-card">
              <div className="agent-card-head">
                <div className="agent-card-title">
                  <strong>{agent.name}</strong>
                  <em className={`agent-status ${agent.status === "enabled" ? "is-active" : "is-rejected"}`}>
                    {LLM_AGENT_STATUS_LABELS[agent.status]}
                  </em>
                  {!agent.apiKeySet && <em className="agent-status is-pending">未配密钥</em>}
                </div>
                <div className="agent-actions">
                  <button type="button" onClick={() => startEdit(agent)} disabled={busy}>
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      api
                        .updateLlmAgent(agent.id, { status: agent.status === "enabled" ? "disabled" : "enabled" })
                        .then(reload)
                        .catch((err) => setError(message(err)))
                    }
                    disabled={busy}
                  >
                    {agent.status === "enabled" ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm(`删除智能体「${agent.name}」？运行日志会一起删除。`)) return;
                      api
                        .deleteLlmAgent(agent.id)
                        .then(reload)
                        .catch((err) => setError(message(err)));
                    }}
                    disabled={busy}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      setRunFor(runFor === agent.id ? null : agent.id);
                      setTestPrompt("");
                    }}
                    disabled={busy}
                  >
                    试跑
                  </button>
                </div>
              </div>
              <p className="agent-card-meta">
                {baseName} · {LLM_AGENT_MODE_LABELS[agent.mode]}
                {agent.mode === "tools" ? `（${agent.tools.length} 个工具）` : ""} · {agent.provider.model || "未配模型"} ·{" "}
                {agent.apiKeyHint ?? "未配密钥"} · 已运行 {agent.runCount} 次
                {agent.lastRunAt ? ` · 最近 ${formatWhen(agent.lastRunAt)}（${agent.lastRunStatus ? LLM_RUN_STATUS_LABELS[agent.lastRunStatus] : "—"}）` : ""}
              </p>
              {agent.description && <p className="agent-card-meta">{agent.description}</p>}
              {runFor === agent.id && (
                <div className="smart-agent-trial">
                  <input
                    value={testPrompt}
                    onChange={(event) => setTestPrompt(event.target.value)}
                    placeholder="留空则按任务指令试跑一次"
                  />
                  <button type="button" className="primary" onClick={() => void runAgent(agent, testPrompt)} disabled={busy}>
                    运行
                  </button>
                </div>
              )}
              {agentRuns.length > 0 && (
                <ul className="smart-agent-miniruns">
                  {agentRuns.map((run) => (
                    <li key={run.id}>
                      <time>{formatWhen(run.createdAt)}</time>
                      <span className={`tag ${llmRunStatusTone(run.status)}`}>{LLM_RUN_STATUS_LABELS[run.status]}</span>
                      <span>{llmRunTriggerLabel(run.trigger)}</span>
                      <span className="run-hint">{firstLineOf(run.error ?? run.output)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <div className="agent-toolbar">
        <h3 style={{ margin: 0 }}>运行日志</h3>
        <FancySelect
          value={logAgentId}
          onChange={setLogAgentId}
          options={[{ value: "", label: "全部智能体" }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]}
        />
        <span className="fine">最近 {visibleRuns.length} 条</span>
      </div>
      <ul className="smart-agent-runs">
        {visibleRuns.length === 0 && (
          <li className="run-empty">还没有运行记录。</li>
        )}
        {visibleRuns.slice(0, 50).map((run) => {
          const expanded = openRun === run.id;
          return (
            <li key={run.id} className="run-item">
              <div className="run-head">
                <time>{formatWhen(run.createdAt)}</time>
                <strong>{run.agentName ?? agents.find((agent) => agent.id === run.agentId)?.name ?? run.agentId}</strong>
                <span className={`tag ${llmRunStatusTone(run.status)}`}>{LLM_RUN_STATUS_LABELS[run.status]}</span>
                <span className="fine">
                  {llmRunTriggerLabel(run.trigger)} · {run.durationMs}ms
                  {run.steps.length > 0 ? ` · ${run.steps.length} 步工具` : ""}
                </span>
                <button type="button" className="link-btn" onClick={() => setOpenRun(expanded ? null : run.id)}>
                  {expanded ? "收起" : "详情"}
                </button>
                {run.status === "failed" && (
                  <button type="button" onClick={() => void retryRun(run)} disabled={busy}>
                    重试
                  </button>
                )}
              </div>
              <p className="run-input">{firstLineOf(run.input, 200)}</p>
              {expanded && (
                <div className="run-detail">
                  {run.error && <p className="form-error">{run.error}</p>}
                  {run.output && <pre className="dev-code">{run.output}</pre>}
                  {run.steps.length > 0 && (
                    <ul className="run-steps">
                      {run.steps.map((step, index) => (
                        <li key={`${run.id}-${index}`}>
                          <span className={`tag ${step.status === "ok" ? "green" : "red"}`}>{step.status === "ok" ? "成功" : "失败"}</span>
                          <code>{step.tool}</code>
                          <span className="fine">{step.ms}ms</span>
                          <span className="run-hint">{firstLineOf(step.result, 160)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {notice && <p className="form-ok">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function firstLineOf(text: string, max = 140) {
  const line = (text ?? "").trim().split("\n").find((item) => item.trim().length > 0)?.trim() ?? "";
  if (!line) return "（无输出）";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function AdminDialog({ selfId, onSelf, onClose }: { selfId: string; onSelf: (user: PublicUser) => void; onClose: () => void }) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [resetPassword, setResetPassword] = useState<Record<string, string>>({});

  useEffect(() => {
    api.users().then(setUsers).catch((err) => setError(message(err)));
  }, []);

  return (
    <Modal title="用户管理" onClose={onClose} size="wide">
      <p className="fine">系统关闭自助注册。在此创建账号、调整角色、启停与重置密码。</p>
      <form
        className="admin-create"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const created = await api.createUser({ name, email, password, role });
            setUsers((current) => [...current, created]);
            setName("");
            setEmail("");
            setPassword("");
            setRole("member");
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          姓名
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          邮箱
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          初始密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />
        </label>
        <label>
          角色
          <FancySelect
            value={role}
            onChange={(v) => setRole(v as "admin" | "member")}
            options={[
              { value: "member", label: "成员" },
              { value: "admin", label: "管理员" },
            ]}
          />
        </label>
        <button type="submit" className="primary">
          创建用户
        </button>
      </form>
      <ul className="member-list user-list">
        {users.map((person) => (
          <li key={person.id}>
            <div className="member-meta">
              <strong>{person.name}</strong>
              <span>{person.email}</span>
              {person.disabled && <em className="badge-warn">已停用</em>}
            </div>
            <FancySelect
              compact
              value={person.role}
              disabled={person.id === selfId}
              onChange={async (value) => {
                try {
                  const updated = await api.updateUser(person.id, { role: value });
                  setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
                  if (updated.id === selfId) onSelf(updated);
                } catch (err) {
                  setError(message(err));
                }
              }}
              options={[
                { value: "admin", label: "管理员" },
                { value: "member", label: "成员" },
              ]}
            />
            <button
              type="button"
              disabled={person.id === selfId}
              onClick={async () => {
                try {
                  const updated = await api.updateUser(person.id, { disabled: !person.disabled });
                  setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
                } catch (err) {
                  setError(message(err));
                }
              }}
            >
              {person.disabled ? "启用" : "停用"}
            </button>
            <div className="member-reset">
              <input
                type="password"
                placeholder="新密码"
                minLength={8}
                value={resetPassword[person.id] ?? ""}
                onChange={(event) =>
                  setResetPassword((current) => ({ ...current, [person.id]: event.target.value }))
                }
              />
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  const next = resetPassword[person.id]?.trim() ?? "";
                  if (next.length < 8) {
                    setError("新密码至少 8 位");
                    return;
                  }
                  try {
                    await api.updateUser(person.id, { password: next });
                    setResetPassword((current) => ({ ...current, [person.id]: "" }));
                    setError(null);
                  } catch (err) {
                    setError(message(err));
                  }
                }}
              >
                重置密码
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function formatBytes(size: number | null) {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ts: number | null) {
  if (ts == null) return "—";
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function BackupDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<BackupSettingsDto | null>(null);
  const [logs, setLogs] = useState<BackupLogDto[]>([]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "run" | null>(null);

  async function reload() {
    const data = await api.backupStatus();
    setSettings(data.settings);
    setLogs(data.logs);
  }

  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, []);

  if (!settings) {
    return (
      <Modal title="数据备份" onClose={onClose} size="wide">
        <p className="fine">{error ?? "加载中…"}</p>
      </Modal>
    );
  }

  return (
    <Modal title="数据备份 · 坚果云" onClose={onClose} size="wide">
      <p className="fine">
        配置坚果云 WebDAV 后，系统会按计划把数据库与附件打包上传，并只保留最近若干份。应用密码请在坚果云「账户信息 → 安全选项」中生成。
      </p>
      <form
        className="backup-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          setBusy("save");
          try {
            const updated = await api.updateBackup({
              enabled: settings.enabled,
              davUrl: settings.davUrl,
              username: settings.username,
              password: password || undefined,
              remotePath: settings.remotePath,
              hour: settings.hour,
              minute: settings.minute,
              keepDays: settings.keepDays,
            });
            setSettings(updated.settings);
            setPassword("");
            setNotice("配置已保存");
            await reload();
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(null);
          }
        }}
      >
        <label className="backup-check">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          启用每日自动备份
        </label>
        <label>
          WebDAV 地址
          <input
            value={settings.davUrl}
            onChange={(event) => setSettings({ ...settings, davUrl: event.target.value })}
            placeholder="https://dav.jianguoyun.com/dav/"
            required
          />
        </label>
        <label>
          坚果云账号（邮箱）
          <input
            type="email"
            value={settings.username}
            onChange={(event) => setSettings({ ...settings, username: event.target.value })}
            placeholder="you@example.com"
            required
          />
        </label>
        <label>
          应用密码{settings.hasPassword ? "（已配置，留空则不修改）" : ""}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={settings.hasPassword ? "••••••••" : "坚果云应用密码"}
            autoComplete="new-password"
          />
        </label>
        <label>
          远程目录
          <input
            value={settings.remotePath}
            onChange={(event) => setSettings({ ...settings, remotePath: event.target.value })}
            placeholder="/知行人生备份"
            required
          />
        </label>
        <label>
          每日备份时间（北京时间）
          <div className="backup-time">
            <input
              type="number"
              min={0}
              max={23}
              value={settings.hour}
              onChange={(event) => setSettings({ ...settings, hour: Number(event.target.value) })}
              aria-label="小时"
            />
            <span>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={settings.minute}
              onChange={(event) => setSettings({ ...settings, minute: Number(event.target.value) })}
              aria-label="分钟"
            />
          </div>
        </label>
        <label>
          保留份数
          <input
            type="number"
            min={1}
            max={30}
            value={settings.keepDays}
            onChange={(event) => setSettings({ ...settings, keepDays: Number(event.target.value) })}
          />
        </label>
        <div className="backup-actions">
          <button type="submit" className="primary" disabled={busy !== null}>
            {busy === "save" ? "保存中…" : "保存配置"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setError(null);
              setNotice(null);
              setBusy("test");
              try {
                await api.updateBackup({
                  enabled: settings.enabled,
                  davUrl: settings.davUrl,
                  username: settings.username,
                  password: password || undefined,
                  remotePath: settings.remotePath,
                  hour: settings.hour,
                  minute: settings.minute,
                  keepDays: settings.keepDays,
                });
                const result = await api.testBackup();
                setPassword("");
                setNotice(`连接成功：${result.remotePath}`);
                await reload();
              } catch (err) {
                setError(message(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={async () => {
              setError(null);
              setNotice(null);
              setBusy("run");
              try {
                await api.runBackup();
                setNotice("备份完成");
                await reload();
              } catch (err) {
                setError(message(err));
                await reload().catch(() => undefined);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "run" ? "备份中…" : "立即备份"}
          </button>
        </div>
      </form>
      <div className="backup-meta">
        <span>上次备份：{formatWhen(settings.lastRunAt)}</span>
        <span>下次计划：{formatWhen(settings.nextRunAt)}（北京时间）</span>
      </div>
      {notice && <p className="form-ok">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
      <h3 className="backup-logs-title">备份日志</h3>
      {logs.length === 0 ? (
        <p className="fine">暂无备份记录。</p>
      ) : (
        <ul className="backup-logs">
          {logs.map((log) => (
            <li key={log.id} data-status={log.status}>
              <div className="backup-log-head">
                <strong className={`backup-status backup-status-${log.status}`}>
                  {log.status === "ok" ? "成功" : log.status === "error" ? "失败" : "进行中"}
                </strong>
                <span>{formatWhen(log.startedAt)}</span>
                <span>{log.fileName ?? "—"}</span>
                <span>{formatBytes(log.fileSize)}</span>
              </div>
              <p>{log.message}</p>
              {log.remotePath && <p className="fine">{log.remotePath}</p>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ImportDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (csv: string) => Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="导入 CSV" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit(csv);
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          CSV 文本（首行为字段名）
          <textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={10} required />
        </label>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setCsv(await file.text());
          }}
        />
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">导入</button>
        </div>
      </form>
    </Modal>
  );
}

function RecordDetailDialog({
  recordId,
  tableId,
  baseId,
  fields,
  record,
  canEdit,
  fullScreen,
  onClose,
  onChange,
  onDelete,
  onOpenDocument,
}: {
  recordId: string;
  tableId: string;
  baseId?: string | null;
  fields: Field[];
  record: { id: string; fields: Record<string, unknown> } | null;
  canEdit: boolean;
  fullScreen?: boolean;
  onClose: () => void;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onDelete?: () => void;
  onOpenDocument?: (documentId: string) => void;
}) {
  const [comments, setComments] = useState<Array<{ id: string; userName: string; body: string; createdAt: number }>>([]);
  const [history, setHistory] = useState<Array<{ id: string; action: string; userName: string | null; createdAt: number }>>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<RecordDocumentLink[]>([]);
  const [layout, setLayout] = useState<{
    style: "single" | "multi" | "grouped";
    fieldIds: string[];
    groups: Array<{ id: string; title: string; fieldIds: string[] }>;
    columns?: number;
  } | null>(null);

  async function reload() {
    setComments(await api.comments(recordId));
    setHistory(await api.history(recordId));
    setLayout(await api.getDetailPage(tableId));
    setDocs(await api.recordDocuments(recordId));
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, [recordId, tableId]);

  const orderedFields = (() => {
    if (!layout) return fields;
    if (layout.style === "grouped" && layout.groups.length) {
      return layout.groups.flatMap((group) =>
        group.fieldIds.map((id) => fields.find((field) => field.id === id)).filter((field): field is Field => Boolean(field)),
      );
    }
    if (layout.fieldIds.length) {
      return layout.fieldIds.map((id) => fields.find((field) => field.id === id)).filter((field): field is Field => Boolean(field));
    }
    return fields;
  })();
  const columns = layout?.style === "multi" ? layout.columns || 2 : 1;

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen, onClose]);

  function renderField(field: Field) {
    if (!record) return null;
    return (
      <label key={field.id}>
        {field.name}
        <div className="detail-cell">
          <Cell
            field={field}
            allFields={fields}
            record={record as unknown as PublicRecord}
            value={(record.fields[field.name] ?? null) as DisplayValue}
            readOnly={!canEdit || ["formula", "lookup", "auto_number", "created_time", "updated_time", "created_by"].includes(field.type)}
            onChange={(value) => onChange(recordId, field.name, value)}
          />
        </div>
      </label>
    );
  }

  const content = (
    <>
      {record && (
        <div className={`detail-fields cols-${columns}`}>
          {layout?.style === "grouped" && layout.groups.length
            ? layout.groups.map((group) => (
                <section key={group.id} className="detail-group">
                  <h3 className="section-title">{group.title}</h3>
                  {group.fieldIds.map((id) => {
                    const field = fields.find((item) => item.id === id);
                    if (!field) return null;
                    return renderField(field);
                  })}
                </section>
              ))
            : orderedFields.map((field) => renderField(field))}
        </div>
      )}
      <div className="dialog-actions">
        {canEdit && onDelete && (
          <button
            type="button"
            className="danger-text"
            onClick={() => {
              if (window.confirm("删除这条记录？此操作不可撤销。")) onDelete();
            }}
          >
            删除记录
          </button>
        )}
      </div>
      <h3 className="section-title">相关文档</h3>
      <ul className="member-list">
        {docs.map((doc) => (
          <li key={doc.id}>
            <div>
              <strong>
                {doc.icon || "📄"} {doc.title}
              </strong>
              {doc.label && <span>{doc.label}</span>}
            </div>
            {onOpenDocument && (
              <button type="button" onClick={() => onOpenDocument(doc.id)}>
                打开
              </button>
            )}
          </li>
        ))}
        {!docs.length && <li className="doc-hint">还没有关联文档。</li>}
      </ul>
      {canEdit && baseId && (
        <div className="share-add">
          <button
            type="button"
            onClick={async () => {
              try {
                const created = await api.createDocument(baseId, { template: "experiment-plan", title: "实验前思考" });
                await api.linkDocumentRecord(created.id, recordId, "实验前思考");
                setDocs(await api.recordDocuments(recordId));
                onOpenDocument?.(created.id);
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            ＋ 实验前思考
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const created = await api.createDocument(baseId, { template: "experiment-review", title: "实验复盘" });
                await api.linkDocumentRecord(created.id, recordId, "实验复盘");
                setDocs(await api.recordDocuments(recordId));
                onOpenDocument?.(created.id);
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            ＋ 实验复盘
          </button>
        </div>
      )}
      <h3 className="section-title">评论</h3>
      <ul className="member-list">
        {comments.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.userName}</strong>
              <span>{item.body}</span>
            </div>
            {canEdit && (
              <button type="button" onClick={() => api.deleteComment(item.id).then(reload).catch((err) => setError(message(err)))}>
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          className="share-add"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api.addComment(recordId, body);
              setBody("");
              await reload();
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          <input value={body} onChange={(event) => setBody(event.target.value)} placeholder="写一条评论" required />
          <button type="submit" className="primary">发送</button>
        </form>
      )}
      <h3 className="section-title">历史</h3>
      <ul className="member-list">
        {history.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.action}</strong>
              <span>
                {item.userName ?? "系统"} · {new Date(item.createdAt).toLocaleString()}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </>
  );

  if (fullScreen) {
    return (
      <div className="mobile-page" role="dialog" aria-modal="true" aria-label="记录详情">
        <header className="mobile-page-bar">
          <button type="button" className="mobile-back" onClick={onClose}>
            ‹ 返回
          </button>
          <h2>记录详情</h2>
        </header>
        <div className="mobile-page-body">{content}</div>
      </div>
    );
  }

  return (
    <Modal title="记录详情" onClose={onClose} size="wide">
      {content}
    </Modal>
  );
}

function DetailPageDialog({
  tableId,
  fields,
  onClose,
}: {
  tableId: string;
  fields: Field[];
  onClose: () => void;
}) {
  const [style, setStyle] = useState<"single" | "multi" | "grouped">("single");
  const [fieldIds, setFieldIds] = useState<string[]>(fields.map((field) => field.id));
  const [columns, setColumns] = useState<1 | 2 | 3>(2);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getDetailPage(tableId)
      .then((config) => {
        setStyle(config.style);
        setFieldIds(config.fieldIds.length ? config.fieldIds : fields.map((field) => field.id));
        setColumns((config.columns as 1 | 2 | 3) || 2);
      })
      .catch((err) => setError(message(err)));
  }, [tableId, fields]);
  return (
    <Modal title="自定义详情页" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api.setDetailPage(tableId, {
              style,
              fieldIds,
              columns: style === "multi" ? columns : 1,
              groups:
                style === "grouped"
                  ? [
                      { id: "g1", title: "基础信息", fieldIds: fieldIds.slice(0, Math.ceil(fieldIds.length / 2)) },
                      { id: "g2", title: "其他", fieldIds: fieldIds.slice(Math.ceil(fieldIds.length / 2)) },
                    ]
                  : [],
            });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          样式
          <FancySelect
            value={style}
            onChange={(v) => setStyle(v as typeof style)}
            options={[
              { value: "single", label: "单列" },
              { value: "multi", label: "多列" },
              { value: "grouped", label: "分组" },
            ]}
          />
        </label>
        {style === "multi" && (
          <label>
            列数
            <FancySelect
              value={String(columns)}
              onChange={(v) => setColumns(Number(v) as 1 | 2 | 3)}
              options={[
                { value: "2", label: "2" },
                { value: "3", label: "3" },
              ]}
            />
          </label>
        )}
        <label>
          字段顺序（逗号分隔 id，默认全部）
          <textarea
            rows={4}
            value={fieldIds.join(",")}
            onChange={(event) =>
              setFieldIds(
                event.target.value
                  .split(/[,，\s]+/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
        <p className="fine">可选字段：{fields.map((field) => `${field.name}(${field.id})`).join(" · ")}</p>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </Modal>
  );
}

function ColorRulesDialog({
  fields,
  view,
  onClose,
  onSubmit,
}: {
  fields: Field[];
  view: View;
  onClose: () => void;
  onSubmit: (rules: NonNullable<View["config"]["colorRules"]>) => Promise<void>;
}) {
  const [rules, setRules] = useState(view.config.colorRules ?? []);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="条件填色" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSubmit(rules);
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        {rules.map((rule, index) => (
          <div key={rule.id} className="filter-row">
            <FancySelect
              compact
              value={rule.fieldId}
              onChange={(fieldId) => {
                const next = [...rules];
                next[index] = { ...rule, fieldId };
                setRules(next);
              }}
              options={fields.map((field) => ({ value: field.id, label: field.name }))}
            />
            <FancySelect
              compact
              value={rule.op}
              onChange={(op) => {
                const next = [...rules];
                next[index] = { ...rule, op: op as typeof rule.op };
                setRules(next);
              }}
              options={[
                { value: "eq", label: "等于" },
                { value: "neq", label: "不等于" },
                { value: "contains", label: "包含" },
                { value: "is_empty", label: "为空" },
              ]}
            />
            <input
              value={rule.value ?? ""}
              onChange={(event) => {
                const next = [...rules];
                next[index] = { ...rule, value: event.target.value };
                setRules(next);
              }}
              placeholder="值"
            />
            <input
              type="color"
              value={rule.color.startsWith("#") ? rule.color : "#fef3c7"}
              onChange={(event) => {
                const next = [...rules];
                next[index] = { ...rule, color: event.target.value };
                setRules(next);
              }}
            />
            <button type="button" onClick={() => setRules(rules.filter((item) => item.id !== rule.id))}>
              删
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() =>
            setRules([
              ...rules,
              {
                id: `cr_${Math.random().toString(36).slice(2, 8)}`,
                fieldId: fields[0]?.id ?? "",
                op: "eq",
                value: "",
                color: "#fef3c7",
                target: "row",
              },
            ])
          }
        >
          ＋ 规则
        </button>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </Modal>
  );
}

function AutomationDialog({
  tableId,
  baseId,
  canOwn,
  fields,
  onClose,
}: {
  tableId: string;
  baseId: string | null;
  canOwn: boolean;
  fields: Field[];
  onClose: () => void;
}) {
  const [items, setItems] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [savedWebhook, setSavedWebhook] = useState("");
  const [webhookDraft, setWebhookDraft] = useState("");
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [name, setName] = useState("新建时设为待办");
  const [triggerType, setTriggerType] = useState<"record_created" | "webhook" | "button" | "schedule">("record_created");
  const [fieldId, setFieldId] = useState(fields.find((field) => field.type === "single_select")?.id ?? fields[0]?.id ?? "");
  const [buttonFieldId, setButtonFieldId] = useState(fields.find((field) => field.type === "button")?.id ?? "");
  const [value, setValue] = useState("待办");
  const [actionType, setActionType] = useState<"set_field" | "http_request" | "add_comment" | "send_email" | "feishu_bot" | "feishu_digest" | "run_agent">("set_field");
  const [httpUrl, setHttpUrl] = useState("https://example.com/hook");
  const [webhookSecret, setWebhookSecret] = useState("duowei");
  const [scheduleCron, setScheduleCron] = useState("every:5");
  const [commentBody, setCommentBody] = useState("自动化备注 {recordId}");
  const [emailTo, setEmailTo] = useState("ops@example.com");
  const [emailSubject, setEmailSubject] = useState("知行人生通知");
  const [emailText, setEmailText] = useState("记录 {recordId} 触发了自动化");
  const [feishuText, setFeishuText] = useState("【知行人生】{标题} · {状态} · 截止 {截止日期}");
  const [agentItems, setAgentItems] = useState<LlmAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("请按你的任务指令处理一次，并简要汇报结果。");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feishuNeeded = items.some((item) => item.actions.some((action) => action.type === "feishu_bot" || action.type === "feishu_digest"));
  const webhookReady = Boolean(savedWebhook);
  async function reload() {
    const [list, history, agentList] = await Promise.all([api.automations(tableId), api.automationRuns(tableId), api.llmAgents()]);
    setItems(list);
    setRuns(history);
    const usable = agentList.filter((agent) => agent.status === "enabled" && (!agent.baseId || agent.baseId === baseId));
    setAgentItems(usable);
    setAgentId((current) => (current && usable.some((agent) => agent.id === current) ? current : (usable[0]?.id ?? "")));
    if (baseId) {
      const settings = await api.getSettings(baseId);
      const current = settings.integrations?.feishuWebhookUrl ?? "";
      setSavedWebhook(current);
      setWebhookDraft((draft) => (draft ? draft : current));
    }
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, [tableId, baseId]);
  async function saveWebhook() {
    if (!baseId) return;
    setError(null);
    setNotice(null);
    try {
      await api.updateSettings(baseId, { integrations: { feishuWebhookUrl: webhookDraft.trim() } });
      setSavedWebhook(webhookDraft.trim());
      setNotice(webhookDraft.trim() ? "飞书机器人已保存。" : "已清空飞书机器人地址，飞书动作将不会发送。");
    } catch (err) {
      setError(message(err));
    }
  }
  async function sendTest() {
    if (!baseId) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api.testFeishu(baseId, webhookDraft.trim() ? { webhookUrl: webhookDraft.trim() } : undefined);
      setNotice("测试消息已发出，请到飞书群里确认。");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function runNow(automationId: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await api.runAutomation(automationId);
      setOpenRuns(automationId);
      setNotice(`试跑结果：${runStatusLabel(result.run.status)}（${result.run.detail}）`);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="自动化" onClose={onClose} size="wide">
      <p className="fine">
        支持创建触发、按钮、Webhook、定时；定时格式：every:5 / daily:09:00 / weekly:1:09:00 / 0 9 * * *；动作含改字段、评论、HTTP、邮件、飞书机器人、调用智能体。
      </p>
      {feishuNeeded && (
        <div className={`automation-setup${webhookReady ? "" : " is-missing"}`}>
          <div className="automation-setup-head">
            <strong>{webhookReady ? "飞书机器人已配置" : "飞书自动化不会发送：尚未配置飞书机器人 Webhook"}</strong>
            {webhookReady && <span className="tag green">{webhookLabel(savedWebhook)}</span>}
          </div>
          <p className="fine" style={{ margin: 0 }}>
            在飞书群里添加「自定义机器人」，把 Webhook 地址粘贴到这里；配置后可以点「发送测试消息」验证连通。
          </p>
          <div className="automation-setup-row">
            <input
              value={webhookDraft}
              onChange={(event) => setWebhookDraft(event.target.value)}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
              disabled={!canOwn}
            />
            <button type="button" onClick={saveWebhook} disabled={!canOwn}>
              保存
            </button>
            <button type="button" className="primary" onClick={sendTest} disabled={busy || !webhookDraft.trim()}>
              发送测试消息
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const trigger =
              triggerType === "webhook"
                ? { type: "webhook" as const, secret: webhookSecret || undefined }
                : triggerType === "button"
                  ? { type: "button" as const, fieldId: buttonFieldId }
                  : triggerType === "schedule"
                    ? { type: "schedule" as const, cron: scheduleCron }
                    : { type: "record_created" as const };
            const actions =
              actionType === "http_request"
                ? [{ type: "http_request" as const, url: httpUrl, method: "POST" as const }]
                : actionType === "add_comment"
                  ? [{ type: "add_comment" as const, body: commentBody }]
                  : actionType === "send_email"
                    ? [{ type: "send_email" as const, to: emailTo, subject: emailSubject, text: emailText }]
                    : actionType === "feishu_bot"
                      ? [{ type: "feishu_bot" as const, text: feishuText }]
                      : actionType === "feishu_digest"
                        ? [{ type: "feishu_digest" as const, daysAhead: 2, excludeStatuses: ["已完成", "已搁置"] }]
                        : actionType === "run_agent"
                          ? [{ type: "run_agent" as const, agentId, prompt: agentPrompt }]
                    : [{ type: "set_field" as const, fieldId, value }];
            await api.createAutomation(tableId, { name, trigger, actions });
            await reload();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          触发方式
          <FancySelect
            value={triggerType}
            onChange={(v) => setTriggerType(v as typeof triggerType)}
            options={[
              { value: "record_created", label: "记录创建" },
              { value: "button", label: "按钮字段" },
              { value: "webhook", label: "Webhook" },
              { value: "schedule", label: "定时" },
            ]}
          />
        </label>
        {triggerType === "button" && (
          <label>
            按钮字段
            <FancySelect
              value={buttonFieldId}
              required
              onChange={setButtonFieldId}
              options={fields
                .filter((field) => field.type === "button")
                .map((field) => ({ value: field.id, label: field.name }))}
            />
          </label>
        )}
        {triggerType === "webhook" && (
          <label>
            Webhook 密钥（可选）
            <input value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} />
          </label>
        )}
        {triggerType === "schedule" && (
          <label>
            周期表达式
            <FancySelect
              value={["every:5", "every:60", "hourly", "daily:09:00", "weekly:1:09:00", "0 9 * * *"].includes(scheduleCron) ? scheduleCron : "__custom__"}
              onChange={(v) => {
                if (v !== "__custom__") setScheduleCron(v);
              }}
              options={[
                { value: "every:5", label: "每 5 分钟" },
                { value: "every:60", label: "每 60 分钟" },
                { value: "hourly", label: "每小时" },
                { value: "daily:09:00", label: "每天 09:00" },
                { value: "weekly:1:09:00", label: "每周一 09:00" },
                { value: "0 9 * * *", label: "cron：每天 9 点" },
                { value: "__custom__", label: "自定义…" },
              ]}
            />
            <input
              value={scheduleCron}
              onChange={(event) => setScheduleCron(event.target.value)}
              placeholder="every:5 / daily:09:00 / weekly:1:09:00"
              required
              style={{ marginTop: 6 }}
            />
          </label>
        )}
        <label>
          动作
          <FancySelect
            value={actionType}
            onChange={(v) => setActionType(v as typeof actionType)}
            options={[
              { value: "set_field", label: "设置字段" },
              { value: "add_comment", label: "添加评论" },
              { value: "http_request", label: "HTTP 请求" },
              { value: "send_email", label: "发送邮件" },
              { value: "feishu_bot", label: "飞书机器人（单条）" },
              { value: "feishu_digest", label: "飞书待办摘要" },
              { value: "run_agent", label: "调用智能体" },
            ]}
          />
        </label>
        {actionType === "set_field" && (
          <>
            <label>
              设置字段
              <FancySelect
                value={fieldId}
                onChange={setFieldId}
                options={fields.map((field) => ({ value: field.id, label: field.name }))}
              />
            </label>
            <label>
              值
              <input value={value} onChange={(event) => setValue(event.target.value)} required />
            </label>
          </>
        )}
        {actionType === "add_comment" && (
          <label>
            评论内容
            <input value={commentBody} onChange={(event) => setCommentBody(event.target.value)} required />
          </label>
        )}
        {actionType === "http_request" && (
          <label>
            URL
            <input value={httpUrl} onChange={(event) => setHttpUrl(event.target.value)} required />
          </label>
        )}
        {actionType === "feishu_bot" && (
          <label>
            飞书文本（可用 {"{字段名}"}）
            <input value={feishuText} onChange={(event) => setFeishuText(event.target.value)} required />
          </label>
        )}
        {actionType === "feishu_digest" && (
          <p className="fine">将汇总截止日期在未来 2 天内、且未完成的记录，推到本空间配置的飞书机器人。</p>
        )}
        {actionType === "run_agent" && (
          <>
            {agentItems.length === 0 ? (
              <p className="fine">
                还没有启用中的智能体：请管理员到右上角「智能体」里新建并启用一个，再回到这里挂到自动化上。
              </p>
            ) : (
              <>
                <label>
                  智能体
                  <FancySelect
                    value={agentId}
                    onChange={setAgentId}
                    options={agentItems.map((agent) => ({ value: agent.id, label: agent.name }))}
                  />
                </label>
                <label>
                  指令（可用 {"{字段名}"}）
                  <input value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} required />
                </label>
                <p className="fine">
                  运行会以智能体负责人的身份执行；定时触发时不带记录上下文，适合「每日 9 点汇总进度」这类任务。
                </p>
              </>
            )}
          </>
        )}
        {actionType === "send_email" && (
          <>
            <label>
              收件人
              <input value={emailTo} onChange={(event) => setEmailTo(event.target.value)} required />
            </label>
            <label>
              主题
              <input value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} required />
            </label>
            <label>
              正文
              <input value={emailText} onChange={(event) => setEmailText(event.target.value)} required />
            </label>
          </>
        )}
        <button type="submit" className="primary" disabled={actionType === "run_agent" && !agentId}>
          添加规则
        </button>
      </form>
      <ul className="member-list automation-list">
        {items.map((item) => {
          const history = runs.filter((run) => run.automationId === item.id).slice(0, 20);
          const latest = history[0] ?? null;
          const expanded = openRuns === item.id;
          return (
            <li key={item.id} className="automation-item">
              <div>
                <strong>{item.name}</strong>
                <span>
                  {item.enabled ? "已启用" : "已停用"} · {item.trigger.type}
                  {item.trigger.type === "webhook" ? ` · POST /api/webhooks/automations/${item.id}` : ""}
                </span>
                <span className="automation-run-hint">
                  <span className={`tag ${runStatusTone(latest?.status ?? null)}`}>
                    {latest ? `${runStatusLabel(latest.status)} · ${formatWhen(latest.createdAt)}` : "尚无运行记录"}
                  </span>
                  {latest && <span>{latest.detail}</span>}
                </span>
                {history.length > 1 && (
                  <button type="button" className="link-btn" onClick={() => setOpenRuns(expanded ? null : item.id)}>
                    {expanded ? "收起运行记录" : `最近 ${history.length} 次运行`}
                  </button>
                )}
                {expanded && (
                  <ul className="automation-runs">
                    {history.map((run) => (
                      <li key={run.id}>
                        <time>{formatWhen(run.createdAt)}</time>
                        <span className={`tag ${runStatusTone(run.status)}`}>{runStatusLabel(run.status)}</span>
                        <span>{run.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" onClick={() => runNow(item.id)} disabled={busy || !item.enabled}>
                试跑
              </button>
              <button
                type="button"
                onClick={() =>
                  api.updateAutomation(item.id, { enabled: !item.enabled }).then(reload).catch((err) => setError(message(err)))
                }
              >
                {item.enabled ? "停用" : "启用"}
              </button>
              <button type="button" onClick={() => api.deleteAutomation(item.id).then(reload).catch((err) => setError(message(err)))}>
                删除
              </button>
            </li>
          );
        })}
      </ul>
      {notice && <p className="form-ok">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function runStatusLabel(status: "ok" | "failed" | "skipped") {
  if (status === "ok") return "成功";
  if (status === "failed") return "失败";
  return "跳过";
}

function runStatusTone(status: "ok" | "failed" | "skipped" | null) {
  if (status === "ok") return "green";
  if (status === "failed") return "red";
  if (status === "skipped") return "yellow";
  return "gray";
}

function webhookLabel(webhook: string) {
  try {
    const url = new URL(webhook);
    return `${url.hostname}/…${url.pathname.slice(-6)}`;
  } catch {
    return "已配置";
  }
}

function CalendarFeishuDialog({
  baseId,
  tableId,
  fields,
  canOwn,
  onClose,
}: {
  baseId: string;
  tableId: string;
  fields: Field[];
  canOwn: boolean;
  onClose: () => void;
}) {
  const [webhook, setWebhook] = useState("");
  const [feeds, setFeeds] = useState<Array<{ id: string; token: string }>>([]);
  const [dateFieldId, setDateFieldId] = useState(fields.find((field) => field.name === "截止日期")?.id ?? fields.find((field) => field.type === "date")?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const dateFields = fields.filter((field) => field.type === "date");
  const subscribeUrl = (token: string) => `${window.location.origin}/api/calendar/${token}.ics`;

  async function reload() {
    const [settings, list] = await Promise.all([api.getSettings(baseId), api.calendarFeeds(tableId)]);
    setWebhook(settings.integrations?.feishuWebhookUrl ?? "");
    setFeeds(list);
  }

  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, [baseId, tableId]);

  return (
    <Modal title="日历与飞书" onClose={onClose} size="wide">
      <p className="fine">
        飞书：在群里添加「自定义机器人」，复制 Webhook。日历：把 ICS 地址订阅到苹果日历、Google Calendar 或飞书日历。
      </p>
      <label>
        飞书机器人 Webhook
        <input
          value={webhook}
          onChange={(event) => setWebhook(event.target.value)}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
          disabled={!canOwn}
        />
      </label>
      <div className="dialog-actions" style={{ justifyContent: "flex-start", marginBottom: 16 }}>
        {canOwn && (
          <button
            type="button"
            className="primary"
            onClick={() =>
              api
                .updateSettings(baseId, { integrations: { feishuWebhookUrl: webhook } })
                .then(() => setHint("已保存飞书地址"))
                .catch((err) => setError(message(err)))
            }
          >
            保存
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            api
              .testFeishu(baseId, { webhookUrl: webhook || undefined })
              .then(() => setHint("已向飞书发送测试消息"))
              .catch((err) => setError(message(err)))
          }
        >
          发送测试
        </button>
        <button
          type="button"
          onClick={() =>
            api
              .sendFeishuDigest(tableId)
              .then((result) => setHint(result.sent ? `已推送 ${result.count} 条待办到飞书` : "未发送（检查 Webhook 或近期待办）"))
              .catch((err) => setError(message(err)))
          }
        >
          推送待办摘要
        </button>
      </div>
      <h3 className="section-title">日历订阅</h3>
      <label>
        日期字段
        <FancySelect
          value={dateFieldId}
          onChange={setDateFieldId}
          options={dateFields.map((field) => ({ value: field.id, label: field.name }))}
        />
      </label>
      <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
        <a className="button" href={`/api/tables/${tableId}/calendar.ics${dateFieldId ? `?dateFieldId=${dateFieldId}` : ""}`}>
          下载 ICS
        </a>
        <button
          type="button"
          className="primary"
          onClick={() =>
            api
              .createCalendarFeed(tableId, { dateFieldId: dateFieldId || undefined })
              .then(async (feed) => {
                await reload();
                setHint(`订阅地址：${subscribeUrl(feed.token)}`);
              })
              .catch((err) => setError(message(err)))
          }
        >
          生成订阅链接
        </button>
      </div>
      <ul className="member-list">
        {feeds.map((feed) => (
          <li key={feed.id}>
            <div>
              <strong>ICS 订阅</strong>
              <span>{subscribeUrl(feed.token)}</span>
            </div>
            <button type="button" onClick={() => navigator.clipboard.writeText(subscribeUrl(feed.token)).then(() => setHint("已复制"))}>
              复制
            </button>
            <button type="button" onClick={() => api.deleteCalendarFeed(feed.id).then(reload).catch((err) => setError(message(err)))}>
              删除
            </button>
          </li>
        ))}
      </ul>
      {hint && <p className="fine">{hint}</p>}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

/**
 * 部署环境一律走 IP 直连：云厂商（阿里云）会按 Host / TLS SNI 里的未备案域名拦截，
 * 用 IP 作 Host 不会被拦。Agent 说明里只写 IP 入口，避免 Agent 拿到域名后请求被 403 / RST。
 */
const AGENT_IP_ORIGIN = "http://47.122.123.1";

/** 本地开发或已用 IP 直连时沿用当前地址；否则（域名）改写成 IP 入口。 */
function resolveAgentOrigin(): string {
  if (typeof window === "undefined") return AGENT_IP_ORIGIN;
  const current = window.location.origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(current)) return current;
  if (/^https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(current)) return current;
  return AGENT_IP_ORIGIN;
}

function buildAgentBrief(origin: string, token: string) {
  const cleanOrigin = origin.replace(/\/$/, "");
  const cleanToken = token.trim() || "dwa_把令牌粘贴到这里";
  return `# 知行人生 · Agent 使用说明（请完整阅读后开始操作）

你正在协助用户使用「知行人生」——一套自托管的人生管理工具（空间 / 清单 / 看板 / 日历）。
请用 HTTP 调用其 REST API；不要臆造 tableId / recordId，先 list 再写。

## 接入信息

- **API 根地址**：\`${cleanOrigin}\`
- **务必用这个 IP 直连地址**：服务部署在国内云主机，用域名会被云厂商按未备案域名拦截（HTTP 403 / TLS 握手被重置）。不要把它替换成任何域名。
- **鉴权头**：\`Authorization: Bearer ${cleanToken}\`
- 令牌类型：
  - \`dwa_…\`：MCP Agent 令牌（管理员在网页「Agent 管理」创建/批准后获得，可随时在列表中查看与复制）
  - \`dw_…\`：个人访问令牌（网页「访问令牌」创建；仅 REST）
- 所有请求 \`Content-Type: application/json\`（有 body 时）
- 健康检查（无需登录）：\`GET ${cleanOrigin}/api/health\` → \`{"ok":true}\`

## 每次会话开场（必做）

1. \`GET ${cleanOrigin}/api/auth/me\` — 确认身份
2. \`GET ${cleanOrigin}/api/bases\` — 列出可见「空间」及其「清单」（tables）
3. 选定 \`tableId\` 后：\`GET ${cleanOrigin}/api/tables/{tableId}\` 了解字段与记录
4. 需要筛选：\`POST ${cleanOrigin}/api/tables/{tableId}/query\`，body 示例：
\`\`\`json
{
  "filters": [{ "field": "状态", "op": "eq", "value": "进行中" }],
  "conjunction": "and",
  "limit": 50
}
\`\`\`

若 \`/api/bases\` 为空：请用户在「Agent 管理」中点开你的 Agent「编辑」，勾选可访问的空间。

## 产品语义 ↔ API

| 界面用语 | API |
|----------|-----|
| 空间 | base（\`baseId\`） |
| 清单 / 数据表 | table（\`tableId\`） |
| 记录 | record（\`recordId\`） |
| 字段 | 读写记录时用**字段名**作 JSON 键，不要用内部 field id |

## 写数据约定（极易踩坑）

- \`POST /api/tables/{tableId}/records\` 创建；\`PATCH /api/records/{recordId}\` 更新
- body 形如：\`{ "fields": { "标题": "…", "状态": "进行中", "截止日期": "2026-10-01" } }\`
- **单选**：传选项**名称**（如 \`"进行中"\`），不是选项内部 id
- **多选**：字符串数组
- **日期**：\`YYYY-MM-DD\`
- **公式 / 按钮 / 部分系统字段**：一般不要直接 update
- 筛选运算符：\`eq\` \`neq\` \`contains\` \`not_contains\` \`gt\` \`gte\` \`lt\` \`lte\` \`is_empty\` \`is_not_empty\`

## 常用能力

- 模板建空间：\`POST ${cleanOrigin}/api/templates/{id}\`
  - \`todos\` 个人待办（看板+日历+飞书摘要）
  - \`research\` 科研管理（论文 / 任务 / 投稿）
  - \`requirements\` 需求管理；\`engineering\` 研发进度
- 新建清单：\`POST ${cleanOrigin}/api/bases/{baseId}/tables\`
- 新建字段：\`POST ${cleanOrigin}/api/tables/{tableId}/fields\`
- 评论：\`POST ${cleanOrigin}/api/records/{recordId}/comments\`
- 导出 CSV：\`GET ${cleanOrigin}/api/tables/{tableId}/export.csv\`（同样带 Bearer）
- 飞书：在空间设置里配置 webhook 后，可用相关 integrations 接口测通/发摘要

## 推荐工作流示例

**查并进行中的待办并勾掉一条**
1. \`GET /api/bases\` → 找到「个人待办」空间下的待办表 \`tableId\`
2. \`POST /api/tables/{tableId}/query\`，筛选 \`状态 eq 进行中\`（或表内实际选项名）
3. \`PATCH /api/records/{recordId}\`，\`{ "fields": { "状态": "已完成" } }\`

**从模板开一套科研管理**
1. \`POST /api/templates/research\`
2. \`GET /api/bases\` 确认新空间
3. 按字段名往「论文」「任务」「投稿记录」写记录

## 权限提醒

- Agent 只能看到管理员授权给它的空间
- 删空间 / 部分管理接口需要更高角色；失败时阅读返回 JSON 的 \`error\` 字段，不要重试硬闯
- 不要把令牌写进公开仓库或聊天记录；用户若只给了占位符，先请用户粘贴真实 \`dwa_\` / \`dw_\` 令牌

## 给 Cursor / Codex / WorkBuddy 等的用法

把**本说明全文**贴进对话，并补上真实令牌。然后直接下任务，例如：
「列出我所有空间和清单」「把科研管理里截稿在本周的论文列出来」「在个人待办新建一条：本周五前提交周报」。

你应优先用 REST 完成任务，并在关键操作后用简短中文向用户汇报结果。
`;
}

function AgentBriefDialog({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const origin = resolveAgentOrigin();
  const [token, setToken] = useState("dwa_把令牌粘贴到这里");
  const [copied, setCopied] = useState(false);
  const brief = useMemo(() => buildAgentBrief(origin, token), [origin, token]);

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const area = document.getElementById("agent-brief-text") as HTMLTextAreaElement | null;
      area?.focus();
      area?.select();
      document.execCommand("copy");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Modal title="给 Agent 的使用说明" onClose={onClose} size="wide">
      <p className="fine">
        复制下方说明，粘贴给 Cursor / Codex / WorkBuddy 等 Agent，它们即可按 REST 操作「知行人生」。
        {isAdmin ? " 请先在「Agent 管理」创建 Agent 并复制 dwa_ 令牌填入下方。" : " 请向管理员索取 Agent 令牌（dwa_…），或到「访问令牌」创建个人令牌（dw_…）。"}
      </p>
      <label>
        令牌（会写入说明文本）
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="dwa_… 或 dw_…"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <textarea id="agent-brief-text" className="agent-brief" readOnly value={brief} rows={18} spellCheck={false} />
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="primary" onClick={() => void copyBrief()}>
          {copied ? "已复制" : "复制给 Agent"}
        </button>
      </div>
    </Modal>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const [limits, setLimits] = useState<{
    description: string;
    tablesPerBase: number;
    fieldsPerTable: number;
    viewsPerTable: number;
    cellCaps: Array<{ type: string; cap: string }>;
  } | null>(null);
  useEffect(() => {
    api.limits().then(setLimits).catch(() => setLimits(null));
  }, []);
  return (
    <Modal title="使用说明" onClose={onClose} size="wide">
      <h3 className="section-title">用知行人生推进日子</h3>
      <ol className="fine" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
        <li>日常节奏用「个人待办」；论文与投稿用「科研管理」（论文 + 任务 + 投稿记录）。</li>
        <li>在「日历 / 飞书」填写飞书机器人 Webhook，并把 ICS 订到系统日历或飞书日历。</li>
        <li>从模板或空白新建「空间」，再添加清单与字段。</li>
        <li>用表格 / 看板 / 日历整理节奏；筛选、分组、填色在工具栏。</li>
        <li>需要时在「更多」里配置仪表盘、自动化与日历 / 飞书。</li>
        <li>字段菜单可「更改类型」；按钮动作关联当前记录。</li>
        <li>「数据助手」可本地问数；把对接说明交给外部 Agent：点顶栏「给 Agent」一键复制。</li>
      </ol>
      <h3 className="section-title">按钮类型</h3>
      <p className="fine">
        数据表按钮关联当前行（可评论 / 改字段 / 开链接）。仪表盘或定时消息中的按钮不关联具体记录。
      </p>
      <h3 className="section-title">常见上限</h3>
      {limits ? (
        <ul className="fine" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>{limits.description}</li>
          <li>数据表 / base ≤ {limits.tablesPerBase}；字段 / 表 ≤ {limits.fieldsPerTable}；视图 / 表 ≤ {limits.viewsPerTable}</li>
          {limits.cellCaps.map((item) => (
            <li key={item.type}>
              {item.type}：{item.cap}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">加载上限说明…</p>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </Modal>
  );
}

function ChangeTypeDialog({
  field,
  onClose,
  onSubmit,
}: {
  field: Field;
  onClose: () => void;
  onSubmit: (type: string) => Promise<void>;
}) {
  const [targets, setTargets] = useState<string[]>([]);
  const [nextType, setNextType] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .fieldChangeTargets(field.id)
      .then((data) => {
        setTargets(data.targets);
        setNextType(data.targets[0] ?? "");
      })
      .catch((err) => setError(message(err)));
  }, [field.id]);
  return (
    <Modal title={`更改类型 · ${field.name}`} onClose={onClose}>
      <p className="fine">当前类型：{FIELD_TYPE_LABELS[field.type]}。修改后不可撤销，大表会转换前若干行。</p>
      {targets.length === 0 ? (
        <p className="fine">该字段类型不可变更（系统 / 公式 / 按钮等）。</p>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await onSubmit(nextType);
              onClose();
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          <label>
            新类型
            <FancySelect
              value={nextType}
              required
              onChange={setNextType}
              options={targets.map((type) => ({
                value: type,
                label: FIELD_TYPE_LABELS[type as Field["type"]] ?? type,
              }))}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="primary">
              确认变更
            </button>
          </div>
        </form>
      )}
      {targets.length === 0 && (
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      )}
      {error && targets.length === 0 && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function AssistantPanel({
  tableId,
  tableName,
  onClose,
}: {
  tableId: string;
  tableName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"agent" | "local">("local");
  const [agents, setAgents] = useState<LlmAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [question, setQuestion] = useState("这张表有多少条？");
  const [answer, setAnswer] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tokenHint, setTokenHint] = useState(() => localStorage.getItem("duowei_pat_hint") || "");

  useEffect(() => {
    api
      .tableAgents(tableId)
      .then((list) => {
        setAgents(list);
        if (list.length > 0) {
          setAgentId(list[0].id);
          setTab("agent");
        }
      })
      .catch(() => setAgents([]));
  }, [tableId]);

  async function ask(q: string) {
    setQuestion(q);
    try {
      const result = await api.assistantQuery(tableId, q);
      setAnswer(result.answer);
      setSuggestions(result.suggestions ?? []);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }

  async function askAgent(q: string) {
    const text = q.trim();
    if (!text || !agentId) return;
    const nextMessages = [...messages, { role: "user" as const, content: text }];
    setMessages(nextMessages);
    setAgentBusy(true);
    setAgentError(null);
    setAgentNote(null);
    try {
      const result = await api.agentChat(tableId, {
        agentId,
        question: text,
        history: messages.slice(-10),
      });
      if (result.error || !result.answer) {
        setAgentError(result.error ?? "智能体没有返回内容");
        setMessages(nextMessages);
      } else {
        setMessages([...nextMessages, { role: "assistant", content: result.answer }]);
        const tools = result.steps.filter((step) => step.tool).length;
        setAgentNote(`用时 ${result.durationMs}ms${tools ? `，调用 ${tools} 次工具` : ""}`);
      }
    } catch (err) {
      setAgentError(message(err));
    } finally {
      setAgentBusy(false);
    }
  }

  const localSection = (
    <>
      <p className="fine">
        本地规则问数（非大模型）：条数、字段、按字段统计、数值求和、上限与按钮说明、MCP 工具。令牌用于启动 MCP：
        <code>DUOWEI_TOKEN=… npx tsx src/mcp.ts</code>
      </p>
      <label>
        个人访问令牌备注（仅存本机）
        <input
          value={tokenHint}
          onChange={(event) => {
            setTokenHint(event.target.value);
            localStorage.setItem("duowei_pat_hint", event.target.value);
          }}
          placeholder="在「访问令牌」创建后填备注"
        />
      </label>
      <div className="assist-actions">
        <button type="button" onClick={() => ask("有多少条记录？")}>
          查条数
        </button>
        <button type="button" onClick={() => ask("有哪些字段？")}>
          列字段
        </button>
        <button type="button" onClick={() => ask("按状态统计")}>
          按状态统计
        </button>
        <button type="button" onClick={() => ask("上限是多少？")}>
          上限
        </button>
        <button type="button" onClick={() => ask("按钮类型说明")}>
          按钮说明
        </button>
        <button type="button" onClick={() => ask("MCP 工具")}>
          MCP
        </button>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              await api.createRecord(tableId, {});
              setAnswer("已创建一条空记录。");
              setError(null);
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          创建空记录
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await ask(question);
        }}
      >
        <label>
          提问
          <input value={question} onChange={(event) => setQuestion(event.target.value)} required />
        </label>
        <button type="submit" className="primary">
          询问
        </button>
      </form>
      {suggestions.length > 0 && (
        <div className="assist-actions">
          {suggestions.map((item) => (
            <button type="button" key={item} className="ghost" onClick={() => ask(item)}>
              {item}
            </button>
          ))}
        </div>
      )}
      {answer && <pre className="dev-code">{answer}</pre>}
      {error && <p className="form-error">{error}</p>}
    </>
  );

  return (
    <Modal title={`数据问答 · ${tableName}`} onClose={onClose} size="wide">
      {(agents.length > 0 || tab === "local") && (
        <div className="agent-filters" style={{ marginBottom: 10 }}>
          {agents.length > 0 && (
            <button type="button" className={tab === "agent" ? "is-on" : ""} onClick={() => setTab("agent")}>
              智能体
            </button>
          )}
          <button type="button" className={tab === "local" ? "is-on" : ""} onClick={() => setTab("local")}>
            本地问数
          </button>
        </div>
      )}
      {tab === "agent" ? (
        <>
          <p className="fine">
            智能体按你的身份读写这张表，需要写字段时会先读字段表再动手；回答由大模型生成，涉及数据请自行核对。
          </p>
          {agents.length > 1 && (
            <label>
              智能体
              <FancySelect
                value={agentId}
                onChange={setAgentId}
                options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
              />
            </label>
          )}
          <div className="agent-chat">
            {messages.length === 0 && (
              <p className="fine">
                向「{agents.find((agent) => agent.id === agentId)?.name ?? "智能体"}」提问，例如：这张表里状态为「进行中」的有哪些？帮我新建一条明天的待办。
              </p>
            )}
            {messages.map((item, index) => (
              <div key={index} className={item.role === "user" ? "chat-bubble user" : "chat-bubble assistant"}>
                {item.content}
              </div>
            ))}
            {agentBusy && <div className="chat-bubble assistant">思考中…</div>}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const target = new FormData(event.currentTarget).get("agent-q");
              void askAgent(String(target ?? ""));
              event.currentTarget.reset();
            }}
          >
            <label>
              提问
              <input name="agent-q" placeholder="例如：把截止日期在明天的记录列出来" autoComplete="off" required />
            </label>
            <button type="submit" className="primary" disabled={agentBusy || !agentId}>
              发送
            </button>
          </form>
          {agentNote && <p className="fine">{agentNote}</p>}
          {agentError && <p className="form-error">{agentError}</p>}
        </>
      ) : (
        localSection
      )}
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
  size = "default",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: "default" | "wide" | "narrow";
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [dragY, setDragY] = useState(0);
  const touchStartY = useRef<number | null>(null);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={size === "default" ? "modal" : `modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
      >
        <header
          onTouchStart={(event) => {
            touchStartY.current = event.touches[0].clientY;
          }}
          onTouchMove={(event) => {
            if (touchStartY.current == null) return;
            const dy = event.touches[0].clientY - touchStartY.current;
            setDragY(Math.max(0, dy));
          }}
          onTouchEnd={() => {
            if (dragY > 80) onClose();
            setDragY(0);
            touchStartY.current = null;
          }}
        >
          <span className="modal-grip" aria-hidden />
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function roleLabel(role: string) {
  if (role === "owner") return "所有者";
  if (role === "editor") return "可编辑";
  return "可查看";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作失败";
}
