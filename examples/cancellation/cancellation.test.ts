// Deterministic cancellation + timeout choreography. Zero network: every model
// turn comes from core's scriptedModel, and the "hung source" is an
// interruptible delay rather than a real socket.
//
// The timing is deliberate, not lucky. `world.run()` runs its synchronous
// prefix — candidate selection, guards, `system:start` — before it returns, so
// a system that awaits is already parked by the time the next line executes.
// That makes "cancel while calls are in flight" reproduce every time.

import { Cancelled, SystemError, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { buildWorld, Job, Notes, report, spawnJobs } from './pipeline';

const TOPICS = [
  { topic: 'ECS scheduling', source: 'fast' as const },
  { topic: 'dirty tracking', source: 'fast' as const },
];

const reply = (text: string) => ({ role: 'assistant' as const, content: text });

/** Short deadline for scripted models. `main.ts` uses seconds for a live provider. */
const TIMEOUT_MS = 250;

test('cancel mid-flight: in-flight work is dropped and the run reports cancelled', async () => {
  const world = buildWorld({
    // Slow enough that both jobs are still in flight when we cancel.
    model: scriptedModel([reply('notes A'), reply('notes B')], { delayMs: 60_000 }),
    timeoutMs: TIMEOUT_MS,
  });
  const jobs = spawnJobs(world, TOPICS);

  const run = world.run();
  // Both research pairs are parked inside model.generate right now (R53).
  expect(world.runningPairs().map((p) => p.system)).toEqual(['research', 'research']);
  expect(world.runningPairs().every((p) => p.timeoutMs === 250)).toBe(true);

  world.cancel('operator pressed stop');
  const result = await run;

  expect(result.status).toBe('cancelled');
  // Nothing landed: each pair's buffer was discarded when its aborted call threw.
  for (const job of jobs) expect(world.entity(job.id)?.has(Notes)).toBe(false);
  // Cancellation is not failure, so there is nothing for `retry` to re-arm —
  // otherwise the batch would restart itself the moment it was stopped.
  expect(result.errors).toEqual([]);
  for (const job of jobs) expect(world.entity(job.id)?.has(SystemError)).toBe(false);
  expect(world.entity(jobs[0]?.id ?? 0)?.get(Cancelled)).toMatchObject({
    reason: 'operator pressed stop',
  });
});

test('a cancel preserves the work that had already finished', async () => {
  // The first job answers immediately; the second is still in flight.
  const slow = async () => {
    await new Promise<void>(() => {}); // never settles
    return reply('never arrives');
  };
  const world = buildWorld({
    model: scriptedModel([reply('fast notes'), slow]),
    timeoutMs: TIMEOUT_MS,
  });
  const jobs = spawnJobs(world, TOPICS);

  // Step 1: both pairs run concurrently. The first commits; the second is
  // abandoned at its 250ms deadline, so the barrier commits without it.
  const first = await world.run();
  expect(first.status).toBe('error');
  expect(world.entity(jobs[0]?.id ?? 0)?.get(Notes)).toBe('fast notes');
  expect(world.entity(jobs[1]?.id ?? 0)?.get(SystemError)?.[0]?.error.name).toBe(
    'SystemTimeoutError',
  );

  // Stop the batch rather than let retry keep trying.
  world.cancel('good enough');
  expect((await world.run()).status).toBe('cancelled');

  // Partial results are ordinary state, so they simply survive.
  expect(report(world)).toEqual([
    { topic: 'ECS scheduling', status: 'researched', notes: 'fast notes' },
    { topic: 'dirty tracking', status: 'cancelled' },
  ]);
});

test('a hung source times out, and retry heals it because a timeout is a normal error', async () => {
  const world = buildWorld({
    model: scriptedModel([reply('fast notes'), reply('recovered notes')]),
    timeoutMs: TIMEOUT_MS,
  });
  const jobs = spawnJobs(world, [
    { topic: 'ECS scheduling', source: 'fast' },
    { topic: 'flaky source', source: 'flaky' },
  ]);
  const hung = jobs[1]?.id ?? 0;

  const result = await world.run();

  // Exactly one pair was abandoned at its deadline, and it was the flaky one.
  const timedOut = world
    .getTrace()
    .flatMap((s) => s.runs)
    .filter((r) => r.error?.name === 'SystemTimeoutError');
  expect(timedOut).toHaveLength(1);
  expect(timedOut[0]?.entity).toBe(hung);

  // `retry` re-armed the pair; the retried attempt succeeded, and R32 cleared
  // the record — the same healing path as any other failure.
  expect(world.entity(hung)?.has(SystemError)).toBe(false);
  expect(world.entity(hung)?.get(Notes)).toBe('recovered notes');
  expect(result.status).toBe('done');
  expect(report(world).map((r) => r.status)).toEqual(['researched', 'researched']);
});

test('the hung source unblocks immediately on cancel, without waiting for its deadline', async () => {
  const world = buildWorld({ model: scriptedModel([reply('unused')]), timeoutMs: TIMEOUT_MS });
  const jobs = spawnJobs(world, [{ topic: 'flaky source', source: 'flaky' }]);

  const started = Date.now();
  const run = world.run();
  world.cancel('stop');
  const result = await run;

  expect(result.status).toBe('cancelled');
  // It honoured ctx.signal, so it came back well inside its 250ms deadline:
  // the cooperative path, not the timeout path.
  expect(Date.now() - started).toBeLessThan(200);
  expect(world.entity(jobs[0]?.id ?? 0)?.has(SystemError)).toBe(false);
});

test('cancellation survives a snapshot, and removing the component un-cancels', async () => {
  const world = buildWorld({
    model: scriptedModel([reply('a'), reply('b')], { delayMs: 60_000 }),
    timeoutMs: TIMEOUT_MS,
  });
  const jobs = spawnJobs(world, TOPICS);
  const run = world.run();
  world.cancel('stop before restart');
  await run;

  // No persistence work of its own: Cancelled is ordinary component data, so it
  // is in the snapshot like everything else.
  const snapshot = world.snapshot();
  const reloaded = buildWorld({
    model: scriptedModel([reply('a'), reply('b')]),
    timeoutMs: TIMEOUT_MS,
  });
  reloaded.load(snapshot);

  expect(reloaded.entity(jobs[0]?.id ?? 0)?.get(Cancelled)).toMatchObject({
    reason: 'stop before restart',
  });
  expect((await reloaded.run()).status).toBe('cancelled');

  // Un-cancelling is just removing the component — no engine API, no flag.
  for (const job of reloaded.query(Job)) job.remove(Cancelled);
  expect((await reloaded.run()).status).toBe('done');
  expect(reloaded.entity(jobs[0]?.id ?? 0)?.get(Notes)).toBe('a');
  expect(report(reloaded).map((r) => r.status)).toEqual(['researched', 'researched']);
});
