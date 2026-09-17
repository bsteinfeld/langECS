// Boundary hardening (T63-T69): every one of these is a reproduced defect where
// the engine left the world somewhere between two boundaries — a half-applied
// load, a silently ordered barrier, a dropped cancellation, leaked ids, dirt
// that could never be consumed, a trace entry that claimed a step that never
// committed, and a change record aliasing live storage.

import { expect, test } from 'vitest';
import {
  Cancelled,
  createWorld,
  DeserializeError,
  defineComponent,
  defineSystem,
  delay,
  formatTrace,
  MemoryAdapter,
  type PersistenceAdapter,
  type Snapshot,
  WorldRunningError,
  WriteConflictError,
} from '../src/index';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

// ---------------------------------------------------------------------- T63

test('T63 a throwing deserialize leaves the world byte-identical (R36/R13)', async () => {
  const Good = defineComponent<number>({ name: 'hardening.good' });
  const Bad = defineComponent<number>({
    name: 'hardening.bad',
    deserialize: () => {
      throw new Error('boom');
    },
  });
  const seen: { entity: number; value: number }[] = [];
  const sys = defineSystem({
    name: 'hardening.sys',
    query: [Good],
    run: (e) => {
      seen.push({ entity: e.id, value: e.get(Good) });
    },
  });

  const world = createWorld();
  world.use(sys);
  world.spawn(Good(111));
  const before = world.snapshot();

  const hostile: Snapshot = {
    version: 1,
    worldId: world.id,
    step: 7,
    nextEntityId: 99,
    entities: [
      { id: 10, components: { [Good.componentName]: 1 } },
      { id: 11, components: { [Bad.componentName]: 2 } },
    ],
    pendingPairs: [],
  };
  expect(() => world.load(hostile)).toThrow(DeserializeError);

  // `load` stages into locals and publishes in one go, like the barrier: the
  // failure reverts nothing because nothing was ever applied.
  expect(world.snapshot()).toEqual(before);

  // The scheduler is part of that: `matched`/`dirt` still describe the original
  // timeline, so the run executes the real entity only — never a phantom pair
  // for an entity the failed load half-introduced.
  const result = await world.run();
  expect(seen).toEqual([{ entity: 1, value: 111 }]);
  expect(result.steps).toBe(1);
});

test('T63 a failed load keeps the previous trace and id counter (R36/R13)', () => {
  const Mark = defineComponent<number>({ name: 'hardening.mark' });
  const Explodes = defineComponent<number>({
    name: 'hardening.explodes',
    deserialize: () => {
      throw new Error('nope');
    },
  });
  const world = createWorld();
  world.spawn(Mark(1));
  const idBefore = world.snapshot().nextEntityId;
  expect(() =>
    world.load({
      version: 1,
      worldId: world.id,
      step: 4,
      nextEntityId: 50,
      entities: [{ id: 7, components: { [Explodes.componentName]: 1 } }],
      pendingPairs: [],
    }),
  ).toThrow(DeserializeError);
  // The half-load used to leave `nextEntityId` untouched while the loaded ids
  // were already in the map, so the next spawn overwrote a loaded entity (R13).
  expect(world.snapshot().nextEntityId).toBe(idBefore);
  expect(world.spawn(Mark(2)).id).toBe(2);
  expect(world.entity(1)?.get(Mark)).toBe(1);
});

// ---------------------------------------------------------------------- T64

test('T64 set + remove of one component by two pairs rejects, either order (R30)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick' });
  const Flag = defineComponent<string>({ name: 'hardening.flag' });
  const setter = defineSystem({
    name: 'hardening.setter',
    query: [Tick],
    run: (e) => e.set(Flag, 'from-setter'),
  });
  const remover = defineSystem({
    name: 'hardening.remover',
    query: [Tick],
    run: (e) => e.remove(Flag),
  });

  for (const order of [
    [setter, remover],
    [remover, setter],
  ]) {
    const world = createWorld();
    for (const sys of order) world.use(sys);
    const e = world.spawn(Tick(1), Flag('seed'));
    const err = await world.run().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(WriteConflictError);
    const conflict = err as WriteConflictError;
    expect(conflict.component).toBe(Flag.componentName);
    expect(conflict.entity).toBe(e.id);
    expect(conflict.step).toBe(1);
    expect(conflict.pairs.map((p) => p.system).sort()).toEqual([
      'hardening.remover',
      'hardening.setter',
    ]);
    // Rejected at the step-start boundary (R30 amended), in both orders.
    expect(e.get(Flag)).toBe('seed');
  }
});

