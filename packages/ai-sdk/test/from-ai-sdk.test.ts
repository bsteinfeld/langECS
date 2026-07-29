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

  test('R49 omits abortSignal entirely when req.signal is unset', async () => {
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
