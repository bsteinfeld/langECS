// Golden structural-regression coverage (CI-02): assertSnapshotMatch locks a
// normalized fixture, normalizeSnapshot is stable across volatile-only deltas,
// and a structural change is detectable as drift. Deterministic, zero-network.

import { createWorld, type Snapshot } from '@langecs/core';
import { describe, expect, test } from 'vitest';
import {
  assertSnapshotMatch,
  CaseTag,
  DatasetTag,
  EvalInput,
  normalizeSnapshot,
} from '../src/index';

// A small deterministic sub-world: spawn a couple of data-only components and
// snapshot it. No model, no network — just structural shape.
function buildCaseWorld(id: string): Snapshot {
  const world = createWorld({ id });
  world.spawn(CaseTag(), EvalInput('What is 2+3?'));
  return world.snapshot();
}

describe('assertSnapshotMatch — golden lock (CI-02)', () => {
  test('locks a deterministic sub-world snapshot (writes then matches the fixture)', () => {
    // First run writes __snapshots__/snapshot.test.ts.snap; later runs compare.
    // CI fails on a new/changed snapshot -> behavior-drift detection.
    const snapshot = buildCaseWorld('eval-golden');
    assertSnapshotMatch(snapshot);
  });
});

describe('normalizeSnapshot — stable across re-runs (CI-02)', () => {
  test('two snapshots differing only in worldId + nextEntityId normalize equal', () => {
    const base = buildCaseWorld('eval-a');
    // Same structural shape, different per-case id and a bumped allocation
    // counter — exactly the volatile churn normalizeSnapshot must absorb.
    const variant: Snapshot = {
      ...base,
      worldId: 'eval-b',
      nextEntityId: base.nextEntityId + 99,
    };

    expect(normalizeSnapshot(base)).toEqual(normalizeSnapshot(variant));
    // Sanity: the raw snapshots are NOT equal — normalization did the work.
    expect(base).not.toEqual(variant);
  });

  test('volatile fields (worldId/nextEntityId) are not passed through', () => {
    const normalized = normalizeSnapshot(buildCaseWorld('eval-c')) as Record<string, unknown>;
    expect('worldId' in normalized).toBe(false);
    expect('nextEntityId' in normalized).toBe(false);
    // The behavioral shape is preserved.
    expect('entities' in normalized).toBe(true);
    expect('pendingPairs' in normalized).toBe(true);
  });

  test('timestamp-ish component fields are stripped (no fixture churn)', () => {
    const withTs: Snapshot = {
      version: 1,
      worldId: 'eval-ts',
      step: 0,
      nextEntityId: 2,
      entities: [{ id: 1, components: { Note: { text: 'hi', ms: 1718000000000 } } }],
      pendingPairs: [],
    };
    const withDifferentTs: Snapshot = {
      ...withTs,
      entities: [{ id: 1, components: { Note: { text: 'hi', ms: 9999999999999 } } }],
    };
    // The differing `ms` is stripped, so the normalized forms are equal.
    expect(normalizeSnapshot(withTs)).toEqual(normalizeSnapshot(withDifferentTs));
  });
});

describe('normalizeSnapshot — drift detection (CI-02)', () => {
  test('a structural change (added component) is NOT deep-equal to the golden', () => {
    const golden = normalizeSnapshot(buildCaseWorld('eval-drift'));

    // Build the same world but with an EXTRA component on the case entity — a
    // stand-in for a behavior change that adds structural shape. This WOULD fail
    // assertSnapshotMatch's toMatchSnapshot against the committed golden.
    const drifted = createWorld({ id: 'eval-drift' });
    drifted.spawn(CaseTag(), EvalInput('What is 2+3?'), DatasetTag());
    expect(normalizeSnapshot(drifted.snapshot())).not.toEqual(golden);
  });
});
