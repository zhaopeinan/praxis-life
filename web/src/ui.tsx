import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

export function useMediaQuery(query: string): boolean {  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function DropMenu({
  label = "⋯",
  ariaLabel = "更多操作",
  className,
  panelClassName,
  children,
}: {
  label?: ReactNode;
  ariaLabel?: string;
  className?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (el) setRect(el.getBoundingClientRect());
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
      const el = wrapRef.current;
      if (el) setRect(el.getBoundingClientRect());
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    window.visualViewport?.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      window.visualViewport?.removeEventListener("resize", onReposition);
    };
  }, [open]);

  const menuStyle = (() => {
    if (rect == null) return undefined;
    const gap = 4;
    const viewH = window.visualViewport?.height ?? window.innerHeight;
    const spaceBelow = viewH - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const base: CSSProperties = {
      position: "fixed",
      right: Math.max(8, window.innerWidth - rect.right),
      maxHeight: Math.max(160, Math.min(viewH * 0.6, openUp ? spaceAbove : spaceBelow)),
      zIndex: 80,
    };
    if (openUp) base.bottom = viewH - rect.top + gap;
    else base.top = rect.bottom + gap;
    return base;
  })();

  return (
    <div className={`drop-menu${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="drop-menu-trigger secondary"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            className={`menu drop-menu-panel${panelClassName ? ` ${panelClassName}` : ""}`}
            role="menu"
            ref={menuRef}
            style={menuStyle}
            onClick={(event) => {
              const button = (event.target as HTMLElement).closest("button");
              if (button && !button.classList.contains("fancy-select-trigger")) setOpen(false);
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

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
    window.visualViewport?.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      window.visualViewport?.removeEventListener("resize", onReposition);
    };
  }, [open]);

  const menuStyle = (() => {
    if (rect == null) return undefined;
    const gap = 4;
    const maxMenu = 320;
    const viewH = window.visualViewport?.height ?? window.innerHeight;
    const spaceBelow = viewH - rect.bottom - 12;
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

export type ContextMenuItem = { label: string; danger?: boolean; onClick: () => void } | "sep";

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, (window.visualViewport?.height ?? window.innerHeight) - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div className="menu context-menu" role="menu" ref={menuRef} style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 90 }}>
      {items.map((item, index) =>
        item === "sep" ? (
          <hr className="menu-sep" key={index} />
        ) : (
          <button
            type="button"
            key={index}
            className={item.danger ? "danger-text" : ""}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
