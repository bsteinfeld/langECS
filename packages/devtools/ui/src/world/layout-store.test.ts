import { expect, test } from 'vitest';
import { fallbackSlot, type KV, layoutKey, loadLayout, saveLayout } from './layout-store';

/** In-memory KV — tests run in node, where localStorage does not exist. */
function fakeKV(seed: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test('round-trips a layout per world id', () => {
  const kv = fakeKV();
  saveLayout('tour', { 1: { x: 10, y: 20 }, 5: { x: 300, y: 40 } }, kv);
  expect(loadLayout('tour', kv)).toEqual({ 1: { x: 10, y: 20 }, 5: { x: 300, y: 40 } });
  // other worlds are unaffected
  expect(loadLayout('playground', kv)).toEqual({});
});

test('missing or corrupt storage yields an empty layout', () => {
  expect(loadLayout('tour', fakeKV())).toEqual({});
  expect(loadLayout('tour', fakeKV({ [layoutKey('tour')]: 'not json{' }))).toEqual({});
  expect(loadLayout('tour', fakeKV({ [layoutKey('tour')]: '[1,2]' }))).toEqual({});
});

test('entries that are not points are dropped on load', () => {
  const kv = fakeKV({
    [layoutKey('w')]: JSON.stringify({ 1: { x: 1, y: 2 }, 2: { x: 'nope', y: 2 }, 3: null }),
  });
  expect(loadLayout('w', kv)).toEqual({ 1: { x: 1, y: 2 } });
});

test('fallbackSlot is a deterministic grid with distinct slots', () => {
  expect(fallbackSlot(0)).toEqual(fallbackSlot(0));
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const p = fallbackSlot(i);
    seen.add(`${p.x},${p.y}`);
  }
  expect(seen.size).toBe(12);
});
