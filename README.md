# LangECS

**An Entity-Component-System runtime for LLM agents — LangGraph's execution semantics on a living ECS world instead of a compiled graph.**

Agents are entities. All agent state — message history, pending tool calls, errors, interrupts — is components (pure JSON data). Logic is systems: queries over components plus an async handler. There are no edges and no router; a system fires when another system's writes dirty the components its query watches, and a run ends when nothing fires (quiescence). One sentence of positioning: **LangGraph is Pregel over a closed graph; LangECS is Pregel over an open world.**

> **Status: v0.1, an experiment — verdict in.** This repo exists to validate a hypothesis — that an ECS substrate makes agent orchestration clearer and more flexible than a graph — by porting six LangGraph.js examples side by side and judging honestly (each port's [README](#examples) contains its verdict, including where LangGraph is better; the aggregate judgment is in [docs/experiment-verdict.md](docs/experiment-verdict.md)). APIs are unstable, packages are not on npm, and the name `langecs` is provisional — a rename is planned before any release ([docs/naming.md](docs/naming.md)).

"Agents as ECS entities" is not a new idea — [ArgOS](https://github.com/project-89/argOS) and DeepMind's [Simulation Streams](https://arxiv.org/abs/2501.18668) got there first, on the simulation side. What LangECS adds is the runtime:

- **Reactive dirty-triggered scheduling instead of tick loops.** Prior ECS×agent systems tick on wall-clock intervals or run sequentially. Here, (system, entity) pairs fire only when a *foreign* write changes their queried components — a pair's own writes never retrigger it, so `callLLM` appending to `Messages` doesn't re-call itself and there are no accidental $0.10/step loops. Loops must be explicit cycles (LLM ↔ tools, writer ↔ critic), backstopped by `recursionLimit`.
- **LangGraph-parity orchestration on the ECS substrate.** Deterministic parallel super-steps with a commit barrier, per-component reducers for concurrent writes (a reducer-less double write throws instead of silently losing data), checkpoint/resume at every step boundary, human-in-the-loop via quiescence, time travel and forking.
- **Durability is a queryable world snapshot, not a replay journal.** Temporal/Inngest-style runtimes also survive process death; what they persist is an opaque execution log. A LangECS snapshot is plain JSON you can read, query, diff, rewind, and fork — time travel is a primitive, not a reconstruction.

Lineage: under the hood this is a blackboard system with production-rule triggering and Pregel super-steps, borrowing reactive change detection from game-engine ECS — the full survey of ancestors and prior art is in [docs/prior-art.md](docs/prior-art.md).

## The mapping

| LangECS | What it is | LangGraph analog |
|---|---|---|
| **Entity** | An agent instance (or a task, a shared blackboard, anything) — just an id | Node instance / thread state, loosely |
| **Component** | *All* state: message history, model ref, pending tool calls, errors, interrupts | State channels |
| **System** | Query-driven logic: `callLLM`, `executeTools`, a supervisor, a healer | Nodes |
| **Component add/remove/change** | What triggers systems | Edges / channel triggers |
| **World** | The container: entities, systems, named resources, scheduler, snapshot | Compiled graph + checkpointer + thread |

Components hold only serializable data. Anything with behavior — model clients, tool implementations, DB handles — registers on the world as a named resource, and components reference it by name (`ModelRef('model:main')`). That one rule is why a snapshot is plain JSON and any process with the code can resume it.

## 60-second quickstart

Not on npm yet — run inside the repo:

```sh
git clone <this repo> langecs && cd langecs
corepack enable && pnpm install             # Node >= 20, pnpm 11
echo 'OPENAI_API_KEY=sk-...' >> .env.local  # repo root, gitignored
pnpm -C examples react-agent                # the agent below, plus token streaming
pnpm test                                   # entire suite: deterministic, zero network —
                                            # unless OPENAI_API_KEY is set, which opts in
                                            # one real ai-sdk integration test
```

A complete ReAct agent (adapted from [`examples/react-agent`](examples/react-agent/README.md)):

```ts
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, defineResource, type Model } from '@langecs/core';
import { ask, defineTool, reactAgent, registerTools } from '@langecs/stdlib';

// A typed resource name: the world slot a Model client registers under.
const Gpt = defineResource<Model>('model:main');

// A tool is data a system reads; its implementation registers on the world by name.
const weather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: (args) =>
    JSON.stringify({ city: (args as { city: string }).city, tempF: 64, conditions: 'foggy' }),
});

// An agent is a spawnable bundle of components + query-scoped systems.
const assistant = reactAgent({
  name: 'assistant',
  model: Gpt, // just a typed resource name — components hold data, never clients
  tools: [weather],
  systemPrompt: 'You are a helpful assistant.',
});

const world = createWorld();
world.register(Gpt, fromAiSdk(openai('gpt-4o-mini')));
registerTools(world, [weather]);
const agent = world.spawn(assistant);

// One awaited Q&A turn, driven to quiescence. The LLM→tools→LLM loop has no
// edges: callLLM's reply with tool calls dirties PendingToolCalls (wakes
// executeTools); the tool result appended to Messages is foreign dirt that
// wakes callLLM again; a reply without tool calls removes MessageWaiting and
// the world goes quiescent — which is when ask() returns the reply text.
console.log(await ask(world, agent, "What's the weather in San Francisco?"));
```

Swap `fromAiSdk(openai(...))` for any AI SDK provider, or `fromLangChain(chatModel)` from [`@langecs/langchain`](packages/langchain) — the model is one registry entry. Tests replace it with `scriptedModel` from core and assert the exact step choreography with zero network. Want live tokens and step events instead of one awaited answer? `sendMessage(world, agent, text)` returns a `Run` that is both awaitable and an `AsyncIterable<RunEvent>` — [`examples/supervisor`](examples/supervisor/README.md) is the full event-stream demo.

Three helpers carry most of the examples, all one-liners:

- `defineResource<Model>('model:main')` — a typed resource name: `world.register(ref, client)` and `ctx.resource(ref)` type-check instead of being stringly-typed.
- `ask(world, agent, text)` — one fully-automatic turn: send, run to quiescence, return the reply text (any non-`'done'` outcome throws a self-explaining error).
- `extractJson<T>(model, { prompt, schema })` — strict-JSON structured output from any `Model`, with markdown-fence stripping and one parse-failure retry built in.

## What you get for being state-first

Everything below is a consequence of one design rule: there is no execution state outside components. These snippets are condensed from the working examples they cite.

### Errors are components

A throwing system isn't a crashed run. The engine discards that pair's writes (siblings in the same step commit normally) and appends a `SystemError` component to the entity — so failure is queryable state, and healing is just another system. When the retried pair later succeeds, the engine auto-clears its records. From [`examples/supervisor`](examples/supervisor/README.md):

```ts
const heal = defineSystem({
  name: 'heal',
  query: [SystemError, Task], // a crashed worker with an unfinished task
  run: (e, ctx) => {
    for (const record of e.get(SystemError)) {
      ctx.invalidate(e, record.system); // re-arm the failed pair for the next step
    }
  },
});
world.use(heal); // global system: watches every entity in the world
```

### Kill the process mid-conversation, resume in another one

Human-in-the-loop needs no engine machinery: a system writes an `AwaitingHuman` component and the world goes quiescent with status `'pending'`. Since every step boundary was already persisted, "pause" survives process death by construction. From [`examples/human-in-the-loop`](examples/human-in-the-loop/README.md):

```ts
// Process 1: delete_record is defined with needsApproval: true → run ends
// 'pending', every step is already on disk under .world/ → process.exit(0).

// Process 2 — brand new process, later:
const adapter = fsAdapter({ dir: DATA_DIR });
const world = buildWorld();                // same systems-and-resources recipe as process 1
world.use(recordsAgent);                   // register the agent's systems BEFORE load
const snapshot = await adapter.load(WORLD_ID);
world.load(snapshot!);                     // entities, step counter, pending dirt — the lot

const [pending] = world.pending();         // why is it paused? read the interrupt payload
await world.resume(pending!.entity, true); // approve → runs to the final answer
```

### Time travel is loading a snapshot

The in-memory adapter keeps full history, so rewind-and-fork is three lines, and the original timeline is untouched. From [`examples/time-travel`](examples/time-travel/README.md):

```ts
const adapter = new MemoryAdapter();
const world = createWorld({ id: 'demo', persistence: adapter }); // snapshot at every barrier
const agent = world.spawn(timeTraveler);
await sendMessage(world, agent, "Hi! I'm Jo.");
await sendMessage(world, agent, "What's the weather like in SF currently?");

const fork = createWorld({ id: 'demo-fork', persistence: adapter });
fork.use(timeTraveler);                        // systems before load
fork.load(adapter.loadStep('demo', 1)!);       // rewind: the weather question never happened
await sendMessage(fork, agent.id, 'What is my name?'); // timelines diverge from here
```

### Parallel multi-agent steps, deterministic by construction

All matching pairs in a step run concurrently (`Promise.all`); writes are buffered and applied at the barrier in a deterministic order, with reducers merging fan-in. The supervisor dispatches both workers in one barrier — including spawning a whole agent mid-run. From [`examples/supervisor`](examples/supervisor/README.md):

```ts
// Inside the supervisor's plan system:
ctx.write(researcherId, Task, { from: e.id, instructions: tasks.researcher }, 'set');
ctx.spawn(writer, Task({ from: e.id, instructions: tasks.writer })); // agent spawned at runtime
// Next step: researcher:work and writer:work fire CONCURRENTLY. Both report via
// ctx.write(task.from, Inbox, [...], 'add') — Inbox's append reducer merges the
// fan-in deterministically; without a reducer the double write would throw.
```

And when something *doesn't* fire, the built-in flight recorder answers why: every step's trace records which pairs were scheduled, which were vetoed by `when` guards, every write, and timings (`world.getTrace()` / `formatTrace()`).

## Packages

| Package | What it is |
|---|---|
| [`@langecs/core`](packages/core) | The engine: world, reactive scheduler, snapshots, run event stream, flight recorder, `MemoryAdapter`, `scriptedModel`. **Zero runtime dependencies, isomorphic** (no `node:*`). |
| [`@langecs/stdlib`](packages/stdlib) | Standard components and systems — `Messages`, `Inbox`, `callLLM`, `executeTools`, tool approval, retry — plus the `reactAgent` preset and `defineTool`/`sendMessage` helpers. |
| [`@langecs/ai-sdk`](packages/ai-sdk) | `fromAiSdk(model)`: any Vercel AI SDK provider as a LangECS `Model`, with tool calls and token streaming. |
| [`@langecs/langchain`](packages/langchain) | `fromLangChain(chatModel)`: any LangChain.js chat model as a LangECS `Model`. |
| [`@langecs/persist-fs`](packages/persist-fs) | `fsAdapter({ dir })`: one JSON snapshot per step boundary on disk, atomic writes, `history()`/`loadStep()`. |
| [`@langecs/otel`](packages/otel) | OpenTelemetry instrumentation over `world.observe` (SPEC §14): run/step/system spans, GenAI-semconv model & tool spans with token usage, metrics. Depends only on `@opentelemetry/api`. |
| [`@langecs/devtools`](packages/devtools) | The visual inspector: live entity/component editing, systems & dirty-pair view, flight-recorder timeline, OTLP trace waterfall, interrupt answering, time travel — `startDevtools(world)`. |

## Examples

Fourteen runnable examples form a learning path — [examples/README.md](examples/README.md) is the full index. Every example ships a live demo (`pnpm -C examples <name>`, needs `OPENAI_API_KEY` — except order-pipeline, which makes zero model calls) and a deterministic `scriptedModel` test that asserts the step-by-step choreography with zero network. Every `main.ts` outside the ports is await-and-read-state — no event handling required; streaming is opt-in ([supervisor](examples/supervisor/README.md) is the full event-stream demo).

**Start here**

| Example | What it teaches |
|---|---|
| [hello-world](examples/hello-world/README.md) | A chat agent from raw parts — one component, one tag, one system; quiescence ends the run |
| [order-pipeline](examples/order-pipeline/README.md) | A no-LLM workflow engine — stage components, free per-order concurrency, retry-after-failure |
| [tools-from-scratch](examples/tools-from-scratch/README.md) | The tool loop demystified — `think` ↔ `act` by hand, no loop construct, then the `reactAgent` preset |
| [devtools-demo](examples/devtools-demo/README.md) | The inspector GUI on a live world — edit components, approve interrupts, time-travel, OTel traces (no API key needed) |

**Real-world workflows**

| Example | What it teaches |
|---|---|
| [support-desk](examples/support-desk/README.md) | Entities as work items: concurrent triage, `when`-guard routing, per-ticket human escalation |
| [content-pipeline](examples/content-pipeline/README.md) | A staged pipeline with no orchestrator: `ctx.spawn` fan-out, reducer fan-in, count-guard readiness |
| [code-review-crew](examples/code-review-crew/README.md) | Three reviewers, one step: same-query fan-out, the step barrier as the join, a lead verdict |

**Multi-agent**

| Example | What it teaches |
|---|---|
| [research-team](examples/research-team/README.md) | Runtime agent spawning onto a shared blackboard, a bounded critic cycle, a global token budget |
| [supervisor](examples/supervisor/README.md) | Parallel worker fan-out, `Inbox` fan-in, mid-run spawning, crash → heal (also a LangGraph port) |
| [reflection](examples/reflection/README.md) | Writer↔critic alternation from self-write exclusion; termination by removing a tag (also a port) |

**LangGraph ports + verdicts** — the six side-by-side ports that gated the experiment; each README ends with an honest comparison ([examples/README.md](examples/README.md#langgraph-ports--verdicts) condenses all six verdicts):

| Example | LangGraph.js original | Verdict in one phrase |
|---|---|---|
| [react-agent](examples/react-agent/README.md) | [quickstart](https://github.com/langchain-ai/langgraphjs/tree/main/examples/quickstart) | Par, with different strengths |
| [sql-agent](examples/sql-agent/README.md) | [sql-agent](https://github.com/langchain-ai/langgraphjs/tree/main/examples/sql-agent) | Roughly par, with opposite strengths |
| [supervisor](examples/supervisor/README.md) | [agent_supervisor.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/agent_supervisor.ipynb) | Better at the mechanics this pattern is about |
| [reflection](examples/reflection/README.md) | [reflection](https://github.com/langchain-ai/langgraphjs/tree/main/examples/reflection) | Better runtime semantics; worse immediate legibility |
| [human-in-the-loop](examples/human-in-the-loop/README.md) | [review-tool-calls.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/review-tool-calls.ipynb), [react-human-in-the-loop.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/react-human-in-the-loop.ipynb) | Genuinely nicer for tool approval specifically |
| [time-travel](examples/time-travel/README.md) | [time-travel.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/time-travel.ipynb) | Par overall |

## Docs

**Start here**

- [docs/getting-started.md](docs/getting-started.md) — build a ReAct agent end to end from raw parts: components, systems, tools, the trace, and what to read next
- [docs/concepts.md](docs/concepts.md) — the mental model, bottom up: the step loop, dirty rules, reducers, scoping, snapshots
- [docs/langgraph-comparison.md](docs/langgraph-comparison.md) — LangECS for LangGraph.js developers: concept-by-concept mapping, plus where the two genuinely diverge (in both directions)

**Guides**

- [docs/guides/debugging-systems.md](docs/guides/debugging-systems.md) — **"why didn't my system fire?"**: read the flight recorder and introspection (`systemsMatching`, `queryStats`) to make emergent control flow legible — the five things that trip people up, each with the trace that reveals it
- [docs/guides/structured-output.md](docs/guides/structured-output.md) — typed data out of an LLM: `extractJson` with a validate hook (Zod/Valibot), `routeJson` for type-safe dispatch, and reasoning content (`Msg.thinking`)
- [docs/guides/errors-and-retries.md](docs/guides/errors-and-retries.md) — failure as queryable state: `SystemError`, retry and healing systems, barrier rejections
- [docs/guides/cancellation-and-timeouts.md](docs/guides/cancellation-and-timeouts.md) — stopping work already in flight: `world.cancel()` and the `Cancelled` component, cooperative `ctx.signal`, per-system `timeoutMs` as the escape from a hung barrier, `runningPairs()`
- [docs/guides/human-in-the-loop.md](docs/guides/human-in-the-loop.md) — pause-by-quiescence: `AwaitingHuman`, `resume()`, approval flows that survive process death
- [docs/guides/multi-agent.md](docs/guides/multi-agent.md) — supervisor/worker fan-out, `Inbox` fan-in, runtime agent spawning, writer↔critic cycles
- [docs/guides/persistence-and-time-travel.md](docs/guides/persistence-and-time-travel.md) — snapshot anatomy, the adapter contract, the restore recipe, rewind-and-fork
- [docs/guides/streaming-and-observability.md](docs/guides/streaming-and-observability.md) — the run event stream, token streaming via `ctx.emit`, the flight recorder

**Background and reference**

- [docs/experiment-verdict.md](docs/experiment-verdict.md) — the aggregate verdict on the six ports: hypothesis validated, with the wins/losses pattern and what gates a release
- [docs/prior-art.md](docs/prior-art.md) — what already exists (ArgOS, Simulation Streams, blackboard systems, Pregel, production rules, Linda, durable execution) and which claims we soften because of it
- [DESIGN.md](DESIGN.md) — the decision record: why each piece is the way it is
- [SPEC.md](SPEC.md) — the engineering contract: numbered requirements (R1–R49) and the required test matrix (T1–T27)
- [docs/naming.md](docs/naming.md) — the rename research (`langecs` is a working title)
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, commands, repo conventions

## Roadmap

Designed but deliberately deferred until the port verdicts are in:

- **Declarative agent format** — a thin YAML/JSON loader over `defineAgent` (agent definitions are already pure data + name refs)
- **Per-entity independent stepping** — opt-in escape from the global step barrier for large, heterogeneous worlds
- **Deep ECS relations** — messages and tool calls as entities with relation components (`BelongsTo`, `IssuedBy`), flecs-style pairs and cleanup policies
- **`interrupt()` sugar** — LangGraph-style mid-system pause that compiles down to the existing `AwaitingHuman` convention
- **`@langecs/langgraph` interop** — mount a compiled LangGraph graph as a LangECS system, for incremental migration
- **OTel export + visual world inspector** — both built strictly as consumers of the flight-recorder trace format (the trace is already a v1 surface; these are its first external consumers)
- **Durable persistence adapters** — SQLite/Postgres/Redis, snapshot deltas
- **Rename** — before anything ships publicly; candidates and research in [docs/naming.md](docs/naming.md)
