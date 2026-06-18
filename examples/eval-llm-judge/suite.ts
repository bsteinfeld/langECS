// Deterministic LLM-as-judge eval dataset + scripted-judge wiring (JUDGE-01).
//
// This ships a tiny dataset of judge cases scored through the UNCHANGED Phase 7
// scoreCase/verdictSystem chain: each case carries only EvalOutput / EvalExpected
// and a `ScorerRef('scorer:llm-judge')` string (R3 — the judge Model never lives
// in a component). The judge itself is a `scriptedModel`, so the suite is fully
// deterministic and zero-network: it never reads an env var and never imports a
// model-provider package. The advisory real-model gate lives ONLY in main.ts.

import { type EntityHandle, scriptedModel, type World } from '@langecs/core';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  llmJudgeScorer,
  registerEvalSystems,
  ScorerRef,
} from '@langecs/eval';

/** The string key the case entity references the judge by (R3 — name only). */
export const JUDGE_REF = 'scorer:llm-judge';

/** The rubric injected into the judge system prompt for this demo. */
export const JUDGE_RUBRIC =
  'Reward factual correctness and completeness; penalize hedging and irrelevant text.';

/**
 * One judge case. `output` is the candidate answer under test, `expected` is the
 * reference the judge grades against. `scriptedVerdict` is the deterministic
 * `{score,pass,reason}` JSON the scripted judge model returns for THIS case (the
 * judge calls the model exactly once per case), and `expectScore` / `expectVerdict`
 * are what the unchanged chain must produce.
 */
export interface JudgeCase {
  id: string;
  input: string;
  output: string;
  expected: string;
  scriptedVerdict: string;
  expectScore: number;
  expectVerdict: 'pass' | 'fail';
}

/**
 * Three characterization cases. The verdict threshold is the default 1.0 (no
 * `eval:threshold` resource registered), so only a perfect 1.0 score is a 'pass'
 * and any sub-1.0 score is a 'fail' — the dataset exercises both outcomes.
 */
export const judgeDataset: JudgeCase[] = [
  {
    id: 'capital-correct',
    input: 'What is the capital of France?',
    output: 'The capital of France is Paris.',
    expected: 'Paris',
    scriptedVerdict: '{"score":1,"pass":true,"reason":"correct and complete"}',
    expectScore: 1,
    expectVerdict: 'pass',
  },
  {
    id: 'capital-partial',
    input: 'What is the capital of Australia?',
    output: 'I think it might be Sydney?',
    expected: 'Canberra',
    scriptedVerdict: '{"score":0.2,"pass":false,"reason":"wrong city and hedged"}',
    expectScore: 0.2,
    expectVerdict: 'fail',
  },
  {
    id: 'math-correct',
    input: 'What is 12 * 12?',
    output: '12 * 12 = 144.',
    expected: '144',
    scriptedVerdict: '{"score":1,"pass":true,"reason":"exact"}',
    expectScore: 1,
    expectVerdict: 'pass',
  },
];

/**
 * Registers the SCRIPTED judge under `'scorer:llm-judge'`. The scriptedModel
 * returns one verdict turn per case, in dataset order (the judge calls its model
 * once per case via scoreCase), so the whole suite is deterministic and offline.
 * Mirrors the real registration shape — only the Model differs (main.ts swaps in
 * a real model behind its env gate).
 */
export function registerScriptedJudge(world: World): void {
  const verdictTurns = judgeDataset.map((c) => ({
    role: 'assistant' as const,
    content: c.scriptedVerdict,
  }));
  world.register(JUDGE_REF, llmJudgeScorer(scriptedModel(verdictTurns), { rubric: JUDGE_RUBRIC }));
}

/**
 * Spawns every case onto `world` carrying the by-name `ScorerRef` and the
 * `EvalComplete` one-shot trigger, returning the spawned case entities in dataset
 * order. The caller registers the judge (scripted or real) and the eval systems
 * first, then drives `world.run()` to quiescence.
 */
export function spawnJudgeCases(world: World): EntityHandle[] {
  return judgeDataset.map((c) =>
    world.spawn(
      CaseTag(),
      EvalInput(c.input),
      EvalOutput(c.output),
      EvalExpected(c.expected),
      ScorerRef(JUDGE_REF),
      EvalComplete(),
    ),
  );
}

/**
 * Convenience wiring: registers the eval systems + the scripted judge and spawns
 * the dataset. Returns the case entities (in dataset order). The test uses this
 * for a one-call deterministic setup; main.ts registers a (possibly real) judge
 * itself and only reuses `spawnJudgeCases`.
 */
export function wireScriptedJudgeWorld(world: World): EntityHandle[] {
  registerEvalSystems(world);
  registerScriptedJudge(world);
  return spawnJudgeCases(world);
}
