import type { Msg } from '@langecs/core';
import { describe, expect, test } from 'vitest';
import {
  toAiSdkTools,
  toAssistantMsg,
  toModelMessage,
  toModelMessages,
  toUsage,
} from '../src/index';

describe('toModelMessages', () => {
  test('system and user messages map to string-content messages', () => {
    expect(toModelMessage({ role: 'system', content: 'Be brief.' })).toEqual({
      role: 'system',
      content: 'Be brief.',
    });
    expect(toModelMessage({ role: 'user', content: 'hi' })).toEqual({
      role: 'user',
      content: 'hi',
    });
  });

  test('plain assistant message keeps string content', () => {
    expect(toModelMessage({ role: 'assistant', content: 'hello' })).toEqual({
      role: 'assistant',
      content: 'hello',
    });
  });

  test('assistant message with tool calls becomes text + tool-call parts', () => {
    const msg: Msg = {
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: 'call_1', name: 'add', args: { a: 1, b: 2 } }],
    };
    expect(toModelMessage(msg)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: { a: 1, b: 2 } },
      ],
    });
  });

  test('assistant tool-call message with empty content omits the text part', () => {
    const msg: Msg = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_2', name: 'lookup', args: {} }],
    };
    const converted = toModelMessage(msg);
    expect(converted).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_2', toolName: 'lookup', input: {} }],
    });
  });

  test('tool message becomes a tool-result part with text output', () => {
    const msg: Msg = { role: 'tool', content: '3', toolCallId: 'call_1', name: 'add' };
    expect(toModelMessage(msg)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'add',
          output: { type: 'text', value: '3' },
        },
      ],
    });
  });

  test('toModelMessages maps a whole conversation in order', () => {
    const out = toModelMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });
});

describe('toAiSdkTools', () => {
  test('returns undefined for missing or empty specs', () => {
    expect(toAiSdkTools(undefined)).toBeUndefined();
    expect(toAiSdkTools([])).toBeUndefined();
  });

  test('maps ToolSpec name/description/parameters via jsonSchema', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
    };
    const tools = toAiSdkTools([{ name: 'add', description: 'Add numbers', parameters: schema }]);
    expect(tools).toBeDefined();
    const add = tools?.add;
    expect(add?.description).toBe('Add numbers');
    expect(add?.inputSchema).toMatchObject({ jsonSchema: schema });
    expect(add?.execute).toBeUndefined();
  });

  test('defaults parameters to an empty object schema', () => {
    const tools = toAiSdkTools([{ name: 'noop' }]);
    expect(tools?.noop?.inputSchema).toMatchObject({
      jsonSchema: { type: 'object', properties: {} },
    });
  });
});

describe('toAssistantMsg / toUsage', () => {
  test('text-only result has no toolCalls property', () => {
    expect(toAssistantMsg('hi', [])).toEqual({ role: 'assistant', content: 'hi' });
  });

  test('tool calls map id/name/args', () => {
    const msg = toAssistantMsg('', [{ toolCallId: 'c1', toolName: 'add', input: { a: 1 } }]);
    expect(msg.toolCalls).toEqual([{ id: 'c1', name: 'add', args: { a: 1 } }]);
  });

  test('usage maps token counts and tolerates undefined', () => {
    expect(toUsage(undefined)).toBeUndefined();
    expect(toUsage({ inputTokens: 3, outputTokens: 7 })).toEqual({
      inputTokens: 3,
      outputTokens: 7,
    });
    expect(toUsage({ inputTokens: undefined, outputTokens: undefined })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });
});
