// Deterministic choreography tests for the multi-agent supervisor example.
// Core scriptedModel only — zero network. Asserts the step-by-step flow via
// the flight recorder (world trace) and the live event stream:
//   1. one routing call fans out to BOTH workers in the SAME step (parallel),
//      with the writer agent spawned dynamically by the supervisor;
//   2. worker results fan in through the Inbox reducer and are aggregated;
//   3. a scripted worker crash lands as SystemError, the heal path re-arms the
//      pair, the retry succeeds, and aggregation still completes.

import {
  createWorld,
  type ModelRequest,
  type Msg,
  type RunEvent,
  SystemError,
  scriptedModel,
} from '@langecs/core';
import { Inbox, lastAssistant, Messages, MessageWaiting } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import { spawnTeam, Task, writer } from './agents';

const ROUTING_JSON =
  '{"researcher": "Dig up three facts about hummingbirds.", ' +
  '"writer": "Write a two-line poem about hummingbirds."}';

/** Scripted turn that also captures the request the model saw. */
const capture =
  (into: ModelRequest[], message: Msg) =>
  (req: ModelRequest): Msg => {
    into.push(req);
    return message;
  };

async function collectEvents(run: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const customData = (events: RunEvent[]): Record<string, unknown>[] =>
  events
    .filter((e): e is Extract<RunEvent, { type: 'custom' }> => e.type === 'custom')
    .map((e) => e.data as Record<string, unknown>);

test('supervisor fans out to both workers in one step, aggregates, and answers', async () => {
  const supervisorRequests: ModelRequest[] = [];
  const world = createWorld();
  world.register(
    'model:supervisor',
    scriptedModel([
      capture(supervisorRequests, { role: 'assistant', content: ROUTING_JSON }),
      capture(supervisorRequests, {
        role: 'assistant',
        content: 'FINAL: hummingbird facts, wrapped in a poem.',
      }),
    ]),
  );
  world.register(
    'model:researcher',
    scriptedModel([{ role: 'assistant', content: 'RESEARCH_FINDINGS: hummingbirds can hover.' }]),
  );
  world.register(
    'model:writer',
    scriptedModel([{ role: 'assistant', content: 'WRITER_DRAFT: tiny wings hum.' }]),
  );

  const team = spawnTeam(world);
  const run = sendMessageRun(world, team.supervisor.id, 'Tell me about hummingbirds, with a poem.');
  const result = await run;
  expect(result.status).toBe('done');
  expect(result.steps).toBe(3);
  expect(result.errors).toEqual([]);

  const trace = world.getTrace();
  expect(trace).toHaveLength(3);

  // Step 1: only the routing system fires (external Messages+MessageWaiting dirt).
  expect(trace[0]?.runs.map((r) => r.system)).toEqual(['supervisor:plan']);
  // Dynamic spawning: the writer agent was created mid-run BY the supervisor.
  const writerId = trace[0]?.spawned[0];
  expect(writerId).toBeDefined();
  expect(trace[0]?.spawnedBy).toEqual([
    { entity: writerId, system: 'supervisor:plan', parent: team.supervisor.id },
  ]);
  expect(world.entity(writerId as number)?.has(writer.tag)).toBe(true);

  // Step 2: BOTH workers executed in the SAME step — parallel fan-out.
  expect(trace[1]?.runs.map((r) => r.system).sort()).toEqual(['researcher:work', 'writer:work']);
  expect(trace[1]?.runs.every((r) => r.error === undefined)).toBe(true);
  // The aggregator was woken by the same barrier but vetoed (0 of 2 results yet).
  expect(trace[1]?.vetoed).toEqual([
    { system: 'supervisor:aggregate', entity: team.supervisor.id },
  ]);
  // Fan-in: both workers appended to the supervisor's Inbox in one barrier;
  // the append reducer merged them instead of conflicting.
  const inboxChanges = trace[1]?.applied.filter(
    (c) => c.component === 'Inbox' && c.entity === team.supervisor.id,
  );
  expect(inboxChanges).toHaveLength(2);
  expect(inboxChanges?.every((c) => c.kind === 'merge')).toBe(true);

  // Step 3: results aggregated into the final answer.
  expect(trace[2]?.runs.map((r) => r.system)).toEqual(['supervisor:aggregate']);

  // The aggregation model call saw BOTH workers' results.
  expect(supervisorRequests).toHaveLength(2);
  const aggregateInput = supervisorRequests[1]?.messages.at(-1)?.content ?? '';
  expect(aggregateInput).toContain('RESEARCH_FINDINGS: hummingbirds can hover.');
  expect(aggregateInput).toContain('WRITER_DRAFT: tiny wings hum.');

  // Final state: answer delivered, triggers consumed, findings drained.
  const sup = world.entity(team.supervisor.id);
  expect(lastAssistant(world, team.supervisor)?.content).toBe(
    'FINAL: hummingbird facts, wrapped in a poem.',
  );
  expect(sup?.get(Messages)?.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
  expect(sup?.has(MessageWaiting)).toBe(false);
  expect(sup?.get(Inbox)).toEqual([]);
  expect(team.researcher.has(Task)).toBe(false);
  expect(world.entity(writerId as number)?.has(Task)).toBe(false);

  // Dispatch events narrate the routing, including the runtime spawn.
  const dispatches = customData(await collectEvents(run)).filter((d) => d.kind === 'dispatch');
  expect(dispatches).toMatchObject([
    { to: 'researcher', entity: team.researcher.id },
    { to: 'writer', entity: writerId, spawned: true },
  ]);
});

test('a worker crash lands as SystemError, heal re-arms the pair, and the run still completes', async () => {
  const supervisorRequests: ModelRequest[] = [];
  const world = createWorld();
  world.register(
    'model:supervisor',
    scriptedModel([
      capture(supervisorRequests, { role: 'assistant', content: ROUTING_JSON }),
      capture(supervisorRequests, { role: 'assistant', content: 'FINAL: healed and answered.' }),
    ]),
  );
  world.register(
    'model:researcher',
    scriptedModel([{ role: 'assistant', content: 'RESEARCH_FINDINGS: resilient facts.' }]),
  );
  // The writer's model crashes on its first call, then recovers.
  world.register(
    'model:writer',
    scriptedModel([
      () => {
        throw new Error('writer model crashed (scripted)');
      },
      { role: 'assistant', content: 'WRITER_DRAFT: recovered draft.' },
    ]),
  );

  const team = spawnTeam(world);
  const run = sendMessageRun(world, team.supervisor.id, 'Survive a crash, please.');
  const result = await run;
  expect(result.status).toBe('done');
  expect(result.steps).toBe(5);
  expect(result.errors).toEqual([]);

  const trace = world.getTrace();
  expect(trace).toHaveLength(5);
  const writerId = trace[0]?.spawned[0] as number;

  // Step 2: both workers still ran in the same step; the writer failed.
  expect(trace[1]?.runs.map((r) => r.system).sort()).toEqual(['researcher:work', 'writer:work']);
  const failed = trace[1]?.runs.find((r) => r.system === 'writer:work');
  expect(failed?.error?.message).toBe('writer model crashed (scripted)');
  expect(failed?.writes).toEqual([]); // the failed pair's buffer was discarded
  // The researcher's sibling write still committed (its result reached the Inbox).
  expect(
    trace[1]?.applied.some((c) => c.component === 'Inbox' && c.entity === team.supervisor.id),
  ).toBe(true);
  // The crash is visible state: SystemError was appended to the writer entity.
  expect(
    trace[1]?.applied.some((c) => c.component === 'SystemError' && c.entity === writerId),
  ).toBe(true);

  // Step 3: heal matched [SystemError, Task] and re-armed the failing pair;
  // the aggregator woke on the researcher's result but vetoed (1 of 2).
  expect(trace[2]?.runs.map((r) => r.system)).toEqual(['heal']);
  expect(trace[2]?.vetoed).toEqual([
    { system: 'supervisor:aggregate', entity: team.supervisor.id },
  ]);

  // Step 4: the writer pair re-fired via ctx.invalidate and succeeded.
  expect(trace[3]?.runs.map((r) => r.system)).toEqual(['writer:work']);
  expect(trace[3]?.runs[0]?.error).toBeUndefined();

  // Step 5: both results in — aggregation completes the request.
  expect(trace[4]?.runs.map((r) => r.system)).toEqual(['supervisor:aggregate']);
  const aggregateInput = supervisorRequests[1]?.messages.at(-1)?.content ?? '';
  expect(aggregateInput).toContain('RESEARCH_FINDINGS: resilient facts.');
  expect(aggregateInput).toContain('WRITER_DRAFT: recovered draft.');
  expect(lastAssistant(world, team.supervisor)?.content).toBe('FINAL: healed and answered.');

  // The retried success auto-cleared the SystemError record (R32).
  expect(world.entity(writerId)?.has(SystemError)).toBe(false);

  // The healing path narrated itself.
  const heals = customData(await collectEvents(run)).filter((d) => d.kind === 'heal:retry');
  expect(heals).toEqual([
    { kind: 'heal:retry', entity: writerId, system: 'writer:work', attempt: 1 },
  ]);
});

/** stdlib sendMessage, inlined so the test pins the exact trigger components. */
function sendMessageRun(world: ReturnType<typeof createWorld>, supervisorId: number, text: string) {
  return world.send(supervisorId, Messages([{ role: 'user', content: text }]), MessageWaiting());
}
