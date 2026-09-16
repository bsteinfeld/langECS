// Deterministic choreography tests for the research team — core scriptedModel
// only, zero network. The step-by-step flow is asserted from final component
// state plus the flight recorder (world.getTrace()).

import { createWorld, type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { narrateWorld } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import {
  Answer,
  Approved,
  BudgetExceeded,
  Findings,
  latestFindings,
  Notes,
  Plan,
  Question,
  ResearchModel,
  RevisionRequest,
  SubQuestion,
  TokenUsage,
} from './blackboard';
import { researcher, spawnResearchTeam } from './team';

const PLAN_JSON =
  '{"subQuestions": ["What is honey chemically made of?", "Why does honey resist spoiling?"]}';

/** Answers researcher calls by sub-question, so concurrent call order never matters. */
const findingFor = (req: ModelRequest): Msg => {
  const asked = req.messages[0]?.content ?? '';
  return asked.includes('made of')
    ? { role: 'assistant', content: 'FINDING_A: mostly fructose and glucose from nectar.' }
    : { role: 'assistant', content: 'FINDING_B: it just lasts.' };
};

/** Trace rendered as one system-name list per executed step. */
const runsByStep = (world: ReturnType<typeof createWorld>): string[][] =>
  world
    .getTrace()
    .filter((s) => s.runs.length > 0)
    .map((s) => s.runs.map((r) => r.system).sort());

/** The full happy-path run, shared by the choreography and narration tests. */
async function runHappyPath() {
  const world = createWorld();
  world.register(
    ResearchModel,
    scriptedModel([
      { role: 'assistant', content: PLAN_JSON }, // planner decomposition
      findingFor, // researcher 1 (either order)
      findingFor, // researcher 2
      // critic round 1: finding 1 is weak → RevisionRequest on its researcher
      { role: 'assistant', content: '{"weak": [{"index": 1, "reason": "no mechanism given"}]}' },
      { role: 'assistant', content: 'FINDING_B2: low water activity and acidity stop microbes.' },
      { role: 'assistant', content: '{"weak": []}' }, // critic round 2: pass
      { role: 'assistant', content: 'ANSWER: honey is sugars at low water activity.' },
    ]),
  );

  const board = spawnResearchTeam(world);
  const result = await world.send(board, Question('Why does honey never spoil?'));
  return { world, board, result };
}

test('plan → parallel research → critic rejection cycle → synthesis', async () => {
  const { world, board, result } = await runHappyPath();
  expect(result.status).toBe('done');
  expect(result.errors).toEqual([]);

  // The step choreography, straight from the flight recorder:
  expect(runsByStep(world)).toEqual([
    ['planner'], // decompose + spawn the team
    ['researcher:investigate', 'researcher:investigate'], // parallel, same step
    ['critic'], // board full → review → flag finding 1
    ['researcher:revise'], // the explicit cycle: re-fired by RevisionRequest
    ['critic'], // revised finding appended → re-review → pass
    ['synthesizer'], // Approved arrived → final answer
  ]);

  // The planner recorded its decomposition and spawned both researchers
  // mid-run, as agents.
  expect(board.get(Plan)).toEqual([
    'What is honey chemically made of?',
    'Why does honey resist spoiling?',
  ]);
  const trace = world.getTrace();
  expect(trace[0]?.spawned).toHaveLength(2);
  const team = world.query(researcher.tag, SubQuestion, Notes);
  expect(team.map((r) => r.get(SubQuestion).index).sort()).toEqual([0, 1]);

  // The budget watchdog woke on every ledger append but always vetoed (under
  // budget); it never executed.
  expect(trace.some((s) => s.vetoed.some((v) => v.system === 'budgetWatchdog'))).toBe(true);
  expect(trace.every((s) => s.runs.every((r) => r.system !== 'budgetWatchdog'))).toBe(true);

  // Blackboard end state: 3 findings appended (2 originals + 1 revision),
  // the revision winning slot 1; approved; synthesized.
  const findings = board.get(Findings) ?? [];
  expect(findings).toHaveLength(3);
  const latest = latestFindings(findings);
  expect(latest.get(0)?.text).toContain('FINDING_A');
  expect(latest.get(1)).toMatchObject({
    text: expect.stringContaining('FINDING_B2'),
    revised: true,
  });
  expect(board.has(Approved)).toBe(true);
  expect(board.get(Answer)).toBe('ANSWER: honey is sugars at low water activity.');

  // The revising researcher kept BOTH drafts in its private Notes and
  // consumed its RevisionRequest; its teammate never revised.
  const revised = team.find((r) => r.get(SubQuestion).index === 1);
  expect(revised?.get(Notes)).toHaveLength(2);
  expect(revised?.has(RevisionRequest)).toBe(false);
  expect(team.find((r) => r.get(SubQuestion).index === 0)?.get(Notes)).toHaveLength(1);

  // Every model call billed the shared ledger: planner, 2× investigate,
  // 2× critic, 1× revise, 1× synthesizer.
  const billed = (board.get(TokenUsage) ?? []).map((s) => s.system).sort();
  expect(billed).toEqual([
    'critic',
    'critic',
    'investigate',
    'investigate',
    'planner',
    'revise',
    'synthesizer',
  ]);
});

test('narration says what the team is doing, and never affects what runs', async () => {
  const { world, board } = await runHappyPath();

  // Phase/Goal have no scheduling role (R64): nothing queries them, so the
  // choreography is byte-identical to the run without them — this is the
  // "control flow is implicit, and you can narrate it anyway" trade.
  const lines = narrateWorld(world);
  expect(lines[0]?.sentence).toBe(`#${board.id} aims to answer the research question; is answered`);
  // One line per researcher, each saying which sub-question it owns and where it
  // got to — the thing a newcomer could not previously see at all.
  const researchers = lines.slice(1);
  expect(researchers).toHaveLength(2);
  expect(researchers.map((n) => n.phase).sort()).toEqual(['reported', 'revised']);
  for (const line of researchers) {
    expect(line.goal).toMatch(/^research sub-question \d+: /);
    expect(line.state).toBe('working');
  }
});

test('a tiny token budget halts the team gracefully with partial findings', async () => {
  const world = createWorld();
  world.register(
    ResearchModel,
    scriptedModel([
      { role: 'assistant', content: PLAN_JSON },
      findingFor,
      findingFor,
      // Nothing else is scripted: scriptedModel throws on any extra call, so
      // this test inherently proves no model system fired past the stamp.
    ]),
  );

  // Budget of 1 token: the planner's first call already exceeds it.
  const board = spawnResearchTeam(world, 1);
  const result = await world.send(board, Question('Why does honey never spoil?'));

  // Graceful quiescence — a budget stop is a normal outcome, not an error.
  expect(result.status).toBe('done');
  expect(result.errors).toEqual([]);

  // The brake has one step of lag: the researchers were already executing
  // when the watchdog tallied the planner's spend, so their findings landed —
  // but the critic and synthesizer never matched, and no answer exists.
  expect(board.get(BudgetExceeded)).toMatchObject({ budget: 1 });
  expect(board.get(Findings) ?? []).toHaveLength(2);
  expect(board.has(Approved)).toBe(false);
  expect(board.get(Answer)).toBeUndefined();

  // Every researcher is stamped too — a pending revision could not fire either.
  const team = world.query(researcher.tag);
  expect(team).toHaveLength(2);
  for (const r of team) expect(r.has(BudgetExceeded)).toBe(true);

  // Choreography: planner; then researchers + the watchdog in the same step
  // (the stamp commits at that barrier); then nothing model-shaped ever again.
  // (runsByStep sorts the names, so 'budgetWatchdog' leads the second step
  // alphabetically; the pairs still fire in the same barrier as before.)
  expect(runsByStep(world)).toEqual([
    ['planner'],
    ['budgetWatchdog', 'researcher:investigate', 'researcher:investigate'],
  ]);
  const trace = world.getTrace();
  const stampStep = trace.findIndex((s) => s.applied.some((c) => c.component === 'BudgetExceeded'));
  expect(stampStep).toBe(1);
  expect(trace.slice(stampStep + 1).flatMap((s) => s.runs)).toEqual([]);
});
