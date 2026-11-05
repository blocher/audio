import { useEffect, useRef, useState } from "react";

/** Move every key in `picked` one place up (-1) or down (1). A run of picked keys moves as a block and stops at the end. */
export function shiftKeys<K>(keys: K[], picked: Set<K>, dir: -1 | 1): K[] {
  const next = [...keys];
  const swap = (i: number, j: number) => ([next[i], next[j]] = [next[j], next[i]]);
  if (dir < 0) {
    for (let i = 1; i < next.length; i++) if (picked.has(next[i]) && !picked.has(next[i - 1])) swap(i, i - 1);
  } else {
    for (let i = next.length - 2; i >= 0; i--) if (picked.has(next[i]) && !picked.has(next[i + 1])) swap(i, i + 1);
  }
  return next;
}

/** Picked keys (in list order) moved to the start or the end. */
export function toEdge<K>(keys: K[], picked: Set<K>, edge: "top" | "bottom"): K[] {
  const mine = keys.filter((k) => picked.has(k));
  const rest = keys.filter((k) => !picked.has(k));
  return edge === "top" ? [...mine, ...rest] : [...rest, ...mine];
}

/** Picked keys (in list order) put down at `target`, an insertion point counted in the original list (0 … length). */
export function dropAt<K>(keys: K[], picked: Set<K>, target: number): K[] {
  const mine = keys.filter((k) => picked.has(k));
  const rest = keys.filter((k) => !picked.has(k));
  const at = keys.slice(0, target).filter((k) => !picked.has(k)).length;
  return [...rest.slice(0, at), ...mine, ...rest.slice(at)];
}

export const sameOrder = <K,>(a: K[], b: K[]) => a.length === b.length && a.every((k, i) => k === b[i]);

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if ((overflowY === "auto" || overflowY === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

type Drag<K> = { moving: Set<K>; target: number; y: number };

/**
 * Reorder a list by dragging a handle, with mouse or touch. Put `listRef` on the list, `data-sort-row` on each row,
 * and spread `handle(key)` on each row's grip. Dragging a picked row carries every picked row with it.
 * The list scrolls (its own scroller, or the page) while the pointer is held near its top or bottom edge.
 */
export function useDragSort<K>(keys: K[], picked: Set<K>, commit: (next: K[]) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag<K> | null>(null);
  const live = useRef<Drag<K> | null>(null);
  const frame = useRef(0);

  const update = (d: Drag<K> | null) => {
    live.current = d;
    setDrag(d);
  };

  const targetAt = (y: number) => {
    const rows = listRef.current ? [...listRef.current.querySelectorAll<HTMLElement>("[data-sort-row]")] : [];
    return rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return y > b.top + b.height / 2;
    }).length;
  };

  const tick = () => {
    const d = live.current;
    if (!d) return;
    const scroller = scrollParent(listRef.current);
    const top = scroller ? scroller.getBoundingClientRect().top : 0;
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    const edge = 64;
    const speed = d.y < top + edge ? -Math.ceil((top + edge - d.y) / 6) : d.y > bottom - edge ? Math.ceil((d.y - bottom + edge) / 6) : 0;
    if (speed) {
      if (scroller) scroller.scrollTop += speed;
      else window.scrollBy(0, speed);
      const target = targetAt(d.y);
      if (target !== d.target) update({ ...d, target });
    }
    frame.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const end = (drop: boolean) => {
    cancelAnimationFrame(frame.current);
    const d = live.current;
    update(null);
    if (!drop || !d) return;
    const next = dropAt(keys, d.moving, d.target);
    if (!sameOrder(next, keys)) commit(next);
  };

  const handle = (key: K) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const moving = picked.has(key) ? new Set(picked) : new Set([key]);
      update({ moving, target: keys.indexOf(key), y: e.clientY });
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(tick);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = live.current;
      if (!d) return;
      const target = targetAt(e.clientY);
      live.current = { ...d, y: e.clientY };
      if (target !== d.target) update({ ...d, target, y: e.clientY });
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => live.current && end(true),
  });

  /** Class names for a row: faded while it's being carried, a line where the carried rows will land. */
  const rowClass = (key: K, index: number) => {
    if (!drag) return "";
    const cls = [];
    if (drag.moving.has(key)) cls.push("sort-moving");
    if (drag.target === index) cls.push("drop-before");
    if (index === keys.length - 1 && drag.target === keys.length) cls.push("drop-after");
    return cls.join(" ");
  };

  return { listRef, handle, rowClass, dragging: !!drag };
}
