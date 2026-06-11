import { expect, test } from 'vitest';
import {
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  Not,
  UnknownSystemError,
  WriteConflictError,
} from '../src/index';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => (globalThis as any).setTimeout(resolve, ms));

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];

test('T2 reducer merges two writers in one step in registration order', async () => {
  const Item = defineComponent<number>({ name: 't2item' });
  const Log = defineComponent<string[]>({ name: 't2log', reducer: append });
  const writerA = defineSystem({
    name: 't2a',
    query: [Item],
    run: (e, ctx) => ctx.write(e, Log, ['a']),
  });
  const writerB = defineSystem({
    name: 't2b',
    query: [Item],
    run: (e, ctx) => ctx.write(e, Log, ['b']),
  });
  const world = createWorld();
  // Register B first: barrier order follows registration index, not names.
  world.use(writerB);
  world.use(writerA);
  const e = world.spawn(Item(1));
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(result.steps).toBe(1);
  expect(e.get(Log)).toEqual(['b', 'a']);
});

test('T3 plain-component double-write throws WriteConflictError naming systems/entity/step', async () => {
  const Item = defineComponent<number>({ name: 't3item' });
  const Out = defineComponent<string>({ name: 't3out' });
  const a = defineSystem({ name: 't3a', query: [Item], run: (e) => e.set(Out, 'a') });
  const b = defineSystem({ name: 't3b', query: [Item], run: (e) => e.set(Out, 'b') });
  const world = createWorld();
  world.use(a);
  world.use(b);
  const e = world.spawn(Item(1));
  const err = await world.run().then(
    () => null,
    (x: unknown) => x as WriteConflictError,
  );
  expect(err).toBeInstanceOf(WriteConflictError);
  expect(err?.component).toBe('t3out');
  expect(err?.entity).toBe(e.id);
  expect(err?.step).toBe(1);
  // Structured pairs for programmatic consumers; `systems` is derived display.
  expect(err?.pairs).toEqual([
    { system: 't3a', entity: e.id },
    { system: 't3b', entity: e.id },
  ]);
  expect(err?.systems).toEqual([`t3a (entity ${e.id})`, `t3b (entity ${e.id})`]);
  expect(err?.message).toContain('t3out');
  expect(err?.message).toContain('t3a');
  expect(err?.message).toContain('t3b');
  // Conflict detected during barrier staging: state untouched AND dirt intact
  // (R30 amended) — the snapshot still records the step-start boundary, and a
  // re-run reproduces the conflict instead of silently losing the work.
  expect(e.has(Out)).toBe(false);
  expect(world.step).toBe(0);
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 't3a', reason: 'new-match' },
    { entity: e.id, system: 't3b', reason: 'new-match' },
  ]);
  const retryErr = await world.run().then(
    () => null,
    (x: unknown) => x as WriteConflictError,
  );
  expect(retryErr).toBeInstanceOf(WriteConflictError);
});

test('T4 self-write exclusion: own append does not refire, foreign write does', async () => {
  const Msgs = defineComponent<string[]>({ name: 't4msgs', reducer: append });
  let runs = 0;
  const selfAppender = defineSystem({
    name: 't4self',
    query: [Msgs],
    run: (e) => {
      runs += 1;
      e.add(Msgs, ['x']);
    },
  });
  const world = createWorld();
  world.use(selfAppender);
  const e = world.spawn(Msgs(['hi']));
  const r1 = await world.run();
  expect(runs).toBe(1);
  expect(r1.steps).toBe(1);
  expect(e.get(Msgs)).toEqual(['hi', 'x']);
  e.add(Msgs, ['ext']); // external dirt (R16/R26.3)
  await world.run();
  expect(runs).toBe(2);
  expect(e.get(Msgs)).toEqual(['hi', 'x', 'ext', 'x']);
});

