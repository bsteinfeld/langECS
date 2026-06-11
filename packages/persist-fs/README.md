# @langecs/persist-fs

Filesystem [persistence adapter](../core/README.md#snapshots-and-persistence) for
LangECS worlds. Every step boundary lands on disk as a JSON snapshot, so a world
survives process death: kill it mid-conversation, start a new process, load, resume.
Node-only (uses `node:fs`); for in-memory history and time travel without disk, core's
`MemoryAdapter` has the same surface.

## `fsAdapter(options): FsAdapter`

```ts
import { createWorld } from '@langecs/core';
import { fsAdapter } from '@langecs/persist-fs';

const world = createWorld({ id: 'records-world', persistence: fsAdapter({ dir: './.world' }) });
```

`FsAdapter` is a `PersistenceAdapter` with `history`/`loadStep` guaranteed:

```ts
interface FsAdapterOptions { dir: string }   // root directory; created on first save

interface FsAdapter extends PersistenceAdapter {
  save(snapshot: Snapshot): Promise<void>;
  load(worldId: string): Promise<Snapshot | null>;                       // newest snapshot
  history(worldId: string): Promise<{ step: number; savedAt: number }[]>;
  loadStep(worldId: string, step: number): Promise<Snapshot | null>;
}
```

The engine awaits `save` after **every step barrier** and once at run end, so the disk
always reflects the latest consistent boundary — including pending work that has not
fired yet (`pendingPairs`).

## File layout

```
<dir>/
  <worldId>/
    step-000001.json    # one file per step boundary
    step-000002.json
    ...
    latest.json         # always mirrors the newest snapshot
```

All writes are **atomic** (unique tmp file in the same directory, then rename), so a
reader never observes a partially-written snapshot. If a crash lands between the two
writes and `latest.json` is missing, `load()` falls back to the newest step file.
Missing directories are tolerated everywhere (`load` → `null`, `history` → `[]`).

## Kill and resume

Condensed from the [human-in-the-loop example](../../examples/human-in-the-loop/main.ts),
which demonstrates this across two real processes — the run parks as `'pending'` on a
tool-approval interrupt, the process exits, and a fresh process finishes the
conversation:

```ts
/** Same world recipe in both processes; only the snapshot differs. */
function buildWorld(): World {
  const world = createWorld({ id: WORLD_ID, persistence: fsAdapter({ dir: DATA_DIR }) });
  world.register(MODEL_RESOURCE, fromAiSdk(openai('gpt-4o-mini')));   // resources are
  registerTools(world, recordTools());                                // never snapshotted
  return world;
}

// ── process 1 ───────────────────────────────────────────────────────────────
const world = buildWorld();
const agent = world.spawn(recordsAgent);
const result = await sendMessage(world, agent, 'Look up record 42, then delete it.');
result.status;     // 'pending' — delete_record needs approval; every boundary is on disk
process.exit(0);   // the kill. Nothing survives but the snapshot files.

// ── process 2 (brand new) ───────────────────────────────────────────────────
const adapter = fsAdapter({ dir: DATA_DIR });
const snapshot = await adapter.load(WORLD_ID);
const world2 = buildWorld();
world2.use(recordsAgent);   // register the agent's systems BEFORE load (core R19)
world2.load(snapshot!);     // entities, step counter, pending dirt — the lot (R36)

const [first] = world2.pending();   // the persisted AwaitingHuman interrupt
await world2.resume(first!.entity, true);   // approve; the tool finally executes
```

The order matters in process 2: `world.use(agentDef)` registers the agent's scoped
systems **without spawning**, which `world.load()` needs to resolve the snapshot's
components and pending pairs. Resources (models, tools) are behavior, not data — they
are never in the snapshot and must be re-registered, which `buildWorld()` does.

## History and time travel

One file per step means rewind-and-fork works straight from the directory listing
(from this package's tests):

```ts
const snap1 = await adapter.loadStep('tt', 1);   // the world as it was after step 1

const fork = createWorld({ id: 'tt-fork' });     // a FRESH world, new worldId
fork.use(echo);                                  // same system registrations
fork.load(snap1!);
fork.step;                                       // 1
await fork.send(e.id, Input(['z']));             // diverge from there

// The original timeline — in memory and on disk — is untouched:
(await adapter.load('tt'))?.step;                // still 2
```

Give the fork its own `persistence: adapter` and it checkpoints its own history under
its own worldId, side by side with the original. The
[time-travel example](../../examples/time-travel/main.ts) runs this end to end (with
core's `MemoryAdapter`; the adapters are interchangeable).

## See also

- [@langecs/core](../core/README.md) — `Snapshot` format, `PersistenceAdapter`
  contract, `MemoryAdapter`
- [human-in-the-loop example](../../examples/human-in-the-loop/README.md) — the full
  two-process demo
- [time-travel example](../../examples/time-travel/README.md) — rewind and fork
