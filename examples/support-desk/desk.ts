// The support-desk domain, shared by main.ts and the tests.
//
// ENTITIES ARE NOT ONLY AGENTS: every customer ticket is an entity holding
// pure data, and every "worker" (triage, the two specialists, the watchdog)
// is a stateless system swept across whatever tickets match its query. There
// is no per-ticket agent, no router node, and no graph — the choreography is
// entirely query matching + dirty triggers.

import {
  AwaitingHuman,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  HumanResponse,
  interrupt,
  type Model,
  Not,
  type World,
} from '@langecs/core';
import { extractJson } from '@langecs/stdlib';

// ---------------------------------------------------------------- components

export type Category = 'billing' | 'technical';
export type Priority = 1 | 2 | 3;

/** A triage verdict — the model's, or the human's after an escalation. */
export type TriageResult = { category: Category; priority: Priority; confidence: number };

/** What the human passes to `world.resume(ticket, ...)` for an escalated ticket. */
export type HumanVerdict = { category: Category; priority?: Priority };

/** One customer ticket: pure data. Not an agent — no prompt, no model, no loop. */
export const Ticket = defineComponent<{ from: string; subject: string; body: string }>({
  name: 'Ticket',
});

/** The triage verdict; its very presence is what routes a ticket onward. */
export const Triaged = defineComponent<TriageResult>({ name: 'Triaged' });

/** The drafted answer to the customer. */
export const Reply = defineComponent<string>({ name: 'Reply' });

/** Workflow marker: a specialist has handled this ticket. */
export const Drafted = defineTag('Drafted');

/** Stamped by the SLA watchdog on priority-1 tickets still waiting for a reply. */
export const SlaRisk = defineComponent<{ flaggedAtStep: number }>({ name: 'SlaRisk' });

/** The one model the whole desk shares (typed ref — no stringly-typed hops). */
export const DeskModel = defineResource<Model>('model:desk');

/** Below this triage confidence, the ticket is escalated to the human queue. */
export const CONFIDENCE_FLOOR = 0.7;

// ------------------------------------------------------------------- systems

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: { enum: ['billing', 'technical'] },
    priority: { type: 'integer', minimum: 1, maximum: 3, description: '1 = most urgent' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['category', 'priority', 'confidence'],
};

/**
 * Classifies untriaged tickets. Every freshly spawned ticket matches
 * `[Ticket, Not(Triaged)]` at once, so the first step runs one classification
 * per ticket CONCURRENTLY — fan-out without a loop anywhere.
 */
export const triage = defineSystem({
  name: 'triage',
  query: [Ticket, Not(Triaged)],
  run: async (e, ctx) => {
    const ticket = e.get(Ticket);
    const verdict = await extractJson<TriageResult>(ctx.resource(DeskModel), {
      system:
        'You triage customer support tickets. priority: 1 = outage/urgent, 3 = minor. ' +
        'confidence is YOUR certainty in the category: report it below 0.7 whenever ' +
        'the ticket is garbled, vague, or could plausibly be either category.',
      prompt: `From: ${ticket.from}\nSubject: ${ticket.subject}\n\n${ticket.body}`,
      schema: TRIAGE_SCHEMA,
      schemaName: 'Triage',
    });
    // Triaged appearing un-matches this pair and newly-matches the specialists
    // and the watchdog — that hand-off IS the routing; there are no edges.
    e.set(Triaged, verdict);
    if (verdict.confidence < CONFIDENCE_FLOOR) {
      // Park only THIS ticket in the human queue: AwaitingHuman makes the run
      // quiesce as 'pending', and the specialists' Not(AwaitingHuman) term
      // keeps them away — the confident tickets complete undisturbed.
      e.add(AwaitingHuman, interrupt('triage-escalation', { guess: verdict }).value);
    }
  },
});

/**
 * A specialist is NOT an agent spawned per ticket — it is one system (one
 * persona, one model call) swept across every ticket its guard claims. Both
 * specialists wake on the same dirt (Triaged appearing); the `when` guard is
 * the router, and the losing lane's veto simply consumes its dirt.
 */
function specialist(name: string, category: Category, persona: string) {
  return defineSystem({
    name,
    // Not(Drafted): one reply per ticket. Not(AwaitingHuman)/Not(HumanResponse):
    // an escalated ticket stays out of the specialist lanes until the human's
    // verdict has been applied (applyHumanTriage below).
    query: [Ticket, Triaged, Not(Drafted), Not(AwaitingHuman), Not(HumanResponse)],
    when: (e) => e.get(Triaged).category === category,
    run: async (e, ctx) => {
      const ticket = e.get(Ticket);
      const result = await ctx.resource(DeskModel).generate({
        system: persona,
        messages: [
          {
            role: 'user',
            content:
              `Subject: ${ticket.subject}\n\n${ticket.body}\n\n` +
              `Write a short reply (2 sentences max) to ${ticket.from}.`,
          },
        ],
      });
      e.set(Reply, result.message.content);
      e.add(Drafted);
    },
  });
}

export const respondBilling = specialist(
  'respondBilling',
  'billing',
  'You are the billing specialist of a support desk: refunds, invoices, charges.',
);

export const respondTechnical = specialist(
  'respondTechnical',
  'technical',
  'You are the technical support engineer of a support desk: outages, bugs, APIs.',
);

/**
 * Global sweep over triaged-but-unanswered tickets. It fires in the SAME step
 * as the specialists (all woke on Triaged appearing) and reads the same
 * step-start state — where no draft exists yet (R17 isolation) — so a
 * priority-1 ticket is flagged deterministically even though its reply lands
 * at the same barrier. Once Drafted commits, the query un-matches and it rests.
 */
export const slaWatchdog = defineSystem({
  name: 'slaWatchdog',
  query: [Ticket, Triaged, Not(Drafted)],
  when: (e) => e.get(Triaged).priority === 1,
  run: (e, ctx) => {
    e.set(SlaRisk, { flaggedAtStep: ctx.step });
  },
});

/**
 * Consumes the human's `world.resume(...)` verdict: resume removed
 * AwaitingHuman and set HumanResponse — a brand-new match for this system.
 * Replacing Triaged (foreign dirt on the watchdog) and removing HumanResponse
 * (the specialists' Not() term) is exactly what re-opens the ticket for the
 * right specialist on the next step.
 */
export const applyHumanTriage = defineSystem({
  name: 'applyHumanTriage',
  query: [Ticket, HumanResponse],
  run: (e) => {
    const verdict = e.get(HumanResponse).value as HumanVerdict;
    const guess = e.get(Triaged);
    e.set(Triaged, {
      category: verdict.category,
      priority: verdict.priority ?? guess?.priority ?? 2,
      confidence: 1, // a human said so
    });
    e.remove(HumanResponse); // consumed (R33 convention)
  },
});

/** Registers the desk model and the five desk systems. Tickets come separately. */
export function setupDesk(world: World, model: Model): void {
  world.register(DeskModel, model);
  for (const system of [triage, respondBilling, respondTechnical, slaWatchdog, applyHumanTriage]) {
    world.use(system);
  }
}
