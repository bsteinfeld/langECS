// Benchmarking/metrics components for LangECS (BENCH-01/BENCH-02, R3).
// All values are plain JSON data (R3); behavior (metering, aggregation) lives in
// Wave 2 helpers and named world resources, never inside a component value.
// All component names carry the 'bench:' prefix to avoid global registry
// collisions (R7), mirroring eval's 'eval:' convention.

import { type ComponentType, defineComponent } from '@langecs/core';

/** Append reducer: concurrent same-barrier writes merge instead of conflicting (R30). */
const append = <T>(current: T[], incoming: T[]): T[] => [...current, ...incoming];

/** Sum reducer: concurrent same-barrier numeric writes accumulate instead of conflicting (R30). */
const sum = (current: number, incoming: number): number => current + incoming;

/**
 * One model call's token spend (BENCH-01). Generalized from research-team's
 * `{system, tokens}` to split input/output so `estimateCost` can price each
 * direction independently (BENCH-02). Plain JSON, no functions (R3).
 */
export type Spend = { system: string; inputTokens: number; outputTokens: number };

/**
 * Append-ledger of every model call's token spend. The append reducer lets
 * concurrent same-barrier model calls merge their entries rather than throwing
 * WriteConflictError (R30).
 */
export const TokenUsage: ComponentType<Spend[]> = defineComponent<Spend[]>({
  name: 'bench:TokenUsage',
  reducer: append,
});

/**
 * Estimated USD cost for a run. The sum reducer lets multi-call runs accumulate
 * cost across same-barrier writes rather than conflicting (R30).
 */
export const CostEstimate: ComponentType<number> = defineComponent<number>({
  name: 'bench:CostEstimate',
  reducer: sum,
});

/** Wall-clock latency in milliseconds. Written once by the Wave 2 harness helper (no reducer). */
export const LatencyMs: ComponentType<number> = defineComponent<number>({
  name: 'bench:LatencyMs',
});

/** Number of scheduler steps the run took (from RunResult.steps). Written once (no reducer). */
export const StepCount: ComponentType<number> = defineComponent<number>({
  name: 'bench:StepCount',
});

/** The aggregate benchmark report shape (BENCH-04). All fields plain JSON (R3). */
export interface BenchmarkReportData {
  cases: number;
  passed: number;
  failed: number;
  passRate: number;
  meanScore: number;
  latencyMs: { mean: number; p95: number };
  cost: { mean: number; total: number };
  totalTokens: number;
  ranAt: string;
}

/**
 * The aggregated run report, written once by the Wave 2 aggregator (no reducer).
 * A plain data object — no functions or class instances (R3).
 */
export const BenchmarkReport: ComponentType<BenchmarkReportData> =
  defineComponent<BenchmarkReportData>({
    name: 'bench:BenchmarkReport',
  });
