import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DisplayValue, Field, PublicRecord, RowHeight, Sort, ColorRule } from "../../src/types.js";
import { matchesFilter } from "../../src/query.js";

const WIDTH: Record<Field["type"], number> = {
  text: 220,
  long_text: 280,
  number: 120,
  single_select: 150,
  multi_select: 180,
  date: 148,
  checkbox: 88,
  url: 200,
  email: 180,
  phone: 140,
  person: 160,
  rating: 120,
  progress: 140,
  currency: 120,
  auto_number: 120,
  created_time: 160,
  updated_time: 160,
  created_by: 120,
  formula: 140,
  link: 180,
  duplex_link: 180,
  lookup: 160,
  button: 120,
  attachment: 200,
  barcode: 140,
  geolocation: 200,
  signature: 160,
  group: 160,
};

const MIN_COL = 96;
const MAX_COL = 720;
const ADD_COL = 56;

const ROW_PX: Record<RowHeight, number> = {
  short: 32,
  medium: 40,
  tall: 56,
  extra: 72,
};

const READONLY_TYPES = new Set([
  "auto_number",
  "created_time",
  "updated_time",
  "created_by",
  "formula",
  "lookup",
]);

function defaultWidth(field: Field, index: number): number {
  const base = WIDTH[field.type] ?? 160;
  return index === 0 ? Math.max(base, 240) : base;
}

function loadWidths(tableId: string | undefined, fields: Field[]): Record<string, number> {
  const next: Record<string, number> = {};
  fields.forEach((field, index) => {
    next[field.id] = defaultWidth(field, index);
  });
  if (!tableId) return next;
  try {
    const raw = localStorage.getItem(`duowei:colwidths:${tableId}`);
    if (!raw) return next;
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const field of fields) {
      const value = saved[field.id];
      if (typeof value === "number" && Number.isFinite(value)) {
        next[field.id] = Math.min(MAX_COL, Math.max(MIN_COL, value));
      }
    }
  } catch {
    /* ignore */
  }
  return next;
}

