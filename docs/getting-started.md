# Getting started

LangECS is a TypeScript runtime for LLM agents built on an Entity-Component-System
architecture — "LangGraph.js, but the runtime is a living ECS world". Agents are
**entities**, their state is **components** (plain JSON data), and behavior is
**systems** that fire whenever the data they query changes. There is no graph and
there are no edges: the agent loop emerges from data changing.

This is an experiment in validating that mapping (see [DESIGN.md](../DESIGN.md) and
[prior-art.md](./prior-art.md)). The [examples](../examples/) form a learning path:
seven standalone examples plus six ports of LangGraph.js originals, each port with
an honest side-by-side comparison. `langecs` is a working title — see
[naming.md](./naming.md).

This page walks you through building one ReAct agent end to end. It mirrors
[`examples/react-agent`](../examples/react-agent/), which is the same program with
more tooling. For the mental model behind every line, read
[concepts.md](./concepts.md); if you know LangGraph.js, start with
[langgraph-comparison.md](./langgraph-comparison.md).

## Install

The packages are not published to npm yet — you work inside this repo, a pnpm
workspace. You need **Node ≥ 20** and **pnpm 11** (the repo pins
`packageManager: pnpm@11.1.0`, so `corepack enable` is the easy path):

```sh
git clone <this repo> && cd langecs
corepack enable
pnpm install
```

That's it. Packages export TypeScript source directly during development, so there
is no build step before running anything. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for the full workspace tour.

The walkthrough below is one runnable file. Save it as `examples/my-agent.ts`
(the `examples` package already depends on the `@langecs/*` packages it needs)
and run it with:

```sh
echo 'OPENAI_API_KEY=sk-...' >> .env.local   # repo root, gitignored
pnpm -C examples exec tsx my-agent.ts
```

## 1. Create a world

A world is the container: entities, systems, named resources, and the scheduler.
It is also the unit of persistence — a world at rest serializes to plain JSON.

```ts
import { createWorld } from '@langecs/core';

const world = createWorld({ id: 'getting-started' });
```

## 2. Register a model resource

Components only ever hold serializable data. Anything with functions — model
clients, tool implementations, DB handles — registers on the world as a **named
resource**, and components reference it **by name**. That split is what lets a
snapshot resume in any process that re-registers the same names.

```ts
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { defineResource, type Model } from '@langecs/core';
import { loadEnvLocal } from './_shared/env';

loadEnvLocal();   // repo-root .env.local -> process.env (OPENAI_API_KEY); no dotenv dep

const MainModel = defineResource<Model>('model:main');   // a typed resource name
world.register(MainModel, fromAiSdk(openai('gpt-4o-mini')));
```

`@langecs/ai-sdk` wraps any Vercel AI SDK model into the core `Model` contract
(`generate` + optional `stream`). The core itself depends on zero LLM packages.

No API key? Register a deterministic scripted model instead — same contract, zero
network. This is exactly how every example's test works:

```ts
import { scriptedModel } from '@langecs/core';

world.register(MainModel, scriptedModel([
  // Turn 1: the model requests a tool call.
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'get_weather', args: { city: 'San Francisco' } }],
  },
  // Turn 2: with the tool result in context, a plain answer ends the loop.
  { role: 'assistant', content: 'It is 64°F and foggy in San Francisco.' },
]));
```

## 3. Define a tool

A tool is data a system reads — a name in a `Tools` component — plus an
implementation registered as a resource (`tool:<name>`). `defineTool` +
`registerTools` from `@langecs/stdlib` handle the convention:

```ts
import { defineTool, registerTools } from '@langecs/stdlib';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Look up the current weather for a city. Returns temperature (°F) and conditions.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name, e.g. "San Francisco"' } },
    required: ['city'],
  },
  execute: (args) => {
    const city = String((args as { city?: unknown }).city ?? '');
    return JSON.stringify({ city, tempF: 64, conditions: 'foggy', source: 'stubbed demo data' });
  },
});

registerTools(world, [weatherTool]);
```

## 4. Define the agent — the stdlib preset

