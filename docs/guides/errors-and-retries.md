# Errors and retries

LangECS treats a failing system the way it treats everything else: as component data.
The engine catches the throw, discards that pair's buffered writes, and appends a
record to the entity's `SystemError` component — then keeps going. Failure becomes
state you can query, retry against, snapshot, and time-travel through.

There is exactly one class of failure that is *not* state: a barrier rejection
(`WriteConflictError` and friends), which aborts the run — but even that preserves the
pending work. This guide covers both shapes.

## `SystemError`: failure as a component

When a pair's `run` throws (sync or rejected promise), the engine
([SPEC](../../SPEC.md) R31):

- **discards that pair's buffered writes entirely** — a half-finished system commits
  nothing;
- **appends an `ErrorRecord` to the entity's `SystemError`** component at the barrier;
- **commits every sibling pair normally** — one worker crashing does not poison the
  step.

A throwing `when` guard is treated exactly the same as a throwing `run`.

```ts
/** One failed (system, entity) execution, appended by the engine at the barrier. */
export interface ErrorRecord {
  system: string; // the registered key, e.g. 'researcher:work' for agent-scoped systems
  step: number;
  error: { name: string; message: string; stack?: string };
}
```

`SystemError` has an append reducer, so records accumulate across attempts — which is
what makes counting attempts trivial (below). The engine's append counts as *foreign*
dirt: systems querying `SystemError` wake up next step.

Unhandled, the failure surfaces at the end of the run. Status precedence is
`'error'` > `'pending'` > `'done'` (R28):

```ts
const result = await world.run();
if (result.status === 'error') {
  for (const { entity, records } of result.errors) {
    // detached copies — inspect freely
  }
}
```

A quiescent-with-error world is still a perfectly healthy world: snapshotted as usual,
resumable as usual, and the error records are sitting there for any system — or any
caller — to act on.

## Auto-clear on success

When pair (S, e) later **succeeds**, the engine removes S's records from e's
`SystemError` at that barrier (R32). You never manually clean up error state for a
recovered system; recovery *is* the cleanup. The removal also counts as foreign dirt,
so watchdog systems querying `SystemError` get unmatched (or re-fired for the
remaining failures) automatically.

## Retrying: `RetryPolicy` + the stdlib `retry` system

Opt an entity into retries by giving it a policy:

```ts
import { RetryPolicy, retry } from '@langecs/stdlib';

world.use(retry); // or get it bundled via the reactAgent preset
const e = world.spawn(Job('task'), RetryPolicy({ max: 3, baseMs: 20 }));
```

From the stdlib's deterministic test — a system that fails twice and then succeeds:

```ts
const flaky = defineSystem({
  name: 'flaky',
  query: [Job],
  run: (e) => {
    attempts += 1;
    if (attempts < 3) throw new Error(`boom ${attempts}`);
    e.set(Output, `processed ${e.get(Job)}`);
  },
});

const result = await world.run();
// fail, retry, fail, retry, succeed
expect(result.steps).toBe(5);
expect(result.status).toBe('done');
expect(e.has(SystemError)).toBe(false); // engine auto-clear (R32)
```

The `retry` system itself is ~20 lines and uses no private machinery
([`systems.ts`](../../packages/stdlib/src/systems.ts)): it queries
`[SystemError, RetryPolicy]`, counts records per failing system, and for each system
with `attempts ≤ max` waits `baseMs · 2^(attempts−1)` and calls
`ctx.invalidate(e, system)` to re-fire exactly the failing pair. Healthy sibling
systems on the same entity are never re-fired. Past `max` it stops invalidating — the
run quiesces with status `'error'` and the records intact for someone else to handle.

## `ctx.invalidate`: the re-fire primitive

`ctx.invalidate(target, system?)` manually marks (system, entity) — or all systems for
the entity — dirty for the next step (R24). It's the escape hatch that retry and
healing are built on, with two safety properties:

- An **unknown system name** rejects the run during barrier staging (typo ≠ silent
  no-op).
- An invalidate whose **target entity no longer exists** at the barrier is dropped and
  recorded in the trace's `droppedWrites` — phantom dirt never reaches a snapshot's
  `pendingPairs`.

## Supervisor healing

Retry-with-backoff is one policy; a supervisor watching its workers is another. Since
`SystemError` is just a component, healing is just a query — this is the
[supervisor example](../../examples/supervisor/agents.ts)'s global watchdog:

```ts
export const heal = defineSystem({
  name: 'heal',
  query: [SystemError, Task], // a failed worker whose task is still unfinished
  run: (e, ctx) => {
    const failures = new Map<string, number>();
    for (const record of e.get(SystemError)) {
      failures.set(record.system, (failures.get(record.system) ?? 0) + 1);
    }
    for (const [system, count] of failures) {
      if (count > MAX_HEAL_ATTEMPTS) continue; // give up; run ends with status 'error'
      ctx.invalidate(e, system);
    }
  },
});
```

Note the query trick: the worker's failed write (which would have removed `Task`) was
discarded with its buffer, so `Task` is still present — `[SystemError, Task]` precisely
matches "crashed with unfinished work". On a successful retry, auto-clear removes the
records and `heal` unmatches by itself. See
[Multi-agent patterns](./multi-agent.md) for the surrounding choreography.

## The other failure shape: barrier rejections

Everything above is *user code* failing, which the engine converts to state. The
barrier's **staging phase** is different: it validates everything that can throw —
write-conflict prescan, reducer evaluations, spawn-time agent-system registration,
invalidate validation — against a staging overlay *before* anything commits. If
staging throws, the **run rejects**:

```ts
const Item = defineComponent<number>({ name: 'item' });
const Out = defineComponent<string>({ name: 'out' }); // plain: no reducer
const a = defineSystem({ name: 'a', query: [Item], run: (e) => e.set(Out, 'a') });
const b = defineSystem({ name: 'b', query: [Item], run: (e) => e.set(Out, 'b') });

await world.run(); // rejects with WriteConflictError
```

`WriteConflictError` names the component, entity id, step, and the conflicting pairs
(`error.pairs`), because two different pairs wrote the same plain (reducer-less)
component on the same entity in one step (R30). Silent last-write-wins is impossible
by construction. The fix is one of:

- **give the component a reducer** — concurrent `add`s then merge in deterministic
  barrier order (this is why `Messages` and `Inbox` are reducer components), or
- **serialize the writers** — restructure so only one system owns that write.

(`set` on a reducer component replaces the accumulated value at its position in the
order — allowed and deterministic, but sharp; prefer `add`.)

### Rejection preserves the work

The critical property (R26/R30 amended): a staging rejection leaves **component state,
dirt, the step counter, and the trace all at the step-start boundary**. Nothing tears,
and nothing is lost — re-running the world *reproduces the conflict* rather than
silently dropping the pending pairs. From core's regression tests:

```ts
const err = await world.run().then(() => null, (x) => x as Error);
expect(err?.message).toBe('reducer boom');

// Zero torn state: the sibling pair's write did NOT commit, the step counter
// and trace are at the step-start boundary.
expect(e.has(Good)).toBe(false);
expect(world.step).toBe(0);

// Dirt preserved: the snapshot records the step-start boundary, and a re-run
// reproduces the failure instead of silently dropping the work.
expect(world.snapshot().pendingPairs).toEqual([
  { entity: e.id, system: 'atomSetter', reason: 'new-match' },
  { entity: e.id, system: 'atomAppender', reason: 'new-match' },
]);
```

The full list of staging rejections: `WriteConflictError`, a throwing reducer, a
duplicate agent-system key from `ctx.spawn(agentDef)`, and an unknown system name in
`ctx.invalidate`. On the observation side, a rejected run's promise rejects and its
event iterators drain buffered events then throw — no `run:end` is emitted (see
[Streaming and observability](./streaming-and-observability.md)).

## Quiesce-with-error vs. rejection, side by side

| | `status: 'error'` | Rejected run (e.g. `WriteConflictError`) |
|---|---|---|
| What failed | Your system's `run`/`when` threw | The barrier's staging phase: conflicting writes, throwing reducer, … |
| Run outcome | Settles normally; `run:end` emitted | Promise rejects; iterators throw after draining; no `run:end` |
| Committed state | Step committed; failing pair's writes discarded, siblings applied | Nothing committed; state at the step-start boundary |
| `SystemError` | Appended on the entity | Not involved |
| The pending work | Failing pair's dirt consumed; re-fire via `ctx.invalidate` (retry/heal) | All dirt preserved; a re-run replays the step and reproduces the failure |
| Who handles it | Systems (retry, heal) or the caller inspecting `result.errors` | The developer — it's a structural bug in the world, not a runtime hiccup |

## See also

- [Multi-agent patterns](./multi-agent.md) — healing in a full supervisor/worker world
- [Streaming and observability](./streaming-and-observability.md) — `system:error`
  events, rejected-run stream semantics, reading failures off the trace
- [Persistence and time travel](./persistence-and-time-travel.md) — why every snapshot
  is boundary-consistent, even around failures
- [LangECS for LangGraph.js developers](../langgraph-comparison.md) — reducer/conflict
  semantics vs. LangGraph channels
