import { useEffect, useMemo, useRef, useState } from "react";
import { applyQuery } from "../../src/query.js";
import type { BaseMember, BaseSummary, DisplayValue, Field, McpAgent, PublicRecord, PublicUser, RowAccessRule, TablePayload, View, ViewType } from "../../src/types.js";
import { FIELD_TYPE_LABELS, VIEW_TYPE_LABELS } from "../../src/types.js";
import { api, type BackupLogDto, type BackupSettingsDto } from "./api";
import { AuthScreen } from "./AuthScreen";
import { DashboardView } from "./DashboardView";
import { CalendarView, FormView, GalleryView, GanttView } from "./ExtraViews";
import { Cell, GridView } from "./GridView";
import { KanbanView } from "./KanbanView";
import { BottomBar, MobileAgenda, MobileKanban, RecordCardList } from "./mobile";
import { PublicShareScreen } from "./PublicShareScreen";
import { StageEmpty } from "./StageEmpty";
import { DEFAULT_STATUS_FIELD, DEFAULT_STATUS_OPTIONS, pickStatusField } from "./statusField";
import { DropMenu, FancySelect, useMediaQuery } from "./ui";

const FIELD_TYPES = (Object.keys(FIELD_TYPE_LABELS) as Field["type"][]).map((id) => ({
  id,
  label: FIELD_TYPE_LABELS[id],
}));

function parsePublicHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const match = hash.match(/^\/?public\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [publicToken, setPublicToken] = useState<string | null>(() => parsePublicHash());

  useEffect(() => {
    const onHash = () => setPublicToken(parsePublicHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (publicToken) {
      setBooting(false);
      return;
    }
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setBooting(false));
  }, [publicToken]);

  if (publicToken) return <PublicShareScreen token={publicToken} />;
  if (booting) return <div className="boot">正在打开知行人生…</div>;
  if (!user) return <AuthScreen onUser={setUser} />;
  return <Workspace user={user} onUser={setUser} onLogout={() => setUser(null)} />;
}

