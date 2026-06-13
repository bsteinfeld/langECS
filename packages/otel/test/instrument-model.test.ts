// instrumentModel: GenAI chat spans, token usage, content capture, errors.

import type { Model, ModelResult } from '@langecs/core';
import { scriptedModel } from '@langecs/core';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, expect, test, vi } from 'vitest';
import { instrumentModel, instrumentTool } from '../src/index';

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

afterEach(() => {
  vi.unstubAllEnvs();
});

test('generate: chat span with operation/provider/request-model and finish reasons', async () => {
  const { exporter, provider } = setup();
  const model = instrumentModel(scriptedModel([{ role: 'assistant', content: 'hi there' }]), {
    provider: 'openai',
    model: 'gpt-test',
    tracerProvider: provider,
  });
  const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
  expect(result.message.content).toBe('hi there');

  const span = one(exporter);
  expect(span.name).toBe('chat gpt-test');
  expect(span.kind).toBe(SpanKind.CLIENT);
  expect(span.attributes['gen_ai.operation.name']).toBe('chat');
  expect(span.attributes['gen_ai.provider.name']).toBe('openai');
  expect(span.attributes['gen_ai.request.model']).toBe('gpt-test');
  // scriptedModel reports finishReason 'stop' and no usage.
  expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  expect(span.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  expect(span.attributes['gen_ai.usage.output_tokens']).toBeUndefined();
  // Content capture defaults off (env var unset).
  expect(span.attributes['gen_ai.input.messages']).toBeUndefined();
  expect(span.attributes['gen_ai.output.messages']).toBeUndefined();
});

test('usage tokens from ModelResult land as gen_ai.usage.* attributes', async () => {
  const { exporter, provider } = setup();
  // scriptedModel never sets usage — hand-roll a model that does.
  const usageModel: Model = {
    async generate(): Promise<ModelResult> {
      return {
        message: { role: 'assistant', content: 'counted' },
        usage: { inputTokens: 7, outputTokens: 3 },
        finishReason: 'stop',
      };
    },
  };
  const model = instrumentModel(usageModel, { model: 'm', tracerProvider: provider });
  await model.generate({ messages: [] });

  const span = one(exporter);
  expect(span.attributes['gen_ai.usage.input_tokens']).toBe(7);
  expect(span.attributes['gen_ai.usage.output_tokens']).toBe(3);
});

test('captureMessageContent: input/output messages captured as JSON', async () => {
  const { exporter, provider } = setup();
  const model = instrumentModel(scriptedModel([{ role: 'assistant', content: 'out' }]), {
    model: 'm',
    tracerProvider: provider,
    captureMessageContent: true,
  });
  await model.generate({ messages: [{ role: 'user', content: 'in' }] });

  const span = one(exporter);
  expect(span.attributes['gen_ai.input.messages']).toBe(
    JSON.stringify([{ role: 'user', content: 'in' }]),
  );
  expect(span.attributes['gen_ai.output.messages']).toBe(
    JSON.stringify([{ role: 'assistant', content: 'out' }]),
  );
});

test('captureMessageContent default reads OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', async () => {
  vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');
  const { exporter, provider } = setup();
  const model = instrumentModel(scriptedModel([{ role: 'assistant', content: 'out' }]), {
    model: 'm',
    tracerProvider: provider,
  });
  await model.generate({ messages: [{ role: 'user', content: 'in' }] });
  expect(one(exporter).attributes['gen_ai.input.messages']).toBe(
    JSON.stringify([{ role: 'user', content: 'in' }]),
  );
});

test('explicit captureMessageContent: false wins over the env var', async () => {
  vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');
  const { exporter, provider } = setup();
  const model = instrumentModel(scriptedModel([{ role: 'assistant', content: 'out' }]), {
    model: 'm',
    tracerProvider: provider,
    captureMessageContent: false,
  });
  await model.generate({ messages: [{ role: 'user', content: 'in' }] });
  expect(one(exporter).attributes['gen_ai.input.messages']).toBeUndefined();
});

test('model error: recordException + ERROR + error.type, rethrown', async () => {
  const { exporter, provider } = setup();
  const failing: Model = {
    async generate(): Promise<ModelResult> {
      throw new TypeError('rate limited');
    },
  };
  const model = instrumentModel(failing, { model: 'm', tracerProvider: provider });
  await expect(model.generate({ messages: [] })).rejects.toThrow('rate limited');

  const span = one(exporter);
  expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(span.attributes['error.type']).toBe('TypeError');
  expect(span.events.find((e) => e.name === 'exception')?.attributes?.['exception.message']).toBe(
    'rate limited',
  );
});

test('stream is wrapped when present and absent when the model has none', async () => {
  const { exporter, provider } = setup();

  const noStream: Model = {
    async generate(): Promise<ModelResult> {
      return { message: { role: 'assistant', content: 'x' } };
    },
  };
  expect(instrumentModel(noStream, { tracerProvider: provider }).stream).toBeUndefined();

  const streaming = instrumentModel(scriptedModel([{ role: 'assistant', content: 'abcd' }]), {
    model: 'm',
    tracerProvider: provider,
  });
  const chunks: string[] = [];
  const result = await streaming.stream?.({ messages: [] }, (d) => {
    if (d.text !== undefined) chunks.push(d.text);
  });
  expect(result?.message.content).toBe('abcd');
  expect(chunks.join('')).toBe('abcd');
  const span = one(exporter); // only the stream call produced a span
  expect(span.name).toBe('chat m');
});

test('span name falls back to "chat unknown" without a model option', async () => {
  const { exporter, provider } = setup();
  const model = instrumentModel(scriptedModel([{ role: 'assistant', content: 'x' }]), {
    tracerProvider: provider,
  });
  await model.generate({ messages: [] });
  const span = one(exporter);
  expect(span.name).toBe('chat unknown');
  expect(span.attributes['gen_ai.request.model']).toBeUndefined();
});

test('idempotent: re-instrumenting a wrapped model (or tool) is a no-op — one span, not two', async () => {
  const { exporter, provider } = setup();
  const wrapped = instrumentModel(scriptedModel([{ role: 'assistant', content: 'once' }]), {
    model: 'gpt-test',
    tracerProvider: provider,
  });
  // The wrapResources auto-wrap path calls instrumentModel on whatever was
  // registered — when that is already a wrapper, it must come back unchanged.
  const rewrapped = instrumentModel(wrapped, { model: 'other', tracerProvider: provider });
  expect(rewrapped).toBe(wrapped);

  await rewrapped.generate({ messages: [{ role: 'user', content: 'hi' }] });
  expect(one(exporter).name).toBe('chat gpt-test');

  const tool = instrumentTool({ name: 'calc', execute: () => 42 }, { tracerProvider: provider });
  expect(instrumentTool(tool, { tracerProvider: provider })).toBe(tool);
});
