// Engine-semantics regression tests for the adversarial-review fixes:
// two-phase barrier atomicity, dirt lifecycle at the barrier commit,
// rejected-run stream visibility, spawn aliasing, guard ctx restriction,
// limit-boundary ordering, system:start/system:error pairing, and
// observation-surface detachment.

import { expect, test } from 'vitest';
import {
  AwaitingHuman,
  createWorld,
  DuplicateSystemError,
  defineAgent,
  defineComponent,
  defineSystem,
  defineTag,
  type GuardCtx,
  interrupt,
  type RunEvent,
  type Snapshot,
  SystemError,
  WriteConflictError,
} from '../src/index';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => (globalThis as any).setTimeout(resolve, ms));

// ------------------------------------------------------- barrier atomicity

test('throwing reducer mid-barrier leaves zero torn state and preserves dirt (R25/R30 amended)', async () => {
  const Good = defineComponent<string>({ name: 'atomGood' });
  const Bad = defineComponent<number[]>({
    name: 'atomBad',
    reducer: () => {
      throw new Error('reducer boom');
    },
  });
  const Trigger = defineTag('atomTrigger');
  const setter = defineSystem({
    name: 'atomSetter',
    query: [Trigger],
    run: (e) => e.set(Good, 'committed'),
  });
  const appender = defineSystem({
    name: 'atomAppender',
    query: [Trigger, Bad],
    run: (e) => e.add(Bad, [2]),
  });
  const world = createWorld();
  world.use(setter);
  world.use(appender);
  const e = world.spawn(Trigger(), Bad([1]));

  const err = await world.run().then(
    () => null,
    (x: unknown) => x as Error,
  );
  expect(err?.message).toBe('reducer boom');

  // Zero torn state: the sibling pair's write did NOT commit, the step counter
  // and trace are at the step-start boundary.
  expect(e.has(Good)).toBe(false);
  expect(e.get(Bad)).toEqual([1]);
  expect(world.step).toBe(0);
  expect(world.getTrace()).toEqual([]);

  // Dirt preserved: the snapshot records the step-start boundary, and a re-run
  // reproduces the failure instead of silently dropping the work.
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 'atomSetter', reason: 'new-match' },
    { entity: e.id, system: 'atomAppender', reason: 'new-match' },
  ]);
  const err2 = await world.run().then(
    () => null,
    (x: unknown) => x as Error,
  );
  expect(err2?.message).toBe('reducer boom');
});

test('duplicate agent-system key from ctx.spawn(AgentDef) rejects during staging, nothing commits', async () => {
  const Probe = defineComponent<string>({ name: 'atomDupProbe' });
  const Kick = defineTag('atomDupKick');
  const w1 = defineSystem({ name: 'dupwork', query: [Probe], run: () => {} });
  const w2 = defineSystem({ name: 'dupwork', query: [Probe], run: () => {} });
  // Two different defs collide on the key 'atomDupAgent:dupwork'.
  const DupAgent = defineAgent({ name: 'atomDupAgent', systems: [w1, w2] });
  const boss = defineSystem({
    name: 'atomDupBoss',
    query: [Kick],
    run: (e, ctx) => {
      e.set(Probe, 'should-not-commit');
      ctx.spawn(DupAgent);
    },
  });
  const world = createWorld();
  world.use(boss);
  const e = world.spawn(Kick());

  const err = await world.run().then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(DuplicateSystemError);
  // Step-start boundary intact: no write, no spawn, no step, dirt preserved.
  expect(e.has(Probe)).toBe(false);
  expect(world.query(DupAgent.tag)).toHaveLength(0);
  expect(world.step).toBe(0);
  expect(world.getTrace()).toEqual([]);
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 'atomDupBoss', reason: 'new-match' },
  ]);
});

