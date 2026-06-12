// extractJson: strict-JSON structured output over any core Model — clean and
// fenced replies, the single retry with parse-error context, and the final
// descriptive failure. All driven by scriptedModel.

import { type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { extractJson } from '../src/index';

const capture =
  (requests: ModelRequest[], content: string) =>
  (req: ModelRequest): Msg => {
    requests.push(req);
    return { role: 'assistant', content };
  };

test('parses a clean JSON reply; instruction embeds system, directive, and schema', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([capture(requests, '{"name":"Ada","age":36}')]);

  const person = await extractJson<{ name: string; age: number }>(model, {
    prompt: 'Extract the person from: "Ada Lovelace, 36, mathematician."',
    system: 'You are a data extractor.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    },
    schemaName: 'Person',
  });

  expect(person).toEqual({ name: 'Ada', age: 36 });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages).toEqual([
    { role: 'user', content: 'Extract the person from: "Ada Lovelace, 36, mathematician."' },
  ]);
  expect(requests[0]?.system).toContain('You are a data extractor.');
  expect(requests[0]?.system).toContain('ONLY a single valid JSON value');
  expect(requests[0]?.system).toContain('JSON Schema "Person"');
  expect(requests[0]?.system).toContain('"required"');
});

test('strips markdown code fences before parsing', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: '```json\n{"ok": true, "items": [1, 2]}\n```' },
  ]);
  await expect(extractJson(model, { prompt: 'go' })).resolves.toEqual({ ok: true, items: [1, 2] });
});

test('messages provide context and prompt is appended last', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([capture(requests, '[1,2]')]);

  await expect(
    extractJson(model, {
      messages: [
        { role: 'user', content: 'remember 1 and 2' },
        { role: 'assistant', content: 'noted' },
      ],
      prompt: 'now list the numbers',
    }),
  ).resolves.toEqual([1, 2]);
  expect(requests[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(requests[0]?.messages[2]?.content).toBe('now list the numbers');
});

test('retries once, appending the malformed output and the parse error as context', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([
    capture(requests, '{"broken": '),
    capture(requests, '{"fixed":true}'),
  ]);

  await expect(extractJson(model, { prompt: 'extract' })).resolves.toEqual({ fixed: true });
  expect(requests).toHaveLength(2);
  const retryMessages = requests[1]?.messages ?? [];
  // Original user prompt, the malformed assistant reply, then the correction.
  expect(retryMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(retryMessages[1]?.content).toBe('{"broken": ');
  expect(retryMessages[2]?.content).toContain('not valid JSON');
  expect(retryMessages[2]?.content).toContain('JSON.parse failed with:');
  expect(retryMessages[2]?.content).toContain('ONLY the corrected JSON value');
  // The strict-JSON instruction rides along on the retry too.
  expect(requests[1]?.system).toContain('ONLY a single valid JSON value');
});

test('throws a descriptive error after the second parse failure', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: 'Happy to help! Here is the JSON: {' },
    { role: 'assistant', content: 'still not json' },
  ]);

  const failing = extractJson(model, { prompt: 'extract' });
  await expect(failing).rejects.toThrow('extractJson');
  await expect(failing).rejects.toThrow('2 attempts');
  await expect(failing).rejects.toThrow('Second parse error:');
  await expect(failing).rejects.toThrow('still not json');
});

test('throws when neither prompt nor messages is given', async () => {
  const model = scriptedModel([]);
  await expect(extractJson(model, {})).rejects.toThrow('nothing to send');
});
