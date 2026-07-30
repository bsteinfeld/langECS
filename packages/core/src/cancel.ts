// Cooperative-cancellation utilities (R49). Isomorphic (R1): `AbortController`
// and `AbortSignal` are standard in every runtime this package targets, but
// `DOMException` and `AbortSignal.any` are not assumed.

import { CancelledError } from './errors';

// Platform constructors reached through `globalThis` rather than a type library
// (R1) — see `platform.d.ts` for why core declares no values for these.
const platform = globalThis as unknown as {
  AbortController: new () => AbortController;
  AbortSignal?: { any?(signals: AbortSignal[]): AbortSignal };
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * Throws if `signal` has already been aborted (R49) — the first line of a
 * cancellation-aware `Model.generate`, tool, or long-running system.
 *
 * Re-throws the signal's own `reason` when the platform populated one (an
 * `AbortError` `DOMException`, or whatever value was passed to
 * `controller.abort(reason)`), so callers that switch on `err.name ===
 * 'AbortError'` keep working. Falls back to `CancelledError`.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw abortReason(signal);
}

/** The value an aborted `signal` should be rejected with (R49). */
export function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  return reason === undefined ? new CancelledError() : reason;
}

/**
 * Resolves after `ms`, or rejects the moment `signal` aborts (R49) — an
 * interruptible sleep. Used by `scriptedModel`'s `delayMs` (R44) so
 * cancellation is testable with zero network, and useful in user systems that
 * back off.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const handle = platform.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      platform.clearTimeout(handle);
      reject(abortReason(signal as AbortSignal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An `AbortSignal` that aborts as soon as **any** input signal does (R49) — how
 * a caller composes a long-lived cancellation signal it owns with a per-call
 * deadline, so one signal can be handed to `ModelRequest.signal`.
 *
 * Prefers the platform's `AbortSignal.any` when present and falls back to a
 * hand-rolled controller, so behavior is identical on runtimes that predate it
 * (R1). Returns the sole input unchanged when there is only one — the common
 * case for a pair with no `timeoutMs`, which composes no wrapper at all — and
 * an already-aborted signal when any input is already aborted.
 *
 * Retention, on the fallback path only: each input carries one listener until
 * the composite aborts, at which point every listener is removed. A composite
 * that *never* aborts therefore retains one listener per input for that input's
 * lifetime — so on runtimes without native `AbortSignal.any` (Node < 20.3,
 * pre-2024 browsers), keep composites short-lived relative to their inputs
 * rather than building one per call from a long-lived signal. Native
 * `AbortSignal.any` holds dependents weakly per spec and has no such retention.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const native = platform.AbortSignal?.any;
  if (typeof native === 'function') return native.call(platform.AbortSignal, present);
  const controller = new platform.AbortController();
  // Listeners are torn down as a set the moment the composite resolves, whether
  // that happens synchronously below or on a later abort. Without this a
  // long-lived input accumulates one stale listener per composite built from it
  // — each retaining that composite's controller — for the whole run.
  const cleanups: (() => void)[] = [];
  const releaseAll = (): void => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };
  for (const signal of present) {
    if (signal.aborted) {
      releaseAll();
      controller.abort(abortReason(signal));
      return controller.signal;
    }
    const onAbort = (): void => {
      releaseAll();
      controller.abort(abortReason(signal));
    };
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
