import { type Model, type ModelRequest, type ModelResult, throwIfAborted } from '@langecs/core';
import { generateText, type LanguageModel, streamText } from 'ai';
import {
  type AiSdkToolCall,
  toAiSdkTools,
  toAssistantMsg,
  toModelMessages,
  toUsage,
} from './convert';

/**
 * Wrap a Vercel AI SDK v6 language model (or gateway model id) as a LangECS
 * core `Model`.
 *
 * - `generate()` maps to `generateText` (single step: tools carry no
 *   `execute`, so tool calls are returned to the engine unexecuted).
 * - `stream()` maps to `streamText`, forwarding text deltas to `onChunk`
 *   as they arrive and resolving with the same `ModelResult` shape.
 */
export function fromAiSdk(model: LanguageModel): Model {
  const callOptions = (req: ModelRequest) => ({
    model,
    system: req.system,
    messages: toModelMessages(req.messages),
    tools: toAiSdkTools(req.tools),
    temperature: req.temperature,
    maxOutputTokens: req.maxTokens,
    // Sampling controls (R43): forwarded only when set, so providers that
    // reject a given knob are never sent an explicit `undefined`.
    topP: req.topP,
    topK: req.topK,
    frequencyPenalty: req.frequencyPenalty,
    presencePenalty: req.presencePenalty,
    seed: req.seed,
    stopSequences: req.stopSequences,
    // Cooperative cancellation (R49): the SDK aborts the underlying HTTP
    // request, so `ctx.signal` (a cancelled world or an elapsed system timeout)
    // actually stops the call rather than just stopping the wait.
    abortSignal: req.signal,
    // Core `Msg[]` may legitimately contain role:'system' entries.
    allowSystemInMessages: true,
  });

  return {
    async generate(req: ModelRequest): Promise<ModelResult> {
      // Enforce R49's "reject, never resolve" at the adapter boundary rather
      // than trusting the provider: forwarding `abortSignal` covers an abort
      // that lands mid-flight (the SDK aborts the HTTP request), but a signal
      // that was ALREADY aborted before the call reaches some providers as a
      // normal request. A cancelled world must never observe a fresh reply.
      throwIfAborted(req.signal);
      const result = await generateText(callOptions(req));
      return {
        message: toAssistantMsg(result.text, result.toolCalls, result.reasoningText),
        usage: toUsage(result.usage),
        finishReason: result.finishReason,
        raw: result,
      };
    },

    async stream(req: ModelRequest, onChunk: (d: { text?: string }) => void): Promise<ModelResult> {
      throwIfAborted(req.signal);
      // Suppress the SDK's default console logging; errors surface as
      // 'error' stream parts and are re-thrown below.
      const result = streamText({ ...callOptions(req), onError: () => {} });
      let text = '';
      let reasoning = '';
      const toolCalls: AiSdkToolCall[] = [];
      let finishReason: string | undefined;
      let usage: ModelResult['usage'];
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            if (part.text.length > 0) onChunk({ text: part.text });
            break;
          case 'reasoning-delta':
            // Reasoning tokens stream too, but are captured into Msg.thinking
            // rather than forwarded as answer text via onChunk.
            reasoning += part.text;
            break;
          case 'tool-call':
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            break;
          case 'finish':
            finishReason = part.finishReason;
            usage = toUsage(part.totalUsage);
            break;
          case 'abort':
            throw new Error('AI SDK stream aborted');
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          default:
            break;
        }
      }
      return {
        message: toAssistantMsg(text, toolCalls, reasoning.length > 0 ? reasoning : undefined),
        usage,
        finishReason,
        raw: await result.response,
      };
    },
  };
}
