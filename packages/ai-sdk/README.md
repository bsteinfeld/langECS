# @langecs/ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) model adapter for LangECS: wrap any AI SDK v6
language model as a core [`Model`](../core/README.md#model-contracts) — one dependency,
every provider (OpenAI, Anthropic, Google, Ollama, …), tool calling, and streaming
included. This is the adapter the [examples](../../examples/README.md) use.

Peer dependency: `ai` (>= 5; developed and tested against v6).

## `fromAiSdk(model: LanguageModel): Model`

```ts
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, defineResource, type Model } from '@langecs/core';
import { reactAgent } from '@langecs/stdlib';

const Gpt = defineResource<Model>('model:main');   // a typed resource name

const world = createWorld({ id: 'react-agent-demo' });
world.register(Gpt, fromAiSdk(openai('gpt-4o-mini')));
const assistant = reactAgent({ name: 'assistant', model: Gpt });
```

That registry line is the entire provider integration. The agent definition references
the model **by resource name** (`Gpt` is just `'model:main'` carrying the `Model` type;
the plain string works everywhere a ref does), so swapping providers is a one-liner —
change the registration, touch nothing else:

```ts
import { anthropic } from '@ai-sdk/anthropic';
world.register(Gpt, fromAiSdk(anthropic('claude-sonnet-4-6')));
```

`fromAiSdk` also accepts a gateway model id string, since AI SDK v6's `LanguageModel`
type includes those.

## What it maps

- **`generate()` → `generateText`.** `Msg[]` converts to AI SDK `ModelMessage[]`
  (system/user/assistant-with-tool-call-parts/tool-result), `ToolSpec[]` converts to an
  AI SDK `ToolSet` via `jsonSchema()`. The tools carry **no `execute` function** — a
  single model step returns tool calls to the engine unexecuted, because tool execution
  belongs to the world (stdlib `executeTools`), not the SDK. Sampling controls pass
  through when set — `temperature`, `maxTokens` (→ `maxOutputTokens`), `topP`, `topK`,
  `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`; usage and
  `finishReason` map back; `raw` carries the original SDK result. Reasoning models'
  thinking is captured into `Msg.thinking` (from the SDK's reasoning output).
- **`stream()` → `streamText`.** Text deltas are forwarded to `onChunk` as they arrive;
  reasoning deltas are accumulated into `Msg.thinking` (not forwarded as answer text);
  tool calls and usage are collected from the full stream; the resolved `ModelResult`
  has the same shape as `generate()`. Stream errors are re-thrown (they surface as a
  failing system in the world, i.e. a `SystemError` record — not a crash).

## Streaming

Used directly (adapted from this package's integration test):

```ts
const model = fromAiSdk(openai('gpt-4o-mini'));
const chunks: string[] = [];
const result = await model.stream?.(
  { messages, system, tools: [addTool], temperature: 0 },
  (d) => { if (d.text) chunks.push(d.text); },
);
// chunks.join('') === result.message.content
```

Inside a world you normally don't call this yourself: the stdlib
[`callLLM`](../stdlib/README.md#callllm) system detects `stream` support and pipes
tokens into the live run event stream via `ctx.emit({ kind: 'token', text })` — see the
[react-agent example](../../examples/react-agent/main.ts) for printing them as they
arrive.

## Conversion utilities

The mapping functions are exported for reuse and testing — pure functions, no I/O:

| Export | Direction |
|---|---|
| `toModelMessages(msgs)` / `toModelMessage(msg)` | core `Msg` → AI SDK `ModelMessage` |
| `toAiSdkTools(specs)` | core `ToolSpec[]` → AI SDK `ToolSet` (via `jsonSchema()`) |
| `toAssistantMsg(text, toolCalls)` | AI SDK output → core assistant `Msg` |
| `toUsage(usage)` | AI SDK usage → `ModelResult['usage']` |
| `AiSdkToolCall`, `AiSdkUsage` | shared shape types |

## Tests

- **Unit tests** run against the AI SDK's `MockLanguageModelV3` — deterministic, zero
  network: `pnpm -C packages/ai-sdk test`.
- **One integration test** does a real ReAct round trip (tool call → tool result →
  streamed final answer) against OpenAI. It is gated on `OPENAI_API_KEY`: put the key
  in the **repo-root `.env.local`** (gitignored; a tiny built-in loader reads it — no
  dotenv dependency) and the same test command runs it; without the key it is skipped
  entirely.

## See also

- [@langecs/core](../core/README.md) — the `Model`/`Msg`/`ToolSpec` contracts
- [@langecs/stdlib](../stdlib/README.md) — `ModelRef`, `callLLM`, tool execution
- [@langecs/langchain](../langchain/README.md) — the same idea for LangChain.js chat models