test('T4 exclusion is per pair: (S,e1) writing e2 is foreign dirt for (S,e2) (R27)', async () => {
  const Box = defineComponent<string[]>({ name: 't4box', reducer: append });
  const Poker = defineTag('t4poker');
  const runsPerEntity = new Map<number, number>();
  let otherId = 0;
  const sys = defineSystem({
    name: 't4pair',
    query: [Box],
    run: (e, ctx) => {
      runsPerEntity.set(e.id, (runsPerEntity.get(e.id) ?? 0) + 1);
      if (e.has(Poker) && ctx.step === 1) ctx.write(otherId, Box, ['poke']);
    },
  });
  const world = createWorld();
  world.use(sys);
  const e1 = world.spawn(Box([]), Poker());
  const e2 = world.spawn(Box([]));
  otherId = e2.id;
  await world.run();
  expect(runsPerEntity.get(e1.id)).toBe(1); // own write went to e2, not itself
  expect(runsPerEntity.get(e2.id)).toBe(2); // foreign write from (S,e1) refired (S,e2)
  expect(e2.get(Box)).toEqual(['poke']);
});

test('T5 newly-matched trigger via Not() term satisfied by removal', async () => {
  const Data = defineComponent<number>({ name: 't5data' });
  const Blocked = defineTag('t5blocked');
  const Seen = defineComponent<number>({ name: 't5seen' });
  let fires = 0;
  const watcher = defineSystem({
    name: 't5watch',
    query: [Data, Not(Blocked)],
    run: (e) => {
      fires += 1;
      e.set(Seen, e.get(Data));
    },
  });
  const unblocker = defineSystem({
    name: 't5unblock',
    query: [Data, Blocked],
    run: (e) => e.remove(Blocked),
  });
  const world = createWorld();
  world.use(watcher);
  world.use(unblocker);
  const e = world.spawn(Data(7), Blocked());
  const result = await world.run();
  expect(result.steps).toBe(2); // step 1: unblocker; step 2: watcher newly matches
  expect(fires).toBe(1);
  expect(e.get(Seen)).toBe(7);
});

test('T5 newly-matched trigger via spawn', async () => {
  const Task = defineComponent<string>({ name: 't5task' });
  const Done = defineComponent<string>({ name: 't5done' });
  const Boss = defineTag('t5boss');
  const spawner = defineSystem({
    name: 't5spawner',
    query: [Boss],
    run: (_e, ctx) => {
      ctx.spawn(Task('work'));
    },
  });
  const worker = defineSystem({
    name: 't5worker',
    query: [Task],
    run: (e) => e.set(Done, e.get(Task)),
  });
  const world = createWorld();
  world.use(spawner);
  world.use(worker);
  world.spawn(Boss());
  await world.run();
  const tasks = world.query(Task);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.get(Done)).toBe('work');
});

test('T6 value-change dirt: reducer append wakes an already-matching system', async () => {
  const Inbox = defineComponent<string[]>({ name: 't6inbox', reducer: append });
  const Sender = defineTag('t6sender');
  const Handled = defineComponent<number>({ name: 't6handled' });
  let recipientRuns = 0;
  let recipientId = 0;
  const recipient = defineSystem({
    name: 't6recv',
    query: [Inbox],
    run: (e) => {
      recipientRuns += 1;
      e.set(Handled, e.get(Inbox).length);
    },
  });
  const sender = defineSystem({
    name: 't6send',
    query: [Sender],
    run: (_e, ctx) => ctx.write(recipientId, Inbox, ['hello']),
  });
  const world = createWorld();
  world.use(recipient);
  world.use(sender);
  const r = world.spawn(Inbox([]));
  recipientId = r.id;
  world.spawn(Sender());
  await world.run();
  expect(recipientRuns).toBe(2); // step 1 (new-match, sees []), step 2 (foreign append)
  expect(r.get(Inbox)).toEqual(['hello']);
  expect(r.get(Handled)).toBe(1);
});

test('T7 when-veto is traced, consumes dirt, quiescence reached', async () => {
  const Flag = defineComponent<number>({ name: 't7flag' });
  let runs = 0;
  const guarded = defineSystem({
    name: 't7guard',
    query: [Flag],
    when: (e) => e.get(Flag) > 10,
    run: () => {
      runs += 1;
    },
  });
  const world = createWorld();
  world.use(guarded);
  const e = world.spawn(Flag(1));
  const r1 = await world.run();
  expect(r1.status).toBe('idle'); // veto consumed the only dirt; zero steps scheduled
  expect(runs).toBe(0);
  const trace1 = world.getTrace();
  expect(trace1).toHaveLength(1);
  expect(trace1[0]?.vetoed).toEqual([{ system: 't7guard', entity: e.id }]);
  expect(trace1[0]?.runs).toEqual([]);
  const r2 = await world.run();
  expect(r2.status).toBe('idle');
  expect(world.getTrace()).toHaveLength(1); // dirt was consumed: not even a candidate now
  e.set(Flag, 99);
  const r3 = await world.run();
  expect(r3.status).toBe('done');
  expect(runs).toBe(1);
});

