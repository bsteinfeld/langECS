// Dataset loaders for the LangECS eval stack (EVAL-03).
//
// `loadDataset` reads a JSONL file via `node:fs` and `defineDataset` wraps an
// inline array. Both yield identically-shaped `EvalCase[]`. `node:fs` is used
// here intentionally: only `@langecs/core` must stay isomorphic (R1); the eval
// package may depend on Node built-ins.

import { readFileSync } from 'node:fs';

/** One eval case: R3-compliant, JSON-serializable (all fields are plain data). */
export interface EvalCase {
  /** Unique identifier for this case. */
  id: string;
  /** The input to feed the agent: a plain text prompt or serialized context. */
  input: string;
  /** The expected output for the scorer. Format depends on the chosen scorer. */
  expected: string;
  /** Which scorer resource to use, e.g. 'scorer:exact-match'. */
  scorer: string;
  /** Optional metadata for filtering/tagging (consumed in later phases). */
  tags?: string[];
  /** Optional scripted model turns for deterministic CI (Phase 8 harness). */
  script?: Array<{ role: string; content: string; [k: string]: unknown }>;
}

/** Type-safe inline dataset definition. Returns a frozen `EvalCase[]`. */
export function defineDataset(cases: EvalCase[]): readonly EvalCase[] {
  return Object.freeze([...cases]);
}

/**
 * Loads an eval dataset from a JSONL file. Each non-blank line must be a valid
 * JSON object conforming to `EvalCase`; blank/whitespace-only lines are skipped.
 * A malformed line throws an `Error` whose message includes the 1-based line
 * number and the file path rather than producing a corrupt case (T-07-02).
 */
export function loadDataset(path: string): EvalCase[] {
  const text = readFileSync(path, 'utf8');
  const cases: EvalCase[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    try {
      cases.push(JSON.parse(line) as EvalCase);
    } catch (err) {
      throw new Error(`loadDataset: invalid JSON on line ${i + 1} of ${path}: ${err}`);
    }
  }
  return cases;
}