function Workspace({ user, onUser, onLogout }: { user: PublicUser; onUser: (user: PublicUser) => void; onLogout: () => void }) {
  const [bases, setBases] = useState<BaseSummary[]>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [payload, setPayload] = useState<TablePayload | null>(null);
  const [members, setMembers] = useState<BaseMember[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<string | null>(null);
  const [optionField, setOptionField] = useState<Field | null>(null);
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [appMode, setAppMode] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [kanbanPrompt, setKanbanPrompt] = useState(false);
  const [widgetsKey, setWidgetsKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const detailPushed = useRef(false);
  const dialogPushed = useRef(false);

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
  const myRole = !base
    ? null
    : user.role === "admin"
      ? "owner"
      : members.find((item) => item.userId === user.id)?.role ?? null;
  const canEdit = myRole === "owner" || myRole === "editor";
  const canOwn = myRole === "owner";

  async function refreshBases(prefer?: { baseId?: string | null; tableId?: string | null }) {
    const list = await api.bases();
    setBases(list);
    const nextBase = list.find((item) => item.id === prefer?.baseId) ?? list[0] ?? null;
    const nextTable = nextBase?.tables.find((item) => item.id === prefer?.tableId) ?? nextBase?.tables[0] ?? null;
    setBaseId(nextBase?.id ?? null);
    setTableId(nextTable?.id ?? null);
    if (prefer?.tableId == null || nextTable?.id !== tableId) setViewId(null);
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
      if (typing || !canEdit || appMode || !payload) return;
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
  }, [dialog, detailRecordId, showDashboard, navOpen, canEdit, appMode, payload]);

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
  /** 表里能填进表单的字段（排除系统字段） */
  const formFields = (payload?.fields ?? []).filter(
    (field) => !["auto_number", "created_time", "updated_time", "created_by", "formula", "lookup", "button"].includes(field.type),
  );

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
  const editCluster = canEdit ? (
    <div className="toolbar-cluster">
      <button
        type="button"
        onClick={async () => {
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
        }}
      >
        导出
      </button>
      <button type="button" onClick={() => setDialog("import")}>
        导入
      </button>
      <button type="button" onClick={() => setDialog("automations")}>
        自动化
      </button>
      <button type="button" onClick={() => setDialog("workflows")}>
        工作流
      </button>
      <button type="button" onClick={() => setDialog("sync")}>
        同步
      </button>
      <button type="button" onClick={() => setDialog("plugins")}>
        插件
      </button>
    </div>
  ) : null;
  const mainCluster = (
    <div className="toolbar-cluster">
      <button type="button" onClick={() => setDialog("assistant")}>
        AI 助手
      </button>
      {base && (
        <button type="button" onClick={() => setShowDashboard(true)}>
          仪表盘
        </button>
      )}
      {canOwn && <button type="button" onClick={() => setDialog("share")}>分享</button>}
      {canEdit && payload && (
        <button type="button" onClick={() => setDialog("public-share")}>
          公开分享
        </button>
      )}
      {canOwn && <button type="button" onClick={() => setDialog("acl")}>权限</button>}
      {canOwn && <button type="button" onClick={() => setDialog("portal")}>门户</button>}
      {canEdit && <button type="button" onClick={() => setDialog("calendar-feishu")}>日历 / 飞书</button>}
      {base && (
        <button type="button" onClick={() => setAppMode((value) => !value)}>
          {appMode ? "退出应用" : "应用模式"}
        </button>
      )}
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
            { value: "locked", label: "锁定视图" },
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
      {canEdit && !appMode && (
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
    <div className="app">
      {isMobile && navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={isMobile && navOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          知行人生
        </div>
        <div className="side-scroll">
          {bases.map((item) => (
            <div key={item.id} className={item.id === baseId ? "base open" : "base"}>
              <div className="base-head">
                <button
                  type="button"
                  className="base-name"
                  onClick={() => {
                    setBaseId(item.id);
                    setTableId(item.tables[0]?.id ?? null);
                    setViewId(null);
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
              {item.tables.map((table) => (
                <div key={table.id} className={table.id === tableId ? "table-row on" : "table-row"}>
                  <button
                    type="button"
                    className="table-link"
                    onClick={() => {
                      setBaseId(item.id);
                      setTableId(table.id);
                      setViewId(null);
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
            </div>
          ))}
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
          <div className="top-title">
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
            {payload && canOwn && !appMode && !isMobile && (
              <button
                type="button"
                className="ghost danger-text"
                onClick={() => deleteCurrentTable().catch(fail)}
              >
                删除清单
              </button>
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
                {payload && canOwn && !appMode && (
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
        {payload && view && !showDashboard && (
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
                {editCluster}
                {mainCluster}
                <span className="count">{records.length} 条</span>
              </div>
            )}
            {isMobile && (
              <div className="toolbar-right">
                {mobileSearch || search ? searchInput : null}
                {filterButton}
                <button type="button" onClick={() => setDialog("assistant")}>
                  AI 助手
                </button>
                <DropMenu ariaLabel="更多操作" panelClassName="toolbar-more">
                  {viewMiscControls}
                  {gridTuning}
                  {kanbanTuning}
                  {dateTuning}
                  {editCluster}
                  {mainCluster}
                </DropMenu>
                <span className="count">{records.length} 条</span>
              </div>
            )}
          </div>
        )}
        {showDashboard && base ? (
          <DashboardView baseId={base.id} tables={base.tables} onClose={() => setShowDashboard(false)} />
        ) : (
        <div className="stage">
          {appMode && base && <AppWidgets key={widgetsKey} baseId={base.id} />}
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
                readOnly={!canEdit || appMode}
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
              readOnly={!canEdit || appMode}
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
              onShareRecord={(record) => {
                api
                  .shareRecord(record.id, 30)
                  .then(async (created) => {
                    try {
                      await navigator.clipboard.writeText(created.token);
                      setNotice(`只读分享令牌已复制到剪贴板：${created.token}`);
                    } catch {
                      setNotice(`只读分享令牌：${created.token}`);
                    }
                  })
                  .catch(fail);
              }}
            />
            ))}
          {payload && view?.type === "kanban" && groupField &&
            (isMobile ? (
              <MobileKanban
                fields={visibleFields}
                records={records}
                groupField={groupField}
                readOnly={!canEdit || appMode}
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
                readOnly={!canEdit || appMode}
                onChange={onChange}
                onDelete={(recordId) => api.deleteRecord(recordId).then(() => reloadTable()).catch(fail)}
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
                readOnly={!canEdit || appMode}
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
                readOnly={!canEdit || appMode}
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
                readOnly={!canEdit || appMode}
                onOpen={setDetailRecordId}
                onAdd={() => api.createRecord(payload.id, {}).then(() => reloadTable()).catch(fail)}
              />
            ))}
          {payload && view?.type === "form" &&
            (formFields.length === 0 ? (
              <StageEmpty
                icon="▢"
                title="这个表单还没有可填写的字段"
                description="表单只展示能手动填写的字段，公式、创建时间一类的系统字段不会出现在这里。"
                tone="calm"
                actions={
                  canEdit ? (
                    <button type="button" className="primary" onClick={() => setDialog("field")}>
                      ＋ 新建字段
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <FormView
                fields={visibleFields}
                readOnly={!canEdit || appMode}
                onSubmit={async (values) => {
                  await api.createRecord(payload.id, values);
                  await reloadTable();
                }}
              />
            ))}
        </div>
        )}
      </section>
      {isMobile && !appMode && !showDashboard && payload && view && (
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
        <AutomationDialog tableId={payload.id} fields={payload.fields} onClose={closeDialog} />
      )}
      {dialog === "acl" && payload && canOwn && (
        <AclDialog
          tableId={payload.id}
          fields={payload.fields}
          members={members}
          records={payload.records}
          onClose={closeDialog}
        />
      )}
      {dialog === "workflows" && payload && (
        <WorkflowDialog
          tableId={payload.id}
          fields={payload.fields}
          baseId={base?.id}
          onClose={closeDialog}
        />
      )}
      {dialog === "sync" && base && (
        <SyncDialog tables={base.tables} onClose={closeDialog} />
      )}
      {dialog === "plugins" && (
        <PluginMarketDialog onClose={closeDialog} />
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
      {dialog === "portal" && base && canOwn && (
        <PortalDialog
          baseId={base.id}
          tables={base.tables}
          onClose={() => {
            closeDialog();
            setWidgetsKey((value) => value + 1);
          }}
        />
      )}
      {detailRecordId && payload && (
        <RecordDetailDialog
          recordId={detailRecordId}
          tableId={payload.id}
          fields={payload.fields}
          record={payload.records.find((item) => item.id === detailRecordId) ?? null}
          canEdit={canEdit && !appMode}
          fullScreen={isMobile}
          onClose={closeDetail}
          onChange={onChange}
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
      {dialog === "public-share" && payload && view && (
        <PublicShareDialog
          tableId={payload.id}
          views={payload.views}
          currentViewId={view.id}
          onClose={closeDialog}
        />
      )}
      {dialog === "tokens" && <TokenDialog onClose={closeDialog} />}
      {dialog === "admin" && <AdminDialog selfId={user.id} onSelf={onUser} onClose={closeDialog} />}
      {dialog === "backup" && user.role === "admin" && <BackupDialog onClose={closeDialog} />}
      {dialog === "agents" && user.role === "admin" && (
        <AgentManageDialog bases={bases} onClose={closeDialog} />
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
  const selectable = type === "single_select" || type === "multi_select";
  const linkFields = (fields ?? []).filter((field) => field.type === "link" || field.type === "duplex_link");
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
            options={FIELD_TYPES.map((item) => ({ value: item.id, label: item.label }))}
          />
        </label>
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

function PublicShareDialog({
  tableId,
  views,
  currentViewId,
  onClose,
}: {
  tableId: string;
  views: View[];
  currentViewId: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"view" | "form">("view");
  const [viewId, setViewId] = useState(currentViewId);
  const [list, setList] = useState<
    Array<{
      id: string;
      kind: "view" | "form";
      token: string;
      enabled: boolean;
      viewId: string | null;
      createdAt: number;
    }>
  >([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setList(await api.listPublicShares(tableId));
  }

  useEffect(() => {
    refresh().catch((err) => setError(message(err)));
  }, [tableId]);

  const formViews = views.filter((item) => item.type === "form");

  return (
    <Modal title="公开分享" onClose={onClose} size="wide">
      <p className="fine">生成无需登录即可访问的视图或表单链接（hash：`#/public/令牌`）。</p>
      <form
        className="share-add"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await api.createPublicShare(tableId, {
              kind,
              viewId: kind === "view" ? viewId : formViews[0]?.id ?? viewId,
            });
            setCreatedToken(result.token);
            await refresh();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <FancySelect
          value={kind}
          compact
          onChange={(v) => setKind(v as "view" | "form")}
          options={[
            { value: "view", label: "独立分享视图" },
            { value: "form", label: "公开表单" },
          ]}
        />
        {kind === "view" && (
          <FancySelect
            value={viewId}
            compact
            onChange={setViewId}
            options={views.map((item) => ({
              value: item.id,
              label: `${item.name}（${VIEW_TYPE_LABELS[item.type]}）`,
            }))}
          />
        )}
        <button type="submit" className="primary">
          创建链接
        </button>
      </form>
      {createdToken && (
        <p className="fine">
          完整链接：<code>{`${window.location.origin}${window.location.pathname}#/public/${createdToken}`}</code>
        </p>
      )}
      <ul className="member-list">
        {list.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.kind === "form" ? "公开表单" : "分享视图"}</strong>
              <span>
                {item.token}… · {item.enabled ? "启用" : "已关闭"}
              </span>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.setPublicShareEnabled(item.id, !item.enabled);
                  await refresh();
                } catch (err) {
                  setError(message(err));
                }
              }}
            >
              {item.enabled ? "关闭" : "启用"}
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                try {
                  await api.deletePublicShare(item.id);
                  await refresh();
                } catch (err) {
                  setError(message(err));
                }
              }}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
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
  const selects = fields.filter((field) => field.type === "single_select");
  const dates = fields.filter((field) => field.type === "date");
  const titles = fields.filter((field) => field.type === "text" || field.type === "long_text");
  const progresses = fields.filter((field) => field.type === "progress" || field.type === "number");
  const links = fields.filter((field) => field.type === "link" || field.type === "duplex_link");
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
              titleField: type === "gallery" || type === "form" || type === "gantt" ? titleField || undefined : undefined,
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
            options={(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((id) => ({
              value: id,
              label: VIEW_TYPE_LABELS[id],
            }))}
          />
        </label>
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
        {(type === "gallery" || type === "form" || type === "gantt") && (
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
  fields,
  record,
  canEdit,
  fullScreen,
  onClose,
  onChange,
  onDelete,
}: {
  recordId: string;
  tableId: string;
  fields: Field[];
  record: { id: string; fields: Record<string, unknown> } | null;
  canEdit: boolean;
  fullScreen?: boolean;
  onClose: () => void;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onDelete?: () => void;
}) {
  const [comments, setComments] = useState<Array<{ id: string; userName: string; body: string; createdAt: number }>>([]);
  const [history, setHistory] = useState<Array<{ id: string; action: string; userName: string | null; createdAt: number }>>([]);
  const [watching, setWatching] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<{
    style: "single" | "multi" | "grouped";
    fieldIds: string[];
    groups: Array<{ id: string; title: string; fieldIds: string[] }>;
    columns?: number;
  } | null>(null);

  async function reload() {
    setComments(await api.comments(recordId));
    setHistory(await api.history(recordId));
    setWatching(await api.watching(recordId));
    setLayout(await api.getDetailPage(tableId));
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
        <button
          type="button"
          onClick={async () => {
            try {
              if (watching) await api.unwatch(recordId);
              else await api.watch(recordId);
              setWatching(!watching);
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          {watching ? "取消关注" : "关注记录"}
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={async () => {
              try {
                const created = await api.shareRecord(recordId, 30);
                setShareToken(created.token);
              } catch (err) {
                setError(message(err));
              }
            }}
          >
            生成分享链接
          </button>
        )}
      </div>
      {shareToken && (
        <p className="dev-code">
          只读分享令牌：<code>{shareToken}</code>
        </p>
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
  fields,
  onClose,
}: {
  tableId: string;
  fields: Field[];
  onClose: () => void;
}) {
  const [items, setItems] = useState<
    Array<{ id: string; name: string; enabled: boolean; trigger: { type: string }; actions: Array<{ type: string }> }>
  >([]);
  const [name, setName] = useState("新建时设为待办");
  const [triggerType, setTriggerType] = useState<"record_created" | "webhook" | "button" | "schedule">("record_created");
  const [fieldId, setFieldId] = useState(fields.find((field) => field.type === "single_select")?.id ?? fields[0]?.id ?? "");
  const [buttonFieldId, setButtonFieldId] = useState(fields.find((field) => field.type === "button")?.id ?? "");
  const [value, setValue] = useState("待办");
  const [actionType, setActionType] = useState<"set_field" | "http_request" | "add_comment" | "send_email" | "feishu_bot" | "feishu_digest">("set_field");
  const [httpUrl, setHttpUrl] = useState("https://example.com/hook");
  const [webhookSecret, setWebhookSecret] = useState("duowei");
  const [scheduleCron, setScheduleCron] = useState("every:5");
  const [commentBody, setCommentBody] = useState("自动化备注 {recordId}");
  const [emailTo, setEmailTo] = useState("ops@example.com");
  const [emailSubject, setEmailSubject] = useState("知行人生通知");
  const [emailText, setEmailText] = useState("记录 {recordId} 触发了自动化");
  const [feishuText, setFeishuText] = useState("【知行人生】{标题} · {状态} · 截止 {截止日期}");
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setItems(await api.automations(tableId));
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, [tableId]);
  return (
    <Modal title="自动化" onClose={onClose} size="wide">
      <p className="fine">
        支持创建触发、按钮、Webhook、定时；定时格式：every:5 / daily:09:00 / weekly:1:09:00 / 0 9 * * *；动作含改字段、评论、HTTP、邮件、飞书机器人。飞书地址在「日历 / 飞书」里配置。
      </p>
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
        <button type="submit" className="primary">添加规则</button>
      </form>
      <ul className="member-list">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>
                {item.enabled ? "已启用" : "已停用"} · {item.trigger.type}
                {item.trigger.type === "webhook" ? ` · POST /api/webhooks/automations/${item.id}` : ""}
              </span>
            </div>
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
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function AclDialog({
  tableId,
  fields,
  members,
  records,
  onClose,
}: {
  tableId: string;
  fields: Field[];
  members: BaseMember[];
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState(members[0]?.userId ?? "");
  const [denied, setDenied] = useState<string[]>([]);
  const [allowedRows, setAllowedRows] = useState<string[]>([]);
  const [rowMode, setRowMode] = useState<"all" | "allow_ids" | "created_by" | "person_in" | "field_equals" | "field_in">("all");
  const [personFieldId, setPersonFieldId] = useState(fields.find((field) => field.type === "person")?.id ?? "");
  const [equalsFieldId, setEqualsFieldId] = useState(fields[0]?.id ?? "");
  const [equalsValue, setEqualsValue] = useState("");
  const [inFieldId, setInFieldId] = useState(fields[0]?.id ?? "");
  const [inValues, setInValues] = useState("");
  const [preview, setPreview] = useState<{ total: number; visible: number; hiddenFieldIds: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const personFields = fields.filter((field) => field.type === "person");

  useEffect(() => {
    api
      .getAcl(tableId)
      .then((acl) => {
        setDenied(acl.columnDeny?.[userId] ?? []);
        const rule = acl.rowRules?.[userId];
        const rows = acl.rowAllow?.[userId] ?? [];
        if (rule?.type === "allow_ids") {
          setRowMode("allow_ids");
          setAllowedRows(rule.recordIds);
        } else if (rule?.type === "created_by") {
          setRowMode("created_by");
          setAllowedRows([]);
        } else if (rule?.type === "person_in") {
          setRowMode("person_in");
          setPersonFieldId(rule.fieldId);
          setAllowedRows([]);
        } else if (rule?.type === "field_equals") {
          setRowMode("field_equals");
          setEqualsFieldId(rule.fieldId);
          setEqualsValue(rule.value);
          setAllowedRows([]);
        } else if (rule?.type === "field_in") {
          setRowMode("field_in");
          setInFieldId(rule.fieldId);
          setInValues(rule.values.join(", "));
          setAllowedRows([]);
        } else if (rows.length) {
          setRowMode("allow_ids");
          setAllowedRows(rows);
        } else {
          setRowMode("all");
          setAllowedRows([]);
        }
        setPreview(null);
      })
      .catch((err) => setError(message(err)));
  }, [tableId, userId]);

  function buildRule(): RowAccessRule {
    if (rowMode === "allow_ids") return { type: "allow_ids", recordIds: allowedRows };
    if (rowMode === "created_by") return { type: "created_by" };
    if (rowMode === "person_in") return { type: "person_in", fieldId: personFieldId };
    if (rowMode === "field_equals") return { type: "field_equals", fieldId: equalsFieldId, value: equalsValue };
    if (rowMode === "field_in") {
      return {
        type: "field_in",
        fieldId: inFieldId,
        values: inValues
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
      };
    }
    return { type: "all" };
  }

  return (
    <Modal title="行列权限" onClose={onClose} size="wide">
      <p className="fine">按成员配置隐藏列，以及条件行权限（创建人 / 人员字段 / 字段等于 / 字段属于集合 / 白名单）。</p>
      <label>
        成员
        <FancySelect
          value={userId}
          onChange={setUserId}
          options={members.map((member) => ({ value: member.userId, label: member.name }))}
        />
      </label>
      <h3 className="section-title">列权限</h3>
      <div className="acl-fields">
        {fields.map((field) => {
          const checked = denied.includes(field.id);
          return (
            <label key={field.id} className="check-line">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  setDenied((current) =>
                    event.target.checked ? [...current, field.id] : current.filter((id) => id !== field.id),
                  )
                }
              />
              隐藏「{field.name}」
            </label>
          );
        })}
      </div>
      <h3 className="section-title">行权限</h3>
      <label>
        可见范围
        <FancySelect
          value={rowMode}
          onChange={(v) => {
            setRowMode(v as typeof rowMode);
            setPreview(null);
          }}
          options={[
            { value: "all", label: "全部行" },
            { value: "created_by", label: "仅自己创建的行" },
            { value: "person_in", label: "人员字段包含自己" },
            { value: "field_equals", label: "字段等于指定值" },
            { value: "field_in", label: "字段属于集合" },
            { value: "allow_ids", label: "仅白名单" },
          ]}
        />
      </label>
      {rowMode === "person_in" && (
        <label>
          人员字段
          <FancySelect
            value={personFieldId}
            onChange={setPersonFieldId}
            options={personFields.map((field) => ({ value: field.id, label: field.name }))}
          />
        </label>
      )}
      {rowMode === "field_equals" && (
        <>
          <label>
            字段
            <FancySelect
              value={equalsFieldId}
              onChange={setEqualsFieldId}
              options={fields.map((field) => ({ value: field.id, label: field.name }))}
            />
          </label>
          <label>
            等于
            <input value={equalsValue} onChange={(event) => setEqualsValue(event.target.value)} placeholder="匹配值" />
          </label>
        </>
      )}
      {rowMode === "field_in" && (
        <>
          <label>
            字段
            <FancySelect
              value={inFieldId}
              onChange={setInFieldId}
              options={fields.map((field) => ({ value: field.id, label: field.name }))}
            />
          </label>
          <label>
            允许值（逗号分隔）
            <input
              value={inValues}
              onChange={(event) => setInValues(event.target.value)}
              placeholder="进行中, 规划中"
              required
            />
          </label>
        </>
      )}
      {rowMode === "allow_ids" && (
        <div className="acl-fields">
          {records.map((record) => {
            const label = String(Object.values(record.fields)[0] ?? record.id);
            const checked = allowedRows.includes(record.id);
            return (
              <label key={record.id} className="check-line">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setAllowedRows((current) =>
                      event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id),
                    )
                  }
                />
                {label}
              </label>
            );
          })}
        </div>
      )}
      {preview && (
        <p className="fine">
          预览：共 {preview.total} 行，该成员可见 {preview.visible} 行；隐藏列 {preview.hiddenFieldIds.length} 个。
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            try {
              const acl = await api.getAcl(tableId);
              await api.setAcl(tableId, {
                rowAllow: {
                  ...(acl.rowAllow ?? {}),
                  [userId]: rowMode === "allow_ids" ? allowedRows : [],
                },
                columnDeny: { ...(acl.columnDeny ?? {}), [userId]: denied },
                rowRules: { ...(acl.rowRules ?? {}), [userId]: buildRule() },
              });
              setPreview(await api.previewAcl(tableId, userId));
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          预览效果
        </button>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              const acl = await api.getAcl(tableId);
              await api.setAcl(tableId, {
                rowAllow: {
                  ...(acl.rowAllow ?? {}),
                  [userId]: rowMode === "allow_ids" ? allowedRows : [],
                },
                columnDeny: { ...(acl.columnDeny ?? {}), [userId]: denied },
                rowRules: { ...(acl.rowRules ?? {}), [userId]: buildRule() },
              });
              onClose();
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

function WorkflowDialog({
  tableId,
  fields,
  onClose,
  baseId,
}: {
  tableId: string;
  fields: Field[];
  onClose: () => void;
  baseId?: string;
}) {
  const [items, setItems] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [runs, setRuns] = useState<
    Array<{
      id: string;
      recordId: string;
      status: string;
      pendingNodeIndex: number;
      nodeLabel: string | null;
      approvers: string[];
      strategy: string;
      votes: Array<{ userName: string; decision: string; comment: string | null }>;
      votedApprovers?: string[];
      pendingApprovers?: string[];
      comment: string | null;
      timedOut: boolean;
      timeoutAt: number | null;
      createdAt: number;
    }>
  >([]);
  const [sla, setSla] = useState<{
    pendingCount: number;
    timedOutCount: number;
    dueSoonCount: number;
    timedOut: Array<{ id: string; recordId: string; nodeLabel: string | null }>;
    dueSoon: Array<{ id: string; recordId: string; nodeLabel: string | null; timeoutAt: number | null }>;
  } | null>(null);
  const [name, setName] = useState("多级审批写入");
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? "");
  const [value, setValue] = useState("已通过");
  const [approvers1, setApprovers1] = useState("");
  const [approvers2, setApprovers2] = useState("");
  const [strategy, setStrategy] = useState<"any" | "all">("any");
  const [timeoutHours, setTimeoutHours] = useState("0");
  const [withApproval, setWithApproval] = useState(true);
  const [multiLevel, setMultiLevel] = useState(true);
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [timelineRunId, setTimelineRunId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<
    Array<{ action: string; actorUserName: string; onBehalfOfUserName: string | null; detail: string | null; createdAt: number }>
  >([]);
  const [proxyName, setProxyName] = useState("");
  const [proxyBaseOnly, setProxyBaseOnly] = useState(true);
  const [proxyWorkflowOnly, setProxyWorkflowOnly] = useState(false);
  const [proxyHours, setProxyHours] = useState("");
  const [proxies, setProxies] = useState<
    Array<{ id: string; proxyUserName: string; baseId: string | null; workflowId: string | null; expiresAt: number | null }>
  >([]);
  const [auditAction, setAuditAction] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [auditRecordId, setAuditRecordId] = useState("");
  const [auditHits, setAuditHits] = useState<
    Array<{ action: string; actorUserName: string; recordId: string | null; detail: string | null; createdAt: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setItems(await api.workflows(tableId));
    const pending = await api.workflowRuns({ tableId, status: "pending" });
    const timed = await api.workflowRuns({ tableId, status: "timed_out" });
    setRuns([...pending, ...timed]);
    setSla(await api.workflowSla({ tableId, withinHours: 48 }));
    const proxy = await api.getApprovalProxy();
    setProxies(proxy.proxies);
  }
  async function loadTimeline(runId: string) {
    setTimelineRunId(runId);
    setTimeline(await api.workflowAudit({ runId }));
  }
  async function searchAudit() {
    setAuditHits(
      await api.workflowAudit({
        tableId,
        baseId,
        action: auditAction || undefined,
        actor: auditActor || undefined,
        recordId: auditRecordId || undefined,
      }),
    );
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, [tableId]);
  return (
    <Modal title="工作流" onClose={onClose} size="wide">
      <p className="fine">多级审批、加签强制会签、代理范围/有效期、审计检索与导出。</p>
      <div className="proxy-box">
        <strong>代理审批</strong>
        <label>
          代理人（邮箱或唯一用户名）
          <input value={proxyName} onChange={(e) => setProxyName(e.target.value)} placeholder="bob@team.test" />
        </label>
        <label className="check-line">
          <input type="checkbox" checked={proxyBaseOnly} onChange={(e) => setProxyBaseOnly(e.target.checked)} />
          仅限当前空间
        </label>
        <label className="check-line">
          <input type="checkbox" checked={proxyWorkflowOnly} onChange={(e) => setProxyWorkflowOnly(e.target.checked)} />
          仅限选中工作流（保存时用列表第一项启用流；可稍后改）
        </label>
        <label>
          有效期小时（空=不过期）
          <input value={proxyHours} onChange={(e) => setProxyHours(e.target.value)} type="number" min={0} />
        </label>
        <div className="row-actions">
          <button
            type="button"
            className="primary tiny-btn"
            onClick={() =>
              api
                .setApprovalProxy(proxyName, {
                  baseId: proxyBaseOnly ? baseId : undefined,
                  workflowId: proxyWorkflowOnly ? items.find((i) => i.enabled)?.id : undefined,
                  expiresInHours: proxyHours ? Number(proxyHours) : undefined,
                })
                .then(reload)
                .catch((err) => setError(message(err)))
            }
          >
            添加代理规则
          </button>
          <button type="button" className="tiny-btn" onClick={() => api.clearApprovalProxy().then(reload).catch((err) => setError(message(err)))}>
            清除全部
          </button>
        </div>
        <ul className="member-list">
          {proxies.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.proxyUserName}</strong>
                <span className="fine">
                  {p.baseId ? "限 base" : "全 base"} · {p.workflowId ? "限工作流" : "全工作流"} ·{" "}
                  {p.expiresAt ? `至 ${new Date(p.expiresAt).toLocaleString()}` : "不过期"}
                </span>
              </div>
              <button type="button" className="tiny-btn" onClick={() => api.clearApprovalProxy(p.id).then(reload).catch((err) => setError(message(err)))}>
                删除
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="proxy-box">
        <strong>审计检索 / 导出</strong>
        <label>
          action
          <input value={auditAction} onChange={(e) => setAuditAction(e.target.value)} placeholder="approve / transfer / …" />
        </label>
        <label>
          actor
          <input value={auditActor} onChange={(e) => setAuditActor(e.target.value)} placeholder="Ada" />
        </label>
        <label>
          recordId
          <input value={auditRecordId} onChange={(e) => setAuditRecordId(e.target.value)} />
        </label>
        <div className="row-actions">
          <button type="button" className="primary tiny-btn" onClick={() => searchAudit().catch((err) => setError(message(err)))}>
            检索
          </button>
          <a
            className="tiny-btn"
            href={api.exportWorkflowAuditCsvUrl({
              tableId,
              baseId,
              action: auditAction || undefined,
              actor: auditActor || undefined,
              recordId: auditRecordId || undefined,
            })}
            download
          >
            下载 CSV
          </a>
        </div>
        {auditHits.length > 0 && (
          <ul className="timeline-list">
            {auditHits.slice(0, 20).map((ev, idx) => (
              <li key={`${ev.createdAt}-${idx}`}>
                <time>{new Date(ev.createdAt).toLocaleString()}</time>
                <strong>{ev.action}</strong>
                <span>
                  {ev.actorUserName}
                  {ev.recordId ? ` · ${ev.recordId.slice(0, 8)}…` : ""}
                  {ev.detail ? ` — ${ev.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const hours = Number(timeoutHours) || 0;
            const nodes: unknown[] = [{ id: "n1", type: "trigger", trigger: { type: "record_created" } }];
            if (withApproval) {
              nodes.push({
                id: "ap1",
                type: "approval",
                approvers: approvers1.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                label: "一级审批",
                strategy,
                timeoutHours: hours > 0 ? hours : undefined,
                forceAllAfterAddSign: true,
              });
              if (multiLevel) {
                nodes.push({
                  id: "ap2",
                  type: "approval",
                  approvers: approvers2.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                  label: "二级审批",
                  strategy: "any",
                  timeoutHours: hours > 0 ? hours : undefined,
                  forceAllAfterAddSign: true,
                });
              }
              nodes.push({ id: "act", type: "action", action: { type: "set_field", fieldId, value } });
            } else {
              nodes.push({
                id: "n2",
                type: "condition",
                conditions: [{ fieldId, op: "is_empty" }],
                conjunction: "and",
              });
              nodes.push({ id: "n3", type: "action", action: { type: "set_field", fieldId, value } });
            }
            await api.createWorkflow(tableId, { name, nodes });
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
        <label className="check-line">
          <input type="checkbox" checked={withApproval} onChange={(event) => setWithApproval(event.target.checked)} />
          含人工审批
        </label>
        {withApproval && (
          <>
            <label className="check-line">
              <input type="checkbox" checked={multiLevel} onChange={(event) => setMultiLevel(event.target.checked)} />
              两级审批串联
            </label>
            <label>
              一级策略
              <FancySelect
                value={strategy}
                onChange={(v) => setStrategy(v as "any" | "all")}
                options={[
                  { value: "any", label: "任一通过" },
                  { value: "all", label: "全部通过" },
                ]}
              />
            </label>
            <label>
              一级审批人
              <input value={approvers1} onChange={(event) => setApprovers1(event.target.value)} placeholder="空=任意" />
            </label>
            {multiLevel && (
              <label>
                二级审批人
                <input value={approvers2} onChange={(event) => setApprovers2(event.target.value)} placeholder="空=任意" />
              </label>
            )}
            <label>
              超时小时（0=不超时）
              <input value={timeoutHours} onChange={(event) => setTimeoutHours(event.target.value)} type="number" min={0} />
            </label>
          </>
        )}
        <label>
          通过后写入字段
          <FancySelect
            value={fieldId}
            onChange={setFieldId}
            options={fields.map((field) => ({ value: field.id, label: field.name }))}
          />
        </label>
        <label>
          写入值
          <input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <button type="submit" className="primary">创建工作流</button>
      </form>
      <h4>SLA 简报</h4>
      {sla && (
        <p className="fine sla-brief">
          待批 {sla.pendingCount} · 已超时 {sla.timedOutCount} · 48h 内到期 {sla.dueSoonCount}
          {sla.dueSoon.length > 0 &&
            `（即将：${sla.dueSoon
              .slice(0, 3)
              .map((r) => r.nodeLabel || r.recordId.slice(0, 6))
              .join("、")}）`}
        </p>
      )}
      <h4>待审批 / 已超时</h4>
      {runs.length === 0 && <p className="fine">暂无待处理审批</p>}
      <ul className="member-list">
        {runs.map((run) => {
          const voted = run.votedApprovers ?? run.votes.map((v) => v.userName);
          const pendingPeople = run.pendingApprovers ?? [];
          return (
            <li key={run.id} className="pending-run">
              <div>
                <strong>
                  {run.nodeLabel || `节点 #${run.pendingNodeIndex}`} · 记录 {run.recordId.slice(0, 8)}…
                </strong>
                <span>
                  {run.status === "timed_out" || run.timedOut ? "已超时" : "待审批"} · 策略{" "}
                  {run.strategy === "all" ? "全部通过" : "任一通过"}
                </span>
                <div className="cosign-progress">
                  <span className="tag voted">已投 {voted.length ? voted.join("、") : "—"}</span>
                  <span className="tag pending">
                    未投 {pendingPeople.length ? pendingPeople.join("、") : run.approvers.length ? "—" : "任意编辑者"}
                  </span>
                </div>
              </div>
              <label>
                审批意见
                <input
                  value={commentDraft[run.id] ?? ""}
                  onChange={(event) => setCommentDraft((prev) => ({ ...prev, [run.id]: event.target.value }))}
                  placeholder="简短意见"
                />
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  className="primary tiny-btn"
                  onClick={() =>
                    api
                      .decideWorkflowRun(run.id, "approve", commentDraft[run.id])
                      .then(reload)
                      .catch((err) => setError(message(err)))
                  }
                >
                  通过
                </button>
                <button
                  type="button"
                  className="tiny-btn"
                  onClick={() =>
                    api
                      .decideWorkflowRun(run.id, "reject", commentDraft[run.id] || "驳回")
                      .then(reload)
                      .catch((err) => setError(message(err)))
                  }
                >
                  驳回
                </button>
                <button
                  type="button"
                  className="tiny-btn"
                  onClick={() => {
                    const who = window.prompt("转交给（逗号分隔）", "Bob");
                    if (!who) return;
                    api
                      .transferWorkflowRun(
                        run.id,
                        who.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                        commentDraft[run.id],
                      )
                      .then(reload)
                      .catch((err) => setError(message(err)));
                  }}
                >
                  转交
                </button>
                <button
                  type="button"
                  className="tiny-btn"
                  onClick={() => {
                    const who = window.prompt("加签（逗号分隔）", "Carol");
                    if (!who) return;
                    api
                      .addSignWorkflowRun(
                        run.id,
                        who.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                        commentDraft[run.id],
                      )
                      .then(reload)
                      .catch((err) => setError(message(err)));
                  }}
                >
                  加签
                </button>
                <button
                  type="button"
                  className="tiny-btn"
                  onClick={() => loadTimeline(run.id).catch((err) => setError(message(err)))}
                >
                  时间线
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {timelineRunId && (
        <>
          <h4>运行时间线 · {timelineRunId.slice(0, 10)}…</h4>
          <ul className="timeline-list">
            {timeline.map((ev, idx) => (
              <li key={`${ev.createdAt}-${idx}`}>
                <time>{new Date(ev.createdAt).toLocaleString()}</time>
                <strong>{ev.action}</strong>
                <span>
                  {ev.actorUserName}
                  {ev.onBehalfOfUserName ? `（代 ${ev.onBehalfOfUserName}）` : ""}
                  {ev.detail ? ` — ${ev.detail}` : ""}
                </span>
              </li>
            ))}
            {timeline.length === 0 && <li className="fine">暂无审计事件</li>}
          </ul>
        </>
      )}
      <h4>工作流列表</h4>
      <ul className="member-list">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.enabled ? "已启用" : "已停用"}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                api.updateWorkflow(item.id, { enabled: !item.enabled }).then(reload).catch((err) => setError(message(err)))
              }
            >
              {item.enabled ? "停用" : "启用"}
            </button>
            <button type="button" onClick={() => api.deleteWorkflow(item.id).then(reload).catch((err) => setError(message(err)))}>
              删除
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function SyncDialog({
  tables,
  onClose,
}: {
  tables: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<
    Array<{
      id: string;
      name: string;
      sourceTableId: string;
      targetTableId: string;
      mode: string;
      conflict: string;
      lastResult: { synced: number; created: number; updated: number; skipped: number; conflict: string } | null;
    }>
  >([]);
  const [name, setName] = useState("跨表同步");
  const [sourceId, setSourceId] = useState(tables[0]?.id ?? "");
  const [targetId, setTargetId] = useState(tables[1]?.id ?? tables[0]?.id ?? "");
  const [mode, setMode] = useState<"full" | "incremental">("incremental");
  const [conflict, setConflict] = useState<"skip_if_target_nonempty" | "overwrite">("skip_if_target_nonempty");
  const [fieldMapText, setFieldMapText] = useState("标题=名称");
  const [matchField, setMatchField] = useState("标题");
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setJobs(await api.syncJobs());
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, []);

  function parseFieldMap(text: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const part of text.split(/[,，\n]/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [src, dst] = trimmed.split(/[=:：]/).map((item) => item.trim());
      if (src && dst) map[src] = dst;
    }
    return map;
  }

  return (
    <Modal title="跨表同步" onClose={onClose} size="wide">
      <p className="fine">配置字段映射与匹配键；展示上次同步结果与冲突跳过条数，可改策略后重跑。</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const fieldMap = parseFieldMap(fieldMapText);
            if (!Object.keys(fieldMap).length) throw new Error("请至少配置一条字段映射，如 标题=名称");
            await api.createSyncJob({
              name,
              sourceTableId: sourceId,
              targetTableId: targetId,
              fieldMap,
              matchField: matchField.trim() || Object.keys(fieldMap)[0],
              mode,
              conflict,
            });
            await reload();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          源表
          <FancySelect
            value={sourceId}
            onChange={setSourceId}
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
          />
        </label>
        <label>
          目标表
          <FancySelect
            value={targetId}
            onChange={setTargetId}
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
          />
        </label>
        <label>
          字段映射（源=目标，逗号分隔）
          <input
            value={fieldMapText}
            onChange={(e) => setFieldMapText(e.target.value)}
            placeholder="标题=名称, 状态=状态"
            required
          />
        </label>
        <label>
          匹配字段（源表字段名）
          <input value={matchField} onChange={(e) => setMatchField(e.target.value)} placeholder="标题" required />
        </label>
        <label>
          模式
          <FancySelect
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: "incremental", label: "增量" },
              { value: "full", label: "全量" },
            ]}
          />
        </label>
        <label>
          冲突策略
          <FancySelect
            value={conflict}
            onChange={(v) => setConflict(v as typeof conflict)}
            options={[
              { value: "skip_if_target_nonempty", label: "目标非空则跳过" },
              { value: "overwrite", label: "覆盖" },
            ]}
          />
        </label>
        <button type="submit" className="primary">创建任务</button>
      </form>
      <ul className="member-list">
        {jobs.map((job) => (
          <li key={job.id} className="pending-run">
            <div>
              <strong>{job.name}</strong>
              <span>
                {job.mode} · {job.conflict === "overwrite" ? "覆盖" : "跳过非空"}
              </span>
              {job.lastResult && (
                <span className="fine">
                  上次：同步 {job.lastResult.synced}（新建 {job.lastResult.created} / 更新 {job.lastResult.updated}）· 冲突/跳过{" "}
                  {job.lastResult.skipped}
                </span>
              )}
            </div>
            <label>
              重跑策略
              <FancySelect
                compact
                value={job.conflict}
                onChange={(v) =>
                  api
                    .updateSyncJob(job.id, { conflict: v })
                    .then(reload)
                    .catch((err) => setError(message(err)))
                }
                options={[
                  { value: "skip_if_target_nonempty", label: "目标非空则跳过" },
                  { value: "overwrite", label: "覆盖" },
                ]}
              />
            </label>
            <div className="row-actions">
              <button
                type="button"
                className="primary tiny-btn"
                onClick={() =>
                  api
                    .runSyncJob(job.id, {
                      conflict: job.conflict as "skip_if_target_nonempty" | "overwrite",
                    })
                    .then(reload)
                    .catch((err) => setError(message(err)))
                }
              >
                重跑
              </button>
              <button type="button" className="tiny-btn" onClick={() => api.deleteSyncJob(job.id).then(reload).catch((err) => setError(message(err)))}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function PluginMarketDialog({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<
    Array<{ id: string; name: string; description: string; kind: string; enabled: boolean }>
  >([]);
  const [events, setEvents] = useState<Array<{ event: string; tableId: string; recordId?: string; at: number }>>([]);
  const [webhookUrl, setWebhookUrl] = useState("https://example.com/duowei-hook");
  const [error, setError] = useState<string | null>(null);
  async function reload() {
    const data = await api.marketplace();
    setPlugins(data.plugins);
    setEvents(data.recentEvents);
  }
  useEffect(() => {
    reload().catch((err) => setError(message(err)));
  }, []);
  return (
    <Modal title="插件市场" onClose={onClose}>
      <p className="fine">内置插件可启用/禁用。Webhook 出站与同步事件日志。</p>
      <label>
        Webhook URL（启用出站时使用）
        <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
      </label>
      <ul className="member-list">
        {plugins.map((plugin) => (
          <li key={plugin.id}>
            <div>
              <strong>{plugin.name}</strong>
              <span>{plugin.description}</span>
            </div>
            <button
              type="button"
              className={plugin.enabled ? undefined : "primary"}
              onClick={() =>
                api
                  .setMarketplacePlugin(plugin.id, !plugin.enabled, plugin.kind === "webhook" ? webhookUrl : undefined)
                  .then(reload)
                  .catch((err) => setError(message(err)))
              }
            >
              {plugin.enabled ? "禁用" : "启用"}
            </button>
          </li>
        ))}
      </ul>
      <h4>最近事件日志</h4>
      {events.length === 0 && <p className="fine">暂无事件（启用「同步与事件日志」后可见）</p>}
      <ul className="member-list">
        {events.slice().reverse().map((ev, idx) => (
          <li key={`${ev.at}-${idx}`}>
            <div>
              <strong>{ev.event}</strong>
              <span>
                {ev.tableId.slice(0, 8)}… {ev.recordId ? `/ ${ev.recordId.slice(0, 8)}…` : ""} ·{" "}
                {new Date(ev.at).toLocaleString()}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
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

function buildAgentBrief(origin: string, token: string) {
  const cleanOrigin = origin.replace(/\/$/, "");
  const cleanToken = token.trim() || "dwa_把令牌粘贴到这里";
  return `# 知行人生 · Agent 使用说明（请完整阅读后开始操作）

你正在协助用户使用「知行人生」——一套自托管的人生管理工具（空间 / 清单 / 看板 / 日历）。
请用 HTTP 调用其 REST API；不要臆造 tableId / recordId，先 list 再写。

## 接入信息

- **API 根地址**：\`${cleanOrigin}\`
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
  const origin = typeof window !== "undefined" ? window.location.origin : "https://task.zhaopeinan.com";
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
        <li>需要时配置自动化、工作流与仪表盘，或开启分享与权限。</li>
        <li>字段菜单可「更改类型」；按钮动作关联当前记录。</li>
        <li>「AI 助手」可本地问数；把对接说明交给外部 Agent：点顶栏「给 Agent」一键复制。</li>
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
  const [question, setQuestion] = useState("这张表有多少条？");
  const [answer, setAnswer] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tokenHint, setTokenHint] = useState(() => localStorage.getItem("duowei_pat_hint") || "");

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

  return (
    <Modal title={`智能问答 · ${tableName}`} onClose={onClose} size="wide">
      <p className="fine">
        本地规则问数（非大模型 Agent）：条数、字段、按字段统计、数值求和、上限与按钮说明、MCP 工具。令牌用于启动 MCP：
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
    </Modal>
  );
}

function AppWidgets({ baseId }: { baseId: string }) {
  const [portal, setPortal] = useState<{
    portal?: { widgets?: Array<{ id: string; type: string; tableId: string; title?: string; fieldId?: string; attachmentFieldId?: string; limit?: number; titleFieldId?: string }> };
    tables: Array<{ id: string; name: string; fields: Array<{ id: string; name: string; type: string }>; records: Array<{ id: string; fields: Record<string, unknown> }> }>;
  } | null>(null);
  useEffect(() => {
    api.appMode(baseId).then(setPortal).catch(() => setPortal(null));
  }, [baseId]);
  if (!portal?.portal?.widgets?.length) return null;
  return (
    <div className="app-widgets">
      {portal.portal.widgets.map((widget) => {
        const table = portal.tables.find((item) => item.id === widget.tableId);
        if (!widget || !table) return null;
        if (widget.type === "list") {
          const titleField =
            table.fields.find((field) => field.id === widget.titleFieldId) ??
            table.fields.find((field) => field.type === "text") ??
            table.fields[0];
          return (
            <article key={widget.id} className="app-widget">
              <h3>{widget.title || table.name}</h3>
              <ul>
                {table.records.slice(0, widget.limit ?? 8).map((record) => (
                  <li key={record.id}>{String(record.fields[titleField?.name ?? ""] ?? record.id)}</li>
                ))}
              </ul>
            </article>
          );
        }
        if (widget.type === "tags") {
          const field = table.fields.find((item) => item.id === widget.fieldId);
          const tags = new Set<string>();
          if (field) {
            for (const record of table.records) {
              const raw = record.fields[field.name];
              if (Array.isArray(raw)) raw.forEach((item) => tags.add(String(item)));
              else if (raw != null && raw !== "") tags.add(String(raw));
            }
          }
          return (
            <article key={widget.id} className="app-widget">
              <h3>{widget.title || field?.name || "标签"}</h3>
              <div className="app-tags">
                {[...tags].slice(0, 24).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </article>
          );
        }
        if (widget.type === "image") {
          const field = table.fields.find((item) => item.id === widget.attachmentFieldId);
          const images: string[] = [];
          if (field) {
            for (const record of table.records) {
              const raw = record.fields[field.name];
              if (Array.isArray(raw)) {
                for (const item of raw) {
                  if (item && typeof item === "object" && "url" in item) images.push(String((item as { url: string }).url));
                }
              }
            }
          }
          return (
            <article key={widget.id} className="app-widget">
              <h3>{widget.title || "图片"}</h3>
              <div className="app-tags">
                {images.slice(0, widget.limit ?? 6).map((url) => (
                  <img key={url} src={url} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />
                ))}
              </div>
            </article>
          );
        }
        return null;
      })}
    </div>
  );
}

function PortalDialog({
  baseId,
  tables,
  onClose,
}: {
  baseId: string;
  tables: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  type WidgetDraft =
    | { id: string; type: "list"; tableId: string; title: string; limit: number; titleFieldId: string }
    | { id: string; type: "tags"; tableId: string; title: string; fieldId: string }
    | { id: string; type: "image"; tableId: string; title: string; attachmentFieldId: string; limit: number };
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState<"light" | "blue" | "green">("light");
  const [nav, setNav] = useState<string[]>(tables.map((item) => item.id));
  const [widgets, setWidgets] = useState<WidgetDraft[]>([]);
  const [fieldsByTable, setFieldsByTable] = useState<Record<string, Field[]>>({});
  const [error, setError] = useState<string | null>(null);

  async function ensureFields(tableId: string) {
    if (!tableId || fieldsByTable[tableId]) return fieldsByTable[tableId] ?? [];
    const table = await api.getTable(tableId);
    setFieldsByTable((current) => ({ ...current, [tableId]: table.fields }));
    return table.fields;
  }

  useEffect(() => {
    api
      .getSettings(baseId)
      .then(async (settings) => {
        setTimezone(settings.timezone);
        setTitle(settings.portal.title ?? "");
        setTheme((settings.portal.theme as "light" | "blue" | "green") ?? "light");
        setNav(settings.portal.navTableIds ?? tables.map((item) => item.id));
        const loaded = (settings.portal.widgets ?? []) as WidgetDraft[];
        setWidgets(
          loaded.map((item, index) => {
            if (item.type === "tags") {
              return { id: item.id || `w${index}`, type: "tags", tableId: item.tableId, title: item.title ?? "", fieldId: item.fieldId ?? "" };
            }
            if (item.type === "image") {
              return {
                id: item.id || `w${index}`,
                type: "image",
                tableId: item.tableId,
                title: item.title ?? "",
                attachmentFieldId: item.attachmentFieldId ?? "",
                limit: item.limit ?? 6,
              };
            }
            return {
              id: item.id || `w${index}`,
              type: "list",
              tableId: item.tableId,
              title: item.title ?? "",
              limit: item.limit ?? 8,
              titleFieldId: item.titleFieldId ?? "",
            };
          }),
        );
        for (const widget of loaded) {
          try {
            await ensureFields(widget.tableId);
          } catch {
            /* ignore */
          }
        }
      })
      .catch((err) => setError(message(err)));
  }, [baseId, tables]);

  return (
    <Modal title="门户与时区" onClose={onClose} size="wide">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api.updateSettings(baseId, {
              timezone,
              portal: {
                title: title || undefined,
                theme,
                navTableIds: nav,
                hideChrome: false,
                widgets: widgets.map((widget) => {
                  if (widget.type === "tags") {
                    return {
                      id: widget.id,
                      type: "tags" as const,
                      tableId: widget.tableId,
                      title: widget.title || undefined,
                      fieldId: widget.fieldId,
                    };
                  }
                  if (widget.type === "image") {
                    return {
                      id: widget.id,
                      type: "image" as const,
                      tableId: widget.tableId,
                      title: widget.title || undefined,
                      attachmentFieldId: widget.attachmentFieldId,
                      limit: widget.limit,
                    };
                  }
                  return {
                    id: widget.id,
                    type: "list" as const,
                    tableId: widget.tableId,
                    title: widget.title || undefined,
                    limit: widget.limit,
                    titleFieldId: widget.titleFieldId || undefined,
                  };
                }),
              },
            });
            onClose();
          } catch (err) {
            setError(message(err));
          }
        }}
      >
        <label>
          时区
          <FancySelect
            value={timezone}
            onChange={setTimezone}
            options={[
              { value: "Asia/Shanghai", label: "Asia/Shanghai" },
              { value: "UTC", label: "UTC" },
              { value: "America/Los_Angeles", label: "America/Los_Angeles" },
              { value: "Europe/London", label: "Europe/London" },
            ]}
          />
        </label>
        <label>
          应用门户标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认用空间名" />
        </label>
        <label>
          主题
          <FancySelect
            value={theme}
            onChange={(v) => setTheme(v as typeof theme)}
            options={[
              { value: "light", label: "浅色" },
              { value: "blue", label: "蓝色" },
              { value: "green", label: "绿色" },
            ]}
          />
        </label>
        <div className="acl-fields">
          {tables.map((table) => {
            const checked = nav.includes(table.id);
            return (
              <label key={table.id} className="check-line">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setNav((current) =>
                      event.target.checked ? [...current, table.id] : current.filter((id) => id !== table.id),
                    )
                  }
                />
                门户显示「{table.name}」
              </label>
            );
          })}
        </div>
        <h3 className="section-title">应用组件</h3>
        <p className="fine">列表 / 标签 / 图片组件会在应用模式下展示。</p>
        {widgets.map((widget, index) => {
          const fields = fieldsByTable[widget.tableId] ?? [];
          return (
            <div key={widget.id} className="chart-edit-row">
              <label>
                类型
                <FancySelect
                  value={widget.type}
                  onChange={(v) => {
                    const type = v as WidgetDraft["type"];
                    const tableId = widget.tableId || tables[0]?.id || "";
                    void ensureFields(tableId);
                    const next = [...widgets];
                    if (type === "tags") {
                      next[index] = { id: widget.id, type: "tags", tableId, title: widget.title, fieldId: "" };
                    } else if (type === "image") {
                      next[index] = {
                        id: widget.id,
                        type: "image",
                        tableId,
                        title: widget.title,
                        attachmentFieldId: "",
                        limit: 6,
                      };
                    } else {
                      next[index] = { id: widget.id, type: "list", tableId, title: widget.title, limit: 8, titleFieldId: "" };
                    }
                    setWidgets(next);
                  }}
                  options={[
                    { value: "list", label: "列表" },
                    { value: "tags", label: "标签" },
                    { value: "image", label: "图片" },
                  ]}
                />
              </label>
              <label>
                标题
                <input
                  value={widget.title}
                  onChange={(event) => {
                    const next = [...widgets];
                    next[index] = { ...widget, title: event.target.value } as WidgetDraft;
                    setWidgets(next);
                  }}
                />
              </label>
              <label>
                数据表
                <FancySelect
                  value={widget.tableId}
                  placeholder="选择"
                  onChange={(tableId) => {
                    void ensureFields(tableId);
                    const next = [...widgets];
                    if (widget.type === "tags") next[index] = { ...widget, tableId, fieldId: "" };
                    else if (widget.type === "image") next[index] = { ...widget, tableId, attachmentFieldId: "" };
                    else next[index] = { ...widget, tableId, titleFieldId: "" };
                    setWidgets(next);
                  }}
                  options={[
                    { value: "", label: "选择" },
                    ...tables.map((table) => ({ value: table.id, label: table.name })),
                  ]}
                />
              </label>
              {widget.type === "list" && (
                <>
                  <label>
                    标题字段
                    <FancySelect
                      value={widget.titleFieldId}
                      placeholder="自动"
                      onChange={(titleFieldId) => {
                        const next = [...widgets];
                        next[index] = { ...widget, titleFieldId };
                        setWidgets(next);
                      }}
                      options={[
                        { value: "", label: "自动" },
                        ...fields.map((field) => ({ value: field.id, label: field.name })),
                      ]}
                    />
                  </label>
                  <label>
                    条数
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={widget.limit}
                      onChange={(event) => {
                        const next = [...widgets];
                        next[index] = { ...widget, limit: Number(event.target.value) || 8 };
                        setWidgets(next);
                      }}
                    />
                  </label>
                </>
              )}
              {widget.type === "tags" && (
                <label>
                  标签字段
                  <FancySelect
                    value={widget.fieldId}
                    required
                    placeholder="选择"
                    onChange={(fieldId) => {
                      const next = [...widgets];
                      next[index] = { ...widget, fieldId };
                      setWidgets(next);
                    }}
                    options={[
                      { value: "", label: "选择" },
                      ...fields.map((field) => ({ value: field.id, label: field.name })),
                    ]}
                  />
                </label>
              )}
              {widget.type === "image" && (
                <>
                  <label>
                    附件字段
                    <FancySelect
                      value={widget.attachmentFieldId}
                      required
                      placeholder="选择"
                      onChange={(attachmentFieldId) => {
                        const next = [...widgets];
                        next[index] = { ...widget, attachmentFieldId };
                        setWidgets(next);
                      }}
                      options={[
                        { value: "", label: "选择" },
                        ...fields
                          .filter((field) => field.type === "attachment")
                          .map((field) => ({ value: field.id, label: field.name })),
                      ]}
                    />
                  </label>
                  <label>
                    张数
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={widget.limit}
                      onChange={(event) => {
                        const next = [...widgets];
                        next[index] = { ...widget, limit: Number(event.target.value) || 6 };
                        setWidgets(next);
                      }}
                    />
                  </label>
                </>
              )}
              <button type="button" onClick={() => setWidgets(widgets.filter((item) => item.id !== widget.id))}>
                删除
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="secondary"
          onClick={() =>
            setWidgets([
              ...widgets,
              {
                id: `w_${Math.random().toString(36).slice(2, 9)}`,
                type: "list",
                tableId: tables[0]?.id ?? "",
                title: tables[0]?.name ?? "列表",
                limit: 8,
                titleFieldId: "",
              },
            ])
          }
        >
          ＋ 添加组件
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
