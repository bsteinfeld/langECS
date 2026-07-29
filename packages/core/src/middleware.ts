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
import { requestKey } from './hash';
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

/**
 * True for the errors an operator cancellation produces, which must never be
 * retried or failed over (R49).
 *
 * A `withTimeout` DEADLINE is deliberately excluded. Because `withTimeout` hands
 * the layers below a derived signal, a `signal.aborted` test alone made a
 * deadline indistinguishable from a cancel — so `wrapModel(big, withTimeout(60),
 * withFallback(small))`, which reads as "give the primary 60ms then try the small
 * one", short-circuited on the first iteration and never called the fallback. A
 * deadline SHOULD fail over; only an operator stop should not.
 */
function isCancellation(err: unknown, signal?: AbortSignal): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === TIMEOUT_ERROR_NAME) return false;
  if (signal?.aborted === true) {
    // The signal may have been aborted BY a deadline below us.
    const reason = (signal as { reason?: { name?: unknown } }).reason;
    return reason?.name !== TIMEOUT_ERROR_NAME;
  }
  return name === 'AbortError' || name === 'CancelledError';
}

/** Marks a `withTimeout` expiry so `isCancellation` can tell it from an operator stop. */
const TIMEOUT_ERROR_NAME = 'ModelTimeoutError';

/** The error a `withTimeout` deadline aborts with (R61). */
function timeoutError(ms: number): Error {
  const err = new Error(`Model call exceeded its ${ms}ms timeout.`);
  err.name = TIMEOUT_ERROR_NAME;
  return err;
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
 * `timeoutMs` (R52), which bounds a whole pair — this bounds one model call.
 *
 * **It bounds the whole chain below it, not each attempt.** The signal it derives
 * is shared by every layer underneath, so once the deadline fires there is no
 * budget left for a retry or a fallback to spend:
 *
 * ```ts
 * // Bounds the WHOLE thing at 20ms. The fallback never gets to run, because
 * // the deadline has already spent the budget the chain shares.
 * wrapModel(big, withTimeout(20), withFallback(small))
 *
 * // Gives each attempt its own budget — wrap the models, not the chain.
 * wrapModel(wrapModel(big, withTimeout(20)), withFallback(small))
 * ```
 *
 * Note this is the OPPOSITE arrangement from `withCost`, which wants to be
 * outermost. Observability goes outside; deadlines go inside.
 *
 * A deadline is also reported distinguishably (`name: 'ModelTimeoutError'`) so it
 * is never mistaken for an operator cancellation in a log or a `retryOn`
 * predicate.
 */
export function withTimeout(ms: number): ModelMiddleware {
  return (inner) => {
    const run = async <R>(req: ModelRequest, call: (r: ModelRequest) => Promise<R>): Promise<R> => {
      throwIfAborted(req.signal);
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort(abortReason(req.signal as AbortSignal));
      req.signal?.addEventListener('abort', onOuterAbort, { once: true });
      const timer = timers.setTimeout(() => controller.abort(timeoutError(ms)), ms);
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
      // Defined ONLY when the primary streams. Passing it unconditionally
      // fabricated a `stream` on a non-streaming model, and the fabricated one
      // emitted zero chunks — stdlib's `callLLM` branches on `stream`'s presence,
      // so it took the streaming path and produced no token events at all, with
      // no error anywhere. That is exactly what R61 rule 2 forbids.
      ...(inner.stream === undefined
        ? {}
        : {
            stream: async (req: ModelRequest, onChunk: (d: { text?: string }) => void) => {
              let lastError: unknown;
              for (const model of chain) {
                throwIfAborted(req.signal);
                let emitted = false;
                try {
                  const streamFn = model.stream;
                  if (streamFn === undefined) {
                    // A non-streaming FALLBACK still has to deliver its text, so
                    // forward it as one chunk the way `withCache` does.
                    const result = await model.generate(req);
                    if (result.message.content.length > 0) {
                      onChunk({ text: result.message.content });
                    }
                    return result;
                  }
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
          }),
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
  // NEGATIVE_INFINITY, not 0: `now()` is `performance.now()` (ms since process
  // start), so a zero baseline made the FIRST call sleep `minIntervalMs - uptime`
  // — a 3s quota-derived interval stalled the first model call for ~2.6s.
  let lastStart = Number.NEGATIVE_INFINITY;
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
        if (minIntervalMs > 0) {
          // The slot is RESERVED synchronously, before yielding. Reading
          // `lastStart` and writing it after the sleep gave every concurrent
          // caller the same deadline, so they all fired together — with the
          // default unlimited concurrency, a fan-out step got no pacing at all,
          // which is the documented use ("derive from a per-minute quota").
          const startAt = Math.max(now(), lastStart + minIntervalMs);
          lastStart = startAt;
          const wait = startAt - now();
          if (wait > 0) await delay(wait, req.signal);
        } else {
          lastStart = now();
        }
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
      try {
        sink(entry);
      } catch (err) {
        // Isolated the way R45 isolates observer callbacks: this is bookkeeping
        // ABOUT a call, so a ledger that throws on overflow must not turn a
        // successful model call into a `SystemError` on an entity that did
        // nothing wrong.
        (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console?.error?.(
          '[langecs] withCost sink threw (ignored):',
          err,
        );
      }
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
  /**
   * Override the cache key. Default: the **exact** canonical form of the request
   * minus `signal` — not a digest. A 32-bit digest collision would silently serve
   * a different prompt's answer, which is close to unfalsifiable in production;
   * string keys are exact and hash internally anyway.
   */
  key?: (req: ModelRequest) => string;
  /** Cap on entries; the oldest is evicted past it. Unset means unbounded. */
  maxEntries?: number;
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
  const keyOf = opts?.key ?? requestKey;
  const ttlMs = opts?.ttlMs;
  const maxEntries = opts?.maxEntries;

  const read = (key: string): ModelResult | undefined => {
    const hit = store.get(key);
    if (hit === undefined) {
      // A caller-supplied bounded/LRU store evicts on its own, so prune the
      // parallel stamps map on any miss or it grows without bound beside it.
      stamps.delete(key);
      return undefined;
    }
    if (ttlMs !== undefined && now() - (stamps.get(key) ?? 0) > ttlMs) {
      store.delete(key);
      stamps.delete(key);
      return undefined;
    }
    // Detached per hit. Handing every consumer the SAME object let one mutation
    // poison the cache for everyone — and stdlib does `e.add(Messages, [result
    // .message])`, so the cached `Msg` becomes committed component state, aliased
    // by every entity that ever got this answer. `replayModel` detaches for
    // exactly this reason; the cache needs it more.
    return JSON.parse(JSON.stringify(hit)) as ModelResult;
  };
  const write = (key: string, result: ModelResult): void => {
    // Stored detached as well as read detached: the miss path returns the model's
    // own object to the caller, so storing that same reference let the FIRST
    // consumer poison every later hit.
    store.set(key, JSON.parse(JSON.stringify(result)) as ModelResult);
    stamps.set(key, now());
    if (maxEntries !== undefined && store.size > maxEntries) {
      const oldest = store.keys().next();
      if (oldest.done !== true) {
        store.delete(oldest.value);
        stamps.delete(oldest.value);
      }
    }
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
