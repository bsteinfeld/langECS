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
 * An `AbortSignal` that aborts as soon as **any** input signal does (R51) —
 * how a pair's per-step signal follows both the run-wide cancellation signal
 * and its own `timeoutMs` deadline.
 *
 * Prefers the platform's `AbortSignal.any` when present and falls back to a
 * hand-rolled controller, so behavior is identical on runtimes that predate it
 * (R1). Returns the sole input unchanged when there is only one, and an
 * already-aborted signal when any input is already aborted.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const native = platform.AbortSignal?.any;
  if (typeof native === 'function') return native.call(platform.AbortSignal, present);
  const controller = new platform.AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(abortReason(signal)), { once: true });
  }
  return controller.signal;
}
