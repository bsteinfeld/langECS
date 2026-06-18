// Eval suite orchestrator (EVAL-04, EVAL-05, CI-01).
//
// `runEvalSuite` turns the Phase 7 eval vocabulary (components + scorers +
// scoreCase/verdictSystem) into a runnable suite. The settled architecture is
// SUB-WORLD PER CASE: each EvalCase runs the agent-under-test in a throwaway
// `createWorld`; only the extracted output + an `EvalComplete` stamp flow back
// to the caller-supplied OUTER world, which owns scoring. This makes the
// score-before-quiescence pitfall impossible by construction — the agent and
// the scorers run in different worlds at different times (08-RESEARCH Pattern 1).
//
// Aggregation (pass-rate) is plain JS here, NOT an ECS system, to avoid the
// self-retrigger loop Phase 7 deliberately deferred (08-RESEARCH Pitfall C).
//
// The default path is zero-network: each case carries its own `script` fed to
// `scriptedModel`. A real model is used ONLY when both `opts.realModel` is
// supplied AND `process.env.OPENAI_API_KEY` is set (08-RESEARCH Pattern 2). This
// package never imports a model-provider package — the real model is
// caller-supplied (08-RESEARCH Pitfall B keeps the default suite zero-network).

import {
  createWorld,
  type EntityHandle,
  type EntityTarget,
  type Model,
  type Snapshot,
  scriptedModel,
  type World,
} from '@langecs/core';
import { lastAssistant, sendMessage } from '@langecs/stdlib';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from './components';
import type { EvalCase } from './dataset';
import { registerBuiltinScorers } from './scorers';
import { registerEvalSystems } from './systems';

/** Options controlling a single `runEvalSuite` invocation. */
export interface RunEvalSuiteOptions {
  /**
   * Wire the agent-under-test into a fresh sub-world: register its tools and
   * spawn its AgentDef, returning the spawned agent handle. REQUIRED — the agent
   * definition is supplied here (not as a positional), so the harness stays
   * agnostic about how the agent is constructed. Expects a `Model` already
   * registered under `'model:main'` (the harness registers it before calling).
   */
  wireAgent: (world: World) => EntityHandle;
  /**
   * When provided AND `OPENAI_API_KEY` is set, use this real Model instead of
   * `scriptedModel`. Absent key falls back to the deterministic scripted path —
   * no test-file edit toggles paths (EVAL-05).
   */
  realModel?: Model;
  /**
   * UNGATED per-case model factory (zero-network, no `OPENAI_API_KEY` needed).
   * Consulted ONLY when the gated `realModel` path is not active, and BELOW it in
   * precedence: `realModel` (gated) > `modelFactory` (ungated) > per-case
   * `EvalCase.script`. This is the mechanism Phase 10's `runComparison` uses to run
   * N candidate models over one shared dataset (CMP-01): each candidate supplies a
   * factory, and the harness swaps the `'model:main'` registry entry per case.
   *
   * MUST return a FRESH `Model` per call. The harness resolves the model once per
   * case, and `scriptedModel` is STATEFUL (advances an index and throws when
   * exhausted, R44) — a reused instance would exhaust across cases. Returning
   * `() => scriptedModel(turns)` (a new model each call) keeps every case isolated.
   */
  modelFactory?: () => Model;
  /** Per-case verdict pass threshold, registered as the `eval:threshold` resource. Default 1.0. */
  scoreThreshold?: number;
  /** Suite-level pass-rate the CI gate asserts (`passRate >= passThreshold`). Default 1.0. */
  passThreshold?: number;
  /** Override the default `lastAssistant` output extractor for non-chat agents. */
  extractOutput?: (world: World, agent: EntityTarget) => string;
  /**
   * Injectable wall clock for deterministic per-case latency (default `Date.now`).
   * Times each case's `sendMessage` to populate `EvalCaseResult.wallMs`. Additive,
   * non-breaking: callers that ignore it get the default-clock behavior unchanged
   * (Phase 9 BENCH-03 metric flow; tests inject a fake clock — 09-RESEARCH Pitfall 3).
   */
  clock?: () => number;
}

/** Per-case result row. `status` is always `'done'` — non-done runs throw before reaching here. */
export interface EvalCaseResult {
  id: string;
  output: string;
  score: number;
  verdict: 'pass' | 'fail' | 'skip';
  status: 'done';
  /** The sub-world snapshot captured at quiescence (consumed by the Wave 2 snapshot helper). */
  snapshot: Snapshot;
  /**
   * Authoritative scheduler step count of this case's run, from `RunResult.steps`.
   * Additive optional field (Phase 9 BENCH-03): existing consumers ignore it.
   */
  steps?: number;
  /**
   * Elapsed wall time (ms) of this case's `sendMessage`, measured via the
   * injectable `clock` (default `Date.now`). Additive optional field (Phase 9
   * BENCH-03); used by `buildBenchmarkReport` for mean/p95 latency.
   */
  wallMs?: number;
}

/** Aggregate result of running an entire suite. */
export interface EvalSuiteResult {
  cases: EvalCaseResult[];
  total: number;
  passed: number;
  failed: number;
  /** passed / total (0 for an empty suite). */
  passRate: number;
  /** Echoed from `opts.passThreshold` (default 1.0). The CI gate asserts `passRate >= this`. */
  passThreshold: number;
  /** Mean per-case Score (0 for an empty suite). */
  meanScore: number;
  /** ISO timestamp of completion. Normalize this away from golden fixtures. */
  ranAt: string;
}

