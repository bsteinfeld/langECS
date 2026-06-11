// retry: counts SystemError records per failing system, backs off, re-fires
// via ctx.invalidate, and relies on the engine auto-clear (R32) on success.

import { createWorld, defineComponent, defineSystem, SystemError } from '@langecs/core';
import { expect, test } from 'vitest';
import { RetryPolicy, retry } from '../src/index';

test('retry re-fires a failing system with exponential backoff until it succeeds', async () => {
  const Job = defineComponent<string>({ name: 'retryJob' });
  const Output = defineComponent<string>({ name: 'retryOutput' });
  let attempts = 0;
  const timestamps: number[] = [];
  const flaky = defineSystem({
    name: 'flaky',
    query: [Job],
    run: (e) => {
      timestamps.push(Date.now());
      attempts += 1;
      if (attempts < 3) throw new Error(`boom ${attempts}`);
      e.set(Output, `processed ${e.get(Job)}`);
    },
  });

  const world = createWorld();
  world.use(flaky);
  world.use(retry);
  const e = world.spawn(Job('task'), RetryPolicy({ max: 3, baseMs: 20 }));

  const result = await world.run();
  // fail, retry, fail, retry, succeed
  expect(result.steps).toBe(5);
  expect(result.status).toBe('done');
  expect(result.errors).toEqual([]);
  expect(attempts).toBe(3);
  expect(e.get(Output)).toBe('processed task');
  // Engine auto-clear removed flaky's records once it succeeded (R32).
  expect(e.has(SystemError)).toBe(false);

  // Exponential backoff: ~20ms before attempt 2, ~40ms before attempt 3.
  expect(timestamps).toHaveLength(3);
  expect((timestamps[1] ?? 0) - (timestamps[0] ?? 0)).toBeGreaterThanOrEqual(15);
  expect((timestamps[2] ?? 0) - (timestamps[1] ?? 0)).toBeGreaterThanOrEqual(35);
});

test('retry gives up after max retries, leaving the run quiescent with status error', async () => {
  const Task = defineComponent<number>({ name: 'retryDoomedTask' });
  let attempts = 0;
  const doomed = defineSystem({
    name: 'doomed',
    query: [Task],
    run: () => {
      attempts += 1;
      throw new Error('always fails');
    },
  });

  const world = createWorld();
  world.use(doomed);
  world.use(retry);
  const e = world.spawn(Task(1), RetryPolicy({ max: 2, baseMs: 1 }));

  const result = await world.run();
  expect(result.status).toBe('error');
  expect(attempts).toBe(3); // initial + 2 retries
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.entity).toBe(e.id);
  const records = result.errors[0]?.records ?? [];
  expect(records).toHaveLength(3);
  expect(records.every((r) => r.system === 'doomed')).toBe(true);
  expect(records.map((r) => r.error.message)).toEqual([
    'always fails',
    'always fails',
    'always fails',
  ]);

  // A later run schedules nothing: retry consumed its dirt when it gave up.
  const again = await world.run();
  expect(again.status).toBe('idle');
});

test('retry only re-fires the failing system, not healthy siblings', async () => {
  const Work = defineComponent<number>({ name: 'retrySiblingWork' });
  const Log = defineComponent<string[]>({
    name: 'retrySiblingLog',
    reducer: (a, b) => [...a, ...b],
  });
  let badRuns = 0;
  let goodRuns = 0;
  const bad = defineSystem({
    name: 'badWorker',
    query: [Work],
    run: () => {
      badRuns += 1;
      if (badRuns === 1) throw new Error('first try fails');
    },
  });
  const good = defineSystem({
    name: 'goodWorker',
    query: [Work],
    run: (e, ctx) => {
      goodRuns += 1;
      ctx.write(e, Log, ['good ran']);
    },
  });

  const world = createWorld();
  world.use(bad);
  world.use(good);
  world.use(retry);
  const e = world.spawn(Work(1), RetryPolicy({ max: 5, baseMs: 1 }));

  const result = await world.run();
  expect(result.status).toBe('done');
  expect(badRuns).toBe(2); // failed once, retried once, succeeded
  expect(goodRuns).toBe(1); // never re-fired by the retry of its sibling
  expect(e.get(Log)).toEqual(['good ran']);
  expect(e.has(SystemError)).toBe(false);
});