test('T8 quiescence, and recursionLimit yields status limit', async () => {
  const A = defineComponent<number>({ name: 't8a' });
  const B = defineComponent<number>({ name: 't8b' });
  const ping = defineSystem({
    name: 't8ping',
    query: [A],
    run: (e, ctx) => ctx.write(e, B, e.get(A) + 1, 'set'),
  });
  const pong = defineSystem({
    name: 't8pong',
    query: [B],
    run: (e) => {
      const b = e.get(B);
      if (b !== undefined) e.set(A, b + 1);
    },
  });
  const world = createWorld();
  world.use(ping);
  world.use(pong);
  world.spawn(A(0));
  const limited = await world.run({ limit: 5 });
  expect(limited.status).toBe('limit');
  expect(limited.steps).toBe(5);

  // Quiescence on a non-cyclic world.
  const world2 = createWorld({ recursionLimit: 3 });
  world2.use(ping);
  world2.spawn(A(0));
  const done = await world2.run();
  expect(done.status).toBe('done');
  expect(done.steps).toBe(1);
  const idle = await world2.run();
  expect(idle.status).toBe('idle');
  expect(idle.steps).toBe(0);

  // (extended) createWorld({recursionLimit}) caps a cyclic run with no per-run
  // option (R12), and a follow-up run() resumes the cycle from the preserved
  // dirt instead of going idle (R25.3).
  const world3 = createWorld({ recursionLimit: 3 });
  world3.use(ping);
  world3.use(pong);
  world3.spawn(A(0));
  const capped = await world3.run();
  expect(capped.status).toBe('limit');
  expect(capped.steps).toBe(3);
  expect(world3.snapshot().pendingPairs).not.toEqual([]);
  const resumed = await world3.run();
  expect(resumed.status).toBe('limit');
  expect(resumed.steps).toBe(3); // resumed and was capped again — work not lost
});

test('T20 ctx.invalidate refires a pair with no other dirt', async () => {
  const Tgt = defineComponent<number>({ name: 't20tgt' });
  const Kick = defineTag('t20kick');
  let targetRuns = 0;
  let targetId = 0;
  const target = defineSystem({
    name: 't20target',
    query: [Tgt],
    run: () => {
      targetRuns += 1;
    },
  });
  const kicker = defineSystem({
    name: 't20kicker',
    query: [Kick],
    run: (_e, ctx) => ctx.invalidate(targetId, 't20target'),
  });
  const world = createWorld();
  world.use(target);
  world.use(kicker);
  const te = world.spawn(Tgt(1));
  targetId = te.id;
  world.spawn(Kick());
  const result = await world.run();
  expect(result.steps).toBe(2);
  expect(targetRuns).toBe(2); // step 1 new-match, step 2 via invalidate only
});

test('R24/R25 ctx.invalidate with an unknown system rejects before the barrier commits', async () => {
  const Val = defineComponent<number>({ name: 'invUnknownVal' });
  const bad = defineSystem({
    name: 'invUnknownBad',
    query: [Val],
    run: (e, ctx) => {
      e.set(Val, 99);
      ctx.invalidate(e, 'no-such-system');
    },
  });
  const world = createWorld();
  world.use(bad);
  const e = world.spawn(Val(1));
  const err = await world.run().then(
    () => null,
    (x: unknown) => x as UnknownSystemError,
  );
  expect(err).toBeInstanceOf(UnknownSystemError);
  expect(err?.systemNames).toEqual(['no-such-system']);
  // Rejected before commit: state stays at the step-start boundary (like T3).
  // No torn state — the write did not commit, so no step increment, no trace,
  // and no consumed dirt either: the snapshot still records the boundary and
  // a re-run reproduces the rejection instead of silently dropping the work.
  expect(e.get(Val)).toBe(1);
  expect(world.step).toBe(0);
  expect(world.getTrace()).toHaveLength(0);
  expect(world.snapshot().pendingPairs).toEqual([
    { entity: e.id, system: 'invUnknownBad', reason: 'new-match' },
  ]);
  const retry = await world.run().then(
    () => null,
    (x: unknown) => x as UnknownSystemError,
  );
  expect(retry).toBeInstanceOf(UnknownSystemError);
  expect(e.get(Val)).toBe(1);
});

