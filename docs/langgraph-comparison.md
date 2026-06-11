# LangECS for LangGraph.js developers

If you already build with LangGraph.js, you know almost everything you need to know
about LangECS. Both runtimes are Pregel-descended: discrete super-steps, parallel
execution inside a step, a global barrier where state commits, checkpoints at step
boundaries, reducers for concurrent writes. LangECS keeps that execution model and
swaps the *organizing structure*: instead of a graph whose nodes pass state along
edges, it's an Entity-Component-System world where systems fire on whatever entities
currently match their query.

This page maps each LangGraph concept to its LangECS equivalent, then is honest about
where the two genuinely diverge — in both directions.

> Full API reference: the [`@langecs/core`](../packages/core/README.md) and
> [`@langecs/stdlib`](../packages/stdlib/README.md) READMEs.

---

## Concept map

| LangGraph.js | LangECS | Notes |
|---|---|---|
| `StateGraph` + `compile()` → compiled graph | `createWorld()` → `World` | The world is also the live state container, not just the program |
| Node (`addNode('name', fn)`) | System (`defineSystem({ name, query, when?, run })`) | A system runs once per *matching entity* per step, not once per step |
| State channels + reducers (`Annotation.Root` / Zod state schema, `reducer:`) | Components + reducers (`defineComponent<T>({ name, reducer? })`) | Same semantics: reducers merge concurrent writes; no reducer → conflict error |
| Edges / conditional edges (`addEdge`, `addConditionalEdges`, `START`/`END`) | Component add/remove + `when` guards | "Routing" is writing data the next system's query matches |
| Super-step | Step | Same Pregel heritage, near-identical semantics |
| `Send` API / subgraphs | `ctx.spawn(...)` + `Inbox` / blackboard components | Fan-out spawns entities instead of dispatching node copies |
| `Command` (`goto` / `update`) | Ordinary component writes | There is no separate control-flow object; writes *are* control flow |
| `interrupt()` + `new Command({ resume })` | `AwaitingHuman` component + `world.pending()` / `world.resume()` | Quiescence *is* the pause; no node re-execution machinery |
| Checkpointer + `thread_id` (`MemorySaver`, `PostgresSaver`…) | `PersistenceAdapter` + `worldId` (`MemoryAdapter`, `fsAdapter`) | Snapshot saved at every step boundary in both |
| `getStateHistory` + `checkpoint_id` replay | `adapter.history()` / `adapter.loadStep()` + `world.load()` | Time travel and forking work the same way |
| `streamMode: 'values' \| 'updates' \| 'messages' \| 'custom'` | `Run` async-iterable events + `ctx.emit` | One event stream; modes become event types |
| `recursionLimit` (default 25) | `recursionLimit` (default 50) | Same job, same name: a backstop on intentional cycles |

---

## The mappings in detail

### StateGraph / compiled graph ↔ World

A compiled LangGraph graph is a program you invoke against per-thread state held by a
checkpointer. A LangECS world is both at once: it holds the entities and their
components (the state), the registered systems (the program), and named resources
(model clients, tool implementations). `world.send(target, ...componentInits)` adds the
components and drives steps until quiescence — the analog of
`graph.invoke(input, { configurable: { thread_id } })`.
Default usage is one world per conversation (≈ one `thread_id`), but a world can host
many agents and conversations at once; nothing forces the one-thread shape.

### Node ↔ System

A LangGraph node is a function that receives the whole state and returns a partial
update. A LangECS system is a function plus a *query*:

```ts
const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting],   // which entities are eligible
  when: (e) => e.get(Messages).length > 0,       // optional sync guard: read-only view
                                                 // + restricted GuardCtx; a veto
                                                 // consumes the trigger
  run: async (e, ctx) => { /* read e, write components */ },
});
```

The key shift: a node runs when an edge points at it; a system runs **once per
matching entity** whose queried components changed last step. With one entity in the
world the two are equivalent. With N worker entities, one `callLLM` system serves all
of them in parallel within the step — that's where the models stop being isomorphic.

### State channels + reducers ↔ Components + reducers

