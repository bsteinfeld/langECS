import { expect, test } from 'vitest';
import {
  AwaitingHuman,
  createWorld,
  defineComponent,
  defineSystem,
  HumanResponse,
  MemoryAdapter,
  type Model,
  Not,
  scriptedModel,
  UnknownComponentError,
  UnknownSystemError,
} from '../src/index';

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];

// ---------------------------------------------------------------------- T11

const Question = defineComponent<string>({ name: 't11question' });
const Answer = defineComponent<string>({ name: 't11answer' });
const asker = defineSystem({
  name: 't11ask',
  query: [Question, Not(AwaitingHuman), Not(HumanResponse)],
  run: (e) => {
    e.add(AwaitingHuman, [{ id: 'q1', kind: 'question', payload: e.get(Question) }]);
  },
});
const handler = defineSystem({
  name: 't11handle',
  query: [Question, HumanResponse],
  run: (e) => {
    e.set(Answer, String(e.get(HumanResponse).value));
    e.remove(HumanResponse);
    e.remove(Question);
  },
});

test('T11 interrupts: pending status, world.pending(), resume continues', async () => {
  const world = createWorld();
  world.use(asker);
  world.use(handler);
  const e = world.spawn(Question('what color?'));
  const r1 = await world.run();
  expect(r1.status).toBe('pending');
  expect(r1.pending).toEqual([
    { entity: e.id, interrupts: [{ id: 'q1', kind: 'question', payload: 'what color?' }] },
  ]);
  expect(world.pending()).toEqual(r1.pending);
  const r2 = await world.resume(e, 'blue');
  expect(r2.status).toBe('done');
  expect(world.pending()).toEqual([]);
  expect(e.get(Answer)).toBe('blue');
  expect(e.has(AwaitingHuman)).toBe(false);
  expect(e.has(HumanResponse)).toBe(false);
});

test('T11 interrupts work across snapshot/load on a fresh world', async () => {
  const world = createWorld({ id: 'hitl' });
  world.use(asker);
  world.use(handler);
  const e = world.spawn(Question('proceed?'));
  await world.run();
  const snap = world.snapshot();

  const world2 = createWorld({ id: 'hitl' });
  world2.use(asker);
  world2.use(handler);
  world2.load(snap);
  expect(world2.pending()).toEqual([
    { entity: e.id, interrupts: [{ id: 'q1', kind: 'question', payload: 'proceed?' }] },
  ]);
  const result = await world2.resume(e.id, 'yes');
  expect(result.status).toBe('done');
  expect(world2.entity(e.id)?.get(Answer)).toBe('yes');
});

// ---------------------------------------------------------------------- T12

const Stage1 = defineComponent<string>({ name: 't12stage1' });
const Stage2 = defineComponent<string>({ name: 't12stage2' });
const Stage3 = defineComponent<string>({ name: 't12stage3' });
const sysA = defineSystem({
  name: 't12a',
  query: [Stage1, Not(Stage2)],
  run: async (e, ctx) => {
    const model = ctx.resource<Model>('model');
    const res = await model.generate({ messages: [{ role: 'user', content: e.get(Stage1) }] });
    e.set(Stage2, res.message.content);
  },
});
const sysB = defineSystem({
  name: 't12b',
  query: [Stage2, Not(Stage3)],
  run: (e) => e.set(Stage3, `${e.get(Stage2)}!`),
});
const makeModel = () => scriptedModel([{ role: 'assistant', content: 'reply' }]);

test('T12 snapshot/load roundtrip mid-conversation resumes identically', async () => {
  const world1 = createWorld({ id: 'conv' });
  world1.use(sysA);
  world1.use(sysB);
  world1.register('model', makeModel());
  world1.spawn(Stage1('hello'));
  const paused = await world1.run({ limit: 1 });
  expect(paused.status).toBe('limit');
  expect(paused.steps).toBe(1);
  const snap = world1.snapshot();
  expect(snap.pendingPairs).toEqual([{ entity: 1, system: 't12b', reason: 'new-match' }]);

  // Missing registrations are reported by load (R36).
  const bare = createWorld({ id: 'conv' });
  expect(() => bare.load(snap)).toThrow(UnknownSystemError);
  expect(() =>
    bare.load({ ...snap, pendingPairs: [], entities: [{ id: 1, components: { ghost: 1 } }] }),
  ).toThrow(UnknownComponentError);

  const world2 = createWorld({ id: 'conv' });
  world2.use(sysA);
  world2.use(sysB);
  world2.register('model', makeModel());
  world2.load(snap);

  const r1 = await world1.run();
  const r2 = await world2.run();
  expect(r1.status).toBe('done');
  expect(r2.status).toBe('done');
  expect(world2.snapshot().entities).toEqual(world1.snapshot().entities);
  expect(world2.entity(1)?.get(Stage3)).toBe('reply!');
});

// ---------------------------------------------------------------------- T13

const Input = defineComponent<string[]>({ name: 't13input', reducer: append });
const Output = defineComponent<string[]>({ name: 't13output', reducer: append });
const echo = defineSystem({
  name: 't13echo',
  query: [Input],
  run: (e) => {
    const last = e.get(Input).at(-1);
    e.add(Output, [`${last}-echo`]);
  },
});

