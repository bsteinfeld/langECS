// The streaming token event carries a filterable name (R60) without changing the
// payload every existing consumer already switches on.

import { createWorld, type RunEvent, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { Messages, MessageWaiting, ModelRef, TokenEvent } from '../src/components';
import { sendMessage } from '../src/helpers';
import { callLLM } from '../src/systems';

test('callLLM streams through the typed TokenEvent, keeping the { kind, text } payload', async () => {
  const world = createWorld();
  world.use(callLLM);
  world.register('model:main', scriptedModel([{ role: 'assistant', content: 'hello there' }]));
  const agent = world.spawn(Messages([]), ModelRef('model:main'));

  const custom: Extract<RunEvent, { type: 'custom' }>[] = [];
  const run = sendMessage(world, agent, 'hi');
  for await (const event of run) {
    if (event.type === 'custom') custom.push(event);
  }

  expect(custom.length).toBeGreaterThan(1);
  // New: observers can filter by name instead of parsing every payload.
  expect(custom.every((e) => e.name === TokenEvent.eventName)).toBe(true);
  // Unchanged: the payload shape existing consumers rely on.
  expect(custom.every((e) => (e.data as { kind?: string }).kind === 'token')).toBe(true);
  expect(custom.map((e) => (e.data as { text: string }).text).join('')).toBe('hello there');
  expect(world.entity(agent.id)?.has(MessageWaiting)).toBe(false);
});