This is the closest mapping of all. A LangGraph channel with a reducer
(`Annotation<BaseMessage[]>({ reducer: ... })`, or `ReducedValue` in the Zod-schema
API) is a LangECS component with a reducer:

```ts
const Messages = defineComponent<Msg[]>({
  name: 'messages',
  reducer: (a, b) => [...a, ...b],
});
```

Concurrent writes in one step merge through the reducer in deterministic order.
Writes to a reducer-less component from two writers in the same step throw
`WriteConflictError`, which carries the `component`, `entity`, `step`, and the
conflicting writer `pairs` (`{ system, entity }[]`, in deterministic barrier order) —
the same philosophy as LangGraph's `InvalidUpdateError` on a default channel. Fan-out/fan-in
code ports directly. Differences: components live *per entity* rather than once per
thread, and `transient: true` components are excluded from snapshots (compare
`UntrackedValue`).

### Edges / conditional edges ↔ component add/remove + `when` guards

LangECS has no edges. Control flow is data flow:

- **Static edge** (`addEdge('a', 'b')`): system A writes a component that system B's
  query includes. B fires next step because its queried data changed or newly matched.
- **Conditional edge** (`addConditionalEdges('agent', shouldContinue)`): either A
  writes different components per branch (each branch system queries its own), or
  branch systems share a query and discriminate with a `when` guard.
- **`END`**: nothing. When no system writes anything that wakes another system, the
  world is quiescent and the run returns. Termination is the absence of work, not a
  sentinel node.

Two scheduler rules replace edge wiring and are worth internalizing:

1. **Dirty-triggering**: a (system, entity) pair fires only if its query matches *and*
   something relevant changed last step — a queried component was added, removed, set,
   or reducer-merged, or the query newly matches.
2. **Self-write exclusion**: a pair's own writes never retrigger it. `callLLM`
   appending to `Messages` does not re-invoke `callLLM` on the same entity. Loops must
   be *explicit cycles* — A writes what B reads, B writes what A reads (LLM ↔ tools,
   writer ↔ critic) — with `recursionLimit` as the backstop, exactly as in LangGraph.

### Super-step ↔ step (shared Pregel heritage)

LangGraph's docs describe execution as "inspired by Google Pregel": nodes scheduled
together form a super-step, updates apply between super-steps. LangECS steps are the
same construct. All matching (system, entity) pairs run concurrently
(`Promise.all`); every mutation is buffered; at the barrier, buffers apply in
deterministic order (system registration order, then entity id). Checkpoints, stream
events, interrupts, and the recursion limit all live at the same boundary in both
runtimes. Ported examples behave step-for-step identically by design. The shared
cost is also identical: one slow node/system holds the barrier for everything else
scheduled that step.

### Send API / subgraphs ↔ `ctx.spawn` + Inbox/blackboard

`Send('worker', state)` dispatches N parallel copies of a node, each with its own
state — LangGraph's map-reduce primitive. In LangECS you spawn N entities:

```ts
// supervisor system, fanning out
for (const task of tasks) {
  ctx.spawn(WorkerAgent, Task(task), Inbox([]));
}
```

Each worker entity carries its own components; the (single, shared) worker systems
run on all of them in parallel within the step. Fan-in is a reducer: workers append
to a shared blackboard entity's `Findings` component, or write to the supervisor's
`Inbox` (an append-reducer component — from inside a system, "sending a message" is
just `ctx.write(supervisor, Inbox, [msg])`, a buffered reducer merge at the barrier).
Subgraphs-as-encapsulation map to `defineAgent`: a named, spawnable
bundle of components + systems whose queries are auto-narrowed by a hidden
`agent:<name>` tag, so one agent's systems never run on another's entities.

### Command ↔ ordinary component writes

`new Command({ update, goto })` exists in LangGraph because state updates and routing
are separate mechanisms that sometimes need to be combined. In LangECS there is no
second mechanism: every write is already both an update *and* (via dirty-triggering)
a routing decision. Writing `PendingToolCalls` onto an entity is the `goto: 'tools'`.
There is nothing to map `Command.PARENT` to because there is no graph nesting —
everything is one flat world of entities.

### `interrupt()` ↔ AwaitingHuman + `world.pending()` / `world.resume()`

