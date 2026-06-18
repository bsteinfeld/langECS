// CI gate for the shipped LLM-as-judge example (JUDGE-01). Fully scripted and
// zero-network: the judge is a `scriptedModel`, so the suite is deterministic and
// requires NO API key. This file imports no model-provider package and reads no
// environment — the advisory real-model path (its env gate) lives only in main.ts
// and is never invoked here. Each case is graded through the UNCHANGED Phase 7
// scoreCase → verdictSystem chain via a `scriptedModel` judge.

import { createWorld } from '@langecs/core';
import { Score, Verdict } from '@langecs/eval';
import { expect, test } from 'vitest';
import { judgeDataset, wireScriptedJudgeWorld } from './suite';

test('scripted judge yields deterministic Score/Verdict via the unchanged chain (JUDGE-01)', async () => {
  const world = createWorld({ id: 'eval-llm-judge' });
  const cases = wireScriptedJudgeWorld(world);

  const result = await world.run();

  // Self-retrigger guard: a scorer/verdict loop would surface as 'limit', never 'done'.
  expect(result.status).toBe('done');
  expect(cases.length).toBe(judgeDataset.length);

  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const spec = judgeDataset[i];
    expect(c).toBeDefined();
    expect(spec).toBeDefined();
    if (!c || !spec) continue;
    // The scripted judge's score flows straight through scoreCase (R3: resolved by
    // the 'scorer:llm-judge' string), and verdictSystem turns it into pass/fail.
    expect(c.get(Score)).toBe(spec.expectScore);
    expect(c.get(Verdict)).toBe(spec.expectVerdict);
  }
});

test('the suite mixes pass and fail outcomes (the gate is not vacuous)', async () => {
  const world = createWorld({ id: 'eval-llm-judge' });
  const cases = wireScriptedJudgeWorld(world);
  await world.run();

  const verdicts = cases.map((c) => c.get(Verdict));
  expect(verdicts).toContain('pass');
  expect(verdicts).toContain('fail');
});