test('mid-run snapshot is boundary-consistent: in-flight pairs keep their dirt (R26/R35 amended)', async () => {
  const In = defineComponent<number>({ name: 'midsnapIn' });
  const Out = defineComponent<number>({ name: 'midsnapOut' });
  const slow = defineSystem({
    name: 'midsnapSlow',
    query: [In],
    run: async (e) => {
      await sleep(10);
      e.set(Out, e.get(In) * 2);
    },
  });
  const world = createWorld();
  world.use(slow);
  const e = world.spawn(In(21));

  const run = world.run();
  let snap: Snapshot | undefined;
  for await (const ev of run) {
    if (ev.type === 'system:start') {
      snap = world.snapshot(); // taken while the pair is executing
      break;
    }
  }
  await run;
  expect(e.get(Out)).toBe(42);

  // Dirt is consumed only at the barrier commit, so the mid-step snapshot
  // still carries the in-flight pair — loading it does not lose the work.
  expect(snap?.step).toBe(0);
  expect(snap?.pendingPairs).toEqual([
    { entity: e.id, system: 'midsnapSlow', reason: 'new-match' },
  ]);
  const world2 = createWorld({ id: 'midsnap2' });
  world2.use(slow);
  world2.load(snap as Snapshot);
  const result = await world2.run();
  expect(result.status).toBe('done');
  expect(world2.entity(e.id)?.get(Out)).toBe(42);
});

// ------------------------------------------------- rejected-run visibility

test('rejected run: iterators drain buffered events then throw; promise consumers reject (R40 amended)', async () => {
  const Item = defineComponent<number>({ name: 'rejItem' });
  const Out = defineComponent<string>({ name: 'rejOut' });
  const a = defineSystem({ name: 'rejA', query: [Item], run: (e) => e.set(Out, 'a') });
  const b = defineSystem({ name: 'rejB', query: [Item], run: (e) => e.set(Out, 'b') });
  const world = createWorld();
  world.use(a);
  world.use(b);
  world.spawn(Item(1));

  const run = world.run();
  const events: RunEvent[] = [];
  let thrown: unknown = null;
  try {
    for await (const ev of run) events.push(ev);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WriteConflictError);
  expect(events.map((ev) => ev.type)).toEqual([
    'run:start',
    'step:start',
    'system:start',
    'system:start',
    'system:end',
    'system:end',
  ]);

  // Late iterator: full replay, then the same terminal throw.
  const replay: RunEvent[] = [];
  let thrownLate: unknown = null;
  try {
    for await (const ev of run) replay.push(ev);
  } catch (err) {
    thrownLate = err;
  }
  expect(replay).toEqual(events);
  expect(thrownLate).toBe(thrown);

  // Promise-consumer behavior unchanged: the run rejects.
  const fromPromise = await run.then(
    () => null,
    (x: unknown) => x,
  );
  expect(fromPromise).toBe(thrown);
});

// ----------------------------------------------------------- spawn aliasing

test('two spawns of one AgentDef share nothing; the template survives in-place mutation (R34 amended)', async () => {
  const Mem = defineComponent<{ log: string[] }>({ name: 'aliasMem' });
  const Pad = defineComponent<string[]>({ name: 'aliasPad' });
  const Agent = defineAgent({ name: 'aliasAgent', components: [Mem({ log: [] }), Pad([])] });
  const world = createWorld();
  const e1 = world.spawn(Agent);
  const e2 = world.spawn(Agent);

  expect(e1.get(Mem)).not.toBe(e2.get(Mem));
  expect(e1.get(Pad)).not.toBe(e2.get(Pad));

  // In-place mutation is undefined behavior (R17 amended) — but it must never
  // cross entities or corrupt the AgentDef template.
  e1.get(Mem)?.log.push('leak');
  e1.get(Pad)?.push('leak');
  expect(e2.get(Mem)?.log).toEqual([]);
  expect(e2.get(Pad)).toEqual([]);
  const e3 = world.spawn(Agent);
  expect(e3.get(Mem)?.log).toEqual([]);
  expect(e3.get(Pad)).toEqual([]);

  // Same guarantee on the in-system spawn path (barrier materialization).
  const Kick = defineTag('aliasKick');
  const boss = defineSystem({
    name: 'aliasBoss',
    query: [Kick],
    run: (_e, ctx) => {
      ctx.spawn(Agent);
      ctx.spawn(Agent);
    },
  });
  world.use(boss);
  world.spawn(Kick());
  await world.run();
  const all = world.query(Mem);
  expect(all.length).toBe(5);
  const values = all.map((h) => h.get(Mem));
  expect(new Set(values).size).toBe(5); // pairwise distinct object identities
  expect(values.every((v) => v !== undefined && v.log.length === (v === values[0] ? 1 : 0))).toBe(
    true,
  );
});

