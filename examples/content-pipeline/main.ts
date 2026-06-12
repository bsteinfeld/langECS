// Content pipeline — a staged fan-out/fan-in workflow with no orchestrator.
//
//   Brief ─▶ outline ─▶ draftSections (spawns one Section entity per heading)
//         ─▶ drafter ×3, ALL IN ONE STEP (parallel model calls, free)
//         ─▶ assemble (once every slot is in) ─▶ editor ─▶ Published
//
// Run with: pnpm -C examples content-pipeline   (OPENAI_API_KEY in repo-root .env.local)
// Append --trace for one timing line per stage, straight from the flight recorder.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { Brief, Published, pipeline, WriterModel } from './pipeline';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'content-pipeline' });
world.register(WriterModel, fromAiSdk(openai('gpt-4o-mini')));
for (const stage of pipeline) world.use(stage);

// The pipeline's entire input is one component on one entity. Everything that
// happens next is systems reacting to the data the previous stage produced.
const post = world.spawn();
const result = await world.send(
  post,
  Brief(
    'Why entity-component-system architecture is a natural fit for LLM agent ' +
      'workflows. Audience: TypeScript developers. Tone: practical, lightly opinionated.',
  ),
);

if (result.status !== 'done') {
  console.error(`Pipeline did not finish cleanly: status '${result.status}' — see --trace.`);
  process.exit(1);
}

console.log(post.get(Published) ?? '(nothing published)');

if (process.argv.includes('--trace')) {
  // One line per step = one line per stage. Note the single step with 3 drafter runs.
  for (const s of world.getTrace()) {
    const stage = [...new Set(s.runs.map((r) => r.system))].join('+');
    console.log(`step ${s.step}  ${stage} ×${s.runs.length}  ${s.durationMs.toFixed(0)}ms`);
  }
}
