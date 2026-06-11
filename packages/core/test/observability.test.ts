import { expect, test } from 'vitest';
import {
  createWorld,
  defineComponent,
  defineSystem,
  formatTrace,
  type RunEvent,
  type StepTrace,
  type World,
} from '../src/index';

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];

test('T14 event stream order, late-iterator replay, ctx.emit custom events', async () => {
  const Chat = defineComponent<string[]>({ name: 't14chat', reducer: append });
  const Done = defineComponent<boolean>({ name: 't14done' });
  const emitter = defineSystem({
    name: 't14emit',
    query: [Chat],
    run: (e, ctx) => {
      ctx.emit('chunk-1');
      ctx.emit('chunk-2');
      e.set(Done, true);
    },
  });
  const world = createWorld();
  world.use(emitter);
  const e = world.spawn(Chat(['hi']));
  const run = world.run();
  // Live iterator, started before completion.
  const liveDone = (async () => {
    const events: RunEvent[] = [];
    for await (const ev of run) events.push(ev);
    return events;
  })();
  const result = await run;
  expect(result.status).toBe('done');
  const live = await liveDone;
  // Late iterator, started after completion: full replay from index 0.
  const replay: RunEvent[] = [];
  for await (const ev of run) replay.push(ev);
  expect(replay).toEqual(live);

  expect(live.map((ev) => ev.type)).toEqual([
    'run:start',
    'step:start',
    'system:start',
    'custom',
    'custom',
    'system:end',
    'step:applied',
    'run:end',
  ]);
  const customs = live.filter((ev) => ev.type === 'custom');
  expect(customs.map((c) => c.data)).toEqual(['chunk-1', 'chunk-2']);
  expect(customs[0]).toMatchObject({ system: 't14emit', entity: e.id, step: 1 });
  expect(live[1]).toMatchObject({ step: 1, scheduled: [{ system: 't14emit', entity: e.id }] });
  expect(live.at(-2)).toMatchObject({
    type: 'step:applied',
    changes: [{ entity: e.id, component: 't14done', kind: 'set', value: true }],
  });
  expect(live.at(-1)).toEqual({ type: 'run:end', status: 'done', steps: 1 });
});

test('T15 trace contents (scheduled/vetoed/writes) and formatTrace smoke', async () => {
  const Doc = defineComponent<string>({ name: 't15doc' });
  const Mark = defineComponent<string>({ name: 't15mark' });
  const writer = defineSystem({ name: 't15write', query: [Doc], run: (e) => e.set(Mark, 'done') });
  const vetoer = defineSystem({ name: 't15veto', query: [Doc], when: () => false, run: () => {} });
  const world = createWorld();
  world.use(writer);
  world.use(vetoer);
  const e = world.spawn(Doc('text'));
  await world.run();
  const trace = world.getTrace();
  const step1 = trace[0];
  expect(step1?.step).toBe(1);
  expect(step1?.scheduled).toEqual([
    { system: 't15write', entity: e.id },
    { system: 't15veto', entity: e.id },
  ]);
  expect(step1?.vetoed).toEqual([{ system: 't15veto', entity: e.id }]);
  expect(step1?.runs).toHaveLength(1);
  expect(step1?.runs[0]).toMatchObject({
    system: 't15write',
    entity: e.id,
    writes: [{ entity: e.id, component: 't15mark', kind: 'set', value: 'done' }],
  });
  expect(step1?.applied).toEqual([
    { entity: e.id, component: 't15mark', kind: 'set', value: 'done' },
  ]);
  const text = formatTrace(trace);
  expect(text).toContain('step 1');
  expect(text).toContain('t15write');
  expect(text).toContain('vetoed');
  expect(text).toContain('t15veto');
  expect(text).toContain('set t15mark');
});

test('trace ring buffer respects keep, and trace:false disables it', async () => {
  const Tick = defineComponent<number>({ name: 't15tick' });
  const Tock = defineComponent<number>({ name: 't15tock' });
  const ping = defineSystem({
    name: 't15ping',
    query: [Tick],
    run: (e) => e.set(Tock, e.get(Tick)),
  });
  const pong = defineSystem({
    name: 't15pong',
    query: [Tock],
    run: (e) => {
      const v = e.get(Tock);
      if (v !== undefined && v < 6) e.set(Tick, v + 1);
    },
  });
  const world = createWorld({ trace: { keep: 3 } });
  world.use(ping);
  world.use(pong);
  world.spawn(Tick(0));
  await world.run();
  const trace = world.getTrace();
  expect(trace).toHaveLength(3);
  expect(trace.at(-1)?.step).toBe(world.step);

  const silent = createWorld({ trace: false });
  silent.use(ping);
  silent.spawn(Tick(0));
  await silent.run();
  expect(silent.getTrace()).toEqual([]);
});

// ---------------------------------------------------------------------- T21

const Cue = defineComponent<number>({ name: 't21cue' });
const Echo = defineComponent<number>({ name: 't21echo' });
const Conv = defineComponent<string[]>({ name: 't21conv', reducer: append });
const Marker = defineComponent<string>({ name: 't21marker' });
const sysA = defineSystem({
  name: 't21a',
  query: [Cue],
  run: (e, ctx) => {
    const n = e.get(Cue);
    ctx.write(e, Conv, [`a${n}`]);
    if (n === 1) ctx.spawn(Marker('forked'));
    if (n < 3) e.set(Echo, n);
  },
});
const sysB = defineSystem({
  name: 't21b',
  query: [Echo],
  run: (e) => {
    const n = e.get(Echo);
    e.add(Conv, [`b${n}`]);
    e.set(Cue, n + 1);
  },
});

async function scriptedScenario(): Promise<World> {
  const world = createWorld({ id: 'det' });
  world.use(sysA);
  world.use(sysB);
  world.spawn(Cue(0));
  await world.run();
  return world;
}

const stripTimings = (trace: StepTrace[]) =>
  trace.map((step) => ({
    ...step,
    durationMs: 0,
    runs: step.runs.map((r) => ({ ...r, ms: 0 })),
  }));

test('T21 determinism: identical scripted run twice → identical state and trace shape', async () => {
  const w1 = await scriptedScenario();
  const w2 = await scriptedScenario();
  expect(w1.snapshot()).toEqual(w2.snapshot());
  expect(stripTimings(w1.getTrace())).toEqual(stripTimings(w2.getTrace()));
  expect(w1.entity(1)?.get(Conv)).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2', 'a3']);
  expect(w1.query(Marker)).toHaveLength(1);
});
