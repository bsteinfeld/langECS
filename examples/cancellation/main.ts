// Stopping work that is already in flight, in two acts.
//
//   Act 1 — timeouts.      Four jobs run; one source hangs. Its pair is
//                          abandoned at its deadline instead of hanging the
//                          barrier forever, and the stdlib retry system heals it
//                          because a timeout is an ordinary error.
//   Act 2 — cancellation.  A second batch is stopped mid-flight. The open HTTP
//                          requests are actually cancelled (ctx.signal), the
//                          finished work survives, and the reason is queryable
//                          state rather than a log line.
//
//   pnpm -C examples cancellation           # both acts
//   pnpm -C examples cancellation --trace   # + the flight recorder
//
// Needs OPENAI_API_KEY in the repo-root .env.local. The deterministic version of
// the same choreography is in cancellation.test.ts and needs no key at all.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { Cancelled, formatTrace, SystemError } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { buildWorld, Job, Notes, report, spawnJobs } from './pipeline';

loadEnvLocal();

const model = () => fromAiSdk(openai('gpt-4o-mini'));
/** Comfortably longer than a healthy gpt-4o-mini reply, shorter than a hang. */
const TIMEOUT_MS = 6_000;
/** Long enough for the calls to be open, short enough to be a demo. */
const STOP_AFTER_MS = 900;

const table = (rows: { topic: string; status: string; notes?: string }[]): void => {
  console.log(`\n${'topic'.padEnd(38)} status`);
  console.log('-'.repeat(58));
  for (const row of rows) {
    console.log(`${row.topic.padEnd(38)} ${row.status}`);
    if (row.notes !== undefined) {
      console.log(`${' '.repeat(38)} ${row.notes.replaceAll('\n', ' ').slice(0, 88)}`);
    }
  }
};

// ---------------------------------------------------------------- act 1
console.log('=== Act 1: one source hangs; the deadline turns it into a healable error ===');

const timeouts = buildWorld({ model: model(), timeoutMs: TIMEOUT_MS });
spawnJobs(timeouts, [
  { topic: 'entity-component-system scheduling', source: 'fast' },
  { topic: 'dirty-flag change detection', source: 'flaky' }, // hangs once, then heals
  { topic: 'structural typing in TypeScript', source: 'fast' },
  { topic: 'optimistic concurrency control', source: 'fast' },
]);

const act1 = await timeouts.run();
console.log(`\nrun ${act1.status} after ${act1.steps} step(s)`);
const timedOut = timeouts
  .getTrace()
  .flatMap((s) => s.runs)
  .filter((r) => r.error?.name === 'SystemTimeoutError');
console.log(
  `${timedOut.length} pair(s) abandoned at the ${TIMEOUT_MS}ms deadline, then re-armed by retry; ` +
    'R32 cleared the record when the retry succeeded, so nothing is left behind.',
);
table(report(timeouts));

// ---------------------------------------------------------------- act 2
console.log('\n\n=== Act 2: stop the batch while the calls are open ===');

const cancelled = buildWorld({ model: model(), timeoutMs: TIMEOUT_MS });
const jobs = spawnJobs(cancelled, [
  { topic: 'write-ahead logging', source: 'fast' },
  { topic: 'vector clocks', source: 'fast' },
  { topic: 'CRDT convergence', source: 'fast' },
]);

const run = cancelled.run();

// The stop button. `cancel` is the one external mutation legal mid-run: it aborts
// every pair's ctx.signal — so the provider requests are genuinely cancelled —
// and stamps `Cancelled` as an engine write at the next step boundary.
const stop = setTimeout(() => {
  const inFlight = cancelled.runningPairs();
  console.log(`\n--- stopping after ${STOP_AFTER_MS}ms; ${inFlight.length} pair(s) in flight ---`);
  for (const pair of inFlight) {
    console.log(`    ${pair.system}#${pair.entity} running ${pair.elapsedMs.toFixed(0)}ms`);
  }
  cancelled.cancel(`operator stopped the batch after ${STOP_AFTER_MS}ms`);
}, STOP_AFTER_MS);

const act2 = await run;
clearTimeout(stop);

console.log(`\nrun ${act2.status} after ${act2.steps} step(s)`);
// Aborting an open call makes it throw — but the engine deliberately records no
// SystemError for it, so this is 'cancelled' rather than 'error' and the retry
// system does not restart what was just stopped.
console.log(
  `errors recorded: ${act2.errors.length} ` +
    `(entities still carrying SystemError: ${cancelled.query(SystemError).length})`,
);
table(report(cancelled));

console.log(
  '\nWhy it stopped is queryable state, not a log line — and it is in every ' +
    'snapshot for free, because cancellation is just a component:\n' +
    `  ${JSON.stringify(cancelled.entity(jobs[0]?.id ?? 0)?.get(Cancelled) ?? null)}`,
);
console.log(
  `\nUn-cancelling is removing the component. Finished notes are untouched by ` +
    `either operation: ${cancelled.query(Job, Notes).length} of ${jobs.length} survived the stop.`,
);

if (process.argv.includes('--trace')) {
  console.log(`\n--- act 1 flight recorder ---\n${formatTrace(timeouts.getTrace())}`);
  console.log(`\n--- act 2 flight recorder ---\n${formatTrace(cancelled.getTrace())}`);
}
