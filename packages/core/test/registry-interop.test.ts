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

test('R7 a second core evaluation fails with both module URLs before definitions can alias', async () => {
  const firstUrl = (import.meta as { url: string }).url.replace(
    'test/registry-interop.test.ts',
    'src/component.ts',
  );
  defineComponent<number>({ name: 'interop.BeforeDuplicate' });
  vi.resetModules();
  await expect(import('../src/component')).rejects.toThrow(/Multiple @langecs\/core instances/);
  // The failed import does not replace the first instance or mutate its registry.
  expect(getComponentByName('interop.BeforeDuplicate')?.componentName).toBe(
    'interop.BeforeDuplicate',
  );
  try {
    await import('../src/component');
  } catch (error) {
    expect(String(error)).toContain(firstUrl);
    expect(String(error)).toContain('First module:');
    expect(String(error)).toContain('Second module:');
    expect(String(error)).toContain('peer dependencies');
  }
});
