# rag-qa

**Teaches:** Retrieval-Augmented Generation as a plain ECS pipeline — and why
parallel retrieval fan-out and result gathering need *no orchestration code*,
just entities matching in a step and a reducer merging their writes.

RAG is the most-deployed LLM pattern: decompose a question into searches, fetch
context, answer from it. In LangECS that's three systems and two reducers.

## The shape

One question becomes a small blackboard entity (`Question`). Then:

1. **`decompose`** — turns the question into 1-3 focused sub-queries using typed
   structured output (`extractJson` with a schema + validator, so a malformed
   reply self-corrects on retry), and **spawns one retrieval entity per
   sub-query** (`ctx.spawn(SubQuery(q), Parent(id))`).
2. **`retrieve`** — every spawned retriever matches `[SubQuery, Parent]` in the
   **same step**, so they all run in parallel. Each fans its passages back into
   the question's `Retrieved` component (append reducer) and bumps a `Reports`
   sum-reducer, then despawns itself. The reducers merge the concurrent writers
   deterministically at the barrier — no locks, no race, no fan-in code.
3. **`synthesize`** — woken every time results arrive, its `when` guard vetoes
   until `Reports` reaches the expected count, then composes one grounded, cited
   answer from the de-duplicated context.

```
decompose ──spawn──▶ retrieve ─┐
            (per q)  retrieve ──┼─▶ Retrieved (reducer) ──▶ synthesize ──▶ Answer
                     retrieve ─┘   Reports   (reducer)
```

This is the same fan-out/fan-in mechanism as the
[supervisor](../supervisor/README.md) example — parallel work is "many entities
matching in one step", and gathering is a reducer. A graph framework would need
a map/fan-out construct and an explicit join; here it's the scheduler's default
behavior.

## The retriever is just a resource

The retriever is a world resource (`'retriever'`), so swapping the toy keyword
search for a real vector store (pgvector, Pinecone, a local embedding index) is a
one-line `world.register` change — the pipeline systems never change. Components
hold data; behavior lives in named resources.

## Run it

```sh
pnpm -C examples rag-qa   # live demo against gpt-4o-mini (needs OPENAI_API_KEY)
```

The demo uses a tiny in-memory corpus and streams the decomposition and
retrieval as they happen. `rag-qa.test.ts` proves the schedule deterministically
with `scriptedModel`: step 1 decomposes and spawns two retrievers, step 2 runs
both in one step and merges their hits, step 3 synthesizes — all asserted from
`world.getTrace()`, no network.
