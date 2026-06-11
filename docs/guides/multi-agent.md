# Multi-agent patterns

LangECS has no message bus, no agent-to-agent RPC, and no router. Agents are entities;
communication is **writing components on another entity**. The scheduler's
dirty-tracking does the rest: a write that lands on a component another system queries
wakes that system next step. In-flight messages are ordinary component data — they
appear in snapshots, in the [flight recorder](./streaming-and-observability.md), and in
time travel.

This guide covers the patterns the [supervisor](../../examples/supervisor/README.md) and
[reflection](../../examples/reflection/README.md) examples are built from. The code below
is taken from those examples and from the stdlib — everything here runs in this repo's
test suite. If LangGraph terms are your frame of reference, read
[LangECS for LangGraph.js developers](../langgraph-comparison.md) first.

## The two rules everything builds on

1. **Dirty-triggering.** A (system, entity) pair fires in step N+1 iff the system's
   query matches the entity *and* something relevant changed in step N: a queried
   component was added, removed, set, or reducer-merged, or the query newly matches
   ([SPEC](../../SPEC.md) R26).
2. **Self-write exclusion.** A pair's own writes never re-trigger it. Only *foreign*
   writes — another system, another entity's pair, or the engine — count as dirt.

Every multi-agent pattern below is just an arrangement of these two rules.

## Pattern 1: the Inbox (actor style)

Give each agent an append-reducer mailbox component. The stdlib ships one:

```ts
/** Actor-style mailbox; append reducer, so `world.send(e, Inbox([...]))` wakes the recipient. */
export const Inbox: ComponentType<InboxItem[]> = defineComponent<InboxItem[]>({
  name: 'Inbox',
  reducer: (current, incoming) => [...current, ...incoming],
});
```

Sending is writing. From outside the world:

```ts
import { Inbox } from '@langecs/stdlib';

world.send(agent, Inbox([{ from: 'user', content: 'new orders arrived' }]));
```

From inside a system, via `ctx.write` with the `'add'` op (merge through the reducer).
This is the supervisor example's worker reporting back:

```ts
const work = defineSystem({
  name: 'work',
  query: [Task, Role, ModelRef],
  run: async (e, ctx) => {
    const task = e.get(Task);
    const role = e.get(Role);
    const reply = await callModel(ctx, e.get(ModelRef), role.title, {
      system: role.prompt,
      messages: [{ role: 'user', content: task.instructions }],
    });
    // Report back: Inbox has an append reducer, so concurrent workers merge
    // deterministically at the barrier instead of conflicting (R30).
    ctx.write(task.from, Inbox, [{ from: role.title, content: reply.content }], 'add');
    e.remove(Task);
  },
});
```

Three properties make this an actor mailbox rather than just a list:

- **Appending wakes the recipient.** A value change on a queried component is dirt,
  even if the recipient's query already matched. Any system querying `Inbox` fires
  next step.
- **Concurrent senders merge.** If five workers append in the same step, the reducer
  folds all five writes in deterministic barrier order. Without a reducer that would be
  a `WriteConflictError` (see [Errors and retries](./errors-and-retries.md)).
- **Consuming is a `set`.** `e.set(Inbox, [])` replaces the value, bypassing the
  reducer — that's how the supervisor drains its inbox after aggregating.

Entity references inside components are **by id** (`task.from` above is a number), so
the whole conversation is serializable.

## Pattern 2: the blackboard

For tightly-coupled collaboration, skip mailboxes entirely: spawn one shared entity and
let multiple systems read and reduce into the *same* components. The
[reflection example](../../examples/reflection/agent.ts) is a writer↔critic loop with no
router and no edges — both systems query the same blackboard:

```ts
export const writer = defineSystem({
  name: 'writer',
  query: [Messages, Reflecting],
  when: (e) => {
    const last = e.get(Messages).at(-1);
    return last !== undefined && authorOf(last) !== 'writer';
  },
  run: async (e, ctx) => {
    const reply = await callModel(ctx, 'writer', {
      messages: e.get(Messages),
      system: WRITER_PROMPT,
    });
    e.add(Messages, [{ role: 'assistant', content: reply.content, meta: { author: 'writer' } }]);
  },
});
```

