# LangECS — Design Document

*Decision record from design interview, 2026-06-10. Supersedes the raw notes in `idea.md`.*

LangECS is a TypeScript framework for building agents and multi-agent systems on an
Entity-Component-System architecture — "LangGraph.js, but the runtime is a living ECS world."

---

## 1. Goal & success criteria

**v1 is a validate-by-porting experiment.** Build the minimal core, port six LangGraph.js
examples, and judge honestly whether they come out clearer and more flexible than the
originals. Open-source only if the mapping proves itself. The examples *are* the
acceptance test, not an afterthought.

**The long-term goal** is the resilient server-world: one long-lived world hosting many
persistent agents and conversations, surviving process death, resuming anywhere.
v1 doesn't build that, but every v1 decision below was made so that it requires
configuration, not rewrite.

A big part of the intended value is **dev UX**: designing agents and how they operate
should feel friendly. Much of that lives in the stdlib (presets like a ReAct agent),
not the engine.

---

## 2. The core mapping

Classic ECS semantics underneath, agent-first DX on top.

| LangECS | What it is | LangGraph analog |
|---|---|---|
| **Entity** | An agent instance (or task/blackboard/anything) — just an id | (node instance / thread state, loosely) |
| **Component** | ALL data and state: message history, model ref, pending tool calls, flags | State channels |
| **System** | Query-driven logic of any kind: `callLLM`, `execTools`, `route`, `queryDB`… | Nodes |
| **Component add/remove/change** | What triggers systems | Edges / channel triggers |
| **World** | The container: entities, systems, registries, scheduler | Compiled graph + checkpointer + thread |

A system has three parts:

1. **Query** — the component set that makes an entity eligible (`query(Messages, ModelRef, MessageWaiting)`)
2. **`when` guard** *(optional)* — arbitrary JS predicate for fine-grained conditions (from idea.md: "direct it to very specific places with some JavaScript")
3. **`run` handler** — async function receiving `(entity, ctx)`

A "tool" is **data a system reads** (a name in a `Tools` component), not the definition
of a system. Executing tools is one stdlib system among many.

`defineAgent(...)` produces a named, spawnable bundle of components + systems, so
agents are first-class to define and spawn — and because components are pure data,
the definition is itself a serializable document (see §7, §13).

---

## 3. Execution model

### 3.1 Reactive scheduler with discrete steps (Pregel-style super-steps)

Event-driven, never polling — but batched. Component mutations during step N are
buffered; at the step boundary the scheduler computes which (system, entity) pairs now
match and runs them as step N+1. Step boundaries are where **checkpoints, stream
events, interrupts, and recursion limits** live.

A run terminates on **quiescence** (no pair fires) or when `recursionLimit`
(max steps) hits.

### 3.2 Parallel within a step, global barrier

All matching pairs in a step run concurrently (`Promise.all`); mutations are buffered
per pair and applied at the barrier in deterministic order (system registration order,
then entity id). Wall-clock parallel, semantically deterministic. Same model as
LangGraph super-steps, so ported examples behave identically.

Known cost, accepted for v1: one slow system holds the barrier for the whole world that
step. **Per-entity independent stepping is a v2 opt-in**, not the v1 foundation.

### 3.3 Dirty-triggering with self-write exclusion

A (system, entity) pair fires in step N+1 iff its query matches AND something relevant
changed in step N:

- the query **newly matches**, or
- a **queried component's value changed** — written by *someone else* (a pair's own
  writes never retrigger itself).

Consequences (all intended):

- Appending to `Inbox` wakes the recipient (value change counts).
- `callLLM` appending to `Messages` doesn't re-call itself (self-write excluded).
- A stale trigger component left behind is harmless — no change, no re-fire, quiescence
  still reached. No "must consume your trigger" discipline, no accidental $0.10/step
  loops.
- Loops are **explicit cycles**: A writes what B reads, B writes what A reads
  (e.g. `callLLM ↔ execTools`, writer ↔ critic). `recursionLimit` backstops
  intentional cycles.

### 3.4 Write conflicts: per-component reducers, error otherwise