export function GridView({
  fields,
  allFields,
  records,
  sorts,
  groups,
  colorRules,
  rowHeight = "medium",
  readOnly,
  tableId,
  baseId,
  onSort,
  onChange,
  onDelete,
  onAdd,
  onAddField,
  onRenameField,
  onEditOptions,
  onChangeType,
  onDeleteField,
  onOpenRecord,
}: {
  fields: Field[];
  allFields?: Field[];
  records: PublicRecord[];
  sorts: Sort[];
  groups?: Array<{ fieldId: string }>;
  colorRules?: ColorRule[];
  rowHeight?: RowHeight;
  readOnly: boolean;
  tableId?: string;
  baseId?: string;
  onSort: (fieldId: string) => void;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onDelete: (recordId: string) => void;
  onAdd: () => void;
  onAddField: () => void;
  onRenameField: (fieldId: string, name: string) => void;
  onEditOptions: (field: Field) => void;
  onChangeType?: (field: Field) => void;
  onDeleteField: (field: Field) => void;
  onOpenRecord?: (recordId: string) => void;
}) {
  const catalog = allFields ?? fields;
  const fieldKey = fields.map((field) => field.id).join(",");
  const [widths, setWidths] = useState<Record<string, number>>(() => loadWidths(tableId, fields));
  const [resizing, setResizing] = useState<string | null>(null);

  useEffect(() => {
    setWidths(loadWidths(tableId, fields));
  }, [tableId, fieldKey]);

  useEffect(() => {
    if (!tableId) return;
    localStorage.setItem(`duowei:colwidths:${tableId}`, JSON.stringify(widths));
  }, [tableId, widths]);

  const startResize = useCallback((fieldId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startW = widths[fieldId] ?? MIN_COL;
    setResizing(fieldId);
    document.body.classList.add("col-resizing");

    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(MAX_COL, Math.max(MIN_COL, startW + (moveEvent.clientX - startX)));
      setWidths((current) => (current[fieldId] === next ? current : { ...current, [fieldId]: next }));
    };
    const onUp = () => {
      setResizing(null);
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [widths]);

  const resetWidth = useCallback((field: Field, index: number) => {
    setWidths((current) => ({ ...current, [field.id]: defaultWidth(field, index) }));
  }, []);

  const columns =
    fields.map((field) => `${widths[field.id] ?? defaultWidth(field, 0)}px`).join(" ") + ` ${ADD_COL}px`;
  const grouped = useMemo(() => groupRecords(records, fields, groups ?? []), [records, fields, groups]);
  const height = ROW_PX[rowHeight] ?? 40;

  return (
    <div className="grid-scroll">
      <div className="grid" style={{ ["--cols" as string]: columns, ["--row-h" as string]: `${height}px` }}>
        <div className="grid-row head">
          {fields.map((field, index) => {
            const sort = sorts.find((item) => item.fieldId === field.id);
            return (
              <div className="cell head-cell" key={field.id}>
                <button type="button" className="head-label" onClick={() => onSort(field.id)} title={field.name}>
                  <span>{field.name}</span>
                  {sort && <i>{sort.direction === "asc" ? "↑" : "↓"}</i>}
                </button>
                {!readOnly && (
                  <FieldMenu
                    field={field}
                    onRename={onRenameField}
                    onEditOptions={onEditOptions}
                    onChangeType={onChangeType}
                    onDelete={onDeleteField}
                  />
                )}
                <button
                  type="button"
                  className={resizing === field.id ? "col-resize active" : "col-resize"}
                  aria-label={`调整「${field.name}」列宽`}
                  title="拖拽调整列宽，双击恢复默认"
                  onPointerDown={(event) => startResize(field.id, event)}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    resetWidth(field, index);
                  }}
                />
              </div>
            );
          })}
          <div className="cell head-cell add-col">
            {!readOnly && (
              <button type="button" className="icon-button" onClick={onAddField} aria-label="添加字段">
                +
              </button>
            )}
          </div>
        </div>
        {grouped.map((group) => (
          <div key={group.key} className="grid-group">
            {group.label != null && (
              <div className="grid-group-label">
                <strong>{group.label || "(空)"}</strong>
                <span>{group.records.length}</span>
              </div>
            )}
            {group.records.map((record) => {
              const rowColor = resolveRowColor(record, catalog, colorRules);
              return (
              <div className="grid-row" key={record.id} style={rowColor ? { background: rowColor } : undefined}>
                {fields.map((field) => (
                  <div className="cell" key={field.id}>
                    <Cell
                      field={field}
                      allFields={catalog}
                      record={record}
                      value={record.fields[field.name] ?? null}
                      readOnly={readOnly || READONLY_TYPES.has(field.type)}
                      baseId={baseId}
                      onChange={(value) => {
                        if (field.type === "single_select" || field.type === "multi_select") {
                          const cascade = field.config.optionCascade;
                          if (cascade?.targetFieldId) {
                            const target = catalog.find((item) => item.id === cascade.targetFieldId);
                            if (target) {
                              const sourceName = typeof value === "string" ? value : "";
                              const allowed = sourceName ? cascade.map[sourceName] ?? [] : [];
                              const current = record.fields[target.name];
                              const currentName = typeof current === "string" ? current : "";
                              if (currentName && allowed.length && !allowed.includes(currentName)) {
                                onChange(record.id, target.name, null);
                              }
                            }
                          }
                        }
                        onChange(record.id, field.name, value);
                      }}
                    />
                  </div>
                ))}
                <div className="cell row-actions">
                  {onOpenRecord && (
                    <button type="button" className="icon-button" onClick={() => onOpenRecord(record.id)} aria-label="详情">
                      …
                    </button>
                  )}
                  {!readOnly && (
                    <button type="button" className="icon-button danger" onClick={() => onDelete(record.id)} aria-label="删除记录">
                      ×
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        ))}
        {!readOnly && (
          <button type="button" className="add-row" onClick={onAdd}>
            + 添加记录
          </button>
        )}
        {records.length === 0 && <p className="grid-empty">这张表还没有记录。</p>}
      </div>
    </div>
  );
}

function groupRecords(
  records: PublicRecord[],
  fields: Field[],
  groups: Array<{ fieldId: string }>,
): Array<{ key: string; label: string | null; records: PublicRecord[] }> {
  if (!groups.length) return [{ key: "all", label: null, records }];
  const field = fields.find((item) => item.id === groups[0].fieldId);
  if (!field) return [{ key: "all", label: null, records }];
  const map = new Map<string, PublicRecord[]>();
  for (const record of records) {
    const value = record.fields[field.name];
    const label = value == null || value === "" ? "" : Array.isArray(value) ? value.join(", ") : String(value);
    const list = map.get(label) ?? [];
    list.push(record);
    map.set(label, list);
  }
  return [...map.entries()].map(([label, items]) => ({ key: label || "__empty", label, records: items }));
}

function FieldMenu({
  field,
  onRename,
  onEditOptions,
  onChangeType,
  onDelete,
}: {
  field: Field;
  onRename: (fieldId: string, name: string) => void;
  onEditOptions: (field: Field) => void;
  onChangeType?: (field: Field) => void;
  onDelete: (field: Field) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(field.name);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  if (renaming) {
    return (
      <input
        className="rename-input"
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          setRenaming(false);
          if (name.trim() && name.trim() !== field.name) onRename(field.id, name.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
    );
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-button tiny" aria-label={`${field.name}字段菜单`} onClick={() => setOpen((value) => !value)}>
        ⋯
      </button>
      {open && (
        <div className="menu">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setRenaming(true);
            }}
          >
            重命名
          </button>
          {(field.type === "single_select" || field.type === "multi_select") && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEditOptions(field);
              }}
            >
              编辑选项
            </button>
          )}
          {onChangeType && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onChangeType(field);
              }}
            >
              更改类型
            </button>
          )}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="danger-text"
            onClick={() => {
              setOpen(false);
              onDelete(field);
            }}
          >
            删除字段
          </button>
        </div>
      )}
    </div>
  );
}

