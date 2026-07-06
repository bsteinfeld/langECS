import { expect, test } from 'vitest';
import type { EntityState } from '../../../src/protocol';
import { classifyEntity, displayName, spatialPosition, statusLine } from './zones';

/** Minimal EntityState builder for tests. */
function entity(
  id: number,
  components: { name: string; value?: unknown; tag?: boolean }[],
  agents: string[] = [],
): EntityState {
  return {
    id,
    agents,
    components: components.map((c) => ({
      name: c.name,
      value: c.value ?? true,
      tag: c.tag ?? false,
      reducer: false,
      transient: false,
    })),
  };
}

const chat = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'Hello! 👋' },
];

test('classifyEntity: eval:* components win', () => {
  expect(classifyEntity(entity(1, [{ name: 'eval:Score', value: 1 }]))).toBe('evals');
  // eval prefix beats an agent-looking transcript on the same entity
  expect(
    classifyEntity(
      entity(2, [
        { name: 'eval:EvalInput', value: 'q' },
        { name: 'Messages', value: chat },
      ]),
    ),
  ).toBe('evals');
});

test('classifyEntity: bench:* components', () => {
  expect(
    classifyEntity(entity(3, [{ name: 'bench:ComparisonReport', value: { candidates: [] } }])),
  ).toBe('bench');
});

test('classifyEntity: agents via server-derived agent tags or a non-empty transcript', () => {
  expect(classifyEntity(entity(4, [{ name: 'Whatever', value: 1 }], ['researcher']))).toBe(
    'agents',
  );
  expect(classifyEntity(entity(5, [{ name: 'Chat', value: chat }]))).toBe('agents');
  // an empty array is transcript-shaped but is no evidence of agency
  expect(classifyEntity(entity(6, [{ name: 'Chat', value: [] }]))).toBe('other');
});

test('classifyEntity: everything else is other', () => {
  expect(classifyEntity(entity(7, [{ name: 'Position', value: { x: 0, y: 0 } }]))).toBe('other');
  expect(classifyEntity(entity(8, []))).toBe('other');
});

test('displayName: Name component, then first agent, then #id', () => {
  expect(displayName(entity(1, [{ name: 'Name', value: 'Alice' }]))).toBe('Alice');
  expect(displayName(entity(2, [{ name: 'Name', value: 42 }], ['support']))).toBe('support');
  expect(displayName(entity(3, []))).toBe('#3');
});

test('spatialPosition: first alphabetical component with numeric x/y, else null', () => {
  const spatial = entity(1, [
    { name: 'Zed', value: { x: 9, y: 9 } },
    { name: 'Position', value: { x: 5, y: 3 } },
  ]);
  expect(spatialPosition(spatial)).toEqual({ x: 5, y: 3 });
  expect(spatialPosition(entity(2, [{ name: 'Health', value: { hp: 1, max: 2 } }]))).toBeNull();
  expect(spatialPosition(entity(3, [{ name: 'P', value: { x: '5', y: 3 } }]))).toBeNull();
});

test('statusLine: running system wins, then flags, then domain lines', () => {
  const idle = entity(1, [{ name: 'Chat', value: chat }]);
  expect(statusLine(idle, ['tour:reply'])).toBe('⚙ tour:reply running…');
  expect(statusLine(entity(2, [{ name: 'AwaitingHuman', value: [], tag: false }]), [])).toBe(
    '✋ awaiting human',
  );
  expect(statusLine(entity(3, [{ name: 'SystemError', value: [] }]), [])).toBe('⚠ error');
  expect(
    statusLine(
      entity(4, [
        { name: 'eval:Score', value: 1 },
        { name: 'eval:Verdict', value: 'pass' },
      ]),
      [],
    ),
  ).toBe('score 1 · pass');
  expect(
    statusLine(
      entity(5, [{ name: 'bench:ComparisonReport', value: { candidates: [{}, {}] } }]),
      [],
    ),
  ).toBe('2 candidates');
  expect(statusLine(idle, [])).toBe('✓ replied');
  const waiting = entity(6, [{ name: 'Chat', value: [{ role: 'user', content: 'hi' }] }]);
  expect(statusLine(waiting, [])).toBe('… awaiting reply');
  expect(statusLine(entity(7, [{ name: 'Position', value: { x: 0, y: 0 } }]), [])).toBeNull();
});
