// assertBudget — a throwing budget gate for benchmark runs (BENCH-04).
//
// ADVISORY-BUDGET WARNING: cost and token budgets derived from `estimateTokens` /
// `MODEL_PRICING` are ADVISORY (estimateTokens is ~4 chars/token, off 20-40% vs a
// real tokenizer; MODEL_PRICING lags provider changes — 09-RESEARCH Pitfall 5).
// Do NOT make an estimate a silent hard correctness gate. Hard CI gates should
// prefer LATENCY and real provider `usage`; treat cost/token thresholds as
// guardrails, not contracts. The throw itself is intentional — a thrown assertion
// in vitest exits non-zero (CI red), which is the desired failure signal (T-09-07).

export interface Budget {
  /** Max total USD cost. Omit to skip the cost assertion. */
  maxCostUsd?: number;
  /** Max latency in milliseconds. Omit to skip the latency assertion. */
  maxLatencyMs?: number;
  /** Max total tokens. Omit to skip the token assertion. */
  maxTokens?: number;
}

export interface BudgetActuals {
  /** Actual total USD cost (default 0 when absent). */
  costUsd?: number;
  /** Actual latency in milliseconds (default 0 when absent). */
  latencyMs?: number;
  /** Actual total tokens (default 0 when absent). */
  tokens?: number;
}

/**
 * Throws a single descriptive `Error` naming every exceeded dimension with its
 * budget and actual; returns silently when every defined budget dimension is
 * within range. An omitted budget dimension is never asserted; a missing actual
 * is treated as 0. Comparison is strict `>`, so an actual exactly at the budget
 * passes. Cost is rendered to 4 decimal places.
 */
export function assertBudget(actual: BudgetActuals, budget: Budget): void {
  const fail: string[] = [];

  if (budget.maxCostUsd !== undefined) {
    const cost = actual.costUsd ?? 0;
    if (cost > budget.maxCostUsd) {
      fail.push(`cost ${cost.toFixed(4)} USD exceeds budget ${budget.maxCostUsd.toFixed(4)} USD`);
    }
  }

  if (budget.maxLatencyMs !== undefined) {
    const latency = actual.latencyMs ?? 0;
    if (latency > budget.maxLatencyMs) {
      fail.push(`latency ${latency}ms exceeds budget ${budget.maxLatencyMs}ms`);
    }
  }

  if (budget.maxTokens !== undefined) {
    const tokens = actual.tokens ?? 0;
    if (tokens > budget.maxTokens) {
      fail.push(`tokens ${tokens} exceeds budget ${budget.maxTokens}`);
    }
  }

  if (fail.length > 0) {
    throw new Error(`Budget exceeded: ${fail.join('; ')}`);
  }
}
