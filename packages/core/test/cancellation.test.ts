// Cancellation (R50/R51) and per-system timeouts (R52/R53). Deterministic and
// zero-network: every "slow" call is either an interruptible `delay` or a
// promise the test resolves by hand.
//
// The timing here is deliberate, not lucky. `world.run()` executes its
// synchronous prefix — candidate selection, guards, `system:start` — before it
// returns, so a system that awaits is already parked by the time the next line
// of the test runs. That makes "cancel while in flight" reproducible without
// sleeping.

import { expect, test } from 'vitest';
import {
  Cancelled,
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  delay,
  Not,
  SystemError,
  scriptedModel,
  throwIfAborted,
  type World,
} from '../src/index';

const Job = defineComponent<{ label: string }>({ name: 'cancel.Job' });
const Done = defineTag('cancel.Done');
const Mark = defineComponent<string>({ name: 'cancel.Mark' });

/** Honours `ctx.signal` the way a well-behaved system should (R51). */
const slowGuarded = defineSystem({
  name: 'slowGuarded',
  query: [Job, Not(Done), Not(Cancelled)],
  run: async (e, ctx) => {
    await delay(60_000, ctx.signal);
    e.add(Done);
  },
});

test('R50 cancel mid-run: Cancelled is stamped, guarded work never lands, status is cancelled', async () => {
  const world = createWorld();
  world.use(slowGuarded);
  const job = world.spawn(Job({ label: 'a' }));

  const run = world.run();
  world.cancel('operator stopped it');
  const result = await run;

  expect(result.status).toBe('cancelled');
  // The pair's write never committed: its buffer was discarded when the
  // aborted `delay` rejected.
  expect(world.entity(job.id)?.has(Done)).toBe(false);
  expect(world.entity(job.id)?.get(Cancelled)).toMatchObject({ reason: 'operator stopped it' });
  // Cancellation is not failure (R50) — nothing for a retry system to re-arm.
  expect(result.errors).toEqual([]);
  expect(world.entity(job.id)?.has(SystemError)).toBe(false);
});

test('R50 a cancelled run reports cancelled even when a pair also failed for another reason', async () => {
  const boom = defineSystem({
    name: 'boom',
    query: [Job, Not(Cancelled)],
    run: async (_e, ctx) => {
      await delay(60_000, ctx.signal);
    },
  });
  const world = createWorld();
  world.use(boom);
  const job = world.spawn(Job({ label: 'b' }));

  const run = world.run();
  world.cancel();
  const result = await run;

  // Without 'cancelled' outranking 'error', the caller could not tell "I
  // stopped this" from "it broke" — the aborted call itself throws.
  expect(result.status).toBe('cancelled');
  expect(world.entity(job.id)?.has(SystemError)).toBe(false);
  // A reason is optional. `step` is the boundary the stamp LANDED at, not the
  // step that was in flight when `cancel()` was called — the record documents
  // itself that way, and it previously pinned the pre-cancel value.
  // Step 1 committed (the aborted pair recorded nothing), then the cancellation
  // boundary committed as step 2 — it changes state, so it advances the counter.
  expect(world.entity(job.id)?.get(Cancelled)).toEqual({ step: 2 });
  expect(world.step).toBe(2);
});

test('R50 cancel is state: it survives a snapshot round-trip and lifts when removed', async () => {
  const world = createWorld();
  world.use(slowGuarded);
  const job = world.spawn(Job({ label: 'c' }));
  const run = world.run();
  world.cancel('stop');
  await run;

  // Durable for free, because cancellation is an ordinary component.
  const snapshot = world.snapshot();
  const reloaded = createWorld();
  reloaded.use(slowGuarded);
  reloaded.load(snapshot);
  expect(reloaded.entity(job.id)?.get(Cancelled)).toMatchObject({ reason: 'stop' });
  // Still cancelled, so a fresh run does nothing.
  expect((await reloaded.run()).status).toBe('cancelled');

  // Un-cancel by removing the component — no special engine API needed. The
  // guard term matches again, so the work is live: no engine flag to reset, and
  // nothing that could outlive the state it came from.
  expect(reloaded.systemsMatching(job.id).map((s) => s.key)).toEqual([]);
  reloaded.entity(job.id)?.remove(Cancelled);
  expect(reloaded.systemsMatching(job.id).map((s) => s.key)).toEqual(['slowGuarded']);
  const resumed = reloaded.run();
  expect(reloaded.runningPairs().map((p) => p.system)).toEqual(['slowGuarded']);
  reloaded.cancel('stop the resumed run too');
  expect((await resumed).status).toBe('cancelled');
});

