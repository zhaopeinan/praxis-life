import { useEffect, useMemo, useState } from "react";
import type { ChartType, DashboardChart, DashboardConfig, Field, TableSummary } from "../../src/types.js";
import { api } from "./api";
import { StageEmpty } from "./StageEmpty";
import { pickStatusField } from "./statusField";
import { FancySelect } from "./ui";

type DashRow = { id: string; name: string; config: DashboardConfig };
type ChartData = { id: string; title: string; type: string; labels: string[]; values: number[] };

const CHART_TYPES: Array<{ id: ChartType; label: string }> = [
  { id: "bar", label: "柱状图" },
  { id: "line", label: "折线图" },
  { id: "pie", label: "饼图" },
  { id: "donut", label: "环图" },
  { id: "count", label: "计数" },
];

const THEME = ["#0f766e", "#0369a1", "#b45309", "#be123c", "#7c3aed", "#15803d", "#c2410c"];

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function DashboardView({
  baseId,
  tables,
  onClose,
}: {
  baseId: string;
  tables: TableSummary[];
  onClose: () => void;
}) {
  const [list, setList] = useState<DashRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [data, setData] = useState<{
    id: string;
    name: string;
    charts: ChartData[];
    slicers: Array<{ id: string; title: string; tableId: string; fieldId: string; options: string[] }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCharts, setDraftCharts] = useState<DashboardChart[]>([]);
  const [draftSlicers, setDraftSlicers] = useState<NonNullable<DashboardConfig["slicers"]>>([]);
  const [slicerValues, setSlicerValues] = useState<Record<string, string[]>>({});
  const [fieldsByTable, setFieldsByTable] = useState<Record<string, Field[]>>({});
  const [busy, setBusy] = useState(false);

  const active = list.find((item) => item.id === activeId) ?? null;

  async function refreshList(preferId?: string) {
    const rows = (await api.dashboards(baseId)) as DashRow[];
    setList(rows.map((row) => ({
      id: row.id,
      name: row.name,
      config: (row.config as DashboardConfig) ?? { charts: [] },
    })));
    const nextId = preferId ?? activeId ?? rows[0]?.id ?? null;
    setActiveId(nextId);
  }

  async function loadData(id: string, values = slicerValues) {
    const next = await api.getDashboard(id, values);
    setData(next);
  }

  useEffect(() => {
    refreshList().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [baseId]);

  useEffect(() => {
    if (!activeId) {
      setData(null);
      return;
    }
    loadData(activeId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [activeId]);

  async function ensureFields(tableId: string) {
    if (fieldsByTable[tableId]) return fieldsByTable[tableId];
    const table = await api.getTable(tableId);
    setFieldsByTable((current) => ({ ...current, [tableId]: table.fields }));
    return table.fields;
  }

  async function startEdit() {
    if (!active) return;
    setDraftName(active.name);
    setDraftCharts(active.config.charts.map((chart) => ({ ...chart })));
    setDraftSlicers((active.config.slicers ?? []).map((item) => ({ ...item })));
    for (const chart of active.config.charts) {
      try {
        await ensureFields(chart.tableId);
      } catch {
        /* ignore */
      }
    }
    for (const slicer of active.config.slicers ?? []) {
      try {
        await ensureFields(slicer.tableId);
      } catch {
        /* ignore */
      }
    }
    setEditing(true);
  }

  async function createDash() {
    setBusy(true);
    setError(null);
    try {
      const created = (await api.createDashboard(baseId, { name: "未命名仪表盘", config: { charts: [] } })) as DashRow;
      await refreshList(created.id);
      setDraftName(created.name);
      setDraftCharts([]);
      setDraftSlicers([]);
      setEditing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!activeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateDashboard(activeId, {
        name: draftName.trim() || "未命名仪表盘",
        config: { charts: draftCharts, slicers: draftSlicers },
      });
      setEditing(false);
      await refreshList(activeId);
      await loadData(activeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 「用我的数据生成一个」：扫一遍数据表，挑第一张有单选字段的表，
   * 按该字段生成分布 + 数量 + 总数的三张图。省去用户手配图表。
   */
  async function quickStart() {
    setBusy(true);
    setError(null);
    try {
      let target: { tableId: string; tableName: string; field: Field } | null = null;
      for (const table of tables.slice(0, 8)) {
        try {
          const full = await api.getTable(table.id);
          const field = pickStatusField(full.fields);
          if (field) {
            setFieldsByTable((current) => ({ ...current, [full.id]: full.fields }));
            target = { tableId: full.id, tableName: full.name, field };
            break;
          }
        } catch {
          /* 单张表读不到就跳过，继续找下一张 */
        }
      }
      if (!target) {
        setError("这些数据表里都还没有单选字段。先任意加一个「状态」单选字段，再回来一键生成。");
        return;
      }
      const charts: DashboardChart[] = [
        { id: uid("c"), title: `${target.field.name}分布`, type: "donut", tableId: target.tableId, fieldId: target.field.id },
        { id: uid("c"), title: `${target.field.name}数量`, type: "bar", tableId: target.tableId, fieldId: target.field.id },
        { id: uid("c"), title: "记录总数", type: "count", tableId: target.tableId, fieldId: "" },
      ];
      const created = (await api.createDashboard(baseId, {
        name: `${target.tableName} · 概览`,
        config: { charts },
      })) as DashRow;
      await refreshList(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard-shell">
      <header className="dashboard-bar">
        <div className="dashboard-heading">
          <span className="dashboard-kicker">仪表盘</span>
          <h2>{active?.name ?? "数据概览"}</h2>
          <p className="fine">按字段聚合记录；切片器可联动过滤柱状 / 折线 / 饼图 / 环图 / 计数。</p>
        </div>
        <div className="dialog-actions dashboard-actions">
          <button type="button" className="secondary" onClick={() => void createDash()} disabled={busy}>
            ＋ 新建仪表盘
          </button>
          {active && !editing && (
            <button type="button" className="primary" onClick={() => void startEdit()} disabled={busy}>
              编辑
            </button>
          )}
          {editing && (
            <>
              <button type="button" className="primary" onClick={() => void saveEdit()} disabled={busy}>
                保存
              </button>
              <button type="button" onClick={() => setEditing(false)} disabled={busy}>
                取消
              </button>
            </>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}
      <div className="dashboard-layout">
        <aside className="dashboard-nav">
          <p className="dashboard-nav-title">全部仪表盘</p>
          {list.length === 0 && <p className="dashboard-nav-empty">还没有仪表盘</p>}
          {list.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`dashboard-nav-item${item.id === activeId ? " active" : ""}`}
              onClick={() => {
                setEditing(false);
                setActiveId(item.id);
              }}
            >
              <span className="dashboard-nav-name">{item.name}</span>
              <span className="dashboard-nav-count">{item.config.charts.length}</span>
            </button>
          ))}
        </aside>
        <section className="dashboard-canvas">
          {list.length === 0 && (
            <div className="dashboard-empty">
              <span className="dashboard-empty-icon" aria-hidden="true">
                ◔
              </span>
              <h3>把散落的记录，汇成一张能看懂的表</h3>
              <p>
                仪表盘会按字段统计这个空间里的数据。比如「按状态看进度」「按负责人看负载」，
                一句话就能配好，不用写公式。
              </p>
              <ul className="dashboard-steps">
                <li>
                  <em>1</em> 选数据表
                </li>
                <li>
                  <em>2</em> 选字段
                </li>
                <li>
                  <em>3</em> 选图表形状
                </li>
              </ul>
              <div className="dashboard-empty-actions">
                <button type="button" className="primary" onClick={() => void createDash()} disabled={busy}>
                  新建空白仪表盘
                </button>
                <button type="button" className="secondary" onClick={() => void quickStart()} disabled={busy || tables.length === 0}>
                  {busy ? "生成中…" : "用我的数据生成一个"}
                </button>
              </div>
            </div>
          )}
          {list.length > 0 && !active && (
            <StageEmpty
              icon="◔"
              title="选一个仪表盘查看"
              description="左侧列出的是当前空间下的全部仪表盘。也可以新建一个，按字段统计记录。"
              tone="calm"
              actions={
                <button type="button" className="primary" onClick={() => void createDash()} disabled={busy}>
                  ＋ 新建仪表盘
                </button>
              }
            />
          )}
          {active && editing && (
            <DashboardEditor
              name={draftName}
              charts={draftCharts}
              slicers={draftSlicers}
              tables={tables}
              fieldsByTable={fieldsByTable}
              onName={setDraftName}
              onCharts={setDraftCharts}
              onSlicers={setDraftSlicers}
              onNeedFields={(tableId) => void ensureFields(tableId)}
            />
          )}
          {active && !editing && !data && <p className="stage-note">加载中…</p>}
          {active && !editing && data && (
            <>
              {data.charts.length === 0 && (
                <div className="dashboard-empty compact">
                  <span className="dashboard-empty-icon" aria-hidden="true">
                    ＋
                  </span>
                  <h3>「{data.name}」还是空的</h3>
                  <p>加一个图表，选好数据表和字段就能看到统计结果。</p>
                  <div className="dashboard-empty-actions">
                    <button type="button" className="primary" onClick={() => void startEdit()}>
                      添加图表
                    </button>
                  </div>
                </div>
              )}
              {data.slicers?.length > 0 && (
                <div className="slicer-bar">
                  {data.slicers.map((slicer) => (
                    <label key={slicer.id} className="slicer">
                      <span>{slicer.title}</span>
                      <div className="slicer-multi" role="group" aria-label={slicer.title}>
                        {slicer.options.map((option) => {
                          const selected = slicerValues[slicer.id] ?? [];
                          const checked = selected.includes(option);
                          return (
                            <label key={option} className="slicer-multi-item">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const nextSelected = checked
                                    ? selected.filter((item) => item !== option)
                                    : [...selected, option];
                                  const next = { ...slicerValues, [slicer.id]: nextSelected };
                                  setSlicerValues(next);
                                  if (activeId) void loadData(activeId, next);
                                }}
                              />
                              {option}
                            </label>
                          );
                        })}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {data.charts.length > 0 && (
                <div className="chart-grid">
                  {data.charts.map((chart) => (
                    <ChartCard key={chart.id} chart={chart} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function DashboardEditor({
  name,
  charts,
  slicers,
  tables,
  fieldsByTable,
  onName,
  onCharts,
  onSlicers,
  onNeedFields,
}: {
  name: string;
  charts: DashboardChart[];
  slicers: NonNullable<DashboardConfig["slicers"]>;
  tables: TableSummary[];
  fieldsByTable: Record<string, Field[]>;
  onName: (name: string) => void;
  onCharts: (charts: DashboardChart[]) => void;
  onSlicers: (slicers: NonNullable<DashboardConfig["slicers"]>) => void;
  onNeedFields: (tableId: string) => void;
}) {
  return (
    <div className="dashboard-editor">
      <label>
        名称
        <input value={name} onChange={(event) => onName(event.target.value)} />
      </label>
      <h3 className="section-title">切片器</h3>
      {slicers.map((slicer, index) => {
        const fields = fieldsByTable[slicer.tableId] ?? [];
        return (
          <div key={slicer.id} className="chart-edit-row">
            <label>
              标题
              <input
                value={slicer.title ?? ""}
                onChange={(event) => {
                  const next = [...slicers];
                  next[index] = { ...slicer, title: event.target.value };
                  onSlicers(next);
                }}
              />
            </label>
            <label>
              数据表
              <FancySelect
                value={slicer.tableId}
                placeholder="选择"
                onChange={(tableId) => {
                  onNeedFields(tableId);
                  const next = [...slicers];
                  next[index] = { ...slicer, tableId, fieldId: "" };
                  onSlicers(next);
                }}
                options={[
                  { value: "", label: "选择" },
                  ...tables.map((table) => ({ value: table.id, label: table.name })),
                ]}
              />
            </label>
            <label>
              字段
              <FancySelect
                value={slicer.fieldId}
                placeholder="选择"
                onChange={(fieldId) => {
                  const next = [...slicers];
                  next[index] = { ...slicer, fieldId };
                  onSlicers(next);
                }}
                options={[
                  { value: "", label: "选择" },
                  ...fields.map((field) => ({ value: field.id, label: field.name })),
                ]}
              />
            </label>
            <button type="button" onClick={() => onSlicers(slicers.filter((item) => item.id !== slicer.id))}>
              删除
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onSlicers([
            ...slicers,
            {
              id: uid("s"),
              title: "切片器",
              tableId: tables[0]?.id ?? "",
              fieldId: "",
            },
          ])
        }
      >
        ＋ 添加切片器
      </button>
      <h3 className="section-title">图表</h3>
      {charts.map((chart, index) => {
        const fields = fieldsByTable[chart.tableId] ?? [];
        return (
          <div key={chart.id} className="chart-edit-row">
            <label>
              标题
              <input
                value={chart.title}
                onChange={(event) => {
                  const next = [...charts];
                  next[index] = { ...chart, title: event.target.value };
                  onCharts(next);
                }}
              />
            </label>
            <label>
              类型
              <FancySelect
                value={chart.type}
                onChange={(type) => {
                  const next = [...charts];
                  next[index] = { ...chart, type: type as ChartType };
                  onCharts(next);
                }}
                options={CHART_TYPES.map((item) => ({ value: item.id, label: item.label }))}
              />
            </label>
            <label>
              数据表
              <FancySelect
                value={chart.tableId}
                placeholder="选择"
                onChange={(tableId) => {
                  onNeedFields(tableId);
                  const next = [...charts];
                  next[index] = { ...chart, tableId, fieldId: "" };
                  onCharts(next);
                }}
                options={[
                  { value: "", label: "选择" },
                  ...tables.map((table) => ({ value: table.id, label: table.name })),
                ]}
              />
            </label>
            <label>
              字段
              <FancySelect
                value={chart.fieldId}
                placeholder="选择"
                onChange={(fieldId) => {
                  const next = [...charts];
                  next[index] = { ...chart, fieldId };
                  onCharts(next);
                }}
                options={[
                  { value: "", label: "选择" },
                  ...fields.map((field) => ({ value: field.id, label: field.name })),
                ]}
              />
            </label>
            <button
              type="button"
              onClick={() => onCharts(charts.filter((item) => item.id !== chart.id))}
            >
              删除
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onCharts([
            ...charts,
            {
              id: uid("c"),
              title: "新图表",
              type: "bar",
              tableId: tables[0]?.id ?? "",
              fieldId: "",
            },
          ])
        }
      >
        ＋ 添加图表
      </button>
    </div>
  );
}

function ChartCard({ chart }: { chart: ChartData }) {
  const total = useMemo(() => chart.values.reduce((sum, value) => sum + value, 0), [chart.values]);
  const empty = chart.type !== "count" && (chart.labels.length === 0 || total === 0);
  return (
    <article className="chart-card">
      <header>
        <h3>{chart.title}</h3>
        <span className="fine">{labelOf(chart.type)}</span>
      </header>
      <div className="chart-body">
        {chart.type === "count" ? (
          <div className="chart-count">{total}</div>
        ) : empty ? (
          <p className="chart-empty">暂无数据</p>
        ) : chart.type === "bar" || chart.type === "line" ? (
          <BarOrLine labels={chart.labels} values={chart.values} mode={chart.type} />
        ) : (
          <PieOrDonut labels={chart.labels} values={chart.values} donut={chart.type === "donut"} />
        )}
      </div>
    </article>
  );
}

function labelOf(type: string): string {
  return CHART_TYPES.find((item) => item.id === type)?.label ?? type;
}

function BarOrLine({
  labels,
  values,
  mode,
}: {
  labels: string[];
  values: number[];
  mode: "bar" | "line";
}) {
  const max = Math.max(1, ...values);
  const width = 320;
  const height = 160;
  const pad = 24;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = labels.length ? innerW / labels.length : innerW;
  const points = values.map((value, index) => {
    const x = pad + step * index + step / 2;
    const y = pad + innerH - (value / max) * innerH;
    return { x, y, value, label: labels[index] ?? "" };
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img">
      <line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH} stroke="#cbd5e1" />
      {mode === "bar" &&
        points.map((point, index) => {
          const barW = Math.max(8, step * 0.55);
          const barH = (point.value / max) * innerH;
          return (
            <rect
              key={index}
              x={point.x - barW / 2}
              y={pad + innerH - barH}
              width={barW}
              height={barH}
              fill={THEME[index % THEME.length]}
              rx={3}
            >
              <title>{`${point.label}: ${point.value}`}</title>
            </rect>
          );
        })}
      {mode === "line" && points.length > 0 && (
        <>
          <polyline
            fill="none"
            stroke={THEME[0]}
            strokeWidth={2.5}
            points={points.map((point) => `${point.x},${point.y}`).join(" ")}
          />
          {points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r={3.5} fill={THEME[0]}>
              <title>{`${point.label}: ${point.value}`}</title>
            </circle>
          ))}
        </>
      )}
    </svg>
  );
}

function PieOrDonut({
  labels,
  values,
  donut,
}: {
  labels: string[];
  values: number[];
  donut: boolean;
}) {
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const cx = 90;
  const cy = 90;
  const r = 70;
  const inner = donut ? 38 : 0;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const sweep = (value / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    return { start, end: angle, value, label: labels[index] ?? "", color: THEME[index % THEME.length] };
  });
  return (
    <div className="pie-wrap">
      <svg viewBox="0 0 180 180" className="chart-svg pie" role="img">
        {slices.map((slice, index) => (
          <path key={index} d={arcPath(cx, cy, r, inner, slice.start, slice.end)} fill={slice.color}>
            <title>{`${slice.label}: ${slice.value}`}</title>
          </path>
        ))}
      </svg>
      <ul className="pie-legend">
        {slices.map((slice, index) => (
          <li key={index}>
            <span style={{ background: slice.color }} />
            {slice.label || "(空)"} · {slice.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function arcPath(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
  }
  const ix1 = cx + inner * Math.cos(end);
  const iy1 = cy + inner * Math.sin(end);
  const ix2 = cx + inner * Math.cos(start);
  const iy2 = cy + inner * Math.sin(start);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix2} ${iy2} Z`;
}