LangGraph's `interrupt(payload)` pauses mid-node; the payload surfaces under
`__interrupt__`; `new Command({ resume: value })` resumes — and the runtime
**re-executes the interrupted node from the beginning**, which is why code before an
`interrupt()` must be idempotent.

LangECS has no engine machinery for this at all. A system that needs human input
writes an `AwaitingHuman` component (with a payload) and simply doesn't write
anything that would wake another system. The world goes quiescent naturally, and the
run result is `'pending'` instead of `'done'`:

```ts
const result = await sendMessage(world, agent, text); // stdlib helper: Messages append + MessageWaiting + run
if (result.status === 'pending') {
  const [{ entity, interrupts }] = world.pending();   // ≈ __interrupt__
  // ... show interrupts[0].payload to a human ...
  await world.resume(entity, answer);                 // ≈ Command({ resume })
}
```

`world.resume` removes `AwaitingHuman`, sets `HumanResponse({ value })`, and runs to
quiescence; a *different* system queries `HumanResponse` and acts on it. That's the
trade: **ask in one system, handle in another.** No node re-execution machinery is
needed because nothing gets re-executed — the ask-system already committed its writes
at the barrier; resuming is just a new step triggered by new data, identical to any
other turn boundary. Consequently there is no idempotency caveat, and a pause
survives process death for free (the quiescent world is a plain snapshot). The cost
is real, though: a linear `interrupt()` call-site must be restructured into an
ask/handle system pair when porting. A LangGraph-style `interrupt()` sugar compiling
down to this convention is on the v2 list.

### Checkpointer / `thread_id` ↔ PersistenceAdapter / `worldId`

Direct mapping. `createWorld({ id, persistence: adapter })` ≈ compiling with a
checkpointer and invoking with a `thread_id`. The adapter's `save(snapshot)` is
awaited at every step boundary, like checkpoints at every super-step. A snapshot is
plain JSON — entities, components, step counter, and pending dirt — because
components are data-only; behavior (model clients, tool impls) is re-registered by
name on restore (`world.register('model:main', ...)` ≈ rebuilding your graph object).
`MemoryAdapter` ≈ `MemorySaver`; `@langecs/persist-fs` is the first durable adapter
(SQLite/Postgres/Redis later — LangGraph is well ahead here). Time travel matches
`getStateHistory` + replay from a `checkpoint_id`: `adapter.loadStep(worldId, n)`
into `world.load()` on a fresh world, then send different input to fork the timeline.

### Stream modes ↔ Run events + `ctx.emit`

`world.send()` / `world.run()` return a `Run` that is both a promise of the result
and an async iterable of events — one stream rather than selectable modes:

| LangGraph `streamMode` | LangECS equivalent |
|---|---|
| `updates` | `step:applied { changes, spawned, despawned }` events (per-step diffs) |
| `values` | apply `step:applied` diffs, or read committed state via `world.query()` |
| `messages` (token, metadata) | `custom` events from `ctx.emit` — stdlib `callLLM` emits model stream chunks mid-step |
| `custom` (`config.writer(...)`) | `ctx.emit(data)` — same role, same mid-step delivery |
| `debug` | `system:start` / `system:end` / `system:error` events + the flight-recorder trace (`world.getTrace()`) |

Emitted data is observation only — never stored, never snapshotted. The final
assistant message still lands in `Messages` at the barrier, exactly as a streamed
LangGraph node still returns its state update.

### `recursionLimit` ↔ `recursionLimit`

Same name, same job: a cap on steps that turns a runaway cycle into a `'limit'`
result instead of an infinite loop. LangGraph defaults to 25 super-steps, passed
per-invoke; LangECS defaults to 50, set at `createWorld({ recursionLimit })` or
per-run via `world.run({ limit })`. One practical difference: LangECS's stale-trigger
rule (no change → no re-fire) means leftover marker components can't cause accidental
loops, so in practice the limit only guards *intentional* cycles.

---

## What's genuinely different

**Where ECS wins.**

- **Agents are data, not program structure.** N agents = N entities sharing one set
  of systems, not N graph instances or N subgraph copies. A supervisor spawns a
  worker at runtime with `ctx.spawn(WorkerAgent, Task(t))` — no graph recompilation,
  no `Send` choreography.
