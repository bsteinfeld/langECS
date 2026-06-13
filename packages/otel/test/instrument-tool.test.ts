// instrumentTool: execute_tool spans, error recording, property preservation.

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { instrumentTool } from '../src/index';

const setup = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
};

const one = (exporter: InMemorySpanExporter): ReadableSpan => {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
};

test('execute span: name, kind, gen_ai attrs; async result awaited; props preserved', async () => {
  const { exporter, provider } = setup();
  const tool = {
    name: 'lookup',
    description: 'looks things up',
    parameters: { type: 'object' },
    needsApproval: true,
    execute: async (args: unknown) => `found:${(args as { q: string }).q}`,
  };
  const wrapped = instrumentTool(tool, { tracerProvider: provider });

  // Every non-execute property survives the wrap (spread of the original).
  expect(wrapped.name).toBe('lookup');
  expect(wrapped.description).toBe('looks things up');
  expect(wrapped.parameters).toEqual({ type: 'object' });
  expect(wrapped.needsApproval).toBe(true);

  await expect(wrapped.execute({ q: 'x' })).resolves.toBe('found:x');
  const span = one(exporter);
  expect(span.name).toBe('execute_tool lookup');
  expect(span.kind).toBe(SpanKind.INTERNAL);
  expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool');
  expect(span.attributes['gen_ai.tool.name']).toBe('lookup');
  expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
});

test('sync results are awaited into a resolved promise', async () => {
  const { exporter, provider } = setup();
  const wrapped = instrumentTool(
    { name: 'sync', execute: () => 41 + 1 },
    { tracerProvider: provider },
  );
  await expect(wrapped.execute()).resolves.toBe(42);
  expect(one(exporter).name).toBe('execute_tool sync');
});

test('throwing tool: recordException + ERROR + error.type, rethrown', async () => {
  const { exporter, provider } = setup();
  const wrapped = instrumentTool(
    {
      name: 'broken',
      execute: () => {
        throw new RangeError('out of range');
      },
    },
    { tracerProvider: provider },
  );
  await expect(wrapped.execute()).rejects.toThrow('out of range');

  const span = one(exporter);
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes['error.type']).toBe('RangeError');
  expect(span.events.find((e) => e.name === 'exception')?.attributes?.['exception.message']).toBe(
    'out of range',
  );
});
