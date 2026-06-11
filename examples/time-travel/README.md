# Time travel: checkpoint history, rewind, fork

Port of the LangGraph.js how-to ["How to view and update past graph state"](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/time-travel.ipynb) (time travel).

## What it does

A ReAct agent (stdlib `reactAgent` preset, one fake `search` tool — same placeholder weather tool as the original) runs a short multi-step conversation on a world checkpointed by the core `MemoryAdapter`:

1. **Turn 1** — "Hi! I'm Jo." → 1 step (`callLLM`).
2. **Turn 2** — "What's the weather like in SF currently?" → 3 steps (`callLLM` → `executeTools` → `callLLM`), tokens streamed live via `ctx.emit`.
3. **History** — the adapter saved a full JSON snapshot at *every* step barrier; `adapter.history('time-travel')` lists steps 1–4.
4. **Rewind** — `adapter.loadStep('time-travel', 1)` is loaded into a **fresh** world (`world.use(agentDef)` to register systems, then `world.load(snapshot)`). The fresh world sits at step 1: only the greeting exchange exists; the weather question never happened.
5. **Fork** — the fresh world gets a *different* user input ("what is my name?"). Both timelines now diverge from a shared 2-message prefix, and the original world (and its checkpoint history) is provably untouched.

## Run it

```sh
# live demo (needs OPENAI_API_KEY in the repo-root .env.local; model: gpt-4o-mini)
pnpm -C examples time-travel

# deterministic test (scriptedModel, zero network)
pnpm -C examples exec vitest run time-travel
```

The test (`time-travel.test.ts`) drives the same `agent.ts` module with `scriptedModel` and asserts the step-by-step choreography from the flight-recorder trace (`callLLM` → `executeTools` (+ vetoed `toolApproval`) → `callLLM`), that the fork's state differs from the original final state, that the two timelines share the 2-message common prefix, and that the rewound world resumes *exactly* at the boundary (a bare `run()` is `'idle'`).

## Side-by-side with the LangGraph.js original

The original notebook builds the graph explicitly (Annotation state + nodes + edges + compile), then time-travels with checkpoint configs:

```ts
// LangGraph.js (original)
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (x, y) => x.concat(y) }),
});
const workflow = new StateGraph(StateAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeMessage)
  .addEdge("tools", "agent");
const graph = workflow.compile({ checkpointer: new MemorySaver() });

// history: iterate opaque checkpoint configs, pick one by inspecting values
const states = await graphWithInterrupt.getStateHistory(config);
for await (const state of states) {
  if (state.values?.messages?.length === 2) toReplay = state;
}
// replay / branch: stream(null, ...) from a checkpoint config; updateState
// attributes the edit "as if" it came from a node
const branchConfig = await graphWithInterrupt.updateState(toReplay.config,
  { messages: [{ role: "tool", content: "It's sunny out...", tool_call_id }] },
  "tools");
await graphWithInterrupt.stream(null, { ...branchConfig });
```

```ts
// LangECS (this port)
const adapter = new MemoryAdapter();
const world = createWorld({ id: 'time-travel', persistence: adapter });
const agent = world.spawn(timeTraveler); // reactAgent preset: components + systems

await sendMessage(world, agent, "Hi! I'm Jo.");
await sendMessage(world, agent, "What's the weather like in SF currently?");

adapter.history('time-travel'); // [{ step: 1, savedAt }, ... { step: 4, savedAt }]

const fork = createWorld({ id: 'time-travel-fork' });
fork.use(timeTraveler);                                // systems, no spawn
fork.load(adapter.loadStep('time-travel', 1)!);        // rewind to step 1
await sendMessage(fork, agent.id, 'what is my name?'); // diverge
```

Concept map: `MemorySaver` ↔ `MemoryAdapter`, `thread_id` ↔ `worldId`, `checkpoint_id` ↔ `step` (a plain integer), `getStateHistory` ↔ `adapter.history`, `stream(null, config)` ↔ `load` + `run`. Code size is roughly par: the notebook has ~204 non-blank code lines; this port is ~201 (`agent.ts` 71 + `main.ts` 130) and does the same work plus side-by-side timeline printing — neither is meaningfully shorter.

### Where LangECS is better

- **Snapshots are plain JSON you can read.** A checkpoint is `{ step, entities: [{ id, components }], pendingPairs }` — diffable, greppable, storable anywhere. History keys are stable integers, not opaque checkpoint UUIDs threaded through `configurable` objects; in the original you find a rewind point by iterating `getStateHistory` and sniffing `state.values.messages.length`.
- **Forks are physically isolated.** The fork is a separate world with its own id; nothing it does can touch the original timeline, and the test proves the original's state *and* its saved history are byte-identical after the fork runs. In LangGraph both branches live in one thread's checkpoint tree — powerful, but you must hold the right `checkpoint_id` to know which branch you're on, and a wrong config silently continues the wrong branch.
- **Exact-boundary resume is observable and testable.** The snapshot carries `pendingPairs` (scheduled work), so a rewound world is verifiably at rest: `(await fork.run()).status === 'idle'`. The flight recorder then gives a step-by-step trace of both timelines. The original how-to has no deterministic test story at all (it's a notebook against live OpenAI); this port's choreography test runs with `scriptedModel` in ~30 ms with zero network.
- **No graph wiring.** No `Annotation.Root`, nodes, conditional edges, or `compile` — the ReAct loop is the preset's dirty-trigger cycle, and time travel needed zero extra structure in the agent definition.

### Where LangGraph is better

- **Branching in place.** `updateState(toReplay.config, ...)` forks *inside the same thread* and returns a new checkpoint config; the checkpointer stores the whole branch tree under one `thread_id`. LangECS has linear history per `worldId` — forking means a fresh world with a new id, and *you* must re-register systems (`world.use`) and resources (model, tools) before `load`. More manual plumbing per fork.
- **Replay without rebuilding.** `stream(null, toReplay.config)` re-runs from any past checkpoint in one call on the existing graph object. The LangECS equivalent is construct-world → use → register → load every time.
- **Node-attributed state edits.** `updateState(config, values, "tools")` injects state "as if" the tools node produced it, so the graph knows the agent node runs next. LangECS can edit a loaded world with external component writes (external dirt drives the next step correctly), but there is no first-class "pretend system X wrote this" — this how-to's "add a fake tool message and branch" section has no equally ergonomic one-liner here.
- **Richer checkpoint metadata.** LangGraph state snapshots carry `next`, `metadata`, and a parent config (the branch tree). A LangECS snapshot's `pendingPairs` is the same information for resume purposes, but lower-level, and there's no parent/branch lineage between snapshots.

### Verdict

**Par overall, with different strengths.** LangECS wins on snapshot transparency, fork isolation, and deterministic testability — rewind-and-fork is just data (`loadStep` → `load`), and you can prove the original timeline is intact. LangGraph wins on time-travel *ergonomics*: in-place branching, one-call replay from any checkpoint, and node-attributed state edits are smoother than rebuilding a world per fork. If your use case is "explore alternate trajectories interactively," the original's `updateState`/checkpoint-config flow has less friction; if it's "audit, persist, test, and trust your timelines," this version is easier to reason about.
