// Model contracts (R43). Types only — the engine never uses them; adapters
// (@langecs/ai-sdk, @langecs/langchain) and the stdlib build on these.

import { abortReason, delay, throwIfAborted } from './cancel';

export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  name?: string;
  /**
   * Reasoning / "thinking" text a model emitted alongside its answer
   * (o1/o3, Claude extended thinking, DeepSeek-R1, …). Output-only and
   * observation-oriented: adapters populate it from the provider's reasoning
   * blocks, but it is never sent back to the model (`content` is the durable
   * answer). Plain JSON like the rest of `Msg`, so it survives snapshots — drop
   * it before persisting if the reasoning is sensitive.
   */
  thinking?: string;
  meta?: Record<string, unknown>;
};

export type ToolSpec = {
  name: string;
  description?: string;
  /** JSON Schema. */
  parameters?: Record<string, unknown>;
};

export interface ModelRequest {
  messages: Msg[];
  system?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Nucleus sampling (0–1). Set this or `temperature`, not both. */
  topP?: number;
  /** Top-K sampling: only consider the K most likely tokens. */
  topK?: number;
  /** Penalize tokens by their existing frequency. Provider ranges vary. */
  frequencyPenalty?: number;
  /** Penalize tokens that have appeared at all. Provider ranges vary. */
  presencePenalty?: number;
  /**
   * Sampling seed. With a fixed seed (and temperature) supporting providers
   * return near-deterministic output — useful for reproducible runs and tests.
   */
  seed?: number;
  /** Stop generation when any of these strings is produced. */
  stopSequences?: string[];
  /**
   * Cooperative cancellation (R49), in three parts: check this before starting
   * work, forward it to the underlying transport, and check it once more before
   * delivering a result — **reject**, never resolve, once it aborts.
   * `throwIfAborted(signal)` covers each check in one line. The third check is
   * what stops a provider that ignores the signal from resolving into a
   * cancelled caller.
   *
   * The caller owns the signal: an `AbortController` it holds, or a timeout it
   * set around the call. Once engine-level cancellation lands, systems will
   * receive one as `ctx.signal`. Cancellation is cooperative by construction: a
   * model that ignores the signal cannot be interrupted, and the engine does not
   * pretend otherwise — it stops waiting for the pair, but the underlying call
   * may still be in flight.
   */
  signal?: AbortSignal;
}

export interface ModelResult {
  message: Msg;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  raw?: unknown;
}

export interface Model {
  generate(req: ModelRequest): Promise<ModelResult>;
  stream?(req: ModelRequest, onChunk: (d: { text?: string }) => void): Promise<ModelResult>;
}

/**
 * Awaits `pending`, but rejects the moment `signal` aborts (R49). A scripted turn
 * function is allowed to *never* settle — that is how R44 says to script a call
 * that only a timeout can end — so awaiting it directly would hang the test
 * rather than cancel it. The listener is removed however the race ends, so a
 * settled turn leaves nothing attached to a long-lived signal.
 */
function raceAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  let onAbort: (() => void) | undefined;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject);
  }).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

/** One scripted turn: a fixed message, or a function of the request (R44). */
export type ScriptedTurn = Msg | ((req: ModelRequest) => Msg | Promise<Msg>);

export interface ScriptedModelOptions {
  /**
   * Delay every turn by this many milliseconds, interruptibly (R44 amended).
   * The wait rejects the instant `req.signal` aborts, which is how a test
   * exercises cancellation (R49) and timeout scenarios deterministically and
   * with zero network — and, per the invariant on {@link scriptedModel}, without
   * consuming the turn it was waiting to deliver.
   */
  delayMs?: number;
}

/**
 * Deterministic `Model` for tests (R44): returns the scripted turns in order,
 * supports `stream` by chunking content, throws if called more times than
 * scripted.
 *
 * Cancellation-aware (R49), with one invariant: **a turn is consumed only when a
 * reply is delivered.** Any call that rejects because `req.signal` aborted —
 * before it started, during a `delayMs` wait, or while an async turn function
 * was still resolving — leaves the script exactly where it was, so the next call
 * receives that same turn. A cancelled step must not silently eat the reply the
 * following step expects. (`stream()` has produced its reply by the time it
 * begins chunking, so an abort partway through chunk delivery rejects with the
 * turn already spent.)
 *
 * Concurrent calls — several pairs calling the model in one step — still take
 * distinct turns in call order; a cancelled call returns only *its own* slot, to
 * be reused by whichever call comes next.
 *
 * A turn function may return a promise, which is the deterministic way to script
 * a slow — or never-settling — call. Such a turn is *raced* against `req.signal`
 * rather than merely awaited, so a call that only a timeout could end rejects at
 * the abort instead of hanging.
 */
export function scriptedModel(turns: ScriptedTurn[], opts?: ScriptedModelOptions): Model {
  let cursor = 0;
  // Slots handed back by calls that aborted before delivering a reply, kept
  // ascending and reused before `cursor` advances again. A plain "rewind the
  // cursor" would be wrong: several pairs can call the model concurrently in one
  // step, so each claims its slot up front and only a cancelled call returns it.
  const released: number[] = [];
  const peek = (): number => (released.length > 0 ? (released[0] as number) : cursor);
  const claim = (): void => {
    if (released.length > 0) released.shift();
    else cursor += 1;
  };
  const release = (slot: number): void => {
    released.push(slot);
    released.sort((a, b) => a - b);
  };
  const next = async (req: ModelRequest): Promise<Msg> => {
    throwIfAborted(req.signal);
    // Exhaustion is reported without disturbing the cursor, so the message stays
    // stable however many times an exhausted model is called.
    const slot = peek();
    const turn = turns[slot];
    if (turn === undefined) {
      throw new Error(
        `scriptedModel exhausted: ${turns.length} turn(s) scripted, call ${slot + 1} requested.`,
      );
    }
    // Claimed synchronously: concurrent calls within one step must take distinct
    // turns, so the slot cannot stay up for grabs across the awaits below.
    claim();
    try {
      if (opts?.delayMs !== undefined) await delay(opts.delayMs, req.signal);
      // Raced, not just awaited: an abort wins against a turn that is slow or
      // never settles at all, and still rejects rather than hanging.
      const message =
        typeof turn === 'function' ? await raceAbort(Promise.resolve(turn(req)), req.signal) : turn;
      // Covers the ordering where the turn settled and the abort landed together.
      throwIfAborted(req.signal);
      return message;
    } catch (err) {
      // Only cancellation returns the turn — that is what the invariant is
      // about. A turn function that throws on its own has delivered its
      // scripted outcome and stays consumed.
      if (req.signal?.aborted === true) release(slot);
      throw err;
    }
  };
  return {
    async generate(req) {
      return { message: await next(req), finishReason: 'stop' };
    },
    async stream(req, onChunk) {
      const message = await next(req);
      const text = message.content;
      const chunkSize = Math.max(1, Math.ceil(text.length / 4));
      for (let at = 0; at < text.length; at += chunkSize) {
        throwIfAborted(req.signal);
        onChunk({ text: text.slice(at, at + chunkSize) });
      }
      return { message, finishReason: 'stop' };
    },
  };
}