The critic mirrors it (query `[Messages, Reflecting, MaxCritiques]`, guard
`authorOf(last) === 'writer'`), and ends the loop by removing the tag:

```ts
if (delivered >= e.get(MaxCritiques)) {
  e.add(Messages, [
    { role: 'user', content: APPROVAL, meta: { author: 'critic', approved: true } },
  ]);
  e.remove(Reflecting); // <- the loop's END: both queries unmatch, world quiesces
  return;
}
```

The alternation **is** the dirty-tracking. The writer's append is self-write-excluded,
so it doesn't re-fire the writer — but it's foreign dirt for the critic, which wakes
next step. The critic's append wakes the writer. Removing `Reflecting` unmatches both
queries and the world quiesces: the loop ends by component removal, not a conditional
edge. `recursionLimit` backstops the cycle if your stop rule is wrong.

Both systems and the blackboard state ship as one spawnable unit:

```ts
export const reflection: AgentDef = defineAgent({
  name: 'reflection',
  components: [Messages([]), Reflecting(), MaxCritiques(2)],
  systems: [writer, critic],
});

// per-spawn override of the round budget:
world.spawn(reflection, MaxCritiques(1));
```

## Pattern 3: supervisor with dynamic workers

The [supervisor example](../../examples/supervisor/agents.ts) composes the first two
patterns and adds runtime spawning. One routing system fans out; the workers run in
parallel; results fan in through the supervisor's `Inbox`.

The fan-out, from the supervisor's `plan` system:

```ts
let expect = 0;
if (tasks.researcher !== undefined) {
  // The researcher is a long-lived entity; assign work to the existing one
  // (or spawn it if this world somehow lacks one).
  const target = ctx.world.query(researcher.tag)[0] ?? ctx.spawn(researcher);
  ctx.write(target, Task, { from: e.id, instructions: tasks.researcher }, 'set');
  expect += 1;
}
if (tasks.writer !== undefined) {
  // Dynamic spawning: the writer agent (components + scoped systems) joins
  // the world mid-run, with its Task already attached.
  const spawned = ctx.spawn(writer, Task({ from: e.id, instructions: tasks.writer }));
  expect += 1;
}
e.set(Dispatched, { expect });
```

Notes on the moving parts:

- **`ctx.spawn(agentDef, ...extraInits)` mints a whole agent at runtime** — components,
  the `agent:<name>` auto-tag, and its scoped systems (registered idempotently). The
  entity id is allocated eagerly, so `spawned.id` is usable immediately; the components
  materialize at the barrier (R29).
- **`agentDef.tag` is a real component** you can query. `ctx.world.query(researcher.tag)`
  finds existing researcher instances; a global system can query workers across all
  agents the same way.
- **A `Task` arriving is what wakes a worker.** The `work` system's query
  `[Task, Role, ModelRef]` newly matches — no dispatch call, no edge.

The fan-in is the `aggregate` system, which fires every time the supervisor's `Inbox`
changes and *vetoes itself* until everything has arrived:

```ts
const aggregate = defineSystem({
  name: 'aggregate',
  query: [Inbox, Dispatched, Messages, ModelRef, MessageWaiting],
  when: (e) => e.get(Inbox).length >= e.get(Dispatched).expect,
  run: async (e, ctx) => {
    // ...one model call composes the final answer from e.get(Inbox)...
    e.add(Messages, [reply]);
    e.set(Inbox, []);        // consume the findings (set bypasses the append reducer)
    e.remove(Dispatched);    // re-arms `plan` for the next request
    e.remove(MessageWaiting); // answer delivered -> quiescence
  },
});
```

A `when` veto consumes the pair's dirt, so a vetoing aggregator doesn't spin — it
sleeps until the next `Inbox` append makes the pair dirty again.

