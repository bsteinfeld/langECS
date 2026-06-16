# Debugging reactive systems: "why didn't my system fire?"

In LangECS there are no edges to trace. A system runs when its **query matches**
an entity *and* something it cares about **changed**. When a system you expected
to run doesn't — or one you didn't expect keeps running — the answer is always
in the same two places:

1. the **flight recorder** (`world.getTrace()` + `formatTrace`), which records,
   per step, every pair that was *scheduled*, every one *vetoed* by a guard,
   what each *ran*, and what got *applied*;
2. **introspection** (`world.systems()`, `world.systemsMatching(id)`,
   `world.queryStats()`, `listComponents()`), which tells you what's registered
   and what currently matches.

This guide walks the five things that actually trip people up, each with the
trace output that reveals it and the fix. If you read one page after the
[concepts](../concepts.md), read this one — it converts "spooky action at a
distance" into "I can see exactly what happened."

> **The mental model in one sentence.** A pair `(system, entity)` fires in the
> next step iff its query matches **and** a queried component changed by *someone
> else*, or the query *newly* matches. (Full rules: SPEC.md §5, R26.)

## Reading a trace

Turn the flight recorder into text with `formatTrace(world.getTrace())`. A
healthy ReAct loop looks like this:

```
step 1 (0.4ms)
  scheduled: bot:callLLM#1
  run bot:callLLM#1 0.1ms
    merge Messages on #1
    set PendingToolCalls on #1
  applied: merge Messages#1, set PendingToolCalls#1
step 2 (0.1ms)
  scheduled: bot:toolApproval#1, bot:executeTools#1
  vetoed:    bot:toolApproval#1
  run bot:executeTools#1 0.1ms
    merge Messages on #1
    remove PendingToolCalls on #1
  applied: merge Messages#1, remove PendingToolCalls#1
step 3 (0.1ms)
  scheduled: bot:callLLM#1
  run bot:callLLM#1 0.0ms
    merge Messages on #1
    remove MessageWaiting on #1
  applied: merge Messages#1, remove MessageWaiting#1
```

How to read each step:

- **`scheduled:`** — the pairs whose query matched *and* were dirty this step
  (`system:entity#id`). If your system isn't here, its query didn't match or it
  had no fresh dirt — see scenarios 1, 4, 5.
- **`vetoed:`** — scheduled pairs whose `when` guard returned `false`. They were
  eligible but chose not to run, and their dirt was consumed — scenario 2.
- **`run …`** — pairs that executed, with the writes each buffered.
- **`applied:`** — what actually committed at the barrier (after reducers,
  conflict checks, and despawns).

Notice step 3 calls `callLLM` again even though `callLLM` wrote `Messages` in
step 1: the *tool result* appended by `executeTools` in step 2 is a **foreign**
change to `Messages`, which re-triggers `callLLM`. That foreign-vs-self
distinction is the whole engine. Read on.

---

## 1. "It matches, but it never fires" — there's no dirt

The single most common surprise: a system's query matches an entity, but the
system never runs, because **matching is not enough**. A pair only fires on a
*change* to a queried component (by another writer) or a *new* match.

```ts
const Counter = defineComponent<number>({ name: 'counter' });
const report = defineSystem({
  name: 'report',
  query: [Counter],
  run: (e) => console.log('count is', e.get(Counter)),
});
const world = createWorld();
world.use(report);
const e = world.spawn(Counter(0));
await world.run();        // report fires once — the spawn is a NEW match
await world.run();        // nothing happens: Counter didn't change, no new match
```

The second `run()` returns status `'idle'` (zero steps scheduled). That's not a
bug — it's the design that makes quiescence reliable and stops runaway
$0.10/step loops. **A system runs in response to change, not on a clock.**

**Confirm it:** `world.systemsMatching(e.id)` returns `['report']` (it *does*
match), but the trace for the second run is empty and `world.queryStats()` shows
`runCount: 1`. Matches, but nothing made it dirty.

**Fix:** make the trigger explicit. Cause a change to a queried component
(`e.set(Counter, 1)` from outside, or have another system write it), or force a
re-fire with `ctx.invalidate(e, 'report')`. If you want "run again on new input,"
the input *is* the change — e.g. `sendMessage` appends to `Messages`, which is
foreign dirt for `callLLM`.

---

## 2. "It was scheduled but skipped" — a `when` guard vetoed it

If a pair appears under `vetoed:` but not `run`, its `when` guard returned
`false`. Guards are how you express "matches, but not *yet*."

```ts
const review = defineSystem({
  name: 'review',
  query: [Draft, Reviewing],
  when: (e) => e.get(Draft).length >= 10,   // only review substantial drafts
  run: (e) => e.remove(Reviewing),
});
world.spawn(Draft('too short'), Reviewing());
await world.run();
```

```
step 1 (0.0ms)
  scheduled: review#1
  vetoed:    review#1
```

The pair was scheduled (matched + dirty) and then vetoed. The run quiesces with
nothing applied. `world.systemsMatching(1)` still returns `['review']` — it
matches; the guard just said "not now."

