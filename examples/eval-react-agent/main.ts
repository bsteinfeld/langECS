// Optional gated real-model run of the reactAgent eval suite (EVAL-05, CI-04).
//
// Run with: pnpm -C examples eval-react-agent
// Needs OPENAI_API_KEY in the repo-root .env.local.
//
// This is the ONLY place the real model + env wiring lives — the .test.ts gate
// never reads OPENAI_API_KEY. The same `runEvalSuite` call drives the suite; the
// only difference is `opts.realModel`, used ONLY when a key is present (the
// harness falls back to the scripted path otherwise — one switch, no edits).

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { runEvalSuite } from '@langecs/eval';
import { loadEnvLocal } from '../_shared/env';
import { MODEL } from '../react-agent/agent';
import { reactAgentDataset, spawnReactAgent } from './suite';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'eval-react-agent-live' });

console.log(`Running reactAgent eval suite (${reactAgentDataset.length} cases) against ${MODEL}…`);

const result = await runEvalSuite(world, reactAgentDataset, {
  wireAgent: spawnReactAgent,
  realModel: fromAiSdk(openai(MODEL)),
  scoreThreshold: 1.0,
  passThreshold: 1.0,
});

for (const c of result.cases) {
  console.log(`  [${c.verdict.toUpperCase()}] ${c.id} (score ${c.score}) -> ${c.output}`);
}
console.log(
  `\npassRate ${(result.passRate * 100).toFixed(0)}% (${result.passed}/${result.total}); ` +
    `meanScore ${result.meanScore.toFixed(2)}; threshold ${result.passThreshold}`,
);

if (result.passRate < result.passThreshold) {
  console.error('\nSuite did not clear its pass threshold.');
  process.exit(1);
}
console.log('\nSuite passed.');
