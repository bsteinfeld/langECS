// Eval scoring systems (EVAL-02). Two single-fire systems designed so neither
// retriggers on its own write — the subtlest correctness requirement of the
// phase (SPEC §5 / R26 self-write exclusion, RESEARCH.md Pitfall 2).
//
//   scoreCase     resolves the scorer named by ScorerRef and writes Score.
//   verdictSystem reads Score and writes a pass/fail Verdict.
//
// Self-retrigger safety: scoreCase queries `Score` ONLY via `Not(Score)` (never
// as a positive term), so it never reads — and so never refires on — the Score
// it writes; `EvalComplete` is its newly-matched one-shot dirty trigger.
// verdictSystem likewise queries `Verdict` only via `Not(Verdict)`. Because both
// write to the SAME case entity (never a separate aggregate entity), neither
// write is foreign dirt for the other's positive terms. Suite-level aggregation
// (an AggregateSystem on the DatasetTag controller entity) is deferred to
// Phase 8 — deliberately absent here (scope guard).

import { defineSystem, Not, type World } from '@langecs/core';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from './components';
import type { Scorer } from './scorers';

/**
 * Scores one completed eval case. Fires exactly once per case: its query matches
 * when `EvalComplete` is newly stamped and no `Score` exists yet (`Not(Score)`),
 * and writing `Score` removes it from the match set so it cannot refire. It
 * resolves the scorer indirectly via `ScorerRef` (a plain string key) against the
 * world resource registry — no scorer function ever lives in a component (R3).
 */
export const scoreCase = defineSystem({
  name: 'eval:scoreCase',
  query: [CaseTag, EvalOutput, EvalExpected, EvalComplete, ScorerRef, Not(Score)],
  run: async (e, ctx) => {
    const scorer = ctx.resource<Scorer>(e.get(ScorerRef));
    const s = await scorer.score(e.get(EvalOutput), e.get(EvalExpected));
    e.set(Score, s);
  },
});

/**
 * Turns a numeric `Score` into a pass/fail `Verdict` on the same case entity.
 * Fires once per case: the newly-matched `Score` dirt (foreign to this system —
 * `scoreCase` wrote it) plus `Not(Verdict)` is the one-shot trigger. The pass
 * threshold comes from the optional `eval:threshold` resource, falling back to
 * `1.0` (exact-match semantics) when none is registered; the Phase 8 harness will
 * supply a threshold resource. It never writes a separate aggregate entity, so
 * its `Verdict` write is not foreign dirt for `scoreCase` (which guards on
 * `Not(Score)`, not `Verdict`).
 */
export const verdictSystem = defineSystem({
  name: 'eval:verdictSystem',
  query: [CaseTag, Score, Not(Verdict)],
  run: (e, ctx) => {
    const threshold = (() => {
      try {
        return ctx.resource<number>('eval:threshold');
      } catch {
        return 1.0;
      }
    })();
    e.set(Verdict, e.get(Score) >= threshold ? 'pass' : 'fail');
  },
});

/**
 * Registers both eval scoring systems globally on a world, mirroring how stdlib
 * presets register their systems via `world.use`. Pair with
 * `registerBuiltinScorers(world)` so `scoreCase` can resolve `ScorerRef` keys.
 */
export function registerEvalSystems(world: World): void {
  world.use(scoreCase);
  world.use(verdictSystem);
}