**The dirt-consumption catch:** a veto **consumes** the dirt. The pair will *not*
re-evaluate the guard until *new* dirt arrives. So if you're waiting for a guard
to flip from `false` to `true`, something must write a queried component again to
re-schedule it. (This is exactly how the supervisor's `aggregate` works: each
worker result is a fresh `Inbox` change that re-schedules the guard until enough
results are in.)

**Fix:** if the guard depends on a value that changes *without* a write to a
queried component, add the thing it depends on to the query, or `ctx.invalidate`
when the external condition changes.

---

## 3. "My system calls itself forever" — or expectedly doesn't

A system that writes a component in its *own* query does **not** re-trigger
itself (self-write exclusion). This is why `callLLM` appending to `Messages`
doesn't loop:

```
step 1: run bot:callLLM#1 → merge Messages#1   (self-write: no re-trigger)
```

Step 1 does not schedule `callLLM` again from its own `Messages` append. It only
re-fires in step 3 because *`executeTools`* (a different pair) wrote `Messages`.

So if you *want* a loop, you need two systems writing each other's queried
components — A writes what B reads, B writes what A reads (writer↔critic,
callLLM↔executeTools). If you have an *unwanted* loop, the trace shows it
immediately: the same pair re-firing every step. Look at which **foreign** write
keeps re-triggering it in the `applied:` lines, and either stop writing that
component or narrow the query. `recursionLimit` (default 50) backstops genuine
runaways — a run that hits it returns status `'limit'` with the pending work
intact.

---

## 4. "A `Not()` term is quietly excluding it"

A negative query term (`Not(C)`) means "match only entities *without* `C`." It's
easy to leave one satisfied and wonder why nothing fires.

```ts
const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, MessageWaiting],
  // executeTools additionally has Not(AwaitingHuman):
});
```

In the ReAct systems, `executeTools` carries `Not(AwaitingHuman)`. When a tool
needs approval, `toolApproval` writes `AwaitingHuman` — which *un-matches*
`executeTools` entirely. It vanishes from `scheduled:` and the world goes
`'pending'`. That's intended (the approval gate), but the same mechanism bites
when a leftover component silently excludes a system.

**Confirm it:** `world.systems()` prints each system's *effective* query split
into `include` / `exclude`:

```json
{ "key": "bot:executeTools",
  "query": { "include": ["agent:bot", "PendingToolCalls", "Tools"],
             "exclude": ["AwaitingHuman"] }, "hasGuard": true }
```

Then check the entity's components (`world.entity(id)?.components()`): if it has
a component listed under `exclude`, that's your answer.

**Fix:** remove the excluding component when the gate should open (`world.resume`
removes `AwaitingHuman`), or drop the `Not()` term if the exclusion was
accidental.

---

## 5. "The system isn't registered (agent-scope confusion)"

If a system is missing from `world.systems()` entirely, it was never registered,
or it's scoped to an agent you didn't spawn. `defineAgent` registers its systems
under `<agentName>:<systemName>` with the query auto-narrowed by a hidden
`agent:<name>` tag — so an agent's systems only run on *its own* instances:

```json
{ "key": "bot:callLLM", "name": "callLLM", "agent": "bot",
  "query": { "include": ["agent:bot", "Messages", "ModelRef", "MessageWaiting"], ... } }
```

Two gotchas this catches:

- You wrote `defineSystem(...)` but never `world.use(it)` (for a global system)
  or never spawned the agent that owns it. `world.systems()` won't list it.
- You expected a global system to run on an agent's entity but it's actually
  agent-scoped (or vice-versa). The `agent` field and the `agent:<name>` tag in
  `include` tell you which.

**Fix:** register global cross-cutting systems with `world.use(system)`; bundle
per-agent systems in `defineAgent({ systems: [...] })`. Loading a snapshot?
`world.use(agentDef)` registers the scoped systems *without* spawning, which you
need before `world.load()` of a snapshot referencing them.

---

## Your debugging checklist

When a system misbehaves, in order:

1. **`formatTrace(world.getTrace())`** — is the pair in `scheduled:`? in
   `vetoed:`? in `run`? The section it's in points straight at the cause above.
2. **`world.systemsMatching(entityId)`** — does it even match this entity right
   now? If no → wrong components (scenario 4/5). If yes but absent from the
   trace → no dirt (scenario 1) or a guard veto (scenario 2).
3. **`world.systems()`** — is it registered, with the query and scoping you
   expect (scenario 5)? Check `include`/`exclude`.
4. **`world.queryStats()`** — `runCount`/`errorCount`/`lastStepFired` per system:
   which systems are hot, which never fire, which are throwing.
5. **`world.entity(id)?.components()`** — what does the entity actually hold? A
   missing positive term or a present `Not()` term explains most non-matches.

Everything above is **read-only and free of side effects** — safe to sprinkle
through tests and request handlers. The same data feeds the
[`@langecs/devtools`](../../packages/devtools) inspector, where you can watch it
live and step through history instead of reading text. For the precise firing
rules behind all of this, see SPEC.md §5 (R25–R32); for the design rationale,
[DESIGN.md §3](../../DESIGN.md).
