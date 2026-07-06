// Free-mode token positions, persisted per world in localStorage (spec: layout
// is a browser-side concern — never written into the world). KV is injected so
// node tests pass a fake; the component passes window.localStorage.

import type { Point } from './zones';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Layout = Record<number, Point>;

export function layoutKey(worldId: string): string {
  return `langecs-devtools:world-layout:${worldId}`;
}

function isPoint(value: unknown): value is Point {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { x?: unknown }).x === 'number' &&
    typeof (value as { y?: unknown }).y === 'number'
  );
}

export function loadLayout(worldId: string, kv: KV): Layout {
  const raw = kv.getItem(layoutKey(worldId));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const layout: Layout = {};
    for (const [id, point] of Object.entries(parsed)) {
      const n = Number(id);
      if (Number.isInteger(n) && isPoint(point)) layout[n] = point;
    }
    return layout;
  } catch {
    return {};
  }
}

export function saveLayout(worldId: string, layout: Layout, kv: KV): void {
  kv.setItem(layoutKey(worldId), JSON.stringify(layout));
}

/** Deterministic spawn grid for tokens without a saved position: 5 per row. */
export function fallbackSlot(index: number): Point {
  return { x: 40 + (index % 5) * 170, y: 40 + Math.floor(index / 5) * 150 };
}
