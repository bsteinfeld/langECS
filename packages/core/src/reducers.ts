import { LangECSError } from './errors';

// Standard reducers (R59). Reducers are how LangECS avoids silent
// last-write-wins (R30), so every fan-in pattern needs one — and everybody
// writes the same five.
//
// These live in core rather than stdlib because a reducer is a core concept: it
// is what `defineComponent({ reducer })` takes, and what `WriteConflictError`
// tells you to reach for.

/** A component's merge function, as accepted by `defineComponent` (R30). */
export type Reducer<T> = (current: T, incoming: T) => T;

/**
 * **Purity is required.** Reducers run inside the barrier's staging phase
 * against committed values, which are handed out by reference and must be
 * treated as immutable (R17 amended). Every reducer here returns a new value and
 * never mutates its arguments; a reducer of your own that mutates `current`
 * corrupts committed state in a way the engine cannot detect.
 *
 * **A reducer never sees the FIRST write.** The engine merges only when the
 * component is already present (R30), so the initial value — whether from
 * `spawn`, an agent bundle, or the first external `add` — is stored verbatim.
 * That matters for the constraining reducers: a component seeded at spawn with
 * 10 items and `boundedAppend(3)` stays over its cap until the next write, and
 * duplicates *within* a first `dedupeByReducer` payload survive. Seed with `[]`
 * and let the first real write merge if the invariant has to hold from step one.
 */

/**
 * Concatenates array writes — the reducer behind `Messages`, `Inbox`,
 * `SystemError` and every fan-in in the examples.
 *
 * ```ts
 * const Findings = defineComponent<Finding[]>({ name: 'Findings', reducer: appendReducer() })
 * ```
 */
export function appendReducer<T>(): Reducer<T[]> {
  return (current, incoming) => [...current, ...incoming];
}

/**
 * Appends, then caps the array at `max` (R59).
 *
 * The bounded variant everyone eventually needs and that is easy to get wrong in
 * a way that only shows up at hour three: an unbounded append on a long-running
 * world grows a component forever, and since every component lands in every
 * snapshot (R35), that cost is paid on every save.
 *
 * `keep: 'last'` (the default) discards from the front, which is what a running
 * log or a message window wants. `keep: 'first'` discards from the back, for the
 * "remember how this started" case.
 */
export function boundedAppend<T>(max: number, opts?: { keep?: 'first' | 'last' }): Reducer<T[]> {
  const keep = opts?.keep ?? 'last';
  // Validated at FACTORY time, not inside the closure: a reducer that throws
  // would reject the whole run during barrier staging (R30), long after the
  // mistake was made. `Math.max(0, Math.floor(NaN))` is NaN, so
  // `merged.length <= NaN` was false and the slice returned everything — the cap
  // silently became unbounded, which is precisely the growth R59 exists to
  // prevent. Reachable as `boundedAppend(Number(process.env.MAX_LOG))`.
  if (!Number.isInteger(max) || max <= 0) {
    throw new LangECSError(
      `boundedAppend(${String(max)}) needs a positive integer cap (R59). A non-numeric cap ` +
        `silently becomes UNBOUNDED, and a zero or negative one silently discards every write.`,
    );
  }
  const limit = max;
  return (current, incoming) => {
    const merged = [...current, ...incoming];
    if (merged.length <= limit) return merged;
    return keep === 'last' ? merged.slice(merged.length - limit) : merged.slice(0, limit);
  };
}

/**
 * Shallow-merges object writes, incoming keys winning (R59) — for a component
 * several systems each contribute different fields to.
 *
 * Shallow on purpose: a deep merge has to guess about arrays (replace or
 * concatenate?) and would silently pick one. Compose `appendReducer` on a nested
 * component instead when you need that.
 */
export function mergeReducer<T extends object>(): Reducer<T> {
  return (current, incoming) => ({ ...current, ...incoming });
}

/**
 * Keeps whichever write scores highest (R59) — "best result wins" fan-in, e.g.
 * the highest-confidence extraction among several models.
 *
 * Ties keep `current`, so the result does not depend on barrier ordering among
 * equal scores.
 */
export function maxByReducer<T>(score: (value: T) => number): Reducer<T> {
  return (current, incoming) => (score(incoming) > score(current) ? incoming : current);
}

/**
 * Appends, dropping entries whose key was already present (R59) — fan-in where
 * several workers may report the same item, like retrieved passages or lint
 * findings.
 *
 * First occurrence wins, so the earliest writer in barrier order (system
 * registration index, then entity id) is the one kept, which keeps the result
 * deterministic.
 */
export function dedupeByReducer<T>(key: (value: T) => string | number): Reducer<T[]> {
  // Rebuilding the key set per write was exactly n²/2 `key()` calls — 12.5M for
  // 5,000 sequential writes — and it runs in the barrier's STAGING phase, the
  // synchronous section gating the commit for every pair in the step. Memoized on
  // the identity of `current`, which is the previously committed array and so is
  // stable between writes; purity is untouched because nothing is mutated.
  const keysOf = new WeakMap<readonly T[], Set<string | number>>();
  const keySet = (values: T[]): Set<string | number> => {
    const hit = keysOf.get(values);
    if (hit !== undefined) return hit;
    const built = new Set(values.map(key));
    keysOf.set(values, built);
    return built;
  };
  return (current, incoming) => {
    const seen = new Set(keySet(current));
    const out = [...current];
    for (const item of incoming) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    keysOf.set(out, seen);
    return out;
  };
}

/**
 * Adds numeric writes (R59) — token counters, cost ledgers, scores. The
 * canonical use is summing `ModelResult.usage` across concurrent model calls,
 * where a plain component would throw `WriteConflictError` instead.
 */
export function sumReducer(): Reducer<number> {
  return (current, incoming) => current + incoming;
}
