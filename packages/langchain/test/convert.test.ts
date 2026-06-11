import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { Msg } from '@langecs/core';
import { describe, expect, it } from 'vitest';
import {
  fromLangChainMessage,
  toLangChainMessage,
  toLangChainMessages,
  toLangChainTools,
  toModelResult,
} from '../src/index';

describe('toLangChainMessage', () => {
  it('maps system/user/assistant/tool roles to the LangChain message classes', () => {
    expect(toLangChainMessage({ role: 'system', content: 'be terse' })).toBeInstanceOf(
      SystemMessage,
    );
    expect(toLangChainMessage({ role: 'user', content: 'hi' })).toBeInstanceOf(HumanMessage);
    expect(toLangChainMessage({ role: 'assistant', content: 'hello' })).toBeInstanceOf(AIMessage);
    expect(toLangChainMessage({ role: 'tool', content: '3', toolCallId: 'call_1' })).toBeInstanceOf(
      ToolMessage,
    );
  });

  it('preserves content', () => {
    const lc = toLangChainMessage({ role: 'user', content: 'what is 1+2?' });
    expect(lc.content).toBe('what is 1+2?');
  });

  it('converts assistant toolCalls to LangChain tool_calls', () => {
    const msg: Msg = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'add', args: { a: 1, b: 2 } }],
    };
    const lc = toLangChainMessage(msg) as AIMessage;
    expect(lc.tool_calls).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'add', args: { a: 1, b: 2 } },
    ]);
  });

  it('omits tool_calls entirely when the assistant message has none', () => {
    const lc = toLangChainMessage({ role: 'assistant', content: 'plain' }) as AIMessage;
    expect(lc.tool_calls).toEqual([]);
  });

  it('converts tool messages with tool_call_id and name', () => {
    const lc = toLangChainMessage({
      role: 'tool',
      content: '3',
      toolCallId: 'call_1',
      name: 'add',
    }) as ToolMessage;
    expect(lc.tool_call_id).toBe('call_1');
    expect(lc.name).toBe('add');
    expect(lc.content).toBe('3');
  });

  it('throws a descriptive error for a tool message without toolCallId', () => {
    expect(() => toLangChainMessage({ role: 'tool', content: 'oops' })).toThrowError(/toolCallId/);
  });
});

describe('toLangChainMessages', () => {
  it('prepends req.system as a SystemMessage', () => {
    const lc = toLangChainMessages({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(lc).toHaveLength(2);
    expect(lc[0]).toBeInstanceOf(SystemMessage);
    expect(lc[0]?.content).toBe('be helpful');
    expect(lc[1]).toBeInstanceOf(HumanMessage);
  });

  it('converts a whole conversation in order', () => {
    const lc = toLangChainMessages({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
        { role: 'tool', content: 'r', toolCallId: 'c1', name: 't' },
        { role: 'assistant', content: 'done' },
      ],
    });
    expect(lc.map((m) => m.getType())).toEqual(['system', 'human', 'ai', 'tool', 'ai']);
  });
});

describe('toLangChainTools', () => {
  it('maps ToolSpec to StructuredToolParams shape (parameters -> schema)', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    expect(
      toLangChainTools([{ name: 'add', description: 'adds numbers', parameters: schema }]),
    ).toEqual([{ name: 'add', description: 'adds numbers', schema }]);
  });

  it('defaults to an empty object schema when parameters are omitted', () => {
    expect(toLangChainTools([{ name: 'ping' }])).toEqual([
      { name: 'ping', schema: { type: 'object', properties: {} } },
    ]);
  });
});

describe('fromLangChainMessage', () => {
  it('maps an AIMessage to an assistant Msg', () => {
    expect(fromLangChainMessage(new AIMessage('hello'))).toEqual({
      role: 'assistant',
      content: 'hello',
    });
  });

  it('maps tool_calls back to toolCalls', () => {
    const msg = fromLangChainMessage(
      new AIMessage({
        content: '',
        tool_calls: [{ type: 'tool_call', id: 'call_9', name: 'add', args: { a: 1 } }],
      }),
    );
    expect(msg.toolCalls).toEqual([{ id: 'call_9', name: 'add', args: { a: 1 } }]);
  });

  it('generates a fallback id when a tool call has none', () => {
    const msg = fromLangChainMessage(
      new AIMessage({ content: '', tool_calls: [{ name: 'add', args: {} }] }),
    );
    expect(msg.toolCalls?.[0]?.id).toBe('call_0');
  });

  it('flattens text content blocks via .text', () => {
    const msg = fromLangChainMessage(
      new AIMessage({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      }),
    );
    expect(msg.content).toBe('Hello world');
  });
});

describe('toModelResult', () => {
  it('maps usage_metadata and finish_reason, and keeps the raw message', () => {
    const lc = new AIMessage({
      content: 'hi',
      usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      response_metadata: { finish_reason: 'stop' },
    });
    const result = toModelResult(lc);
    expect(result.message).toEqual({ role: 'assistant', content: 'hi' });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.finishReason).toBe('stop');
    expect(result.raw).toBe(lc);
  });

  it('falls back to stop_reason (anthropic style)', () => {
    const result = toModelResult(
      new AIMessage({ content: 'x', response_metadata: { stop_reason: 'end_turn' } }),
    );
    expect(result.finishReason).toBe('end_turn');
  });

  it('omits usage and finishReason when the message carries neither', () => {
    const result = toModelResult(new AIMessageChunk({ content: 'x' }));
    expect(result.usage).toBeUndefined();
    expect(result.finishReason).toBeUndefined();
  });
});
