// Model middleware (R61): retry, timeout, fallback, rate limiting, cost
// accounting and caching, composed at the resource-registration site.
//
// `Model` is a deliberately small interface — `generate` plus optional `stream`
// (R43) — and that minimalism is right. But it means every user reimplements the
// same six wrappers around it. None of them are domain logic, and none of them
// belong inside the engine: middleware composes entirely outside engine
// semantics, so it costs nothing to anyone who does not use it.
//
//   world.register(Architect,
//     wrapModel(fromAiSdk(bedrock(BIG)),
//       withCost(ledger),                            // outermost: sees whichever
//       withRetry({ max: 3 }),                       // model actually answered
//       withFallback(fromAiSdk(bedrock(SMALL)))))
//
// Note the order: `withCost` goes FIRST, not last. A fallback model is called
// directly rather than through the layers below, so a ledger listed after
// `withFallback` only ever sees the primary — and reports nothing at all in the
// case you most want to measure. Verified against a real failing provider.

import { abortReason, delay, throwIfAborted } from './cancel';
import { hashRequest } from './hash';
import type { Model, ModelRequest, ModelResult } from './model';

/** One layer of model middleware (R61): takes a `Model`, returns a `Model`. */
export type ModelMiddleware = (model: Model) => Model;

/**
 * Composes middleware around a model (R61). **First listed is outermost**, the
 * same convention as observer `wrapSystemRun` (R46), so the list reads
 * outside-in:
 *
 * ```ts
 * wrapModel(base, withRetry({ max: 3 }), withCost(ledger))
 * // retry sees every attempt; cost sees only the one that succeeded
 * ```
 *
 * Swap the order and cost would count each retried attempt — which is sometimes
 * what you want, and is why the order is yours to choose rather than fixed.
 *
 * One ordering trap is worth knowing before you hit it: a layer listed **after**
 * `withFallback` wraps only the primary model, because a fallback is invoked
 * directly rather than through the layers below. Put observability (`withCost`)
 * outermost. See `withFallback`.
 */
export function wrapModel(model: Model, ...middleware: ModelMiddleware[]): Model {
  let wrapped = model;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const layer = middleware[i];
    if (layer) wrapped = layer(wrapped);
  }
  return wrapped;
}

/**
 * Keeps a wrapper's `stream` support in step with the model underneath it.
 *
 * A middleware that only wraps `generate` must not silently remove `stream`, or
 * layering one would turn a streaming agent into a non-streaming one — and
 * stdlib's `callLLM` branches on exactly that, so tokens would stop appearing
 * with no error anywhere.
 */
function withStreamPassthrough(
  inner: Model,
  overrides: { generate: Model['generate']; stream?: Model['stream'] },
): Model {
  const out: Model = { generate: overrides.generate };
  const stream = overrides.stream ?? inner.stream?.bind(inner);
  if (stream !== undefined) out.stream = stream;
  return out;
}

/** True for the errors cancellation produces, which must never be retried (R49). */
function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'CancelledError';
}

export interface RetryOptions {
  /** Maximum retries after the first attempt (so `max: 2` means up to 3 calls). */
  max: number;
  /** Base backoff, doubled per attempt. Default 250ms. */
  baseMs?: number;
  /** Decide per error whether to retry. Default: retry anything not a cancellation. */
  retryOn?: (err: unknown, attempt: number) => boolean;
}

/**
 * Retries failed calls with exponential backoff (R61).
 *
 * Never retries a cancellation (R49): an aborted call means the caller asked to
 * stop, and retrying it would defeat `world.cancel()` and every `timeoutMs`
 * budget above it. The backoff wait is itself interruptible, so a cancel during
 * the pause takes effect immediately rather than after the sleep.
 *
 * For `stream`, retrying stops being safe the moment a chunk has been delivered —
 * downstream has already seen those tokens, and a second attempt would duplicate
 * them. So a stream is retried only while nothing has been emitted yet, which is
 * the case that matters (connection failures happen before the first token).
 */
