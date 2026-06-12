# content-pipeline

A staged real-life workflow — produce a short blog post — with **no
orchestrator, no stage list, no edges**. One Post entity flows through five
single-purpose systems:

```
Brief ─▶ outline ─▶ draftSections ─▶ drafter ×3 (ONE step) ─▶ assemble ─▶ editor ─▶ Published
            LLM        ctx.spawn       LLM each, parallel      count guard      LLM
```

Each system queries the data shape it needs (`[Brief, Not(Outline)]`,
`[Outline]`, `[Section]`, …); the previous stage *producing* that shape is
what fires the next. The run ends when nothing matches anymore — `Published`
existing and quiescence are the same fact.

## The ECS ideas it teaches

1. **Fan-out/fan-in is free.** `draftSections` spawns one `Section` entity per
   outline heading (`ctx.spawn`); every fresh Section is dirt for `drafter`,
   so the engine runs **all three drafters concurrently in a single step** —
   no `Promise.all`, no map-reduce plumbing. Each drafter writes its text back
   to the parent Post (`ctx.write`), where the `SectionDrafts` **append
   reducer** merges the concurrent writes instead of conflicting.
2. **Readiness is data, not choreography.** `assemble`'s `when` guard compares
   counts (`drafts.length === outline.sections.length`) and holds the reduce
   until every slot has arrived. Assembly sorts by each draft's outline
   `index`, so model-call completion order never leaks into the page — the
   test scrambles completion order on purpose to prove it.
3. **The new DX surface.** `defineResource<Model>('model:writer')` gives a
   typed resource handle (no stringly-typed `ctx.resource<Model>('…')` hops),
   and `extractJson` turns the outline call into typed structured output with
   fence-stripping and one retry built in.

## Run it

```sh
pnpm -C examples content-pipeline           # live demo (OPENAI_API_KEY in repo-root .env.local)
pnpm -C examples content-pipeline --trace   # + one timing line per stage from the flight recorder
pnpm -C examples exec vitest run content-pipeline   # deterministic test — no key, no network
```
