// Benchmark aggregation + suite wrapper (BENCH-03).
//
// Aggregation is PLAIN JS, never an ECS system: an aggregation system querying
// Score/TokenUsage would re-fire on its own/foreign writes (self-retrigger,
// 09-RESEARCH Pitfall 1 / T-09-06). `buildBenchmarkReport` reads token/cost from
// each per-case `EvalCaseResult.snapshot` and latency/steps from the additive
// `EvalCaseResult.{wallMs,steps}` fields (09-RESEARCH Open Question 1, RESOLVED).
//
// `runBenchmarkSuite` wraps `runEvalSuite`. The sub-world model is registered by the
// harness BEFORE `wireAgent` and resource values are never externally readable (R18),
// and external world writes throw mid-run (R16) — so per-call `ctx.write` metering
// (the `meteredModel` shape) cannot be injected into an arbitrary harness-driven
// agent. Instead the wrapper meters at the IDLE `extractOutput` seam (called by the
// harness after quiescence, BEFORE it captures the per-case snapshot): it reads the
// agent's `Messages` transcript, splits assistant vs non-assistant tokens via the
// same `estimateTokens` fallback `meteredModel` uses, and writes `TokenUsage`/
// `CostEstimate` onto the agent so they land in that snapshot. Latency/steps come
// from the harness's additive `wallMs`/`steps`; `opts.clock` passes through for
// deterministic latency (never assert real ms — Pitfall 3).
//
// `writeBenchmarkReport` makes a finished report snapshot-able via an external
// `world.spawn` onto a DatasetTag controller entity (NOT a system, Pitfall 1).

import type { EntityHandle, EntityTarget, Msg, Snapshot, World } from '@langecs/core';
import {
  DatasetTag,
  type EvalCase,
  type EvalSuiteResult,
  type RunEvalSuiteOptions,
  runEvalSuite,
} from '@langecs/eval';
import { estimateTokens, lastAssistant, Messages } from '@langecs/stdlib';
import {
  BenchmarkReport,
  type BenchmarkReportData,
  CostEstimate,
  type Spend,
  TokenUsage,
} from './components';
import { estimateCost } from './cost';

// ----------------------------------------------------------------- pure helpers

/** 95th percentile of `xs` (0 for empty). Index = ceil(0.95·n)-1, clamped to [0, n-1]. */
const p95 = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx] ?? 0;
};

/** First numeric value of `componentName` across the snapshot's entities, else 0. */
function readNum(snap: Snapshot, componentName: string): number {
  for (const entity of snap.entities) {
    const value = entity.components[componentName];
    if (typeof value === 'number') return value;
  }
  return 0;
}