test('T64 an add and a remove on a reducer component by two pairs rejects (R30)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick2' });
  const Log = defineComponent<string[]>({
    name: 'hardening.log',
    reducer: (a, b) => [...a, ...b],
  });
  const appender = defineSystem({
    name: 'hardening.appender',
    query: [Tick],
    run: (e) => e.add(Log, ['appended']),
  });
  const clearer = defineSystem({
    name: 'hardening.clearer',
    query: [Tick],
    run: (e) => e.remove(Log),
  });
  const world = createWorld();
  world.use(appender);
  world.use(clearer);
  const e = world.spawn(Tick(1), Log(['seed']));
  // A reducer makes concurrent WRITES safe; it says nothing about a remove
  // racing them, which used to commit in registration order and silently drop
  // either the merge or the whole component.
  await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  expect(e.get(Log)).toEqual(['seed']);
});

test('T64 a spawn-time init racing a foreign write to the same shell rejects (R30)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick3' });
  const Plain = defineComponent<string>({ name: 'hardening.plain' });
  let shell = 0;
  const spawner = defineSystem({
    name: 'hardening.spawner',
    query: [Tick],
    run: (_e, ctx) => {
      shell = ctx.spawn(Plain('from-init')).id;
    },
  });
  const other = defineSystem({
    name: 'hardening.other',
    query: [Tick],
    run: async (_e, ctx) => {
      await sleep(5);
      ctx.write(shell, Plain, 'from-other', 'set');
    },
  });
  const world = createWorld();
  world.use(spawner);
  world.use(other);
  world.spawn(Tick(1));
  // The shell's id is public the moment `ctx.spawn` returns (R29), so a sibling
  // can write it; the init was invisible to the prescan and lost the race.
  await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  expect(world.entity(2)).toBeUndefined();
});

test('T64 legitimate same-slot combinations still commit (R30)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick4' });
  const Gone = defineComponent<string>({ name: 'hardening.gone' });
  const Log = defineComponent<string[]>({
    name: 'hardening.log2',
    reducer: (a, b) => [...a, ...b],
  });
  const Own = defineComponent<string>({ name: 'hardening.own' });

  // (b) two pairs removing the same component: idempotent, order-free.
  const removerA = defineSystem({
    name: 'hardening.removerA',
    query: [Tick],
    run: (e) => e.remove(Gone),
  });
  const removerB = defineSystem({
    name: 'hardening.removerB',
    query: [Tick],
    run: (e) => e.remove(Gone),
  });
  // (a) two pairs adding to a reducer component: the sanctioned merge.
  const appenderA = defineSystem({
    name: 'hardening.appenderA',
    query: [Tick],
    run: (e) => e.add(Log, ['a']),
  });
  const appenderB = defineSystem({
    name: 'hardening.appenderB',
    query: [Tick],
    run: (e) => e.add(Log, ['b']),
  });
  // Same pair doing write-then-remove is never a conflict: R30 is about two
  // DIFFERENT pairs.
  const selfChurn = defineSystem({
    name: 'hardening.selfChurn',
    query: [Tick],
    run: (e) => {
      e.set(Own, 'x');
      e.remove(Own);
    },
  });

  const world = createWorld();
  for (const sys of [removerA, removerB, appenderA, appenderB, selfChurn]) world.use(sys);
  const e = world.spawn(Tick(1), Gone('bye'), Log(['seed']));
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(e.has(Gone)).toBe(false);
  expect(e.get(Log)).toEqual(['seed', 'a', 'b']);
  expect(e.has(Own)).toBe(false);
});

// ---------------------------------------------------------------------- T65

