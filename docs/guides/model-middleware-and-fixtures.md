# Model middleware, reducers, typed events, and fixtures

*The four things everyone was writing by hand. Requirements: R59 (standard
reducers), R60 (typed events), R61 (model middleware), R62 (record and replay).*

None of this is engine surface. A world that uses none of it behaves identically —
which is exactly why it can ship: middleware composes at the
resource-registration site, reducers are just functions you hand to
`defineComponent`, and a recording is a JSON file.

## Standard reducers

Reducers are how LangECS avoids silent last-write-wins (R30), so every fan-in
pattern needs one — and everyone writes the same five:

```ts
import { appendReducer, boundedAppend, dedupeByReducer, maxByReducer, mergeReducer, sumReducer } from '@langecs/core'

const Findings = defineComponent<Finding[]>({ name: 'Findings', reducer: appendReducer() })
const Spend    = defineComponent<number>({ name: 'Spend',    reducer: sumReducer() })
const Passages = defineComponent<Passage[]>({ name: 'Passages', reducer: dedupeByReducer((p) => p.id) })
const Best     = defineComponent<Extract>({ name: 'Best',    reducer: maxByReducer((e) => e.confidence) })
const Profile  = defineComponent<Profile>({ name: 'Profile', reducer: mergeReducer() })
```

Two details worth knowing:

**`boundedAppend` is the one everyone eventually needs.** An unbounded append on
a long-running world grows a component forever, and since every component lands
in every snapshot (R35), that growth is paid on **every save**. It is easy to get
wrong in a way that only shows up at hour three.

```ts
const Log = defineComponent<Entry[]>({ name: 'Log', reducer: boundedAppend(200) })
// keep: 'last' (default) drops the oldest — a running log
// keep: 'first' drops the newest — "remember how this started"
```

**Reducers must be pure.** They run in the barrier's staging phase against
committed values, which are handed out by reference and must be treated as
immutable (R17). Every reducer here returns a new value; one of your own that
mutates `current` corrupts committed state in a way the engine cannot detect.

Two smaller choices are deliberate: `maxByReducer` keeps `current` on a tie, and
`dedupeByReducer` keeps the first occurrence — so neither result depends on
barrier ordering among equals.

## Typed custom events

`ctx.emit(data: unknown)` is the engine's only channel for domain-meaningful
events (R23), and untyped it makes every consumer cast — then parse everything
just to discover whether it cares. `defineEvent` fixes that the same way
`defineResource` fixed stringly-typed resources:

```ts
const Token = defineEvent<{ text: string }>('token')
const Phase = defineEvent<{ phase: string }>('phase')

ctx.emit(Token, { text })          // payload type-checked at the call site

// observer:
if (event.type === 'custom' && event.name === 'phase') render(event.data)
```

The plain `ctx.emit(data)` form still works and leaves `name` absent, so this is
additive.

**Adding a name to an event that already has readers**: keep the payload and add
the ref. That is exactly what stdlib's streaming tokens do — `TokenEvent` carries
`name: 'token'` for new consumers while the payload keeps its `{ kind, text }`
shape, so nothing that switched on `data.kind` broke.

The ref is **branded**, not structural. A payload that merely happens to have an
`eventName` field is not mistaken for a typed emit — otherwise it would silently
swap the name and drop the payload.

## Model middleware

`Model` is deliberately tiny — `generate` plus optional `stream` (R43) — so
everyone reimplements the same six wrappers around it. `wrapModel` composes them
at registration time:

```ts
world.register(Architect,
  wrapModel(fromAiSdk(bedrock(BIG)),
    withCost(ledger),                        // outermost
    withRetry({ max: 3 }),
    withFallback(fromAiSdk(bedrock(SMALL)))))
```

**First listed is outermost**, the same convention as observer `wrapSystemRun`
(R46). Order is yours to choose, and it changes meaning: `withCost` outside
`withRetry` counts the successful call, inside it counts every attempt.

### The one ordering trap

A fallback model is invoked **directly**, not through the layers below it. So
anything listed *after* `withFallback` wraps only the primary:

```ts
// WRONG — the ledger reports nothing when the primary fails, which is exactly
// when you want to know what the fallback cost you.
wrapModel(big, withRetry({ max: 3 }), withFallback(small), withCost(ledger))

// RIGHT — observability outermost, so it sees whichever model answered.
wrapModel(big, withCost(ledger), withRetry({ max: 3 }), withFallback(small))
```

