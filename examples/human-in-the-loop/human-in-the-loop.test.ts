// Deterministic kill-and-resume choreography. Zero network: the model is
// core's scriptedModel. The "process restart" is simulated with two separate
// world instances that share nothing but one fsAdapter tmp directory:
//
//   world A  spawn -> sendMessage -> 'pending' (AwaitingHuman) -> discarded
//   world B  use(agentDef) -> load(snapshot from disk) -> resume -> 'done'
//
// Choreography is asserted step-by-step from the flight recorder (world trace)
// and from the resume run's event stream.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AwaitingHuman,
  createWorld,
  HumanResponse,
  type ModelRequest,
  type Msg,
  type RunEvent,
  scriptedModel,
} from '@langecs/core';
import { type FsAdapter, fsAdapter } from '@langecs/persist-fs';
import {
  lastAssistant,
  Messages,
  MessageWaiting,
  PendingToolCalls,
  registerTools,
  sendMessage,
} from '@langecs/stdlib';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MODEL_RESOURCE, recordsAgent, recordTools, WORLD_ID } from './agent';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'langecs-hitl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DELETE_CALL = { id: 'call-1', name: 'delete_record', args: { id: 42 } };

/** "Process A": fresh world; the scripted model immediately asks for the dangerous tool. */
function processA(adapter: FsAdapter) {
  const deletions: number[] = [];
  const world = createWorld({ id: WORLD_ID, persistence: adapter });
  world.register(
    MODEL_RESOURCE,
    scriptedModel([{ role: 'assistant', content: '', toolCalls: [DELETE_CALL] }]),
  );
  registerTools(
    world,
    recordTools((id) => deletions.push(id)),
  );
  const agent = world.spawn(recordsAgent);
  return { world, agent, deletions };
}

/** "Process B": brand-new world that only shares the adapter's directory with A. */
function processB(adapter: FsAdapter, finalTurn: Msg | ((req: ModelRequest) => Msg)) {
  const deletions: number[] = [];
  const world = createWorld({ id: WORLD_ID, persistence: adapter });
  world.use(recordsAgent); // systems must be registered before load (R19/R36)
  world.register(MODEL_RESOURCE, scriptedModel([finalTurn]));
  registerTools(
    world,
    recordTools((id) => deletions.push(id)),
  );
  return { world, deletions };
}

test('kill-and-resume with approval: A parks pending on disk, B loads, approves, completes', async () => {
  const adapter = fsAdapter({ dir });

  // ---- process A: runs until quiescent-pending, persists every boundary, "dies".
  const a = processA(adapter);
  const r1 = await sendMessage(a.world, a.agent, 'Delete record 42.');

  expect(r1.status).toBe('pending');
  expect(r1.steps).toBe(2);
  expect(a.deletions).toEqual([]); // the dangerous tool never ran
  expect(r1.pending).toEqual([
    {
      entity: a.agent.id,
      interrupts: [
        expect.objectContaining({ kind: 'tool-approval', payload: { calls: [DELETE_CALL] } }),
      ],
    },
  ]);

  // Step-by-step choreography (flight recorder):
  //   step 1: callLLM answers with a tool call
  //   step 2: toolApproval fires and writes AwaitingHuman; executeTools is
  //           VETOED by its `when` guard (parked, dirt consumed)
  const traceA = a.world.getTrace();
  expect(traceA.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['records-bot:callLLM'],
    ['records-bot:toolApproval'],
  ]);
  expect(traceA[1]?.vetoed).toEqual([{ system: 'records-bot:executeTools', entity: a.agent.id }]);

  // The pending boundary is on disk: plain JSON with the interrupt in it.
  expect((await adapter.history(WORLD_ID)).map((h) => h.step)).toEqual([1, 2]);
  const onDisk = await adapter.load(WORLD_ID);
  expect(onDisk?.step).toBe(2);
  const parked = onDisk?.entities.find((e) => e.id === a.agent.id);
  expect(Object.keys(parked?.components ?? {})).toEqual(
    expect.arrayContaining(['agent:records-bot', 'Messages', 'PendingToolCalls', 'AwaitingHuman']),
  );
  expect(parked?.components).not.toHaveProperty('HumanResponse');
  // World A is now discarded — only the files survive the "crash".

  // ---- process B: rebuild the shell, load the snapshot, ask the human, resume.
  const b = processB(adapter, { role: 'assistant', content: 'Record 42 is gone.' });
  const snapshot = await adapter.load(WORLD_ID);
  expect(snapshot).not.toBeNull();
  b.world.load(snapshot as NonNullable<typeof snapshot>);

  expect(b.world.step).toBe(2);
  expect(b.world.pending()).toEqual(r1.pending); // committed state survived the restart

  const entity = b.world.pending()[0]?.entity as number;
  const run = b.world.resume(entity, true);
  const r2 = await run;

  expect(r2.status).toBe('done');
  expect(r2.steps).toBe(2);
  expect(b.deletions).toEqual([42]); // executed exactly once, in process B
  expect(a.deletions).toEqual([]); // and never in process A

  // Resume choreography: removing AwaitingHuman re-matches executeTools (its
  // Not(AwaitingHuman) term), HumanResponse satisfies its guard; then the tool
  // result re-fires callLLM, whose no-tool-call reply ends the conversation.
  // Steps continue from the restored counter: 3 then 4.
  const traceB = b.world.getTrace();
  expect(traceB.map((s) => [s.step, s.runs.map((r) => r.system)])).toEqual([
    [3, ['records-bot:executeTools']],
    [4, ['records-bot:callLLM']],
  ]);

  // Same choreography through the event stream (replayed after completion),
  // including the live token stream of the final answer.
  const events: RunEvent[] = [];
  for await (const event of run) events.push(event);
  const ofType = <T extends RunEvent['type']>(type: T): Extract<RunEvent, { type: T }>[] =>
    events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
  expect(ofType('step:start').map((e) => e.step)).toEqual([3, 4]);
  expect(ofType('system:start').map((e) => e.system)).toEqual([
    'records-bot:executeTools',
    'records-bot:callLLM',
  ]);
  const tokens = ofType('custom').map(
    (e) => (e.data as { kind?: string; text?: string }).text ?? '',
  );
  expect(tokens.join('')).toBe('Record 42 is gone.');
  expect(events.at(-1)).toEqual({ type: 'run:end', status: 'done', steps: 2 });

  // Final component state: full conversation, all trigger state consumed (R33).
  const handle = b.world.entity(entity);
  const messages = handle?.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(messages[2]).toMatchObject({
    role: 'tool',
    toolCallId: 'call-1',
    name: 'delete_record',
    content: 'Record 42 permanently deleted.',
  });
  expect(lastAssistant(b.world, entity)?.content).toBe('Record 42 is gone.');
  expect(handle?.has(AwaitingHuman)).toBe(false);
  expect(handle?.has(HumanResponse)).toBe(false);
  expect(handle?.has(PendingToolCalls)).toBe(false);
  expect(handle?.has(MessageWaiting)).toBe(false);
});

