# Concepts

The mental model behind LangECS, bottom up: what entities, components, systems,
and worlds are; how the step loop executes; the exact rules for what fires when;
and why everything in a component must be plain data.

If you haven't built anything yet, do [getting-started.md](./getting-started.md)
first. If you think in LangGraph.js, read
[langgraph-comparison.md](./langgraph-comparison.md) alongside this. The
normative contract (numbered requirements, amendments) is [SPEC.md](../SPEC.md);
the rationale is [DESIGN.md](../DESIGN.md).

## The four nouns

| Thing | What it is |
|---|---|
| **Entity** | Just an id (a number, starting at 1, never reused). An agent instance, a task, a shared blackboard — identity, nothing else. |
| **Component** | Typed, named, serializable data attached to an entity: message history, model ref, pending tool calls, flags. ALL state lives here. |
| **System** | Query-driven logic: "for every entity with these components, when they change, run this function." |
| **World** | The container: entities, registered systems, named resources, the scheduler, the step counter. Also the unit of persistence. |

Components and systems are defined with plain typed functions:

```ts
import { defineComponent, defineSystem, defineTag, type Model, type Msg } from '@langecs/core';

// A component: globally unique name, typed value, optional reducer.
const Messages = defineComponent<Msg[]>({
  name: 'Messages',
  reducer: (current, incoming) => [...current, ...incoming],   // concurrent adds append
});
const ModelRef = defineComponent<string>({ name: 'ModelRef' });

// A tag: a value-less marker component.
const MessageWaiting = defineTag('MessageWaiting');

// A system: query + optional sync guard + async handler.
const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting],
  when: (e) => e.get(Messages).length > 0,     // guard: pure read, can veto this firing
  run: async (e, ctx) => {
    const model = ctx.resource<Model>(e.get(ModelRef));   // behavior looked up by name
    const result = await model.generate({ messages: e.get(Messages) });
    e.add(Messages, [result.message]);   // merged through the reducer at the barrier
    e.remove(MessageWaiting);            // consume the trigger
  },
});
```

(Condensed from the real `callLLM` in
[`packages/stdlib/src/systems.ts`](../packages/stdlib/src/systems.ts).)

Inside `run`, `e.get(Messages)` is typed `Msg[]` — non-nullable, because
`Messages` is a positive query term. `e.get(SomethingElse)` is `T | undefined`.
No manual generics anywhere.

A query can also exclude: `Not(C)` matches entities that do **not** have `C`.
The stdlib `executeTools` queries `[PendingToolCalls, Tools, Not(AwaitingHuman)]`
— adding an `AwaitingHuman` component *unmatches* it, which is how the approval
flow parks tool execution until a human answers.

Entities are created by spawning component inits onto a world:

```ts
const world = createWorld();
world.use(callLLM);                                       // register a global system
const agent = world.spawn(Messages([]), ModelRef('model:main'));
agent.add(Messages, [{ role: 'user', content: 'hi' }]);   // external mutation, applies immediately
```

Calling a component type — `Messages([])` — produces a `ComponentInit`, usable in
`world.spawn(...)`, `world.send(...)`, and agent bundles.

## The step loop

`world.run()` (and its convenience wrapper `world.send(target, ...inits)`) drives
a Pregel-style super-step loop:

1. **Candidates** — every (system, entity) pair where the query matches the
   committed state *and* the pair is dirty (see the next section).
2. **No candidates → quiescent.** The run ends. (Hitting the step limit also
   ends it, with all remaining dirt kept so a later run resumes the work.)
3. **Guards** — each candidate's `when(e, guardCtx)` runs synchronously over
   step-start state. Returning `false` vetoes the firing. Guards get a
   restricted context (`step`, read-only `world`, `resource`) — they cannot
   write.
4. **Execute** — all eligible pairs run **concurrently** (`Promise.all`). Every
   mutation a pair makes (`e.add/set/remove`, `ctx.write/spawn/despawn`) is
   buffered, not applied. All reads during the step see the **step-start
   state** — systems never observe each other's same-step writes.
5. **Barrier** — buffered writes commit in deterministic order (system
   registration order, then entity id). Reducers merge concurrent writes;
   conflicting plain writes throw (below). Spawns materialize, despawns apply
   last, a throwing system's buffer is discarded and a `SystemError` record is
   appended to its entity instead.
6. Compute dirt for the next step, record the step in the flight recorder, emit
   `step:applied`, save a snapshot if a persistence adapter is configured.
   Repeat.

Wall-clock parallel, semantically deterministic: the same inputs replay to the
same component state.

### A worked example: three steps of a ReAct agent

