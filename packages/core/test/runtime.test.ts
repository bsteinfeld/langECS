import { expect, test } from 'vitest';
import {
  AwaitingHuman,
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  MissingResourceError,
  SystemError,
  WorldRunningError,
} from '../src/index';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => (globalThis as any).setTimeout(resolve, ms));

test('T9 parallelism: two ~30ms systems in one step complete in <50ms wall-clock', async () => {
  const P = defineComponent<number>({ name: 't9p' });
  const s1 = defineSystem({ name: 't9s1', query: [P], run: async () => sleep(30) });
  const s2 = defineSystem({ name: 't9s2', query: [P], run: async () => sleep(30) });
  const world = createWorld();
  world.use(s1);
  world.use(s2);
  world.spawn(P(1));
  const started = Date.now();
  const result = await world.run();
  const elapsed = Date.now() - started;
  expect(result.steps).toBe(1);
  expect(elapsed).toBeLessThan(50);
});

test('T10 throwing system: SystemError appended, writes discarded, sibling commits, later success auto-clears', async () => {
  const Job = defineComponent<string>({ name: 't10job' });
  const Result = defineComponent<string>({ name: 't10result' });
  const Side = defineComponent<string>({ name: 't10side' });
  const failer = defineSystem({
    name: 't10fail',
    query: [Job],
    run: (e) => {
      e.set(Result, 'should-be-discarded');
      if (e.get(Job) === 'bad') throw new Error('boom');
      e.set(Result, 'ok');
    },
  });
  const sibling = defineSystem({
    name: 't10sib',
    query: [Job],
    run: (e) => e.set(Side, 'committed'),
  });
  const world = createWorld();
  world.use(failer);
  world.use(sibling);
  const e = world.spawn(Job('bad'));
  const r1 = await world.run();
  expect(r1.status).toBe('error');
  expect(r1.errors).toHaveLength(1);
  expect(r1.errors[0]?.entity).toBe(e.id);
  expect(r1.errors[0]?.records).toEqual([
    {
      system: 't10fail',
      step: 1,
      error: expect.objectContaining({ name: 'Error', message: 'boom' }),
    },
  ]);
  expect(e.has(Result)).toBe(false); // failed pair's buffer discarded entirely
  expect(e.get(Side)).toBe('committed'); // sibling pair committed normally
  expect(e.get(SystemError)?.[0]?.system).toBe('t10fail');

  e.set(Job, 'good');
  const r2 = await world.run();
  expect(r2.status).toBe('done');
  expect(r2.errors).toEqual([]);
  expect(e.get(Result)).toBe('ok');
  expect(e.has(SystemError)).toBe(false); // R32 auto-clear removed the record
});

test('throwing when guard is treated like a throwing run (R31)', async () => {
  const W = defineComponent<number>({ name: 't10w' });
  const badGuard = defineSystem({
    name: 't10guard',
    query: [W],
    when: () => {
      throw new Error('guard exploded');
    },
    run: () => {},
  });
  const world = createWorld();
  world.use(badGuard);
  const e = world.spawn(W(1));
  const result = await world.run();
  expect(result.status).toBe('error');
  expect(e.get(SystemError)?.[0]).toEqual({
    system: 't10guard',
    step: 1,
    error: expect.objectContaining({ message: 'guard exploded' }),
  });
});

test('T17 system spawn/despawn; writes to despawned entity dropped and traced', async () => {
  const Victim = defineComponent<number>({ name: 't17victim' });
  const Killer = defineTag('t17killer');
  const Writer = defineTag('t17writer');
  let victimId = 0;
  const killer = defineSystem({
    name: 't17kill',
    query: [Killer],
    run: (_e, ctx) => {
      ctx.despawn(victimId);
      ctx.spawn(Victim(2));
    },
  });
  const writer = defineSystem({
    name: 't17write',
    query: [Writer],
    run: (_e, ctx) => ctx.write(victimId, Victim, 99, 'set'),
  });
  const world = createWorld();
  world.use(killer);
  world.use(writer);
  const victim = world.spawn(Victim(1));
  victimId = victim.id;
  world.spawn(Killer());
  world.spawn(Writer());
  await world.run();
  expect(world.entity(victimId)).toBeUndefined();
  const survivors = world.query(Victim);
  expect(survivors).toHaveLength(1);
  expect(survivors[0]?.get(Victim)).toBe(2);
  expect(survivors[0]?.id).toBeGreaterThan(victimId);
  const step1 = world.getTrace()[0];
  expect(step1?.despawned).toEqual([victimId]);
  expect(step1?.spawned).toEqual([survivors[0]?.id]);
  expect(step1?.spawnedBy?.[0]?.system).toBe('t17kill');
  expect(step1?.droppedWrites).toEqual([
    { system: 't17write', entity: victimId, component: 't17victim', kind: 'write' },
  ]);
});

