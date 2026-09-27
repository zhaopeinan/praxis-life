import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption = { value: string; label: string; disabled?: boolean };

export function FancySelect({
  value,
  options,
  onChange,
  disabled,
  placeholder = "请选择",
  required,
  id,
  "aria-label": ariaLabel,
  className,
  compact,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
  /** 工具栏等窄位：更矮、宽度随内容 */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((item) => item.value === value);

  function measure() {
    const el = wrapRef.current;
    if (!el) return;
    setRect(el.getBoundingClientRect());
  }

  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onReposition() {
      measure();
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  const menuStyle = (() => {
    if (rect == null) return undefined;
    const gap = 4;
    const maxMenu = 320;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, Math.min(maxMenu, openUp ? spaceAbove : spaceBelow));
    const top = openUp ? Math.max(8, rect.top - maxHeight - gap) : rect.bottom + gap;
    const width = Math.max(rect.width, compact ? 140 : 180);
    return {
      position: "fixed" as const,
      top,
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      maxHeight,
      zIndex: 80,
    };
  })();

  return (
    <div className={`fancy-select${compact ? " compact" : ""}${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        id={id}
        type="button"
        className="fancy-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          setOpen((item) => !item);
        }}
      >
        <span className={current ? "" : "placeholder"}>{current?.label ?? placeholder}</span>
        <span className="fancy-select-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          className="fancy-select-required"
          value={value}
          required
          onChange={() => undefined}
        />
      )}
      {open &&
        rect &&
        createPortal(
          <div className="menu fancy-select-menu" role="listbox" ref={menuRef} style={menuStyle}>
            {!required && placeholder != null && options.every((item) => item.value !== "") && (
              <button
                type="button"
                role="option"
                className={!value ? "on" : ""}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                {placeholder}
              </button>
            )}
            {options.map((option) => (
              <button
                type="button"
                role="option"
                key={option.value || "__empty"}
                disabled={option.disabled}
                className={option.value === value ? "on" : ""}
                aria-selected={option.value === value}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
