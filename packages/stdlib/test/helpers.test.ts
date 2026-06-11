// Helper surface: defineTool/registerTools naming, message helpers, and
// executeTools' handling of tool errors / unregistered tools.

import { createWorld, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  bareToolName,
  defineTool,
  lastAssistant,
  Messages,
  MessageWaiting,
  reactAgent,
  registerTools,
  sendMessage,
  toolResourceName,
  toToolSpec,
  userMessage,
} from '../src/index';

test('userMessage builds a plain user Msg', () => {
  expect(userMessage('hello')).toEqual({ role: 'user', content: 'hello' });
});

test('tool naming: toolResourceName / bareToolName / toToolSpec normalize the tool: prefix', () => {
  expect(toolResourceName('calc')).toBe('tool:calc');
  expect(toolResourceName('tool:calc')).toBe('tool:calc');
  expect(bareToolName('tool:calc')).toBe('calc');
  expect(bareToolName('calc')).toBe('calc');

  const tool = defineTool({
    name: 'calc',
    description: 'Calculates',
    parameters: { type: 'object' },
    execute: () => 'ok',
  });
  expect(toToolSpec(tool)).toEqual({
    name: 'calc',
    description: 'Calculates',
    parameters: { type: 'object' },
  });
  // No undefined keys leak into the spec.
  expect(Object.keys(toToolSpec(defineTool({ name: 'bare', execute: () => 0 })))).toEqual(['name']);
});

test('registerTools registers each tool as a resource under tool:<name>', async () => {
  const echo = defineTool({ name: 'echo', execute: (args) => args });
  const world = createWorld();
  registerTools(world, [echo]);

  // Resources are only readable through a SystemCtx; probe via executeTools'
  // own lookup path by running a one-shot agent turn that calls the tool.
  world.register(
    'model:probe',
    scriptedModel([
      { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'echo', args: { x: 1 } }] },
      { role: 'assistant', content: 'echoed' },
    ]),
  );
  const agent = world.spawn(
    reactAgent({ name: 'probebot', model: 'model:probe', tools: ['echo'] }),
  );
  const result = await sendMessage(world, agent, 'echo x');
  expect(result.status).toBe('done');
  const toolMsg = (agent.get(Messages) ?? [])[2];
  expect(toolMsg).toMatchObject({ role: 'tool', content: '{"x":1}', name: 'echo' });
});

test('sendMessage appends the user message and raises MessageWaiting (works without systems)', async () => {
  const world = createWorld();
  const e = world.spawn(Messages([]));
  const result = await sendMessage(world, e, 'anyone there?');
  expect(result.status).toBe('idle'); // no systems registered: zero steps
  expect(e.get(Messages)).toEqual([{ role: 'user', content: 'anyone there?' }]);
  expect(e.has(MessageWaiting)).toBe(true);
});

test('lastAssistant returns undefined without assistant messages and accepts a numeric id', async () => {
  const world = createWorld();
  const e = world.spawn(Messages([userMessage('hi')]));
  expect(lastAssistant(world, e)).toBeUndefined();
  expect(lastAssistant(world, e.id)).toBeUndefined();
  e.add(Messages, [{ role: 'assistant', content: 'first' }]);
  e.add(Messages, [{ role: 'assistant', content: 'latest' }]);
  expect(lastAssistant(world, e.id)?.content).toBe('latest');
});

test('executeTools turns tool exceptions and unregistered tools into Error tool messages', async () => {
  const cranky = defineTool({
    name: 'cranky',
    execute: () => {
      throw new Error('tool blew up');
    },
  });
  const world = createWorld();
  registerTools(world, [cranky]);
  world.register(
    'model:errors',
    scriptedModel([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'e1', name: 'cranky', args: {} },
          { id: 'e2', name: 'ghost', args: {} }, // never registered
        ],
      },
      { role: 'assistant', content: 'noted the failures' },
    ]),
  );
  const agent = world.spawn(
    reactAgent({ name: 'errbot', model: 'model:errors', tools: ['cranky', 'ghost'] }),
  );

  const result = await sendMessage(world, agent, 'go');
  // Tool failures become messages, not SystemError: the loop keeps running.
  expect(result.status).toBe('done');
  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  expect(messages[2]).toMatchObject({ toolCallId: 'e1', meta: { error: true } });
  expect(messages[2]?.content).toContain('tool blew up');
  expect(messages[3]?.content).toContain('not registered');
  expect(lastAssistant(world, agent)?.content).toBe('noted the failures');
});