test('same-pair despawn-then-write: entity removed, write dropped and traced (R25.5)', async () => {
  const Doomed = defineComponent<string>({ name: 'dtwDoomed' });
  const sys = defineSystem({
    name: 'dtwSys',
    query: [Doomed],
    run: (e) => {
      e.despawn();
      e.set(Doomed, 'after-despawn'); // same buffer, recorded after the despawn
    },
  });
  const world = createWorld();
  world.use(sys);
  const e = world.spawn(Doomed('alive'));
  const result = await world.run();
  // Despawns apply AFTER all writes (R25.5), but a write targeting an entity
  // despawned in the same step — even by its own pair — is dropped and traced,
  // never committed. No WriteConflict interaction: dropped writes are exempt
  // from the R30 prescan.
  expect(result.status).toBe('done');
  expect(result.steps).toBe(1);
  expect(world.entity(e.id)).toBeUndefined();
  const step1 = world.getTrace()[0];
  expect(step1?.despawned).toEqual([e.id]);
  expect(step1?.applied).toEqual([]);
  expect(step1?.droppedWrites).toEqual([
    { system: 'dtwSys', entity: e.id, component: 'dtwDoomed', kind: 'write' },
  ]);
});

test('R28 status precedence: a sibling error beats an interrupt; both surfaces populated', async () => {
  const Ask = defineTag('r28ask');
  const Boom = defineTag('r28boom');
  const interrupter = defineSystem({
    name: 'r28interrupt',
    query: [Ask],
    run: (e) => e.add(AwaitingHuman, [{ id: 'r28-1', kind: 'approval' }]),
  });
  const failer = defineSystem({
    name: 'r28fail',
    query: [Boom],
    run: () => {
      throw new Error('sibling boom');
    },
  });
  const world = createWorld();
  world.use(interrupter);
  world.use(failer);
  const asker = world.spawn(Ask());
  const bomber = world.spawn(Boom());
  const result = await world.run();
  expect(result.status).toBe('error'); // 'error' > 'pending' > 'done' (R28)
  expect(result.pending).toEqual([
    { entity: asker.id, interrupts: [{ id: 'r28-1', kind: 'approval' }] },
  ]);
  expect(result.errors).toEqual([
    {
      entity: bomber.id,
      records: [
        {
          system: 'r28fail',
          step: 1,
          error: expect.objectContaining({ message: 'sibling boom' }),
        },
      ],
    },
  ]);
});

test('R28 zero-step run with pre-existing AwaitingHuman returns idle (pinned)', async () => {
  const world = createWorld();
  const e = world.spawn(AwaitingHuman([{ id: 'pre-1', kind: 'approval' }]));
  const result = await world.run();
  // A run that scheduled zero steps is 'idle' regardless of pre-existing
  // interrupts (R28: 'idle' reflects "nothing ran", not world contents) —
  // result.pending still reports them.
  expect(result.status).toBe('idle');
  expect(result.steps).toBe(0);
  expect(result.pending).toEqual([
    { entity: e.id, interrupts: [{ id: 'pre-1', kind: 'approval' }] },
  ]);
  expect(world.pending()).toEqual(result.pending);
});

test('T18 external mutation while a run is in flight throws WorldRunningError', async () => {
  const G = defineComponent<number>({ name: 't18g' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = defineSystem({ name: 't18slow', query: [G], run: async () => gate });
  const world = createWorld();
  world.use(slow);
  const h = world.spawn(G(1));
  const run = world.run();
  expect(() => h.add(G, 2)).toThrow(WorldRunningError);
  expect(() => h.remove(G)).toThrow(WorldRunningError);
  expect(() => h.despawn()).toThrow(WorldRunningError);
  expect(() => world.spawn(G(3))).toThrow(WorldRunningError);
  expect(() => world.run()).toThrow(WorldRunningError); // only one run at a time (R25)
  release();
  const result = await run;
  expect(result.status).toBe('done');
  h.add(G, 2); // idle again: external mutation allowed
  expect(h.get(G)).toBe(2);
});

test('ctx.resource resolves registered resources and throws a clear error otherwise (R18)', async () => {
  const R = defineComponent<string>({ name: 't18r' });
  const Out = defineComponent<string>({ name: 't18out' });
  const uses = defineSystem({
    name: 't18use',
    query: [R],
    run: (e, ctx) => {
      const upper = ctx.resource<(s: string) => string>('upper');
      e.set(Out, upper(e.get(R)));
    },
  });
  const missing = defineSystem({
    name: 't18missing',
    query: [Out],
    run: (_e, ctx) => {
      ctx.resource('nope');
    },
  });
  const world = createWorld();
  world.use(uses);
  world.register('upper', (s: string) => s.toUpperCase());
  const e = world.spawn(R('hi'));
  await world.run();
  expect(e.get(Out)).toBe('HI');
  world.use(missing);
  const r = await world.run();
  expect(r.status).toBe('error');
  expect(e.get(SystemError)?.[0]?.error.name).toBe(new MissingResourceError('nope').name);
});