test('T65 a cancel landing on a step whose barrier rejects is still stamped (R50)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick5' });
  const Plain = defineComponent<string>({ name: 'hardening.plain5' });
  const a = defineSystem({
    name: 'hardening.a',
    query: [Tick],
    run: async (e) => {
      await sleep(10);
      e.set(Plain, 'a');
    },
  });
  const b = defineSystem({
    name: 'hardening.b',
    query: [Tick],
    run: async (e) => {
      await sleep(10);
      e.set(Plain, 'b');
    },
  });
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'reject-cancel', persistence: adapter });
  world.use(a);
  world.use(b);
  const e = world.spawn(Tick(1));

  const run = world.run();
  world.cancel('stop please');
  await expect(run).rejects.toBeInstanceOf(WriteConflictError);

  // `pendingCancel` is consumed at the top of the loop or after it; the
  // rejection path reached neither, and the next run() reset it — the operator's
  // stop evaporated and the work resumed.
  expect(e.get(Cancelled)?.reason).toBe('stop please');
  expect(world.query(Cancelled).length).toBe(1);
  // Stamped at the step-start boundary the rejection restored (no step committed).
  expect(e.get(Cancelled)?.step).toBe(0);
  expect(world.step).toBe(0);
  // And durable: an unpersisted cancellation resumes un-cancelled (R37/R58).
  const stored = adapter.load(world.id);
  expect(stored?.entities[0]?.components).toHaveProperty(Cancelled.componentName);
});

// ---------------------------------------------------------------------- T66

test('T66 the cancellation stamp records a detached copy (R41/R42)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick6' });
  const slow = defineSystem({
    name: 'hardening.slow',
    query: [Tick],
    run: () => sleep(5),
  });
  const world = createWorld();
  world.use(slow);
  const e = world.spawn(Tick(1));
  const run = world.run();
  world.cancel('operator stopped it');
  await run;

  const trace = world.getTrace();
  const record = trace[trace.length - 1]?.applied.find(
    (c) => c.component === Cancelled.componentName,
  );
  expect(record?.value).toEqual(e.get(Cancelled));
  // The stamp goes through `commitWrite`, which used to push the live value.
  (record?.value as { reason?: string }).reason = 'MUTATED VIA TRACE';
  expect(e.get(Cancelled)?.reason).toBe('operator stopped it');
});

// ---------------------------------------------------------------------- T67

test('T67 dirt is pruned when a pair stops matching (R35)', async () => {
  const A = defineComponent<number>({ name: 'hardening.a7' });
  const sys = defineSystem({ name: 'hardening.sys7', query: [A], run: () => {} });
  const world = createWorld();
  world.use(sys);
  const e = world.spawn(A(1));
  expect(world.snapshot().pendingPairs).toHaveLength(1);
  e.remove(A); // unmatches before the pair ever ran
  // `pendingPairs` is "dirt at this boundary": dirt no candidate scan can ever
  // reach is not pending work, it is garbage that rides in every snapshot.
  expect(world.snapshot().pendingPairs).toEqual([]);
  const result = await world.run();
  expect(result.status).toBe('idle');
  expect(world.snapshot().pendingPairs).toEqual([]);
});

test('T67 a transient-only pending pair does not survive a snapshot round trip (R35/R36)', async () => {
  const Live = defineComponent<number>({ name: 'hardening.live', transient: true });
  const sys = defineSystem({ name: 'hardening.sys8', query: [Live], run: () => {} });
  const world = createWorld();
  world.use(sys);
  world.spawn(Live(1));
  const snap = world.snapshot();
  // The component is excluded from the snapshot (R35) but the dirt it created
  // is not, so the restored pair could never match — permanent phantom work.
  expect(snap.pendingPairs).toEqual([{ entity: 1, system: 'hardening.sys8', reason: 'new-match' }]);

  const fresh = createWorld();
  fresh.use(sys);
  const report = fresh.load(snap);
  expect(report.droppedPairs).toEqual([
    { entity: 1, system: 'hardening.sys8', reason: 'new-match' },
  ]);
  const result = await fresh.run();
  expect(result.status).toBe('idle');
  expect(fresh.snapshot().pendingPairs).toEqual([]);
});

// ---------------------------------------------------------------------- T68

test('T68 a rejected barrier restores nextEntityId (R30/R29)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick9' });
  const Plain = defineComponent<string>({ name: 'hardening.plain9' });
  const spawner = defineSystem({
    name: 'hardening.spawner9',
    query: [Tick],
    run: (e, ctx) => {
      ctx.spawn(Plain('child'));
      e.set(Plain, 'a');
    },
  });
  const other = defineSystem({
    name: 'hardening.other9',
    query: [Tick],
    run: (e) => e.set(Plain, 'b'),
  });
  const world = createWorld();
  world.use(spawner);
  world.use(other);
  world.spawn(Tick(1));
  const before = world.snapshot();
  await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  // R30 amended: state, dirt, step counter and trace all back at the step-start
  // boundary — the id counter is committed state too (R35), so it goes back.
  expect(world.snapshot()).toEqual(before);
});

