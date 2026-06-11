// The chat loop choreography, tested step-by-step with core's scriptedModel:
// LLM -> tools -> LLM -> final answer is the canonical dirty-trigger cycle.

import {
  createWorld,
  type Model,
  type ModelRequest,
  type Msg,
  type RunEvent,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';
import {
  defineTool,
  lastAssistant,
  Messages,
  MessageWaiting,
  PendingToolCalls,
  reactAgent,
  registerTools,
  sendMessage,
} from '../src/index';

const makeAddTool = () =>
  defineTool({
    name: 'add',
    description: 'Adds two numbers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    execute: (args) => {
      const { a, b } = args as { a: number; b: number };
      return String(a + b);
    },
  });

test('canonical cycle step-by-step: LLM -> tools -> LLM -> final answer', async () => {
  const requests: ModelRequest[] = [];
  const turn =
    (message: Msg) =>
    (req: ModelRequest): Msg => {
      requests.push(req);
      return message;
    };
  const model = scriptedModel([
    turn({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'add', args: { a: 2, b: 3 } }],
    }),
    turn({ role: 'assistant', content: 'The answer is 5.' }),
  ]);

  const world = createWorld();
  world.register('model:main', model);
  const add = makeAddTool();
  registerTools(world, [add]);
  const agent = world.spawn(
    reactAgent({ name: 'mathbot', model: 'model:main', tools: [add], systemPrompt: 'Be terse.' }),
  );

  const result = await sendMessage(world, agent, 'What is 2 + 3?');
  expect(result.status).toBe('done');
  expect(result.steps).toBe(3);

  // Step-by-step choreography from the flight recorder:
  const trace = world.getTrace();
  expect(trace).toHaveLength(3);
  // step 1: only callLLM fires (external Messages + MessageWaiting dirt).
  expect(trace[0]?.runs.map((r) => r.system)).toEqual(['mathbot:callLLM']);
  // step 2: PendingToolCalls newly matches executeTools; toolApproval is
  // scheduled on the same dirt but vetoed (no tool needs approval).
  expect(trace[1]?.runs.map((r) => r.system)).toEqual(['mathbot:executeTools']);
  expect(trace[1]?.vetoed).toEqual([{ system: 'mathbot:toolApproval', entity: agent.id }]);
  // step 3: executeTools' foreign Messages append re-fires callLLM (its own
  // step-1 append did not — self-write exclusion).
  expect(trace[2]?.runs.map((r) => r.system)).toEqual(['mathbot:callLLM']);

  // Conversation log:
  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(messages[1]?.toolCalls).toEqual([{ id: 'call-1', name: 'add', args: { a: 2, b: 3 } }]);
  expect(messages[2]).toMatchObject({
    role: 'tool',
    content: '5',
    toolCallId: 'call-1',
    name: 'add',
  });
  expect(messages[3]?.content).toBe('The answer is 5.');

  // Requests the model saw:
  expect(requests).toHaveLength(2);
  expect(requests[0]?.system).toBe('Be terse.');
  expect(requests[0]?.tools).toEqual([
    { name: 'add', description: 'Adds two numbers', parameters: add.parameters },
  ]);
  expect(requests[0]?.messages.map((m) => m.role)).toEqual(['user']);
  expect(requests[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  expect(requests[1]?.messages[2]?.content).toBe('5');

  // Trigger components consumed; answer retrievable.
  expect(agent.has(MessageWaiting)).toBe(false);
  expect(agent.has(PendingToolCalls)).toBe(false);
  expect(lastAssistant(world, agent)?.content).toBe('The answer is 5.');
});

test('callLLM streams tokens via ctx.emit when the model supports stream', async () => {
  const world = createWorld();
  world.register('model:chat', scriptedModel([{ role: 'assistant', content: 'streamed reply' }]));
  const agent = world.spawn(reactAgent({ name: 'streamer', model: 'model:chat' }));

  const run = sendMessage(world, agent, 'hi');
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run;
  expect(result.status).toBe('done');

  const tokens = events.filter(
    (e): e is Extract<RunEvent, { type: 'custom' }> => e.type === 'custom',
  );
  expect(tokens.length).toBeGreaterThan(1); // scriptedModel chunks into ~4 pieces
  for (const event of tokens) {
    expect(event.system).toBe('streamer:callLLM');
    expect(event.entity).toBe(agent.id);
    expect((event.data as { kind: string }).kind).toBe('token');
  }
  expect(tokens.map((e) => (e.data as { text: string }).text).join('')).toBe('streamed reply');

  // Tokens are live mid-step: they precede the step's barrier event.
  const firstToken = events.findIndex((e) => e.type === 'custom');
  const firstApplied = events.findIndex((e) => e.type === 'step:applied');
  expect(firstToken).toBeGreaterThan(-1);
  expect(firstToken).toBeLessThan(firstApplied);
  // The streamed message still lands in Messages at the barrier.
  expect(lastAssistant(world, agent)?.content).toBe('streamed reply');
});

test('callLLM falls back to generate (no token events) when the model lacks stream', async () => {
  const scripted = scriptedModel([{ role: 'assistant', content: 'plain reply' }]);
  const generateOnly: Model = { generate: (req) => scripted.generate(req) };
  const world = createWorld();
  world.register('model:plain', generateOnly);
  const agent = world.spawn(reactAgent({ name: 'plainbot', model: 'model:plain' }));

  const run = sendMessage(world, agent, 'hi');
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  expect(events.filter((e) => e.type === 'custom')).toHaveLength(0);
  expect((await run).status).toBe('done');
  expect(lastAssistant(world, agent)?.content).toBe('plain reply');
});

test('multi-turn: each sendMessage re-raises MessageWaiting and quiesces on the answer', async () => {
  const world = createWorld();
  world.register(
    'model:turns',
    scriptedModel([
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'second answer' },
    ]),
  );
  const agent = world.spawn(reactAgent({ name: 'turnbot', model: 'model:turns' }));

  const r1 = await sendMessage(world, agent, 'one');
  expect(r1.status).toBe('done');
  expect(r1.steps).toBe(1);
  expect(lastAssistant(world, agent)?.content).toBe('first answer');
  expect(agent.has(MessageWaiting)).toBe(false);

  const r2 = await sendMessage(world, agent, 'two');
  expect(r2.status).toBe('done');
  expect(r2.steps).toBe(1);
  expect(lastAssistant(world, agent)?.content).toBe('second answer');
  expect((agent.get(Messages) ?? []).map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
});