// ----------------------------------------------------------------- GuardCtx

test('when-guards receive a restricted GuardCtx at runtime: no mutators, reads + resources work (R21 amended)', async () => {
  const Flag = defineComponent<number>({ name: 'guardFlag' });
  let seenKeys: string[] = [];
  let seenResource = '';
  let seenQueryCount = -1;
  const guarded = defineSystem({
    name: 'guardSys',
    query: [Flag],
    when: (e, ctx) => {
      seenKeys = Object.keys(ctx).sort();
      seenResource = ctx.resource<string>('greeting');
      seenQueryCount = ctx.world.query(Flag).length;
      const open = ctx as unknown as Record<string, unknown>;
      expect(open.write).toBeUndefined();
      expect(open.spawn).toBeUndefined();
      expect(open.despawn).toBeUndefined();
      expect(open.remove).toBeUndefined();
      expect(open.invalidate).toBeUndefined();
      expect(open.emit).toBeUndefined();
      return e.get(Flag) > 0;
    },
    run: () => {},
  });
  const world = createWorld();
  world.register('greeting', 'hello');
  world.use(guarded);
  world.spawn(Flag(1));
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(seenKeys).toEqual(['resource', 'step', 'world']);
  expect(seenResource).toBe('hello');
  expect(seenQueryCount).toBe(1);
  // Type-level: GuardCtx exposes exactly step/world/resource.
  type _Check = GuardCtx extends { step: number } ? true : never;
  const _check: _Check = true;
  expect(_check).toBe(true);
});

// ------------------------------------------------------------ limit boundary

test('limit break happens before guard evaluation: vetoing guard never runs, dirt preserved (R25 amended)', async () => {
  const V = defineComponent<number>({ name: 'limVetoVal' });
  let guardCalls = 0;
  const vetoer = defineSystem({
    name: 'limVeto',
    query: [V],
    when: () => {
      guardCalls += 1;
      return false;
    },
    run: () => {},
  });
  const world = createWorld();
  world.use(vetoer);
  const e = world.spawn(V(1));

  const limited = await world.run({ limit: 0 });
  expect(limited.status).toBe('limit');
  expect(limited.steps).toBe(0);
  expect(guardCalls).toBe(0); // no guard code ran at the limit break
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 'limVeto', reason: 'new-match' },
  ]);

  // Resume re-fires the pair: the guard finally evaluates (and vetoes).
  const resumed = await world.run();
  expect(guardCalls).toBe(1);
  expect(resumed.status).toBe('idle');
  expect(world.snapshot().pendingPairs).toEqual([]); // veto consumed the dirt
});

test('limit break with a throwing guard: nothing swallowed — dirt preserved, resume surfaces the error (R31)', async () => {
  const W = defineComponent<number>({ name: 'limThrowVal' });
  let guardCalls = 0;
  const thrower = defineSystem({
    name: 'limThrow',
    query: [W],
    when: () => {
      guardCalls += 1;
      throw new Error('guard at limit');
    },
    run: () => {},
  });
  const world = createWorld();
  world.use(thrower);
  const e = world.spawn(W(1));

  const limited = await world.run({ limit: 0 });
  expect(limited.status).toBe('limit');
  expect(limited.steps).toBe(0);
  expect(guardCalls).toBe(0);
  expect(e.has(SystemError)).toBe(false);
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 'limThrow', reason: 'new-match' },
  ]);

  // Resume re-fires the pair; the guard throw is recorded per R31, not lost.
  const resumed = await world.run();
  expect(guardCalls).toBe(1);
  expect(resumed.status).toBe('error');
  expect(e.get(SystemError)?.[0]).toEqual({
    system: 'limThrow',
    step: 1,
    error: expect.objectContaining({ message: 'guard at limit' }),
  });
});

// ------------------------------------------------------------ event pairing

