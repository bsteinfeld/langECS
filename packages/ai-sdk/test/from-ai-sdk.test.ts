// Unit tests for fromAiSdk against the AI SDK's MockLanguageModelV3 — no network.

import type { ToolSpec } from '@langecs/core';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, test } from 'vitest';
import { fromAiSdk } from '../src/index';

// Provider-spec types derived from the mock's constructor — `@ai-sdk/provider`
// is a transitive dependency and not directly importable here.
type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>;
type GenerateResult = Extract<NonNullable<MockOptions['doGenerate']>, { content: unknown }>;
type StreamResult = Extract<NonNullable<MockOptions['doStream']>, { stream: unknown }>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
};

const addTool: ToolSpec = {
  name: 'add',
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
};

describe('fromAiSdk generate()', () => {
  test('maps a text response to ModelResult (message/usage/finishReason)', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'Hello!' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message).toEqual({ role: 'assistant', content: 'Hello!' });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
    expect(result.finishReason).toBe('stop');
    expect(result.raw).toBeDefined();
  });

  test('converts the full request: messages, system, tools, temperature, maxTokens', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    await model.generate({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'add 1 and 2' },
        {
          role: 'assistant',
          content: 'calling tool',
          toolCalls: [{ id: 'call_1', name: 'add', args: { a: 1, b: 2 } }],
        },
        { role: 'tool', content: '3', toolCallId: 'call_1', name: 'add' },
      ],
      tools: [addTool],
      temperature: 0.5,
      maxTokens: 99,
    });

    expect(mock.doGenerateCalls).toHaveLength(1);
    const call = mock.doGenerateCalls[0]!;
    expect(call.temperature).toBe(0.5);
    expect(call.maxOutputTokens).toBe(99);
    expect(call.tools).toMatchObject([
      {
        type: 'function',
        name: 'add',
        description: 'Add two numbers',
        inputSchema: addTool.parameters,
      },
    ]);
    expect(call.prompt).toMatchObject([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'add 1 and 2' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: { a: 1, b: 2 } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'add',
            output: { type: 'text', value: '3' },
          },
        ],
      },
    ]);
  });

  test('forwards advanced sampling parameters to the provider call', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    await model.generate({
      messages: [{ role: 'user', content: 'hi' }],
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
      seed: 1234,
      stopSequences: ['STOP'],
    });
    const call = mock.doGenerateCalls[0]!;
    expect(call.topP).toBe(0.9);
    expect(call.topK).toBe(40);
    expect(call.frequencyPenalty).toBe(0.5);
    expect(call.presencePenalty).toBe(0.25);
    expect(call.seed).toBe(1234);
    expect(call.stopSequences).toEqual(['STOP']);
  });

  test('R49 forwards req.signal to the provider call as abortSignal', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const controller = new AbortController();
    await model.generate({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    // Cancellation has to reach the transport, not just the awaiting engine:
    // the SDK aborts the HTTP request from this signal.
    expect(mock.doGenerateCalls[0]?.abortSignal).toBe(controller.signal);
  });

  test('R49 an aborted signal rejects the call', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'never delivered' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      model.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toThrow();
  });

  test('R49 sends no abort signal to the provider when req.signal is unset', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(mock.doGenerateCalls[0]?.abortSignal).toBeUndefined();
    // Deliberately `toBeUndefined()` and not `'abortSignal' in call`: the
    // adapter omits the key (conditional spread in `callOptions`), but the SDK
    // normalizes its own provider-call object with `abortSignal:` always
    // present, so at this observation point the key exists either way. What is
    // assertable — and what matters — is that no signal reaches the provider.
  });

  test('maps reasoning content to Msg.thinking', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [
          { type: 'reasoning', text: 'The user wants a greeting.' },
          { type: 'text', text: 'Hello!' },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message.content).toBe('Hello!');
    expect(result.message.thinking).toBe('The user wants a greeting.');
  });

  test('maps role:system entries inside messages without warnings', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const result = await model.generate({
      messages: [
        { role: 'system', content: 'sys-in-messages' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(mock.doGenerateCalls[0]!.prompt[0]).toMatchObject({
      role: 'system',
      content: 'sys-in-messages',
    });
    expect(result.message.content).toBe('ok');
  });

  test('maps tool calls to Msg.toolCalls with parsed args (single step, unexecuted)', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'add',
            input: '{"a":1,"b":2}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
    });
    const model = fromAiSdk(mock);
    const result = await model.generate({
      messages: [{ role: 'user', content: 'add 1 and 2' }],
      tools: [addTool],
    });
    expect(result.message.role).toBe('assistant');
    expect(result.message.toolCalls).toEqual([{ id: 'call_1', name: 'add', args: { a: 1, b: 2 } }]);
    expect(result.finishReason).toBe('tool-calls');
    // Single LLM step: the adapter never executes tools itself.
    expect(mock.doGenerateCalls).toHaveLength(1);
  });
});

