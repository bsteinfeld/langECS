import {
  abortReason,
  type Model,
  type ModelRequest,
  type ModelResult,
  throwIfAborted,
} from '@langecs/core';
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
    // request, so an aborting signal actually stops the call rather than just
    // stopping the wait. Spread conditionally so the key is absent — not present
    // and `undefined` — when no signal was supplied.
    ...(req.signal !== undefined ? { abortSignal: req.signal } : {}),
    // Core `Msg[]` may legitimately contain role:'system' entries.
    allowSystemInMessages: true,
  });

  return {
    async generate(req: ModelRequest): Promise<ModelResult> {
      // R49 is enforced at the adapter boundary in three parts, rather than
      // trusting the provider:
      //   1. check on entry — an ALREADY-aborted signal reaches some providers
      //      as a perfectly normal request, so it must never go out;
      //   2. forward `abortSignal` (in `callOptions`) — the SDK aborts the
      //      underlying HTTP request, so an abort landing mid-flight actually
      //      stops the call instead of only stopping our wait;
      //   3. check again before delivering — a provider that ignores the signal
      //      still cannot resolve into a cancelled caller.
      throwIfAborted(req.signal);
      const result = await generateText(callOptions(req));
      throwIfAborted(req.signal);
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
            // The SDK treats an abort as a graceful end-of-stream: it emits this
            // part and closes. R49 says reject instead — and with the signal's
            // own `reason`, so `err.name === 'AbortError'` and custom reasons
            // both survive. The generic error covers an 'abort' part arriving
            // without a signal to explain it.
            if (req.signal !== undefined) throw abortReason(req.signal);
            throw new Error('AI SDK stream aborted');
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          default:
            break;
        }
      }
      // Third R49 check (see `generate`): a provider that ended its stream
      // normally despite the abort must not resolve into a cancelled caller.
      throwIfAborted(req.signal);
      return {
        message: toAssistantMsg(text, toolCalls, reasoning.length > 0 ? reasoning : undefined),
        usage,
        finishReason,
        raw: await result.response,
      };
    },
  };
}