export function withRetry(opts: RetryOptions): ModelMiddleware {
  const max = Math.max(0, Math.floor(opts.max));
  const baseMs = opts.baseMs ?? 250;
  const shouldRetry = opts.retryOn ?? (() => true);

  return (inner) => {
    const attempt = async <R>(
      req: ModelRequest,
      call: (isFirstAttempt: boolean) => Promise<R>,
      canRetry: () => boolean,
    ): Promise<R> => {
      let lastError: unknown;
      for (let tries = 0; tries <= max; tries++) {
        throwIfAborted(req.signal);
        try {
          return await call(tries === 0);
        } catch (err) {
          lastError = err;
          if (isCancellation(err, req.signal)) throw err;
          if (tries === max || !canRetry() || !shouldRetry(err, tries + 1)) throw err;
          // Interruptible: a cancel during backoff must not wait it out.
          await delay(baseMs * 2 ** tries, req.signal);
        }
      }
      throw lastError;
    };

    return withStreamPassthrough(inner, {
      generate: (req) =>
        attempt(
          req,
          () => inner.generate(req),
          () => true,
        ),
      ...(inner.stream === undefined
        ? {}
        : {
            stream: (req: ModelRequest, onChunk: (d: { text?: string }) => void) => {
              let emitted = false;
              const guarded = (chunk: { text?: string }): void => {
                emitted = true;
                onChunk(chunk);
              };
              return attempt(
                req,
                () => (inner.stream as NonNullable<Model['stream']>)(req, guarded),
                // Retry only while the consumer has seen nothing.
                () => !emitted,
              );
            },
          }),
    });
  };
}

/**
 * Fails a call that takes longer than `ms` (R61).
 *
 * Composes with `ctx.signal`: the inner call receives a signal that aborts on
 * either this deadline or the caller's cancellation, so the provider request is
 * genuinely abandoned rather than merely un-awaited. Distinct from a system
 * `timeoutMs` (R52), which bounds a whole pair — this bounds one model call, so
 * `withRetry(withTimeout(...))` can give each attempt its own budget.
 */
export function withTimeout(ms: number): ModelMiddleware {
  return (inner) => {
    const run = async <R>(req: ModelRequest, call: (r: ModelRequest) => Promise<R>): Promise<R> => {
      throwIfAborted(req.signal);
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort(abortReason(req.signal as AbortSignal));
      req.signal?.addEventListener('abort', onOuterAbort, { once: true });
      const timer = timers.setTimeout(
        () => controller.abort(new Error(`Model call exceeded its ${ms}ms timeout.`)),
        ms,
      );
      try {
        return await call({ ...req, signal: controller.signal });
      } finally {
        timers.clearTimeout(timer);
        req.signal?.removeEventListener('abort', onOuterAbort);
      }
    };

    return withStreamPassthrough(inner, {
      generate: (req) => run(req, (r) => inner.generate(r)),
      ...(inner.stream === undefined
        ? {}
        : {
            stream: (req: ModelRequest, onChunk: (d: { text?: string }) => void) =>
              run(req, (r) => (inner.stream as NonNullable<Model['stream']>)(r, onChunk)),
          }),
    });
  };
}

/**
 * Falls back to another model when the primary fails (R61) — the cheap-model
 * escape when the big one is overloaded, or a cross-provider hedge.
 *
 * **Ordering matters more here than anywhere else, and the intuitive order is
 * wrong.** A fallback model is called directly, not through the layers below
 * this one, so anything listed *after* `withFallback` wraps **only the primary**:
 *
 * ```ts
 * // WRONG: the ledger sees nothing when the primary fails, which is exactly
 * // when you most want to know what the fallback cost.
 * wrapModel(big, withRetry({ max: 3 }), withFallback(small), withCost(ledger))
 *
 * // RIGHT: observability outermost, so it sees whichever model answered.
 * wrapModel(big, withCost(ledger), withRetry({ max: 3 }), withFallback(small))
 * ```
 *
 * To instrument the fallback specifically, wrap it before passing it in:
 * `withFallback(wrapModel(small, withCost(ledger)))`.
 *
 * A cancellation is never failed over, for the same reason it is never retried.
 * Fallback applies to `stream` only before the first chunk: once tokens have been
 * delivered, switching models mid-answer would splice two different replies
 * together.
 */