test('kill-and-resume with denial: the tool never runs and the model sees the denial', async () => {
  const adapter = fsAdapter({ dir });

  // ---- process A: identical to the approval test, then discarded.
  const a = processA(adapter);
  const r1 = await sendMessage(a.world, a.agent, 'Delete record 42.');
  expect(r1.status).toBe('pending');
  expect(a.deletions).toEqual([]);

  // ---- process B: load and DENY.
  const finalRequests: ModelRequest[] = [];
  const b = processB(adapter, (req) => {
    finalRequests.push(req);
    return { role: 'assistant', content: 'Understood — record 42 was left alone.' };
  });
  const snapshot = await adapter.load(WORLD_ID);
  b.world.load(snapshot as NonNullable<typeof snapshot>);

  const entity = b.world.pending()[0]?.entity as number;
  const r2 = await b.world.resume(entity, { approved: false, reason: 'production data' });

  expect(r2.status).toBe('done');
  expect(r2.steps).toBe(2); // same shape as approval: executeTools, then callLLM
  expect(b.deletions).toEqual([]); // denied -> never executed, in either process
  expect(a.deletions).toEqual([]);

  const traceB = b.world.getTrace();
  expect(traceB.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['records-bot:executeTools'],
    ['records-bot:callLLM'],
  ]);

  // The denial becomes an ordinary tool-result message...
  const messages = b.world.entity(entity)?.get(Messages) ?? [];
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(messages[2]?.toolCallId).toBe('call-1');
  expect(messages[2]?.content).toContain('denied');
  expect(messages[2]?.content).toContain('production data');
  expect(messages[2]?.meta).toEqual({ denied: true });

  // ...which the model actually saw before producing its final answer.
  expect(finalRequests).toHaveLength(1);
  expect(finalRequests[0]?.messages.at(-1)?.role).toBe('tool');
  expect(finalRequests[0]?.messages.at(-1)?.content).toContain('denied');
  expect(lastAssistant(b.world, entity)?.content).toBe('Understood — record 42 was left alone.');

  // Trigger state fully consumed on the denial path too.
  const handle = b.world.entity(entity);
  expect(handle?.has(AwaitingHuman)).toBe(false);
  expect(handle?.has(HumanResponse)).toBe(false);
  expect(handle?.has(PendingToolCalls)).toBe(false);
});
