# Cancellation and timeouts

*How to stop work that is already in flight, and how to stop work that will never
finish on its own. Requirements: R49 (`ModelRequest.signal`), R50
(`world.cancel` + `Cancelled`), R51 (`ctx.signal`), R52 (`timeoutMs`), R53
(`runningPairs`).*

The step barrier already gives you a clean stopping point *between* steps: a run
drives to quiescence, and nothing is half-applied. What it does not give you is a
way to stop *inside* a step. A single 60-second model call used to be
uninterruptible by construction — no user cancellation, no budget cap, no
timeout, no test that could assert teardown.

Two mechanisms close that gap, and they are deliberately different:

| | `world.cancel()` | `timeoutMs` |
|---|---|---|
| Who decides | an operator, from outside | the engine, from a deadline |
| Scope | the whole world | one (system, entity) pair |
| Records `SystemError` | **no** | **yes** |
| Result status | `'cancelled'` | `'error'` |
| Meant to be healed | no — it was deliberate | yes — `retry` re-arms it |
| Stops the barrier waiting | only via `timeoutMs` | yes, always |

## Cancellation is state, not a flag

```ts
const run = world.run();
world.cancel('user hit stop');
const result = await run;      // status: 'cancelled'
```

`cancel` does two things: it aborts every in-flight pair's `ctx.signal`, and it
stamps the builtin `Cancelled({ step, reason })` component on **every** entity.
That second half is the design. Cancellation is not an engine flag — it is
component data, exactly like `SystemError` (failure) and `AwaitingHuman`
(waiting). Three consequences fall out for free:

```ts
world.entity(id)?.get(Cancelled)   // { step: 4, reason: 'user hit stop' }
```

- **It survives snapshot/load.** A cancelled world reloads cancelled. No extra
  field on the envelope, no migration, nothing to remember to persist.
- **It is queryable.** `world.query(Cancelled)` is just a query, and the devtools
  inspector shows it like any other component.
- **You un-cancel it by removing it.** There is no `world.uncancel()`, because
  there is no hidden state to reset:

  ```ts
  for (const e of world.query(Cancelled)) e.remove(Cancelled);
  await world.run();          // the systems match again
  ```

`cancel` is the one external mutation that is legal while a run is in flight
(R16 forbids the rest). It is still barrier-safe: mid-run the stamp is applied as
an *engine write at the next step boundary*, so the trace and every snapshot stay
boundary-consistent. That boundary commits state, so it advances the step counter
like any other commit — the pre-cancel snapshot keeps its own step, and time
travel can still recover the uncancelled world. It shows up in the flight
recorder as a step with no runs and the `Cancelled` writes in `applied`.

### The `Not(Cancelled)` convention

Cancellation is **cooperative and opt-in at the query level**. Every stdlib
system carries the guard:

```ts
export const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting, Not(Cancelled)],
  // …
})
```

Do the same in your own systems and a cancel stops them. Leave it out and they
keep matching — deliberately. The engine will not guess which of your systems are
safe to abandon; a bookkeeping system that must run even on the way down is a
legitimate design, and a `Not(Cancelled)` term forced into every query would
break it.

### Why a cancelled pair is not an error

Aborting an in-flight call makes it *throw*. If the engine recorded those throws
as `SystemError` the way it records any other failure (R31), two bad things would
follow: the run would report `'error'` instead of `'cancelled'`, so you could not
tell "I stopped this" from "it broke"; and the stdlib `retry` system — which
exists to heal `SystemError` — would cheerfully re-arm the very work you just
cancelled.

So a pair that failed *because* the world was cancelled discards its buffer and
records **nothing**, and `'cancelled'` outranks `'error'` in R28's precedence.
A timeout is the opposite case and does record, precisely because a timeout is
something you usually want retried.

## Cancellation is cooperative — that is not a hedge

Aborting a signal cannot reach inside a function that ignores it. `ctx.signal`
is handed to every system, and honouring it is the system's job:

```ts
const research = defineSystem({
  name: 'research',
  query: [Topic, Not(Notes), Not(Cancelled)],
  run: async (e, ctx) => {
    const model = ctx.resource(Researcher)
    // Forward it. This is the whole contract.
    const res = await model.generate({ messages: [...], signal: ctx.signal })

    for (const url of e.get(Topic).sources) {
      throwIfAborted(ctx.signal)          // …and check it in long loops
      await fetch(url, { signal: ctx.signal })
    }
    e.set(Notes, res.message.content)
  },
})
```

