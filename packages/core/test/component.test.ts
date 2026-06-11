import { expect, test } from 'vitest';
import {
  AwaitingHuman,
  DuplicateComponentError,
  defineComponent,
  defineSystem,
  defineTag,
  getComponentByName,
  interrupt,
  Not,
  SystemError,
} from '../src/index';

test('T1 duplicate component name throws immediately', () => {
  defineComponent<number>({ name: 't1dup' });
  expect(() => defineComponent<string>({ name: 't1dup' })).toThrow(DuplicateComponentError);
  expect(() => defineTag('t1dup')).toThrow(/already defined/);
});

test('component types are callable and registered by name (R5, R7)', () => {
  const Count = defineComponent<number>({ name: 'count' });
  const init = Count(3);
  expect(init.component).toBe(Count);
  expect(init.value).toBe(3);
  expect(Count.componentName).toBe('count');
  expect(Count.name).toBe('count');
  expect(getComponentByName('count')).toBe(Count);
});

test('tags are ComponentType<true> callable with zero args (R6)', () => {
  const Busy = defineTag('busy');
  expect(Busy().value).toBe(true);
  expect(Busy(true).value).toBe(true);
  expect(Busy.componentName).toBe('busy');
});

test('Not() produces a negative query term (R8)', () => {
  const Flag = defineTag('notflag');
  const term = Not(Flag);
  expect(term.not).toBe(Flag);
});

test('built-in components have append reducers (R9, R10)', () => {
  const e1 = { system: 's1', step: 1, error: { name: 'Error', message: 'a' } };
  const e2 = { system: 's2', step: 2, error: { name: 'Error', message: 'b' } };
  expect(SystemError.reducer?.([e1], [e2])).toEqual([e1, e2]);
  const i1 = { id: 'a', kind: 'question' };
  const i2 = { id: 'b', kind: 'approval' };
  expect(AwaitingHuman.reducer?.([i1], [i2])).toEqual([i1, i2]);
});

test('interrupt helper generates ids when not supplied (R10)', () => {
  const withId = interrupt('approval', { tool: 'rm' }, 'custom-id');
  expect(withId.component).toBe(AwaitingHuman);
  expect(withId.value).toEqual([{ id: 'custom-id', kind: 'approval', payload: { tool: 'rm' } }]);
  // Generated ids carry per-process entropy (counter + random base36 suffix)
  // so a fresh process resumed from a snapshot cannot mint a colliding id.
  const generated = interrupt('question');
  const again = interrupt('question');
  expect(generated.value[0]?.id).toMatch(/^interrupt-\d+-[a-z0-9]+$/);
  expect(again.value[0]?.id).toMatch(/^interrupt-\d+-[a-z0-9]+$/);
  expect(again.value[0]?.id).not.toBe(generated.value[0]?.id);
});

test('defineSystem requires at least one positive query term (R21)', () => {
  const Gate = defineTag('sysgate');
  expect(() => defineSystem({ name: 'all-negative', query: [Not(Gate)], run: () => {} })).toThrow(
    /positive/,
  );
});
