// Built-in deterministic scorers for the LangECS eval stack (EVAL-02, R3).
//
// A `Scorer` carries behavior (`score`), so — exactly like `ToolDef` in stdlib —
// it lives in the world resource registry, never in a component. Components
// reference a scorer by name via `ScorerRef` (a plain string), keyed `scorer:<name>`.
// Every scorer here is pure, deterministic, zero-LLM, and zero-network.

import type { World } from '@langecs/core';

/** A scorer: maps (output, expected) to a score in [0, 1].
 *  Lives in the world resource registry; never in a component (R3). */
export interface Scorer {
  score(output: string, expected: string): number | Promise<number>;
}

/** Resource key convention for built-in scorers. */
export const SCORER_RESOURCE_PREFIX = 'scorer:' as const;

/** Resource name a scorer registers under: `scorer:<name>` (idempotent on prefixed input). */
export function scorerResourceName(name: string): string {
  return name.startsWith(SCORER_RESOURCE_PREFIX) ? name : `${SCORER_RESOURCE_PREFIX}${name}`;
}

/** 1 when output and expected are equal after trimming, else 0. */
export const exactMatchScorer: Scorer = {
  score(output, expected) {
    return output.trim() === expected.trim() ? 1 : 0;
  },
};

/** 1 when output contains expected as a substring, else 0. */
export const containsScorer: Scorer = {
  score(output, expected) {
    return output.includes(expected) ? 1 : 0;
  },
};

/**
 * 1 when output matches the regex in `expected`, else 0.
 * `expected` is either a bare regex source (e.g. `\\d+`) or a JSON object
 * `{"source":"...","flags":"..."}`. A non-JSON `expected` falls back to a bare
 * source via `new RegExp(expected)`.
 */
export const regexScorer: Scorer = {
  score(output, expected) {
    let re: RegExp;
    try {
      const parsed = JSON.parse(expected) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'source' in parsed) {
        const p = parsed as { source: string; flags?: string };
        re = new RegExp(p.source, p.flags ?? '');
      } else {
        re = new RegExp(expected);
      }
    } catch {
      re = new RegExp(expected);
    }
    return re.test(output) ? 1 : 0;
  },
};

/**
 * Minimal structural JSON-schema validation (type + required keys only — no
 * external validator dep in Phase 7). `expected` is a JSON schema string;
 * `output` is the candidate JSON string. Returns 0 on any parse failure.
 */
export const jsonSchemaScorer: Scorer = {
  score(output, expected) {
    try {
      const schema = JSON.parse(expected) as {
        type?: string;
        required?: string[];
        properties?: Record<string, { type?: string }>;
      };
      const value = JSON.parse(output) as unknown;
      if (schema.type && typeof value !== schema.type) return 0;
      if (schema.required && typeof value === 'object' && value !== null) {
        for (const key of schema.required) {
          if (!(key in (value as Record<string, unknown>))) return 0;
        }
      }
      return 1;
    } catch {
      return 0;
    }
  },
};

/**
 * 1 when |actual - expected| is within tolerance, else 0. `expected` is a JSON
 * config `{"expected": N, "tolerance": T, "relative"?: bool}`; `output` is
 * parsed via `parseFloat`. Returns 0 when output is not numeric. When `relative`
 * is true the threshold is `|expected * tolerance|`, else `tolerance` (absolute).
 */
export const numericToleranceScorer: Scorer = {
  score(output, expected) {
    try {
      const config = JSON.parse(expected) as {
        expected: number;
        tolerance: number;
        relative?: boolean;
      };
      const actual = Number.parseFloat(output.trim());
      if (Number.isNaN(actual)) return 0;
      const diff = Math.abs(actual - config.expected);
      const threshold = config.relative
        ? Math.abs(config.expected * config.tolerance)
        : config.tolerance;
      return diff <= threshold ? 1 : 0;
    } catch {
      return 0;
    }
  },
};

/**
 * Factory: wraps any pure predicate into a `Scorer`. A boolean result maps to
 * 1/0; a number result passes through unchanged. The factory is exported but is
 * NOT registered by `registerBuiltinScorers` — callers register their own
 * instance under a custom name, e.g.
 *   `world.register('scorer:my-check', customPredicateScorer((o, e) => o.startsWith(e)))`.
 * The factory itself is never stored in a component (R3).
 */
export function customPredicateScorer(
  predicate: (output: string, expected: string) => boolean | number,
): Scorer {
  return {
    score(output, expected) {
      const result = predicate(output, expected);
      return typeof result === 'boolean' ? (result ? 1 : 0) : result;
    },
  };
}

/**
 * Registers the five concrete built-in scorers as world resources under their
 * `scorer:<name>` keys, mirroring `registerTools`. `customPredicateScorer` is a
 * factory, so it is intentionally NOT registered here — the caller registers the
 * factory's result under whatever custom name they choose.
 */
export function registerBuiltinScorers(world: World): void {
  world.register(scorerResourceName('exact-match'), exactMatchScorer);
  world.register(scorerResourceName('contains'), containsScorer);
  world.register(scorerResourceName('regex'), regexScorer);
  world.register(scorerResourceName('json-schema'), jsonSchemaScorer);
  world.register(scorerResourceName('numeric-tolerance'), numericToleranceScorer);
  // customPredicateScorer is a factory — the caller registers their own instance.
}
