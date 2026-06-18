// Model comparison for LangECS (CMP-01, CMP-02).
//
// `runComparison` runs ONE dataset against ONE agent-under-test across N candidate
// models, each candidate isolated in its own fresh outer world, and emits a ranked,
// snapshot-able `ComparisonReport`. It is a THIN orchestration loop over the shipped
// `runBenchmarkSuite` (Phase 9), which already forks a sub-world per case, registers
// the candidate's model into each sub-world, gates the quiescence/scoring chain, and
// aggregates a full `BenchmarkReportData`. Phase 10 wires N suite runs together and
// sorts the results in plain JS.
//
// FORK RECONCILIATION (CMP-01). The roadmap describes CMP-01 as "an isolated fork via
// world.snapshot() + world.load() per candidate, swapping the model:* registry entry."
// That literal snapshot()/load() base-world fork is intentionally NOT implemented here.
// `world.load()` does NOT restore resources (R36/R18), so a loaded base world could not
// carry the per-candidate model — you would re-register `model:main` after every load(),
// which is exactly what the harness already does per sub-world. Running N independent
// `runBenchmarkSuite` calls (each with a fresh outer world + the candidate's model via
// the Plan 01 `modelFactory`) delivers identical starting state AND a per-candidate
// model swap — strictly STRONGER isolation than a literal fork — so CMP-01 is satisfied
// by intent. Candidate runs share no state because nothing is passed between worlds.
//
// PLAIN-JS RANKING (CMP-02). `rankCandidates` is plain JS, NEVER an ECS system. An
// aggregation system that queried the per-candidate reports and wrote a ranking would
// re-fire on its own/foreign writes (self-retrigger, R26/R27); Phases 8 and 9 kept
// aggregation plain JS for exactly this reason. The ranking comparator ends with a
// `name.localeCompare` tiebreak so identical-metric candidates order deterministically
// (without it the winner could flip across runs).
//
// SMALL-N CAVEAT (anti-feature). The `ComparisonReport` is a DETERMINISTIC side-by-side
// over one fixed dataset, NOT a statistical, Elo, or arena-style claim. The "winner" is
// "best on this dataset by this rank key," nothing more. There are no confidence,
// significance, or pValue fields — and there never will be (v2.0 exclusion).
//
// ZERO-NETWORK DEFAULT. Scripted candidates run via the ungated `modelFactory` (no
// network, no OPENAI_API_KEY). A real candidate (`isReal: true`) routes through the
// harness `realModel` + `OPENAI_API_KEY` gate, unchanged — it only goes live when the
// key is present.

import {
  type ComponentType,
  createWorld,
  defineComponent,
  type EntityHandle,
  type EntityTarget,
  type Model,
  type World,
} from '@langecs/core';
import { DatasetTag, type EvalCase } from '@langecs/eval';
import type { BenchmarkReportData } from './components';
import { runBenchmarkSuite } from './report';

// --------------------------------------------------------------------- types

/**
 * One model under comparison. `model` may be a `Model` instance OR a `() => Model`
 * factory. A factory is REQUIRED for a multi-case dataset because `scriptedModel` is
 * stateful and exhausts (R44) — a single shared instance reused across cases would
 * throw. A bare `Model` instance is accepted ONLY for a single-case dataset (wrapped
 * as a one-shot factory). A real candidate sets `isReal: true` to route through the
 * harness `realModel` + `OPENAI_API_KEY` gate instead of the scripted path.
 */
export interface Candidate {
  name: string;
  model: Model | (() => Model);
  isReal?: boolean;
}

/** The agent-under-test, wired identically into every candidate's sub-world. */
export interface AgentUnderTest {
  wireAgent: (world: World) => EntityHandle;
}

/**
 * Shared options applied IDENTICALLY to every candidate — only the model varies, so
 * the comparison is fair by construction. Per-candidate dataset/threshold/agentDef
 * drift is impossible: those live here (or as positionals), never on `Candidate`.
 */
export interface RunComparisonOptions {
  /** Primary rank key. Default `'passRate'`. */
  rankBy?: 'passRate' | 'meanScore';
  /** Tiebreak order on a primary-key tie (lower wins). Default `['cost', 'latency']`. */
  tiebreak?: ('cost' | 'latency')[];
  /** Per-case verdict pass threshold (eval:threshold). Forwarded to every candidate. */
  scoreThreshold?: number;
  /** Suite-level pass-rate echoed in each candidate's report. Forwarded to every candidate. */
  passThreshold?: number;
  /** Injectable wall clock for deterministic latency in tests. Forwarded to every candidate. */
  clock?: () => number;
  /** Override the default output extractor for non-chat agents. Forwarded to every candidate. */
  extractOutput?: (world: World, agent: EntityTarget) => string;
}

/**
 * The ranked, side-by-side comparison report (CMP-02, R3). All fields are plain JSON —
 * each candidate is identified by its `name` STRING, never a `Model` object or function,
 * so `world.snapshot()` round-trips without throwing.
 */
export interface ComparisonReportData {
  candidates: Array<{
    name: string;
    passRate: number;
    meanScore: number;
    report: BenchmarkReportData;
  }>;
  /** Candidate names, best first. */
  ranked: string[];
  /** `ranked[0]` (empty string for no candidates). */
  winner: string;
  rankedBy: 'passRate' | 'meanScore';
  /** ISO timestamp; normalize away from golden fixtures. */
  ranAt: string;
}

/**
 * The comparison report component (`bench:ComparisonReport`). No reducer — written once
 * via an external `world.spawn` (see `writeComparisonReport`). Plain data only (R3).
 */
export const ComparisonReport: ComponentType<ComparisonReportData> =
  defineComponent<ComparisonReportData>({ name: 'bench:ComparisonReport' });

