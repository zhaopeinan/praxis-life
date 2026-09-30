import { useMemo, useState } from "react";
import type { DisplayValue, Field, PublicRecord } from "../../src/types.js";
import { beginTouchDrag } from "./touchDrag";
import { FancySelect } from "./ui";

function titleOf(record: PublicRecord, fields: Field[], titleFieldId: string | null): string {
  const field = fields.find((item) => item.id === titleFieldId) ?? fields[0];
  if (!field) return record.id;
  const value = record.fields[field.name];
  if (value == null || value === "") return "未命名";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function CalendarView({
  fields,
  records,
  dateFieldId,
  titleFieldId,
  readOnly,
  onChange,
  onOpen,
}: {
  fields: Field[];
  records: PublicRecord[];
  dateFieldId: string | null;
  titleFieldId: string | null;
  readOnly: boolean;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onOpen?: (recordId: string) => void;
}) {
  const dateField = fields.find((field) => field.id === dateFieldId && field.type === "date");
  const [touchOver, setTouchOver] = useState<string | null>(null);
  const [touchDragging, setTouchDragging] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const days = useMemo(() => buildMonth(cursor), [cursor]);
  const byDate = useMemo(() => {
    const map = new Map<string, PublicRecord[]>();
    if (!dateField) return map;
    for (const record of records) {
      const raw = record.fields[dateField.name];
      if (typeof raw !== "string" || !raw) continue;
      const list = map.get(raw) ?? [];
      list.push(record);
      map.set(raw, list);
    }
    return map;
  }, [records, dateField]);

  if (!dateField) {
    return <p className="stage-note">请先在视图设置中选择日期字段。</p>;
  }

  const label = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          上月
        </button>
        <strong>{label}</strong>
        <button type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          下月
        </button>
      </div>
      <div className="calendar-weekdays">
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {days.map((day) => {
          const key = day ? formatDate(day) : "";
          const items = key ? byDate.get(key) ?? [] : [];
          return (
            <div
              key={key || `empty-${day}`}
              className={`calendar-day${day ? "" : " empty"}${day && touchOver === key ? " over" : ""}`}
              data-drop-key={day ? key : undefined}
            >
              {day && <em>{day.getDate()}</em>}
              <div className="calendar-events">
                {items.map((record) => (
                  <button
                    type="button"
                    key={record.id}
                    className={`calendar-event${touchDragging === record.id ? " touch-dragging" : ""}`}
                    onClick={() => onOpen?.(record.id)}
                    draggable={!readOnly}
                    onDragStart={(event) => event.dataTransfer.setData("text/record", record.id)}
                    onTouchStart={(event) => {
                      if (readOnly || !day) return;
                      beginTouchDrag(event, {
                        onActivate: () => setTouchDragging(record.id),
                        onTargetChange: (dropKey) => setTouchOver(dropKey),
                        onDrop: (dropKey) => {
                          if (dropKey) onChange(record.id, dateField.name, dropKey);
                        },
                        onEnd: () => {
                          setTouchDragging(null);
                          setTouchOver(null);
                        },
                      });
                    }}
                  >
                    {titleOf(record, fields, titleFieldId)}
                  </button>
                ))}
              </div>
              {day && !readOnly && (
                <div
                  className="calendar-drop"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const recordId = event.dataTransfer.getData("text/record");
                    if (recordId) onChange(recordId, dateField.name, formatDate(day));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GalleryView({
  fields,
  records,
  titleFieldId,
  readOnly,
  onOpen,
  onAdd,
}: {
  fields: Field[];
  records: PublicRecord[];
  titleFieldId: string | null;
  readOnly: boolean;
  onOpen?: (recordId: string) => void;
  onAdd?: () => void;
}) {
  const metaFields = fields.filter((field) => field.id !== titleFieldId).slice(0, 3);
  return (
    <div className="gallery">
      {records.map((record) => (
        <article key={record.id} className="gallery-card" onClick={() => onOpen?.(record.id)}>
          <h3>{titleOf(record, fields, titleFieldId)}</h3>
          <dl>
            {metaFields.map((field) => (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd>{formatValue(record.fields[field.name])}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
      {!readOnly && onAdd && (
        <button type="button" className="gallery-add" onClick={onAdd}>
          + 添加记录
        </button>
      )}
      {records.length === 0 && <p className="stage-note">画册还没有记录。</p>}
    </div>
  );
}

export function FormView({
  fields,
  readOnly,
  onSubmit,
}: {
  fields: Field[];
  readOnly: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const editable = fields.filter(
    (field) =>
      !["auto_number", "created_time", "updated_time", "created_by", "formula", "lookup", "button"].includes(field.type),
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function optionsFor(field: Field) {
    const options = field.config.options ?? [];
    const source = fields.find((item) => item.config.optionCascade?.targetFieldId === field.id);
    if (!source?.config.optionCascade) return options;
    const sourceName = values[source.id] ?? "";
    if (!sourceName) return options;
    const allowed = source.config.optionCascade.map[sourceName];
    if (!allowed) return options;
    return options.filter((option) => allowed.includes(option.name));
  }

  return (
    <div className="form-view">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (readOnly) return;
          setBusy(true);
          setError(null);
          try {
            const payload: Record<string, unknown> = {};
            for (const field of editable) {
              const raw = values[field.id] ?? "";
              if (field.type === "checkbox") payload[field.name] = raw === "true";
              else if (field.type === "number" || field.type === "currency" || field.type === "rating" || field.type === "progress") {
                payload[field.name] = raw === "" ? null : Number(raw);
              } else if (field.type === "multi_select" || field.type === "person") {
                payload[field.name] = raw
                  .split(/[,，]/)
                  .map((item) => item.trim())
                  .filter(Boolean);
              } else if (field.type === "geolocation") {
                if (!raw.trim()) payload[field.name] = null;
                else {
                  try {
                    payload[field.name] = JSON.parse(raw);
                  } catch {
                    payload[field.name] = raw;
                  }
                }
              } else if (field.type === "signature") {
                payload[field.name] = raw || null;
              } else {
                payload[field.name] = raw || null;
              }
            }
            await onSubmit(payload);
            setValues({});
            setDone(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {editable.map((field) => (
          <label key={field.id}>
            {field.name}
            {field.type === "long_text" ? (
              <textarea
                value={values[field.id] ?? ""}
                disabled={readOnly || busy}
                rows={4}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            ) : field.type === "checkbox" ? (
              <input
                type="checkbox"
                checked={values[field.id] === "true"}
                disabled={readOnly || busy}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.id]: event.target.checked ? "true" : "false" }))
                }
              />
            ) : field.type === "single_select" ? (
              <FancySelect
                value={values[field.id] ?? ""}
                disabled={readOnly || busy}
                placeholder="请选择"
                onChange={(next) => {
                  setValues((current) => {
                    const updated = { ...current, [field.id]: next };
                    const cascade = field.config.optionCascade;
                    if (cascade?.targetFieldId) {
                      const target = fields.find((item) => item.id === cascade.targetFieldId);
                      if (target) {
                        const allowed = next ? cascade.map[next] ?? [] : [];
                        const currentTarget = updated[target.id] ?? "";
                        if (currentTarget && allowed.length && !allowed.includes(currentTarget)) {
                          updated[target.id] = "";
                        }
                      }
                    }
                    return updated;
                  });
                }}
                options={[
                  { value: "", label: "请选择" },
                  ...optionsFor(field).map((option) => ({ value: option.name, label: option.name })),
                ]}
              />
            ) : field.type === "geolocation" ? (
              <input
                type="text"
                placeholder='{"lat":31.2,"lng":121.5,"label":"上海"}'
                value={values[field.id] ?? ""}
                disabled={readOnly || busy}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            ) : field.type === "signature" ? (
              <input
                type="text"
                placeholder="粘贴 data:image/png;base64,..."
                value={values[field.id] ?? ""}
                disabled={readOnly || busy}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            ) : (
              <input
                type={field.type === "date" ? "date" : field.type === "number" || field.type === "currency" || field.type === "rating" || field.type === "progress" ? "number" : "text"}
                value={values[field.id] ?? ""}
                disabled={readOnly || busy}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            )}
          </label>
        ))}
        {error && <p className="form-error">{error}</p>}
        {done && <p className="fine">提交成功</p>}
        {!readOnly && (
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "提交中…" : "提交"}
          </button>
        )}
      </form>
    </div>
  );
}

function formatValue(value: DisplayValue | undefined): string {
  if (value == null) return "—";
  if (Array.isArray(value)) {
    return (
      value
        .map((item) => (typeof item === "string" ? item : item.name))
        .join(", ") || "—"
    );
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object" && "lat" in value && "lng" in value) {
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : "";
    return label || `${value.lat}, ${value.lng}`;
  }
  if (typeof value === "string" && value.startsWith("data:image/")) return "（签字）";
  return String(value);
}

export function GanttView({
  fields,
  records,
  dateFieldId,
  endDateFieldId,
  progressFieldId,
  dependencyFieldId,
  titleFieldId,
  readOnly,
  onChange,
  onOpen,
}: {
  fields: Field[];
  records: PublicRecord[];
  dateFieldId: string | null;
  endDateFieldId: string | null;
  progressFieldId: string | null;
  dependencyFieldId: string | null;
  titleFieldId: string | null;
  readOnly: boolean;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onOpen?: (recordId: string) => void;
}) {
  const startField = fields.find((field) => field.id === dateFieldId && field.type === "date");
  const endField = fields.find((field) => field.id === endDateFieldId && field.type === "date") ?? startField;
  const progressField = fields.find((field) => field.id === progressFieldId);
  const depField = fields.find((field) => field.id === dependencyFieldId);

  const range = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const record of records) {
      const start = parseDay(startField ? record.fields[startField.name] : null);
      const end = parseDay(endField ? record.fields[endField.name] : null) ?? start;
      if (start == null) continue;
      min = Math.min(min, start);
      max = Math.max(max, end ?? start);
    }
    if (!Number.isFinite(min)) {
      const now = Date.now();
      return { min: now, max: now + 14 * 86400000 };
    }
    return { min: min - 2 * 86400000, max: max + 2 * 86400000 };
  }, [records, startField, endField]);

  const span = Math.max(range.max - range.min, 86400000);

  if (!startField) {
    return <p className="stage-note">请先为甘特视图配置开始日期字段。</p>;
  }

  return (
    <div className="gantt">
      <div className="gantt-head">
        <span>任务</span>
        <span>时间条（起止日期 + 进度）</span>
      </div>
      {records.map((record) => {
        const start = parseDay(record.fields[startField.name]);
        const end = parseDay(endField ? record.fields[endField.name] : null) ?? start;
        const progressRaw = progressField ? record.fields[progressField.name] : 0;
        const progress = typeof progressRaw === "number" ? Math.max(0, Math.min(100, progressRaw)) : 0;
        const left = start == null ? 0 : ((start - range.min) / span) * 100;
        const width = start == null || end == null ? 4 : Math.max(2, ((end - start + 86400000) / span) * 100);
        const deps = depField && Array.isArray(record.fields[depField.name])
          ? (record.fields[depField.name] as string[]).join(", ")
          : "";
        return (
          <div className="gantt-row" key={record.id}>
            <button type="button" className="gantt-title" onClick={() => onOpen?.(record.id)}>
              {titleOf(record, fields, titleFieldId)}
              {deps && <small>依赖: {deps}</small>}
            </button>
            <div className="gantt-track">
              {start != null && (
                <div className="gantt-bar" style={{ left: `${left}%`, width: `${width}%` }}>
                  <i style={{ width: `${progress}%` }} />
                  <em>{progress}%</em>
                </div>
              )}
            </div>
            {!readOnly && (
              <div className="gantt-edit">
                <input
                  type="date"
                  value={typeof record.fields[startField.name] === "string" ? String(record.fields[startField.name]) : ""}
                  onChange={(event) => onChange(record.id, startField.name, event.target.value || null)}
                />
                {endField && (
                  <input
                    type="date"
                    value={typeof record.fields[endField.name] === "string" ? String(record.fields[endField.name]) : ""}
                    onChange={(event) => onChange(record.id, endField.name, event.target.value || null)}
                  />
                )}
                {progressField && (
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={progress}
                    onChange={(event) => onChange(record.id, progressField.name, Number(event.target.value))}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      {records.length === 0 && <p className="stage-note">暂无任务记录。</p>}
    </div>
  );
}

function parseDay(value: DisplayValue | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00`).getTime();
}

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildMonth(cursor: Date): Array<Date | null> {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startPad = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
