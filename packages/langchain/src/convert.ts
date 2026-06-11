// Msg[] <-> LangChain message conversion plus tool-spec and result mapping.
// Pure functions with no engine coupling — `fromLangChain()` builds on these.

import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ModelRequest, ModelResult, Msg, ToolSpec } from '@langecs/core';

/** Convert a single core `Msg` into the corresponding LangChain message class. */
export function toLangChainMessage(msg: Msg): BaseMessage {
  switch (msg.role) {
    case 'system':
      return new SystemMessage(msg.content);
    case 'user':
      return new HumanMessage(msg.content);
    case 'assistant': {
      const toolCalls = (msg.toolCalls ?? []).map((tc) => ({
        type: 'tool_call' as const,
        id: tc.id,
        name: tc.name,
        // LangChain types tool-call args as a record; core keeps them `unknown`.
        // Pass the value through untouched — LangChain does not validate at runtime.
        args: (tc.args ?? {}) as Record<string, unknown>,
      }));
      return new AIMessage({
        content: msg.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
    case 'tool': {
      if (msg.toolCallId === undefined) {
        throw new Error(
          '@langecs/langchain: tool message is missing toolCallId — LangChain ToolMessage requires tool_call_id.',
        );
      }
      return new ToolMessage({
        content: msg.content,
        tool_call_id: msg.toolCallId,
        ...(msg.name !== undefined ? { name: msg.name } : {}),
      });
    }
  }
}

/** Convert a full `ModelRequest` (optional system prompt + messages) into LangChain messages. */
export function toLangChainMessages(req: ModelRequest): BaseMessage[] {
  const out: BaseMessage[] = [];
  if (req.system !== undefined) out.push(new SystemMessage(req.system));
  for (const msg of req.messages) out.push(toLangChainMessage(msg));
  return out;
}

/**
 * LangChain `StructuredToolParams` shape — the most portable member of `BindToolsInput`:
 * providers run it through `convertToOpenAITool`, and the fake test models read
 * `name`/`description`/`schema` directly.
 */
export type LangChainToolParams = {
  name: string;
  description?: string;
  /** JSON Schema (passed through `toJsonSchema` untouched on the LangChain side). */
  schema: Record<string, unknown>;
};

/** Convert core `ToolSpec`s into LangChain `bindTools` input. */
export function toLangChainTools(tools: ToolSpec[]): LangChainToolParams[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    schema: tool.parameters ?? { type: 'object', properties: {} },
  }));
}

/** Convert a LangChain AI message (or accumulated stream chunk) back into a core `Msg`. */
export function fromLangChainMessage(message: AIMessage | AIMessageChunk): Msg {
  const toolCalls = (message.tool_calls ?? []).map((tc, index) => ({
    id: tc.id ?? `call_${index}`,
    name: tc.name,
    args: tc.args as unknown,
  }));
  return {
    role: 'assistant',
    content: message.text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function extractFinishReason(message: AIMessage | AIMessageChunk): string | undefined {
  const meta = message.response_metadata as Record<string, unknown> | undefined;
  const candidate = meta?.finish_reason ?? meta?.finishReason ?? meta?.stop_reason;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Map a LangChain AI message (or accumulated stream chunk) to a core `ModelResult`. */
export function toModelResult(message: AIMessage | AIMessageChunk): ModelResult {
  const result: ModelResult = { message: fromLangChainMessage(message), raw: message };
  const usage = message.usage_metadata;
  if (usage !== undefined) {
    result.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
  const finishReason = extractFinishReason(message);
  if (finishReason !== undefined) result.finishReason = finishReason;
  return result;
}