test('R50 cancel while idle applies immediately, like any other external write', async () => {
  const world = createWorld();
  world.use(slowGuarded);
  const a = world.spawn(Job({ label: 'x' }));
  const b = world.spawn(Job({ label: 'y' }));

  world.cancel('before we started');

  // Every entity is stamped, so every Not(Cancelled) system unmatches at once.
  expect(world.entity(a.id)?.get(Cancelled)).toMatchObject({ reason: 'before we started' });
  expect(world.entity(b.id)?.get(Cancelled)).toMatchObject({ reason: 'before we started' });
  expect(world.systemsMatching(a.id).map((s) => s.key)).toEqual([]);
  const result = await world.run();
  expect(result.status).toBe('cancelled');
  expect(result.steps).toBe(0);
});

test('R51 ctx.signal reaches the model and cancels the call in flight', async () => {
  const Reply = defineComponent<string>({ name: 'cancel.Reply' });
  const callModel = defineSystem({
    name: 'callModel',
    query: [Job, Not(Reply), Not(Cancelled)],
    run: async (e, ctx) => {
      const model = scriptedModel([{ role: 'assistant', content: 'too late' }], {
        delayMs: 60_000,
      });
      // The whole point of R49: the signal goes into the request.
      const result = await model.generate({ messages: [], signal: ctx.signal });
      e.set(Reply, result.message.content);
    },
  });
  const world = createWorld();
  world.use(callModel);
  const job = world.spawn(Job({ label: 'ask' }));

  const run = world.run();
  world.cancel('changed my mind');
  const result = await run;

  expect(result.status).toBe('cancelled');
  expect(world.entity(job.id)?.has(Reply)).toBe(false);
});

test('R52 a hung system times out into SystemError while its siblings commit normally', async () => {
  const hang = defineSystem({
    name: 'hang',
    query: [Job],
    timeoutMs: 10,
    // Never settles: without a timeout this hangs the barrier forever — no
    // commit, no snapshot, `world.running` stuck true.
    run: () => new Promise<void>(() => {}),
  });
  const healthy = defineSystem({
    name: 'healthy',
    query: [Job],
    run: (e) => {
      e.set(Mark, 'committed');
    },
  });
  const world = createWorld();
  world.use(hang);
  world.use(healthy);
  const job = world.spawn(Job({ label: 'slow' }));

  const result = await world.run();

  // The step still committed, and the healthy pair's write landed.
  expect(world.entity(job.id)?.get(Mark)).toBe('committed');
  // The timeout took R31's path, so `retry` can heal it (unlike a cancel).
  expect(result.status).toBe('error');
  const records = world.entity(job.id)?.get(SystemError) ?? [];
  expect(records).toHaveLength(1);
  expect(records[0]?.system).toBe('hang');
  expect(records[0]?.error.name).toBe('SystemTimeoutError');
  expect(records[0]?.error.message).toMatch(/exceeded its 10ms timeout/);
});

test('R52 an abandoned pair can never land a write, however late it finishes', async () => {
  let release: (() => void) | undefined;
  const late = defineSystem({
    name: 'late',
    query: [Job],
    timeoutMs: 5,
    run: async (e) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // Runs AFTER the barrier that abandoned this pair. Buffering it would
      // commit a write at a barrier this system was no longer part of.
      e.set(Mark, 'should never appear');
    },
  });
  const world = createWorld();
  world.use(late);
  const job = world.spawn(Job({ label: 'zombie' }));

  const result = await world.run();
  expect(result.status).toBe('error');

  // Let the abandoned system finish, then give its write every chance to land.
  release?.();
  await delay(10);
  expect(world.entity(job.id)?.has(Mark)).toBe(false);
  // And it is still just the one timeout record — no second error, no commit.
  expect(world.entity(job.id)?.get(SystemError)).toHaveLength(1);
});