test('every system:error is preceded by system:start for the same pair, with full payload (R41 amended)', async () => {
  const Job = defineComponent<number>({ name: 'pairJob' });
  const runThrower = defineSystem({
    name: 'pairRunThrow',
    query: [Job],
    run: () => {
      throw new Error('run boom');
    },
  });
  const guardThrower = defineSystem({
    name: 'pairGuardThrow',
    query: [Job],
    when: () => {
      throw new Error('guard boom');
    },
    run: () => {},
  });
  const world = createWorld();
  world.use(runThrower);
  world.use(guardThrower);
  const e = world.spawn(Job(1));

  const run = world.run();
  const events: RunEvent[] = [];
  for await (const ev of run) events.push(ev);
  const result = await run;
  expect(result.status).toBe('error');

  const errors = events.filter((ev) => ev.type === 'system:error');
  expect(errors.map((ev) => ev.system).sort()).toEqual(['pairGuardThrow', 'pairRunThrow']);
  for (const errEv of errors) {
    expect(errEv).toMatchObject({
      step: 1,
      entity: e.id,
      error: expect.objectContaining({ name: 'Error' }),
    });
    const startIdx = events.findIndex(
      (ev) =>
        ev.type === 'system:start' && ev.system === errEv.system && ev.entity === errEv.entity,
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(events.indexOf(errEv));
  }
  // The trailing envelope is intact: step:applied then run:end.
  expect(events.at(-2)?.type).toBe('step:applied');
  expect(events.at(-1)).toEqual({ type: 'run:end', status: 'error', steps: 1 });
});

// ----------------------------------------------------- observation detachment

test('pending()/RunResult are detached copies: mutating them never touches committed state (R28 amended)', async () => {
  const Ask = defineTag('detachAsk');
  const interrupter = defineSystem({
    name: 'detachInterrupt',
    query: [Ask],
    run: (e) => {
      if (!e.has(AwaitingHuman)) e.add(AwaitingHuman, interrupt('approval', { q: 1 }).value);
    },
  });
  const world = createWorld();
  world.use(interrupter);
  const e = world.spawn(Ask());
  const result = await world.run();
  expect(result.status).toBe('pending');
  expect(result.pending[0]?.interrupts).toHaveLength(1);

  result.pending[0]?.interrupts.push({ id: 'injected', kind: 'fake' });
  const record = result.pending[0]?.interrupts[0];
  if (record) record.kind = 'tampered';
  expect(world.pending()[0]?.interrupts).toHaveLength(1);
  expect(world.pending()[0]?.interrupts[0]?.kind).toBe('approval');
  expect(e.get(AwaitingHuman)).toHaveLength(1);
});

test('RunResult.errors are detached copies (R28 amended)', async () => {
  const Bomb = defineTag('detachBomb');
  const failer = defineSystem({
    name: 'detachFail',
    query: [Bomb],
    run: () => {
      throw new Error('kaboom');
    },
  });
  const world = createWorld();
  world.use(failer);
  const e = world.spawn(Bomb());
  const result = await world.run();
  expect(result.status).toBe('error');
  result.errors[0]?.records.pop();
  expect(result.errors[0]?.records).toHaveLength(0);
  expect(e.get(SystemError)).toHaveLength(1);
});

test('ChangeRecord.value in events and trace is detached from committed storage (R41/R42 amended)', async () => {
  const List = defineComponent<string[]>({ name: 'detachList' });
  const Seed = defineTag('detachSeed');
  const writer = defineSystem({
    name: 'detachWriter',
    query: [Seed],
    run: (e) => e.set(List, ['a']),
  });
  const world = createWorld();
  world.use(writer);
  const e = world.spawn(Seed());

  const run = world.run();
  const events: RunEvent[] = [];
  for await (const ev of run) events.push(ev);
  await run;

  const applied = events.find((ev) => ev.type === 'step:applied');
  const eventValue = applied?.changes[0]?.value as string[];
  expect(eventValue).toEqual(['a']);
  eventValue.push('hacked-via-event');
  expect(e.get(List)).toEqual(['a']);

  const trace = world.getTrace()[0];
  const traceWrite = trace?.runs[0]?.writes[0]?.value as string[];
  expect(traceWrite).toEqual(['a']);
  traceWrite.push('hacked-via-trace');
  expect(e.get(List)).toEqual(['a']);

  // Later in-place mutation of committed state cannot rewrite history either.
  (e.get(List) as string[]).push('late-mutation');
  expect((trace?.applied[0]?.value as string[]).includes('late-mutation')).toBe(false);
});
