import { expect, test, vi } from 'vitest';
import { defineComponent, defineTag, getComponentByName, listComponents } from '../src/component';

test('R7 application duplicates cannot substitute a reducer or change tag introspection', () => {
  const name = 'interop.StrictValue';
  const original = defineComponent<number>({ name, reducer: (a, b) => a + b });
  expect(() => defineComponent<number>({ name, reducer: Math.max })).toThrow();
  expect(() => defineTag(name)).toThrow();
  expect(getComponentByName(name)).toBe(original);
  expect(listComponents().find((c) => c.name === name)?.tag).toBe(false);
});

test('R7 a module reset starts a fresh registry without a duplicate-install diagnostic', async () => {
  const old = defineComponent<number>({ name: 'interop.BeforeReload' });
  vi.resetModules();
  const reloaded = await import('../src/index');
  expect(typeof reloaded.createWorld).toBe('function');
  expect(reloaded.getComponentByName('interop.BeforeReload')).toBeUndefined();
  const fresh = reloaded.defineComponent<number>({ name: 'interop.BeforeReload' });
  expect(fresh).not.toBe(old);
  expect(getComponentByName('interop.BeforeReload')).toBe(old);
  expect(reloaded.getComponentByName('interop.BeforeReload')).toBe(fresh);
  expect(() => reloaded.defineTag('interop.BeforeReload')).toThrow();
});
