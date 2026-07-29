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
  const limit = Math.max(0, Math.floor(max));
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
  return (current, incoming) => {
    const seen = new Set(current.map(key));
    const out = [...current];
    for (const item of incoming) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
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
