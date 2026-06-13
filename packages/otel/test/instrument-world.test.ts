// instrumentWorld: run/step/system span tree, errors, events, wrapResources.
// Deterministic — in-memory exporter, no global providers, zero network.

import {
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  type Model,
  Not,
  scriptedModel,
} from '@langecs/core';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { instrumentWorld } from '../src/index';

const setup = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
};

const byName = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const span = spans.find((s) => s.name === name);
  expect(span, `expected a span named "${name}"`).toBeDefined();
  return span as ReadableSpan;
};

// ---------------------------------------------------------------- span tree

const TreeDoc = defineComponent<string>({ name: 'otwTreeDoc' });
const TreeDone = defineTag('otwTreeDone');

test('run/step/system spans form a tree with run attributes and OK status', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-tree' });
  world.use(
    defineSystem({
      name: 'otwTreeFinish',
      query: [TreeDoc, Not(TreeDone)],
      run: (e) => {
        e.add(TreeDone);
      },
    }),
  );
  const entity = world.spawn(TreeDoc('hello'));
  const detach = instrumentWorld(world, { tracerProvider: provider });
  await world.run();
  detach();

  const spans = exporter.getFinishedSpans();
  const run = byName(spans, 'langecs.run');
  const step = byName(spans, 'langecs.step');
  const system = byName(spans, 'langecs.system otwTreeFinish');
  expect(spans).toHaveLength(3);

  // Parent links: system -> step -> run -> (none).
  expect(system.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
  expect(step.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
  expect(run.parentSpanContext).toBeUndefined();
  // One trace.
  expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

  expect(run.kind).toBe(SpanKind.INTERNAL);
  expect(run.status.code).toBe(SpanStatusCode.OK);
  expect(run.attributes['langecs.world.id']).toBe('otw-tree');
  expect(typeof run.attributes['langecs.run.id']).toBe('string');
  expect(run.attributes['langecs.run.status']).toBe('done');
  expect(run.attributes['langecs.run.steps']).toBe(1);

  expect(step.attributes['langecs.scheduled.count']).toBe(1);
  expect(step.attributes['langecs.changes.count']).toBe(1);
  expect(step.attributes['langecs.spawned.count']).toBe(0);
  expect(step.attributes['langecs.despawned.count']).toBe(0);
  expect(typeof step.attributes['langecs.step.number']).toBe('number');

  expect(system.kind).toBe(SpanKind.INTERNAL);
  expect(system.attributes['langecs.system.key']).toBe('otwTreeFinish');
  expect(system.attributes['langecs.system.name']).toBe('otwTreeFinish');
  expect(system.attributes['langecs.entity.id']).toBe(entity.id);
});

// ------------------------------------------------------------ system errors

const BoomDoc = defineComponent<string>({ name: 'otwBoomDoc' });

test('throwing system run: ERROR status, exception event, error.type; run span ERROR', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-boom' });
  world.use(
    defineSystem({
      name: 'otwBoom',
      query: [BoomDoc],
      run: () => {
        throw new RangeError('kaboom');
      },
    }),
  );
  world.spawn(BoomDoc('x'));
  const detach = instrumentWorld(world, { tracerProvider: provider });
  await world.run();
  detach();

  const spans = exporter.getFinishedSpans();
  const systemSpans = spans.filter((s) => s.name === 'langecs.system otwBoom');
  expect(systemSpans).toHaveLength(1); // wrapper-owned; system:error must not duplicate it
  const system = systemSpans[0] as ReadableSpan;
  expect(system.status.code).toBe(SpanStatusCode.ERROR);
  expect(system.status.message).toBe('kaboom');
  expect(system.attributes['error.type']).toBe('RangeError');
  const exception = system.events.find((e) => e.name === 'exception');
  expect(exception?.attributes?.['exception.message']).toBe('kaboom');

  const run = byName(spans, 'langecs.run');
  expect(run.status.code).toBe(SpanStatusCode.ERROR);
  expect(run.attributes['langecs.run.status']).toBe('error');
});

const GuardDoc = defineComponent<string>({ name: 'otwGuardDoc' });

test('throwing when guard (no wrapSystemRun): synthesized ERROR span under the step span', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-guard' });
  world.use(
    defineSystem({
      name: 'otwGuarded',
      query: [GuardDoc],
      when: () => {
        throw new Error('guard boom');
      },
      run: () => {},
    }),
  );
  world.spawn(GuardDoc('x'));
  const detach = instrumentWorld(world, { tracerProvider: provider });
  await world.run();
  detach();

  const spans = exporter.getFinishedSpans();
  const systemSpans = spans.filter((s) => s.name === 'langecs.system otwGuarded');
  expect(systemSpans).toHaveLength(1);
  const system = systemSpans[0] as ReadableSpan;
  expect(system.status.code).toBe(SpanStatusCode.ERROR);
  expect(system.events.find((e) => e.name === 'exception')?.attributes?.['exception.message']).toBe(
    'guard boom',
  );
  const step = byName(spans, 'langecs.step');
  expect(system.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
});

// ----------------------------------------------------------- emit + changes

const EmitDoc = defineComponent<string>({ name: 'otwEmitDoc' });
const EmitDone = defineTag('otwEmitDone');

