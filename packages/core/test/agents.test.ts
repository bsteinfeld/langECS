import { expect, test } from 'vitest';
import { createWorld, defineAgent, defineComponent, defineSystem, defineTag } from '../src/index';

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];

const Note = defineComponent<string>({ name: 'agNote' });
const Hits = defineComponent<string[]>({ name: 'agHits', reducer: append });
const respondA = defineSystem({ name: 'respond', query: [Note], run: (e) => e.add(Hits, ['A']) });
const respondB = defineSystem({ name: 'respond', query: [Note], run: (e) => e.add(Hits, ['B']) });
const AgentA = defineAgent({ name: 'agentA', components: [Hits([])], systems: [respondA] });
const AgentB = defineAgent({ name: 'agentB', components: [Hits([])], systems: [respondB] });

test('T16 auto-tag scoping: shared component shapes do not crosstalk; global system sees both', async () => {
  const world = createWorld();
  const a = world.spawn(AgentA, Note('hi'));
  const b = world.spawn(AgentB, Note('hi'));
  expect(a.components()).toContain('agent:agentA');
  expect(b.components()).toContain('agent:agentB');
  await world.run();
  expect(a.get(Hits)).toEqual(['A']);
  expect(b.get(Hits)).toEqual(['B']);

  // Poke only A: only A's scoped system fires.
  a.set(Note, 'again');
  await world.run();
  expect(a.get(Hits)).toEqual(['A', 'A']);
  expect(b.get(Hits)).toEqual(['B']);

  // A global system registered via world.use sees both agents.
  const globalSeen = defineSystem({
    name: 'global-see',
    query: [Note],
    run: (e) => e.add(Hits, ['G']),
  });
  world.use(globalSeen);
  await world.run();
  expect(a.get(Hits)).toEqual(['A', 'A', 'G']);
  expect(b.get(Hits)).toEqual(['B', 'G']);
});

test('R34 spawn-time extra inits override bundle inits; registration is idempotent', async () => {
  const world = createWorld();
  const a1 = world.spawn(AgentA, Note('x'), Hits(['seed']));
  const a2 = world.spawn(AgentA, Note('y')); // second spawn: systems already registered
  // Extras override the bundle regardless of argument position (R34).
  const a3 = world.spawn(Hits(['pre']), AgentA, Note('z'));
  await world.run();
  expect(a1.get(Hits)).toEqual(['seed', 'A']);
  expect(a2.get(Hits)).toEqual(['A']);
  expect(a3.get(Hits)).toEqual(['pre', 'A']);
});

test('R19 world.use(agentDef) registers scoped systems without spawning', async () => {
  const world = createWorld();
  world.use(AgentA);
  expect(world.query(AgentA.tag)).toHaveLength(0);
  const a = world.spawn(AgentA, Note('hello'));
  await world.run();
  expect(a.get(Hits)).toEqual(['A']);
});

test('ctx.spawn accepts an AgentDef; scoped systems register at the barrier (R29)', async () => {
  const WorkerDone = defineComponent<string>({ name: 'agWorkerDone' });
  const work = defineSystem({
    name: 'work',
    query: [Note],
    run: (e) => e.set(WorkerDone, e.get(Note)),
  });
  const Worker = defineAgent({ name: 'workerAgent', systems: [work] });
  const Boss = defineTag('agBoss');
  const supervise = defineSystem({
    name: 'supervise',
    query: [Boss],
    run: (_e, ctx) => {
      const spawned = ctx.spawn(Worker, Note('task'));
      expect(spawned.id).toBeGreaterThan(0); // id allocated eagerly
    },
  });
  const world = createWorld();
  world.use(supervise);
  world.spawn(Boss());
  const result = await world.run();
  expect(result.status).toBe('done');
  const workers = world.query(Worker.tag);
  expect(workers).toHaveLength(1);
  expect(workers[0]?.get(Note)).toBe('task');
  expect(workers[0]?.get(WorkerDone)).toBe('task'); // newly-matched dirt fired the scoped system
});

test('duplicate agent names throw via the auto-tag registry (R7/R34)', () => {
  expect(() => defineAgent({ name: 'agentA' })).toThrow(/agent:agentA/);
});

test('ctx.invalidate resolves systems registered by a same-step AgentDef spawn (R24)', async () => {
  const Job = defineComponent<string>({ name: 'agInvJob' });
  let workerRuns = 0;
  const work = defineSystem({
    name: 'invWork',
    query: [Job],
    run: () => {
      workerRuns += 1;
    },
  });
  const Worker = defineAgent({ name: 'invWorkerAgent', systems: [work] });
  const Kick = defineTag('agInvKick');
  const boss = defineSystem({
    name: 'invBoss',
    query: [Kick],
    run: (_e, ctx) => {
      const spawned = ctx.spawn(Worker, Job('go'));
      // The scoped system only registers at this step's barrier; the prescan
      // must still resolve it instead of rejecting the run.
      ctx.invalidate(spawned, 'invWorkerAgent:invWork');
    },
  });
  const world = createWorld();
  world.use(boss);
  world.spawn(Kick());
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(workerRuns).toBe(1); // new-match + invalidate dirt merge into one firing
});