A component definition may declare a **reducer** (merge function). Concurrent writes to
the same component+entity in one step merge through it deterministically —
`Messages`/`Inbox`/`Findings` append, counters sum. Without a reducer, a double-write
**throws a clear error at the barrier** (naming both systems, the entity, and the
step). Silent last-write-wins data loss is impossible by construction. This is
LangGraph channel semantics (`messages` reducer, `InvalidUpdateError`), so fan-out/
fan-in examples port directly.

### 3.5 Errors are components

The engine catches a throwing system, discards that pair's buffered writes (other
pairs commit normally), and writes a `SystemError` component onto the entity:
`{system, step, attempt, error}`. Then failure is just state:

- stdlib **retry system** matches `(SystemError, RetryPolicy)` and re-triggers with backoff
- a **supervisor** queries workers' `SystemError` components and reassigns
- unhandled errors leave the world **quiescent-with-error**, surfaced by `world.send`

Errors survive snapshots, appear in the trace and inspector, and are programmable —
which is what the resilient server-world requires. (Opt-in strict/fail-fast mode is a
possible later convenience, not the default.)

### 3.6 Entity lifecycle

Systems can **spawn and despawn entities**; both are buffered to the barrier like any
mutation (a supervisor can mint workers at runtime). Entity references inside
components are **by id** (serializable).

---

## 4. World model & persistence

### 4.1 World = persistent container; run = drive to quiescence

A world is the unit of state, identity, and persistence. "Running" is not a separate
concept: `world.send(input)` adds components and drives the scheduler until quiescent;
the world is then at rest and serializable. Default usage is one world per
conversation/task (≈ LangGraph `thread_id`) so example ports map cleanly — but worlds
are never forced ephemeral: a long-lived world with many persistent agents is the same
object. **Nothing in the core may assume single-conversation worlds.** The server-world
(goal state) is a runtime configuration of this same model plus isolation/GC concerns,
layered later.

### 4.2 Components are pure data; behavior lives in named registries

Components hold only serializable data (JSON / structured-clone). Anything with
functions — tool implementations, model clients, DB connections — registers on the
world as a **named resource**; components reference behavior **by name**:

```ts
world.register('tool:sql', sqlToolImpl);
world.register('model:main', fromAiSdk(anthropic('claude-sonnet-4-6')));

agent.add(Tools, ['tool:sql']);
agent.add(ModelRef, 'model:main');
```

A snapshot is plain JSON; any process with the code re-registers resources and resumes
the world. Escape hatches: per-component custom serializers, and `transient` components
(dropped on snapshot, rebuilt by systems). These are escape hatches, not the norm.

### 4.3 Checkpointing

The persistence adapter (LangGraph-checkpointer-style, swappable) receives the snapshot
at **every step boundary**. Full snapshots first; deltas are a later optimization. The
in-memory adapter keeps history — that's what makes **time-travel and
fork-from-step-N** free. v1 adapters: in-memory (in core), filesystem
(`persist-fs`). Durable backends (SQLite/Postgres/Redis) later.

### 4.4 Human-in-the-loop: quiescence IS the pause

No engine machinery. A system needing human input writes an `AwaitingHuman` component
(with a payload describing what it needs) and doesn't add further trigger components —
the world goes quiescent naturally. The caller checks *why* it's quiescent
(`done` vs `pending`), shows the payload, and later sends the answer as ordinary input.

- Pause/resume is identical to any turn boundary and survives process restarts for free.
- DX helpers make it first-class: `world.pending()`, `world.resume(entity, answer)`.
- Cost: ask in one system, handle in another (no mid-function `interrupt()`).
  Ported interrupt examples restructure into ask/handle system pairs.
  A LangGraph-style `interrupt()` sugar that compiles down to this convention is a
  possible v2 layer — not v1.

---

## 5. API style

**Plain typed functions, data underneath.** No decorators (class-only in TS, weaker
inference, tooling churn), no DSL in v1.

```ts
const Messages = defineComponent<Msg[]>({
  name: 'messages',
  reducer: (a, b) => [...a, ...b],
});

const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting],
  when: (e) => e.get(Messages).length > 0,       // optional guard
  run: async (e, ctx) => { /* ... */ },
});

const SqlAgent = defineAgent({
  name: 'sql-agent',
  components: [ModelRef('model:main'), Tools(['tool:sql'])],
  systems: [callLLM, execTools],
});

const world = createWorld();
const agent = world.spawn(SqlAgent);
await world.send(agent, userMsg);
```

