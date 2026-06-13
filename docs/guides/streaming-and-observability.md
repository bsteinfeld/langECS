# Streaming and observability

LangECS splits the world's information into two channels with opposite guarantees:

- **Durable truth lives in components.** Snapshotted, replayable, queryable.
- **Observation is an ephemeral event stream and a flight-recorder trace.** Never
  state, never snapshotted, and always *detached* — you can do anything to an event or
  a trace entry without touching committed state.

This guide covers the `Run` handle, the event union (including what happens when a run
rejects), token streaming via `ctx.emit`, and the flight recorder.

## The `Run` handle: promise + async-iterable

`world.run()`, `world.send(...)`, and `world.resume(...)` all return a `Run`
([SPEC](../../SPEC.md) R40):

```ts
export interface Run extends PromiseLike<RunResult>, AsyncIterable<RunEvent> {}
```

Await it for the result, iterate it for the events — or both, in either order:

```ts
const run = sendMessage(world, agent, question);

for await (const event of run) {
  // live progress
}
const result = await run; // { status, steps, pending, errors }
```

Iterators **replay buffered events from run start, then go live**. It does not matter
whether you start iterating before, during, or after the run — every consumer sees the
identical, complete sequence. Core's T14 test asserts a live iterator and a
started-after-completion iterator produce equal event lists.

## The event union

Every event carries `step` where meaningful
([`events.ts`](../../packages/core/src/events.ts)):

| Event | Payload | When |
|---|---|---|
| `run:start` | `runId` | once, immediately |
| `step:start` | `step`, `scheduled: {system, entity}[]` | a step begins; `scheduled` is the post-guard eligible pairs |
| `system:start` | `step`, `system`, `entity` | a pair begins executing |
| `system:end` | `step`, `system`, `entity`, `ms` | a pair finished cleanly |
| `system:error` | `step`, `system`, `entity`, `error: {name, message, stack?}` | a pair's `run` (or `when`) threw — see [Errors and retries](./errors-and-retries.md) |
| `custom` | `step`, `system`, `entity`, `data` | `ctx.emit(data)`, pushed live mid-step |
| `step:applied` | `step`, `changes: ChangeRecord[]`, `spawned`, `despawned` | the barrier committed |
| `run:end` | `status`, `steps` | the run settled normally |

`ChangeRecord` is `{ entity, component, kind: 'set' | 'merge' | 'remove', value? }` —
the same shape the trace records. Two ordering guarantees worth relying on: every
`system:error` is preceded by a `system:start` for the same pair (a throwing `when`
guard emits both, back to back), and every step that commits emits exactly one
`step:applied` after all of its system events.

A realistic consumer, from the [react-agent example](../../examples/react-agent/main.ts):

```ts
for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(`[step ${event.step}] scheduled: ${event.scheduled.map((p) => p.system).join(', ')}`);
      break;
    case 'custom': {
      const data = event.data as { kind?: string; text?: string };
      if (data.kind === 'token' && data.text !== undefined) process.stdout.write(data.text);
      break;
    }
    case 'system:end':
      console.log(`  ${event.system} done in ${event.ms.toFixed(0)}ms`);
      break;
    case 'run:end':
      console.log(`[run ${event.status} after ${event.steps} step(s)]`);
      break;
    default:
      break;
  }
}
```

## Error semantics on rejected runs

There are two very different failure shapes, and the event stream reflects it:

- **A system throwing is not a run failure.** The engine records a `SystemError`
  component, emits `system:error`, and the run continues to quiescence — settling
  *successfully* with `status: 'error'` and a final `run:end`.
- **A barrier rejection is a run failure.** `WriteConflictError`, a throwing reducer,
  and the other staging-phase rejections make the run **reject**: promise consumers
  see the rejection, and async iterators **drain all buffered events and then throw
  the same reason**. A rejected run emits **no `run:end`** (and no `step:applied` for
  the rejected step — nothing committed).

From core's regression test, the exact sequence for a two-writer conflict:

```ts
expect(thrown).toBeInstanceOf(WriteConflictError);
expect(events.map((ev) => ev.type)).toEqual([
  'run:start',
  'step:start',
  'system:start',
  'system:start',
  'system:end',
  'system:end',
  // <- iterator throws WriteConflictError here; no step:applied, no run:end
]);
```

Iterate-only consumers are therefore never left hanging on a failed run, and
promise-only consumers never miss it. See
[Errors and retries](./errors-and-retries.md) for what state looks like after each
shape.

## Token streaming with `ctx.emit`

`ctx.emit(data)` pushes a `custom` event to the live stream **immediately, mid-step**
(R23) — it does not wait for the barrier. The stdlib's `callLLM` uses it to pipe model
stream chunks out while the call is still running:

```ts
const result = model.stream
  ? await model.stream(req, (chunk) => {
      if (chunk.text !== undefined && chunk.text.length > 0) {
        ctx.emit({ kind: 'token', text: chunk.text });
      }
    })
  : await model.generate(req);

e.add(Messages, [result.message]); // the durable truth still lands at the barrier
```

That last line is the division of labor in one place: tokens are observation (gone
unless someone is listening), the final message is state (committed, snapshotted).
Emitted data is never stored and never snapshotted. The shape of `data` is yours;
`{ kind: 'token', text }` is the stdlib's convention, and the
[supervisor example](../../examples/supervisor/main.ts) extends it with
`{ kind: 'dispatch', ... }` and `{ kind: 'heal:retry', ... }` narration events.

