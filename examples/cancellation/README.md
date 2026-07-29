# cancellation — stopping work that is already in flight

```sh
pnpm -C examples cancellation           # results table (needs OPENAI_API_KEY)
pnpm -C examples cancellation --trace   # + the flight recorder
pnpm -C examples exec vitest run cancellation   # deterministic, no key, no network
```

Four research jobs start in one step. One source hangs; it is abandoned at its
per-system deadline and healed by the stdlib `retry` system. Then, while the
remaining model calls are still open, an operator stops the batch — and the work
that already finished survives.

## What it teaches

**Cancellation is a component, not an engine mode.** `world.cancel(reason)`
aborts every in-flight pair's `ctx.signal` and stamps `Cancelled({ step, reason })`
on every entity. The "stop button" is therefore a query term:

```ts
export const research = defineSystem({
  name: 'research',
  query: [Job, Not(Notes), Not(Cancelled)],   // ← the entire opt-in
  timeoutMs: 250,
  run: async (e, ctx) => {
    const result = await model.generate({ messages: [...], signal: ctx.signal })
    e.set(Notes, result.message.content)
  },
})
```

Three things fall out of that choice, and the test asserts all of them:

- **Partial results survive.** They were committed at a barrier, so they are just
  state. A cancel cannot half-apply anything.
- **It survives a snapshot.** A cancelled world reloads cancelled, with the
  reason intact, because `Cancelled` is in the snapshot like any other component.
  No envelope field, no migration.
- **Removing the component un-cancels the world.** There is no `world.uncancel()`
  because there is no hidden flag that could disagree with the state.

**Cancellation is cooperative, and the example shows both sides.** The system
forwards `ctx.signal` into `ModelRequest.signal`, so the abort reaches the HTTP
request rather than merely ending the `await`. A system that ignored the signal
would run to completion and commit normally — the engine stops *waiting* for a
pair only when that pair has a `timeoutMs`.

**A cancelled pair is deliberately not an error.** Aborting an open call makes it
throw, but the engine records no `SystemError` for it, and `'cancelled'` outranks
`'error'` in the status precedence. Both halves matter: otherwise you could not
tell "I stopped this" from "it broke", and the `retry` system — which exists to
heal `SystemError` — would restart the batch the instant you stopped it. The test
asserts the absence:

```ts
expect(result.errors).toEqual([])
for (const job of jobs) expect(world.entity(job.id)?.has(SystemError)).toBe(false)
```

**A timeout is the opposite case, and needs no new machinery.** The flaky
source's first attempt never returns. `timeoutMs: 250` abandons that pair — the
barrier commits without it — and records a `SystemTimeoutError` on the entity's
`SystemError`. Because that is an ordinary `ErrorRecord`, `RetryPolicy` plus the
stdlib `retry` system heals it exactly like any other failure, and R32 clears the
record when the retried attempt succeeds.

Without a deadline, that one pair would hang the step barrier **forever**: no
commit, no snapshot, no status, and `world.running` stuck `true` so external
mutation throws `WorldRunningError`.

**The engine already counts the attempts.** The flaky source hangs only on its
first try, and it knows which try it is on by reading its own `SystemError`:

```ts
const attempted = (e.get(SystemError) ?? []).length > 0
```

R31 appends a record per failure and R32 clears them on success, so failure
history *is* the retry counter — no bespoke attempt component.

**`runningPairs()` shows what is stuck.** The demo prints it at the moment it
presses stop, and the test asserts it:

```ts
expect(world.runningPairs().map((p) => p.system)).toEqual(['research', 'research'])
```

`systems()` tells you what could run, `systemsMatching(id)` what could run for one
entity, and `runningPairs()` what *is* running and for how long.

## Testing this deterministically

No sleeps and no flakes, because two engine details make the race reproducible:

- `world.run()` executes its synchronous prefix — candidate selection, guards,
  `system:start` — **before it returns**. A system that awaits is therefore
  already parked by the time the next line of the test runs.
- An aborted `scriptedModel` call rejects **without consuming a turn**, so a
  cancelled step cannot eat the reply the next assertion expects.

```ts
const world = buildWorld({ model: scriptedModel([reply('A'), reply('B')], { delayMs: 60_000 }) })
const run = world.run()
world.cancel('operator pressed stop')
expect((await run).status).toBe('cancelled')
```

## See also

- [docs/guides/cancellation-and-timeouts.md](../../docs/guides/cancellation-and-timeouts.md)
  — the full treatment, including the cooperative-cancellation contract for
  custom models and tools
- [order-pipeline](../order-pipeline/) — the same retry/heal pattern for a
  *throwing* system instead of a hanging one
- [research-team](../research-team/) — the other way to stop a runaway batch: a
  token-budget watchdog that quiesces the team gracefully
