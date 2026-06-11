// The approval dance: toolApproval writes AwaitingHuman, executeTools vetoes
// until HumanResponse arrives, denial produces a "denied" tool-result message.

import {
  AwaitingHuman,
  createWorld,
  HumanResponse,
  type ModelRequest,
  type Msg,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';
import {
  defineTool,
  lastAssistant,
  Messages,
  PendingToolCalls,
  reactAgent,
  registerTools,
  sendMessage,
} from '../src/index';

function approvalWorld(agentName: string, secondTurn: Msg | ((req: ModelRequest) => Msg)) {
  let executed = 0;
  const wipe = defineTool({
    name: 'wipe',
    description: 'Wipes a directory',
    needsApproval: true,
    execute: (args) => {
      executed += 1;
      return `wiped ${(args as { path: string }).path}`;
    },
  });
  const world = createWorld();
  world.register(
    'model:approval',
    scriptedModel([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'wipe', args: { path: '/tmp/x' } }],
      },
      secondTurn,
    ]),
  );
  registerTools(world, [wipe]);
  const agent = world.spawn(
    reactAgent({ name: agentName, model: 'model:approval', tools: [wipe] }),
  );
  return { world, agent, executedCount: () => executed };
}

test('toolApproval parks the run as pending; executeTools is vetoed until resume; approval executes', async () => {
  const { world, agent, executedCount } = approvalWorld('approver', {
    role: 'assistant',
    content: 'All wiped.',
  });

  const r1 = await sendMessage(world, agent, 'wipe /tmp/x');
  expect(r1.status).toBe('pending');
  expect(r1.steps).toBe(2); // step 1 callLLM, step 2 toolApproval (executeTools vetoed)
  expect(executedCount()).toBe(0);

  // The interrupt carries the calls needing approval.
  expect(r1.pending).toHaveLength(1);
  expect(r1.pending[0]?.entity).toBe(agent.id);
  expect(r1.pending[0]?.interrupts).toHaveLength(1);
  expect(r1.pending[0]?.interrupts[0]).toMatchObject({
    kind: 'tool-approval',
    payload: { calls: [{ id: 'c1', name: 'wipe', args: { path: '/tmp/x' } }] },
  });
  expect(world.pending()).toEqual(r1.pending);

  // Step 2 choreography: toolApproval ran, executeTools' `when` vetoed (dirt consumed).
  const danceStep = world.getTrace()[1];
  expect(danceStep?.runs.map((r) => r.system)).toEqual(['approver:toolApproval']);
  expect(danceStep?.vetoed).toEqual([{ system: 'approver:executeTools', entity: agent.id }]);
  expect(agent.has(AwaitingHuman)).toBe(true);
  expect(agent.has(PendingToolCalls)).toBe(true); // still parked, not executed

  // Human approves: AwaitingHuman removed, HumanResponse set, run resumes.
  const r2 = await world.resume(agent, true);
  expect(r2.status).toBe('done');
  expect(r2.steps).toBe(2); // executeTools, then callLLM with the tool result
  expect(executedCount()).toBe(1);

  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(messages[2]).toMatchObject({ role: 'tool', content: 'wiped /tmp/x', toolCallId: 'c1' });
  expect(lastAssistant(world, agent)?.content).toBe('All wiped.');

  // Trigger state fully consumed (HumanResponse convention, R33).
  expect(agent.has(AwaitingHuman)).toBe(false);
  expect(agent.has(HumanResponse)).toBe(false);
  expect(agent.has(PendingToolCalls)).toBe(false);
});

test('denial produces a tool-result message saying denied; the tool never runs', async () => {
  const finalRequests: ModelRequest[] = [];
  const { world, agent, executedCount } = approvalWorld('denier', (req) => {
    finalRequests.push(req);
    return { role: 'assistant', content: 'Understood, not wiping.' };
  });

  const r1 = await sendMessage(world, agent, 'wipe /tmp/x');
  expect(r1.status).toBe('pending');

  const r2 = await world.resume(agent, { approved: false, reason: 'too dangerous' });
  expect(r2.status).toBe('done');
  expect(executedCount()).toBe(0);

  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  const denial = messages[2];
  expect(denial?.toolCallId).toBe('c1');
  expect(denial?.content).toContain('denied');
  expect(denial?.content).toContain('too dangerous');
  expect(denial?.meta).toEqual({ denied: true });

  // The model saw the denial and answered accordingly.
  expect(finalRequests[0]?.messages.at(-1)?.content).toContain('denied');
  expect(lastAssistant(world, agent)?.content).toBe('Understood, not wiping.');
  expect(agent.has(HumanResponse)).toBe(false);
  expect(agent.has(PendingToolCalls)).toBe(false);
});

test('mixed batch: denial only blocks approval-gated calls; safe calls still execute', async () => {
  const lookups: unknown[] = [];
  const lookup = defineTool({
    name: 'lookup',
    execute: (args) => {
      lookups.push(args);
      return 'found 3 entries';
    },
  });
  const purge = defineTool({ name: 'purge', needsApproval: true, execute: () => 'purged' });
  const world = createWorld();
  world.register(
    'model:mixed',
    scriptedModel([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a1', name: 'lookup', args: { q: 'logs' } },
          { id: 'a2', name: 'purge', args: {} },
        ],
      },
      { role: 'assistant', content: 'Looked up, purge skipped.' },
    ]),
  );
  registerTools(world, [lookup, purge]);
  const agent = world.spawn(
    reactAgent({ name: 'mixedbot', model: 'model:mixed', tools: [lookup, purge] }),
  );

  const r1 = await sendMessage(world, agent, 'lookup logs then purge');
  expect(r1.status).toBe('pending');
  // Only the approval-gated call appears in the interrupt payload.
  expect(r1.pending[0]?.interrupts[0]?.payload).toEqual({
    calls: [{ id: 'a2', name: 'purge', args: {} }],
  });

  const r2 = await world.resume(agent, false);
  expect(r2.status).toBe('done');
  expect(lookups).toEqual([{ q: 'logs' }]);

  const messages = agent.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  expect(messages[2]).toMatchObject({ toolCallId: 'a1', content: 'found 3 entries' });
  expect(messages[3]?.toolCallId).toBe('a2');
  expect(messages[3]?.content).toContain('denied');
  expect(messages[3]?.meta).toEqual({ denied: true });
});
