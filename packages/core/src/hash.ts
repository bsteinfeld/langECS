// Stable hashing of a `ModelRequest`, for caching (R61) and record/replay (R62).
//
// Hand-rolled rather than `node:crypto`: core is isomorphic and dependency-free
// (R1), and `crypto.subtle.digest` is async, which would force every cache lookup
// to be awaited. This is not a cryptographic hash and does not need to be — it
// identifies a request, it does not authenticate one.

import type { ModelRequest } from './model';

/**
 * Canonical JSON with object keys sorted at every level, so two structurally
 * equal requests hash the same regardless of property insertion order. Without
 * this, `{ system, messages }` and `{ messages, system }` would be different
 * cache keys for the same call.
 */
const MAX_DEPTH = 200;

function canonical(value: unknown, depth = 0, seen?: Set<object>): string {
  // Non-finite numbers must not collapse into `null` the way JSON.stringify does:
  // `maxTokens: budget / 0` (Infinity) or a parseInt mishap (NaN) would otherwise
  // share a cache entry with an unset field. `-0` IS collapsed to `0`, which is
  // correct — no provider distinguishes them.
  if (typeof value === 'number' && !Number.isFinite(value)) return `#${String(value)}`;
  if (value === undefined) return '#undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  // Nothing constrains a `ModelRequest` to be acyclic or shallow: R3 governs
  // COMPONENTS, while `tools[].parameters` is a user-supplied JSON Schema and
  // `Msg.meta`/`toolCalls[].args` are `unknown`. Unbounded recursion here threw a
  // RangeError from inside shared code, which made every `withCache` lookup fail
  // and — worse — turned a model call that had already SUCCEEDED into a failure
  // when `recordingModel` hashed it.
  if (depth > MAX_DEPTH) return '#depth';
  const marks = seen ?? new Set<object>();
  if (marks.has(value as object)) return '#cycle';
  marks.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonical(item, depth + 1, marks)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1, marks)}`)
      .join(',')}}`;
  } finally {
    // Removed on the way out so sibling references to one shared object are not
    // reported as cycles.
    marks.delete(value as object);
  }
}

/** FNV-1a (32-bit), rendered as 8 hex chars. Fast, dependency-free, good enough to key a map. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, via shifts to stay in 32-bit integer math.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The part of a request that identifies it. `signal` is excluded — it is
 * per-call plumbing (R49), not part of what was asked, and including it would
 * make every request unique and every cache useless.
 */
export function requestKey(req: ModelRequest): string {
  const { signal: _signal, ...rest } = req;
  return canonical(rest);
}

/** Stable 8-hex-char digest of a request (R61/R62). Two equal requests hash equal. */
export function hashRequest(req: ModelRequest): string {
  return fnv1a(requestKey(req));
}