test('T13 time travel via MemoryAdapter.loadStep: fork at step N diverges', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'tt', persistence: adapter });
  world.use(echo);
  const e = world.spawn(Input(['a']));
  await world.send(e, Input(['b']));
  await world.send(e, Input(['c']));
  expect(e.get(Output)).toEqual(['b-echo', 'c-echo']);
  expect(adapter.history('tt').map((h) => h.step)).toEqual([1, 2]);

  const snap1 = await adapter.loadStep('tt', 1);
  expect(snap1).not.toBeNull();
  const fork = createWorld({ id: 'tt-fork' });
  fork.use(echo);
  fork.load(snap1 as NonNullable<typeof snap1>);
  expect(fork.step).toBe(1);
  await fork.send(e.id, Input(['z']));
  expect(fork.entity(e.id)?.get(Output)).toEqual(['b-echo', 'z-echo']);
  // Original timeline untouched: divergent states.
  expect(e.get(Output)).toEqual(['b-echo', 'c-echo']);
  expect(fork.entity(e.id)?.get(Input)).toEqual(['a', 'b', 'z']);
});

// ------------------------------------------------- step-0 boundary (R35/R36)

test('step-0 snapshot of a never-run world carries new-match pendingPairs and resumes identically', async () => {
  const Greet = defineComponent<string>({ name: 'zeroGreet' });
  const Reply = defineComponent<string>({ name: 'zeroReply' });
  const greeter = defineSystem({
    name: 'zeroGreeter',
    query: [Greet, Not(Reply)],
    run: (e) => e.set(Reply, `${e.get(Greet)}!`),
  });
  const world = createWorld({ id: 'zero' });
  world.use(greeter);
  const e = world.spawn(Greet('hi'));
  const snap = world.snapshot();
  expect(snap.step).toBe(0);
  expect(snap.nextEntityId).toBe(e.id + 1);
  expect(snap.pendingPairs).toEqual([{ entity: e.id, system: 'zeroGreeter', reason: 'new-match' }]);

  // "Create a conversation, persist immediately, resume in another process":
  // the loaded world runs to the same result as the original.
  const other = createWorld({ id: 'zero' });
  other.use(greeter);
  other.load(snap);
  const r2 = await other.run();
  expect(r2.status).toBe('done');
  expect(other.entity(e.id)?.get(Reply)).toBe('hi!');
  const r1 = await world.run();
  expect(r1.status).toBe('done');
  expect(other.snapshot()).toEqual(world.snapshot());
});

// --------------------------------------- load into a used world (R36 amended)

test('load() into an already-run world replaces everything and clears the trace', async () => {
  const Tick = defineComponent<number>({ name: 'ldTick' });
  const Junk = defineComponent<string>({ name: 'ldJunk' });
  const bump = defineSystem({
    name: 'ldBump',
    query: [Tick],
    run: (e) => {
      const t = e.get(Tick);
      if (t < 3) e.set(Tick, t + 1); // self-write: one step per external trigger
    },
  });

  // Source timeline: one committed step.
  const src = createWorld({ id: 'ld' });
  src.use(bump);
  src.spawn(Tick(0));
  await src.run();
  const snap = src.snapshot();
  expect(snap.step).toBe(1);

  // Target world has its own history: a different entity, a committed step,
  // and a non-empty flight recorder from that other timeline.
  const dst = createWorld({ id: 'ld' });
  dst.use(bump);
  dst.spawn(Tick(100), Junk('stale'));
  await dst.run();
  expect(dst.step).toBe(1);
  expect(dst.getTrace()).toHaveLength(1);

  dst.load(snap);
  // Wholesale replacement: pre-load components gone, counters from the snapshot.
  expect(dst.step).toBe(1);
  expect(dst.query(Junk)).toEqual([]);
  expect(dst.entity(1)?.get(Tick)).toBe(1);
  expect(dst.entity(1)?.has(Junk)).toBe(false);
  // The flight recorder is cleared (R42): no steps from the old timeline.
  expect(dst.getTrace()).toEqual([]);

  // Ids continue from the snapshot's counter; new steps trace from step 2 only.
  expect(dst.spawn(Junk('fresh')).id).toBe(snap.nextEntityId);
  dst.entity(1)?.set(Tick, 0);
  const r = await dst.run();
  expect(r.status).toBe('done');
  expect(dst.entity(1)?.get(Tick)).toBe(1);
  expect(dst.getTrace().map((t) => t.step)).toEqual([2]);
});

// ---------------------------------------------------------------------- T19

const Pos = defineComponent<{ x: number; y: number }>({
  name: 't19pos',
  serialize: (v) => [v.x, v.y],
  deserialize: (raw) => {
    const [x, y] = raw as [number, number];
    return { x, y };
  },
});
const Scratch = defineComponent<number>({ name: 't19scratch', transient: true });

test('T19 transient excluded from snapshot; serialize/deserialize hooks roundtrip', () => {
  const world = createWorld();
  world.spawn(Pos({ x: 1, y: 2 }), Scratch(9));
  const snap = world.snapshot();
  expect(snap.entities).toEqual([{ id: 1, components: { t19pos: [1, 2] } }]);
  expect(JSON.parse(JSON.stringify(snap))).toEqual(snap); // always JSON-stringifiable (R35)

  const world2 = createWorld();
  world2.load(snap);
  const restored = world2.entity(1);
  expect(restored?.get(Pos)).toEqual({ x: 1, y: 2 });
  expect(restored?.has(Scratch)).toBe(false);
  expect(world2.snapshot()).toEqual(snap);
});
