// Deterministic choreography tests for the support-desk example. Core
// scriptedModel only — zero network. Every scripted turn is the same
// dispatcher keyed on request CONTENT, so the assertions never depend on the
// order in which concurrently-executing pairs happen to call the model; the
// turn count (8) doubles as a budget — one extra model call throws.

import { createWorld, type ModelRequest, type Msg, scriptedModel, type World } from '@langecs/core';
import { expect, test } from 'vitest';
import { Drafted, Reply, SlaRisk, setupDesk, Ticket, Triaged } from './desk';

/** Answers ANY desk request: triage JSON by body keyword, replies by persona. */
function answer(req: ModelRequest): Msg {
  const text = req.messages.map((m) => m.content).join('\n');
  // extractJson marks its requests with the strict-JSON system directive.
  if (req.system?.includes('ONLY a single valid JSON')) {
    const verdict = text.includes('two identical charges')
      ? { category: 'billing', priority: 2, confidence: 0.95 }
      : text.includes('webhook')
        ? { category: 'technical', priority: 2, confidence: 0.9 }
        : text.includes('offline')
          ? { category: 'technical', priority: 1, confidence: 0.98 }
          : { category: 'technical', priority: 3, confidence: 0.4 }; // the garbled one
    return { role: 'assistant', content: JSON.stringify(verdict) };
  }
  const lane = req.system?.includes('billing specialist') ? 'BILLING' : 'TECH';
  const subject = /Subject: (.*)/.exec(text)?.[1] ?? '?';
  return { role: 'assistant', content: `${lane}: re "${subject}"` };
}

/** Fresh desk world + the four tickets from main.ts, as named handles. */
function newDesk() {
  const world: World = createWorld({ id: 'support-desk-test' });
  setupDesk(world, scriptedModel(Array.from({ length: 8 }, () => answer)));
  return {
    world,
    billing: world.spawn(
      Ticket({ from: 'dana@acme.io', subject: 'Charged twice', body: 'two identical charges' }),
    ),
    webhook: world.spawn(
      Ticket({ from: 'raj@blue.dev', subject: 'Webhooks 500', body: 'webhook returns 500' }),
    ),
    outage: world.spawn(
      Ticket({ from: 'mei@flux.gg', subject: 'PRODUCTION DOWN', body: 'site is offline' }),
    ),
    garbled: world.spawn(
      Ticket({ from: 'sam@vex.org', subject: 'hi', body: 'it dont work??? also moneys??' }),
    ),
  };
}

test('triage fans out in one step; specialists route by guard; watchdog flags P1', async () => {
  const { world, billing, webhook, outage, garbled } = newDesk();
  const result = await world.run();

  // The garbled ticket escalated, so the RUN is pending — yet only 2 steps ran
  // and, as asserted below, the other three tickets are fully answered.
  expect(result.status).toBe('pending');
  expect(result.steps).toBe(2);

  const trace = world.getTrace();
  // Step 1: ALL four tickets triaged concurrently — one (triage, ticket) pair each.
  expect(trace[0]?.runs.map((r) => `${r.system}@${r.entity}`).sort()).toEqual(
    [billing, webhook, outage, garbled].map((t) => `triage@${t.id}`).sort(),
  );

  // Step 2: routing. respondBilling ran ONLY on the billing ticket; the losing
  // lane's pair was guard-vetoed (dirt consumed, no model call burned).
  const ran = trace[1]?.runs.map((r) => `${r.system}@${r.entity}`) ?? [];
  const vetoed = trace[1]?.vetoed.map((v) => `${v.system}@${v.entity}`) ?? [];
  expect(ran.filter((p) => p.startsWith('respondBilling@'))).toEqual([
    `respondBilling@${billing.id}`,
  ]);
  expect(ran).toContain(`respondTechnical@${webhook.id}`);
  expect(ran).toContain(`respondTechnical@${outage.id}`);
  expect(vetoed).toContain(`respondTechnical@${billing.id}`);
  expect(vetoed).toContain(`respondBilling@${webhook.id}`);
  // The escalated ticket reached NO specialist, not even as a veto: its
  // AwaitingHuman fails the specialists' Not() term, so the pairs never match.
  expect(
    [...ran, ...vetoed].some((p) => p.startsWith('respond') && p.endsWith(`@${garbled.id}`)),
  ).toBe(false);

  // The watchdog fired in the SAME step as the specialists — it read the
  // step-start state, where no draft existed yet — and only on the P1 ticket.
  expect(ran).toContain(`slaWatchdog@${outage.id}`);
  expect(outage.get(SlaRisk)).toEqual({ flaggedAtStep: 2 });
  expect(billing.has(SlaRisk)).toBe(false);
  expect(webhook.has(SlaRisk)).toBe(false);

  // Replies landed in the right lanes.
  expect(billing.get(Reply)).toBe('BILLING: re "Charged twice"');
  expect(webhook.get(Reply)).toBe('TECH: re "Webhooks 500"');
  expect(outage.get(Reply)).toBe('TECH: re "PRODUCTION DOWN"');
});

test('escalation pauses one ticket; resume routes it by the HUMAN category', async () => {
  const { world, billing, webhook, outage, garbled } = newDesk();
  await world.run();

  // Pending is per-entity: the garbled ticket is parked with the model's
  // uncertain guess and no reply, while the other three are already answered.
  expect(world.pending()).toEqual([
    {
      entity: garbled.id,
      interrupts: [expect.objectContaining({ kind: 'triage-escalation' })],
    },
  ]);
  expect(garbled.get(Triaged)).toEqual({ category: 'technical', priority: 3, confidence: 0.4 });
  expect(garbled.has(Reply)).toBe(false);
  expect(garbled.has(Drafted)).toBe(false);
  for (const done of [billing, webhook, outage]) expect(done.has(Reply)).toBe(true);

  // The human overrides the model's guess: billing, not technical.
  const resumed = await world.resume(garbled, { category: 'billing', priority: 2 });
  expect(resumed.status).toBe('done');
  expect(resumed.steps).toBe(2); // applyHumanTriage, then the billing lane

  expect(garbled.get(Triaged)).toEqual({ category: 'billing', priority: 2, confidence: 1 });
  expect(garbled.get(Reply)).toBe('BILLING: re "hi"'); // the HUMAN's lane won
  expect(world.pending()).toEqual([]);

  // Resume choreography: the verdict is applied first (HumanResponse blocks
  // the specialists via Not()), THEN only the billing lane fires.
  const resumeSteps = world.getTrace().slice(-2);
  expect(resumeSteps[0]?.runs.map((r) => r.system)).toEqual(['applyHumanTriage']);
  expect(resumeSteps[1]?.runs.map((r) => `${r.system}@${r.entity}`)).toEqual([
    `respondBilling@${garbled.id}`,
  ]);
  expect(resumeSteps[1]?.vetoed.map((v) => v.system).sort()).toEqual([
    'respondTechnical',
    'slaWatchdog',
  ]);
});
