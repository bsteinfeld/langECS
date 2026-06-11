// Deterministic time-travel choreography test: core scriptedModel only, zero
// network. Drives the same agent module as main.ts, asserts the step-by-step
// system choreography from the flight-recorder trace, then rewinds a fresh
// world to step 1, forks with a different input, and proves the fork shares
// the common prefix while the original timeline stays intact.

import { MemoryAdapter, type Msg, scriptedModel } from '@langecs/core';
import { lastAssistant, Messages, MessageWaiting, sendMessage } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import { buildWorld, forkFromSnapshot, timeTraveler, WORLD_ID } from './agent';

const AGENT = timeTraveler.name; // 'time-traveler' — system keys are `<agent>:<system>`

test('time travel: checkpoint every step, rewind to step 1, fork a divergent timeline', async () => {
  // --- Original timeline: greeting turn + a tool-using weather turn. -------
  const adapter = new MemoryAdapter();
  const world = buildWorld({
    id: WORLD_ID,
    persistence: adapter,
    model: scriptedModel([
      { role: 'assistant', content: 'Hi Jo! How can I help you today?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'search', args: { query: 'weather in SF' } }],
      },
      { role: 'assistant', content: 'It is cold in SF: a low of 13 ℃.' },
    ]),
  });
  const agent = world.spawn(timeTraveler);

  const turn1 = await sendMessage(world, agent, "Hi! I'm Jo.");
  expect(turn1.status).toBe('done');
  expect(turn1.steps).toBe(1);

  const turn2 = await sendMessage(world, agent, "What's the weather like in SF currently?");
  expect(turn2.status).toBe('done');
  expect(turn2.steps).toBe(3); // LLM → tool → LLM, the canonical dirty-trigger cycle

  // Step-by-step choreography from the flight recorder (steps are world-global):
  const trace = world.getTrace();
  expect(trace.map((s) => s.step)).toEqual([1, 2, 3, 4]);
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    [`${AGENT}:callLLM`], // step 1: greeting answered, MessageWaiting removed
    [`${AGENT}:callLLM`], // step 2: weather turn → model requests the search tool
    [`${AGENT}:executeTools`], // step 3: tool runs, result appended as a tool message
    [`${AGENT}:callLLM`], // step 4: foreign Messages dirt re-fires the model → final answer
  ]);
  // toolApproval was scheduled on the same PendingToolCalls dirt but vetoed
  // (no tool needs approval); the veto consumed its dirt.
  expect(trace[2]?.scheduled).toContainEqual({ system: `${AGENT}:toolApproval`, entity: agent.id });
  expect(trace[2]?.vetoed).toEqual([{ system: `${AGENT}:toolApproval`, entity: agent.id }]);

  const originalMessages: Msg[] = agent.get(Messages) ?? [];
  expect(originalMessages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant', // tool call
    'tool',
    'assistant',
  ]);
  expect(originalMessages[4]?.content).toBe('Cold, with a low of 13 ℃');

  // --- history(): one full-JSON checkpoint per step barrier. ---------------
  expect(adapter.history(WORLD_ID).map((h) => h.step)).toEqual([1, 2, 3, 4]);

  // --- Rewind: loadStep(1) into a FRESH world. -----------------------------
  const snapshot = adapter.loadStep(WORLD_ID, 1);
  expect(snapshot).not.toBeNull();
  const fork = forkFromSnapshot({
    id: `${WORLD_ID}-fork`,
    snapshot: snapshot as NonNullable<typeof snapshot>,
    model: scriptedModel([{ role: 'assistant', content: 'Your name is Jo!' }]),
  });
  expect(fork.step).toBe(1);

  // The rewound world is exactly at the step-1 boundary: only the greeting
  // exchange exists, no trigger components, and a bare run() schedules nothing.
  const restored: Msg[] = fork.entity(agent.id)?.get(Messages) ?? [];
  expect(restored).toEqual(originalMessages.slice(0, 2));
  expect(fork.entity(agent.id)?.has(MessageWaiting)).toBe(false);
  expect((await fork.run()).status).toBe('idle');

  // --- Fork with a different user input. -----------------------------------
  const forkRun = await sendMessage(fork, agent.id, 'Never mind the weather — what is my name?');
  expect(forkRun.status).toBe('done');
  expect(forkRun.steps).toBe(1);
  // Fork choreography: the loaded pendingPairs were empty, so its only trace
  // step is the new turn's callLLM (steps continue from the rewind point).
  expect(fork.getTrace().map((s) => [s.step, s.runs.map((r) => r.system)])).toEqual([
    [2, [`${AGENT}:callLLM`]],
  ]);

  // --- Divergence: fork ≠ original final state, common prefix shared. ------
  const forkMessages: Msg[] = fork.entity(agent.id)?.get(Messages) ?? [];
  expect(forkMessages.slice(0, 2)).toEqual(originalMessages.slice(0, 2)); // common prefix
  expect(forkMessages).toHaveLength(4);
  expect(forkMessages[2]?.content).toBe('Never mind the weather — what is my name?');
  expect(forkMessages[2]).not.toEqual(originalMessages[2]); // diverges right after the prefix
  expect(forkMessages).not.toEqual(originalMessages);
  expect(lastAssistant(fork, agent.id)?.content).toBe('Your name is Jo!');

  // --- Original timeline intact: state and history untouched by the fork. --
  expect(agent.get(Messages)).toEqual(originalMessages);
  expect(lastAssistant(world, agent)?.content).toBe('It is cold in SF: a low of 13 ℃.');
  expect(world.step).toBe(4);
  expect(adapter.history(WORLD_ID).map((h) => h.step)).toEqual([1, 2, 3, 4]);
  const finalOriginal = adapter.loadStep(WORLD_ID, 4);
  expect(finalOriginal?.entities).toEqual(world.snapshot().entities);
  expect(fork.snapshot().entities).not.toEqual(world.snapshot().entities);
});
