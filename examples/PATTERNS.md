# Agent patterns in LangECS

The examples demonstrate a small set of recurring patterns. Once you can name
them, "how do I model X as agents?" usually reduces to "which of these is X?"
Each pattern below is plain ECS — components, systems, queries, reducers — with
no special engine support. Links point to the canonical example for each.

| Pattern | What it is | Mechanism | Canonical example |
|---|---|---|---|
| **Single agent** | One entity, one chat loop | dirty-trigger `callLLM` ↔ `executeTools` | [react-agent](react-agent/), [hello-world](hello-world/) |
| **Pipeline / stages** | Work flows through ordered stages | each stage = a system gated by `Not(NextStageOutput)`; output of one is input dirt for the next | [order-pipeline](order-pipeline/), [content-pipeline](content-pipeline/) |
| **Fan-out / fan-in** | Split work, run in parallel, gather | spawn (or one shared query over) N entities that match in one step; merge results via an append/sum **reducer** at the barrier | [code-review-crew](code-review-crew/), [rag-qa](rag-qa/), [content-pipeline](content-pipeline/) |
| **Supervisor / worker** | A coordinator dispatches and aggregates | supervisor writes `Task` onto workers (spawning at runtime), workers report via `Inbox` reducer, a `when`-guarded aggregator waits for all | [supervisor](supervisor/), [research-team](research-team/) |
| **Reflection (writer ↔ critic)** | Alternate two roles until good enough | two systems write each other's queried components; self-write exclusion makes the alternation; a tag removal ends it | [reflection](reflection/), [research-team](research-team/) |
| **Routing / triage** | Classify, then dispatch | `routeJson` (or `extractJson`) picks a route; the choice is a component write that wakes the matching worker | [support-desk](support-desk/), [supervisor](supervisor/) |
| **Error recovery / heal** | Failure is queryable state | a system matching `[SystemError, …]` re-arms the failed pair with `ctx.invalidate`; a later success auto-clears the record | [supervisor](supervisor/), [order-pipeline](order-pipeline/) |
| **Human-in-the-loop** | Pause for approval, resume later | a system writes `AwaitingHuman` (quiescence = the pause), `world.resume` lifts it; survives process death | [human-in-the-loop](human-in-the-loop/), [support-desk](support-desk/) |
| **Blackboard** | Collaborators share one entity | a spawned task entity whose components (`Findings`, `Plan`, `Retrieved`) many systems read and reduce into | [research-team](research-team/), [rag-qa](rag-qa/) |
| **Bounded memory** | Keep long context under budget | `withMessageWindow` trims what each model call sees; durable history stays on the entity | [context-window](context-window/) |
| **Stop button / deadline** | Halt work already in flight | `world.cancel()` stamps `Cancelled`, so the stop is a `Not(Cancelled)` query term; `ctx.signal` aborts the open call; `timeoutMs` bounds a pair that would otherwise hang the barrier | [cancellation](cancellation/) |
| **Time travel / fork** | Inspect or branch history | per-step snapshots via a `PersistenceAdapter`; `loadStep` rewinds, `load` into a fresh world forks | [time-travel](time-travel/) |

## How they compose

Real systems stack these. The [research-team](research-team/) example alone uses
supervisor (a planner spawns researcher agents), fan-out/fan-in (parallel
research into a blackboard), reflection (a critic drives one revision cycle), and
a global watchdog (a token-budget system that quiesces the team gracefully). The
[supervisor](supervisor/) example combines routing (typed `extractJson`
decomposition), fan-out/fan-in, runtime spawning, and heal.

The throughline: **parallelism is "many pairs matching in one step," and joining
is "a reducer."** There's no fan-out operator or join node to learn — it falls
out of the step scheduler. When a pattern surprises you, the
[debugging guide](../docs/guides/debugging-systems.md) shows how to read the
flight recorder to see exactly which pairs fired and why.
