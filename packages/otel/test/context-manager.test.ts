// The one test that registers a global context manager: with
// AsyncLocalStorageContextManager installed (what NodeSDK/NodeTracerProvider
// set up), a model span created by user code *inside a system* nests under
// that system's span, because wrapSystemRun makes the system span active
// (R46). Also proves the caller's active span parents the run span.

import {
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  type Model,
  Not,
  scriptedModel,
} from '@langecs/core';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { instrumentWorld } from '../src/index';

const manager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  manager.enable();
  context.setGlobalContextManager(manager);
});

afterAll(() => {
  context.disable(); // remove the global manager again
  manager.disable();
});

const NestDoc = defineComponent<string>({ name: 'otcNestDoc' });
const NestDone = defineTag('otcNestDone');

test('model span nests under the system span; caller span parents the run span', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const world = createWorld({ id: 'otc-nest' });
  world.use(
    defineSystem({
      name: 'otcCallModel',
      query: [NestDoc, Not(NestDone)],
      run: async (e, ctx) => {
        const model = ctx.resource<Model>('model:main');
        await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
        e.add(NestDone);
      },
    }),
  );
  world.spawn(NestDoc('x'));

  const detach = instrumentWorld(world, { tracerProvider: provider });
  world.register('model:main', scriptedModel([{ role: 'assistant', content: 'yo' }]));

  // The run:start tap is synchronous inside world.run(), so the caller's
  // active span becomes the run span's parent.
  const caller = provider.getTracer('test').startSpan('caller');
  await context.with(trace.setSpan(context.active(), caller), () => world.run());
  caller.end();
  detach();

  const spans = exporter.getFinishedSpans();
  const find = (name: string): ReadableSpan => {
    const span = spans.find((s) => s.name === name);
    expect(span, `expected span "${name}"`).toBeDefined();
    return span as ReadableSpan;
  };
  const chat = find('chat model:main');
  const system = find('langecs.system otcCallModel');
  const run = find('langecs.run');
  const callerSpan = find('caller');

  expect(chat.parentSpanContext?.spanId).toBe(system.spanContext().spanId);
  expect(run.parentSpanContext?.spanId).toBe(callerSpan.spanContext().spanId);
  // Everything shares the caller's trace.
  expect(chat.spanContext().traceId).toBe(callerSpan.spanContext().traceId);
});
