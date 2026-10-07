import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

/**
 * 栏目宽度的拖拽与记忆。
 *
 * 关键取舍：拖拽过程中**不改 React state**，而是直接写目标元素上的 CSS 变量。
 * 文档正文里挂着 Markdown / KaTeX / Mermaid，如果每个 pointermove 都触发一次
 * App 级别的重渲染，拖动会明显卡顿。所以宽度存在 ref 里，松手时才落 localStorage。
 */
export function usePaneWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  cssVar,
  varTargetRef,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** 承载宽度的 CSS 变量名，例如 `--nav-w`。 */
  cssVar: string;
  /** 变量写在哪个元素上（第一栏写在 `.app` 网格上，第二栏写在栏自身）。 */
  varTargetRef: RefObject<HTMLElement | null>;
}) {
  const widthRef = useRef(defaultWidth);

  const apply = useCallback(
    (width: number) => {
      widthRef.current = width;
      varTargetRef.current?.style.setProperty(cssVar, `${width}px`);
    },
    [cssVar, varTargetRef],
  );

  useEffect(() => {
    let stored = defaultWidth;
    try {
      const parsed = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(parsed) && parsed > 0) stored = parsed;
    } catch {
      // localStorage 不可用时就用默认宽度。
    }
    apply(Math.min(max, Math.max(min, stored)));
    // 只在挂载 / 换 key 时读一次，之后宽度由拖拽直接写进 style。
  }, [storageKey, apply, defaultWidth, min, max]);

  const persist = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey, String(Math.round(widthRef.current)));
    } catch {
      // 忽略：记不住宽度不影响使用。
    }
  }, [storageKey]);

  const clamp = useCallback((width: number) => Math.min(max, Math.max(min, width)), [max, min]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      const handle = event.currentTarget;
      handle.classList.add("active");
      document.body.classList.add("col-resizing");

      const onMove = (moveEvent: PointerEvent) => {
        // 手柄贴在栏的右边缘，向右拖即变宽。
        apply(clamp(startWidth + (moveEvent.clientX - startX)));
      };
      const onUp = () => {
        handle.classList.remove("active");
        document.body.classList.remove("col-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        persist();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [apply, clamp, persist],
  );

  const resetWidth = useCallback(() => {
    apply(defaultWidth);
    persist();
  }, [apply, defaultWidth, persist]);

  const nudge = useCallback(
    (delta: number) => {
      apply(clamp(widthRef.current + delta));
      persist();
    },
    [apply, clamp, persist],
  );

  return { startResize, resetWidth, nudge };
}

/** 贴在栏目右边缘的分隔手柄：拖动调宽，双击复位，方向键微调。 */
export function PaneHandle({
  onPointerDown,
  onReset,
  onNudge,
  label,
}: {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onReset: () => void;
  onNudge: (delta: number) => void;
  label: string;
}) {
  return (
    <div
      className="pane-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}：拖动调整宽度，双击复位`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(16);
        }
      }}
    />
  );
}

/** 读写一个布尔型的界面偏好（列为收起态等）。 */
export function readFlag(key: string, fallback = false): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // 忽略。
  }
}
