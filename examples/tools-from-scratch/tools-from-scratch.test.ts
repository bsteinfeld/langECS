// Deterministic choreography test: core scriptedModel only, zero network.
// Proves the hand-built loop alternates think -> act -> think -> act -> think
// purely from the dirty-trigger rules — agent.ts contains no loop construct.

import { createWorld, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  ChatModel,
  Convo,
  calculate,
  convertUnits,
  NeedsReply,
  spawnMathAgent,
  ToolQueue,
} from './agent';

const QUESTION = 'A marathon is 26.2 miles. How many kilometers do 4 marathons cover?';

test('hand-built loop: think -> act -> think -> act -> think, then quiescence', async () => {
  const world = createWorld();
  world.register(
    ChatModel,
    scriptedModel([
      // Turn 1: chain step one — convert miles to kilometers.
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'convert_units',
            args: { value: 26.2, from: 'miles', to: 'kilometers' },
          },
        ],
      },
      // Turn 2: the request must already contain call-1's result — the second
      // tool call chains on the number act wrote into the transcript.
      (req) => {
        expect(req.messages.at(-1)).toMatchObject({
          role: 'tool',
          toolCallId: 'call-1',
          name: 'convert_units',
        });
        return {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'calculator', args: { expression: '42.1648128 * 4' } }],
        };
      },
      // Turn 3: a plain answer — think removes NeedsReply and the world quiesces.
      { role: 'assistant', content: 'Four marathons cover about 168.66 kilometers.' },
    ]),
  );
  const agent = spawnMathAgent(world);

  const result = await world.send(
    agent,
    Convo([{ role: 'user', content: QUESTION }]),
    NeedsReply(),
  );
  expect(result.status).toBe('done');
  expect(result.steps).toBe(5);

  // The choreography, straight from the flight recorder. Note what is ABSENT:
  // steps 2 and 4 run act alone — think's own Convo append never re-fired it
  // (self-write exclusion, R26.1); act's appends are foreign and did (R27).
  const trace = world.getTrace();
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['think'],
    ['act'],
    ['think'],
    ['act'],
    ['think'],
  ]);

  // The transcript interleaves: user -> tool round 1 -> tool round 2 -> answer.
  const convo = agent.get(Convo) ?? [];
  expect(convo.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
    'tool',
    'assistant',
  ]);
  // The inline tools really executed: 26.2 mi = 42.1648128 km; x4 = 168.6592512.
  expect(convo[2]?.content).toBe('26.2 miles = 42.1648128 kilometers');
  expect(convo[4]?.content).toBe('168.6592512');
  expect(convo.at(-1)?.content).toContain('168.66');

  // Both trigger components were consumed: nothing left for either system.
  expect(agent.has(NeedsReply)).toBe(false);
  expect(agent.has(ToolQueue)).toBe(false);
});

test('the inline tools are real implementations', () => {
  expect(calculate('42.1648128 * 4')).toBe(168.6592512);
  expect(calculate('2 + 3 * 4')).toBe(14);
  expect(calculate('10 / 4 - 1')).toBe(1.5);
  expect(() => calculate('two plus two')).toThrow(/calculator/);
  expect(convertUnits(26.2, 'miles', 'kilometers')).toBe(42.1648128);
  expect(() => convertUnits(1, 'miles', 'liters')).toThrow(/convert_units/);
});