This is the actual choreography asserted step-by-step in
[`examples/react-agent/react-agent.test.ts`](../examples/react-agent/react-agent.test.ts).
The agent entity carries `Messages`, `ModelRef`, `Tools`, `SystemPrompt`; the
relevant systems are `callLLM` (query `[Messages, ModelRef, MessageWaiting]`),
`executeTools` (query `[PendingToolCalls, Tools, Not(AwaitingHuman)]`), and
`toolApproval` (query `[PendingToolCalls, Tools]`).

**Before step 1.** `sendMessage(world, agent, question)` externally appends a
user message to `Messages` and adds the `MessageWaiting` tag, then calls
`run()`. External mutations are dirt source 3: `callLLM` now matches and is
dirty. `executeTools`/`toolApproval` don't match — no `PendingToolCalls`.

**Step 1.** `callLLM` fires alone. The model answers with two tool calls. The
pair buffers: append to `Messages`, set `PendingToolCalls`. At the barrier both
commit. Dirt for step 2: `callLLM`'s own `Messages` append is a **self-write**
— it does *not* re-trigger itself. But `PendingToolCalls` appearing makes
`executeTools` and `toolApproval` **newly match** (dirt source 2): both are
dirty.

**Step 2.** `toolApproval`'s guard returns `false` (no tool here needs
approval) — a **veto**, recorded in the trace, and its dirt is consumed: it
will not be reconsidered until new dirt arrives. `executeTools` runs both
tools, buffers: append two `tool` messages to `Messages`, remove
`PendingToolCalls`. Commits. Dirt for step 3: the `Messages` change came from a
**foreign writer** (`executeTools`, not `callLLM`) — dirt source 1, so
`callLLM` re-fires. Removing `PendingToolCalls` merely unmatches
`executeTools`/`toolApproval` — removing a positive-term component never fires
the systems that queried it (though removal *can* create a new match for a
query with a `Not()` term on that component).

**Step 3.** `callLLM` fires with the tool results in context, streams the final
answer (token `custom` events via `ctx.emit`), appends it to `Messages`, and
removes `MessageWaiting`. Its own append is again excluded; removing
`MessageWaiting` unmatches `callLLM` itself. Nothing is dirty-and-matching →
**quiescent**, status `done`.

The flight recorder shows exactly this:

```ts
const trace = world.getTrace();
expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
  ['assistant:callLLM'],
  ['assistant:executeTools'],
  ['assistant:callLLM'],
]);
expect(trace[1]?.vetoed).toEqual([{ system: 'assistant:toolApproval', entity: agent.id }]);
```

No router decided any of this. The LLM↔tools loop *is* the dirty-tracking.

## Dirty-triggering

The subtlest and most important part of the engine. A matching (system, entity)
pair fires in step N+1 iff it is dirty. There are exactly **four dirt sources**:

1. **A queried component changed, written by someone else.** Any component in
   the system's positive query terms was added, removed, set, or
   reducer-merged on that entity during step N — by any writer other than the
   pair itself. Engine writes (like `SystemError`) and external writes count as
   foreign. Any `set`/`add` counts as a change **even if the new value is
   deep-equal** — there is no equality checking.
2. **The query newly matches.** It didn't match at the end of step N−1 and does
   at the end of step N — including matches created by removing a `Not()`-term
   component, by spawning, or by registering a new system.
3. **External mutation.** While the world was idle, code outside any system
   (an `EntityHandle`, `world.send`, `world.resume`) touched the entity's
   queried components or created a new match.
4. **`ctx.invalidate(target, system?)`.** The explicit escape hatch: manually
   mark a pair (or all systems for an entity) dirty for the next step. The
   stdlib `retry` system uses it to re-fire a failed pair after backoff.

Three rules shape how loops behave:

- **Self-write exclusion.** A pair's own writes never re-trigger it. That's
  per *pair*: if (`callLLM`, entity 1) writes to entity 2's `Messages`, that is
  foreign dirt for (`callLLM`, entity 2). Consequence: a stale trigger
  component left behind is harmless — no change, no re-fire, quiescence is
  still reached. There is no "you must consume your trigger" discipline and no
  accidental $0.10/step loop.
- **A veto consumes dirt.** When a `when` guard returns `false`, that firing's
  dirt is gone; the pair stays silent until *new* dirt arrives. Guards are
  "not this time", not "ask me every step".
