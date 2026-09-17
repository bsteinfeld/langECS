// retry hardening (T70/T71): two reproduced defects in the one stdlib system
// that reads engine state as data and writes engine scheduling back.

import {
  Cancelled,
  createWorld,
  defineComponent,
  defineSystem,
  type ErrorRecord,
  SystemError,
} from '@langecs/core';
import { expect, test } from 'vitest';
import { RetryPolicy, retry } from '../src/index';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

const ghostRecord = (system: string): ErrorRecord => ({
  system,
  step: 3,
  error: { name: 'Error', message: 'old failure' },
});

// ---------------------------------------------------------------------- T70

test('T70 a SystemError naming a system this build lacks does not reject the run', async () => {
  const world = createWorld();
  world.use(retry);
  const e = world.spawn(
    RetryPolicy({ max: 3, baseMs: 0 }),
    SystemError([ghostRecord('retryHardening.removedInThisDeploy')]),
  );

  // `ctx.invalidate` with an unresolvable name rejects the whole run (R24), and
  // a snapshot written before a system was renamed or removed carries exactly
  // such names — the deploy-survival case SPEC §16 exists for.
  const result = await world.run();
  expect(result.status).toBe('error');
  // The record is left in place: unretryable is not the same as healed.
  expect(e.get(SystemError)?.map((r) => r.system)).toEqual(['retryHardening.removedInThisDeploy']);
});

test('T70 a live system alongside an unknown one is still retried', async () => {
  const Job = defineComponent<string>({ name: 'retryHardening.job' });
  let attempts = 0;
  const flaky = defineSystem({
    name: 'retryHardening.flaky1',
    query: [Job],
    run: (e) => {
      attempts += 1;
      if (attempts < 2) throw new Error('boom');
      e.set(Job, 'healed');
    },
  });
  const world = createWorld();
  world.use(flaky);
  world.use(retry);
  const e = world.spawn(
    Job('task'),
    RetryPolicy({ max: 3, baseMs: 0 }),
    SystemError([ghostRecord('retryHardening.alsoGone')]),
  );

  const result = await world.run();
  expect(attempts).toBe(2);
  expect(e.get(Job)).toBe('healed');
  // The ghost survives (nothing can clear it), the live failure was healed.
  expect(result.status).toBe('error');
  expect(e.get(SystemError)?.map((r) => r.system)).toEqual(['retryHardening.alsoGone']);
});

// ---------------------------------------------------------------------- T71

test('T71 cancel interrupts the retry backoff and re-arms nothing (R50/R51)', async () => {
  const Job = defineComponent<string>({ name: 'retryHardening.job2' });
  const flaky = defineSystem({
    name: 'retryHardening.flaky2',
    query: [Job],
    run: () => {
      throw new Error('nope');
    },
  });
  const world = createWorld();
  world.use(retry);
  world.use(flaky);
  const e = world.spawn(Job('task'), RetryPolicy({ max: 3, baseMs: 1000 }));

  const started = Date.now();
  const run = world.run(); // step 1: flaky throws; step 2: retry backs off 1000ms
  await sleep(60);
  world.cancel('stop');
  const result = await run;
  const elapsed = Date.now() - started;

  // A bare setTimeout ignored ctx.signal, so the operator's stop waited out the
  // whole backoff (R51: systems forward the signal to every awaited call).
  expect(elapsed).toBeLessThan(500);
  expect(result.status).toBe('cancelled');
  expect(e.get(Cancelled)?.reason).toBe('stop');
  // Failing by the signal's own abort value gives the pair cancellation
  // identity: no ErrorRecord for `retry` itself (R31)…
  expect(e.get(SystemError)?.map((r) => r.system)).toEqual(['retryHardening.flaky2']);
  // …and no invalidate committed, so the cancelled work is not re-armed (R50).
  const pending = world.snapshot().pendingPairs;
  expect(pending.some((p) => p.system === 'retryHardening.flaky2')).toBe(false);
});