`reactAgent` from `@langecs/stdlib` returns an `AgentDef`: a named, spawnable
bundle of components + systems. The whole agent is data plus name references —
no closures over the world.

```ts
import { reactAgent } from '@langecs/stdlib';

const assistant = reactAgent({
  name: 'assistant',
  model: MainModel,             // a typed resource ref — only its name is stored, never a client
  tools: [weatherTool],         // names land in the Tools component
  systemPrompt: 'You are a helpful assistant. Use get_weather for weather questions.',
});
```

There is no magic inside. The preset bundles four ordinary systems
(`callLLM`, `toolApproval`, `executeTools`, `retry`) and a handful of ordinary
components (`Messages`, `ModelRef`, `Tools`, `SystemPrompt`). You can build the
same thing by hand — this is the heart of `callLLM`, condensed from
[`packages/stdlib/src/systems.ts`](../packages/stdlib/src/systems.ts):

```ts
import { defineSystem, type Model } from '@langecs/core';
import { Messages, MessageWaiting, ModelRef, PendingToolCalls } from '@langecs/stdlib';

const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting],   // fires when these change
  when: (e) => e.get(Messages).length > 0,       // optional guard; e.get(Messages) is typed Msg[]
  run: async (e, ctx) => {
    const model = ctx.resource<Model>(e.get(ModelRef));
    const result = await model.generate({ messages: e.get(Messages) });
    e.add(Messages, [result.message]);           // append (Messages has a reducer)
    if (result.message.toolCalls?.length) {
      e.set(PendingToolCalls, result.message.toolCalls);  // executeTools picks this up
    } else {
      e.remove(MessageWaiting);                  // answer delivered -> quiescence
    }
  },
});
```

