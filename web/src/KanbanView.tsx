import { useRef, useState, type MouseEvent } from "react";
import type { DisplayValue, Field, PublicRecord } from "../../src/types.js";
import { beginTouchDrag } from "./touchDrag";

export function KanbanView({
  fields,
  records,
  groupField,
  readOnly,
  onChange,
  onAdd,
  onDelete,
  onOpenRecord,
}: {
  fields: Field[];
  records: PublicRecord[];
  groupField: Field;
  readOnly: boolean;
  onChange: (recordId: string, fieldName: string, value: unknown) => void;
  onAdd: (optionName: string | null) => void;
  onDelete: (recordId: string) => void;
  /** 点击卡片打开记录详情（拖动改状态时不触发） */
  onOpenRecord?: (recordId: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [touchDragging, setTouchDragging] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  /** 按下时的坐标，用来区分「点一下」和「拖动」 */
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const options = groupField.config.options ?? [];
  const primary = fields[0];
  const extra = fields.filter((field) => field.id !== primary?.id && field.id !== groupField.id).slice(0, 3);
  const columns = [
    ...options.map((option) => ({ key: option.name, name: option.name, color: option.color })),
    { key: "__empty__", name: "未分组", color: "gray" },
  ];

  function openRecord(recordId: string, event: MouseEvent<HTMLElement>) {
    // 卡片内部的按钮（删除等）有自己的行为，不要顺带打开详情
    if ((event.target as HTMLElement).closest("button")) return;
    // 刚才是拖动（鼠标或触屏）就别打开详情，否则拖完就弹窗很烦
    const start = pointerStart.current;
    pointerStart.current = null;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    onOpenRecord?.(recordId);
  }

  return (
    <div className="kanban">
      {columns.map((column) => {
        const cards = records.filter((record) => {
          const value = record.fields[groupField.name];
          if (column.key === "__empty__") return value == null || value === "";
          return value === column.name;
        });
        return (
          <section
            key={column.key}
            className={over === column.key ? "column over" : "column"}
            data-drop-key={column.key}
            onDragOver={(event) => {
              if (readOnly) return;
              event.preventDefault();
              setOver(column.key);
            }}
            onDragLeave={() => setOver((current) => (current === column.key ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              const id = dragId.current;
              dragId.current = null;
              if (!id || readOnly) return;
              onChange(id, groupField.name, column.key === "__empty__" ? null : column.name);
            }}
          >
            <header>
              <span className={`tag ${column.color}`}>{column.name}</span>
              <em>{cards.length}</em>
            </header>
            <div className="cards">
              {cards.map((record) => (
                <article
                  key={record.id}
                  className={touchDragging === record.id ? "touch-dragging" : undefined}
                  draggable={!readOnly}
                  title={onOpenRecord && !readOnly ? "点击查看详情，拖动改状态" : undefined}
                  onPointerDown={(event) => {
                    pointerStart.current = { x: event.clientX, y: event.clientY };
                  }}
                  onClick={(event) => openRecord(record.id, event)}
                  onDragStart={() => {
                    dragId.current = record.id;
                  }}
                  onDragEnd={() => {
                    dragId.current = null;
                  }}
                  onTouchStart={(event) => {
                    if (readOnly) return;
                    beginTouchDrag(event, {
                      onActivate: () => setTouchDragging(record.id),
                      onTargetChange: (key) => setOver(key),
                      onDrop: (key) => {
                        if (key) onChange(record.id, groupField.name, key === "__empty__" ? null : key);
                      },
                      onEnd: () => {
                        setTouchDragging(null);
                        setOver(null);
                      },
                    });
                  }}
                >
                  <div className="card-top">
                    <h3>{text(record.fields[primary?.name ?? ""]) || "未命名"}</h3>
                    {!readOnly && (
                      <button type="button" className="icon-button tiny" aria-label="删除记录" onClick={() => onDelete(record.id)}>
                        ×
                      </button>
                    )}
                  </div>
                  <div className="card-meta">
                    {extra.map((field) => {
                      const value = record.fields[field.name];
                      if (value == null || value === "" || value === false) return null;
                      if ((field.type === "single_select" || field.type === "multi_select") && field.config.options) {
                        const names = (Array.isArray(value) ? value : [String(value)]).map((item) =>
                          typeof item === "string" ? item : item.name,
                        );
                        return names.map((name) => {
                          const option = field.config.options?.find((item) => item.name === name);
                          return (
                            <span key={name} className={`tag ${option?.color ?? "gray"}`}>
                              {name}
                            </span>
                          );
                        });
                      }
                      return <span key={field.id}>{text(value)}</span>;
                    })}
                  </div>
                </article>
              ))}
            </div>
            {!readOnly && (
              <button type="button" className="add-card" onClick={() => onAdd(column.key === "__empty__" ? null : column.name)}>
                + 添加
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function text(value: DisplayValue | undefined): string {
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}