/**
 * Selects the model for one case. Three-way precedence, evaluated top-down:
 *   1. GATED real model — only when BOTH `opts.realModel` is supplied AND
 *      `OPENAI_API_KEY` is set (UNCHANGED, EVAL-05).
 *   2. UNGATED `opts.modelFactory` — when no gated real model is active, a
 *      supplied factory yields a FRESH model per case regardless of any env key
 *      (CMP-01 zero-network comparison path; the factory must return a new model
 *      each call because `scriptedModel` is stateful and exhausts, R44).
 *   3. Per-case `EvalCase.script` → `scriptedModel` (UNCHANGED fallback). The
 *      script is typed loosely (`role: string`) while `scriptedModel` wants
 *      `(Msg | fn)[]`, so a cast at this single boundary is expected
 *      (08-RESEARCH Pitfall F).
 * This function is the only place the model path is decided — no test-file edits
 * toggle paths (EVAL-05).
 */
function resolveModel(c: EvalCase, opts: RunEvalSuiteOptions): Model {
  const useReal = opts.realModel !== undefined && !!process.env.OPENAI_API_KEY;
  if (useReal) return opts.realModel as Model;
  if (opts.modelFactory !== undefined) return opts.modelFactory();
  return scriptedModel((c.script ?? []) as Parameters<typeof scriptedModel>[0]);
}

/**
 * Runs an eval `dataset` against the agent wired by `opts.wireAgent`, isolating
 * each case in its own throwaway sub-world and scoring only after the agent
 * reaches quiescence (`RunResult.status === 'done'`). A non-`'done'` status
 * THROWS — eval never silently scores a partial transcript (EVAL-04). Scoring
 * runs in the supplied OUTER `world` via the shipped scoreCase -> verdictSystem
 * chain. Returns the aggregated pass-rate the CI gate asserts (CI-01).
 */
export async function runEvalSuite(
  world: World,
  dataset: readonly EvalCase[],
  opts: RunEvalSuiteOptions,
): Promise<EvalSuiteResult> {
  // The OUTER world owns scoring (Phase 7 systems). Register before the loop so
  // the scoring chain can fire and resolve ScorerRef keys.
  registerBuiltinScorers(world);
  registerEvalSystems(world);
  world.register('eval:threshold', opts.scoreThreshold ?? 1.0);

  const results: EvalCaseResult[] = [];
  for (const c of dataset) {
    // Spawn the case entity in the OUTER world (scorer queries match here).
    const caseEntity = world.spawn(
      CaseTag(),
      EvalInput(c.input),
      EvalExpected(c.expected),
      ScorerRef(c.scorer),
    );

    // --- Sub-world run (isolated per case) ---
    const caseWorld = createWorld({ id: `eval-${c.id}` });
    caseWorld.register('model:main', resolveModel(c, opts));
    const agent = opts.wireAgent(caseWorld);

    // Time the case run with the injectable clock (default Date.now) — deterministic
    // under a fake clock, no behavior change for callers that ignore wallMs.
    const now = opts.clock ?? Date.now;
    const t0 = now();
    const run = await sendMessage(caseWorld, agent, c.input);
    const wallMs = now() - t0;

    // QUIESCENCE GATE: only 'done' is safe to score (EVAL-04 / ROADMAP SC1).
    if (run.status !== 'done') {
      throw new Error(
        `runEvalSuite: case '${c.id}' did not quiesce cleanly (status '${run.status}', ` +
          `${run.steps} step(s)). Eval scores only fully-automatic 'done' runs; ` +
          `'limit' means a non-quiescing cycle hit the step cap, 'error' a thrown system, ` +
          `'pending' an unanswered human interrupt, 'idle' that no system matched. No Score or ` +
          `Verdict is produced for a non-'done' case. caseWorld.getTrace() shows what ran.`,
      );
    }

    // Extract the agent's final answer (default: last assistant message).
    const output =
      (opts.extractOutput
        ? opts.extractOutput(caseWorld, agent)
        : lastAssistant(caseWorld, agent)?.content) ?? '';
    const snapshot = caseWorld.snapshot();

    // Trigger scoring in the OUTER world: the newly-matched EvalComplete dirt
    // fires scoreCase then verdictSystem and quiesces to 'done' within this one
    // send, so Score/Verdict are populated synchronously after it resolves.
    await world.send(caseEntity, EvalOutput(output), EvalComplete());

    results.push({
      id: c.id,
      output,
      score: caseEntity.get(Score) ?? 0,
      verdict: caseEntity.get(Verdict) ?? 'skip',
      status: 'done',
      snapshot,
      steps: run.steps,
      wallMs,
    });
  }

  // --- Plain-JS aggregation (NOT an ECS system — avoids self-retrigger) ---
  const total = results.length;
  const passed = results.filter((r) => r.verdict === 'pass').length;
  const meanScore = total ? results.reduce((acc, r) => acc + r.score, 0) / total : 0;
  return {
    cases: results,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    passThreshold: opts.passThreshold ?? 1.0,
    meanScore,
    ranAt: new Date().toISOString(),
  };
}
