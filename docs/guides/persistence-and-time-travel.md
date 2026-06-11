# Persistence and time travel

A LangECS world serializes to plain JSON, checkpoints itself at every step boundary,
and restores byte-for-byte into a fresh process — including work that was pending when
the snapshot was taken. Time travel and timeline forking fall out of the same
machinery: history is just the set of per-step snapshots an adapter kept.

This guide covers the snapshot format, the adapter contract, the restore recipe, and
the rewind-and-fork flow, mirroring the
[time-travel example](../../examples/time-travel/README.md).

## Why snapshots can be plain JSON

Components hold only serializable data ([SPEC](../../SPEC.md) R3). Anything with
functions — model clients, tool implementations, DB handles — is registered on the
world as a **named resource**, and components reference it by name:

```ts
world.register('model:main', fromAiSdk(openai('gpt-4o-mini')));
agent.add(ModelRef, 'model:main'); // the component stores the string
```

So a snapshot needs no magic: any process with the code re-registers the resources and
resumes the world. Two escape hatches exist per component — `serialize`/`deserialize`
hooks for exotic values, and `transient: true` to drop a component from snapshots
entirely (rebuilt by systems on resume).

## Snapshot anatomy

`world.snapshot()` is synchronous and always JSON-stringifiable:

```ts
export interface Snapshot {
  version: 1;
  worldId: string;
  step: number;          // the committed step counter at this boundary
  nextEntityId: number;  // ids are never reused; the fork keeps counting from here
  entities: SnapshotEntity[]; // { id, components: Record<name, unknown> }
  pendingPairs: PendingPair[]; // { entity, system, reason } — dirt at this boundary
}
```

Here is a real one — the [human-in-the-loop example](./human-in-the-loop.md) paused at
its approval interrupt (abridged):

```json
{
  "version": 1,
  "worldId": "records-world",
  "step": 2,
  "nextEntityId": 2,
  "entities": [
    {
      "id": 1,
      "components": {
        "Messages": [
          { "role": "user", "content": "Delete record 42." },
          { "role": "assistant", "content": "", "toolCalls": [
            { "id": "call-1", "name": "delete_record", "args": { "id": 42 } } ] }
        ],
        "ModelRef": "model:records",
        "Tools": ["lookup_record", "delete_record"],
        "agent:records-bot": true,
        "MessageWaiting": true,
        "PendingToolCalls": [
          { "id": "call-1", "name": "delete_record", "args": { "id": 42 } }
        ],
        "AwaitingHuman": [
          { "id": "interrupt-1-8itd99", "kind": "tool-approval",
            "payload": { "calls": [ { "id": "call-1", "name": "delete_record", "args": { "id": 42 } } ] } }
        ]
      }
    }
  ],
  "pendingPairs": []
}
```

Worth noticing:

- **Everything is component data** — the conversation, the pending tool calls, the
  interrupt, even the agent's `agent:records-bot` auto-tag. There is no separate
  "interrupt store" or "thread state".
- **`pendingPairs` is the dirt.** At a quiescent boundary (like this one) it's empty.
  But snapshots are saved at *every* step barrier, and a mid-run boundary records which
  (system, entity) pairs are still due to fire and why
  (`"reason": "new-match"`, `"changed:<component>"`, `"invalidate"`). Loading such a
  snapshot resumes the
  pending work — nothing in flight is lost. Dirt is consumed only at the barrier
  commit, so every snapshot is boundary-consistent (R26/R35): even a snapshot taken
  while a slow system is mid-execution still carries that pair in `pendingPairs`.
- **Not included:** resources (re-register them), the flight-recorder trace
  (observation, not state), and `transient` components.

## When snapshots are saved

If the world has a persistence adapter, the engine **awaits `adapter.save(snapshot)`
after every step barrier and once more at run end** (the quiescent boundary, R37).
There is no explicit checkpoint call in application code:

```ts
const world = createWorld({ id: 'records-world', persistence: fsAdapter({ dir: DATA_DIR }) });
```

The run-end save carries the same `step` as the last barrier save, so step-keyed
stores (both built-in adapters) naturally dedupe it.

## Adapters

The contract is four functions, two of them optional
([`persistence.ts`](../../packages/core/src/persistence.ts)):

```ts
export interface PersistenceAdapter {
  save(snapshot: Snapshot): void | Promise<void>;
  load(worldId: string): Promise<Snapshot | null> | Snapshot | null;
  history?(worldId: string): Promise<{ step: number; savedAt: number }[]> | { step: number; savedAt: number }[];
  loadStep?(worldId: string, step: number): Promise<Snapshot | null> | Snapshot | null;
}
```

Two implementations ship today:

- **`MemoryAdapter`** (in `@langecs/core`, zero-dep): full per-step history per
  `worldId`, `history()`/`loadStep()` implemented. The default for tests and for
  time-travel within one process.
