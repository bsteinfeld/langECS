// Model contracts (R43). Types only — the engine never uses them; adapters
// (@langecs/ai-sdk, @langecs/langchain) and the stdlib build on these.

import { delay, throwIfAborted } from './cancel';

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
   * Cooperative cancellation (R49). A `Model` should check this before starting
   * work, forward it to the underlying transport, and **reject** — never
   * resolve — once it aborts; `throwIfAborted(signal)` covers the common case.
   *
   * Inside a system this is `ctx.signal` (R51), which fires when the world is
   * cancelled (R50) or the system's `timeoutMs` elapses (R52). Cancellation is
   * cooperative by construction: a model that ignores the signal cannot be
   * interrupted, and the engine does not pretend otherwise — it stops waiting
   * for the pair, but the underlying call may still be in flight.
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

/** One scripted turn: a fixed message, or a function of the request (R44). */
export type ScriptedTurn = Msg | ((req: ModelRequest) => Msg | Promise<Msg>);

export interface ScriptedModelOptions {
  /**
   * Delay every turn by this many milliseconds, interruptibly (R44 amended).
   * The wait rejects the instant `req.signal` aborts, which is how a test
   * exercises cancellation (R49) and system timeouts (R52) deterministically
   * and with zero network.
   */
  delayMs?: number;
}

/**
 * Deterministic `Model` for tests (R44): returns the scripted turns in order,
 * supports `stream` by chunking content, throws if called more times than
 * scripted.
 *
 * Cancellation-aware (R49): a call with an already-aborted `req.signal` rejects
 * **without consuming a turn**, so the script stays aligned for whatever runs
 * next — a cancelled step must not silently eat the reply the following step
 * expects. A turn function may return a promise, which is the deterministic way
 * to script a slow (or never-settling) call.
 */
export function scriptedModel(turns: ScriptedTurn[], opts?: ScriptedModelOptions): Model {
  let index = 0;
  const next = async (req: ModelRequest): Promise<Msg> => {
    // Checked before the turn is consumed: an aborted call leaves the script
    // untouched.
    throwIfAborted(req.signal);
    const turn = turns[index];
    if (turn === undefined) {
      throw new Error(
        `scriptedModel exhausted: ${turns.length} turn(s) scripted, call ${index + 1} requested.`,
      );
    }
    index += 1;
    if (opts?.delayMs !== undefined) await delay(opts.delayMs, req.signal);
    return typeof turn === 'function' ? turn(req) : turn;
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
