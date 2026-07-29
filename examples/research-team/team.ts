// The research team's behavior: four global systems (planner, critic,
// synthesizer, tokenBudget) plus a spawnable researcher agent. Nobody calls
// anybody — each system fires because the previous one's writes made its
// query newly match (or changed a queried component), and the run ends when
// no query has fresh dirt left.
//
// Researchers have no web access; they answer from the model's own training
// knowledge (the README is honest about this).

import {
  type AgentDef,
  defineAgent,
  defineSystem,
  type EntityHandle,
  type EntityTarget,
  type Model,
  Not,
  type SystemCtx,
  type World,
} from '@langecs/core';
import { budgetWatchdog, extractJson, Goal, Phase, spendOf } from '@langecs/stdlib';
import {
  Answer,
  Approved,
  BudgetExceeded,
  type Finding,
  Findings,
  latestFindings,
  Notes,
  Plan,
  Question,
  ResearchModel,
  RevisionRequest,
  SubQuestion,
  TokenBudget,
  TokenUsage,
} from './blackboard';

/** The shared model, wrapped so each call's cost lands on the blackboard's
 * TokenUsage ledger — the data feed for the tokenBudget watchdog. Models that
 * report no usage (scriptedModel in tests) are estimated at ~4 chars/token. */
function meteredModel(ctx: SystemCtx, board: EntityTarget, system: string): Model {
  const inner = ctx.resource(ResearchModel);
  return {
    async generate(req) {
      const result = await inner.generate(req);
      // stdlib's `spendOf` does the reported-or-estimated arithmetic (R63).
      const requestChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      ctx.write(board, TokenUsage, [spendOf(system, result, requestChars)], 'add');
      return result;
    },
  };
}

// --------------------------------------------------------------- researchers

const RESEARCH_PROMPT =
  'You are a researcher on a team, answering from your own knowledge (you have no web access). ' +
  'Answer the sub-question in 2-4 dense, factual sentences. State uncertainty plainly.';

// Fires once per researcher: SubQuestion arrives at spawn (newly-matched
// dirt) and never changes again. Notes is deliberately NOT in this query —
// it is only written here, and listing it would make revise's later Notes
// append (a different pair, hence foreign dirt) re-fire the first draft.
const investigate = defineSystem({
  name: 'investigate',
  query: [SubQuestion, Not(BudgetExceeded)],
  run: async (e, ctx) => {
    const sub = e.get(SubQuestion);
    const model = meteredModel(ctx, sub.board, 'investigate');
    const result = await model.generate({
      system: RESEARCH_PROMPT,
      messages: [{ role: 'user', content: sub.text }],
    });
    const text = result.message.content;
    e.add(Notes, [text]); // private memory first, then the public copy — the
    // Findings append reducer merges same-barrier reporters deterministically.
    const finding: Finding = { researcher: e.id, index: sub.index, text, revised: false };
    ctx.write(sub.board, Findings, [finding], 'add');
    e.set(Phase, 'reported');
  },
});

// The explicit revision cycle: the critic's RevisionRequest write makes this
// query newly match, so the pair fires exactly once — removing the request
// below consumes the trigger.
const revise = defineSystem({
  name: 'revise',
  query: [SubQuestion, Notes, RevisionRequest, Not(BudgetExceeded)],
  run: async (e, ctx) => {
    const sub = e.get(SubQuestion);
    const model = meteredModel(ctx, sub.board, 'revise');
    const flag = `A reviewer flagged your finding: ${e.get(RevisionRequest)}\nRevise it.`;
    const result = await model.generate({
      system: RESEARCH_PROMPT,
      messages: [
        { role: 'user', content: sub.text },
        { role: 'assistant', content: e.get(Notes).at(-1) ?? '' },
        { role: 'user', content: flag },
      ],
    });
    const text = result.message.content;
    e.add(Notes, [text]);
    const finding: Finding = { researcher: e.id, index: sub.index, text, revised: true };
    ctx.write(sub.board, Findings, [finding], 'add');
    e.remove(RevisionRequest);
    e.set(Phase, 'revised');
  },
});

/** A real agent, not a function call: each researcher is an entity with its
 * own Notes memory and two scoped systems, spawned by the planner at runtime. */
export const researcher: AgentDef = defineAgent({
  name: 'researcher',
  components: [Notes([])],
  systems: [investigate, revise],
});

// ------------------------------------------------------------ global systems

const PLAN_SCHEMA = {
  type: 'object',
  required: ['subQuestions'],
  properties: { subQuestions: { type: 'array', items: { type: 'string' } } },
};

