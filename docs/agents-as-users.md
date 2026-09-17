# Agents as the users of LangECS

*Written 2026-09-17, after the 0.2.0 release. A design record: the observation that
prompted it, the two hypotheses it separates, what shipped to test them, what is verified
today and what is only proposed. Read it with [experiment-verdict.md](experiment-verdict.md)
(the human-authored ports) beside it.*

## The observation

> LangECS seems amazing for agents to use, but humans struggle to understand the concepts.
> ECS works when there is a lot going on; humans read drawn edges better. Give agents the
> ability to play in the space — perhaps author their own systems on the fly — and become
> less a LangGraph replacement, more a tool for the agents themselves. It is all just data,
> traceable and auditable. Tell me if I'm wrong.

Partly right, and the part that is wrong matters.

**Right, in this narrower form:** the verdict on the six ports found the LangECS *wins* to
be runtime properties — deterministic super-steps, plain-component double writes that throw
instead of losing data, failure as queryable state, a checkpoint at every step, a flight
recorder that records which pairs ran and which were vetoed — and most of the *losses* to
be read-time legibility or ecosystem maturity (not all: stage enforcement and general
`interrupt()` are semantic losses). A controller with `systemsMatching`, `pendingPairs` and
the trace has cheaper answers to "why didn't it fire?" than a graph diagram gives, and the
public API confines it to specific mechanisms: mutation is idle-only (R16), in-system
writes are buffered (R17), concurrent plain writes reject rather than merge (R30), and
every committed step is checkpointed (R37). That is not "cannot corrupt": an idle edit can
store an invalid value, a `set` replaces what a reducer accumulated, and an application's
own control marker is just another component unless the host protects it — which is why
the playground validates edits against declared schemas and gates native targets.

**Wrong, or at least under-specified:**

1. **"Agents author their own systems on the fly."** A system is code (`SystemDef.run`
   is a function); a component is data (R3). That line is what makes a snapshot plain JSON
   and a world auditable. An agent emitting JavaScript for the engine to run erases it.
   The resolution shipped here is to make agent-authored behavior *data too* — a prompt
   system is a JSON declaration whose `run` is a model call — with the rails described
   below. It is the roadmap's deferred "declarative agent format" with a different author.
2. **"The verdict shows agents are the natural users."** It does not. It tested humans
   porting LangGraph examples, never an agent authoring, debugging or repairing a world;
   some of its losses (stage enforcement, general mid-node `interrupt()`, interactive
   time travel) are not legibility at all. "Agents don't need edges" also confuses input
   modality with reasoning difficulty: an LLM still has to reconstruct eligibility, dirt,
   guards and barrier order. Introspection lowers that cost — for a human too.
3. **"It's all just data, so it's safe."** Deterministic scheduling is not deterministic
   decisions; snapshots omit resources and behavior; time travel does not undo external
   effects (SPEC R57 disclaims exactly-once) and does not uninstall systems (R36 replaces
   entities, not registrations). Writing `PendingToolCalls` is not harmless because it is
   JSON — it invokes tools.
4. **"More entities is better here."** `refreshDirt` scans systems × entities, every
   barrier waits for its slowest pair (DESIGN §3.2 accepts head-of-line blocking) and a
   snapshot serialises the whole world. The opportunity is semantic — many interacting work
   items under one rule set — not game-engine throughput or multi-tenant isolation.

So: an agent-operated playground is a good hypothesis to test. "Agents are the primary
users" is not established, and the way to sell the substrate is not ECS vocabulary but
*how cheaply a controller can inspect, change, run, diagnose and fork a population*.

## Two hypotheses, kept apart

- **H1 — Operate.** An external agent (a coding agent over MCP) can inspect a world,
  find why it is stuck, repair it with scoped edits, run it, and branch it from a
  checkpoint — more reliably and more cheaply than against a comparable JSON store plus
  rules/work-queue surface. Needs no new engine feature and no prompt systems.
- **H2 — Author.** Agents can safely add *behavior* to a live world as data (prompt
  systems, declared components), and a world can carry that vocabulary through snapshots.
  Depends on H1's surface and on rails that H1 does not need.

They were separated because betting on both at once means betting simultaneously on a
protocol, a schema language, a loader/compiler and safe self-modification. H1 is testable
this week; H2 is labelled **experimental** and lives behind an explicit flag.

The six LangGraph ports stay as they are: regression evidence and the credibility of the
comparison. They are no longer the acceptance test for *this* audience.

## What shipped

### `examples/agent-playground` — the H1 apparatus

