// CI-04 gate: the shipped reactAgent eval suite, fully scripted and zero-network.
//
// This drives the EXACT react-agent (assistantAgent + spawnReactAgent) through
// the Phase 8 harness `runEvalSuite` end-to-end. It requires no API key — each
// case carries its own scripted model turns, so the default path uses
// scriptedModel. The real-model path lives only in main.ts and is never invoked
// here; this file imports no model-provider package and reads no environment.

import { createWorld } from '@langecs/core';
import { assertSnapshotMatch, runEvalSuite } from '@langecs/eval';
import { expect, test } from 'vitest';
import { reactAgentDataset, spawnReactAgent } from './suite';

test('reactAgent eval suite passes its CI gate, fully scripted (CI-04)', async () => {
  const world = createWorld({ id: 'eval-react-agent' });

  // No realModel + no key -> the deterministic scripted path. The CI-01 gate
  // (passRate >= passThreshold) is applied to the shipped suite.
  const result = await runEvalSuite(world, reactAgentDataset, {
    wireAgent: spawnReactAgent,
    scoreThreshold: 1.0,
    passThreshold: 1.0,
  });

  // The CI gate: every scripted case clears its scorer.
  expect(result.passRate).toBeGreaterThanOrEqual(result.passThreshold);
  expect(result.total).toBe(reactAgentDataset.length);

  // The status gate: the agent quiesced cleanly in every sub-world before scoring.
  expect(result.cases.every((c) => c.status === 'done')).toBe(true);
});

test('one characterization case locks its structural shape (CI-02 in the shipped example)', async () => {
  const world = createWorld({ id: 'eval-react-agent' });
  const result = await runEvalSuite(world, reactAgentDataset, {
    wireAgent: spawnReactAgent,
    scoreThreshold: 1.0,
    passThreshold: 1.0,
  });

  // Lock ONE case's normalized sub-world snapshot as a golden fixture. A
  // behavior change to the reactAgent's transcript shape fails this snapshot.
  // Small set only (08-RESEARCH Pitfall E) — the bulk relies on passRate above.
  const characterizationCase = result.cases[0];
  expect(characterizationCase).toBeDefined();
  if (characterizationCase) assertSnapshotMatch(characterizationCase.snapshot);
});
