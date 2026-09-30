import type { TouchEvent } from "react";

export type TouchDragCallbacks = {
  /** 长按激活（进入拖拽态） */
  onActivate?: () => void;
  /** 拖拽经过的放置目标（[data-drop-key] 最近祖先）变化 */
  onTargetChange?: (dropKey: string | null) => void;
  /** 松手时的放置目标；可能为 null（拖到空白处） */
  onDrop?: (dropKey: string | null) => void;
  /** 拖拽结束（无论是否成功放置），用于清理视觉状态 */
  onEnd?: () => void;
};

const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 10;

/**
 * 在可拖拽元素的 onTouchStart 中调用：长按激活拖拽，移动时通过
 * document.elementFromPoint 命中最接近的 [data-drop-key] 放置目标。
 * 激活前不拦截手势，页面滚动不受影响；移动超过阈值视为滚动并取消。
 */
export function beginTouchDrag(event: TouchEvent<HTMLElement>, callbacks: TouchDragCallbacks): void {
  if (event.touches.length !== 1) return;
  const source = event.currentTarget;
  const start = event.touches[0];
  const startX = start.clientX;
  const startY = start.clientY;
  let active = false;
  let done = false;
  let currentKey: string | null = null;
  let scrollEl: HTMLElement | null = null;

  const timer = window.setTimeout(() => {
    active = true;
    scrollEl = findHorizontalScroller(source);
    callbacks.onActivate?.();
  }, LONG_PRESS_MS);

  function findHorizontalScroller(el: HTMLElement | null): HTMLElement | null {
    let node = el?.parentElement ?? null;
    while (node) {
      const style = getComputedStyle(node);
      if ((style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollWidth > node.clientWidth) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function autoScroll(x: number) {
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    const EDGE = 48;
    const SPEED = 18;
    if (x < rect.left + EDGE) scrollEl.scrollLeft -= SPEED;
    else if (x > rect.right - EDGE) scrollEl.scrollLeft += SPEED;
  }

  function dropKeyAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y);
    const host = el?.closest?.("[data-drop-key]");
    return host instanceof HTMLElement ? (host.dataset.dropKey ?? null) : null;
  }

  function cleanup() {
    window.clearTimeout(timer);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchCancel);
  }

  function onMove(e: globalThis.TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    if (!active) {
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_CANCEL_PX) {
        done = true;
        cleanup();
      }
      return;
    }
    e.preventDefault();
    autoScroll(touch.clientX);
    const key = dropKeyAt(touch.clientX, touch.clientY);
    if (key !== currentKey) {
      currentKey = key;
      callbacks.onTargetChange?.(key);
    }
  }

  function finish(drop: boolean) {
    if (done) return;
    done = true;
    cleanup();
    if (!active) return;
    if (drop) callbacks.onDrop?.(currentKey);
    callbacks.onEnd?.();
  }

  function onTouchEnd() {
    finish(true);
  }

  function onTouchCancel() {
    finish(false);
  }

  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onTouchEnd);
  window.addEventListener("touchcancel", onTouchCancel);
}