## The flight recorder

Independent of who is listening to the stream, the world keeps a structured per-step
trace in a ring buffer (default: last 1000 steps; configure with
`createWorld({ trace: { keep: 3 } })` or disable with `trace: false`):

```ts
export interface StepTrace {
  step: number;
  scheduled: PairRef[];  // all matched+dirty candidates, BEFORE `when` guards
  vetoed: PairRef[];     // candidates a `when` guard vetoed (dirt consumed)
  runs: TraceRun[];      // { system, entity, ms, error?, writes: ChangeRecord[] }
  applied: ChangeRecord[]; // committed changes, including engine writes
  spawned: number[];
  spawnedBy?: { entity: number; system: string; parent: number }[];
  despawned: number[];
  droppedWrites?: DroppedWrite[]; // ops whose target was despawned this step
  durationMs: number;
}
```

`vetoed` is the entry that answers the most common debugging question in a reactive
scheduler — *"why didn't my system fire?"* Either the pair was never scheduled (query
didn't match, or no dirt) or it's sitting in `vetoed` (your `when` guard said no, and
that consumed the dirt).

`world.getTrace()` returns the buffer; `formatTrace(steps)` renders it. Real output
from the canonical LLM→tools→LLM cycle (the time-travel example's agent driven by a
`scriptedModel`):

```
step 1 (0.5ms)
  scheduled: time-traveler:callLLM#1
  run time-traveler:callLLM#1 0.1ms
    merge Messages on #1
    set PendingToolCalls on #1
  applied: merge Messages#1, set PendingToolCalls#1
step 2 (0.1ms)
  scheduled: time-traveler:toolApproval#1, time-traveler:executeTools#1
  vetoed:    time-traveler:toolApproval#1
  run time-traveler:executeTools#1 0.1ms
    merge Messages on #1
    remove PendingToolCalls on #1
  applied: merge Messages#1, remove PendingToolCalls#1
step 3 (0.1ms)
  scheduled: time-traveler:callLLM#1
  run time-traveler:callLLM#1 0.0ms
    merge Messages on #1
    remove MessageWaiting on #1
  applied: merge Messages#1, remove MessageWaiting#1
```

You can read the whole architecture off that block: agent-scoped system keys
(`<agent>:<system>`), the `toolApproval` veto (no tool needed approval), tool results
arriving as foreign `Messages` dirt that re-fires `callLLM`, and quiescence by
`MessageWaiting` removal. The example tests assert their choreography against exactly
this structure.

The trace is observation, not state: `world.load()` clears it (a restored world never
mixes two timelines' steps), and it is not part of snapshots.

## Why observation is ephemeral — and detached

The detachment rules (R28/R41/R42, all tested):

- `ChangeRecord.value` in events and traces is a **structured-clone copy**, never a
  live reference to committed storage. Later mutation of committed state can never
  rewrite recorded history, and mutating a trace entry never touches the world.
- `RunResult.pending` / `RunResult.errors` and `world.pending()` return detached
  copies too.

Keeping observation out of state is what keeps the durable model honest: a snapshot
plus re-registered resources is *everything* — replaying a world never depends on who
happened to be watching it. It also means events are at-most-once delivery within a
process: if nothing is iterating a `Run` and the process dies, the events are gone,
but no truth was lost — it's all in the components.

## OpenTelemetry and the visual inspector

Both observability consumers ship as packages built strictly on the observer surface
(SPEC §14: `world.observe` — a passive event tap, external-change notifications, and a
system-run middleware; observers can never alter a run's outcome, R45):

- [`@langecs/otel`](../../packages/otel) — OpenTelemetry instrumentation.
  `instrumentWorld(world)` emits `langecs.run` → `langecs.step` → `langecs.system`
  spans (system spans are *active* around your system's code, so model/tool calls nest
  under them), plus GenAI-semantic-convention `chat`/`execute_tool` spans with token
  usage via `instrumentModel`/`instrumentTool`. Depends only on `@opentelemetry/api`;
  your app owns the SDK and exporters.
- [`@langecs/devtools`](../../packages/devtools) — the visual inspector.
  `startDevtools(world)` serves a local GUI: live entity/component editing, systems
  and dirty-pair views, the flight-recorder timeline, an OTLP/HTTP trace waterfall,
  interrupt answering, and a checkpoint-history time-travel panel.

[`examples/devtools-demo`](../../examples/devtools-demo/README.md) wires both onto a
seeded world with zero API keys. If you want to build your own consumer against the
trace format or observer surface, start with [CONTRIBUTING.md](../../CONTRIBUTING.md)
for where design truth lives.

## See also

- [examples/react-agent](../../examples/react-agent/README.md) — the streaming consumer
  in a runnable demo
- [examples/supervisor](../../examples/supervisor/README.md) — custom `ctx.emit`
  narration plus `formatTrace` at the end of a real run
- [Errors and retries](./errors-and-retries.md) — `system:error`, `SystemError`, and
  barrier rejections in depth
- [Persistence and time travel](./persistence-and-time-travel.md) — the durable half of
  the split
