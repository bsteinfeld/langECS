// Support desk — ENTITIES ARE NOT ONLY AGENTS.
//
// Four customer tickets are spawned as four ENTITIES (pure data). Nothing
// iterates over them: triage classifies all four concurrently in step 1, and
// the specialist systems + SLA watchdog wake on Triaged appearing and sweep
// their lanes in step 2. One garbled ticket escalates to the human queue, so
// the run returns 'pending' — but the pause is per-entity: the other three
// tickets already carry replies when the run comes back.
//
// Run with: pnpm -C examples support-desk     (add --trace for the flight recorder)
// Needs OPENAI_API_KEY in the repo-root .env.local.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { AwaitingHuman, createWorld, formatTrace } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { type HumanVerdict, Reply, SlaRisk, setupDesk, Ticket, Triaged } from './desk';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'support-desk' });
setupDesk(world, fromAiSdk(openai('gpt-4o-mini')));

// Four tickets, four entities. The last one is deliberately garbled so triage
// reports low confidence and escalates it instead of guessing a lane.
const inbox = [
  {
    from: 'dana@acme.io',
    subject: 'Charged twice this month',
    body: 'My May invoice shows two identical charges for the same plan. Please refund one.',
  },
  {
    from: 'raj@blue.dev',
    subject: 'Webhook deliveries failing',
    body: 'Since Tuesday every webhook delivery from your platform returns HTTP 500.',
  },
  {
    from: 'mei@flux.gg',
    subject: 'PRODUCTION DOWN',
    body: 'All API calls time out and our whole site is offline. We are losing orders right now!',
  },
  {
    from: 'sam@vex.org',
    subject: 'hi',
    body: 'it dont work??? also moneys taken maybe?? plz fix asap thx',
  },
];
for (const ticket of inbox) world.spawn(Ticket(ticket));

function printBoard(title: string): void {
  console.log(`\n== ${title} ==`);
  for (const t of world.query(Ticket)) {
    const triaged = t.get(Triaged);
    const lane = triaged === undefined ? 'untriaged' : `${triaged.category} P${triaged.priority}`;
    const sla = t.has(SlaRisk) ? ' [SLA RISK]' : '';
    const outcome = t.has(AwaitingHuman)
      ? `ESCALATED -> human queue (triage confidence ${triaged?.confidence})`
      : (t.get(Reply) ?? '(no reply yet)');
    console.log(`#${t.id} [${lane}${sla}] ${t.get(Ticket).subject}`);
    console.log(`    ${outcome}`);
  }
}

const first = await world.run();
printBoard(`desk board after run #1 (status: ${first.status})`);

// 'pending' above is the RUN's status; the blocking is per-entity. Only the
// escalated ticket holds an AwaitingHuman interrupt — resume answers it with
// a human-provided category and the desk routes it like any other ticket.
const escalations = world.pending();
if (escalations.length === 0) {
  console.log('\n(no escalations this run — the model was confident about every ticket)');
}
for (const { entity, interrupts } of escalations) {
  const guess = (interrupts[0]?.payload as { guess: { category: string; confidence: number } })
    .guess;
  console.log(
    `\nhuman: ticket #${entity} guessed '${guess.category}' at confidence ` +
      `${guess.confidence} — it mentions money, filing as billing P2`,
  );
  await world.resume(entity, { category: 'billing', priority: 2 } satisfies HumanVerdict);
}

printBoard('final desk board');

if (process.argv.includes('--trace')) console.log(`\n${formatTrace(world.getTrace())}`);
