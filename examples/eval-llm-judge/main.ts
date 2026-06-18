// Runnable demo of the LLM-as-judge scorer (JUDGE-01, JUDGE-02).
//
// Run with: pnpm -C examples eval-llm-judge
//
// THIS FILE IS THE ONLY PLACE the EVAL_LLM_JUDGE_KEY gate lives — a caller site.
// @langecs/eval/src never reads it (enforced by `pnpm judge:gate`). The default
// path (no key) registers the deterministic scripted judge from suite.ts, so a
// plain `pnpm -C examples eval-llm-judge` runs offline. When EVAL_LLM_JUDGE_KEY is
// set, an ADVISORY real judge is registered instead: its scores are printed but no
// CI gate ever depends on a live judge (the .test.ts gate stays fully scripted).

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { llmJudgeScorer, registerEvalSystems, Score, Verdict } from '@langecs/eval';
import { loadEnvLocal } from '../_shared/env';
import {
  JUDGE_REF,
  JUDGE_RUBRIC,
  judgeDataset,
  registerScriptedJudge,
  spawnJudgeCases,
} from './suite';

/** The real judge model id, used only on the advisory key-gated path. */
const JUDGE_MODEL = 'gpt-4o-mini';

loadEnvLocal();

const world = createWorld({ id: 'eval-llm-judge-demo' });
registerEvalSystems(world);

// The EVAL_LLM_JUDGE_KEY gate — the env read lives ONLY here (a caller site).
const judgeKey = process.env.EVAL_LLM_JUDGE_KEY;
if (judgeKey === undefined) {
  console.log('No EVAL_LLM_JUDGE_KEY set — running the deterministic SCRIPTED judge.\n');
  registerScriptedJudge(world);
} else {
  console.log(`EVAL_LLM_JUDGE_KEY set — registering an ADVISORY real judge (${JUDGE_MODEL}).`);
  console.log('Real-judge scores are printed for inspection only; no CI gate depends on them.\n');
  // The real provider is constructed only on this branch, only when the key is
  // present (structural gating, JUDGE-02). passThreshold is advisory — only the
  // numeric `score` feeds the unchanged Score/Verdict chain.
  world.register(
    JUDGE_REF,
    llmJudgeScorer(fromAiSdk(openai(JUDGE_MODEL)), { rubric: JUDGE_RUBRIC, passThreshold: 0.7 }),
  );
}

const cases = spawnJudgeCases(world);

const result = await world.run();
if (result.status !== 'done') {
  console.error(`World did not quiesce cleanly (status: ${result.status}).`);
  process.exit(1);
}

let passed = 0;
for (let i = 0; i < cases.length; i += 1) {
  const c = cases[i];
  const spec = judgeDataset[i];
  if (!c || !spec) continue;
  const verdict = c.get(Verdict);
  const score = c.get(Score);
  if (verdict === 'pass') passed += 1;
  console.log(
    `  [${(verdict ?? 'n/a').toUpperCase()}] ${spec.id} (score ${score}) -> ${spec.output}`,
  );
}

const passRate = cases.length === 0 ? 0 : passed / cases.length;
console.log(`\npassRate ${(passRate * 100).toFixed(0)}% (${passed}/${cases.length})`);

if (judgeKey !== undefined) {
  console.log('\n(Advisory real-judge run — these scores are informational, not a CI gate.)');
}
