import type { ObserverEvent } from '@langecs/core';
import { expect, test } from 'vitest';
import type { RunEventEntry } from '../store';
import { activePairs, bubblesSince } from './liveness';

let seq = 0;
function entry(event: ObserverEvent): RunEventEntry {
  return { seq: ++seq, runId: 'r1', event };
}

const start = (system: string, entity: number): RunEventEntry =>
  entry({ type: 'system:start', step: 1, system, entity });
const end = (system: string, entity: number): RunEventEntry =>
  entry({ type: 'system:end', step: 1, system, entity, ms: 2 });

test('activePairs tracks system:start/end per entity', () => {
  const events = [start('a:think', 1), start('b:act', 1), start('a:think', 2), end('a:think', 1)];
  const active = activePairs(events);
  expect(active.get(1)).toEqual(['b:act']);
  expect(active.get(2)).toEqual(['a:think']);
});

test('system:error also clears the pair; run:end clears everything', () => {
  const errored = [
    start('a:think', 1),
    entry({
      type: 'system:error',
      step: 1,
      system: 'a:think',
      entity: 1,
      error: { name: 'E', message: 'boom' },
    }),
  ];
  expect(activePairs(errored).size).toBe(0);

  const runEnded = [start('a:think', 1), entry({ type: 'run:end', status: 'done', steps: 3 })];
  expect(activePairs(runEnded).size).toBe(0);
});

test('bubblesSince picks assistant chat changes after the cursor', () => {
  const chatChange = entry({
    type: 'step:applied',
    step: 2,
    changes: [
      {
        entity: 7,
        component: 'Chat',
        kind: 'set',
        value: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello! 👋' },
        ],
      },
      { entity: 8, component: 'Score', kind: 'set', value: 1 },
    ],
    spawned: [],
    despawned: [],
  });
  const bubbles = bubblesSince([chatChange], 0);
  expect(bubbles).toEqual([{ seq: chatChange.seq, entity: 7, text: 'Hello! 👋', tool: false }]);
  // cursor: nothing new at-or-before afterSeq
  expect(bubblesSince([chatChange], chatChange.seq)).toEqual([]);
});

test('bubblesSince flags tool calls, truncates, and skips non-assistant tails', () => {
  const longText = 'x'.repeat(120);
  const events = [
    entry({
      type: 'step:applied',
      step: 3,
      changes: [
        {
          entity: 1,
          component: 'Messages',
          kind: 'merge',
          value: [{ role: 'assistant', content: longText, toolCalls: [{ name: 'search' }] }],
        },
        { entity: 2, component: 'Messages', kind: 'set', value: [{ role: 'user', content: 'q' }] },
        { entity: 3, component: 'Messages', kind: 'remove' },
      ],
      spawned: [],
      despawned: [],
    }),
  ];
  const bubbles = bubblesSince(events, 0);
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]?.entity).toBe(1);
  expect(bubbles[0]?.tool).toBe(true);
  expect(bubbles[0]?.text.length).toBeLessThanOrEqual(80);
  expect(bubbles[0]?.text.endsWith('…')).toBe(true);
});
