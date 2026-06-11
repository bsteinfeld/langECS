# Human-in-the-loop

LangECS has **no engine machinery for pausing**. There is no `interrupt()` call that
freezes a stack frame, no resume token, no node re-execution. A system that needs human
input writes an `AwaitingHuman` component and simply doesn't write anything that would
wake another system. The world goes quiescent on its own — and *quiescence is the
pause*.

This guide walks the convention end to end, then mirrors the
[human-in-the-loop example](../../examples/human-in-the-loop/README.md): a tool-approval
flow that survives killing the process mid-conversation.

## Quiescence is the pause

A run ends when no (system, entity) pair has work. The result's `status` tells you
*why* the world stopped ([SPEC](../../SPEC.md) R28):

| status | Meaning |
|---|---|
| `'done'` | Quiescent, nothing pending — a finished turn |
| `'pending'` | Quiescent, but ≥1 entity has `AwaitingHuman` records — paused for a human |
| `'error'` | Quiescent with ≥1 non-empty `SystemError` — see [Errors and retries](./errors-and-retries.md) |
| `'idle'` | The run scheduled zero steps (nothing was dirty) |
| `'limit'` | Step limit hit; remaining work stays pending for a later `run()` |

Because a pause is just a quiescent world with a particular component on it, it costs
nothing, nests in any flow, and — since quiescent worlds are plain JSON snapshots —
**survives process death for free**.

## The components

Core ships three pieces (in [`builtins.ts`](../../packages/core/src/builtins.ts)); the
engine itself only looks at them to compute the run status:

```ts
/** One pending human-in-the-loop interrupt (R10). */
export interface InterruptRecord {
  id: string;
  kind: string;
  payload?: unknown;
}

// AwaitingHuman: InterruptRecord[] with an append reducer — non-empty => status 'pending'
// HumanResponse: { value: unknown }, plain — set by world.resume(...)
// interrupt(kind, payload?, id?): helper producing an AwaitingHuman init with one record
```

Raising an interrupt from inside a system:

```ts
import { AwaitingHuman, interrupt } from '@langecs/core';

run: (e, ctx) => {
  e.add(AwaitingHuman, interrupt('tool-approval', { calls }).value);
}
```

That's it. Don't write any other trigger component, and the world settles into
`'pending'`.

## Checking and resuming

```ts
const result = await sendMessage(world, agent, text); // stdlib: Messages append + MessageWaiting + run
if (result.status === 'pending') {
  const [{ entity, interrupts }] = world.pending(); // committed state, detached copies
  // ...show interrupts[0].payload to a human, however you like...
  await world.resume(entity, answer); // drives the world back to quiescence
}
```

`world.resume(target, value)` does exactly three things (R33):

1. removes `AwaitingHuman` entirely,
2. sets `HumanResponse({ value })`,
3. runs to quiescence (it returns a `Run` — awaitable and streamable like any other).

The convention completing the loop: **a system that acts on the answer consumes it**
with `remove(HumanResponse)`. Ask in one system, handle in another — that's the trade
versus a mid-function `interrupt()`, and it's deliberate
(see [the LangGraph comparison](../langgraph-comparison.md) for the honest cost/benefit).

## The stdlib approval flow, step by step

You rarely write the dance by hand for tools. Declare the policy on the tool:

```ts
const deleteRecord = defineTool({
  name: 'delete_record',
  description: 'Permanently delete a record by numeric id. This cannot be undone.',
  parameters: { /* JSON Schema */ },
  // The entire approval policy. The stdlib `toolApproval` system turns this
  // into an AwaitingHuman interrupt before `executeTools` ever runs.
  needsApproval: true,
  execute: (args) => {
    const { id } = args as { id: number };
    return `Record ${id} permanently deleted.`;
  },
});
```

Three stdlib systems choreograph the rest
([`systems.ts`](../../packages/stdlib/src/systems.ts)):

- **`callLLM`** answers with tool calls → sets `PendingToolCalls`.
- **`toolApproval`** — query `[PendingToolCalls, Tools]`, guard "some call needs
  approval and no decision exists yet" — appends a `tool-approval` interrupt to
  `AwaitingHuman`.
- **`executeTools`** — query `[PendingToolCalls, Tools, Not(AwaitingHuman)]` — is
  *unmatched* the moment `AwaitingHuman` lands (the `Not()` term), so the dangerous
  call cannot execute while the question is open.

The deterministic test asserts the exact step shape from the flight recorder:

```ts
// step 1: callLLM answers with a tool call
// step 2: toolApproval fires and writes AwaitingHuman; executeTools is
//         VETOED by its `when` guard (parked, dirt consumed)
expect(traceA.map((s) => s.runs.map((r) => r.system))).toEqual([
  ['records-bot:callLLM'],
  ['records-bot:toolApproval'],
]);
expect(traceA[1]?.vetoed).toEqual([{ system: 'records-bot:executeTools', entity: a.agent.id }]);
```

