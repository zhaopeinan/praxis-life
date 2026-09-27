import { useEffect, useMemo, useState } from "react";
import type { ChartType, DashboardChart, DashboardConfig, Field, TableSummary } from "../../src/types.js";
import { api } from "./api";

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

  return (
    <div className="dashboard-shell">
      <header className="dashboard-bar">
        <div>
          <h2>仪表盘</h2>
          <p className="fine">按字段聚合；可用切片器联动过滤柱状 / 折线 / 饼图 / 环图 / 计数</p>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={() => void createDash()} disabled={busy}>
            新建
          </button>
          {active && !editing && (
            <button type="button" className="primary" onClick={() => void startEdit()}>
              编辑
            </button>
          )}
          {editing && (
            <button type="button" className="primary" onClick={() => void saveEdit()} disabled={busy}>
              保存
            </button>
          )}
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}
      <div className="dashboard-layout">
        <aside className="dashboard-nav">
          {list.length === 0 && <p className="fine">还没有仪表盘</p>}
          {list.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeId ? "active" : ""}
              onClick={() => {
                setEditing(false);
                setActiveId(item.id);
              }}
            >
              {item.name}
            </button>
          ))}
        </aside>
        <section className="dashboard-canvas">
          {!active && <p className="stage-note">选择或新建仪表盘</p>}
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
          {active && !editing && data && (
            <>
              {data.slicers?.length > 0 && (
                <div className="slicer-bar">
                  {data.slicers.map((slicer) => (
                    <label key={slicer.id} className="slicer">
                      <span>{slicer.title}</span>
                      <select
                        multiple
                        value={slicerValues[slicer.id] ?? []}
                        onChange={(event) => {
                          const selected = [...event.target.selectedOptions].map((option) => option.value);
                          const next = { ...slicerValues, [slicer.id]: selected };
                          setSlicerValues(next);
                          if (activeId) void loadData(activeId, next);
                        }}
                      >
                        {slicer.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <div className="chart-grid">
                {data.charts.length === 0 && <p className="stage-note">暂无图表，点击编辑添加</p>}
                {data.charts.map((chart) => (
                  <ChartCard key={chart.id} chart={chart} />
                ))}
              </div>
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
              <select
                value={slicer.tableId}
                onChange={(event) => {
                  const tableId = event.target.value;
                  onNeedFields(tableId);
                  const next = [...slicers];
                  next[index] = { ...slicer, tableId, fieldId: "" };
                  onSlicers(next);
                }}
              >
                <option value="">选择</option>
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              字段
              <select
                value={slicer.fieldId}
                onChange={(event) => {
                  const next = [...slicers];
                  next[index] = { ...slicer, fieldId: event.target.value };
                  onSlicers(next);
                }}
              >
                <option value="">选择</option>
                {fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
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
              id: `s_${Math.random().toString(36).slice(2, 9)}`,
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
              <select
                value={chart.type}
                onChange={(event) => {
                  const next = [...charts];
                  next[index] = { ...chart, type: event.target.value as ChartType };
                  onCharts(next);
                }}
              >
                {CHART_TYPES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              数据表
              <select
                value={chart.tableId}
                onChange={(event) => {
                  const tableId = event.target.value;
                  onNeedFields(tableId);
                  const next = [...charts];
                  next[index] = { ...chart, tableId, fieldId: "" };
                  onCharts(next);
                }}
              >
                <option value="">选择</option>
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              字段
              <select
                value={chart.fieldId}
                onChange={(event) => {
                  const next = [...charts];
                  next[index] = { ...chart, fieldId: event.target.value };
                  onCharts(next);
                }}
              >
                <option value="">选择</option>
                {fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
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
              id: `c_${Math.random().toString(36).slice(2, 9)}`,
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
  return (
    <article className="chart-card">
      <header>
        <h3>{chart.title}</h3>
        <span className="fine">{labelOf(chart.type)}</span>
      </header>
      {chart.type === "count" ? (
        <div className="chart-count">{total}</div>
      ) : chart.type === "bar" || chart.type === "line" ? (
        <BarOrLine labels={chart.labels} values={chart.values} mode={chart.type} />
      ) : (
        <PieOrDonut labels={chart.labels} values={chart.values} donut={chart.type === "donut"} />
      )}
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
