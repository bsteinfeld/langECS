// Conversions between LangECS core model contracts (Msg, ToolSpec) and the
// Vercel AI SDK v6 types (ModelMessage, ToolSet). Pure functions, no I/O.

import type { ModelResult, Msg, ToolSpec } from '@langecs/core';
import {
  type AssistantContent,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  type ToolSet,
  tool,
} from 'ai';

/** Shape shared by AI SDK tool calls (`generateText` results and `fullStream` parts). */
export type AiSdkToolCall = { toolCallId: string; toolName: string; input: unknown };

/** Shape shared by AI SDK usage objects (`LanguageModelUsage`). */
export type AiSdkUsage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

/** Convert core `Msg[]` to AI SDK `ModelMessage[]`. */
export function toModelMessages(messages: Msg[]): ModelMessage[] {
  return messages.map(toModelMessage);
}

/** Convert a single core `Msg` to an AI SDK `ModelMessage`. */
export function toModelMessage(msg: Msg): ModelMessage {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: msg.content };
    case 'user':
      return { role: 'user', content: msg.content };
    case 'assistant': {
      if (!msg.toolCalls || msg.toolCalls.length === 0) {
        return { role: 'assistant', content: msg.content };
      }
      const content: Exclude<AssistantContent, string> = [];
      if (msg.content.length > 0) content.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.args,
        });
      }
      return { role: 'assistant', content };
    }
    case 'tool':
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId ?? '',
            toolName: msg.name ?? 'unknown',
            output: { type: 'text', value: msg.content },
          },
        ],
      };
  }
}

/**
 * Convert core `ToolSpec[]` to an AI SDK `ToolSet` via `jsonSchema()`.
 * Tools carry no `execute` function: the engine (stdlib `executeTools`)
 * owns tool execution, so the SDK returns tool calls without running them.
 */
export function toAiSdkTools(specs: ToolSpec[] | undefined): ToolSet | undefined {
  if (!specs || specs.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(
        (spec.parameters ?? { type: 'object', properties: {} }) as JSONSchema7,
      ),
    });
  }
  return tools;
}

/** Build the assistant `Msg` of a `ModelResult` from AI SDK text + tool calls. */
export function toAssistantMsg(text: string, toolCalls: AiSdkToolCall[]): Msg {
  const msg: Msg = { role: 'assistant', content: text };
  if (toolCalls.length > 0) {
    msg.toolCalls = toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      args: call.input,
    }));
  }
  return msg;
}

/** Map AI SDK usage to the core `ModelResult['usage']` shape. */
export function toUsage(usage: AiSdkUsage | undefined): ModelResult['usage'] {
  if (!usage) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}
