// Context-window management for long-running conversations. Pure, deterministic
// helpers plus a `Model` wrapper — no scheduler interaction, so they compose
// safely with the chat loop and stay testable with `scriptedModel`.
//
// The durable truth (the full `Messages` history) is never mutated; these
// helpers bound only what a model SEES on a given call. That keeps snapshots
// complete and time-travel honest while preventing runaway token bills.

import type { Model, ModelRequest, Msg } from '@langecs/core';

/** Rough character count of a message, including a small per-message overhead. */
const msgChars = (msg: Msg): number => {
  let chars = msg.content.length + 8; // role/formatting overhead
  if (msg.toolCalls) {
    for (const call of msg.toolCalls) chars += call.name.length + JSON.stringify(call.args).length;
  }
  return chars;
};

/**
 * Cheap, provider-agnostic token estimate (~4 characters per token) for a single
 * string or a message list. Deliberately an over-estimate-friendly heuristic,
 * not a real tokenizer — good enough to budget a window. Pass your own estimator
 * to {@link recentMessages} / {@link withMessageWindow} when you need precision.
 */
export function estimateTokens(input: string | Msg[]): number {
  const chars =
    typeof input === 'string' ? input.length : input.reduce((sum, msg) => sum + msgChars(msg), 0);
  return Math.ceil(chars / 4);
}

export interface WindowOptions {
  /** Keep at most this many of the most recent messages. */
  maxMessages?: number;
  /** Keep the most recent messages fitting within this estimated token budget. */
  maxTokens?: number;
  /** Token estimator (default {@link estimateTokens}); plug in a real tokenizer. */
  estimate?: (messages: Msg[]) => number;
  /**
   * Always retain leading `system` messages regardless of budget (default
   * `true`) — the agent's instructions should survive truncation.
   */
  keepSystem?: boolean;
}

/** Strip a leading `tool` message orphaned from its (now-trimmed) assistant tool call. */
function dropOrphanLeadingTools(messages: Msg[]): Msg[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role === 'tool') start += 1;
  return start === 0 ? messages : messages.slice(start);
}

/**
 * Returns the most recent slice of `messages` that fits the window, keeping
 * leading `system` messages by default. Pure — never mutates its input.
 *
 * Guards against the classic provider error of a `tool` result without its
 * preceding assistant tool call: if truncation would start the window on an
 * orphaned `tool` message, those leading tool messages are dropped too.
 *
 * With neither `maxMessages` nor `maxTokens` set, returns `messages` unchanged.
 *
 * @example
 * ```ts
 * const trimmed = recentMessages(e.get(Messages), { maxTokens: 4000 });
 * ```
 */
export function recentMessages(messages: Msg[], opts: WindowOptions = {}): Msg[] {
  const { maxMessages, maxTokens } = opts;
  if (maxMessages === undefined && maxTokens === undefined) return messages;
  const estimate = opts.estimate ?? estimateTokens;
  const keepSystem = opts.keepSystem ?? true;

  // Pin leading system messages; window only over the rest.
  let pinned = 0;
  if (keepSystem) {
    while (pinned < messages.length && messages[pinned]?.role === 'system') pinned += 1;
  }
  const head = messages.slice(0, pinned);
  const body = messages.slice(pinned);

  // Walk backwards from the newest, accepting messages while within budget.
  const kept: Msg[] = [];
  for (let i = body.length - 1; i >= 0; i--) {
    const msg = body[i]!;
    const candidate = [msg, ...kept];
    if (maxMessages !== undefined && candidate.length > maxMessages) break;
    if (maxTokens !== undefined && estimate([...head, ...candidate]) > maxTokens) {
      // Always keep at least the single most recent message, even if it alone
      // exceeds the budget — dropping it would send an empty conversation.
      if (kept.length === 0) kept.unshift(msg);
      break;
    }
    kept.unshift(msg);
  }

  return [...head, ...dropOrphanLeadingTools(kept)];
}

/**
 * Wraps a `Model` so every request's `messages` are windowed by
 * {@link recentMessages} before the call — a safe, scheduler-free way to bound
 * context for long-running agents. Register the wrapped model as the resource
 * and every agent using it stays under budget automatically; the stored
 * `Messages` history is untouched.
 *
 * `stream` is preserved when the underlying model supports it.
 *
 * @example
 * ```ts
 * world.register('model:main', withMessageWindow(fromAiSdk(model), { maxTokens: 8000 }));
 * ```
 */
export function withMessageWindow(model: Model, opts: WindowOptions): Model {
  const trim = (req: ModelRequest): ModelRequest => ({
    ...req,
    messages: recentMessages(req.messages, opts),
  });
  const wrapped: Model = {
    generate: (req) => model.generate(trim(req)),
  };
  if (model.stream) {
    const stream = model.stream.bind(model);
    wrapped.stream = (req, onChunk) => stream(trim(req), onChunk);
  }
  return wrapped;
}
