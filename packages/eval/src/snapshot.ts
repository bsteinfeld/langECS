// Golden structural-regression helper (CI-02).
//
// `assertSnapshotMatch` locks the STRUCTURAL SHAPE of a case's sub-world via
// vitest's `toMatchSnapshot()`: the first run writes a fixture under
// `__snapshots__/`, every subsequent run compares against it, and CI fails on a
// new/changed snapshot. This catches behavior drift — a change in which
// components an entity carries, or which pairs are pending, surfaces as a
// snapshot diff a reviewer must consciously accept (08-RESEARCH Pattern 4).
//
// The catch is reproducibility: a raw `Snapshot` carries VOLATILE fields that
// differ run-to-run / machine-to-machine — `worldId` (the per-case `eval-<id>`)
// and `nextEntityId` (an allocation detail). Locking those would make the
// fixture churn on every case rename or unrelated spawn, eroding the gate's
// signal and training reviewers to blind-`--update` (08-RESEARCH Pitfall D + E).
// `normalizeSnapshot` strips them, keeping only the BEHAVIORAL shape
// (`version` + `entities[].{id,components}` + `pendingPairs`).
//
// Policy: lock snapshots for a SMALL characterization set only; rely on
// passRate/Verdict for the bulk (08-RESEARCH Pitfall E — brittle full-snapshot
// locking erodes the gate's signal).

import type { Snapshot } from '@langecs/core';
import { expect } from 'vitest';

/**
 * Recursively strips volatile timestamp-ish fields from a serialized component
 * value so a future timestamped component cannot silently churn the golden
 * fixture (the T21 "ignore ms" analog). Any key matching `ms`/`timestamp`/`ranAt`
 * (case-insensitive) is dropped; everything else is preserved structurally.
 * Pure — never mutates its input.
 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Volatile time fields: omit so a timestamped component does not churn.
      if (/^(ms|timestamp|ranat)$/i.test(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

/**
 * Normalizes a `Snapshot` to its stable, reproducible BEHAVIORAL shape for
 * golden-fixture comparison. Intentionally OMITS:
 *   - `worldId` — carries the per-case `eval-<id>`; varies per case (Pitfall D).
 *   - `nextEntityId` — an allocation detail, not behavior.
 *   - `step` — a run-progress counter, not structural shape.
 * Keeps `version`, `entities[].{id,components}` (the behavioral shape), and
 * `pendingPairs` (what would fire next). Component values are deep-stripped of
 * timestamp-ish fields (see `stripVolatile`).
 */
export function normalizeSnapshot(s: Snapshot): unknown {
  return {
    version: s.version,
    entities: s.entities.map((e) => ({
      id: e.id,
      components: stripVolatile(e.components),
    })),
    pendingPairs: s.pendingPairs,
  };
}

/**
 * Locks a normalized `Snapshot` as a golden fixture via vitest's
 * `toMatchSnapshot()`. First run writes `__snapshots__/`; later runs compare. A
 * structural change (added/removed component, changed pending pairs) fails the
 * snapshot test — behavior-drift detection (CI-02). Volatile fields
 * (`worldId`/`nextEntityId`/timestamps) are stripped first so the fixture is
 * stable across runs and machines.
 */
export function assertSnapshotMatch(snapshot: Snapshot): void {
  expect(normalizeSnapshot(snapshot)).toMatchSnapshot();
}