// ---------------------------------------------------------------------- T69

test('T69 the veto-only iteration is flagged as uncommitted (R42/R45)', async () => {
  const Tick = defineComponent<number>({ name: 'hardening.tick10' });
  let allow = false;
  const sys = defineSystem({
    name: 'hardening.sys10',
    query: [Tick],
    when: () => allow,
    run: (e) => e.set(Tick, 9),
  });
  const world = createWorld();
  world.use(sys);
  const e = world.spawn(Tick(1));

  await world.run(); // fully vetoed: nothing commits, the counter stays at 0
  expect(world.step).toBe(0);
  allow = true;
  e.set(Tick, 2);
  await world.run(); // the real step 1

  const trace = world.getTrace();
  expect(trace.map((t) => t.step)).toEqual([1, 1]);
  // Same label, different truth — which is what the flag is for.
  expect(trace[0]?.committed).toBe(false);
  expect(trace[0]?.vetoed).toHaveLength(1);
  expect(trace[1]?.committed).toBeUndefined();
  expect(trace[1]?.runs).toHaveLength(1);

  const rendered = formatTrace(trace).split('\n');
  expect(rendered[0]).toContain('step 1 (vetoed only, not committed)');
  expect(formatTrace([trace[1]!]).split('\n')[0]).not.toContain('vetoed only');
});

test('T72 load never lets nextEntityId fall below the restored ids (R13)', () => {
  const Marker = defineComponent<number>({ name: 'bh.T72.marker' });
  const world = createWorld();
  world.load({
    version: 1,
    worldId: 'world',
    step: 0,
    nextEntityId: 1, // lags the entities it carries — a corrupt or hand-edited snapshot
    entities: [{ id: 7, components: { 'bh.T72.marker': 7 } }],
    pendingPairs: [],
  });
  const spawned = world.spawn(Marker(8));
  expect(spawned.id).toBe(8);
  expect(world.entity(7)?.get(Marker)).toBe(7);
  expect(world.snapshot().nextEntityId).toBe(9);
});

test('T74 the world stays busy while a late-cancellation save is in flight (R16/R50/R58)', async () => {
  const Slot = defineComponent<number>({ name: 'bh.T74.slot' });
  const Late = defineComponent<number>({ name: 'bh.T74.late' });
  const Go = defineComponent<boolean>({ name: 'bh.T74.go' });
  let release: (() => void) | undefined;
  const saves: Snapshot[] = [];
  const adapter: PersistenceAdapter = {
    save: (snapshot) => {
      saves.push(snapshot);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    load: () => null,
  };
  const world = createWorld({ persistence: adapter });
  // Two writers on a plain component: the first barrier rejects.
  world.use(defineSystem({ name: 'bh.T74.a', query: [Go], run: async (e) => e.set(Slot, 1) }));
  world.use(defineSystem({ name: 'bh.T74.b', query: [Go], run: async (e) => e.set(Slot, 2) }));
  const e = world.spawn(Go(true));
  saves.length = 0; // ignore the spawn's revision (no save happened yet: no run)
  const run = world.run();
  world.cancel('stop');
  // Wait until the rejection handler has stamped Cancelled and started its save.
  while (saves.length === 0) await delay(1);
  expect(world.running).toBe(true);
  expect(() => e.set(Late, 42)).toThrow(WorldRunningError);
  release?.();
  await expect(run).rejects.toBeInstanceOf(WriteConflictError);
  expect(world.running).toBe(false);
  expect(saves[0]?.entities[0]?.components.Cancelled).toBeDefined();
  // Now an edit is accepted, and it is NOT considered saved by the earlier write:
  // a zero-step run (unmatch the conflicting pairs first) persists it at run end.
  e.set(Late, 42);
  e.remove(Go);
  const again = world.run();
  while (saves.length < 2) await delay(1);
  release?.();
  await again;
  expect(saves[1]?.entities[0]?.components['bh.T74.late']).toBe(42);
});
