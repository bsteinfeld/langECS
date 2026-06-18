# eval-react-agent — the reactAgent under an ECS eval gate

A shipped, deterministic **eval suite** for the [`react-agent`](../react-agent) example.
It drives the exact same agent (the `reactAgent` preset with the stubbed weather lookup
and the real calculator) through the Phase 8 harness `runEvalSuite`, scores each case
with a built-in scorer, and asserts a suite-level pass-rate — the CI eval gate (CI-01)
applied to a real agent.

What it proves:

- **A deterministic CI eval gate over the reactAgent.** Every case carries an inline
  scripted model transcript, so the default path uses `scriptedModel`: the test is fully
  deterministic and **zero-network — no `OPENAI_API_KEY` required** (CI-04). `pnpm test`
  auto-discovers it (it is a workspace example) — no new CI wiring.
- **Sub-world-per-case isolation + score-after-quiescence**, inherited from
  `runEvalSuite`: each case runs the agent in a throwaway `eval-<id>` world and is scored
  only after the agent reaches a clean `'done'` status.
- **Structural golden regression (CI-02).** One characterization case locks its
  normalized sub-world snapshot via `assertSnapshotMatch`, so a change to the reactAgent's
  transcript shape surfaces as a snapshot diff.

## Files

- `suite.ts` — the deterministic `reactAgentDataset` (3 cases) reusing
  `assistantAgent`/`spawnReactAgent` from `../react-agent/agent` as the agent-under-test;
  scripted tool-call turns authored inline (well-typed — never loaded from JSONL).
- `eval-react-agent.test.ts` — the zero-network CI-04 gate (`passRate >= passThreshold`,
  all cases `'done'`) plus a single CI-02 snapshot lock. Never reads `OPENAI_API_KEY`.
- `main.ts` — the **optional** gated real-model run: the same `runEvalSuite` call with
  `realModel` set, used only when a key is present.

## Run it

```sh
pnpm install                                   # repo root
pnpm -C examples exec vitest run eval-react-agent   # deterministic gate, no key needed

# Optional real-model run (needs a key):
echo 'OPENAI_API_KEY=sk-...' >> .env.local     # repo root, gitignored
pnpm -C examples eval-react-agent              # runs the suite against gpt-4o-mini
```

## Snapshot policy

Lock snapshots for a **small characterization set only** (here: one case) — they catch
structural behavior drift but are brittle if over-applied. Rely on **passRate / Verdict**
for the bulk of the gate's signal, so a benign change does not train reviewers to
blind-`--update` the golden fixture (08-RESEARCH Pitfall E).
