// Context-window helpers: pure, deterministic windowing + the Model wrapper.

import { type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { estimateTokens, recentMessages, withMessageWindow } from '../src/index';

const user = (content: string): Msg => ({ role: 'user', content });
const assistant = (content: string): Msg => ({ role: 'assistant', content });

test('estimateTokens: ~4 chars/token for strings and message lists', () => {
  expect(estimateTokens('a'.repeat(40))).toBe(10);
  // Per-message overhead is included, so a list estimate exceeds the bare text.
  expect(estimateTokens([user('hello')])).toBeGreaterThan(estimateTokens('hello'));
});

test('recentMessages: no limits returns the input unchanged', () => {
  const msgs = [user('a'), assistant('b')];
  expect(recentMessages(msgs)).toBe(msgs);
});

test('recentMessages: keeps the most recent N and pins leading system messages', () => {
  const msgs: Msg[] = [
    { role: 'system', content: 'be terse' },
    user('1'),
    assistant('2'),
    user('3'),
    assistant('4'),
  ];
  const out = recentMessages(msgs, { maxMessages: 2 });
  // System pinned + last 2 body messages.
  expect(out.map((m) => m.content)).toEqual(['be terse', '3', '4']);
});

test('recentMessages: keepSystem:false drops the system message under pressure', () => {
  const msgs: Msg[] = [{ role: 'system', content: 'sys' }, user('1'), user('2')];
  const out = recentMessages(msgs, { maxMessages: 1, keepSystem: false });
  expect(out.map((m) => m.content)).toEqual(['2']);
});

test('recentMessages: trims a token budget, always keeping at least one message', () => {
  const msgs = [user('x'.repeat(400)), user('y'.repeat(400)), user('z'.repeat(40))];
  // Budget fits only the last small message.
  const out = recentMessages(msgs, { maxTokens: 20 });
  expect(out).toEqual([msgs[2]]);
  // A budget smaller than any single message still returns the newest one.
  expect(recentMessages(msgs, { maxTokens: 1 })).toEqual([msgs[2]]);
});

test('recentMessages: drops a leading orphan tool message after truncation', () => {
  const msgs: Msg[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
    { role: 'tool', content: 'result', toolCallId: 'c1', name: 't' },
    assistant('final'),
  ];
  // maxMessages:2 would start the window on the orphan tool message; it's dropped.
  const out = recentMessages(msgs, { maxMessages: 2 });
  expect(out.map((m) => m.role)).toEqual(['assistant']);
  expect(out[0]?.content).toBe('final');
});

test('withMessageWindow: trims request messages, leaving the stored history alone', async () => {
  const seen: ModelRequest[] = [];
  const base = scriptedModel([
    (req) => {
      seen.push(req);
      return assistant('ok');
    },
  ]);
  const windowed = withMessageWindow(base, { maxMessages: 1 });
  const messages = [user('old'), user('newer'), user('newest')];
  const result = await windowed.generate({ messages });
  expect(result.message.content).toBe('ok');
  // The model only saw the most recent message; the caller's array is untouched.
  expect(seen[0]?.messages.map((m) => m.content)).toEqual(['newest']);
  expect(messages).toHaveLength(3);
});

test('withMessageWindow: preserves streaming when the model supports it', async () => {
  const base = scriptedModel([assistant('streamed')]);
  const windowed = withMessageWindow(base, { maxTokens: 1000 });
  expect(typeof windowed.stream).toBe('function');
  const chunks: string[] = [];
  await windowed.stream?.({ messages: [user('hi')] }, (c) => {
    if (c.text) chunks.push(c.text);
  });
  expect(chunks.join('')).toBe('streamed');
});
