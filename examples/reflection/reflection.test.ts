// Deterministic choreography test — core scriptedModel only, zero network.
// Asserts the alternating writer<->critic cycle straight from the flight
// recorder, exactly 2 critique rounds / 2 revisions, then quiescence ended by
// removal of the `Reflecting` tag (the cleanest dirty-triggering demo).

import {
  createWorld,
  type ModelRequest,
  type Msg,
  type RunEvent,
  scriptedModel,
} from '@langecs/core';
import { Messages, userMessage } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import {
  APPROVAL,
  authorOf,
  CRITIC_PROMPT,
  MaxCritiques,
  MODEL_RESOURCE,
  Reflecting,
  reflection,
  WRITER_PROMPT,
} from './agent';

const turn =
  (requests: ModelRequest[], content: string) =>
  (req: ModelRequest): Msg => {
    requests.push(req);
    return { role: 'assistant', content };
  };

test('writer<->critic alternation: 2 critique rounds, 2 revisions, then quiescence by tag removal', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([
    turn(requests, 'draft v1'),
    turn(requests, 'critique #1: add depth'),
    turn(requests, 'draft v2'),
    turn(requests, 'critique #2: tighten the prose'),
    turn(requests, 'draft v3'),
  ]);

  const world = createWorld({ id: 'reflection-test' });
  world.register(MODEL_RESOURCE, model);
  const blackboard = world.spawn(reflection); // bundle default: MaxCritiques(2)

  const result = await world.send(
    blackboard,
    Messages([userMessage('Essay on The Little Prince')]),
  );
  expect(result.status).toBe('done');
  expect(result.steps).toBe(6);

  // --- the alternating cycle, asserted from the flight recorder ---
  const trace = world.getTrace();
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['reflection:writer'], // draft
    ['reflection:critic'], // critique round 1
    ['reflection:writer'], // revision 1
    ['reflection:critic'], // critique round 2
    ['reflection:writer'], // revision 2
    ['reflection:critic'], // approval — no model call, removes Reflecting
  ]);

  // Step 1: the external task append scheduled BOTH systems; the critic vetoed
  // (nothing to review yet), which consumed its dirt (R26) — visible in trace.
  expect(trace[0]?.scheduled).toEqual([
    { system: 'reflection:writer', entity: blackboard.id },
    { system: 'reflection:critic', entity: blackboard.id },
  ]);
  expect(trace[0]?.vetoed).toEqual([{ system: 'reflection:critic', entity: blackboard.id }]);

  // Every later step fires exactly one system with no vetoes: self-write
  // exclusion keeps each system from re-triggering on its own append, so only
  // the peer's foreign append wakes the other — pure dirty-tracking, no router.
  for (const step of trace.slice(1)) {
    expect(step.runs).toHaveLength(1);
    expect(step.vetoed).toEqual([]);
  }

  // Step 6 ends the loop by component removal, not by a conditional edge.
  expect(trace[5]?.applied).toContainEqual({
    entity: blackboard.id,
    component: Reflecting.componentName,
    kind: 'remove',
  });
  expect(blackboard.has(Reflecting)).toBe(false);

  // --- transcript accumulated on the shared blackboard via the Messages reducer ---
  const transcript = blackboard.get(Messages) ?? [];
  expect(transcript.map((m) => authorOf(m))).toEqual([
    'user',
    'writer',
    'critic',
    'writer',
    'critic',
    'writer',
    'critic',
  ]);
  expect(transcript.map((m) => m.content)).toEqual([
    'Essay on The Little Prince',
    'draft v1',
    'critique #1: add depth',
    'draft v2',
    'critique #2: tighten the prose',
    'draft v3',
    APPROVAL,
  ]);
  // Exactly 2 revisions after the initial draft; the verdict is marked approved.
  expect(transcript.filter((m) => authorOf(m) === 'writer')).toHaveLength(3);
  expect(transcript.at(-1)?.meta).toMatchObject({ author: 'critic', approved: true });

  // --- what each of the 5 model calls saw (approval is code, not a call) ---
  expect(requests).toHaveLength(5);
  expect(requests.map((r) => r.system)).toEqual([
    WRITER_PROMPT,
    CRITIC_PROMPT,
    WRITER_PROMPT,
    CRITIC_PROMPT,
    WRITER_PROMPT,
  ]);
  // The writer sees the transcript as-is; the critic sees roles flipped
  // (drafts as 'user' submissions, its own critiques as 'assistant') — the
  // same translation as the LangGraph original.
  expect(requests[2]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(requests[3]?.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);

  // --- quiescence: with the tag gone nothing matches; a fresh run is a no-op ---
  const again = await world.run();
  expect(again.status).toBe('idle');
  expect(again.steps).toBe(0);
  expect(world.getTrace()).toHaveLength(6); // no further steps were even attempted
});

test('MaxCritiques is data: a spawn-time override shortens the loop; tokens stream per author', async () => {
  const world = createWorld({ id: 'reflection-short' });
  world.register(
    MODEL_RESOURCE,
    scriptedModel([
      { role: 'assistant', content: 'only draft' },
      { role: 'assistant', content: 'single critique' },
      { role: 'assistant', content: 'final revision' },
    ]),
  );
  // Spawn-time init overrides the bundle's MaxCritiques(2) (R34).
  const blackboard = world.spawn(reflection, MaxCritiques(1));

  const run = world.send(blackboard, Messages([userMessage('a haiku about dirt')]));
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run;

  expect(result.status).toBe('done');
  expect(result.steps).toBe(4); // draft, critique, revision, approval
  expect(world.getTrace().map((s) => s.runs.map((r) => r.system))).toEqual([
    ['reflection:writer'],
    ['reflection:critic'],
    ['reflection:writer'],
    ['reflection:critic'],
  ]);

  const transcript = blackboard.get(Messages) ?? [];
  expect(transcript.map((m) => authorOf(m))).toEqual([
    'user',
    'writer',
    'critic',
    'writer',
    'critic',
  ]);
  expect(transcript.at(-1)?.content).toBe(APPROVAL);
  expect(blackboard.has(Reflecting)).toBe(false);

  // Both authors streamed live token events mid-step (scriptedModel chunks).
  const tokens = events.filter(
    (e): e is Extract<RunEvent, { type: 'custom' }> => e.type === 'custom',
  );
  expect(tokens.length).toBeGreaterThan(2);
  const byAuthor = new Set(tokens.map((e) => (e.data as { author: string }).author));
  expect(byAuthor).toEqual(new Set(['writer', 'critic']));
  const writerText = tokens
    .filter((e) => (e.data as { author: string }).author === 'writer' && e.step === 1)
    .map((e) => (e.data as { text: string }).text)
    .join('');
  expect(writerText).toBe('only draft');
});