Full type inference: a system's handler knows its queried components' types.

**System scoping — auto-tag.** `defineAgent` auto-creates a hidden tag component
(`agent:sql-agent`) added to every spawned instance, and automatically narrows that
agent's declared systems' queries by the tag. An agent's systems only run on its own
instances — no crosstalk — yet underneath it's plain tags + queries (pure ECS, no new
engine concept). Systems registered via `world.use(system)` are **global**: that's how
cross-cutting systems work (trace logger, token budget guard, supervisor watching all
workers).

Because `defineAgent` output is pure data + name refs, **a YAML/JSON declarative layer
is a thin v2 loader** — designed from the evidence of the ported examples, not guessed
up front.

---

## 6. LLM layer

**The core depends on zero LLM packages.** It defines two small contracts:

- **`Msg`** — plain-JSON message type (`role`, `content`, `toolCalls?`, …), satisfying
  the data-only component rule. The `Messages` component stores these.
- **`Model`** — `generate(msgs, {tools, ...}) → {message, usage}` plus optional
  `stream(...)`.

First-party adapter packages:

| Package | Wraps | Status |
|---|---|---|
| `@langecs/ai-sdk` | Vercel AI SDK — every provider (Anthropic, OpenAI, Google, Ollama…), tool-calling, streaming | v1; used by the example ports |
| `@langecs/langchain` | LangChain.js chat models; converts message classes ↔ plain JSON at the boundary | v1 |
| `@langecs/langgraph` | Interop: mount a compiled LangGraph graph *as a LangECS system* — incremental-migration story | post-validation stretch |

Swapping models is a registry entry. A scripted `FakeModel` implements `Model`
trivially → the entire engine test suite runs deterministic with zero API calls.

---

## 7. Multi-agent communication

**Components ARE the channel.** No bus, no RPC. Any system may write components on any
entity (buffered, reducer-merged — already conflict-safe), and that is communication.
In-flight messages are just components: in the snapshot, visible to time-travel,
queryable. The step scheduler *is* the "event manager" from idea.md.

Two stdlib-blessed conventions:

1. **Actor-style `Inbox`** — append-reducer component on each agent;
   `world.send(target, msg)` = buffered write to the target's `Inbox`; dirty-triggering
   wakes the recipient's systems next step.
2. **Blackboard** — a shared entity (often spawned per-task) whose components
   (`Transcript`, `Findings`, `Plan`) collaborating agents read and reduce into.

Supervisor pattern = an ordinary system: `query(Inbox, SupervisorTag)` routing `Task`
components onto workers (spawning them if needed). Healing = a system matching
`(SystemError, WorkerTag)`.

Explicitly rejected: engine-level message bus (second kind of state outside
components), direct agent-calls-agent invocation (nests runs inside systems,
breaks the barrier and checkpointing).

---

## 8. Streaming & observability

Clean split: **durable truth lives in components** (snapshotted); **observation is an
ephemeral event stream** (never state, never snapshotted).

v1 scope — all four:

1. **Step/update event stream** — `world.send`/`world.stream` exposes an
   async-iterable: step started, system ran, mutations applied, quiescent/pending.
   ≈ LangGraph `updates` mode; nearly free since the barrier computes it anyway.
2. **Token streaming via `ctx.emit`** — systems pipe model stream chunks into the
   event stream mid-step; the final message still lands in `Messages` at the barrier.
3. **Flight-recorder trace** — per-step structured record: which pairs matched, which
   were vetoed by `when` guards (answers "why didn't my system fire"), every write,
   timings, errors, conflicts. Ships with a pretty console printer. Foundation for
   time-travel debugging.
4. **OTel export + visual world inspector** — in v1 by explicit choice, **sequenced
   after the example ports**. Shipped as `@langecs/otel` and `@langecs/devtools`,
   built on a small first-class observer surface (SPEC §14: `world.observe` event
   tap + external-change notifications + system-run middleware, plus read-only
   introspection) rather than only the trace format — the middleware hook is what
   makes OTel async-context propagation (model spans nested under system spans)
   possible at all. Observers are isolated by contract (R45): they can never alter
   a run's outcome, so the no-bespoke-plumbing spirit holds — the engine still
   doesn't know what OTel or a GUI is. The inspector (watch components flow between
   agents, live editing, step history / time travel) is a long-term differentiator.