- **Loops are explicit cycles.** Repetition only happens when A writes what B
  reads and B writes what A reads. `callLLM ↔ executeTools` is one such cycle.
  The reflection example is the purest form — writer and critic share one
  blackboard entity and alternate purely on authorship
  ([`examples/reflection/agent.ts`](../examples/reflection/agent.ts)):

  ```ts
  const writer = defineSystem({
    name: 'writer',
    query: [Messages, Reflecting],
    when: (e) => {
      const last = e.get(Messages).at(-1);
      return last !== undefined && authorOf(last) !== 'writer';  // fire on others' turns
    },
    run: async (e, ctx) => { /* ...append a draft to Messages... */ },
  });

  const critic = defineSystem({
    name: 'critic',
    query: [Messages, Reflecting, MaxCritiques],
    when: (e) => {
      const last = e.get(Messages).at(-1);
      return last !== undefined && authorOf(last) === 'writer';  // fire on fresh drafts
    },
    run: async (e, ctx) => {
      // ...append a critique — or, after MaxCritiques rounds:
      e.remove(Reflecting);   // both queries unmatch -> the loop ENDS by data, not by an edge
    },
  });
  ```

  `recursionLimit` (default 50 steps per run) backstops intentional cycles.

## Reducers and write conflicts

Within one step, multiple pairs may write the same component on the same entity.
What happens is decided by the component definition:

- **With a reducer**, concurrent `add`s merge deterministically in barrier order
  (system registration order, then entity id). `Messages` and `Inbox` append;
  a counter could sum. This is the LangGraph channel-reducer semantic, which is
  why fan-out/fan-in ports work unchanged.
- **Without a reducer**, two different pairs writing the same component on the
  same entity in one step is an error — the run rejects with a
  `WriteConflictError` naming the component, the entity, the step, and both
  systems. Silent last-write-wins data loss is impossible by construction:

  ```ts
  const Item = defineComponent<number>({ name: 'Item' });
  const Out = defineComponent<string>({ name: 'Out' });   // no reducer
  const a = defineSystem({ name: 'a', query: [Item], run: (e) => e.set(Out, 'a') });
  const b = defineSystem({ name: 'b', query: [Item], run: (e) => e.set(Out, 'b') });
  // both fire on the same entity in one step -> world.run() rejects with WriteConflictError
  ```

The conflict (like every barrier-staging failure: a throwing reducer, an unknown
`ctx.invalidate` system name) is detected **before anything commits**. The run
rejects with component state, dirt, the step counter, and the trace all at the
step-start boundary — re-running the world reproduces the conflict instead of
silently losing the pending work.

One sharp edge, allowed but documented: `set` on a reducer component bypasses
the reducer and replaces the accumulated value at its position in the barrier
order. `add` is the safe default; `set` means "replace".

Single-writer note: a plain component written by one pair per step is fine —
that's exactly what `PendingToolCalls` is.

## Errors are components

A throwing system doesn't crash the run. The engine discards that pair's
buffered writes entirely, appends an `ErrorRecord` to the entity's `SystemError`
component (an append-reducer builtin), and commits every sibling pair normally.
When the same pair later succeeds, the engine removes its records again.

Failure is therefore just state: the stdlib `retry` system queries
`[SystemError, RetryPolicy]`, waits out an exponential backoff, and
`ctx.invalidate`s the failing pair; a supervisor can query workers' `SystemError`
components and reassign. Unhandled errors leave the world quiescent with run
status `'error'`.

## Quiescence and run statuses

A run ends when no matching pair is dirty (or at the step limit). The status
reports *why* the world is quiet, in precedence order:

| status | meaning |
|---|---|
| `error` | ≥ 1 entity has non-empty `SystemError` records |
| `pending` | ≥ 1 entity has `AwaitingHuman` interrupt records |
| `done` | quiescent, clean |
| `idle` | the run scheduled zero steps (nothing was dirty at all) |
| `limit` | the per-run step cap hit; remaining dirt is intact and a later `run()` resumes it |

`pending` is the human-in-the-loop mechanism, and it needs no engine machinery:
a system that wants human input writes an `AwaitingHuman` component and adds no
further trigger — the world goes quiescent naturally. The caller inspects
`world.pending()`, shows the payload, and later answers:

```ts
const [first] = world.pending();          // [{ entity, interrupts: [{ id, kind, payload }] }]
const run = world.resume(first.entity, true);   // removes AwaitingHuman, sets HumanResponse, runs
```

Because a pending world is at rest, the pause survives snapshots and process
death — [`examples/human-in-the-loop`](../examples/human-in-the-loop/) exits the
process at `pending` and resumes in a brand-new one.

## Agents and auto-tag scoping

`defineAgent({ name, components, systems })` packages an agent as a named,
spawnable bundle:

```ts
export const reflection: AgentDef = defineAgent({
  name: 'reflection',
  components: [Messages([]), Reflecting(), MaxCritiques(2)],
  systems: [writer, critic],
});

const board = world.spawn(reflection, MaxCritiques(1));  // spawn-time inits override the bundle
```

Spawning does two things:

- adds a hidden-by-convention **auto-tag** component named `agent:reflection`
  (a real component — it appears in queries and snapshots), and
- registers the declared systems (idempotently, keyed `reflection:writer`,
  `reflection:critic`) with each query **automatically narrowed by the tag**.

So an agent's systems only ever run on that agent's instances — two agents can
share component shapes (every chat agent uses `Messages`) without crosstalk —
yet underneath it's plain tags + queries, no new engine concept. Systems
registered via `world.use(system)` are **global** (no narrowing): that's how
cross-cutting concerns work — a supervisor watching all workers, a token-budget
guard, a trace logger.

Spawned values are deep-copied, so entities spawned from the same `AgentDef`
never share object identity with the template or each other.

## Data-only components, named registries — resume on any process

The strictest rule in the system: **components hold only serializable data**
(JSON / structured-clone). Anything with functions — model clients, tool
implementations, DB connections — registers on the world as a **named
resource**, and components reference behavior by name:

```ts
world.register('model:main', fromAiSdk(openai('gpt-4o-mini')));
world.register('tool:get_weather', weatherTool);

agent.add(ModelRef, 'model:main');   // data: a string
agent.add(Tools, ['get_weather']);   // data: strings
```

Why so strict: `world.snapshot()` is then *always* plain JSON — entities, the
step counter, the entity-id counter, and the pending dirt (`pendingPairs`).
Any process with the code can rebuild the world shell, re-register resources
under the same names, load the snapshot, and continue **identically** from the
boundary. This is the actual resume path from
[`examples/human-in-the-loop/main.ts`](../examples/human-in-the-loop/main.ts):

```ts
// A brand-new process, after the original died at 'pending':
const world = buildWorld();      // createWorld + register model + registerTools — same recipe
world.use(recordsAgent);         // register the agent's systems BEFORE load
world.load(snapshot);            // entities, step counter, pending dirt — the lot
world.resume(entity, approved);  // continue as if nothing happened
```

`load()` validates first — every component name must resolve in the global
registry (import the modules that define them) and every `pendingPairs` system
must be registered — and throws listing anything missing. Persistence adapters
(`MemoryAdapter` in core, `fsAdapter` in `@langecs/persist-fs`) receive a
snapshot at every step boundary; `MemoryAdapter.loadStep(id, n)` makes rewind
and fork-from-step-N one `load()` away
([`examples/time-travel`](../examples/time-travel/)).

Escape hatches, not the norm: per-component `serialize`/`deserialize` hooks for
exotic values, and `transient: true` components that are dropped from snapshots
and rebuilt by systems.

## Read isolation: treat `get()` values as immutable

`get()` — on any view or handle — returns the committed value **by reference**,
and you must treat it as immutable. Only mutations recorded through the API
(`add`, `set`, `remove`, `ctx.write`) are buffered, dirty-tracked, and
conflict-checked. Mutating a returned value in place is undefined behavior: it
is not detected, generates no dirt and no conflict, and may be observed by other
pairs mid-step.

```ts
const messages = e.get(Messages);
messages.push(reply);              // WRONG: invisible to the engine, may corrupt isolation
e.add(Messages, [reply]);          // RIGHT: buffered, reducer-merged, generates dirt
```

The same applies outside systems: build a new value and `set` it rather than
editing the result of `handle.get(C)`.

## Further reading

- [getting-started.md](./getting-started.md) — the runnable walkthrough.
- The guides — each concept above, applied:
  [errors and retries](./guides/errors-and-retries.md),
  [cancellation and timeouts](./guides/cancellation-and-timeouts.md),
  [human-in-the-loop](./guides/human-in-the-loop.md),
  [multi-agent patterns](./guides/multi-agent.md),
  [persistence and time travel](./guides/persistence-and-time-travel.md),
  [schema evolution and resume safety](./guides/schema-evolution-and-resume-safety.md),
  [streaming and observability](./guides/streaming-and-observability.md).
- [langgraph-comparison.md](./langgraph-comparison.md) — for LangGraph.js
  developers; honest divergence list.
- [prior-art.md](./prior-art.md) — the survey of adjacent work.
- [SPEC.md](../SPEC.md) — the numbered engineering contract (R1–R44) this page
  paraphrases; where they disagree, the spec wins.
- [DESIGN.md](../DESIGN.md) — why each of these decisions was made.