To instrument the fallback specifically, wrap it before passing it in:
`withFallback(wrapModel(small, withCost(ledger)))`.

### What each layer guarantees

| | |
|---|---|
| `withRetry({ max, baseMs?, retryOn? })` | Exponential backoff. **Never retries a cancellation**, and the backoff wait is interruptible. |
| `withTimeout(ms)` | Bounds one *call* (a system's `timeoutMs`, R52, bounds a whole pair). Aborts the inner call rather than merely un-awaiting it. |
| `withFallback(...models)` | Tries each in turn on failure. Never fails over a cancellation. |
| `withRateLimit({ minIntervalMs?, concurrency? })` | Queues rather than rejects — a quota is a pacing problem, not an error, and turning it into one would surface as `SystemError` on entities that did nothing wrong. |
| `withCost(sink)` | Reports `usage` per successful call. |
| `withCache({ store?, ttlMs?, key? })` | Keyed on a stable request hash **excluding `signal`** (including it would make every call unique). Caches successes only, so one blip cannot poison an answer permanently. |

Two rules hold across all of them:

- **Cancellation is never retried or failed over** (R49). An aborted call means
  the caller asked to stop; retrying would defeat `world.cancel()` and every
  `timeoutMs` above it.
- **`stream` is never silently dropped.** A layer that only wraps `generate`
  passes `stream` through — otherwise adding one would turn a streaming agent
  into a non-streaming one, and since stdlib's `callLLM` branches on `stream`'s
  presence, tokens would just stop appearing with no error anywhere. Conversely,
  retry and fallback apply to a stream **only before the first chunk**: after
  that, a retry duplicates delivered tokens and a failover splices two different
  answers together.

To put spend into *state* — where a watchdog can see it and R30 can merge it —
write it from a system with `sumReducer()`, not from the `withCost` sink.

## Record and replay

`scriptedModel` (R44) is why the choreography tests exist, but you write the
script **by hand**. That is fine for five turns and impractical for a realistic
multi-agent run — which is where the interesting bugs live, and the case the
engine's determinism story most wants to demonstrate.

```ts
// Record once, against the real thing:
const recorder = recordingModel(fromAiSdk(openai('gpt-4o-mini')), (r) =>
  writeFileSync('fixture.json', JSON.stringify(r, null, 2)))
world.register(MainModel, recorder)
await world.run()

// Replay forever, with no key and no network:
world.register(MainModel, replayModel(JSON.parse(readFileSync('fixture.json', 'utf8'))))
```

That turns a production incident into a regression test, makes a prompt refactor
verifiable, and lets a contributor with no API key run a realistic suite.

### Matching: hash first, ordinal fallback

This is the part that decides whether the feature is useful:

1. **Exact hash match** replays that entry. Unchanged prompts replay exactly, and
   call *order* may vary freely — which matters because concurrent pairs spawn in
   nondeterministic order (R29).
2. **Otherwise the next unconsumed entry by ordinal**, and `onMismatch` fires.

Hash matching alone would break on any prompt edit — the very refactor a fixture
exists to let you verify. Ordinal matching alone would silently align the wrong
answers when calls reorder. "Survives a prompt edit gracefully" means step 2, not
that the hash somehow still matches.

```ts
replayModel(recording, { strict: true })   // CI: fail on drift instead of guessing
```

A recording is plain JSON and diffable: provider `raw` is dropped (it is often
circular), replayed results are detached per call so a system that mutates a
returned message cannot corrupt the fixture, and `formatRecording(recording)`
renders it for review.

```
recording v1: 2 call(s)
  #0 3f1a9c22 via generate tools=[search]
    ← user: What's the weather in SF?
    → assistant: [tool search]
  #1 8b40e7d1 via generate
    ← tool: 13 °C, clear
    → assistant: It's 13 °C and clear in SF.
```

## See also

- [cancellation and timeouts](./cancellation-and-timeouts.md) — the signal every
  middleware layer has to respect
- [errors and retries](./errors-and-retries.md) — retry as *state* in the engine,
  which is a different tool from `withRetry` around one call
- [debugging systems](./debugging-systems.md) — the flight recorder a replayed
  run reproduces