describe('fromAiSdk stream()', () => {
  const streamFrom = (parts: StreamPart[]) =>
    new MockLanguageModelV3({
      doStream: { stream: convertArrayToReadableStream(parts) },
    });

  test('feeds text deltas to onChunk and resolves the full ModelResult', async () => {
    const mock = streamFrom([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hel' },
      { type: 'text-delta', id: 't1', delta: 'lo' },
      { type: 'text-delta', id: 't1', delta: '!' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]);
    const model = fromAiSdk(mock);
    const chunks: string[] = [];
    const result = await model.stream?.({ messages: [{ role: 'user', content: 'hi' }] }, (d) => {
      if (d.text) chunks.push(d.text);
    });
    expect(chunks).toEqual(['Hel', 'lo', '!']);
    expect(result?.message).toEqual({ role: 'assistant', content: 'Hello!' });
    expect(result?.finishReason).toBe('stop');
    expect(result?.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
  });

  test('collects streamed tool calls into Msg.toolCalls', async () => {
    const mock = streamFrom([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call_1', toolName: 'add' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"a":1,"b":2}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: '{"a":1,"b":2}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
    ]);
    const model = fromAiSdk(mock);
    const chunks: string[] = [];
    const result = await model.stream?.(
      { messages: [{ role: 'user', content: 'add 1 and 2' }], tools: [addTool] },
      (d) => {
        if (d.text) chunks.push(d.text);
      },
    );
    expect(chunks).toEqual([]);
    expect(result?.message.toolCalls).toEqual([
      { id: 'call_1', name: 'add', args: { a: 1, b: 2 } },
    ]);
    expect(result?.finishReason).toBe('tool-calls');
  });

  test('captures streamed reasoning into Msg.thinking without forwarding it as text', async () => {
    const mock = streamFrom([
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'think ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'hard' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hi' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]);
    const model = fromAiSdk(mock);
    const chunks: string[] = [];
    const result = await model.stream?.({ messages: [{ role: 'user', content: 'hi' }] }, (d) => {
      if (d.text) chunks.push(d.text);
    });
    expect(chunks).toEqual(['Hi']);
    expect(result?.message.content).toBe('Hi');
    expect(result?.message.thinking).toBe('think hard');
  });

  test('rejects when the stream emits an error part', async () => {
    const mock = streamFrom([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error('boom') },
    ]);
    const model = fromAiSdk(mock);
    await expect(
      model.stream?.({ messages: [{ role: 'user', content: 'hi' }] }, () => {}),
    ).rejects.toThrow('boom');
  });
});

describe('fromAiSdk cancellation (R49)', () => {
  /**
   * A provider that ignores `abortSignal` entirely: it aborts the caller's
   * controller mid-flight and then returns a perfectly normal reply. Real
   * providers vary in how faithfully they honour the signal, and R49's
   * "reject, never resolve" must not depend on their good behaviour.
   */
  const ignoresSignalOnGenerate = (abortNow: () => void) =>
    new MockLanguageModelV3({
      doGenerate: async () => {
        abortNow();
        return {
          content: [{ type: 'text' as const, text: 'late reply' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
          warnings: [],
        };
      },
    });

  test('generate() rejects when the signal aborts mid-flight, even if the provider ignores it', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-flight');
    const model = fromAiSdk(ignoresSignalOnGenerate(() => controller.abort(reason)));
    await expect(
      model.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  // Contract test, not a test of the adapter's own check: `streamText` already
  // rejects with `abortSignal.reason` here. It pins R49 for the stream path
  // regardless of which layer enforces it, so a future SDK release that starts
  // resolving instead fails loudly — the adapter's post-loop check is the
  // backstop that keeps the guarantee independent of the dependency.
  test('stream() rejects rather than resolving a result built from a cancelled call', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-flight');
    // A stream that completes normally, having aborted the caller partway.
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] } as StreamPart);
            c.enqueue({ type: 'text-start', id: 't1' } as StreamPart);
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'Partial' } as StreamPart);
            c.enqueue({ type: 'text-end', id: 't1' } as StreamPart);
            c.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            } as StreamPart);
            c.close();
            controller.abort(reason);
          },
        }),
      },
    });
    await expect(
      fromAiSdk(mock).stream?.(
        { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal },
        () => {},
      ),
    ).rejects.toBe(reason);
  });

  test("stream() surfaces the signal's own reason on an SDK 'abort' part", async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-stream');
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream<StreamPart>({
          async start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] } as StreamPart);
            c.enqueue({ type: 'text-start', id: 't1' } as StreamPart);
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'Par' } as StreamPart);
            await new Promise((r) => setTimeout(r, 10));
            // The SDK turns this into an 'abort' part and closes the stream
            // gracefully; the adapter must reject with this reason, not a
            // generic error, so `err.name`/custom reasons survive.
            controller.abort(reason);
            await new Promise((r) => setTimeout(r, 20));
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'tial' } as StreamPart);
            c.close();
          },
        }),
      },
    });
    const chunks: string[] = [];
    await expect(
      fromAiSdk(mock).stream?.(
        { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal },
        (d) => {
          if (d.text) chunks.push(d.text);
        },
      ),
    ).rejects.toBe(reason);
    expect(chunks).toEqual(['Par']);
  });

  test('stream() abort with no reason rejects with an AbortError, not a generic Error', async () => {
    const controller = new AbortController();
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream<StreamPart>({
          async start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] } as StreamPart);
            c.enqueue({ type: 'text-start', id: 't1' } as StreamPart);
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'Par' } as StreamPart);
            await new Promise((r) => setTimeout(r, 10));
            controller.abort();
            await new Promise((r) => setTimeout(r, 20));
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'tial' } as StreamPart);
            c.close();
          },
        }),
      },
    });
    // Consumers routinely switch on `err.name === 'AbortError'`.
    await expect(
      fromAiSdk(mock).stream?.(
        { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal },
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
