import { useMemo, useState } from "react";
import type { DisplayValue, Field, PublicRecord, View } from "../../src/types.js";
import { groupRecords } from "./GridView";
import { FancySelect } from "./ui";

export function displayValue(value: DisplayValue | undefined): string {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : (item.name ?? "")))
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object" && "lat" in value) {
    return typeof value.label === "string" && value.label.trim() ? value.label.trim() : `${value.lat}, ${value.lng}`;
  }
  const text = String(value);
  if (text.startsWith("data:image/")) return "（签字）";
  return text;
}

function fieldTags(field: Field, value: DisplayValue | undefined): string[] {
  if (!field.config.options) return [];
  const names = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  return names.filter((item): item is string => typeof item === "string");
}

function tagColor(field: Field, name: string): string {
  return field.config.options?.find((item) => item.name === name)?.color ?? "gray";
}

function RecordCard({
  fields,
  record,
  onOpen,
}: {
  fields: Field[];
  record: PublicRecord;
  onOpen: (id: string) => void;
}) {
  const primary = fields[0];
  const title = displayValue(record.fields[primary?.name ?? ""]) || "未命名";
  const summary = fields
    .filter((field) => field.id !== primary?.id)
    .map((field) => ({ field, text: displayValue(record.fields[field.name]) }))
    .filter((item) => item.text)
    .slice(0, 3);
  return (
    <button type="button" className="m-card" onClick={() => onOpen(record.id)}>
      <h3>{title}</h3>
      {summary.length > 0 && (
        <div className="m-card-meta">
          {summary.map(({ field, text }) => (
            <div className="m-field" key={field.id}>
              <span className="m-field-name">{field.name}</span>
              <span className="m-field-value">
                {field.type === "single_select" || field.type === "multi_select"
                  ? fieldTags(field, record.fields[field.name]).map((name) => (
                      <span key={name} className={`tag ${tagColor(field, name)}`}>
                        {name}
                      </span>
                    ))
                  : text}
              </span>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

export function RecordCardList({
  fields,
  records,
  groups,
  readOnly,
  onOpenRecord,
  onAdd,
}: {
  fields: Field[];
  records: PublicRecord[];
  groups: View["config"]["groups"];
  readOnly: boolean;
  onOpenRecord: (id: string) => void;
  onAdd: () => void;
}) {
  const grouped = useMemo(() => groupRecords(records, fields, groups ?? []), [records, fields, groups]);
  return (
    <div className="m-card-list">
      {grouped.map((group) => (
        <section key={group.key} className="m-group">
          {group.label != null && (
            <header className="m-group-header">
              {group.label || "未分组"}
              <span>{group.records.length}</span>
            </header>
          )}
          {group.records.map((record) => (
            <RecordCard key={record.id} fields={fields} record={record} onOpen={onOpenRecord} />
          ))}
          {group.records.length === 0 && <p className="m-empty">这一组还没有记录。</p>}
        </section>
      ))}
      {records.length === 0 && <p className="m-empty">没有符合条件的记录。</p>}
      {!readOnly && (
        <button type="button" className="m-add" onClick={onAdd}>
          ＋ 添加记录
        </button>
      )}
    </div>
  );
}

export function MobileKanban({
  fields,
  records,
  groupField,
  readOnly,
  onChange,
  onAdd,
  onOpenRecord,
}: {
  fields: Field[];
  records: PublicRecord[];
  groupField: Field;
  readOnly: boolean;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onAdd: (optionName: string | null) => void;
  onOpenRecord: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const options = groupField.config.options ?? [];
  const primary = fields[0];
  const extra = fields.filter((field) => field.id !== primary?.id && field.id !== groupField.id).slice(0, 2);
  const columns = [
    ...options.map((option) => ({ key: option.name, name: option.name, color: option.color })),
    { key: "__empty__", name: "未分组", color: "gray" },
  ];

  return (
    <div className="m-accordion">
      {columns.map((column) => {
        const cards = records.filter((record) => {
          const value = record.fields[groupField.name];
          if (column.key === "__empty__") return value == null || value === "";
          return value === column.name;
        });
        const isCollapsed = Boolean(collapsed[column.key]);
        return (
          <section key={column.key} className="m-accordion-group">
            <button
              type="button"
              className="m-accordion-head"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((current) => ({ ...current, [column.key]: !current[column.key] }))}
            >
              <span className={`tag ${column.color}`}>{column.name}</span>
              <em>{cards.length}</em>
              <span className="m-accordion-caret">{isCollapsed ? "▸" : "▾"}</span>
            </button>
            {!isCollapsed && (
              <div className="m-accordion-body">
                {cards.map((record) => (
                  <div key={record.id} className="m-kanban-card">
                    <button type="button" className="m-kanban-open" onClick={() => onOpenRecord(record.id)}>
                      <h3>{displayValue(record.fields[primary?.name ?? ""]) || "未命名"}</h3>
                      {extra.length > 0 && (
                        <div className="m-card-meta">
                          {extra.map((field) => {
                            const text = displayValue(record.fields[field.name]);
                            if (!text) return null;
                            return (
                              <div className="m-field" key={field.id}>
                                <span className="m-field-name">{field.name}</span>
                                <span className="m-field-value">
                                  {field.type === "single_select" || field.type === "multi_select"
                                    ? fieldTags(field, record.fields[field.name]).map((name) => (
                                        <span key={name} className={`tag ${tagColor(field, name)}`}>
                                          {name}
                                        </span>
                                      ))
                                    : text}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </button>
                    {!readOnly && (
                      <FancySelect
                        compact
                        aria-label="移动到分组"
                        value={column.key === "__empty__" ? "" : column.name}
                        options={[
                          { value: "", label: "未分组" },
                          ...options.map((option) => ({ value: option.name, label: option.name })),
                        ]}
                        onChange={(value) => {
                          if ((value || null) !== (column.key === "__empty__" ? null : column.name)) {
                            onChange(record.id, groupField.name, value || null);
                          }
                        }}
                      />
                    )}
                  </div>
                ))}
                {cards.length === 0 && <p className="m-empty">暂无卡片</p>}
                {!readOnly && (
                  <button
                    type="button"
                    className="m-add"
                    onClick={() => onAdd(column.key === "__empty__" ? null : column.name)}
                  >
                    ＋ 添加
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function MobileAgenda({
  fields,
  records,
  dateFieldId,
  titleFieldId,
  onOpen,
}: {
  fields: Field[];
  records: PublicRecord[];
  dateFieldId: string | null;
  titleFieldId: string | null;
  onOpen?: (recordId: string) => void;
}) {
  const dateField = fields.find((field) => field.id === dateFieldId && field.type === "date");
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const days = useMemo(() => {
    const map = new Map<string, PublicRecord[]>();
    if (!dateField) return map;
    for (const record of records) {
      const raw = record.fields[dateField.name];
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      const list = map.get(raw) ?? [];
      list.push(record);
      map.set(raw, list);
    }
    return map;
  }, [records, dateField]);

  if (!dateField) {
    return <p className="stage-note">请先在视图设置中选择日期字段。</p>;
  }

  const titleField = fields.find((field) => field.id === titleFieldId) ?? fields[0];
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const entries: Array<{ date: Date; key: string; items: PublicRecord[] }> = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const items = days.get(key) ?? [];
    if (items.length) entries.push({ date, key, items });
  }

  return (
    <div className="m-agenda">
      <div className="m-agenda-head">
        <button type="button" onClick={() => setCursor(new Date(year, month - 1, 1))}>
          上月
        </button>
        <strong>{`${year} 年 ${month + 1} 月`}</strong>
        <button type="button" onClick={() => setCursor(new Date(year, month + 1, 1))}>
          下月
        </button>
      </div>
      {entries.length === 0 && <p className="m-empty">这个月还没有日程。</p>}
      {entries.map(({ date, key, items }) => (
        <section key={key} className="m-agenda-day">
          <header>
            {`${month + 1} 月 ${date.getDate()} 日`}
            <span>周{WEEKDAYS[date.getDay()]}</span>
          </header>
          {items.map((record) => (
            <button type="button" key={record.id} className="m-agenda-event" onClick={() => onOpen?.(record.id)}>
              {displayValue(record.fields[titleField?.name ?? ""]) || "未命名"}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

export function BottomBar({
  canAdd,
  searchActive,
  onNav,
  onAdd,
  onSearch,
  onFilter,
  onViews,
}: {
  canAdd: boolean;
  searchActive: boolean;
  onNav: () => void;
  onAdd: () => void;
  onSearch: () => void;
  onFilter: () => void;
  onViews: () => void;
}) {
  return (
    <nav className="bottom-bar" aria-label="快捷操作">
      <button type="button" onClick={onNav}>
        <span aria-hidden>≡</span>空间
      </button>
      {canAdd && (
        <button type="button" className="bottom-bar-add" onClick={onAdd}>
          <span aria-hidden>＋</span>新建
        </button>
      )}
      <button type="button" className={searchActive ? "on" : ""} onClick={onSearch}>
        <span aria-hidden>⌕</span>搜索
      </button>
      <button type="button" onClick={onFilter}>
        <span aria-hidden>⧨</span>筛选
      </button>
      <button type="button" onClick={onViews}>
        <span aria-hidden>▦</span>视图
      </button>
    </nav>
  );
}
