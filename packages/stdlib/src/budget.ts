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
  type GuardCtx,
  LangECSError,
  type ModelRequest,
  type ModelResult,
} from '@langecs/core';
import { estimateTokens } from './context';

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
  // Two budget holders sharing one spender is two distinct pairs writing this
  // component in one step — a `WriteConflictError` that rejected the run and
  // stamped nothing at all, the exact inverse of "state that stops further work,
  // not an exception that discards it". Keeping the larger overspend makes the
  // merge order-independent, so the outcome cannot depend on registration order.
  reducer: (current, incoming) => (incoming.spent > current.spent ? incoming : current),
});

/** Stamped when spend crosses `warnAt`, for a "continue?" interaction. */
export const BudgetWarning: ComponentType<BudgetStatus> = defineComponent<BudgetStatus>({
  name: 'BudgetWarning',
  reducer: (current, incoming) => (incoming.spent > current.spent ? incoming : current),
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
 * Providers that report no usage (including `scriptedModel`) are estimated with
 * `estimateTokens` over the request *and* the reply, so a budget test is
 * deterministic and a real run is roughly right rather than silently free. Pass
 * the request — omitting it bills the prompt as zero, and the prompt is usually
 * the larger half.
 */
export function spendOf(system: string, result: ModelResult, req?: ModelRequest): Spend {
  const reported = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  if (reported > 0) return { system, tokens: reported };
  // Takes the REQUEST, not a character count. The old `requestChars = 0` default
  // meant the prompt — usually the dominant cost, and a `Messages` history
  // re-sent in full every turn — was billed as free unless every call site
  // remembered to pass it. A ReAct agent at turn 20 undercounted by 10-100x, so a
  // "50k budget" permitted far more, and forgetting it in one system of five made
  // that system free. Reuses stdlib's own `estimateTokens`, which already walks
  // tool calls and adds per-message overhead.
  const prompt =
    req === undefined
      ? 0
      : estimateTokens(req.messages) + (req.system === undefined ? 0 : estimateTokens(req.system));
  return { system, tokens: Math.max(1, prompt + estimateTokens([result.message])) };
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
  /**
   * System name, so a world can hold more than one budget (a global cap plus a
   * per-team cap, say). The name was hardcoded, and `world.use` dedupes by object
   * identity — so a second `budgetWatchdog()` threw `DuplicateSystemError`, and
   * even calling the factory twice with identical options failed.
   */
  name?: string;
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
  // Validated at registration, which is the right moment to fail. `warnAt: 1`
  // reads as "warn at 100%" and produced ZERO warnings forever, because the
  // over-budget branch short-circuits first; so did `warnAt: 80`, which is what a
  // user thinking in percent actually writes. A notification wired to either was
  // silently never sent.
  if (warnAt !== undefined && !(warnAt > 0 && warnAt < 1)) {
    throw new LangECSError(
      `budgetWatchdog({ warnAt: ${String(warnAt)} }) needs a fraction strictly between 0 and 1 ` +
        `(R63). At 1 or above the warning can never fire, because exceeding the budget is ` +
        `handled first — did you mean ${warnAt >= 1 ? warnAt / 100 : 0.8}?`,
    );
  }

  /** Every entity the brake has to reach: the holder plus each `stampOn` match. */
  const unstampedSpenders = (ctx: GuardCtx, holder: number): boolean => {
    for (const marker of stampOn) {
      for (const spender of ctx.world.query(marker)) {
        if (spender.id !== holder && !spender.has(BudgetExceeded)) return true;
      }
    }
    return false;
  };

  return defineSystem({
    name: opts?.name ?? 'budgetWatchdog',
    // NOT `Not(BudgetExceeded)`. With that term the watchdog unmatched itself
    // permanently the moment it stamped the holder, freezing the braked set at
    // whoever existed then — so a spender spawned afterwards (a second planning
    // round, a retry-spawned worker) called the model, billed the ledger and ran
    // unbounded, with the watchdog gone and the run still reporting 'done'. The
    // whole decision belongs in the guard, which is where this module already
    // said it lived.
    query: [TokenUsage, TokenBudget],
    when: (e, ctx) => {
      const spent = spentTokens(e.get(TokenUsage));
      const budget = e.get(TokenBudget);
      if (spent > budget) {
        // Fire while anything still needs the brake — the holder or a late spender.
        return !e.has(BudgetExceeded) || unstampedSpenders(ctx, e.id);
      }
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

      const first = !e.has(BudgetExceeded);
      // Conditional, so re-firing for a late spender does not churn the holder.
      if (first) e.set(BudgetExceeded, status);
      // A single large call can cross the warning line and the cap in one step, so
      // fire the warning too rather than never at all — a coarse-grained agent
      // (one big call per step) otherwise never sees `onApproachingCap`.
      if (warnAt !== undefined && !e.has(BudgetWarning)) {
        e.add(BudgetWarning, status);
        opts?.onApproachingCap?.(status);
      }
      // Reach the spenders too, or their Not(BudgetExceeded) guards never unmatch
      // and a shared budget brakes only the entity holding the ledger. `add`, not
      // `set`, so two holders sharing a spender merge through the reducer instead
      // of raising WriteConflictError and rejecting the run.
      for (const marker of stampOn) {
        for (const spender of ctx.world.query(marker)) {
          if (spender.id !== e.id && !spender.has(BudgetExceeded)) {
            ctx.write(spender, BudgetExceeded, status, 'add');
          }
        }
      }
      if (first) opts?.onExceeded?.(status);
    },
  });
}