test('R52 a sibling timeout never aborts a healthy pair (per-pair signals)', async () => {
  const seen: { hang?: boolean; ok?: boolean } = {};
  const hang = defineSystem({
    name: 'hangAlone',
    query: [Job],
    timeoutMs: 10,
    run: async (_e, ctx) => {
      await delay(60_000, ctx.signal).catch(() => {
        seen.hang = ctx.signal.aborted;
      });
    },
  });
  const ok = defineSystem({
    name: 'okAlone',
    query: [Job],
    run: async (e, ctx) => {
      await delay(30, ctx.signal);
      // Its own signal must still be live even though a sibling blew up.
      seen.ok = ctx.signal.aborted;
      throwIfAborted(ctx.signal);
      e.set(Mark, 'healthy');
    },
  });
  const world = createWorld();
  world.use(hang);
  world.use(ok);
  const job = world.spawn(Job({ label: 'mixed' }));

  await world.run();
  expect(seen.hang).toBe(true);
  expect(seen.ok).toBe(false);
  expect(world.entity(job.id)?.get(Mark)).toBe('healthy');
});

test('R52 the world default applies where a system sets no timeout of its own', async () => {
  const hang = defineSystem({
    name: 'hangDefault',
    query: [Job],
    run: () => new Promise<void>(() => {}),
  });
  const world = createWorld({ systemTimeoutMs: 10 });
  world.use(hang);
  const job = world.spawn(Job({ label: 'default' }));

  const result = await world.run();
  expect(result.status).toBe('error');
  expect(world.entity(job.id)?.get(SystemError)?.[0]?.error.name).toBe('SystemTimeoutError');
});

test('R53 runningPairs reports what is in flight, and is empty at quiescence', async () => {
  let observed: ReturnType<typeof world.runningPairs> = [];
  const watcher = defineSystem({
    name: 'watcher',
    query: [Job],
    timeoutMs: 5_000,
    run: async (_e, ctx) => {
      observed = world.runningPairs();
      await delay(1, ctx.signal);
    },
  });
  const world = createWorld();
  world.use(watcher);
  const job = world.spawn(Job({ label: 'watch' }));

  expect(world.runningPairs()).toEqual([]);
  await world.run();

  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    system: 'watcher',
    entity: job.id,
    step: 1,
    timeoutMs: 5_000,
  });
  expect(observed[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  // Cleared once the run settles, so a stale pair can never look in flight.
  expect(world.runningPairs()).toEqual([]);
});