Both shipped adapters forward it for you (`@langecs/ai-sdk` → `abortSignal`,
`@langecs/langchain` → the call's `signal` option), and stdlib's `callLLM` puts
`ctx.signal` into the request, so a `reactAgent` is cancellable out of the box.
Tools get it as the second argument to `execute(args, { signal })`.

A system that ignores the signal runs to completion and its writes commit
normally. The engine stops *waiting* for it only if it has a `timeoutMs` — which
is the other half of this guide.

Core exports the small pieces this needs, all isomorphic: `throwIfAborted`,
`abortReason`, `anySignal`, and `delay(ms, signal?)` — an interruptible sleep.

## Timeouts: the escape from a hung barrier

R25 step 5 executes every eligible pair with `Promise.all`. One system that never
settles therefore hangs the barrier **forever**: no step applies, no snapshot is
written, the run neither succeeds nor fails, and `world.running` stays `true` so
external mutation throws `WorldRunningError`. There is no way out of that state.

`timeoutMs` converts it into an `ErrorRecord`, which the engine already knows how
to represent, retry and heal:

```ts
const callTool = defineSystem({
  name: 'callTool',
  query: [PendingToolCalls, Not(Cancelled)],
  timeoutMs: 30_000,                       // per system
  run: async (e, ctx) => { /* … */ },
})

const world = createWorld({ systemTimeoutMs: 60_000 })   // or a world-wide default
```

On expiry the engine aborts that pair's `ctx.signal`, records a
`SystemTimeoutError` on the entity's `SystemError`, and **stops waiting** — the
barrier commits without it. Everything else in the step commits normally.

Because a `SystemTimeoutError` is an ordinary `ErrorRecord`, the existing retry
pattern heals it with no new machinery:

```ts
world.spawn(Job({ … }), RetryPolicy({ max: 3, baseMs: 500 }))
```

### Abandoned, not trusted

The abandoned `run` may still be executing — cancellation is cooperative, so the
engine cannot actually stop it. It is instead made *inert*: its buffer is
discarded, **every subsequent buffered write is refused**, and its `ctx.emit` is
suppressed. A write that lands after the barrier can never commit at a barrier
its system was no longer part of.

That refusal is load-bearing. Without it, R31's "discard the buffer entirely"
would hold for a system that throws but not for one that hangs, and a zombie pair
could write into a step it had already been dropped from.

A pair's timeout aborts **only that pair's** signal. A slow sibling never cancels
a healthy one.

### Seeing what is stuck

`world.runningPairs()` completes the introspection surface: `systems()` tells you
what *could* run, `systemsMatching(id)` what could run for one entity, and this
tells you what *is* running, right now, and for how long.

```ts
setInterval(() => {
  for (const p of world.runningPairs()) {
    if (p.elapsedMs > 10_000) console.warn(`${p.system}#${p.entity} slow: ${p.elapsedMs | 0}ms`)
  }
}, 1_000)
```

It is safe to call mid-run, including from inside an observer. It is empty
before a run starts, and empty after one settles with one deliberate exception:
a pair the barrier abandoned (R52) stays listed, flagged `abandoned: true`,
until its body actually settles — a system hung badly enough to be abandoned is
exactly the thing this exists to show.

## Testing all of this without a network

`scriptedModel` is abort-aware, so cancellation and timeouts are deterministic in
tests (R44):

```ts
// A slow call, interruptibly: the delay rejects the moment the signal aborts.
const model = scriptedModel([{ role: 'assistant', content: 'too late' }], { delayMs: 60_000 })

const run = world.run()
world.cancel('changed my mind')
expect((await run).status).toBe('cancelled')
```

Two details make this reliable rather than lucky:

- `world.run()` executes its synchronous prefix — candidate selection, guards,
  `system:start` — **before it returns**. A system that awaits is therefore
  already parked by the time the next line of your test runs, so "cancel while in
  flight" reproduces every time without sleeping.
- An aborted `scriptedModel` call rejects **without consuming a turn**. A
  cancelled step cannot silently eat the reply the next step's assertions expect,
  so the script stays aligned.

A turn function may also return a promise, which is how you script a call that
never settles for a timeout test:

```ts
const hangs = defineSystem({
  name: 'hangs', query: [Job], timeoutMs: 10,
  run: () => new Promise<void>(() => {}),      // never settles
})
```

## See also

- [errors and retries](./errors-and-retries.md) — `SystemError`, healing, and
  the retry system a timeout feeds into
- [debugging systems](./debugging-systems.md) — reading the flight recorder,
  including the boundary entry a cancel leaves behind
- [persistence and time travel](./persistence-and-time-travel.md) — why
  `Cancelled` needs no persistence work of its own