// --------------------------------------------------------------------- ranking

type CandidateRow = ComparisonReportData['candidates'][number];

/**
 * Ranks candidate rows in plain JS (NOT an ECS system — self-retrigger, R26/R27).
 * Primary key: `opts.rankBy ?? 'passRate'`, sorted DESC. On a primary-key tie, applies
 * `opts.tiebreak ?? ['cost', 'latency']` (lower-is-better, reading `report.cost.total`
 * then `report.latencyMs.mean`). The final `name.localeCompare` tiebreak makes the
 * ordering deterministic for identical-metric candidates (without it the winner could
 * flip across runs — Pitfall 2). Returns `{ ranked, winner }`; `winner === ranked[0]`
 * (empty string for no candidates).
 */
export function rankCandidates(
  rows: readonly CandidateRow[],
  opts: Pick<RunComparisonOptions, 'rankBy' | 'tiebreak'> = {},
): { ranked: string[]; winner: string } {
  const by = opts.rankBy ?? 'passRate';
  const tiebreak = opts.tiebreak ?? ['cost', 'latency'];
  const sorted = [...rows].sort((a, b) => {
    const primary = by === 'meanScore' ? b.meanScore - a.meanScore : b.passRate - a.passRate;
    if (primary !== 0) return primary;
    for (const t of tiebreak) {
      const av = t === 'cost' ? a.report.cost.total : a.report.latencyMs.mean;
      const bv = t === 'cost' ? b.report.cost.total : b.report.latencyMs.mean;
      if (av !== bv) return av - bv; // lower cost/latency wins
    }
    return a.name.localeCompare(b.name); // final deterministic tiebreak by name
  });
  return { ranked: sorted.map((r) => r.name), winner: sorted[0]?.name ?? '' };
}

// --------------------------------------------------------------------- run

/**
 * Derives a per-case model factory from a candidate's `model`. A factory is used
 * directly. A bare `Model` instance is wrapped as a one-shot factory ONLY for a
 * single-case dataset; for a multi-case dataset it throws, because a stateful
 * `scriptedModel` reused across cases would exhaust (R44).
 */
function modelFactoryFor(candidate: Candidate, caseCount: number): () => Model {
  if (typeof candidate.model === 'function') return candidate.model as () => Model;
  if (caseCount <= 1) {
    const instance = candidate.model;
    return () => instance;
  }
  throw new Error(
    `runComparison: candidate '${candidate.name}' supplied a bare Model instance for a ` +
      `multi-case dataset (${caseCount} cases). A stateful model (e.g. scriptedModel) reused ` +
      `across cases would exhaust (R44). Pass a factory '() => model' so each case gets a fresh model.`,
  );
}

/**
 * Runs `dataset` against `agentDef` across every `candidate`, each candidate isolated
 * in its own fresh outer world via `runBenchmarkSuite`. Validates candidate names are
 * unique BEFORE any run (ambiguous-winner guard). Scripted candidates use the ungated
 * `modelFactory`; real candidates (`isReal`) route through the gated `realModel` path.
 * Returns the ranked `ComparisonReportData`. Persist it via `writeComparisonReport`.
 */
export async function runComparison(
  dataset: readonly EvalCase[],
  agentDef: AgentUnderTest,
  candidates: readonly Candidate[],
  opts: RunComparisonOptions = {},
): Promise<ComparisonReportData> {
  // Repudiation guard: duplicate names make the winner ambiguous. Throw before any run.
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.name)) {
      throw new Error(
        `runComparison: duplicate candidate name '${c.name}'. Candidate names must be unique ` +
          `(they identify the winner and key per-candidate cost).`,
      );
    }
    seen.add(c.name);
  }

  const rows: ComparisonReportData['candidates'] = [];
  for (const candidate of candidates) {
    // Fresh OUTER world per candidate — a shared world would accumulate case entities
    // across candidates (no shared state; fair comparison by construction).
    const world = createWorld({ id: `cmp-${candidate.name}` });

    // Real candidates route through the gated realModel path; scripted candidates use
    // the ungated per-case factory. Only one of the two model options is ever set.
    const modelOpts = candidate.isReal
      ? { realModel: modelFactoryFor(candidate, 1)() }
      : { modelFactory: modelFactoryFor(candidate, dataset.length) };

    const { report } = await runBenchmarkSuite(world, dataset, {
      wireAgent: agentDef.wireAgent,
      // candidate.name is passed straight as the MODEL_PRICING key; estimateCost's
      // Object.hasOwn guard (V5) maps unknown/prototype keys to 0 — no second lookup.
      modelName: candidate.name,
      ...modelOpts,
      scoreThreshold: opts.scoreThreshold,
      passThreshold: opts.passThreshold,
      ...(opts.clock && { clock: opts.clock }),
      ...(opts.extractOutput && { extractOutput: opts.extractOutput }),
    });

    rows.push({
      name: candidate.name,
      passRate: report.passRate,
      meanScore: report.meanScore,
      report,
    });
  }

  const { ranked, winner } = rankCandidates(rows, opts);
  return {
    candidates: rows,
    ranked,
    winner,
    rankedBy: opts.rankBy ?? 'passRate',
    ranAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------- report writeback

/**
 * Spawns a controller entity (tagged `DatasetTag`) carrying a finished
 * `ComparisonReport`, so `world.snapshot()` captures it. External `world.spawn`,
 * never a system — mirrors `writeBenchmarkReport` (plain JS, avoids self-retrigger).
 * Returns the spawned handle.
 */
export function writeComparisonReport(world: World, report: ComparisonReportData): EntityHandle {
  return world.spawn(DatasetTag(), ComparisonReport(report));
}