test('R52 timeouts and cancellation compose: cancel stops waiting on a signal-ignoring system', async () => {
  // A system that ignores ctx.signal cannot be interrupted by cancel alone
  // (cancellation is cooperative, R49) — timeoutMs is the hard bound.
  const stubborn = defineSystem({
    name: 'stubborn',
    query: [Job, Not(Cancelled)],
    timeoutMs: 15,
    run: () => new Promise<void>(() => {}),
  });
  const world = createWorld();
  world.use(stubborn);
  const job = world.spawn(Job({ label: 'stubborn' }));

  const run = world.run();
  world.cancel('stop now');
  const result = await run;

  // The timeout is what actually released the barrier; the cancel decided the
  // status and stamped the state.
  expect(result.status).toBe('cancelled');
  expect(world.entity(job.id)?.get(Cancelled)).toMatchObject({ reason: 'stop now' });
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial review of the shipped cancellation work.
// Each failed against the code as first merged.
// ---------------------------------------------------------------------------

test('R50/R31 a concurrent cancel does not swallow a genuine unrelated failure', async () => {
  const Broken = defineComponent<number>({ name: 'cancel.Broken' });
  const buggy = defineSystem({
    name: 'buggy',
    query: [Broken],
    run: () => {
      throw new TypeError('a real production bug');
    },
  });
  const world = createWorld();
  world.use(buggy);
  world.use(slowGuarded);
  const broken = world.spawn(Broken(1));
  const job = world.spawn(Job({ label: 'slow' }));

  const run = world.run();
  world.cancel('operator stopped');
  const result = await run;

  expect(result.status).toBe('cancelled');
  // The suppression is attributed per PAIR by error identity. A run-wide
  // "was the run cancelled?" test made ANY failure landing after the cancel
  // invisible — no ErrorRecord, dirt consumed, and the only trace in a ring
  // buffer that `load` clears. A production bug vanished because someone
  // clicked Stop in the same step.
  const records = world.entity(broken.id)?.get(SystemError) ?? [];
  expect(records.map((r) => r.error.name)).toEqual(['TypeError']);
  expect(records[0]?.error.message).toBe('a real production bug');
  // The cancelled pair still records nothing, which is the intended asymmetry.
  expect(world.entity(job.id)?.has(SystemError)).toBe(false);
});

test('R50 a guard-less system interrupted by a cancel keeps its dirt and resumes', async () => {
  // Blessed by R50: a system without Not(Cancelled) "keeps matching after a
  // cancel, by design". It honours ctx.signal, so the cancel interrupts it.
  const Waiting = defineTag('cancel.Waiting');
  const calls: number[] = [];
  const chat = defineSystem({
    name: 'chat',
    query: [Job, Waiting],
    run: async (e, ctx) => {
      calls.push(ctx.step);
      await delay(60_000, ctx.signal);
      e.remove(Waiting);
    },
  });
  const world = createWorld();
  world.use(chat);
  const job = world.spawn(Job({ label: 'chat' }), Waiting());

  const run = world.run();
  world.cancel('stop');
  expect((await run).status).toBe('cancelled');

  // Consuming the dirt too left no writes, no error and nothing scheduled: the
  // entity was permanently wedged with zero diagnostics.
  expect(world.snapshot().pendingPairs.map((p) => p.system)).toContain('chat');

  // So un-cancelling really does resume it, which is what R50 promises.
  world.entity(job.id)?.remove(Cancelled);
  const resumed = world.run();
  world.cancel('and stop again');
  await resumed;
  // Step 1 ran, step 2 was the cancellation boundary, step 3 is the resumed pair.
  expect(calls).toEqual([1, 3]);
});

test('R28 a stale Cancelled on one entity does not mask error or pending', async () => {
  const Broken = defineComponent<number>({ name: 'cancel.Broken2' });
  const boom = defineSystem({
    name: 'boom2',
    query: [Broken, Not(Cancelled)],
    run: () => {
      throw new Error('real production bug');
    },
  });
  const world = createWorld();
  world.use(boom);

  // One unrelated entity is cancelled and never cleaned up...
  const stale = world.spawn(Job({ label: 'old' }));
  world.cancel('an earlier stop');
  expect(world.entity(stale.id)?.has(Cancelled)).toBe(true);

  // ...then real work arrives and fails.
  const broken = world.spawn(Broken(1));
  const result = await world.run();

  // `Cancelled` has no engine clearing path, so a world-wide status check made
  // ONE stale carrier hide every later error, interrupt and limit — forever.
  expect(result.status).toBe('error');
  expect(world.entity(broken.id)?.get(SystemError)?.[0]?.error.message).toBe('real production bug');
  // The zero-step case still reports cancelled, so a reloaded cancelled world is
  // not silently reported as idle.
  const quiet = createWorld();
  quiet.use(slowGuarded);
  quiet.spawn(Job({ label: 'x' }));
  quiet.cancel('stopped');
  expect((await quiet.run()).status).toBe('cancelled');
});

test('R52 an abandoned pair never advances the entity-id counter', async () => {
  let release: (() => void) | undefined;
  const zombie = defineSystem({
    name: 'zombie',
    query: [Job],
    timeoutMs: 5,
    run: async (_e, ctx) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // Runs long after the barrier abandoned this pair.
      for (let i = 0; i < 5; i++) ctx.spawn(Job({ label: `ghost-${i}` }));
    },
  });
  const world = createWorld();
  world.use(zombie);
  world.spawn(Job({ label: 'host' }));

  await world.run();
  const idAfterRun = world.snapshot().nextEntityId;

  release?.();
  await delay(10);
  // `nextEntityId` is committed state in every snapshot, so a zombie moving it
  // after the run ended made ids from a later run interleave with it — and a
  // loop in an abandoned system would grow it without bound.
  expect(world.snapshot().nextEntityId).toBe(idAfterRun);
  expect(world.query(Job)).toHaveLength(1);
});

test('R53 runningPairs keeps reporting a pair that was abandoned but is still running', async () => {
  let release: (() => void) | undefined;
  const hang = defineSystem({
    name: 'hangVisible',
    query: [Job],
    timeoutMs: 5,
    run: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const world = createWorld();
  world.use(hang);
  world.spawn(Job({ label: 'stuck' }));

  await world.run();
  // The one case an operator reaches for runningPairs() is a system hung badly
  // enough to be abandoned; clearing on the race made exactly that invisible.
  const stillRunning = world.runningPairs();
  expect(stillRunning.map((p) => p.system)).toEqual(['hangVisible']);
  expect(stillRunning[0]?.abandoned).toBe(true);

  release?.();
  await delay(10);
  expect(world.runningPairs()).toEqual([]);
});

test('R50 a cancel landing during the run-end save is honoured, not dropped', async () => {
  // `world.running` is still true while the run-end save awaits, so `cancel()`
  // takes the mid-run branch — and nothing read it: status was computed first and
  // the next run reset the flag. It returned void and left no trace, so a UI
  // gating its Cancel button on `world.running` showed a live control that did
  // nothing. With a real fs/S3/Postgres adapter the window is seconds.
  // A one-step run saves twice: once at the barrier, once at run end. The barrier
  // save is fine — the loop continues and honours the cancel. The RUN-END save is
  // the hole, so fire on the second save.
  let saves = 0;
  let world: World;
  const slowAdapter = {
    async save() {
      saves += 1;
      if (saves === 2) world.cancel('stopped while saving');
      await delay(20);
    },
    load: () => null,
  };
  const bump = defineSystem({
    name: 'bump',
    query: [Job, Not(Done)],
    run: (e) => {
      e.add(Done);
    },
  });
  world = createWorld({ persistence: slowAdapter });
  world.use(bump);
  const job = world.spawn(Job({ label: 'a' }));

  const result = await world.run();
  expect(saves).toBeGreaterThanOrEqual(2);

  expect(result.status).toBe('cancelled');
  expect(world.entity(job.id)?.get(Cancelled)).toMatchObject({
    reason: 'stopped while saving',
  });
});

test('R53 an abandoned pair stays listed while the same pair re-executes later', async () => {
  // The same (system, entity) can legitimately run again — `retry` re-arms a
  // timed-out pair — while the abandoned body from an earlier step is still
  // executing. Keyed by pair id alone, the new execution overwrote the zombie's
  // entry and then deleted it at its own settlement, hiding a still-hung body
  // from the one diagnostic that exists to show it.
  let calls = 0;
  const flaky = defineSystem({
    name: 'flakyRearm',
    query: [Job],
    timeoutMs: 5,
    run: async (e) => {
      calls += 1;
      if (calls === 1) await new Promise<void>(() => {}); // first attempt hangs forever
      e.set(Mark, 'ok');
    },
  });
  const world = createWorld();
  world.use(flaky);
  const job = world.spawn(Job({ label: 'x' }));

  await world.run(); // attempt 1 abandoned at its deadline; its body still hangs
  expect(world.runningPairs().map((p) => [p.system, p.abandoned])).toEqual([['flakyRearm', true]]);

  // Re-arm with an external write; attempt 2 succeeds and R32 clears the record.
  world.entity(job.id)?.set(Job, { label: 'x2' });
  expect((await world.run()).status).toBe('done');
  expect(world.entity(job.id)?.get(Mark)).toBe('ok');

  // The zombie from attempt 1 is genuinely still executing, so it stays listed.
  expect(world.runningPairs().map((p) => [p.system, p.abandoned])).toEqual([['flakyRearm', true]]);
});

test('R53 a settling zombie does not delist a live later execution of the same pair', async () => {
  // The other direction of the same collision: the abandoned body's deferred
  // cleanup deleted whatever the shared key pointed at — which, once the pair
  // re-ran, was the LIVE execution's entry.
  let release: (() => void) | undefined;
  let calls = 0;
  let observed: [string, boolean | undefined][] = [];
  const flaky = defineSystem({
    name: 'flakyDelist',
    query: [Job],
    // Generous enough that attempt 2's own 10ms of work stays well inside it —
    // attempt 1 is the only one meant to be abandoned here.
    timeoutMs: 200,
    run: async (e, ctx) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return;
      }
      // Attempt 2: let the zombie settle mid-flight, then look at the roster.
      release?.();
      await delay(10, ctx.signal);
      observed = world.runningPairs().map((p) => [p.system, p.abandoned]);
      e.set(Mark, 'ok');
    },
  });
  const world = createWorld();
  world.use(flaky);
  const job = world.spawn(Job({ label: 'y' }));

  await world.run(); // attempt 1 abandoned
  world.entity(job.id)?.set(Job, { label: 'y2' });
  await world.run(); // attempt 2 runs; zombie settles while it is in flight

  // The live attempt-2 pair was still listed after the zombie settled.
  expect(observed).toEqual([['flakyDelist', undefined]]);
});
