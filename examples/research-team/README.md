# Research team — dynamic multi-agent on a shared blackboard

A research question goes in; a *team that did not exist yet* answers it. The
planner decomposes the question and spawns one researcher **agent** per
sub-question at runtime; researchers fill a shared blackboard in parallel; a
critic reviews the full board and may send one researcher back for a single
revision; a synthesizer writes the final answer. A global token budget can
stop the whole team at any point.

Honesty note: there is no web access. Researchers "research" by asking the
model to answer from its own training knowledge — this example is about the
coordination machinery, not retrieval.

## What it teaches

1. **Dynamic agent spawning** — `ctx.spawn(researcher, SubQuestion(...))`
   creates real agents mid-run: entities with their own private `Notes`
   memory and scoped systems (`researcher:investigate`, `researcher:revise`).
   The team size is decided by a model call, not by code.
2. **The blackboard pattern via reducers** — all researchers `ctx.write`
   `Findings` onto one shared entity; the append reducer merges same-step
   writers deterministically instead of conflicting. The critic's count guard
   (`when`) vetoes until every sub-question is covered, then reviews exactly
   once.
3. **An explicit cycle, bounded by data** — the critic writes a
   `RevisionRequest` onto a researcher; that newly-matching component is what
   re-fires the agent. One revision round max: a finding marked `revised`
   stands, so the loop cannot spin.
4. **Crosscutting concerns as a global system** — every model call appends to
   a `TokenUsage` ledger; the `tokenBudget` watchdog (registered with
   `world.use`, not agent-scoped) re-tallies on each append, and once over
   budget stamps `BudgetExceeded` everywhere. Every model system excludes that
   component with `Not()`, so the world quiesces gracefully with partial
   results — no exception, no special shutdown path. (The brake has one step
   of lag by design: calls already executing when the ledger tips still land.)

## The choreography of a run

```
step 1  planner                 decompose (extractJson) → spawn researcher per sub-question, set Plan
step 2  investigate × N         parallel, one step; findings + token spends merge onto the board
                                (tokenBudget wakes on the ledger, vetoes: under budget)
step 3  critic                  board full → review (extractJson) → RevisionRequest on one researcher
step 4  researcher:revise       re-fired by the request; appends revised finding, consumes the request
step 5  critic                  revised finding is foreign dirt → re-review → Approved
step 6  synthesizer             Approved newly matches its query → final Answer → quiescent
```

Nobody routes: every arrow above is a component write making the next
system's query dirty. (When the critic passes immediately, steps 4-5 simply
never happen — the test pins the rejection path deterministically.)

## Files

- `blackboard.ts` — the data model: every component, plus the typed model
  resource ref.
- `team.ts` — the behavior: the researcher agent and the four global systems.
- `main.ts` — live demo (`gpt-4o-mini` via `@ai-sdk/openai`): one awaited
  `world.send`, then the blackboard printed. Pass `--trace` for the flight
  recorder.
- `research-team.test.ts` — deterministic (`scriptedModel`, zero network):
  the full choreography incl. one rejection cycle, and a 1-token budget run
  asserting graceful early quiescence with no model call after the stamp.

## Run it

```sh
pnpm install                                     # repo root, once
pnpm -C examples research-team                   # live demo (OPENAI_API_KEY in <repo-root>/.env.local)
pnpm -C examples research-team -- --trace        # same, plus the flight recorder
pnpm -C examples exec vitest run research-team   # deterministic tests, no network
```
