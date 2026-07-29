# @langecs/langchain

LangChain.js model adapter for LangECS: wrap any LangChain chat model
(`BaseChatModel`) as a core [`Model`](../core/README.md#model-contracts). LangChain's
message classes stay at the adapter boundary — inside the world, conversation history
is plain-JSON `Msg[]` components, snapshot-safe by construction.

Peer dependency: `@langchain/core` (>= 0.3; developed and tested against v1).

## `fromLangChain(chatModel: BaseChatModel): Model`

```ts
import { ChatOpenAI } from '@langchain/openai';   // any BaseChatModel works
import { fromLangChain } from '@langecs/langchain';
import { createWorld } from '@langecs/core';

const world = createWorld();
world.register('model:main', fromLangChain(new ChatOpenAI({ model: 'gpt-4o-mini' })));
```

As with every LangECS model adapter, agents reference the model by resource name
(`ModelRef('model:main')`), so this registration line is the entire integration — the
unit tests run the identical adapter against LangChain's `FakeListChatModel` with zero
network:

```ts
import { FakeListChatModel } from '@langchain/core/utils/testing';

const model = fromLangChain(new FakeListChatModel({ responses: ['hello there'] }));
const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
result.message; // { role: 'assistant', content: 'hello there' }
```

## Message mapping

| core `Msg` | LangChain message |
|---|---|
| `role: 'system'` | `SystemMessage` |
| `role: 'user'` | `HumanMessage` |
| `role: 'assistant'` (+ `toolCalls`) | `AIMessage` (+ `tool_calls`) |
| `role: 'tool'` | `ToolMessage` (`tool_call_id` from `toolCallId` — required; missing it throws) |

`ModelRequest.system` is prepended as a `SystemMessage`, and `ModelRequest.signal` is
passed as the call's `signal` option (R49 — see [Limitations](#limitations)). On the way back,
`tool_calls` map to `toolCalls`, `usage_metadata` to
`usage.{inputTokens,outputTokens}`, `finish_reason`/`stop_reason` from
`response_metadata` to `finishReason`, reasoning (`reasoning_content` or
thinking content blocks) to `Msg.thinking`, and `raw` carries the original
LangChain message.

## Tool binding

When a request carries `tools`, the chat model is bound **per call** via
`bindTools()`; core `ToolSpec`s convert to LangChain's most portable tool input shape
(`{ name, description?, schema }`, JSON Schema passed through untouched). From this
package's tests:

```ts
const result = await fromLangChain(chatModel).generate({
  system: 'be terse',
  messages: [{ role: 'user', content: 'add 1 and 2' }],
  tools: [{
    name: 'add',
    description: 'adds two numbers',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  }],
});
// chatModel.bindTools(...) was called with the converted specs;
// result.message.toolCalls carries any tool calls the model made.
```

The tools have no `execute` — the engine (stdlib `executeTools`) owns execution. A
model that does not implement `bindTools()` throws a descriptive error when tools are
requested.

## Streaming

`stream()` uses the model's `.stream()` (every LangChain runnable exposes it;
non-streaming models fall back to a single chunk). Text chunks are forwarded to
`onChunk` as they arrive; chunks are concatenated with `.concat()` so the final
`ModelResult` includes accumulated tool calls and usage. The stdlib
[`callLLM`](../stdlib/README.md#callllm) system picks this up automatically and emits
live token events.

## Limitations

`ModelRequest.temperature` and `maxTokens` — and the other call-time sampling controls
(`topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`) — are
**ignored**: LangChain chat models configure sampling at construction time and expose no
portable call-time option. Set them on the chat model itself.

`ModelRequest.signal` is **not** in that group. It is forwarded as the call's `signal`
option on both `generate()` and `stream()` (R49), so an abort reaches the provider
request; and the adapter checks the signal itself first, so a signal that has already
aborted rejects without invoking the model at all.

## Exports

`fromLangChain`, plus the pure conversion functions: `toLangChainMessage`,
`toLangChainMessages`, `toLangChainTools` (and its `LangChainToolParams` type),
`fromLangChainMessage`, `toModelResult`.

## See also

- [@langecs/core](../core/README.md) — the `Model`/`Msg`/`ToolSpec` contracts
- [@langecs/ai-sdk](../ai-sdk/README.md) — the Vercel AI SDK adapter (used by the examples)
- [@langecs/stdlib](../stdlib/README.md) — where `ModelRef` and tool execution live