## Parallel within a step

Both workers match `[Task, Role, ModelRef]` in the same step, so they execute
**concurrently** — `Promise.all` across all eligible pairs, mutations buffered, applied
in deterministic order at the barrier. The supervisor test asserts the exact shape from
the flight recorder:

```ts
// Step 2: BOTH workers executed in the SAME step — parallel fan-out.
expect(trace[1]?.runs.map((r) => r.system).sort()).toEqual(['researcher:work', 'writer:work']);
// Fan-in: both workers appended to the supervisor's Inbox in one barrier;
// the append reducer merged them instead of conflicting.
const inboxChanges = trace[1]?.applied.filter(
  (c) => c.component === 'Inbox' && c.entity === team.supervisor.id,
);
expect(inboxChanges).toHaveLength(2);
expect(inboxChanges?.every((c) => c.kind === 'merge')).toBe(true);
```

Parallelism is wall-clock real (core test T9: two ~30 ms systems complete in under
50 ms) but semantically deterministic: within a step, every system reads the
step-start state and never observes another pair's same-step writes. The cost is a
global barrier — one slow worker holds the step for the whole world. That's a known v1
trade-off ([DESIGN](../../DESIGN.md) §3.2).

## Healing: crashed workers are just state

When a worker's `run` throws, the engine discards that pair's buffered writes and
appends a record to the entity's `SystemError` component — and `SystemError` is
queryable like anything else. The supervisor example installs a global watchdog:

```ts
export const heal = defineSystem({
  name: 'heal',
  query: [SystemError, Task], // a failed worker with an unfinished task
  run: (e, ctx) => {
    const failures = new Map<string, number>();
    for (const record of e.get(SystemError)) {
      failures.set(record.system, (failures.get(record.system) ?? 0) + 1);
    }
    for (const [system, count] of failures) {
      if (count > MAX_HEAL_ATTEMPTS) continue; // give up: run quiesces with status 'error'
      ctx.invalidate(e, system); // re-arm the failed pair for the next step
    }
  },
});

world.use(heal); // global: watches every agent's workers
```

The choreography is entirely engine-driven:

1. Worker throws → engine appends to `SystemError` (foreign dirt).
2. `heal` newly matches `[SystemError, Task]` (the task is still there — the failed
   write that would have removed it was discarded) and `ctx.invalidate`s the pair.
3. The worker re-runs. On success the engine **auto-clears** that system's
   `SystemError` records, which unmatches `heal` again.
4. If failures exceed the budget, `heal` stops invalidating and the run quiesces with
   status `'error'` — the supervisor or caller inspects `result.errors` and reassigns.

The same mechanism powers the stdlib's per-entity `retry` system; see
[Errors and retries](./errors-and-retries.md) for the full failure model.

## Choosing a pattern

| You need | Use |
|---|---|
| Loosely-coupled agents exchanging messages | `Inbox` per agent (actor) |
| Tight collaboration over shared working state | One blackboard entity, multiple systems |
| Orchestration, fan-out/fan-in, elastic workers | Supervisor + `Task` writes + `ctx.spawn` |
| Cross-cutting concerns (healing, budgets, logging) | A global `world.use(system)` querying everyone |

These compose: the supervisor example is all four at once.

## See also

- [examples/supervisor](../../examples/supervisor/README.md) — the full working port,
  with a deterministic step-by-step test
- [examples/reflection](../../examples/reflection/README.md) — the blackboard loop
- [Errors and retries](./errors-and-retries.md) — `SystemError`, retry, healing
- [Streaming and observability](./streaming-and-observability.md) — watching fan-out
  live via the event stream and trace
- [LangECS for LangGraph.js developers](../langgraph-comparison.md) — `Send` API and
  subgraph mappings
- [Prior art](../prior-art.md) — blackboards, actor mailboxes, and ECS-for-agents
  precedents this design knowingly builds on
