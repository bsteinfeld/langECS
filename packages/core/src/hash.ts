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
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
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
