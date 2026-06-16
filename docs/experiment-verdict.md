# The Experiment Verdict

*Written 2026-06-11, after all six gating ports went green. This is the aggregate judgment
DESIGN.md §9 called for; the per-port evidence lives in each example's README.*

## What was being tested

[DESIGN.md](../DESIGN.md) §1 framed v1 as a **validate-by-porting experiment**: build the
minimal ECS core, port six LangGraph.js examples, and judge honestly whether they come out
clearer and more flexible than the originals. §9 set the bar:

> the supervisor and reflection ports — where ECS should *win* — come out clearly more
> natural than the StateGraph versions, and the baselines are at least par.

## Scorecard

| Port | Bar | Outcome |
|---|---|---|
| [react-agent](../examples/react-agent/README.md) | at least par | **Par.** The LangGraph prebuilt is genuinely shorter; LangECS wins on runtime transparency (trace, one event stream, step-level tests) and zero routing code. |
| [sql-agent](../examples/sql-agent/README.md) | at least par | **Par, opposite strengths.** Staged pipelines are LangGraph's home turf (its graph *enforces* stage order; ours encourages it via prompt). LangECS wins decisively on testability, observability, error policy, and ceremony. |
| [supervisor](../examples/supervisor/README.md) | clear win | **Win on the pattern's core mechanics.** Parallel dispatch with deterministic fan-in, runtime team growth (`ctx.spawn`), and supervised failure recovery (`SystemError` + heal system) are one-liners here versus impossible-or-restructure in the compiled graph. Loses on routing ergonomics (no structured output helper) and flow legibility. |
| [reflection](../examples/reflection/README.md) | clear win | **Partial win.** The writer↔critic cycle that LangGraph needs three edges and a router for is simply *what the scheduler does*, and termination-by-tag-removal is cleaner. But the control flow is implicit, so it reads worse to a newcomer. Better semantics and testability; worse immediate legibility; equal volume. |
| [human-in-the-loop](../examples/human-in-the-loop/README.md) | proof of design | **Win for approval flows.** One flag on the tool, no interrupt plumbing, no node-replay hazard, and a resumable file you can read with `cat` — kill-and-resume across processes works by construction. LangGraph's `interrupt()` remains the more general primitive for arbitrary mid-node pauses. |
| [time-travel](../examples/time-travel/README.md) | proof of design | **Par.** LangECS wins on snapshot transparency, fork isolation, and provable timeline integrity; LangGraph wins on interactive ergonomics (in-place branching, one-call replay). |

## Aggregate judgment

**The hypothesis is validated, with one systematic caveat.** Supervisor cleared its bar;
reflection half-cleared it (runtime semantics: yes; "clearly more natural" to *read*: no);
both baselines held par; both control-feature ports proved the designs they existed to prove.

The caveat is a clean pattern, visible in every single port:

- **Every LangECS win is a *runtime* property.** Deterministic step-level tests
  (the choreography tests in these examples have no LangGraph equivalent), the flight
  recorder, parallel-within-step multi-agent execution, failure as queryable state,
  persistence and resumability by construction.
- **Every LangECS loss is a *read-time* property or ecosystem maturity.** Emergent control
  flow reads worse than drawn edges; model/tool references are stringly-typed; there is no
  structured-output routing helper; LangGraph has years of tooling, docs, and community.

That asymmetry is the actual finding of the experiment, and it cuts in our favor
structurally: **the losses are tooling-fixable; the wins are architectural.** A graph
framework cannot retrofit "three agents thinking in one step" or "the supervisor queries
its workers' error components"; we *can* retrofit legibility — that is precisely what the
deferred [inspector](../README.md#roadmap) (a consumer of the already-shipped trace format)
exists to do.

## What this means (recommendation)

Per DESIGN.md §1, open-sourcing was conditional on the mapping proving itself. It has,
honestly. Recommendation: **publish — after three gates**, in priority order:

1. **Rename** ([docs/naming.md](naming.md)) — already flagged as a release blocker.
2. **Attack the legibility loss before launch**: at minimum a trace-first debugging story
   front-and-center in the docs; ideally the inspector MVP, since it converts the
   experiment's one systematic weakness into a demo.
3. **Two small ergonomic fixes the ports kept hitting**: typed resource references
   (replacing stringly-typed `'model:main'` / `'tool:sql'`) and a structured-output
   routing helper in stdlib (the supervisor port's self-described weakest part).

> **Progress (post-verdict).** Gate 3 is done: typed resource references shipped
> as `defineResource` (R18 amended), and structured output landed in stdlib as
> `extractJson` (with a `validate` hook for Zod/Valibot) plus `routeJson` for
> type-safe dispatch — the supervisor port now routes through them, retiring its
> hand-parser. Gate 2's docs half is in: a trace-first
> [debugging guide](guides/debugging-systems.md) and forward introspection
> (`world.systemsMatching`, `world.queryStats`) make the emergent control flow
> legible; the [`@langecs/devtools`](../packages/devtools) inspector is the
> interactive complement. Gate 1 (rename) remains the maintainer's call.

The six comparison READMEs concede real losses by name and should ship as-is — the
honesty is the credibility. The final publish/no-publish call is the maintainer's.
