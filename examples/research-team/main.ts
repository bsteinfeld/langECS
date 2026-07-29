// Research team demo — one question in, a dynamic team out: the planner
// decomposes it and spawns a researcher agent per sub-question, researchers
// fill a shared blackboard, the critic may send one back for revision, the
// synthesizer writes the final answer. A global token budget can stop the
// whole team at any point (the default budget is far above what this run
// spends — shrink it to watch the graceful halt).
//
// Run:  pnpm -C examples research-team [--trace]
// Needs OPENAI_API_KEY in the repo-root .env.local.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, formatTrace } from '@langecs/core';
import { narrateWorld } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import {
  Answer,
  BudgetExceeded,
  Findings,
  latestFindings,
  Plan,
  Question,
  ResearchModel,
  spentTokens,
  TokenUsage,
} from './blackboard';
import { spawnResearchTeam } from './team';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'research-team-demo' });
world.register(ResearchModel, fromAiSdk(openai('gpt-4o-mini')));
const board = spawnResearchTeam(world);

const question =
  'Why did the Concorde fail commercially, and what would supersonic passenger flight need to return?';
console.log(`question> ${question}`);
console.log('working… (planner → researchers → critic → synthesizer)');

const result = await world.send(board, Question(question));

// Everything below just reads committed state off the blackboard.
console.log(`\nrun: status=${result.status}, steps=${result.steps}`);

const plan = board.get(Plan) ?? [];
console.log('\nsub-questions');
for (const [i, sub] of plan.entries()) console.log(`  ${i + 1}. ${sub}`);

const latest = latestFindings(board.get(Findings) ?? []);
console.log('\nfindings');
for (const [i] of plan.entries()) {
  const finding = latest.get(i);
  console.log(
    `  ${i + 1}. ${finding === undefined ? '(missing)' : `${finding.revised ? '[revised] ' : ''}${finding.text}`}`,
  );
}

console.log('\nanswer');
console.log(board.get(Answer) ?? '(no final answer — the team was stopped early)');

const exceeded = board.get(BudgetExceeded);
if (exceeded !== undefined) {
  console.log(
    `\nbudget exceeded: ~${exceeded.spent} of ${exceeded.budget} tokens — partial results above`,
  );
}
console.log(`tokens spent: ~${spentTokens(board.get(TokenUsage) ?? [])}`);

if (process.argv.includes('--trace')) console.log(`\n${formatTrace(world.getTrace())}`);

// What the world would say it is doing — `Phase`/`Goal` are components with no
// scheduling role (R64), so this costs the engine nothing and is readable at any
// moment, including mid-run from another process via the snapshot.
console.log('\n--- what the team is doing ---');
for (const line of narrateWorld(world)) console.log(`  ${line.sentence}`);
