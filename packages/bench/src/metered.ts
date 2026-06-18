// meteredModel — per-call token/cost metering wrapper (BENCH-01).
//
// Promoted and generalized from `examples/research-team/team.ts:43-55`. Wraps the
// model registered under `model:main` (or an injected `inner`) so each `generate`
// records a split input/output token Spend onto a target entity via the buffered
// `ctx.write` API (R17), and — when a `modelName` is given — an estimated USD cost.
//
// MANDATORY estimateTokens fallback: `scriptedModel` (the deterministic CI default,
// R44) reports NO `usage`, so every CI token assertion rides the `?? estimateTokens`
// branch (09-RESEARCH Pitfall 2). Provider-reported `usage` always wins when present.
//
// All writes are plain JSON data (R3); behavior lives here in the wrapper, never in
// a component value. The wrapper holds a `ctx` and is therefore meant to be called
// INSIDE a system `run` (the only place `ctx.write` can buffer to the barrier so the
// writes land in the sub-world per-case snapshot). Token estimates are ADVISORY only
// (~4 chars/token) — never a hard correctness gate (T-09-04).

import type { EntityTarget, Model, SystemCtx } from '@langecs/core';
import { estimateTokens } from '@langecs/stdlib';
import { CostEstimate, TokenUsage } from './components';
import { estimateCost } from './cost';

export interface MeteredModelOptions {
  /** The inner model to wrap. Default: `ctx.resource<Model>('model:main')`. */
  inner?: Model;
  /** A `MODEL_PRICING` key. When set, a `CostEstimate` is written; when omitted, none is. */
  modelName?: string;
}

/**
 * Wraps a `Model` so each `generate` writes a `TokenUsage` Spend (and optionally a
 * `CostEstimate`) onto `target` inside the current step's barrier (R17). Prefers
 * provider-reported `usage`; falls back to the advisory `estimateTokens` heuristic
 * when absent (the scriptedModel case). Returns the inner result unchanged.
 */
export function meteredModel(
  ctx: SystemCtx,
  target: EntityTarget,
  systemName: string,
  opts: MeteredModelOptions = {},
): Model {
  const inner = opts.inner ?? ctx.resource<Model>('model:main');
  return {
    async generate(req) {
      const result = await inner.generate(req);
      // Prefer provider-reported usage; fall back to the advisory estimate
      // (scriptedModel reports none — this branch is mandatory, 09-RESEARCH Pitfall 2).
      const inputTokens = result.usage?.inputTokens ?? estimateTokens(req.messages);
      const outputTokens = result.usage?.outputTokens ?? estimateTokens([result.message]);
      ctx.write(target, TokenUsage, [{ system: systemName, inputTokens, outputTokens }], 'add');
      if (opts.modelName !== undefined) {
        ctx.write(
          target,
          CostEstimate,
          estimateCost({ inputTokens, outputTokens }, opts.modelName),
          'add',
        );
      }
      return result;
    },
  };
}
