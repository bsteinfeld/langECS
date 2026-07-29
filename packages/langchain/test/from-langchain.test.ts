import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  type ToolMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import {
  FakeChatModel,
  FakeListChatModel,
  FakeStreamingChatModel,
} from '@langchain/core/utils/testing';
import type { ModelRequest } from '@langecs/core';
import { describe, expect, it } from 'vitest';
import { fromLangChain } from '../src/index';

/** Minimal scripted chat model that records every `_generate` input. */
class CapturingChatModel extends BaseChatModel {
  received: BaseMessage[][] = [];
  /** Parsed call options per invocation — how `signal` forwarding is asserted (R49). */
  receivedOptions: { signal?: AbortSignal }[] = [];
  boundTools: BindToolsInput[] | undefined;
  private readonly responses: AIMessage[];
  private i = 0;

  constructor(responses: AIMessage[]) {
    super({});
    this.responses = responses;
  }

  _llmType(): string {
    return 'capturing';
  }

  override bindTools(tools: BindToolsInput[]) {
    this.boundTools = tools;
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    this.received.push(messages);
    this.receivedOptions.push({ ...(options ?? {}) });
    const message = this.responses[this.i];
    if (message === undefined) throw new Error('CapturingChatModel: out of scripted responses');
    this.i += 1;
    return { generations: [{ message, text: message.text }] };
  }
}

const userReq = (content: string): ModelRequest => ({ messages: [{ role: 'user', content }] });

