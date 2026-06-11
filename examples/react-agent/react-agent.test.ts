// Deterministic choreography test for the react-agent example: core
// scriptedModel only, zero network. Asserts the canonical dirty-trigger
// sequence step by step — callLLM, executeTools, callLLM, quiescent 'done' —
// using both the flight recorder (world.getTrace) and the run event stream.

import { createWorld, type RunEvent, scriptedModel } from '@langecs/core';
import {
  lastAssistant,
  Messages,
  MessageWaiting,
  PendingToolCalls,
  sendMessage,
} from '@langecs/stdlib';
import { expect, test } from 'vitest';
import { evaluate, MODEL_RESOURCE, spawnReactAgent } from './agent';

const QUESTION = "What's the weather in San Francisco, and what is (23.5 * 4) - 7?";

test('canonical cycle: callLLM -> executeTools -> callLLM -> quiescent done', async () => {
  const world = createWorld();
  world.register(
    MODEL_RESOURCE,
    scriptedModel([
      // Turn 1: the model requests both tools in one assistant message.
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-weather', name: 'get_weather', args: { city: 'San Francisco' } },
          { id: 'call-calc', name: 'calculator', args: { expression: '(23.5 * 4) - 7' } },
        ],
      },
      // Turn 2: with tool results in context, a plain answer ends the cycle.
      { role: 'assistant', content: 'It is 64°F and foggy in San Francisco; (23.5 * 4) - 7 = 87.' },
    ]),
  );
  const agent = spawnReactAgent(world);

  const run = sendMessage(world, agent, QUESTION);
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run;

  // Quiescent 'done': nothing pending, nothing errored, no recursion limit hit.
  expect(result.status).toBe('done');
  expect(result.steps).toBe(3);
  expect(result.pending).toEqual([]);
  expect(result.errors).toEqual([]);

  // Step-by-step choreography from the flight recorder:
  //   step 1: external Messages+MessageWaiting dirt fires callLLM only.
  //   step 2: PendingToolCalls newly matches executeTools; toolApproval is
  //           scheduled on the same dirt but vetoed (no tool needsApproval).
  //   step 3: executeTools' Messages append is foreign dirt -> callLLM refires
  //           (its own step-1 append did not: self-write exclusion). It removes
  //           MessageWaiting -> no eligible pairs -> quiescence.
  const trace = world.getTrace();
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['assistant:callLLM'],
    ['assistant:executeTools'],
    ['assistant:callLLM'],
  ]);
  expect(trace[1]?.vetoed).toEqual([{ system: 'assistant:toolApproval', entity: agent.id }]);

  // The live event stream tells the same story in order.
  const starts = events.flatMap((e) => (e.type === 'system:start' ? [e.system] : []));
  expect(starts).toEqual(['assistant:callLLM', 'assistant:executeTools', 'assistant:callLLM']);
  expect(events.at(-1)).toEqual({ type: 'run:end', status: 'done', steps: 3 });

  // callLLM streamed the final answer as live token events (scriptedModel
  // chunks content; the empty tool-call turn produces no tokens).
  const tokens = events.flatMap((e) =>
    e.type === 'custom' ? [(e.data as { text: string }).text] : [],
  );
  expect(tokens.length).toBeGreaterThan(1);
  expect(tokens.join('')).toBe('It is 64°F and foggy in San Francisco; (23.5 * 4) - 7 = 87.');

  // Final transcript: user -> assistant(tool calls) -> two tool results -> answer.
  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  expect(messages[2]).toMatchObject({
    role: 'tool',
    toolCallId: 'call-weather',
    name: 'get_weather',
  });
  expect(messages[2]?.content).toContain('foggy');
  expect(messages[3]).toMatchObject({
    role: 'tool',
    toolCallId: 'call-calc',
    name: 'calculator',
    content: '87', // the calculator tool really ran
  });

  // Final assistant message present; trigger components consumed.
  expect(lastAssistant(world, agent)?.content).toContain('87');
  expect(agent.has(MessageWaiting)).toBe(false);
  expect(agent.has(PendingToolCalls)).toBe(false);
});

test('multi-turn memory: a follow-up sendMessage sees the prior transcript', async () => {
  const world = createWorld();
  world.register(
    MODEL_RESOURCE,
    scriptedModel([
      { role: 'assistant', content: 'Hello! Ask me about weather or math.' },
      (req) => {
        // The second turn's request must contain the full first exchange.
        expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        return { role: 'assistant', content: 'You first said: hi.' };
      },
    ]),
  );
  const agent = spawnReactAgent(world);

  expect((await sendMessage(world, agent, 'hi')).status).toBe('done');
  expect((await sendMessage(world, agent, 'what did I say first?')).status).toBe('done');
  expect(lastAssistant(world, agent)?.content).toBe('You first said: hi.');
});

test('calculator tool evaluates real arithmetic', () => {
  expect(evaluate('(23.5 * 4) - 7')).toBe(87);
  expect(evaluate('1 + 2 * 3')).toBe(7);
  expect(evaluate('-4 / (1 + 1)')).toBe(-2);
  expect(() => evaluate('2 +')).toThrow(/calculator/);
});
