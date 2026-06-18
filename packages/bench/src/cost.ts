// Cost estimation for LangECS benchmarks (BENCH-02).
//
// MODEL_PRICING is a STATIC, ADVISORY table maintained by hand. There is NO
// network access and NO live pricing API by design (no-network invariant;
// v2.0 anti-feature). Provider prices change over time, so this table may lag
// reality — it is advisory only and never a hard correctness/security gate.
// To update prices, edit the const below. Prices are USD per 1,000,000 tokens.
// Verified June 2026.

export interface PriceRow {
  /** USD per 1M input (prompt) tokens. */
  inputPerM: number;
  /** USD per 1M output (completion) tokens. */
  outputPerM: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Static, advisory per-1M-token prices. Editable by hand; never fetched. */
export const MODEL_PRICING: Record<string, PriceRow> = {
  // OpenAI
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  // Anthropic
  'claude-sonnet-4.6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-haiku-4.5': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-opus-4.8': { inputPerM: 5.0, outputPerM: 25.0 },
};

/**
 * Estimate the USD cost of a single model call's token `usage` for `modelName`.
 *
 * Advisory only: an unknown (or attacker-controlled) `modelName` contributes 0
 * and NEVER throws (V5 input validation) — an arbitrary model string cannot
 * crash a suite. Pure function: no network, no filesystem, no global state.
 */
export function estimateCost(usage: Usage, modelName: string): number {
  // Own-property check guards against inherited keys ('__proto__', 'toString',
  // …): an attacker-controlled model string must resolve to a real price row
  // or contribute 0 — never to Object.prototype, which would yield NaN (T-09-02).
  const row = Object.hasOwn(MODEL_PRICING, modelName) ? MODEL_PRICING[modelName] : undefined;
  if (!row) return 0;
  return (
    (usage.inputTokens / 1_000_000) * row.inputPerM +
    (usage.outputTokens / 1_000_000) * row.outputPerM
  );
}