A hand-written, model-free ticket-desk world with three seeded failure shapes (quiet but
incomplete; parked on a human; a write conflict after paid work), served over MCP by
`server.ts`. Eight tools: `inspect`, `explain`, `edit`, `run`, `run_status`, `cancel`,
`resume`, `checkpoint`, plus `install` when the host passes `--allow-authoring`. Rules the
adversarial review insisted on and the tests enforce:

| Rule | Why |
|---|---|
| `edit` is one scoped operation and must echo the host **revision** (moves on every external change *and* every committed step — `world.step` does not move for idle writes) | edit-after-inspect races; batches are not atomic |
| `run` has a bounded **response** wait and past it reports `operationStatus: 'running'` with a `runId`; `cancel` is separate | a timer racing the promise is not a step boundary; a fake `'limit'` would lie about paid work still in flight |
| `explain` returns facts (missing positive terms, blocking exclusions, pending dirt, in-flight pairs, last run / last veto from the retained trace) and the recipe author's **note**; it never evaluates a guard | `systemsMatching` ignores dirt and guards; a guard is code with unknown side effects; trace absence is not evidence |
| `resume` is the trusted path for approvals; prompt systems cannot write `HumanResponse` | an actor must not grant itself approval |
| `checkpoint fork` builds a **new** world (`forkFromSnapshot`) from the exact recipe; no in-place rewind | `load` keeps later-installed systems and resources |
| `Recipe` is refused on **every** write path (`edit`, `run` input), values of declared components are validated on edit, and a server without `--allow-authoring` refuses to fork a checkpoint that carries declarations | the authoring boundary was bypassable through a plain `set` plus a fork that hydrated the stored manifest (found in review) |

### `@langecs/stdlib` declarative layer — the H2 primitive, experimental

`ComponentDecl` (name, schema, tag, named R59 reducer, cap) → `componentFromDecl`;
`PromptSystemDecl` (query, not, reads, writes, removes, model, prompt, agent, timeouts,
`maxRuns`, `haltOnRejection`) → `systemFromDecl`, an ordinary `defineSystem`. Rails, each
answering a specific review finding:

- The query is the only wake dependency; `reads` default to it and extra reads are
  documented as non-triggering (R26).
- The whole proposal is validated before anything is buffered: allowed names, tag values,
  declared schema against the value **after** the reducer merges it (so an append cannot
  exceed `maxItems`, a sum cannot pass `maximum`), and the reducer's input kind. Because a
  pair only sees step-start state, the declared reducer *also* validates the merged value at
  the barrier: two writes that are each valid but together break the bound reject the step
  (R25/R30) rather than commit a forbidden value.
- Matched-entity only; write and remove are separate capabilities; a **reserved set**
  (`Recipe`, `Cancelled`, `AwaitingHuman`, `HumanResponse`, `SystemError`, budgets,
  `ProposalRejected`, `PromptRuns`, `Tools`, `ModelRef`, `PendingToolCalls`,
  `MessageWaiting`, `RetryPolicy`, `agent:*`) is refused at declaration time.
- A malformed reply is `ProposalRejected` **state**, not a throw — a throw discards the
  pair's buffer (R31) with the `TokenUsage` receipt for the call just paid for, and invites
  `retry` to pay again. `Not(ProposalRejected)` parks the system until someone clears it.
- `maxRuns` (a `PromptRuns` counter + guard, **and** an admission check on the host ledger,
  because a rejected step never commits the counter and a retried run would pay again)
  brakes two data-defined systems that wake each other: self-write exclusion is per pair,
  not a convergence guarantee, and the engine records a write as a change even when the
  value is identical. `Not(BudgetExceeded)` is added by the compiler (R63).
- A host-owned **`PromptLedger`** resource records every model call at admission and
  settles it (delivered/failed, accepted/rejected, tokens or *unknown*) outside barrier
  rollback. `TokenUsage` on the entity is a best-effort mirror. A strict cap needs
  admission control on that ledger; `budgetWatchdog` is a delayed brake by design (R63).
- `declareSystem` refuses two prompt systems that share a plain write target or write
  against another's remove — a `WriteConflictError` at the barrier after both calls were
  paid for.
- **The world carries its vocabulary**: declarations are recorded in a `Recipe` component
  (components, prompt systems, and the full system registration order — barrier apply
  order, R25 step 6). `hydrateRecipe` validates the whole manifest before registering
  anything (R7 has no undo) and refuses a different order unless told otherwise;
  `forkFromSnapshot` is the restore path.
- Identity of a re-declared component is the full canonical declaration (schema, reducer
  and parameters, tag-ness), not name plus kind. A differing one throws; a code-defined
  name throws.

