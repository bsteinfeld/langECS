// SPEC §14 — observability & introspection (R45–R48, T23–T26).
import { expect, test, vi } from 'vitest';
import {
  createWorld,
  defineAgent,
  defineComponent,
  defineSystem,
  defineTag,
  type ExternalChange,
  listComponents,
  MemoryAdapter,
  type ObserverEvent,
  type RunEvent,
  type SystemRunInfo,
  WriteConflictError,
} from '../src/index';

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];

test('T23 observe onEvent: passive tap sees the full ordered stream without iterating the Run', async () => {
  const Doc = defineComponent<string>({ name: 'obsDoc' });
  const Done = defineTag('obsDone');
  const world = createWorld({ id: 'obs-w' });
  world.use(
    defineSystem({
      name: 'obsFinish',
      query: [Doc],
      run: (e, ctx) => {
        ctx.emit('tick');
        e.add(Done);
      },
    }),
  );
  const e = world.spawn(Doc('hi'));

  const seen: { event: ObserverEvent; runId: string; worldId: string }[] = [];
  world.observe({
    onEvent: (event, info) => seen.push({ event, runId: info.runId, worldId: info.worldId }),
  });

  const run = world.run();
  const result = await run;
  expect(result.status).toBe('done');

  // Tap order matches the Run's own iterator exactly (R45).
  const iterated: RunEvent[] = [];
  for await (const ev of run) iterated.push(ev);
  expect(seen.map((s) => s.event)).toEqual(iterated);
  expect(seen.map((s) => s.event.type)).toEqual([
    'run:start',
    'step:start',
    'system:start',
    'custom',
    'system:end',
    'step:applied',
    'run:end',
  ]);
  expect(seen[0]?.worldId).toBe('obs-w');
  expect(new Set(seen.map((s) => s.runId)).size).toBe(1);
  const first = seen[0]?.event;
  expect(first?.type === 'run:start' && first.runId === seen[0]?.runId).toBe(true);
  expect(seen[3]?.event).toMatchObject({ type: 'custom', entity: e.id, data: 'tick' });
});

test('T23 observe onEvent: rejected run emits run:reject (no run:end), detach stops the tap', async () => {
  const Src = defineComponent<number>({ name: 'obsSrc' });
  const Plain = defineComponent<number>({ name: 'obsPlain' });
  const w1 = defineSystem({ name: 'obsW1', query: [Src], run: (e) => e.set(Plain, 1) });
  const w2 = defineSystem({ name: 'obsW2', query: [Src], run: (e) => e.set(Plain, 2) });
  const world = createWorld();
  world.use(w1);
  world.use(w2);
  world.spawn(Src(0));

  const types: string[] = [];
  const detach = world.observe({ onEvent: (event) => types.push(event.type) });

  await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  expect(types).toContain('run:reject');
  expect(types).not.toContain('run:end');
  const reject = types.at(-1);
  expect(reject).toBe('run:reject');

  // Detach is idempotent and stops the tap (R45); the conflict's dirt is
  // intact (R30 amended), so the re-run reproduces the rejection silently
  // for this now-detached observer.
  detach();
  detach();
  const before = types.length;
  await expect(world.run()).rejects.toBeInstanceOf(WriteConflictError);
  expect(types.length).toBe(before);
});