- **Cross-agent queries.** Any system can query across every entity in the world:
  `query(TokenUsage)` for a budget guard, `query(Inbox, SupervisorTag)` for routing,
  a trace logger over everything. In LangGraph, cross-cutting concerns thread through
  shared state channels or sit outside the graph.
- **Failure is queryable state.** A throwing system gets its writes discarded and a
  `SystemError` component appended to the entity — other systems in the step commit
  normally. A retry system matches `(SystemError, RetryPolicy)`; a supervisor heals
  workers by querying their `SystemError` and reassigning. Errors survive snapshots
  and appear in the trace. There's no equivalent of "the error is just an exception
  that unwound the invoke."
- **The world survives process death mid-conversation, by design.** Pause is
  quiescence, the quiescent world is a JSON snapshot, and resuming in a brand-new
  process is `createWorld` + `use(...)` + `load(...)` + `resume(...)`. There is no
  in-flight execution state to lose because nothing is in flight at a boundary.
- **No edge bookkeeping.** Adding a capability is adding a system with a query;
  removing one is removing it. Nothing else needs rewiring.

**Where LangGraph wins today.**

- **Maturity and ecosystem.** LangGraph is battle-tested in production, with a large
  community, extensive examples, integrations, and answers to most questions already
  written down. LangECS is a validate-by-porting experiment.
- **Hosted platform.** LangGraph Platform / Studio give deployment, a debugger UI,
  and managed persistence out of the box. LangECS has an in-memory adapter, a
  filesystem adapter, and a planned inspector.
- **Mid-node `interrupt()`.** Pausing at an arbitrary line inside a node — with
  resume — is genuinely more ergonomic for linear approval flows than restructuring
  into ask/handle system pairs, idempotency caveat notwithstanding.
- **Time-tested streaming UX.** `streamMode: 'messages'` with per-token metadata,
  `useStream` React hooks, and the surrounding client tooling are polished. LangECS
  has one event stream and `ctx.emit`.
- **Durable checkpointers.** Postgres/SQLite/Redis/MongoDB savers exist today;
  LangECS's durable adapters are roadmap.
- **Explicit graphs are easier to read cold.** You can look at a StateGraph and see
  the topology. In an ECS world the flow is implicit in queries and writes — the
  flight-recorder trace and `formatTrace` exist precisely to compensate.

---

## Migration cheat-sheet

| In LangGraph.js you write… | In LangECS you write… |
|---|---|
| `const State = Annotation.Root({ messages: Annotation<Msg[]>({ reducer: concat }) })` | `const Messages = defineComponent<Msg[]>({ name: 'messages', reducer: (a, b) => [...a, ...b] })` |
| `graph.addNode('callModel', callModel).addEdge(START, 'callModel')` | `const callLLM = defineSystem({ name: 'callLLM', query: [Messages, ModelRef, MessageWaiting], run: async (e, ctx) => { … } })` — the query *is* the edge |
| `graph.addConditionalEdges('agent', shouldContinue, { tools: 'tools', end: END })` | the agent system writes `PendingToolCalls` (or doesn't); the tools system queries it. Branch-on-state → `when: (e) => …` |
| `const app = workflow.compile({ checkpointer }); await app.invoke({ messages }, { configurable: { thread_id: 't1' } })` | `const world = createWorld({ id: 't1', persistence: adapter }); const agent = world.spawn(MyAgent); await world.send(agent, Messages([userMsg]), MessageWaiting())` |
| `const answer = interrupt(payload); … new Command({ resume: value })` | ask-system: `e.add(AwaitingHuman, [{ id, kind: 'approval', payload }])`; caller: `world.pending()` → `world.resume(entity, value)`; handle-system: `query: [HumanResponse, …]` |
| `for await (const chunk of app.stream(input, { streamMode: ['updates', 'messages'] }))` | `const run = world.send(agent, …); for await (const ev of run) { /* 'step:applied', 'custom' (tokens via ctx.emit), … */ }` |

Full signatures: the [`@langecs/core`](../packages/core/README.md) and
[`@langecs/stdlib`](../packages/stdlib/README.md) READMEs.
