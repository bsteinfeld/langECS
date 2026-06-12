# Code-review crew — three reviewers, one step

One `Pr` entity holds a small real diff (a SQL-injection-ish string concat, an
O(n²) nested loop, and a stray `var`). Three reviewer systems — **security**,
**performance**, **style** — each call the model with a lens-specific prompt
and `extractJson` a findings list. Then pure code dedupes, and a lead-reviewer
model call writes the approve/request-changes verdict.

## The one-step parallel fan-in IS the demo

All three reviewers query `[Pr]`, so the single `world.send(pr, Pr(...))` is
one piece of dirt that schedules **three pairs into the same step**. The flight
recorder proves it (`pnpm -C examples code-review-crew --trace`):

```
step 1 (0.6ms)
  scheduled: review-crew:security#1, review-crew:performance#1, review-crew:style#1
  run review-crew:security#1 0.2ms
    merge review:Findings on #1
  run review-crew:performance#1 0.1ms
    merge review:Findings on #1
  run review-crew:style#1 0.1ms
    merge review:Findings on #1
  applied: set review:Findings#1, merge review:Findings#1, merge review:Findings#1
step 2 (0.1ms)
  scheduled: review-crew:dedupe#1
  run review-crew:dedupe#1 0.1ms
    set review:Deduped on #1
step 3 (0.1ms)
  scheduled: review-crew:verdict#1
  run review-crew:verdict#1 0.0ms
    set review:Review on #1
```

In a graph framework this shape needs either three sequential reviewer nodes,
or an explicit `Send()` fan-out plus a join/reducer node that knows how many
branches to wait for. Here the fan-out is just three systems sharing a query,
and the "wait for all" is the step barrier: `Findings` doesn't exist until
every reviewer's append commits, so `dedupe` *cannot* fire early.

## The ECS ideas it teaches

1. **Same-query systems = parallel fan-out.** Dirt schedules every matching
   (system, entity) pair into one step; the engine runs them concurrently
   (`Promise.all`), no orchestration code.
2. **Reducer components = conflict-free fan-in.** `Findings` has an append
   reducer, so three same-step writers merge in deterministic registration
   order instead of throwing `WriteConflictError` (SPEC R30).
3. **Component creation as a sequencing trigger.** `dedupe` fires when
   `Findings` newly matches (post-barrier), `verdict` when `Deduped` does
   (R26.2) — the pipeline stages order themselves by what data exists.

Also showcased: `defineResource` typed model refs (no stringly-typed
`ctx.resource<Model>('model:...')`) and `extractJson` for schema-shaped
structured output.

## Files

- `crew.ts` — components (`Pr`, `Findings`, `Deduped`, `Review`), the three
  reviewer systems, pure-code `mergeFindings`, the verdict system, the diff
  fixture, and the `reviewCrew` agent bundle.
- `main.ts` — live demo with `gpt-4o-mini`: one awaited `world.send`, then the
  review printed like a PR comment thread.
- `code-review-crew.test.ts` — deterministic test (`scriptedModel`, zero
  network): asserts the same-step parallelism from the trace, the dedupe of a
  planted cross-reviewer duplicate (highest severity wins), and the verdict.

## Run it

```sh
pnpm install                                        # repo root, once
pnpm -C examples code-review-crew                   # live demo (OPENAI_API_KEY in <repo-root>/.env.local)
pnpm -C examples code-review-crew --trace           # + flight recorder
pnpm -C examples exec vitest run code-review-crew   # deterministic test, no network
```