// Fires once when a Question lands on the blackboard (Not(Plan) prevents
// replanning); fans the team out by spawning one researcher agent per
// sub-question — entities, components, and scoped systems all join mid-run.
export const planner = defineSystem({
  name: 'planner',
  query: [Question, Not(Plan), Not(BudgetExceeded)],
  run: async (e, ctx) => {
    const { subQuestions } = await extractJson<{ subQuestions: string[] }>(
      meteredModel(ctx, e, 'planner'),
      {
        prompt: e.get(Question),
        system: 'Decompose the research question into 2-4 independent sub-questions.',
        schema: PLAN_SCHEMA,
        schemaName: 'Plan',
      },
    );
    const plan = subQuestions.slice(0, 4);
    for (const [index, text] of plan.entries()) {
      // Narration (R64) rides along with the spawn: nothing queries Goal or
      // Phase, so this is purely so a human — or the devtools inspector, or
      // main.ts — can read what each researcher is for.
      ctx.spawn(
        researcher,
        SubQuestion({ board: e.id, index, text }),
        Goal(`research sub-question ${index}: ${text}`),
        Phase('drafting'),
      );
    }
    e.set(Plan, plan);
    e.set(Phase, 'researching');
  },
});

/** The blackboard rendered for the critic and synthesizer prompts. */
const renderBoard = (question: string, plan: string[], latest: Map<number, Finding>): string =>
  `Research question: ${question}\n\nFindings by sub-question:\n${plan
    .map((sub, i) => `${i}. ${sub}\n   finding: ${latest.get(i)?.text ?? '(missing)'}`)
    .join('\n')}`;

const VERDICT = { index: { type: 'integer' }, reason: { type: 'string' } };
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['weak'],
  properties: { weak: { type: 'array', items: { type: 'object', properties: VERDICT } } },
};

// Every Findings append is foreign dirt, so this re-evaluates as findings
// land — but the count guard vetoes until every sub-question is covered, so
// the review happens exactly when the board is full.
export const critic = defineSystem({
  name: 'critic',
  query: [Question, Plan, Findings, Not(Approved), Not(BudgetExceeded)],
  when: (e) => latestFindings(e.get(Findings)).size >= e.get(Plan).length,
  run: async (e, ctx) => {
    const latest = latestFindings(e.get(Findings));
    const verdict = await extractJson<{ weak: { index: number; reason: string }[] }>(
      meteredModel(ctx, e, 'critic'),
      {
        prompt: renderBoard(e.get(Question), e.get(Plan), latest),
        system:
          'You review research findings. Flag a finding as weak only if it is vague, off-topic, ' +
          'or unsupported; an empty list means everything passes.',
        schema: REVIEW_SCHEMA,
        schemaName: 'Review',
      },
    );
    // One revision round only: a finding that already came back revised
    // stands, however grumpy the critic — this bounds the cycle.
    const flagged = (verdict.weak ?? []).filter((w) => latest.get(w.index)?.revised === false);
    if (flagged.length === 0) {
      e.add(Approved); // green light: the synthesizer's query newly matches
      e.set(Phase, 'synthesizing');
      return;
    }
    for (const w of flagged) {
      const finding = latest.get(w.index);
      if (finding !== undefined) {
        ctx.write(finding.researcher, RevisionRequest, w.reason, 'set');
        ctx.write(finding.researcher, Phase, 'revising', 'set');
      }
    }
    // No write to the blackboard here: this pair's dirt is consumed, and the
    // critic re-fires only when a revised finding appends (foreign dirt).
  },
});

// Approved arriving is the trigger; Not(Answer) makes it one-shot.
export const synthesizer = defineSystem({
  name: 'synthesizer',
  query: [Question, Plan, Findings, Approved, Not(Answer), Not(BudgetExceeded)],
  run: async (e, ctx) => {
    const model = meteredModel(ctx, e, 'synthesizer');
    const board = renderBoard(e.get(Question), e.get(Plan), latestFindings(e.get(Findings)));
    const result = await model.generate({
      system: 'Compose one coherent answer to the research question from the findings. Be concise.',
      messages: [{ role: 'user', content: board }],
    });
    e.set(Answer, result.message.content);
    e.set(Phase, 'answered');
  },
});

// Crosscutting watchdog, now stdlib's (R63) rather than hand-rolled here: it
// re-tallies the ledger after every model call, vetoes while under budget, and
// once over it stamps BudgetExceeded on the board plus every entity matching
// `stampOn`. Only that last part was ever example-specific — the brake has to
// reach the researchers, or their `Not(BudgetExceeded)` guards never unmatch.
//
// The brake has one step of lag by design: calls already executing when the
// ledger tips still land; nothing model-shaped fires after the stamp commits.
export const tokenBudget = budgetWatchdog({ stampOn: [researcher.tag] });

// --------------------------------------------------------------------- setup

export const DEFAULT_BUDGET = 50_000;

/** Registers the four global systems and spawns the (empty) blackboard; the
 * run starts when the caller sends a Question to it. */
export function spawnResearchTeam(world: World, budget: number = DEFAULT_BUDGET): EntityHandle {
  for (const system of [planner, critic, synthesizer, tokenBudget]) world.use(system);
  // `Goal`/`Phase` have no scheduling role at all (R64) — they exist so
  // `narrateWorld(world)` can say what the team is doing at any moment, which is
  // the honest answer to "emergent control flow reads worse than drawn edges".
  return world.spawn(TokenBudget(budget), Goal('answer the research question'), Phase('planning'));
}
