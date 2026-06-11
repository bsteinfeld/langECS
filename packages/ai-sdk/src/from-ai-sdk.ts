import type { Model, ModelRequest, ModelResult } from '@langecs/core';
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
    // Core `Msg[]` may legitimately contain role:'system' entries.
    allowSystemInMessages: true,
  });

  return {
    async generate(req: ModelRequest): Promise<ModelResult> {
      const result = await generateText(callOptions(req));
      return {
        message: toAssistantMsg(result.text, result.toolCalls),
        usage: toUsage(result.usage),
        finishReason: result.finishReason,
        raw: result,
      };
    },

    async stream(req: ModelRequest, onChunk: (d: { text?: string }) => void): Promise<ModelResult> {
      // Suppress the SDK's default console logging; errors surface as
      // 'error' stream parts and are re-thrown below.
      const result = streamText({ ...callOptions(req), onError: () => {} });
      let text = '';
      const toolCalls: AiSdkToolCall[] = [];
      let finishReason: string | undefined;
      let usage: ModelResult['usage'];
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            if (part.text.length > 0) onChunk({ text: part.text });
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
        message: toAssistantMsg(text, toolCalls),
        usage,
        finishReason,
        raw: await result.response,
      };
    },
  };
}
