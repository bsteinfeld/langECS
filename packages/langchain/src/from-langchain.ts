import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Model, ModelRequest } from '@langecs/core';
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
 * Note: `req.temperature` / `req.maxTokens` are ignored — LangChain chat models
 * configure sampling at construction time and expose no portable call-time option.
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

  return {
    async generate(req) {
      const message = await bound(req).invoke(toLangChainMessages(req));
      return toModelResult(message);
    },

    async stream(req, onChunk) {
      const stream = await bound(req).stream(toLangChainMessages(req));
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