function Cell({
  field,
  allFields,
  record,
  value,
  readOnly,
  baseId,
  onChange,
}: {
  field: Field;
  allFields: Field[];
  record: PublicRecord;
  value: DisplayValue;
  readOnly: boolean;
  baseId?: string;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={value === true}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={field.name}
      />
    );
  }
  if (field.type === "single_select") {
    return (
      <SelectCell
        options={cascadeOptions(field, allFields, record)}
        value={typeof value === "string" ? value : ""}
        readOnly={readOnly}
        onChange={(next) => onChange(next || null)}
      />
    );
  }
  if (field.type === "multi_select" || field.type === "person" || field.type === "group" || field.type === "link" || field.type === "duplex_link") {
    const selected = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string" && value
        ? [value]
        : [];
    if (field.type === "multi_select") {
      return (
        <MultiSelectCell
          options={cascadeOptions(field, allFields, record)}
          value={selected}
          readOnly={readOnly}
          onChange={onChange}
        />
      );
    }
    if (field.type === "group" || field.type === "person") {
      return <TagListCell value={selected} readOnly={readOnly} placeholder={field.type === "group" ? "群组，逗号分隔" : "人员，逗号分隔"} onChange={onChange} />;
    }
    return (
      <PlainCell
        value={selected.join(", ")}
        type="text"
        readOnly={readOnly}
        onChange={(next) =>
          onChange(
            next
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  if (field.type === "geolocation") {
    const point =
      value && typeof value === "object" && !Array.isArray(value) && "lat" in value && "lng" in value
        ? (value as { lat: number; lng: number; label?: string })
        : null;
    return (
      <GeoCell
        value={point}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }
  if (field.type === "signature") {
    return (
      <SignatureCell
        value={typeof value === "string" ? value : ""}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }
  if (field.type === "attachment") {
    const files = Array.isArray(value)
      ? value.filter(
          (item): item is { name: string; url: string; mime?: string; size?: number } =>
            typeof item === "object" && item != null && "url" in item,
        )
      : [];
    return (
      <div className="attachment-cell">
        {files.map((file) => {
          const isImage =
            (file.mime && file.mime.startsWith("image/")) ||
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name) ||
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.url);
          const uploadId = file.url.match(/\/api\/uploads\/([^/?#]+)/)?.[1];
          return (
            <div key={file.url} className="attachment-item">
              {isImage ? (
                <a href={file.url} target="_blank" rel="noreferrer" className="attachment-preview-link">
                  <img src={file.url} alt={file.name} className="attachment-preview" />
                </a>
              ) : (
                <a href={file.url} target="_blank" rel="noreferrer">
                  {file.name}
                </a>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="tiny-btn"
                  onClick={async () => {
                    const next = files.filter((item) => item.url !== file.url);
                    onChange(next);
                    if (uploadId) {
                      try {
                        const { api } = await import("./api");
                        await api.deleteUpload(uploadId);
                      } catch {
                        /* best-effort cleanup */
                      }
                    }
                  }}
                >
                  删除
                </button>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <>
            <input
              type="file"
              className="file-input"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = "";
                bytes.forEach((b) => {
                  binary += String.fromCharCode(b);
                });
                const { api } = await import("./api");
                const uploaded = await api.upload(file.name, btoa(binary), file.type || undefined, {
                  baseId,
                  minRole: "viewer",
                });
                onChange([...files, { name: uploaded.name, url: uploaded.url, mime: uploaded.mime, size: uploaded.size }]);
              }}
            />
            <PlainCell
              value=""
              type="text"
              readOnly={false}
              onChange={(next) => {
                if (!next.trim()) return;
                onChange([...files, { name: next.split("/").pop() || "file", url: next.trim() }]);
              }}
            />
          </>
        )}
      </div>
    );
  }
  if (field.type === "button") {
    return (
      <button type="button" className="primary tiny-btn" disabled={readOnly} onClick={() => onChange("__click__")}>
        {typeof value === "string" ? value : field.config.buttonLabel || "执行"}
      </button>
    );
  }
  if (field.type === "barcode" || field.type === "lookup") {
    return (
      <PlainCell
        value={value == null ? "" : Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : item.name)).join(", ") : String(value)}
        type="text"
        readOnly={readOnly || field.type === "lookup"}
        onChange={(next) => onChange(next || null)}
      />
    );
  }
  if (field.type === "rating") {
    const max = field.config.max ?? 5;
    const current = typeof value === "number" ? value : 0;
    return (
      <div className="rating">
        {Array.from({ length: max }, (_, index) => {
          const score = index + 1;
          return (
            <button
              key={score}
              type="button"
              disabled={readOnly}
              className={score <= current ? "on" : ""}
              onClick={() => onChange(score === current ? 0 : score)}
            >
              ★
            </button>
          );
        })}
      </div>
    );
  }
  if (field.type === "progress") {
    const current = typeof value === "number" ? value : 0;
    return (
      <div className="progress-cell">
        <div className="bar">
          <i style={{ width: `${Math.max(0, Math.min(100, current))}%` }} />
        </div>
        <PlainCell
          value={String(current)}
          type="number"
          readOnly={readOnly}
          onChange={(next) => onChange(next === "" ? null : Number(next))}
        />
      </div>
    );
  }
  if (field.type === "long_text") {
    return <LongTextCell value={typeof value === "string" ? value : ""} readOnly={readOnly} onChange={onChange} />;
  }
  if (field.type === "currency") {
    const amount = value == null ? "" : String(value);
    return (
      <div className="currency-cell">
        <span>{field.config.currency ?? "CNY"}</span>
        <PlainCell
          value={amount}
          type="number"
          readOnly={readOnly}
          onChange={(next) => onChange(next === "" ? null : Number(next))}
        />
      </div>
    );
  }
  const inputType =
    field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text";
  return (
    <PlainCell
      value={value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value)}
      type={inputType}
      readOnly={readOnly}
      onChange={(next) => onChange(field.type === "number" ? (next === "" ? null : Number(next)) : next || null)}
    />
  );
}

function PlainCell({
  value,
  type,
  readOnly,
  onChange,
}: {
  value: string;
  type: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  return (
    <input
      className="cell-input"
      type={type}
      value={draft}
      readOnly={readOnly}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (skip.current) {
          skip.current = false;
          return;
        }
        if (draft !== value) onChange(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          skip.current = true;
          setDraft(value);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function LongTextCell({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => {
    setOpen(false);
    if (draft !== value) onChange(draft);
  });
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="menu-wrap long-text" ref={ref}>
      <button type="button" className="long-preview" onClick={() => !readOnly && setOpen(true)} disabled={readOnly}>
        {value || <span className="placeholder">填写</span>}
      </button>
      {open && (
        <div className="popover">
          <textarea className="cell-textarea" value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} rows={6} />
        </div>
      )}
    </div>
  );
}

function SelectCell({
  options,
  value,
  readOnly,
  onChange,
}: {
  options: NonNullable<Field["config"]["options"]>;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const current = options.find((option) => option.name === value);

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="select-trigger" disabled={readOnly} onClick={() => setOpen((item) => !item)}>
        {current ? <span className={`tag ${current.color}`}>{current.name}</span> : <span className="placeholder">选择</span>}
      </button>
      {open && (
        <div className="menu">
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            清空
          </button>
          <div className="menu-sep" role="separator" />
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              className={option.name === value ? "on" : ""}
              onClick={() => {
                onChange(option.name);
                setOpen(false);
              }}
            >
              <span className={`tag ${option.color}`}>{option.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TagListCell({
  value,
  readOnly,
  placeholder,
  onChange,
}: {
  value: string[];
  readOnly: boolean;
  placeholder: string;
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  useEffect(() => {
    setDraft(value.join(", "));
  }, [value]);
  return (
    <div className="tag-list-cell">
      {value.length > 0 && (
        <div className="app-tags" style={{ marginBottom: 4 }}>
          {value.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
      <input
        className="cell-input"
        value={draft}
        disabled={readOnly}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() =>
          onChange(
            draft
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function MultiSelectCell({
  options,
  value,
  readOnly,
  onChange,
}: {
  options: NonNullable<Field["config"]["options"]>;
  value: string[];
  readOnly: boolean;
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="select-trigger multi" disabled={readOnly} onClick={() => setOpen((item) => !item)}>
        {value.length ? (
          value.map((name) => {
            const option = options.find((item) => item.name === name);
            return (
              <span key={name} className={`tag ${option?.color ?? "gray"}`}>
                {name}
              </span>
            );
          })
        ) : (
          <span className="placeholder">选择</span>
        )}
      </button>
      {open && (
        <div className="menu">
          {options.map((option) => {
            const checked = value.includes(option.name);
            return (
              <button
                type="button"
                key={option.id}
                onClick={() => onChange(checked ? value.filter((name) => name !== option.name) : [...value, option.name])}
              >
                <span className={`tag ${option.color}`}>{option.name}</span>
                {checked ? "✓" : ""}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useDismiss(ref: { current: HTMLElement | null }, enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    function onPointer(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [enabled, onClose, ref]);
}

function resolveRowColor(
  record: PublicRecord,
  fields: Field[],
  colorRules: ColorRule[] | undefined,
): string | undefined {
  if (!colorRules?.length) return undefined;
  for (const rule of colorRules) {
    if (rule.target === "cell") continue;
    const field = fields.find((item) => item.id === rule.fieldId);
    if (!field) continue;
    if (matchesFilter(record.fields[field.name], { fieldId: rule.fieldId, op: rule.op, value: rule.value })) {
      return rule.color;
    }
  }
  return undefined;
}

function cascadeOptions(field: Field, allFields: Field[], record: PublicRecord): NonNullable<Field["config"]["options"]> {
  const options = field.config.options ?? [];
  const source = allFields.find((item) => item.config.optionCascade?.targetFieldId === field.id);
  if (!source?.config.optionCascade) return options;
  const sourceValue = record.fields[source.name];
  const sourceName = typeof sourceValue === "string" ? sourceValue : "";
  if (!sourceName) return options;
  const allowed = source.config.optionCascade.map[sourceName];
  if (!allowed) return options;
  return options.filter((option) => allowed.includes(option.name));
}

function GeoCell({
  value,
  readOnly,
  onChange,
}: {
  value: { lat: number; lng: number; label?: string } | null;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const [lat, setLat] = useState(value?.lat != null ? String(value.lat) : "");
  const [lng, setLng] = useState(value?.lng != null ? String(value.lng) : "");
  const [label, setLabel] = useState(value?.label ?? "");
  useEffect(() => {
    setLat(value?.lat != null ? String(value.lat) : "");
    setLng(value?.lng != null ? String(value.lng) : "");
    setLabel(value?.label ?? "");
  }, [value?.lat, value?.lng, value?.label]);

  function commit(nextLat = lat, nextLng = lng, nextLabel = label) {
    if (!nextLat.trim() && !nextLng.trim()) {
      onChange(null);
      return;
    }
    const latN = Number(nextLat);
    const lngN = Number(nextLng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return;
    onChange({ lat: latN, lng: lngN, label: nextLabel.trim() || undefined });
  }

  return (
    <div className="geo-cell">
      <input
        type="number"
        step="any"
        placeholder="纬度"
        value={lat}
        disabled={readOnly}
        onChange={(event) => setLat(event.target.value)}
        onBlur={() => commit()}
      />
      <input
        type="number"
        step="any"
        placeholder="经度"
        value={lng}
        disabled={readOnly}
        onChange={(event) => setLng(event.target.value)}
        onBlur={() => commit()}
      />
      <input
        type="text"
        placeholder="地点"
        value={label}
        disabled={readOnly}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={() => commit()}
      />
      {!readOnly && typeof navigator !== "undefined" && navigator.geolocation && (
        <button
          type="button"
          className="tiny-btn"
          onClick={() => {
            navigator.geolocation.getCurrentPosition((pos) => {
              const nextLat = String(pos.coords.latitude);
              const nextLng = String(pos.coords.longitude);
              setLat(nextLat);
              setLng(nextLng);
              commit(nextLat, nextLng, label);
            });
          }}
        >
          定位
        </button>
      )}
    </div>
  );
}

function SignatureCell({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = value;
  }, [value]);

  function pointer(event: ReactPointerEvent<HTMLCanvasElement>, type: "down" | "move" | "up") {
    if (readOnly) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    if (type === "down") {
      drawing.current = true;
      ctx.beginPath();
      ctx.moveTo(x, y);
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (type === "move" && drawing.current) {
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#0f172a";
      ctx.lineTo(x, y);
      ctx.stroke();
      return;
    }
    if (type === "up" && drawing.current) {
      drawing.current = false;
      onChange(canvas.toDataURL("image/png"));
    }
  }

  return (
    <div className="signature-cell">
      {value && readOnly ? (
        <img src={value} alt="签字" className="signature-preview" />
      ) : (
        <canvas
          ref={canvasRef}
          width={160}
          height={48}
          className="signature-pad"
          onPointerDown={(event) => pointer(event, "down")}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerUp={(event) => pointer(event, "up")}
        />
      )}
      {!readOnly && (
        <button
          type="button"
          className="tiny-btn"
          onClick={() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext("2d");
            if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            onChange(null);
          }}
        >
          清除
        </button>
      )}
    </div>
  );
}
