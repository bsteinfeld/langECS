// LLM-as-judge scorer tests (JUDGE-01, JUDGE-02). Every test is deterministic and
// zero-network: the judge's model is always a `scriptedModel`. No env reads, no
// model-provider imports — the structural-gating guarantee in action.

import {
  createWorld,
  defineSystem,
  defineTag,
  type ModelRequest,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from '../src/components';
import { llmJudgeScorer, validateJudge } from '../src/judge';
import { registerBuiltinScorers, type Scorer } from '../src/scorers';
import { registerEvalSystems } from '../src/systems';

// 1. JUDGE-01 determinism: a scripted verdict turn yields the exact score.
test('scripted judge yields a deterministic score (zero network)', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: '{"score":0.9,"pass":true,"reason":"matches"}' },
  ]);
  const judge = llmJudgeScorer(model);
  expect(await judge.score('Paris', 'The capital is Paris')).toBe(0.9);
});

// 2. JUDGE-01 configurable rubric + determinism wrapper: rubric reaches the model
//    prompt and the request carries temperature:0 + a numeric seed.
test('configurable rubric reaches the prompt; wrapper sets temperature:0 and a seed', async () => {
  let captured: ModelRequest | undefined;
  const model = scriptedModel([
    (req): { role: 'assistant'; content: string } => {
      captured = req;
      return { role: 'assistant', content: '{"score":1,"pass":true,"reason":"ok"}' };
    },
  ]);
  const judge = llmJudgeScorer(model, { rubric: 'REWARD_BREVITY_MARKER' });
  await judge.score('short answer', 'reference');

  expect(captured).toBeDefined();
  const reqText = `${captured?.system ?? ''}\n${(captured?.messages ?? [])
    .map((m) => m.content)
    .join('\n')}`;
  expect(reqText).toContain('REWARD_BREVITY_MARKER');
  expect(captured?.temperature).toBe(0);
  expect(typeof captured?.seed).toBe('number');
});

// 3. JUDGE-01 validate/retry path: a first out-of-range score is rejected by
//    validateJudge (throws), the corrected second turn is accepted.
test('out-of-range score is rejected, then the corrected retry is accepted', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: '{"score":5,"pass":true,"reason":"bad range"}' },
    { role: 'assistant', content: '{"score":0.4,"pass":false,"reason":"corrected"}' },
  ]);
  expect(await llmJudgeScorer(model).score('x', 'y')).toBe(0.4);
});

// 4. JUDGE-01 pass derivation (advisory): score passthrough holds regardless of
//    `pass`, and validateJudge derives `pass` from the threshold when omitted.
test('pass is derived from passThreshold when the model omits it (advisory only)', async () => {
  // Only `score` feeds the chain — assert the number passes through.
  const model = scriptedModel([{ role: 'assistant', content: '{"score":0.8,"reason":"no pass"}' }]);
  expect(await llmJudgeScorer(model).score('a', 'b')).toBe(0.8);

  // Verify the advisory pass derivation directly via the exported validator.
  const v = validateJudge(0.7);
  expect(v({ score: 0.8, reason: '' }).pass).toBe(true);
  expect(v({ score: 0.5, reason: '' }).pass).toBe(false);
});

// 5. JUDGE-01 end-to-end via the UNCHANGED Phase 7 chain: scoreCase → verdictSystem
//    populate Score and Verdict from a case carrying ScorerRef('scorer:llm-judge').
test('end-to-end: scoreCase + verdictSystem populate Score/Verdict via the judge', async () => {
  const world = createWorld();
  registerEvalSystems(world);
  world.register(
    'scorer:llm-judge',
    llmJudgeScorer(
      scriptedModel([{ role: 'assistant', content: '{"score":1,"pass":true,"reason":"ok"}' }]),
    ),
  );

  const c = world.spawn(
    CaseTag(),
    EvalOutput('Paris'),
    EvalExpected('Paris'),
    ScorerRef('scorer:llm-judge'),
    EvalComplete(),
  );

  const result = await world.run();

  // Self-retrigger guard: a loop would surface as 'limit', never 'done'.
  expect(result.status).toBe('done');
  expect(c.get(Score)).toBe(1);
  // Default verdictSystem threshold is 1.0 (no eval:threshold resource registered).
  expect(c.get(Verdict)).toBe('pass');
});

// 6. JUDGE-01 / R3: only the 'scorer:llm-judge' string lives on the component, so
//    JSON.stringify(world.snapshot()) does not throw (no Model/closure in a component).
test('R3: a case carrying ScorerRef("scorer:llm-judge") snapshots without throwing', () => {
  const world = createWorld();
  registerEvalSystems(world);
  world.register(
    'scorer:llm-judge',
    llmJudgeScorer(
      scriptedModel([{ role: 'assistant', content: '{"score":1,"pass":true,"reason":"ok"}' }]),
    ),
  );

  world.spawn(
    CaseTag(),
    EvalOutput('Paris'),
    EvalExpected('Paris'),
    ScorerRef('scorer:llm-judge'),
    EvalComplete(),
  );

  expect(() => JSON.stringify(world.snapshot())).not.toThrow();
});

// 7. JUDGE-02 builtins-omit-judge: registerBuiltinScorers never wires the judge, so
//    resolving 'scorer:llm-judge' from a freshly-seeded world throws.
test('registerBuiltinScorers does NOT register the judge (resolving it throws)', async () => {
  const world = createWorld();
  registerBuiltinScorers(world);

  const Probe = defineTag('judgeProbe');
  let judgeMissing = false;
  const resolveJudge = defineSystem({
    name: 'resolveJudge',
    query: [Probe],
    run: (_e, ctx) => {
      try {
        ctx.resource<Scorer>('scorer:llm-judge');
      } catch {
        judgeMissing = true;
      }
    },
  });

  world.use(resolveJudge);
  world.spawn(Probe());
  const r = await world.run();

  expect(r.status).toBe('done');
  expect(judgeMissing).toBe(true);
});