export function withFallback(...fallbacks: Model[]): ModelMiddleware {
  return (inner) => {
    const chain = [inner, ...fallbacks];
    return withStreamPassthrough(inner, {
      generate: async (req) => {
        let lastError: unknown;
        for (const model of chain) {
          throwIfAborted(req.signal);
          try {
            return await model.generate(req);
          } catch (err) {
            if (isCancellation(err, req.signal)) throw err;
            lastError = err;
          }
        }
        throw lastError;
      },
      stream: async (req, onChunk) => {
        let lastError: unknown;
        for (const model of chain) {
          throwIfAborted(req.signal);
          let emitted = false;
          try {
            const streamFn = model.stream;
            if (streamFn === undefined) return await model.generate(req);
            return await streamFn.call(model, req, (chunk) => {
              emitted = true;
              onChunk(chunk);
            });
          } catch (err) {
            if (isCancellation(err, req.signal)) throw err;
            // Half-streamed: failing over would splice two answers together.
            if (emitted) throw err;
            lastError = err;
          }
        }
        throw lastError;
      },
    });
  };
}

export interface RateLimitOptions {
  /** Minimum spacing between call starts. Derive from a per-minute quota. */
  minIntervalMs?: number;
  /** Maximum calls in flight at once. */
  concurrency?: number;
}

/**
 * Spaces out and/or caps concurrent calls (R61).
 *
 * Queues rather than rejects: a provider quota is a pacing problem, not an error,
 * and turning it into one would surface as `SystemError` on entities that did
 * nothing wrong. Waiting is interruptible, so a queued call still honours a
 * cancel while it sits in line.
 */
export function withRateLimit(opts: RateLimitOptions): ModelMiddleware {
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? Number.MAX_SAFE_INTEGER));
  let lastStart = 0;
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    // Hands the freed slot to the next waiter. Every acquired slot MUST come
    // back through here, or the queue behind it never moves.
    waiting.shift()?.();
  };

  /**
   * Waits for a turn, honouring `signal` while queued.
   *
   * A queued caller that aborts removes **itself** from the queue and rejects, so
   * it never consumes a slot it is not going to use. Once it has been granted a
   * turn, though, it stops being cancellable here: the slot has to be released
   * through the normal path so the baton reaches the next waiter.
   */
  const waitTurn = (signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      function onAbort(): void {
        const at = waiting.indexOf(grant);
        if (at === -1) return; // already granted: release() will pass the baton
        waiting.splice(at, 1);
        reject(abortReason(signal as AbortSignal));
      }
      waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return (inner) => {
    const gate = async <R>(req: ModelRequest, call: () => Promise<R>): Promise<R> => {
      throwIfAborted(req.signal);
      if (active >= concurrency) await waitTurn(req.signal);
      active += 1;
      try {
        // Checked INSIDE the try, so an abort here still runs `release()`. With
        // the check outside it, a waiter that aborted between being handed a slot
        // and taking it would swallow the baton, and every remaining queued call
        // would hang forever with nothing left to wake it.
        throwIfAborted(req.signal);
        const since = now() - lastStart;
        if (minIntervalMs > 0 && since < minIntervalMs) {
          await delay(minIntervalMs - since, req.signal);
        }
        lastStart = now();
        return await call();
      } finally {
        release();
      }
    };

    return withStreamPassthrough(inner, {
      generate: (req) => gate(req, () => inner.generate(req)),
      ...(inner.stream === undefined
        ? {}
        : {
            stream: (req: ModelRequest, onChunk: (d: { text?: string }) => void) =>
              gate(req, () => (inner.stream as NonNullable<Model['stream']>)(req, onChunk)),
          }),
    });
  };
}

/** What `withCost` reports per successful call (R61). */
export interface UsageReport {
  usage: NonNullable<ModelResult['usage']>;
  /** Milliseconds the call took, including any retries inside this layer. */
  ms: number;
  finishReason?: string;
}

