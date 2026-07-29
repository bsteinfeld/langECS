import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import { type Model, type ModelRequest, throwIfAborted } from '@langecs/core';
import { toLangChainMessages, toLangChainTools, toModelResult } from './convert';

/**
 * Wrap any LangChain chat model (`BaseChatModel`) as a core LangECS `Model`.
 *
 * - `Msg[]` (plus optional `system`) is converted to LangChain message classes
 *   (`SystemMessage`/`HumanMessage`/`AIMessage` incl. `tool_calls`/`ToolMessage`).
 * - When `req.tools` is non-empty the model is bound per call via `bindTools()`;
 *   a model without `bindTools` throws a descriptive error.
 * - `usage_metadata` maps to `usage.{inputTokens,outputTokens}`; `finish_reason`
 *   (or `stop_reason`) from `response_metadata` maps to `finishReason`; `raw` is
 *   the original LangChain message.
 * - `stream()` is implemented via the model's `.stream()` (every LangChain
 *   runnable exposes it; non-streaming models fall back to a single chunk).
 *
 * Note: call-time sampling controls (`req.temperature`, `req.maxTokens`,
 * `req.topP`, `req.seed`, …) are ignored — LangChain chat models configure
 * sampling at construction time and expose no portable call-time option.
 * `req.signal` is **not** in that group: it is forwarded as the call's `signal`
 * option (R49), so cancellation reaches the provider request. The
 * adapter does surface reasoning content (`Msg.thinking`) when the model emits
 * it (DeepSeek `reasoning_content`, Anthropic thinking blocks).
 */
export function fromLangChain(chatModel: BaseChatModel): Model {
  const bound = (req: ModelRequest) => {
    if (req.tools === undefined || req.tools.length === 0) return chatModel;
    if (typeof chatModel.bindTools !== 'function') {
      throw new Error(
        `@langecs/langchain: request includes tools but chat model "${chatModel._llmType()}" does not implement bindTools().`,
      );
    }
    return chatModel.bindTools(toLangChainTools(req.tools));
  };

  // Cooperative cancellation (R49): LangChain takes `signal` as a call option
  // on every runnable, so an aborted `ctx.signal` stops the provider request.
  // Omitted entirely when unset, so callers see no behavior change.
  const callOptions = (req: ModelRequest): { signal?: AbortSignal } | undefined =>
    req.signal === undefined ? undefined : { signal: req.signal };

  return {
    async generate(req) {
      // R49's "reject, never resolve" enforced here, not left to the provider:
      // an already-aborted signal must not produce a fresh reply.
      throwIfAborted(req.signal);
      const message = await bound(req).invoke(toLangChainMessages(req), callOptions(req));
      return toModelResult(message);
    },

    async stream(req, onChunk) {
      throwIfAborted(req.signal);
      const stream = await bound(req).stream(toLangChainMessages(req), callOptions(req));
      let final: AIMessageChunk | undefined;
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text.length > 0) onChunk({ text });
        final = final === undefined ? chunk : final.concat(chunk);
      }
      if (final === undefined) {
        throw new Error('@langecs/langchain: chat model stream yielded no chunks.');
      }
      return toModelResult(final);
    },
  };
}