Note what's absent: nothing routes to `executeTools`. Writing `PendingToolCalls`
*is* the routing — `executeTools` queries it, so it fires next step. See
[concepts.md](./concepts.md#dirty-triggering) for the rules.

## 5. Spawn and send

```ts
import { lastAssistant, sendMessage } from '@langecs/stdlib';

const agent = world.spawn(assistant);   // an entity with the agent's components

const run = sendMessage(world, agent, "What's the weather in San Francisco?");
```

`sendMessage` is a two-line helper over the core API: it appends a user message to
`Messages`, raises the `MessageWaiting` tag, and calls `world.run()`:

```ts
world.send(agent, Messages([userMessage(text)]), MessageWaiting());
```

## 6. Stream events

The returned `Run` is both a `PromiseLike<RunResult>` and an
`AsyncIterable<RunEvent>`. Iterators replay buffered events from the start of the
run, then go live, so you can attach whenever you like. `custom` events carry
model tokens that `callLLM` pipes through `ctx.emit` mid-step:

```ts
for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(`\n[step ${event.step}] scheduled: ${event.scheduled.map((p) => p.system).join(', ')}`);
      break;
    case 'custom': {
      const data = event.data as { kind?: string; text?: string };
      if (data.kind === 'token' && data.text) process.stdout.write(data.text);  // live tokens
      break;
    }
    case 'step:applied':
      console.log(`\n  applied: ${event.changes.map((c) => `${c.kind} ${c.component}`).join(', ')}`);
      break;
    case 'run:end':
      console.log(`\n[run ${event.status} after ${event.steps} step(s)]`);
      break;
  }
}
```

Events are observation only — never stored, never snapshotted. Durable truth
lives in components.

## 7. Read the result

```ts
const result = await run;               // { status, steps, pending, errors }
if (result.status !== 'done') {
  console.error(JSON.stringify(result, null, 2));
}
console.log(`\nfinal answer> ${lastAssistant(world, agent)?.content}`);
```

The transcript itself is just a component on the entity — `agent.get(Messages)`
returns the full `Msg[]`: user message, assistant tool-call turn, tool results,
final answer.

## What quiescence means

A run is not "execute the graph once". `world.run()` repeats a step loop:

1. Find every (system, entity) pair whose query matches **and** that is dirty
   (something it queries changed).
2. None? The world is **quiescent** — the run ends.
3. Otherwise run all eligible pairs concurrently, commit their buffered writes at
   a barrier, compute new dirt, repeat.

Quiescence is the natural end state: systems stop firing because nothing they
care about changed. There is no `END` node. The result status tells you *why* the
world went quiet:

| status | meaning |
|---|---|
| `done` | quiescent; no errors, nothing pending |
| `pending` | quiescent, but ≥ 1 entity has `AwaitingHuman` interrupts — check `world.pending()`, answer with `world.resume(entity, value)` |
| `error` | quiescent, but ≥ 1 entity has `SystemError` records (takes precedence over `pending`) |
| `idle` | the run scheduled zero steps — nothing was dirty to begin with |
| `limit` | the step cap hit (`recursionLimit`, default 50); remaining work is kept, a later `run()` resumes it |

Quiescence is also the pause mechanism: a `pending` world is at rest and fully
serializable, so human-in-the-loop survives process death for free — see
[`examples/human-in-the-loop`](../examples/human-in-the-loop/), which kills the
process mid-conversation and resumes in a new one.

## Test it deterministically

Swap the resource, keep everything else — this is the actual pattern from
[`examples/react-agent/react-agent.test.ts`](../examples/react-agent/react-agent.test.ts):

```ts
import { createWorld, scriptedModel } from '@langecs/core';

const world = createWorld();
world.register('model:main', scriptedModel([/* the two turns from step 2 above */]));
// ...spawn, sendMessage, then assert on the trace:
const trace = world.getTrace();
expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
  ['assistant:callLLM'],
  ['assistant:executeTools'],
  ['assistant:callLLM'],
]);
```

`world.getTrace()` is the flight recorder: per step, which pairs were scheduled,
which a `when` guard vetoed, every write, timings, errors. `formatTrace(steps)`
pretty-prints it when you're debugging "why didn't my system fire".

## See it: the visual inspector

One call puts the whole world on screen — entities and their components (with
live editing), system queries and pending pairs, the flight-recorder timeline,
OpenTelemetry traces, and a form to answer `AwaitingHuman` interrupts:

```ts
import { startDevtools } from '@langecs/devtools';
const server = await startDevtools(world);
console.log(server.url); // http://127.0.0.1:4477
```

Try it without writing anything: `pnpm build` once (builds the UI), then
`pnpm -C examples devtools-demo` — a seeded world with a pending refund
approval, zero API keys. [examples/devtools-demo](../examples/devtools-demo/README.md)
has the tour; add [`@langecs/otel`](../packages/otel) instrumentation for the
trace waterfall.

## Where next

- [`examples/`](../examples/README.md) — fourteen runnable examples as a
  learning path. Start with **hello-world**, **order-pipeline**, and
  **tools-from-scratch** (an agent from raw parts → the engine as a no-LLM
  workflow runtime → the tool loop demystified), then the real-world workflows
  (support-desk, content-pipeline, code-review-crew), the multi-agent patterns
  (research-team, supervisor, reflection), and finally the six LangGraph.js
  ports with their honest verdicts.
- [concepts.md](./concepts.md) — the full mental model: the step loop, dirty
  rules, reducers, scoping, snapshots.
- The guides — task-focused deep dives:
  [errors and retries](./guides/errors-and-retries.md),
  [human-in-the-loop](./guides/human-in-the-loop.md),
  [multi-agent patterns](./guides/multi-agent.md),
  [persistence and time travel](./guides/persistence-and-time-travel.md),
  [streaming and observability](./guides/streaming-and-observability.md).
- [langgraph-comparison.md](./langgraph-comparison.md) — concept-by-concept map
  for LangGraph.js developers, honest about divergences.
- [prior-art.md](./prior-art.md) — what already exists and what this experiment
  actually adds.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — workspace layout, commands, and where
  design truth lives ([DESIGN.md](../DESIGN.md), [SPEC.md](../SPEC.md)).

## Roadmap

Designed but deliberately deferred until after the example-port verdict:

- YAML/JSON declarative agent format, per-entity stepping, durable persistence
  adapters (SQLite/Postgres/Redis), a LangGraph interop adapter, and the
  long-lived server-world runtime — see [DESIGN.md §11](../DESIGN.md) for the
  full list.