/**
 * Reports `usage` for every successful call (R61) — the hook token budgets and
 * cost ledgers hang off, wired to the numbers the model layer already returns.
 *
 * The sink is called outside engine semantics, so it is a plain side effect: to
 * put spend into *state* (where a watchdog can see it and R30 can merge it),
 * write it from a system with a summing reducer rather than from here.
 *
 * Place this **outermost** in a chain that contains `withFallback`, or it will
 * only ever see the primary model — and report nothing at all in the case you
 * most care about.
 */
export function withCost(sink: (report: UsageReport) => void): ModelMiddleware {
  return (inner) => {
    const report = (result: ModelResult, startedAt: number): void => {
      const usage = result.usage;
      if (usage === undefined) return;
      const entry: UsageReport = { usage, ms: now() - startedAt };
      if (result.finishReason !== undefined) entry.finishReason = result.finishReason;
      sink(entry);
    };
    return withStreamPassthrough(inner, {
      generate: async (req) => {
        const startedAt = now();
        const result = await inner.generate(req);
        report(result, startedAt);
        return result;
      },
      ...(inner.stream === undefined
        ? {}
        : {
            stream: async (req: ModelRequest, onChunk: (d: { text?: string }) => void) => {
              const startedAt = now();
              const result = await (inner.stream as NonNullable<Model['stream']>)(req, onChunk);
              report(result, startedAt);
              return result;
            },
          }),
    });
  };
}

export interface CacheOptions {
  /** Where to keep entries. Defaults to a per-wrapper `Map`. */
  store?: Map<string, ModelResult>;
  /** Entry lifetime; unset means forever (for the process). */
  ttlMs?: number;
  /** Override the cache key. Default: a stable hash of the request minus `signal`. */
  key?: (req: ModelRequest) => string;
}

/**
 * Serves repeated identical requests from memory (R61).
 *
 * Keyed on a stable hash of the request with `signal` excluded — including it
 * would make every call unique and the cache useless. A cached `stream` replays
 * the whole text as a single chunk: honest about the fact that nothing is
 * actually streaming, and it keeps token-forwarding consumers working.
 *
 * Only successes are cached. Caching a failure would turn one provider blip into
 * a permanently poisoned answer.
 */
export function withCache(opts?: CacheOptions): ModelMiddleware {
  const store = opts?.store ?? new Map<string, ModelResult>();
  const stamps = new Map<string, number>();
  const keyOf = opts?.key ?? hashRequest;
  const ttlMs = opts?.ttlMs;

  const read = (key: string): ModelResult | undefined => {
    const hit = store.get(key);
    if (hit === undefined) return undefined;
    if (ttlMs !== undefined && now() - (stamps.get(key) ?? 0) > ttlMs) {
      store.delete(key);
      stamps.delete(key);
      return undefined;
    }
    return hit;
  };
  const write = (key: string, result: ModelResult): void => {
    store.set(key, result);
    stamps.set(key, now());
  };

  return (inner) =>
    withStreamPassthrough(inner, {
      generate: async (req) => {
        throwIfAborted(req.signal);
        const key = keyOf(req);
        const hit = read(key);
        if (hit !== undefined) return hit;
        const result = await inner.generate(req);
        write(key, result);
        return result;
      },
      ...(inner.stream === undefined
        ? {}
        : {
            stream: async (req: ModelRequest, onChunk: (d: { text?: string }) => void) => {
              throwIfAborted(req.signal);
              const key = keyOf(req);
              const hit = read(key);
              if (hit !== undefined) {
                if (hit.message.content.length > 0) onChunk({ text: hit.message.content });
                return hit;
              }
              const result = await (inner.stream as NonNullable<Model['stream']>)(req, onChunk);
              write(key, result);
              return result;
            },
          }),
    });
}

// Timers and clock via `globalThis` rather than a type library (R1), as elsewhere.
const timers = globalThis as unknown as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const perf = (globalThis as { performance?: { now(): number } }).performance;
const now: () => number = perf ? () => perf.now() : () => Date.now();
