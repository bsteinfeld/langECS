// Deterministic test: withMessageWindow bounds what the model sees while the
// full transcript persists on the entity. scriptedModel, zero network.

import { createWorld, defineResource, type Model, type ModelRequest } from '@langecs/core';
import { ask, Messages, reactAgent, withMessageWindow } from '@langecs/stdlib';
import { expect, test } from 'vitest';

const Chatbot = defineResource<Model>('model:chat');

test('each model call sees at most the window; full history is retained', async () => {
  const seenLengths: number[] = [];
  // A model that echoes a reply and records how many messages it was sent.
  const base: Model = {
    async generate(req: ModelRequest) {
      seenLengths.push(req.messages.length);
      return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  };

  const world = createWorld({ id: 'cw-test' });
  world.register(Chatbot, withMessageWindow(base, { maxMessages: 4 }));
  const agent = world.spawn(reactAgent({ name: 'chatbot', model: Chatbot }));

  const turns = ['t1', 't2', 't3', 't4', 't5', 't6'];
  for (const turn of turns) {
    expect(await ask(world, agent, turn)).toBe('ok');
  }

  // No call ever exceeded the 4-message window...
  expect(Math.max(...seenLengths)).toBeLessThanOrEqual(4);
  // ...and later turns are actually being trimmed (would be >4 unbounded).
  expect(seenLengths.at(-1)).toBe(4);

  // ...but the entity kept the entire transcript (2 messages per turn).
  expect(world.entity(agent.id)?.get(Messages)?.length).toBe(turns.length * 2);
});
