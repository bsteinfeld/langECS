# eval-llm-judge — the LLM-as-judge scorer under an ECS eval gate

A shipped, deterministic demo of the **LLM-as-judge scorer** (`llmJudgeScorer` from
[`@langecs/eval`](../../packages/eval)). Each case carries a candidate `EvalOutput` and a
reference `EvalExpected`; a judge model grades the candidate and emits a
`{score, pass, reason}` verdict, and the numeric `score` flows through the **unchanged
Phase 7 `scoreCase` → `verdictSystem` chain** into a pass/fail `Verdict`.

What it proves:

- **The judge is referenced only by name (R3).** The case entity carries the string
  `ScorerRef('scorer:llm-judge')` — never the judge `Model` or a closure. The model is
  captured at registration time in a world resource (`world.register('scorer:llm-judge',
  llmJudgeScorer(model, { rubric }))`), so case state stays JSON-serializable.
- **A deterministic, zero-network CI default.** The default path registers a
  `scriptedModel` judge, so the test is fully deterministic and **needs no API key**
  (JUDGE-01). `pnpm test` auto-discovers it (it is a workspace example) — no new CI wiring.
- **The env gate lives only at the caller site (JUDGE-02).** `EVAL_LLM_JUDGE_KEY` is read
  **only in `main.ts`**, never in `@langecs/eval/src` (enforced by `pnpm judge:gate`). When
  the key is set, an **advisory** real judge is registered instead — its scores are
  printed for inspection but no CI gate ever depends on a live judge.
- **`extractJson` does the parse/retry/validate, not a hand-rolled loop.** The judge asks
  the model for strict JSON and `extractJson` parses, validates the `{score in [0,1]}`
  shape, and retries once on a bad shape — so the example never reimplements brittle
  verdict-parsing.

## Files

- `suite.ts` — the deterministic `judgeDataset` (3 cases, mixing pass/fail) plus
  `registerScriptedJudge` / `spawnJudgeCases` / `wireScriptedJudgeWorld`. Registers the
  judge by name from a `scriptedModel` (one verdict turn per case). Reads no env, imports
  no provider package.
- `eval-llm-judge.test.ts` — the zero-network CI gate: drives the scripted judge through
  `scoreCase`/`verdictSystem` and asserts each case's deterministic `Score` and `Verdict`.
  Never reads `EVAL_LLM_JUDGE_KEY`.
- `main.ts` — the runnable demo and the **only** place the `EVAL_LLM_JUDGE_KEY` gate
  lives: scripted judge by default, an advisory real judge when the key is present.

## Run it

```sh
pnpm install                                      # repo root
pnpm -C examples exec vitest run eval-llm-judge   # deterministic gate, no key needed
pnpm -C examples eval-llm-judge                   # scripted demo (no key), prints verdicts

# Optional advisory real-judge run (needs a key):
echo 'EVAL_LLM_JUDGE_KEY=sk-...' >> .env.local    # repo root, gitignored
pnpm -C examples eval-llm-judge                   # grades with gpt-4o-mini (advisory only)
```

## Verdict threshold

This demo registers no `eval:threshold` resource, so `verdictSystem` uses its default
threshold of `1.0` — only a perfect `score` of `1.0` is a `pass`. The dataset deliberately
includes a sub-1.0 case so the gate is not vacuous. Register an `eval:threshold` resource
(e.g. `world.register('eval:threshold', 0.7)`) to make a sub-1.0 score count as a pass.