/** Sum of input+output tokens over the first `bench:TokenUsage` ledger found, else 0. */
function readTokens(snap: Snapshot): number {
  for (const entity of snap.entities) {
    const ledger = entity.components['bench:TokenUsage'] as Spend[] | undefined;
    if (Array.isArray(ledger)) {
      return ledger.reduce((acc, spend) => acc + spend.inputTokens + spend.outputTokens, 0);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- aggregation

/**
 * Rolls an `EvalSuiteResult` into a snapshot-able `BenchmarkReportData`. Pass-rate,
 * mean score, and case counts come straight from the suite; latency (mean + p95)
 * from each case's additive `wallMs`; cost and tokens are read out of each case's
 * `snapshot`. Pure — no world, no clock, no I/O.
 */
export function buildBenchmarkReport(suite: EvalSuiteResult): BenchmarkReportData {
  const latencies = suite.cases.map((c) => c.wallMs ?? 0);
  const costs = suite.cases.map((c) => readNum(c.snapshot, 'bench:CostEstimate'));
  const tokens = suite.cases.map((c) => readTokens(c.snapshot));
  const n = suite.cases.length || 1;
  const totalCost = costs.reduce((acc, v) => acc + v, 0);
  return {
    cases: suite.total,
    passed: suite.passed,
    failed: suite.failed,
    passRate: suite.passRate,
    meanScore: suite.meanScore,
    latencyMs: { mean: latencies.reduce((acc, v) => acc + v, 0) / n, p95: p95(latencies) },
    cost: { mean: totalCost / n, total: totalCost },
    totalTokens: tokens.reduce((acc, v) => acc + v, 0),
    ranAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- suite wrapper

/**
 * Options for `runBenchmarkSuite`: every `runEvalSuite` option plus an optional
 * cost-model name. The inherited `modelFactory` (ungated per-case model factory,
 * CMP-01) flows through unchanged via the `{ ...opts }` spread into `runEvalSuite`
 * below — it drives the per-candidate model path `runComparison` uses.
 */
export interface RunBenchmarkSuiteOptions extends RunEvalSuiteOptions {
  /** A `MODEL_PRICING` key; when set, a `CostEstimate` is metered per case. */
  modelName?: string;
}

/**
 * Splits an agent transcript into a single advisory `Spend`: assistant-message
 * tokens count as output, everything else (user/system/tool) as input. Uses the
 * same `estimateTokens` heuristic as `meteredModel` (ADVISORY, ~4 chars/token,
 * T-09-04). Returns `undefined` for an empty transcript so no metric is written.
 */
function meterTranscript(messages: Msg[]): Spend | undefined {
  if (messages.length === 0) return undefined;
  const output = messages.filter((m) => m.role === 'assistant');
  const input = messages.filter((m) => m.role !== 'assistant');
  return {
    system: 'callLLM',
    inputTokens: input.length > 0 ? estimateTokens(input) : 0,
    outputTokens: output.length > 0 ? estimateTokens(output) : 0,
  };
}

/**
 * Wraps `runEvalSuite` with token/cost metering. Token/cost capture happens at the
 * idle `extractOutput` seam (see file header): the agent's `Messages` transcript is
 * split into input/output token estimates and written as `TokenUsage` (+ optional
 * `CostEstimate`) onto the agent BEFORE the harness captures the per-case snapshot,
 * so the metrics land in it. Latency/steps come from the harness's additive
 * `wallMs`/`steps`; `opts.clock` passes through for determinism.
 */
export async function runBenchmarkSuite(
  world: World,
  dataset: readonly EvalCase[],
  opts: RunBenchmarkSuiteOptions,
): Promise<{ suite: EvalSuiteResult; report: BenchmarkReportData }> {
  const baseExtract = opts.extractOutput;
  const extractOutput = (subWorld: World, agent: EntityTarget): string => {
    const id = typeof agent === 'number' ? agent : agent.id;
    const entity = subWorld.entity(id);
    const transcript = entity?.get(Messages) ?? [];
    const spend = meterTranscript(transcript);
    if (entity && spend && spend.inputTokens + spend.outputTokens > 0) {
      // Idle external writes apply immediately (R16); they land in the snapshot
      // the harness captures right after this extractor returns.
      entity.add(TokenUsage, [spend]);
      if (opts.modelName !== undefined) {
        entity.add(
          CostEstimate,
          estimateCost(
            { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
            opts.modelName,
          ),
        );
      }
    }
    return baseExtract
      ? baseExtract(subWorld, agent)
      : (lastAssistant(subWorld, agent)?.content ?? '');
  };

  const suite = await runEvalSuite(world, dataset, { ...opts, extractOutput });
  return { suite, report: buildBenchmarkReport(suite) };
}

// ------------------------------------------------------------- report writeback

/**
 * Spawns a controller entity (tagged `DatasetTag`) carrying a finished
 * `BenchmarkReport`, so `world.snapshot()` captures it. External `world.spawn`,
 * never a system — aggregation/writeback is plain JS to avoid the self-retrigger
 * loop (09-RESEARCH Pitfall 1 / T-09-06). Returns the spawned handle.
 */
export function writeBenchmarkReport(world: World, report: BenchmarkReportData): EntityHandle {
  return world.spawn(DatasetTag(), BenchmarkReport(report));
}
