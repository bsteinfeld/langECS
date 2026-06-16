// Deterministic RAG choreography: decompose → parallel retrieve → synthesize.
// scriptedModel + an in-memory retriever — zero network. Asserts the fan-out/
// fan-in schedule from the flight recorder.

import { createWorld, type RunEvent, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  Answer,
  type Passage,
  QaModel,
  Question,
  Retrieved,
  RetrieverRef,
  useRagPipeline,
} from './pipeline';

// A fixed per-query lookup keeps the choreography assertions deterministic.
const RESULTS: Record<string, Passage[]> = {
  'hummingbird flight': [{ source: 'flight', text: 'Hummingbirds hover and fly backwards.' }],
  'hummingbird diet': [{ source: 'diet', text: 'Hummingbirds feed on nectar and insects.' }],
};

function retriever(query: string): Passage[] {
  return RESULTS[query] ?? [];
}

async function collect(run: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const e of run) events.push(e);
  return events;
}

test('decomposes, retrieves in parallel, and synthesizes a grounded answer', async () => {
  const world = createWorld({ id: 'rag-test' });
  world.register(
    QaModel,
    scriptedModel([
      // 1) decompose -> two sub-queries
      { role: 'assistant', content: '{"queries":["hummingbird flight","hummingbird diet"]}' },
      // 2) synthesize -> grounded answer
      { role: 'assistant', content: 'Hummingbirds hover [flight] and eat nectar [diet].' },
    ]),
  );
  world.register(RetrieverRef, retriever);
  useRagPipeline(world);

  const task = world.spawn(Question('How do hummingbirds fly and eat?'));
  const run = world.run();
  const events = await collect(run);
  const result = await run;

  expect(result.status).toBe('done');

  const trace = world.getTrace();
  // Step 1: only decompose runs; it spawns two retrieval entities.
  expect(trace[0]?.runs.map((r) => r.system)).toEqual(['decompose']);
  expect(trace[0]?.spawned).toHaveLength(2);

  // Step 2: BOTH retrievers run in the SAME step — parallel fan-out.
  expect(trace[1]?.runs.map((r) => r.system)).toEqual(['retrieve', 'retrieve']);
  // Their passages merged into the parent's Retrieved via the append reducer.
  const retrievedWrites = trace[1]?.applied.filter(
    (c) => c.component === 'ragRetrieved' && c.entity === task.id,
  );
  expect(retrievedWrites?.length).toBe(2);
  // The two retrieval entities despawned themselves after reporting.
  expect(trace[1]?.despawned).toHaveLength(2);

  // Step 3: synthesize composes the answer once both reports are in.
  expect(trace[2]?.runs.map((r) => r.system)).toEqual(['synthesize']);

  // Both sub-queries were narrated, and the answer is grounded + cited.
  const subqueries = events
    .filter((e): e is Extract<RunEvent, { type: 'custom' }> => e.type === 'custom')
    .map((e) => e.data as { kind?: string })
    .filter((d) => d.kind === 'subquery');
  expect(subqueries).toHaveLength(2);

  const answer = world.entity(task.id)?.get(Answer) ?? '';
  expect(answer).toContain('[flight]');
  expect(answer).toContain('[diet]');
  // The full passage set fanned in (flight + diet; the bee passage never matched).
  expect(
    world
      .entity(task.id)
      ?.get(Retrieved)
      ?.map((p) => p.source)
      .sort(),
  ).toEqual(['diet', 'flight']);
});
