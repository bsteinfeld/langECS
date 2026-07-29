// Token budgets and the graceful-quiesce watchdog (R63), generalised from the
// pattern examples/research-team had to build by hand.
//
// Any autonomous system that can spawn work per unit of input has no natural
// stopping point, and unbounded spend is the failure mode users fear most about
// agent frameworks. The shape that matters: exceeding a budget is **state that
// stops further work**, not an exception that discards it — a throw would lose
// the partial results you already paid for.

import {
  appendReducer,
  type ComponentType,
  defineComponent,
  defineSystem,
  type ModelResult,
  Not,
} from '@langecs/core';

/** One model call's cost, as appended to `TokenUsage`. */
export type Spend = {
  /** Which system spent it — the key to "what is this run actually paying for?". */
  system: string;
  tokens: number;
};

/**
 * Ledger of every model call's cost. Append reducer, so concurrent spenders in
 * one barrier merge instead of raising `WriteConflictError` (R30).
 *
 * Kept as a ledger rather than a running total because the breakdown is what
 * makes an overspend diagnosable; `spentTokens` sums it.
 */
export const TokenUsage: ComponentType<Spend[]> = defineComponent<Spend[]>({
  name: 'TokenUsage',
  reducer: appendReducer<Spend>(),
});

/** Total token allowance for the run. Plain data, so a test can shrink it to 1. */
export const TokenBudget: ComponentType<number> = defineComponent<number>({ name: 'TokenBudget' });

/** Where the budget stands, as reported by `BudgetExceeded` / `onApproachingCap`. */
export type BudgetStatus = { spent: number; budget: number };

/**
 * Stamped once the ledger passes the budget (R63). Every model-calling system
 * should carry `Not(BudgetExceeded)`, so its arrival unmatches them all and the
 * world quiesces with whatever work is already committed.
 *
 * Graceful by construction: the run ends because nothing matches any more, not
 * because something threw. Partial findings survive, and the reason is queryable
 * state rather than a log line.
 */
export const BudgetExceeded: ComponentType<BudgetStatus> = defineComponent<BudgetStatus>({
  name: 'BudgetExceeded',
});

/** Stamped when spend crosses `warnAt`, for a "continue?" interaction. */
export const BudgetWarning: ComponentType<BudgetStatus> = defineComponent<BudgetStatus>({
  name: 'BudgetWarning',
});

/** Total tokens in a ledger. */
export const spentTokens = (ledger: Spend[]): number =>
  ledger.reduce((total, spend) => total + spend.tokens, 0);

/**
 * A `Spend` for one model result, for a system to append after its call:
 *
 * ```ts
 * const result = await model.generate(req)
 * e.add(TokenUsage, [spendOf('research', result)])
 * ```
 *
 * Providers that report no usage (including `scriptedModel`) are estimated from
 * message length at ~4 characters per token, so a budget test is deterministic
 * and a real run is roughly right rather than silently free.
 */
export function spendOf(system: string, result: ModelResult, requestChars = 0): Spend {
  const reported = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  if (reported > 0) return { system, tokens: reported };
  const chars = requestChars + result.message.content.length;
  return { system, tokens: Math.max(1, Math.ceil(chars / 4)) };
}

export interface BudgetWatchdogOptions {
  /**
   * Fraction of the budget at which `BudgetWarning` is stamped (0–1). Unset means
   * no warning — the watchdog only ever stamps the hard stop.
   */
  warnAt?: number;
  /**
   * Also stamp `BudgetExceeded` on every entity matching these components, not
   * just the budget holder. This is how a shared budget brakes a whole team: the
   * ledger lives on one blackboard entity while the spenders are separate
   * entities, and their `Not(BudgetExceeded)` guards only unmatch once the stamp
   * reaches them.
   */
  stampOn?: ComponentType<any>[];
  /** Called when the cap is crossed — for logging or a `world.cancel()` escalation. */
  onExceeded?: (status: BudgetStatus) => void;
  /** Called when `warnAt` is crossed. */
  onApproachingCap?: (status: BudgetStatus) => void;
}

/**
 * Brakes the world when spend passes the budget (R63).
 *
 * Register it with `world.use(budgetWatchdog())` and put `TokenBudget` +
 * `TokenUsage` on the entity that owns the allowance. Because the ledger has an
 * append reducer, every spender's write is foreign dirt for this pair — so the
 * watchdog re-evaluates after every model call without any polling.
 *
 * The guard, not the body, is where the decision lives: a `when` veto consumes
 * the pair's dirt (R26), so an under-budget world costs one predicate per spend
 * and writes nothing.
 */
export function budgetWatchdog(opts?: BudgetWatchdogOptions) {
  const warnAt = opts?.warnAt;
  const stampOn = opts?.stampOn ?? [];
  return defineSystem({
    name: 'budgetWatchdog',
    query: [TokenUsage, TokenBudget, Not(BudgetExceeded)],
    when: (e) => {
      const spent = spentTokens(e.get(TokenUsage));
      const budget = e.get(TokenBudget);
      if (spent > budget) return true;
      // Warn once: re-stamping every step would churn dirt for no new information.
      return warnAt !== undefined && spent > budget * warnAt && !e.has(BudgetWarning);
    },
    run: (e, ctx) => {
      const spent = spentTokens(e.get(TokenUsage));
      const budget = e.get(TokenBudget);
      const status: BudgetStatus = { spent, budget };

      if (spent <= budget) {
        e.set(BudgetWarning, status);
        opts?.onApproachingCap?.(status);
        return;
      }

      e.set(BudgetExceeded, status);
      // Reach the spenders too, or their Not(BudgetExceeded) guards never unmatch
      // and a shared budget brakes only the entity holding the ledger.
      for (const marker of stampOn) {
        for (const spender of ctx.world.query(marker)) {
          if (spender.id !== e.id) ctx.write(spender, BudgetExceeded, status, 'set');
        }
      }
      opts?.onExceeded?.(status);
    },
  });
}