---

## 9. Validation plan (v1 gate)

Six ports, chosen to maximize coverage of design decisions, each compared side-by-side
with the LangGraph.js original for clarity and line count. Honest verdicts — if ours
isn't clearer, the experiment says so.

| Port | Validates |
|---|---|
| **ReAct quickstart** | core loop, dirty-trigger LLM↔tools cycle, stdlib ReAct preset, token streaming |
| **sql-agent** (the idea.md motivator) | tool/model registries, multi-stage component flow, "agent vs workflow is just components" |
| **multi_agent supervisor** | Inbox/Task comms, parallel-within-step, runtime spawning, SystemError healing |
| **reflection (writer↔critic)** | explicit cycles, reducer-merged transcripts, recursionLimit |
| **human-in-the-loop** | AwaitingHuman → quiescent → resume; *kill the process mid-conversation and resume in a new one* (demo gold) |
| **persistence/time-travel how-tos** | adapter interface, snapshot/restore, rewind-to-step-N, fork timelines |

**Wave 2 (post-verdict):** plan-and-execute, ReWOO, agentic RAG — breadth, low new
decision coverage.

Success criterion for the experiment: the supervisor and reflection ports — where ECS
should *win* — come out clearly more natural than the StateGraph versions, and the
baselines are at least par.

> **Outcome (2026-06-11):** all six ports shipped and the criterion was largely met —
> supervisor cleared its bar, reflection half-cleared it (runtime semantics yes,
> read-time legibility no), baselines par. Aggregate judgment and release
> recommendation: [docs/experiment-verdict.md](docs/experiment-verdict.md).

---

## 10. Project setup

- **pnpm monorepo**, ESM-only, TypeScript strict, Node ≥ 20
- **Core is isomorphic** (no Node APIs) → browser/edge later for free (in-browser inspector demo, edge agents)
- Build: tsdown · Tests: vitest (deterministic via FakeModel) · Lint/format: Biome

```
langecs/
├─ packages/
│  ├─ core/        # engine: 0 runtime deps, isomorphic; includes in-memory persistence
│  ├─ stdlib/      # components & systems: Inbox, retry, AwaitingHuman, ReAct preset…
│  ├─ ai-sdk/      # Vercel AI SDK model adapter
│  ├─ langchain/   # LangChain.js model adapter
│  └─ persist-fs/  # filesystem persistence adapter
├─ examples/
│  ├─ react-agent/   sql-agent/
│  ├─ supervisor/    reflection/
│  └─ human-in-loop/ time-travel/
└─ pnpm-workspace.yaml
```

Package boundaries enforce the architecture (core's zero-dep claim is structural, not
vigilance). **Naming:** `langecs` is a working title; the "Lang—" prefix risks
LangChain brand confusion — do a rename pass before any public release.

---

## 11. Deferred (v2+) — decided, not forgotten

- **YAML/JSON declarative agent format** — thin loader over `defineAgent` data, designed from port evidence
- **Per-entity independent stepping** — opt-in escape from the global barrier for large worlds
- **Deep ECS** — messages/tool-calls as entities with relation components (`BelongsTo`, `IssuedBy`)
- **`interrupt()` sugar** — LangGraph-style mid-system pause compiling down to the AwaitingHuman convention
- **`@langecs/langgraph` interop adapter** — run existing graphs as systems
- **Durable persistence adapters** — SQLite/Postgres/Redis; snapshot deltas
- **Server-world runtime** — isolation, entity GC, multi-tenancy on the long-lived world model
- **Opt-in strict mode** — fail-fast errors for script-style usage

## 12. Known risks

- **Global barrier latency** in heterogeneous worlds (one slow LLM call stalls the step) — accepted for v1, per-entity stepping is the planned escape.
- **Dirty-trigger semantics** are the subtlest part of the engine; they need exhaustive deterministic tests (FakeModel) before any example is ported.
- **Inspector scope creep** — it's gated behind the ports and the trace format on purpose; hold that line.
- **The hypothesis may fail** — the supervisor/reflection ports may not beat StateGraph. That outcome is a valid (and publishable) result of the experiment.
