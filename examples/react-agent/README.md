# react-agent — the ReAct quickstart, as an ECS world

A Reason + Act agent built from the `@langecs/stdlib` `reactAgent` preset, with two
tools: a **stubbed weather lookup** (canned data — the LangGraph original uses Tavily
web search, which needs a second API key) and a **real calculator** (a tiny
recursive-descent expression evaluator). It is a port of the
[LangGraph.js quickstart](https://github.com/langchain-ai/langgraphjs/tree/main/examples/quickstart).

What it demonstrates:

- the **`callLLM` ↔ `executeTools` dirty-trigger cycle** — the agent loop with no
  graph edges: each system fires because another system's writes dirtied the
  components its query watches;
- **token streaming** through the single run event stream (`ctx.emit` → `custom`
  events), interleaved with step progress.

## Files

- `agent.ts` — tools + the `reactAgent(...)` AgentDef, shared by demo and test
- `main.ts` — live demo against OpenAI `gpt-4o-mini` via `@langecs/ai-sdk`
- `react-agent.test.ts` — deterministic choreography test (`scriptedModel`, zero network)

## Run it

```sh
pnpm install                                # repo root
echo 'OPENAI_API_KEY=sk-...' >> .env.local  # repo root, gitignored
pnpm -C examples react-agent                # live demo
pnpm -C examples exec vitest run react-agent  # deterministic tests, no key needed
```

Sample output (real run):

```
user> What's the weather in San Francisco right now, and what is (23.5 * 4) - 7?

[step 1] scheduled: assistant:callLLM
  assistant:callLLM done in 2490ms
  tool requested -> get_weather({"city":"San Francisco"})
  tool requested -> calculator({"expression":"(23.5 * 4) - 7"})
  applied: merge Messages, set PendingToolCalls

[step 2] scheduled: assistant:executeTools
  assistant:executeTools done in 1ms
  applied: merge Messages, remove PendingToolCalls

[step 3] scheduled: assistant:callLLM
  assistant> The weather in San Francisco right now is 64°F and foggy. ... is 87.
  assistant:callLLM done in 1605ms
  applied: merge Messages, remove MessageWaiting

[run done after 3 step(s)]
```

## How the loop works (no edges anywhere)

| Step | What fires | Why it fired (dirty rule) | What it writes |
|---|---|---|---|
| 1 | `callLLM` | `sendMessage` appended to `Messages` and added `MessageWaiting` (external dirt) | appends assistant msg, sets `PendingToolCalls` |
| 2 | `executeTools` | `PendingToolCalls` newly matches its query (`toolApproval` is scheduled on the same dirt, but its `when` vetoes — no tool needs approval) | appends two `tool` msgs, removes `PendingToolCalls` |
| 3 | `callLLM` | `executeTools`' `Messages` append is **foreign** dirt — `callLLM`'s own step‑1 append did not re-fire it (self-write exclusion) | appends final answer, removes `MessageWaiting` |
| — | nothing | no eligible pairs → **quiescence**, run resolves `'done'` | |

The test asserts exactly this sequence from `world.getTrace()` and the run event
stream, plus the token stream and the final transcript — deterministically, using
core's `scriptedModel`.

## Honest comparison with the LangGraph.js original

The original quickstart, in full ([source](https://github.com/langchain-ai/langgraphjs/blob/main/examples/quickstart/quickstart.ipynb)):

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agentTools = [new TavilySearchResults({ maxResults: 3 })];
const agentModel = new ChatOpenAI({ temperature: 0 });
const agentCheckpointer = new MemorySaver();

const agent = createReactAgent({
  llm: agentModel,
  tools: agentTools,
  checkpointSaver: agentCheckpointer,
});

const agentFinalState = await agent.invoke(
  { messages: [new HumanMessage("what is the current weather in sf")] },
  { configurable: { thread_id: "42" } },
);
```

The LangECS equivalent (this example, condensed):

```ts
import { reactAgent, registerTools, sendMessage, lastAssistant } from "@langecs/stdlib";

const world = createWorld();
world.register("model:main", fromAiSdk(openai("gpt-4o-mini")));
registerTools(world, [weatherTool, calculatorTool]);
const agent = world.spawn(
  reactAgent({ name: "assistant", model: "model:main", tools: [weatherTool, calculatorTool] }),
);

await sendMessage(world, agent, "what is the current weather in sf");
lastAssistant(world, agent)?.content;
```

The quickstart's second half rebuilds the same agent explicitly with
`new StateGraph(MessagesAnnotation).addNode("agent", callModel).addNode("tools", toolNode)
.addEdge("__start__", "agent").addEdge("tools", "agent").addConditionalEdges("agent", shouldContinue)`
— a hand-written `shouldContinue` router deciding between `"tools"` and `"__end__"`.
LangECS has no equivalent of that routing function at all: `callLLM` setting (or not
setting) `PendingToolCalls` *is* the routing, and quiescence *is* `__end__`.

### Where LangECS comes out better

- **No control-flow wiring.** The explicit LangGraph version needs `addEdge`,
  `addConditionalEdges`, `shouldContinue`, `__start__`/`__end__`. Here, routing is
  data: systems fire when their queried components change. Adding a capability is
  adding a system, not rewiring a graph.
- **Observability and testability.** One typed event stream covers step progress,
  per-system timings, and streamed tokens (LangGraph splits this across
  `streamMode: "values" | "updates" | "messages" | "custom"`). The flight recorder
  (`world.getTrace()`) lets the test assert the *exact* step-by-step choreography —
  including the `toolApproval` veto — in ~20 lines with a scripted model and zero
  mocking framework.
- **State is plain JSON.** `Messages` is `{ role, content, toolCalls? }[]`, not
  `HumanMessage`/`AIMessage` class instances; snapshots are trivially portable, and
  there is no serializer/reviver layer.
- **Scales to many agents for free.** One registered `callLLM`/`executeTools` pair
  serves N spawned agents in parallel within a step. In LangGraph that shape needs
  subgraphs or the `Send` API.

### Where the LangGraph original is better

- **Less ceremony for the happy path.** `createReactAgent({ llm, tools })` is one
  call: tools carry their own execution and are bound to the model for you. LangECS
  needs three wiring steps (`world.register` for the model resource,
  `registerTools`, `world.spawn`) because behavior must live in named resources, and
  the `'model:main'` / `'tool:get_weather'` indirection is stringly-typed — a typo
  fails at runtime, not compile time.
- **Static legibility.** A compiled graph can be drawn (`agent.getGraph().drawMermaidPng()`).
  The LangECS loop is *emergent* from queries + dirty rules; there is nothing to draw,
  and you must understand self-write exclusion to predict why step 3 fires but step 4
  doesn't. The trace shows what *did* happen, not what *can*.
- **Ecosystem and maturity.** The original gets Tavily search as an off-the-shelf
  tool, LangSmith tracing with two env vars, and years of battle-tested
  interrupt/persistence patterns and docs. LangECS is a v1 experiment; this example
  stubs the weather tool partly because there is no tool catalog to pull from.
- **Multi-turn threads out of the box.** `MemorySaver` + `thread_id: "42"` gives the
  quickstart per-thread memory across `invoke` calls with no extra code. LangECS
  persistence (`MemoryAdapter`/`fsAdapter` + `worldId`) is equivalent in power but
  per-world, and is not shown here (see the `human-in-the-loop` and `time-travel`
  examples).

### Verdict

**Par for this example, with different strengths.** For a single ReAct agent the
LangGraph prebuilt is genuinely shorter and better supported; LangECS wins on
runtime transparency (trace, one event stream, step-level tests) and on the absence
of routing code. The ECS shape is a bet that pays off later — multiple agents, one
world, cross-cutting systems — not a clear win at quickstart size.