describe('fromLangChain · generate', () => {
  it('returns the assistant reply from a FakeListChatModel', async () => {
    const model = fromLangChain(new FakeListChatModel({ responses: ['hello there'] }));
    const result = await model.generate(userReq('hi'));
    expect(result.message).toEqual({ role: 'assistant', content: 'hello there' });
  });

  it('sends the full converted conversation to the chat model', async () => {
    const lc = new CapturingChatModel([new AIMessage('done')]);
    const model = fromLangChain(lc);
    await model.generate({
      system: 'be terse',
      messages: [
        { role: 'user', content: 'add 1 and 2' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'add', args: { a: 1, b: 2 } }],
        },
        { role: 'tool', content: '3', toolCallId: 'c1', name: 'add' },
      ],
    });

    const sent = lc.received[0];
    expect(sent?.map((m) => m.getType())).toEqual(['system', 'human', 'ai', 'tool']);
    expect(sent?.[0]).toBeInstanceOf(SystemMessage);
    expect(sent?.[1]).toBeInstanceOf(HumanMessage);
    const ai = sent?.[2] as AIMessage;
    expect(ai.tool_calls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'add', args: { a: 1, b: 2 } },
    ]);
    const tool = sent?.[3] as ToolMessage;
    expect(tool.tool_call_id).toBe('c1');
    expect(tool.content).toBe('3');
  });

  it('maps tool_calls, usage_metadata and finish_reason from the response', async () => {
    const lc = new CapturingChatModel([
      new AIMessage({
        content: '',
        tool_calls: [{ type: 'tool_call', id: 'call_7', name: 'add', args: { a: 1, b: 2 } }],
        usage_metadata: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
        response_metadata: { finish_reason: 'tool_calls' },
      }),
    ]);
    const result = await fromLangChain(lc).generate(userReq('add 1 and 2'));

    expect(result.message.toolCalls).toEqual([{ id: 'call_7', name: 'add', args: { a: 1, b: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.raw).toBeInstanceOf(AIMessage);
  });
});

describe('fromLangChain · tools', () => {
  const tools = [
    {
      name: 'add',
      description: 'adds two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    },
  ];

  it('binds ToolSpecs via bindTools when tools are provided', async () => {
    const lc = new CapturingChatModel([new AIMessage('ok')]);
    await fromLangChain(lc).generate({ ...userReq('hi'), tools });
    expect(lc.boundTools).toEqual([
      {
        name: 'add',
        description: 'adds two numbers',
        schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      },
    ]);
  });

  it('does not call bindTools when the request has no tools', async () => {
    const lc = new CapturingChatModel([new AIMessage('ok')]);
    await fromLangChain(lc).generate(userReq('hi'));
    expect(lc.boundTools).toBeUndefined();
  });

  it('works end-to-end against the fake bindTools implementation', async () => {
    const model = fromLangChain(new FakeListChatModel({ responses: ['bound ok'] }));
    const result = await model.generate({ ...userReq('hi'), tools });
    expect(result.message.content).toBe('bound ok');
  });

  it('throws a descriptive error when the model lacks bindTools', async () => {
    const model = fromLangChain(new FakeChatModel({}));
    await expect(model.generate({ ...userReq('hi'), tools })).rejects.toThrow(/bindTools/);
  });
});

describe('fromLangChain · stream', () => {
  it('streams text chunks and returns the assembled final message', async () => {
    const model = fromLangChain(new FakeListChatModel({ responses: ['stream me'] }));
    const chunks: string[] = [];
    const result = await model.stream?.(userReq('hi'), (d) => {
      if (d.text !== undefined) chunks.push(d.text);
    });

    expect(chunks.length).toBeGreaterThan(1); // FakeListChatModel streams per character
    expect(chunks.join('')).toBe('stream me');
    expect(result?.message).toEqual({ role: 'assistant', content: 'stream me' });
  });

  it('accumulates tool calls emitted mid-stream', async () => {
    const lc = new FakeStreamingChatModel({
      chunks: [
        new AIMessageChunk({ content: 'calling ' }),
        new AIMessageChunk({
          content: 'add',
          tool_calls: [{ type: 'tool_call', id: 'call_1', name: 'add', args: { a: 1, b: 2 } }],
        }),
      ],
    });
    const chunks: string[] = [];
    const result = await fromLangChain(lc).stream?.(userReq('add'), (d) => {
      if (d.text !== undefined) chunks.push(d.text);
    });

    expect(chunks).toEqual(['calling ', 'add']);
    expect(result?.message.content).toBe('calling add');
    expect(result?.message.toolCalls).toEqual([
      { id: 'call_1', name: 'add', args: { a: 1, b: 2 } },
    ]);
  });

  it('falls back to a single chunk for models without native streaming', async () => {
    const lc = new CapturingChatModel([new AIMessage('no streaming here')]);
    const chunks: string[] = [];
    const result = await fromLangChain(lc).stream?.(userReq('hi'), (d) => {
      if (d.text !== undefined) chunks.push(d.text);
    });

    expect(chunks).toEqual(['no streaming here']);
    expect(result?.message.content).toBe('no streaming here');
  });
});

describe('fromLangChain · cancellation (R49)', () => {
  it('forwards req.signal as the call-time signal option', async () => {
    const lc = new CapturingChatModel([new AIMessage('done')]);
    const controller = new AbortController();
    await fromLangChain(lc).generate({ ...userReq('hi'), signal: controller.signal });
    // Unlike the sampling knobs, `signal` IS a portable call-time option, so it
    // reaches the provider request rather than being dropped.
    expect(lc.receivedOptions[0]?.signal).toBe(controller.signal);
  });

  it('omits the option entirely when no signal is supplied', async () => {
    const lc = new CapturingChatModel([new AIMessage('done')]);
    await fromLangChain(lc).generate(userReq('hi'));
    expect(lc.receivedOptions[0]?.signal).toBeUndefined();
  });

  it('rejects an already-aborted request without calling the model', async () => {
    const lc = new CapturingChatModel([new AIMessage('never delivered')]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fromLangChain(lc).generate({ ...userReq('hi'), signal: controller.signal }),
    ).rejects.toThrow();
    expect(lc.received).toEqual([]);
  });

  it('rejects an already-aborted stream without calling the model', async () => {
    const lc = new CapturingChatModel([new AIMessage('never delivered')]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fromLangChain(lc).stream?.({ ...userReq('hi'), signal: controller.signal }, () => {}),
    ).rejects.toThrow();
    expect(lc.received).toEqual([]);
  });
});

/**
 * A chat model that ignores the `signal` call option entirely: it aborts the
 * caller's controller partway and then completes normally. R49's "reject, never
 * resolve" must hold against a provider like this, not only against ones that
 * cooperate.
 */
class SignalIgnoringChatModel extends BaseChatModel {
  constructor(private readonly abortNow: () => void) {
    super({});
  }
  _llmType() {
    return 'signal-ignoring';
  }
  async _generate(): Promise<ChatResult> {
    this.abortNow();
    return { generations: [{ text: 'late reply', message: new AIMessage('late reply') }] };
  }
  async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    yield new ChatGenerationChunk({ text: 'Par', message: new AIMessageChunk('Par') });
    yield new ChatGenerationChunk({ text: 'tial', message: new AIMessageChunk('tial') });
    // Abort only after the last chunk, so the adapter's for-await loop has
    // already drained: the check *after* the loop is what must reject here.
    this.abortNow();
  }
}

describe('fromLangChain · cancellation mid-flight (R49)', () => {
  it('generate() rejects when the signal aborts mid-flight, even if the model ignores it', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-flight');
    const lc = new SignalIgnoringChatModel(() => controller.abort(reason));
    await expect(
      fromLangChain(lc).generate({ ...userReq('hi'), signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  // Contract test, not a test of the adapter's own check: @langchain/core
  // already calls `signal.throwIfAborted()` internally on this path. It pins
  // R49 for the stream path regardless of which layer enforces it; the
  // adapter's post-loop check is the backstop if that ever changes.
  it('stream() rejects rather than resolving a result built from a cancelled call', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled mid-stream');
    const lc = new SignalIgnoringChatModel(() => controller.abort(reason));
    const chunks: string[] = [];
    await expect(
      fromLangChain(lc).stream?.({ ...userReq('hi'), signal: controller.signal }, (d) => {
        if (d.text) chunks.push(d.text);
      }),
    ).rejects.toBe(reason);
    // Chunks already forwarded stay forwarded; what must not happen is
    // resolving a ModelResult built from a cancelled call.
    expect(chunks).toEqual(['Par', 'tial']);
  });
});
