// Internal helpers shared across the instrumentations. Isomorphic by the same
// rule as `@langecs/core` (R1): no `node:*` imports, no bare Node globals —
// `process` and `performance` are reached through guarded `globalThis` access.

import type { Exception, Tracer, TracerProvider } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';

/** Instrumentation scope name reported to the host's providers. */
export const SCOPE_NAME = '@langecs/otel';
/** Instrumentation scope version (kept in sync with package.json manually). */
export const SCOPE_VERSION = '0.1.0';

/** Tracer from the given provider, falling back to the API-global provider. */
export const tracerFrom = (provider?: TracerProvider): Tracer =>
  (provider ?? trace.getTracerProvider()).getTracer(SCOPE_NAME, SCOPE_VERSION);

const perf = (globalThis as { performance?: { now(): number } }).performance;
/** Monotonic-ish clock for duration metrics; `Date.now` only in exotic runtimes. */
export const now: () => number = perf ? () => perf.now() : () => Date.now();

/** `true` iff the environment variable is exactly `'true'`. Safe without `process`. */
export const envFlag = (name: string): boolean => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] === 'true';
};

/** JSON-stringifies for span attributes; never throws, hard-capped at `max` chars. */
export const safeStringify = (value: unknown, max: number): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? text.slice(0, max) : text;
};

/** Low-cardinality error class for the `error.type` attribute. */
export const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'Error');

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Adapts an arbitrary thrown value to the API's `Exception` shape. */
export const toException = (err: unknown): Exception =>
  err instanceof Error ? err : { name: 'Error', message: String(err) };

// Idempotency marker: instrumentModel/instrumentTool tag their wrappers so a
// second wrap (e.g. explicit instrumentModel + instrumentWorld's wrapResources
// auto-wrap at registration) is a no-op instead of nesting duplicate spans.
// Symbol.for: survives duplicated copies of this package in one process.
const INSTRUMENTED = Symbol.for('langecs.otel.instrumented');

export const isInstrumented = (value: object): boolean =>
  (value as Record<symbol, unknown>)[INSTRUMENTED] === true;

/** Marks a wrapper non-enumerably (spreads of the wrapper don't inherit it). */
export const markInstrumented = <T extends object>(value: T): T => {
  Object.defineProperty(value, INSTRUMENTED, { value: true, enumerable: false });
  return value;
};