`schemaValidator(schema)` also closes a documented gap in `extractJson`, whose schema was
instruction text only; `examples/research-team` now validates its plan and review replies.

### Engine hardening surfaced along the way

An adversarial pass over core reproduced nine defects; all are fixed with tests T63–T72
and SPEC amendments: `load` is atomic (R36); the conflict prescan covers `remove` and
spawn-time inits by distinct pairs (R30); a cancel landing on a rejected barrier is
stamped (R50); the cancellation stamp is a detached copy (R41/R42); unconsumable dirt is
pruned on unmatch and on load (R26/R35); a rejected barrier restores `nextEntityId` and
`load` clamps it (R13/R30); veto-only trace entries carry `committed: false` (R42);
`ctx.world.systems()` exists (R22) so stdlib `retry` can skip records naming a system this
build lacks instead of rejecting the run, and its backoff is interruptible (R50/R51); the
world stays `running` until a late-cancellation save settles and `persist` records the
revision it actually saved (R16/R58, found in the second review pass).

## Verified now versus proposed

| Claim | Status |
|---|---|
| The three seeded failures can be diagnosed and repaired through the protocol; runs report `running`/`finished`/`rejected` truthfully; forks carry the recipe; stale revisions, busy edits, reserved targets and unknown model resources are refused | **Verified**, deterministically, in `agent-playground.test.ts` |
| Prompt systems apply valid proposals through buffered writes; reject malformed ones as state; are braked by `maxRuns` and by budgets; are receipted in the ledger; survive `forkFromSnapshot` | **Verified** in `declarative.test.ts` |
| An agent operating this surface completes build/debug tasks more correctly or more cheaply than against a JSON store + rules baseline | **Not tested** — H1 is open |
| Prompt-authored behavior is a good way for agents to extend a world | **Not tested** — H2 is open; the rails exist |
| Time travel undoes agent mistakes | **Partly**: state yes; external effects and installed systems no |
| Accounting is authoritative | **No**: the ledger is host-owned and complete for admission/settlement; token counts for failed attempts are unknown, not zero; the component mirror is best-effort |

## How to test H1

Same controller, same model, same budget, same tasks, two substrates:

- **A.** This world through the MCP surface (bounded introspection as shipped).
- **B.** A JSON document store plus a small explicit rules/work-queue engine exposing the
  equivalent operations (read, write, run-rules, history).
- Optionally **C.** the graph baseline already used for the ports.

Held-out task families, several attempts each: a quiet-but-incomplete world; a conflict
after paid work; a pending approval; cancellation of a hung step; fresh-process restore
with a dormant system; dynamic fan-out/fan-in. Score **correct final state** and **repair
success** — not run status: `'done'` means quiescence, not goal achieved. Also record
invariant violations, tokens and calls, wall time, and human interventions. A human
comparison is a separate usability question, not evidence for this hypothesis.

## Known limits (keep these in the docs, not in the pitch)

- **R7 registry is per realm.** Component names are global; incompatible vocabularies
  need separate processes or worker realms. A per-world registry would be a core change;
  it is not proposed until an experiment needs concurrent incompatible vocabularies.
- **No unregister.** `world.use` has no inverse, so a changed prompt needs a new system
  name, and `load` cannot remove a system. `world.unuse`/replace-at-idle is the candidate
  core change if H2 proceeds.
- **Run status is world-wide (R28).** One parked ticket makes every run `'pending'`.
  Diagnosis has to read entities, not the status.
- **`ProposalRejected` parks per entity**, so every halting prompt system on that entity
  parks together.
- **Global barrier and full snapshots** bound how large an operated world can sensibly be.
- **Explain is evidence, not proof.** The flight recorder is a ring buffer cleared by
  `load`; `explain` says so and reports absence as absence of evidence.

## Positioning

Keep the LangGraph comparison — it is the honest yardstick and the regression suite. Add,
do not pivot: the agent-facing surface is a third consumer of the observer contract (SPEC
§14) beside `@langecs/otel` and `@langecs/devtools`, and the declarative layer is stdlib
over unchanged engine semantics. What to say about it is narrow and specific: a controller
can inspect, change, run, diagnose and fork a population of interacting work items through
eight bounded operations, and everything it does is a component write, a step, or a
snapshot — refusable at the boundary, visible in the trace and the checkpoints, and
replayable *as state*. Not a complete audit log: idle edits are not journaled beyond the
snapshots they change, the `PromptLedger` is in memory, failed model calls are not replayed,
and a recipe names its native systems and resources symbolically.