test('ctx.emit lands as a langecs.emit event on the open system span', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-emit' });
  world.use(
    defineSystem({
      name: 'otwEmitter',
      query: [EmitDoc, Not(EmitDone)],
      run: (e, ctx) => {
        ctx.emit({ progress: 0.5 });
        e.add(EmitDone);
      },
    }),
  );
  world.spawn(EmitDoc('x'));
  const detach = instrumentWorld(world, { tracerProvider: provider });
  await world.run();
  detach();

  const system = byName(exporter.getFinishedSpans(), 'langecs.system otwEmitter');
  const event = system.events.find((e) => e.name === 'langecs.emit');
  expect(event?.attributes?.['langecs.emit.data']).toBe('{"progress":0.5}');
});

const ChangeDoc = defineComponent<string>({ name: 'otwChangeDoc' });
const ChangeOut = defineComponent<string>({ name: 'otwChangeOut' });

test('captureChanges: step span gets a langecs.change event per committed change', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-changes' });
  world.use(
    defineSystem({
      name: 'otwChanger',
      query: [ChangeDoc, Not(ChangeOut)],
      run: (e) => {
        e.add(ChangeOut, 'result-value');
      },
    }),
  );
  const entity = world.spawn(ChangeDoc('x'));
  const detach = instrumentWorld(world, { tracerProvider: provider, captureChanges: true });
  await world.run();
  detach();

  const step = byName(exporter.getFinishedSpans(), 'langecs.step');
  const changes = step.events.filter((e) => e.name === 'langecs.change');
  expect(changes).toHaveLength(1);
  expect(changes[0]?.attributes).toMatchObject({
    entity: entity.id,
    component: 'otwChangeOut',
    kind: 'set',
    value: '"result-value"',
  });
});

test('captureChanges off by default: no langecs.change events', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-nochanges' });
  world.use(
    defineSystem({
      name: 'otwChangerOff',
      query: [ChangeDoc, Not(ChangeOut)],
      run: (e) => {
        e.add(ChangeOut, 'v');
      },
    }),
  );
  world.spawn(ChangeDoc('x'));
  const detach = instrumentWorld(world, { tracerProvider: provider });
  await world.run();
  detach();

  const step = byName(exporter.getFinishedSpans(), 'langecs.step');
  expect(step.events.filter((e) => e.name === 'langecs.change')).toHaveLength(0);
});

// ------------------------------------------------------------ wrapResources

const ResDoc = defineComponent<string>({ name: 'otwResDoc' });
const ResDone = defineTag('otwResDone');

interface ToolLike {
  name: string;
  description?: string;
  execute: (args: unknown) => unknown;
}

test('wrapResources: models and tool: resources registered after instrumentWorld are auto-wrapped', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-res' });
  let seenDescription: string | undefined;
  world.use(
    defineSystem({
      name: 'otwResUser',
      query: [ResDoc, Not(ResDone)],
      run: async (e, ctx) => {
        const model = ctx.resource<Model>('model:main');
        await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
        const tool = ctx.resource<ToolLike>('tool:add');
        seenDescription = tool.description; // other properties survive the wrap
        await tool.execute({ a: 1 });
        e.add(ResDone);
      },
    }),
  );
  world.spawn(ResDoc('x'));

  const detach = instrumentWorld(world, { tracerProvider: provider });
  world.register('model:main', scriptedModel([{ role: 'assistant', content: 'yo' }]));
  world.register('tool:add', {
    name: 'add',
    description: 'adds things',
    execute: (args: unknown) => (args as { a: number }).a + 1,
  });
  await world.run();
  detach();

  const spans = exporter.getFinishedSpans();
  expect(seenDescription).toBe('adds things');
  const chat = byName(spans, 'chat model:main');
  expect(chat.attributes['gen_ai.request.model']).toBe('model:main');
  const tool = byName(spans, 'execute_tool add');
  expect(tool.attributes['gen_ai.tool.name']).toBe('add');
});

test('non-model, non-tool resources pass through wrapResources untouched', async () => {
  const { provider } = setup();
  const world = createWorld({ id: 'otw-res-plain' });
  const detach = instrumentWorld(world, { tracerProvider: provider });
  const db = { query: () => 42 };
  world.register('db:main', db);
  detach();
  // Same reference back out: read it through a guard ctx-free path — register
  // is restored, so a second registration after detach also passes through.
  let seen: unknown;
  world.use(
    defineSystem({
      name: 'otwResPlainReader',
      query: [ResDoc],
      run: (_e, ctx) => {
        seen = ctx.resource('db:main');
      },
    }),
  );
  world.spawn(ResDoc('x'));
  await world.run();
  expect(seen).toBe(db);
});

// ------------------------------------------------------------------- detach

const DetachDoc = defineComponent<string>({ name: 'otwDetachDoc' });
const DetachDone = defineTag('otwDetachDone');

test('detach restores world.register and stops producing spans; idempotent', async () => {
  const { exporter, provider } = setup();
  const world = createWorld({ id: 'otw-detach' });
  world.use(
    defineSystem({
      name: 'otwDetachFinish',
      query: [DetachDoc, Not(DetachDone)],
      run: (e) => {
        e.add(DetachDone);
      },
    }),
  );

  const detach = instrumentWorld(world, { tracerProvider: provider });
  expect(Object.hasOwn(world, 'register')).toBe(true); // patched instance property
  detach();
  detach(); // idempotent
  expect(Object.hasOwn(world, 'register')).toBe(false); // prototype method restored

  exporter.reset();
  world.spawn(DetachDoc('x'));
  await world.run();
  expect(exporter.getFinishedSpans()).toHaveLength(0);
});