On `world.resume(entity, decision)`: removing `AwaitingHuman` re-matches
`executeTools`, `HumanResponse` satisfies its guard, and the flow finishes:

```ts
// Steps continue from the restored counter: 3 then 4.
expect(traceB.map((s) => [s.step, s.runs.map((r) => r.system)])).toEqual([
  [3, ['records-bot:executeTools']],
  [4, ['records-bot:callLLM']],
]);
```

`executeTools` interprets the resume value as the decision — `true` approves;
`{ approved: false, reason?: string }` denies. A denial never runs the tool; it becomes
an ordinary `tool` message ("…was denied by the human reviewer: production data") that
the model sees on its next turn and reacts to. Both branches end with `HumanResponse`
consumed and the conversation `'done'`.

## Kill-and-resume across processes

Because the pause is just component state, resuming in a *different process* is the
same code as resuming in the same one — plus a snapshot load. The example's two phases
share one world-building recipe:

```ts
import { createWorld, type World } from '@langecs/core';
import { fsAdapter } from '@langecs/persist-fs';
import { registerTools } from '@langecs/stdlib';

/** Fresh world shell: same recipe in both processes; only the snapshot differs. */
function buildWorld(): World {
  const world = createWorld({ id: WORLD_ID, persistence: fsAdapter({ dir: DATA_DIR }) });
  world.register(MODEL_RESOURCE, fromAiSdk(openai(MODEL)));
  registerTools(world, recordTools());
  return world;
}
```

**Phase 1** runs until `'pending'` and exits. No explicit save call — the `persist-fs`
adapter already wrote every step boundary to disk:

```ts
const world = buildWorld();
const agent = world.spawn(recordsAgent);
const result = await sendMessage(world, agent, 'Look up record 42, then delete it.');

if (result.status === 'pending') {
  // AwaitingHuman is on disk inside the latest snapshot. Just leave.
  process.exit(0); // the kill. Nothing survives but the snapshot files.
}
```

**Phase 2** is a brand-new process. Rebuild the shell, register systems *before*
loading, load, ask the human, resume:

```ts
const adapter = fsAdapter({ dir: DATA_DIR });
const snapshot = await adapter.load(WORLD_ID);

const world = buildWorld();
world.use(recordsAgent); // register the agent's systems BEFORE load (R19)
world.load(snapshot);    // entities, step counter, pending dirt — the lot (R36)

const [first] = world.pending();
// ...y/n on stdin...
const run = world.resume(
  first.entity,
  approved ? true : { approved: false, reason: 'denied at the terminal' },
);
await run;
```

The ordering matters: `world.use(agentDef)` registers the agent's scoped systems
*without spawning*, which `load()` requires to resolve the snapshot's components and
pending pairs — it throws, listing exactly what's missing, otherwise. Resources
(model clients, tool implementations) are never snapshotted; `buildWorld()` re-registers
them by name. Details in
[Persistence and time travel](./persistence-and-time-travel.md).

The deterministic test
([`human-in-the-loop.test.ts`](../../examples/human-in-the-loop/human-in-the-loop.test.ts))
simulates the restart with two world instances sharing nothing but a tmp directory, and
asserts the dangerous tool executed exactly once — in process B, after approval — and
never on the denial path.

## Writing your own interrupt

Any system can pause the world; nothing about the convention is tool-specific. The
ask/handle pair in its smallest form (adapted from core's tests):

```ts
import { AwaitingHuman, HumanResponse, interrupt } from '@langecs/core';

const ask = defineSystem({
  name: 'ask',
  query: [Draft, Not(AwaitingHuman)],
  when: (e) => !e.has(HumanResponse),
  run: (e) => {
    e.add(AwaitingHuman, interrupt('review', { draft: e.get(Draft) }).value);
  },
});

const handle = defineSystem({
  name: 'handle',
  query: [Draft, HumanResponse],
  run: (e) => {
    const { value } = e.get(HumanResponse);
    // ...act on the answer...
    e.remove(HumanResponse); // consume it (R33 convention)
  },
});
```

Guard the ask-system so it doesn't re-raise while a response is in flight (the stdlib's
`toolApproval` checks both `!e.has(AwaitingHuman)` and `!e.has(HumanResponse)`), and
always consume `HumanResponse` in the handler. Interrupt `id`s minted by `interrupt()`
stay unique across snapshot/load process boundaries; pass your own stable `id` if you
key approvals externally.

## See also

- [examples/human-in-the-loop](../../examples/human-in-the-loop/README.md) — the
  runnable kill-and-resume demo and its side-by-side LangGraph comparison
- [Persistence and time travel](./persistence-and-time-travel.md) — snapshot anatomy,
  adapters, the use-before-load rule
- [Streaming and observability](./streaming-and-observability.md) — watching a resume
  run live
- [LangECS for LangGraph.js developers](../langgraph-comparison.md) — how this maps to
  `interrupt()` / `Command({ resume })`