test('R24 invalidate on a nonexistent or same-step-despawned entity is dropped + traced; no pendingPairs leak', async () => {
  const Kick = defineTag('invDropKick');
  const Husk = defineComponent<number>({ name: 'invDropHusk' });
  let victimId = 0;
  const sys = defineSystem({
    name: 'invDropSys',
    query: [Kick],
    run: (_e, ctx) => {
      ctx.invalidate(99999); // never existed
      ctx.despawn(victimId);
      ctx.invalidate(victimId); // despawned in this very step
    },
  });
  const world = createWorld();
  world.use(sys);
  const victim = world.spawn(Husk(1));
  victimId = victim.id;
  world.spawn(Kick());
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(world.entity(victimId)).toBeUndefined();
  // Dropped at the barrier with a trace note (R24 amended), like writes to
  // despawned entities.
  expect(world.getTrace()[0]?.droppedWrites).toEqual([
    { system: 'invDropSys', entity: 99999, kind: 'invalidate' },
    { system: 'invDropSys', entity: victimId, kind: 'invalidate' },
  ]);
  // Snapshot cleanliness (R35): phantom dirt for nonexistent entities never
  // reaches pendingPairs, so it cannot round-trip through persistence.
  expect(world.snapshot().pendingPairs).toEqual([]);
  const after = await world.run();
  expect(after.status).toBe('idle');
});

test('R20 (amended) zero-term and negative-only world.query are supported debugging API', () => {
  const Thing = defineComponent<number>({ name: 'q20thing' });
  const Mark = defineTag('q20mark');
  const world = createWorld();
  const e1 = world.spawn(Thing(1), Mark());
  const e2 = world.spawn(Thing(2));
  const e3 = world.spawn(Mark());
  // Zero terms: every entity, ordered by id.
  expect(world.query().map((h) => h.id)).toEqual([e1.id, e2.id, e3.id]);
  // Negative-only terms: the complement, same ordering.
  expect(world.query(Not(Mark)).map((h) => h.id)).toEqual([e2.id]);
  expect(world.query(Not(Thing)).map((h) => h.id)).toEqual([e3.id]);
  expect(world.query(Not(Thing), Not(Mark))).toEqual([]);
});

test('R17 reads during a step see step-start committed state', async () => {
  const Val = defineComponent<number>({ name: 'r17val' });
  const seen: number[] = [];
  const writer = defineSystem({
    name: 'r17writer',
    query: [Val],
    run: (e) => e.set(Val, 2), // self-write: no self-refire, foreign for reader
  });
  const reader = defineSystem({
    name: 'r17reader',
    query: [Val],
    run: async (e, ctx) => {
      await sleep(5); // let the writer's set() be buffered first
      seen.push(e.get(Val));
      ctx.world.query(Val); // step-start view as well
    },
  });
  const world = createWorld();
  world.use(writer);
  world.use(reader);
  world.spawn(Val(1));
  await world.run();
  expect(seen[0]).toBe(1); // never observes the same-step write
  expect(seen[1]).toBe(2); // refired by the writer's (foreign) change
});

test('in-place mutation of a component value bypasses triggering (documented immutability)', async () => {
  const ListC = defineComponent<string[]>({ name: 'r17list', reducer: append });
  let fires = 0;
  const sneaky = defineSystem({
    name: 'r17sneaky',
    query: [ListC],
    run: (e) => {
      fires += 1;
      e.get(ListC).push('mutated-in-place'); // not recorded: no dirt, no refire
    },
  });
  const world = createWorld();
  world.use(sneaky);
  world.spawn(ListC(['x']));
  const result = await world.run();
  expect(result.steps).toBe(1);
  expect(fires).toBe(1);
});
