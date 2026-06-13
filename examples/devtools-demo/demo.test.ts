// Deterministic test of the devtools-demo scenario (no server, no otel, no
// network): the policy model drives the full refund arc, the approval
// interrupt parks and resumes, and the flaky worker heals via retry.

import { lastAssistant, registerTools, sendMessage } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import {
  createDemoWorld,
  demoTools,
  Jobs,
  MODEL_RESOURCE,
  ProcessedJobs,
  policyModel,
} from './world';

test('refund request parks on tool-approval, resumes to a refund answer', async () => {
  const { world, support } = createDemoWorld();
  registerTools(world, demoTools);
  world.register(MODEL_RESOURCE, policyModel());

  const run = await sendMessage(world, support, 'Please refund order #1042 — it arrived broken.');
  expect(run.status).toBe('pending');
  const pending = world.pending();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.entity).toBe(support.id);
  expect(pending[0]?.interrupts[0]?.kind).toBe('tool-approval');

  const resumed = await world.resume(support.id, { approved: true });
  expect(resumed.status).toBe('done');
  expect(lastAssistant(world, support)?.content).toContain('refunded $42.50');
});

test('denied approval produces a polite refusal', async () => {
  const { world, support } = createDemoWorld();
  registerTools(world, demoTools);
  world.register(MODEL_RESOURCE, policyModel());

  await sendMessage(world, support, 'Refund order #1043, it is broken');
  const resumed = await world.resume(support.id, {
    approved: false,
    reason: 'warranty expired',
  });
  expect(resumed.status).toBe('done');
  expect(lastAssistant(world, support)?.content).toContain("won't refund order #1043");
});

test('flaky worker fails once, retry heals it, history records both attempts', async () => {
  const { world, adapter, worker } = createDemoWorld();
  registerTools(world, demoTools);
  world.register(MODEL_RESOURCE, policyModel());

  const run = await world.send(worker, Jobs(['index-knowledge-base']));
  expect(run.status).toBe('done');
  expect(world.entity(worker.id)?.get(ProcessedJobs)).toEqual(['index-knowledge-base']);
  // The MemoryAdapter saw every boundary — time travel has steps to offer.
  const history = await adapter.history(world.id);
  expect(history.length).toBeGreaterThan(1);
});
