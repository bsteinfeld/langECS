// End-to-end test for scoreCase + verdictSystem (EVAL-02).
//
// The critical assertion is the self-retrigger guard: a fully-populated case
// entity must drive the world to RunResult.status === 'done' (NOT 'limit'). A
// 'limit' status would mean scoreCase or verdictSystem retriggered on its own
// write (SPEC §5 / R26 self-write exclusion, RESEARCH.md Pitfall 2). Everything
// here is deterministic and zero-network: EvalOutput is pre-stamped (the Phase 8
// harness stamps it from the agent-under-test), so no model is needed.

import { createWorld } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from '../src/components';
import { registerBuiltinScorers } from '../src/scorers';
import { registerEvalSystems } from '../src/systems';

test('scoreCase + verdictSystem score a passing case and reach status done (no self-retrigger)', async () => {
  const world = createWorld();
  registerBuiltinScorers(world);
  registerEvalSystems(world);

  const c = world.spawn(
    CaseTag(),
    EvalInput('2 + 2'),
    EvalExpected('4'),
    EvalOutput('4'),
    ScorerRef('scorer:exact-match'),
    EvalComplete(),
  );

  const result = await world.run();

  // Self-retrigger guard: a loop would surface as 'limit', never 'done'.
  expect(result.status).toBe('done');
  expect(c.get(Score)).toBe(1);
  expect(c.get(Verdict)).toBe('pass');
});

test('a failing case yields Score 0 and Verdict fail under the default 1.0 threshold', async () => {
  const world = createWorld();
  registerBuiltinScorers(world);
  registerEvalSystems(world);

  const c = world.spawn(
    CaseTag(),
    EvalInput('2 + 2'),
    EvalExpected('5'),
    EvalOutput('4'),
    ScorerRef('scorer:exact-match'),
    EvalComplete(),
  );

  const result = await world.run();

  expect(result.status).toBe('done');
  expect(c.get(Score)).toBe(0);
  expect(c.get(Verdict)).toBe('fail');
});

test('each system fires exactly once per case (bounded steps, no retrigger)', async () => {
  const world = createWorld();
  registerBuiltinScorers(world);
  registerEvalSystems(world);

  world.spawn(
    CaseTag(),
    EvalInput('hi'),
    EvalExpected('hello world'),
    EvalOutput('hello world, friend'),
    ScorerRef('scorer:contains'),
    EvalComplete(),
  );

  const result = await world.run();

  expect(result.status).toBe('done');
  // scoreCase fires once, then verdictSystem fires once on the new Score dirt:
  // a bounded number of steps. A self-retrigger loop would blow past this.
  expect(result.steps).toBeLessThanOrEqual(3);

  const trace = world.getTrace();
  const fired = trace.flatMap((s) => s.runs.map((r) => r.system));
  expect(fired.filter((s) => s === 'eval:scoreCase')).toHaveLength(1);
  expect(fired.filter((s) => s === 'eval:verdictSystem')).toHaveLength(1);
});
