import { expect, test } from 'vitest';
import { scriptedModel } from '../src/index';

test('R44 scriptedModel returns turns in order and supports function turns', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: 'one' },
    (req) => ({ role: 'assistant', content: `echo:${req.messages[0]?.content}` }),
  ]);
  const r1 = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
  expect(r1.message).toEqual({ role: 'assistant', content: 'one' });
  const r2 = await model.generate({ messages: [{ role: 'user', content: 'yo' }] });
  expect(r2.message.content).toBe('echo:yo');
});

test('R44 scriptedModel streams by chunking content', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'streamed reply' }]);
  const chunks: string[] = [];
  const result = await model.stream?.({ messages: [] }, (d) => {
    if (d.text) chunks.push(d.text);
  });
  expect(result?.message.content).toBe('streamed reply');
  expect(chunks.join('')).toBe('streamed reply');
  expect(chunks.length).toBeGreaterThan(1);
});

test('R44 scriptedModel throws when called more times than scripted', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'only' }]);
  await model.generate({ messages: [] });
  await expect(model.generate({ messages: [] })).rejects.toThrow(/exhausted/);
});
