// Live code-review crew over one Pr entity. One send schedules all three
// reviewer lenses into the SAME step (they share the [Pr] query); the barrier
// merges their findings, dedupe collapses cross-lens duplicates in pure code,
// and the lead verdict writes the review. Four model calls, three steps,
// zero graph wiring.
//
//   pnpm -C examples code-review-crew [--trace]
//
// Needs OPENAI_API_KEY in <repo-root>/.env.local.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, formatTrace } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { Deduped, DIFF, Findings, Pr, Review, ReviewModel, reviewCrew } from './crew';

loadEnvLocal();
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY — add it to <repo-root>/.env.local to run this demo.');
  process.exit(1);
}

const world = createWorld({ id: 'code-review-crew' });
world.register(ReviewModel, fromAiSdk(openai('gpt-4o-mini')));

const pr = world.spawn(reviewCrew);
const result = await world.send(
  pr,
  Pr({ title: 'Add user search + duplicate-email report', diff: DIFF }),
);

// --- the review, printed like a PR comment thread ---
const raw = pr.get(Findings) ?? [];
const merged = pr.get(Deduped) ?? [];
const review = pr.get(Review);

console.log('PR #42 — Add user search + duplicate-email report');
console.log(
  `${result.steps} steps · ${raw.length} raw findings from 3 reviewers · ${merged.length} after dedupe\n`,
);
for (const finding of merged) {
  console.log(
    `  [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} — ${finding.title}`,
  );
  console.log(`  flagged by: ${finding.reviewers.join(' + ')}`);
  console.log(`  ${finding.detail}\n`);
}
console.log(review?.verdict === 'approve' ? '>> APPROVED' : '>> CHANGES REQUESTED');
console.log(review?.summary ?? '(no review produced)');

if (process.argv.includes('--trace')) {
  console.log('\n=== flight recorder ===\n');
  console.log(formatTrace(world.getTrace()));
}