- **`fsAdapter({ dir })`** (`@langecs/persist-fs`): one directory per `worldId`,
  `step-000042.json` per boundary plus `latest.json`, atomic writes (tmp file +
  rename) so a reader never sees a torn snapshot, `history()`/`loadStep()` from the
  directory listing. This is what makes the kill-and-resume demo work across
  processes.

Durable backends (SQLite/Postgres/Redis) and snapshot deltas are deferred by design
([DESIGN](../../DESIGN.md) §11) — full JSON snapshots first.

## Restoring: `use` before `load`

`world.load(snapshot)` needs two things to already be true, and throws (listing
exactly what's missing) otherwise:

1. **Every component name must resolve in the global registry** — i.e. the modules
   that `defineComponent`/`defineTag`/`defineAgent` them must have been imported
   (`UnknownComponentError`).
2. **Every system in `pendingPairs` must be registered** — `world.use(...)` for
   globals and agent bundles (`UnknownSystemError`).

The time-travel example wraps the whole recipe:

```ts
/**
 * Time travel: a FRESH world rewound to a saved snapshot. Order matters —
 * `world.use(agentDef)` registers the agent's scoped systems without spawning
 * (R19) so `world.load()` can resolve every component and pending pair (R36).
 */
export function forkFromSnapshot(opts: {
  id: string;
  model: Model;
  snapshot: Snapshot;
  persistence?: PersistenceAdapter;
}): World {
  const world = buildWorld(opts);   // createWorld + register model resource + registerTools
  world.use(timeTraveler);          // agent systems, registered WITHOUT spawning
  world.load(opts.snapshot);        // entities, step counter, id counter, pending dirt
  return world;
}
```

`load()` replaces the previous timeline wholesale: pre-existing entities are discarded
and the flight-recorder buffer is cleared, so the trace never mixes steps from two
histories. The restored world continues *identically* from the boundary — same step
numbers, same pending work.

## History, rewind, and fork

With `history()`/`loadStep()`, every past boundary is addressable:

```ts
const adapter = new MemoryAdapter();
const world = buildWorld({ id: WORLD_ID, model, persistence: adapter });
const agent = world.spawn(timeTraveler);

await sendMessage(world, agent, "Hi! I'm Jo.");                          // step 1
await sendMessage(world, agent, "What's the weather like in SF currently?"); // steps 2-4

adapter.history(WORLD_ID).map((h) => h.step); // [1, 2, 3, 4] — one checkpoint per barrier
```

Rewind to step 1 (right after the greeting, before the weather question ever happened)
and fork with different input:

```ts
const snapshot = adapter.loadStep(WORLD_ID, 1);
const fork = forkFromSnapshot({
  id: `${WORLD_ID}-fork`, // the fork checkpoints its own history under its own worldId
  model,
  snapshot,
  persistence: adapter,
});

fork.step; // 1 — while the original world is still at step 4

await sendMessage(fork, agent.id, 'Never mind the weather — what is my name?');
```

The deterministic test
([`time-travel.test.ts`](../../examples/time-travel/time-travel.test.ts)) pins down the
properties you should expect:

- **The rewound world is exactly the step-1 boundary.** Only the greeting exchange
  exists, no trigger components remain, and a bare `fork.run()` returns `'idle'` —
  the loaded `pendingPairs` were empty, so there is nothing to do until new input.
- **The fork diverges; the prefix is shared.** The fork's `Messages` start with the
  same two messages, then continue differently.
- **The original timeline is untouched.** Its component state, step counter, and all
  four checkpoints are intact; both histories live side by side in the adapter under
  their own `worldId`s.

Entity ids survive the rewind (the test reuses `agent.id` against the fork), because
the snapshot carries `nextEntityId` and ids are never reused within a world.

A note on world ids: the snapshot records the `worldId` it was taken under, but
adapters key storage by the *current* world's id — giving the fork its own id is what
keeps its checkpoints from overwriting the original timeline's.

## Failure boundaries

Two guarantees make persistence trustworthy under failure:

- **Barrier rejections never produce a torn snapshot.** If the barrier's staging phase
  throws (write conflict, throwing reducer, …), component state, dirt, the step
  counter, and the trace all stay at the step-start boundary, and that is the boundary
  the last save reflects. Re-running reproduces the failure instead of losing work.
  See [Errors and retries](./errors-and-retries.md).
- **`fsAdapter` writes atomically.** A crash between the step file and `latest.json`
  is tolerated: `load()` falls back to the newest step file.

## See also

- [examples/time-travel](../../examples/time-travel/README.md) — runnable rewind-and-fork
  demo against a real model
- [examples/human-in-the-loop](../../examples/human-in-the-loop/README.md) — persistence
  as the backbone of kill-and-resume
- [Human-in-the-loop](./human-in-the-loop.md) — why `'pending'` worlds are snapshots too
- [Streaming and observability](./streaming-and-observability.md) — what is *not* in a
  snapshot, and why
- [LangECS for LangGraph.js developers](../langgraph-comparison.md) — checkpointer /
  `thread_id` mapping