test('T23 observer isolation: a throwing onEvent/onExternalChange never affects the run (R45)', async () => {
  const Doc = defineComponent<string>({ name: 'obsIsoDoc' });
  const Done = defineTag('obsIsoDone');
  const world = createWorld();
  world.use(defineSystem({ name: 'obsIso', query: [Doc], run: (e) => e.add(Done) }));
  // Core's tsconfig has no DOM/Node libs (R1); reach console via globalThis.
  const consoleRef = (globalThis as unknown as { console: { error: (...args: unknown[]) => void } })
    .console;
  const errSpy = vi.spyOn(consoleRef, 'error').mockImplementation(() => {});
  try {
    world.observe({
      onEvent: () => {
        throw new Error('observer bug');
      },
      onExternalChange: () => {
        throw new Error('observer bug');
      },
    });
    const e = world.spawn(Doc('x')); // onExternalChange throws here — ignored
    const result = await world.run();
    expect(result.status).toBe('done');
    expect(world.entity(e.id)?.has(Done)).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

test('T24 wrapSystemRun: composes first-registered-outermost, sees info, propagates results', async () => {
  const Doc = defineComponent<string>({ name: 'obsWrapDoc' });
  const Done = defineTag('obsWrapDone');
  const world = createWorld({ id: 'obs-wrap' });
  world.use(
    defineSystem({
      name: 'obsWrapSys',
      query: [Doc],
      run: async (e) => {
        await Promise.resolve();
        e.add(Done);
      },
    }),
  );
  const e = world.spawn(Doc('x'));

  const order: string[] = [];
  let captured: SystemRunInfo | undefined;
  let runningInside: boolean | undefined;
  world.observe({
    wrapSystemRun: async (info, fn) => {
      order.push('outer:start');
      captured = info;
      runningInside = world.running;
      await fn();
      order.push('outer:end');
    },
  });
  world.observe({
    wrapSystemRun: async (_info, fn) => {
      order.push('inner:start');
      await fn();
      order.push('inner:end');
    },
  });

  expect(world.running).toBe(false);
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(world.running).toBe(false);
  expect(order).toEqual(['outer:start', 'inner:start', 'inner:end', 'outer:end']);
  expect(captured).toMatchObject({
    worldId: 'obs-wrap',
    step: 1,
    system: 'obsWrapSys',
    entity: e.id,
  });
  expect(captured?.runId).toBeTruthy();
  expect(runningInside).toBe(true);
});

test('T24 wrapSystemRun: a system throw rejects fn; a wrapper throw lands as SystemError (R31)', async () => {
  const Doc = defineComponent<string>({ name: 'obsWrapErrDoc' });
  const world = createWorld();
  world.use(
    defineSystem({
      name: 'obsWrapBoom',
      query: [Doc],
      run: () => {
        throw new Error('boom');
      },
    }),
  );
  const e = world.spawn(Doc('x'));

  let sawRejection: string | undefined;
  world.observe({
    wrapSystemRun: async (_info, fn) => {
      try {
        await fn();
      } catch (err) {
        sawRejection = (err as Error).message;
        throw err; // propagate per contract (R46)
      }
    },
  });

  const result = await world.run();
  expect(sawRejection).toBe('boom');
  expect(result.status).toBe('error');
  expect(result.errors[0]).toMatchObject({
    entity: e.id,
    records: [{ system: 'obsWrapBoom', error: { message: 'boom' } }],
  });
});

test('T25 onExternalChange: spawn/write/remove/despawn/resource/systems/load all notify (R48)', async () => {
  const Doc = defineComponent<string>({ name: 'obsExtDoc', reducer: (a, b) => a + b });
  const world = createWorld();
  const changes: ExternalChange[] = [];
  world.observe({ onExternalChange: (change) => changes.push(change) });

  world.use(defineSystem({ name: 'obsExtSys', query: [Doc], run: () => {} }));
  world.register('model:test', { generate: () => {} });
  const e = world.spawn(Doc('a'));
  e.add(Doc, 'b');
  e.remove(Doc);
  e.set(Doc, 'c');
  const snap = world.snapshot();
  e.despawn();
  world.load(snap);

  expect(changes).toEqual([
    { kind: 'systems' },
    { kind: 'resource', name: 'model:test' },
    { kind: 'spawn', entity: e.id },
    { kind: 'write', entity: e.id, component: 'obsExtDoc' },
    { kind: 'remove', entity: e.id, component: 'obsExtDoc' },
    { kind: 'write', entity: e.id, component: 'obsExtDoc' },
    { kind: 'despawn', entity: e.id },
    { kind: 'load' },
  ]);
});

test('T26 introspection: systems()/resources()/listComponents()/running (R47)', async () => {
  const Topic = defineComponent<string>({ name: 'obsTopic' });
  const _Draft = defineComponent<string[]>({ name: 'obsDraft', reducer: append });
  const _Hidden = defineComponent<number>({ name: 'obsHidden', transient: true });
  const Busy = defineTag('obsBusy');

  const world = createWorld({ persistence: new MemoryAdapter() });
  world.use(
    defineSystem({
      name: 'obsGlobal',
      query: [Topic],
      when: () => true,
      run: () => {},
    }),
  );
  const writer = defineAgent({
    name: 'obsWriter',
    components: [Topic('t')],
    systems: [
      defineSystem({
        name: 'draft',
        query: [Topic, { not: Busy }],
        run: () => {},
      }),
    ],
  });
  world.use(writer);
  world.register('model:obs', {});

  expect(world.systems()).toEqual([
    {
      key: 'obsGlobal',
      name: 'obsGlobal',
      query: { include: ['obsTopic'], exclude: [] },
      hasGuard: true,
    },
    {
      key: 'obsWriter:draft',
      name: 'draft',
      agent: 'obsWriter',
      query: { include: ['agent:obsWriter', 'obsTopic'], exclude: ['obsBusy'] },
      hasGuard: false,
    },
  ]);
  expect(world.resources()).toEqual(['model:obs']);

  const byName = new Map(listComponents().map((c) => [c.name, c]));
  expect(byName.get('obsTopic')).toEqual({
    name: 'obsTopic',
    tag: false,
    reducer: false,
    transient: false,
  });
  expect(byName.get('obsDraft')).toMatchObject({ reducer: true });
  expect(byName.get('obsHidden')).toMatchObject({ transient: true });
  expect(byName.get('obsBusy')).toMatchObject({ tag: true });
  expect(byName.get('agent:obsWriter')).toMatchObject({ tag: true });
  // Engine built-ins live in the same registry (R9–R11).
  expect(byName.has('SystemError')).toBe(true);
  expect(byName.has('AwaitingHuman')).toBe(true);
});

test('T24 wrapSystemRun hardening: a swallowing wrapper cannot turn a throw into a partial commit (R31)', async () => {
  const In = defineComponent<number>({ name: 'obsSwIn' });
  const A = defineComponent<string>({ name: 'obsSwA' });
  const world = createWorld();
  world.use(
    defineSystem({
      name: 'obsSwBoom',
      query: [In],
      run: (e) => {
        e.add(A, 'written-before-throw');
        throw new Error('after first write');
      },
    }),
  );
  const e = world.spawn(In(1));

  world.observe({
    wrapSystemRun: async (_info, fn) => {
      try {
        await fn();
      } catch {
        // Contract violation on purpose (R46): swallow the rejection.
      }
    },
  });

  const result = await world.run();
  // The engine re-asserts the system's own failure: buffer discarded entirely
  // (no partial A write), SystemError recorded, status 'error'.
  expect(result.status).toBe('error');
  expect(world.entity(e.id)?.has(A)).toBe(false);
  expect(result.errors[0]?.records[0]).toMatchObject({
    system: 'obsSwBoom',
    error: { message: 'after first write' },
  });
});

test('T23 detach idempotency is per registration: double-detach never removes a sibling (R45)', () => {
  const C = defineComponent<number>({ name: 'obsDetC' });
  const world = createWorld();
  let calls = 0;
  const observer = { onExternalChange: () => calls++ };
  const detach1 = world.observe(observer);
  world.observe(observer);

  world.spawn(C(1));
  expect(calls).toBe(2); // attached twice → notified twice

  detach1();
  detach1(); // idempotent — must NOT remove the second registration
  calls = 0;
  world.spawn(C(2));
  expect(calls).toBe(1);
});

test('T23 counter caveat: step:applied fires before world.step increments; event.step is the label (R45)', async () => {
  const C = defineComponent<number>({ name: 'obsStepC' });
  const D = defineTag('obsStepD');
  const world = createWorld();
  world.use(defineSystem({ name: 'obsStepSys', query: [C], run: (e) => e.add(D) }));
  world.spawn(C(1));

  let seen: { eventStep: number; worldStep: number; snapStep: number } | undefined;
  world.observe({
    onEvent: (event) => {
      if (event.type === 'step:applied') {
        seen = { eventStep: event.step, worldStep: world.step, snapStep: world.snapshot().step };
      }
    },
  });
  await world.run();
  expect(seen).toEqual({ eventStep: 1, worldStep: 0, snapStep: 0 });
  expect(world.step).toBe(1);
});
