// The playground world: a fixed, trusted recipe an OUTSIDE controller operates.
//
// This is the substrate for the first hypothesis in docs/agents-as-users.md —
// "an external agent can inspect, diagnose, repair, run and fork a LangECS
// world through a small protocol" — so the recipe is deliberately hand-written,
// deterministic and model-free. What it does have is three things that go wrong
// in exactly the ways emergent control flow goes wrong, each a scenario the
// controller has to find and fix from the outside:
//
//   1. QUIET BUT INCOMPLETE — a ticket that never gets assigned because it lacks
//      the `Sla` component `assign*` queries. Nothing fails; the world is simply
//      done with it. (`explain` shows the missing positive term.)
//   2. PARKED ON A HUMAN — a high-priority ticket escalates to an approval
//      interrupt; the run quiesces `'pending'` and `assignLow` is visibly vetoed
//      by its guard. (`resume` is the trusted way out.)
//   3. CONFLICT AFTER WORK — a ticket carrying both `Vip` and `Rush` makes two
//      labellers `set` the same plain `Label` in one step: the barrier rejects
//      the whole run (R30), naming both systems. (A data-level repair — drop one
//      tag — lets the run commit.)
//
// The model resource is used only by prompt systems the controller installs
// (authoring is opt-in on the server). With no API key a policy model answers.

import {
  AwaitingHuman,
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  HumanResponse,
  interrupt,
  MemoryAdapter,
  type Model,
  type Msg,
  Not,
  type World,
} from '@langecs/core';
import { Goal, Phase } from '@langecs/stdlib';

export const MODEL_RESOURCE = 'model:playground';
export const WORLD_ID = 'playground';

// ------------------------------------------------------------- components

export type Queue = 'billing' | 'tech' | 'general';
export type Priority = 'low' | 'high';

/** The work item. */
export const Ticket = defineComponent<{ id: string; text: string; customer: string }>({
  name: 'pg.Ticket',
});
/** Service-level target; `assign*` require it, so a ticket without one is never assigned. */
export const Sla = defineComponent<{ hours: number }>({ name: 'pg.Sla' });
export const Triage = defineComponent<{ queue: Queue; priority: Priority }>({ name: 'pg.Triage' });
export const Assignment = defineComponent<{ agent: string }>({ name: 'pg.Assignment' });
export const Reply = defineComponent<{ text: string }>({ name: 'pg.Reply' });
/**
 * A plain (reducer-less) component two labellers may both `set` — the latent
 * conflict. Plain on purpose: R30 turns the double write into a rejection
 * instead of silent last-write-wins, and that rejection is scenario 3.
 */
export const Label = defineComponent<string>({ name: 'pg.Label' });
export const Vip = defineTag('pg.Vip');
export const Rush = defineTag('pg.Rush');
export const Approved = defineTag('pg.Approved');
export const Closed = defineTag('pg.Closed');

// ---------------------------------------------------------------- systems

const classify = (text: string): { queue: Queue; priority: Priority } => {
  const t = text.toLowerCase();
  const queue: Queue = /refund|invoice|charge|billing/.test(t)
    ? 'billing'
    : /crash|error|bug|down|broken/.test(t)
      ? 'tech'
      : 'general';
  const priority: Priority = /urgent|down|asap|outage/.test(t) ? 'high' : 'low';
  return { queue, priority };
};

/** Classifies once per ticket (Not(Triage) makes it one-shot). */
export const triage = defineSystem({
  name: 'triage',
  query: [Ticket, Not(Triage)],
  run: (e) => {
    e.set(Triage, classify(e.get(Ticket).text));
    e.set(Phase, 'triaged');
  },
});

/** High priority parks on a human: one interrupt, then quiescence (R33). */
export const escalate = defineSystem({
  name: 'escalate',
  query: [Ticket, Triage, Not(Approved), Not(AwaitingHuman), Not(HumanResponse), Not(Closed)],
  when: (e) => e.get(Triage).priority === 'high',
  run: (e) => {
    e.add(
      AwaitingHuman,
      interrupt('escalation', {
        ticket: e.get(Ticket).id,
        reason: 'high priority needs a human go-ahead before assignment',
      }).value,
    );
    e.set(Phase, 'awaiting approval');
  },
});

/** Consumes the human's answer: approve → Approved; deny → Closed with a reply. */
export const approve = defineSystem({
  name: 'approve',
  query: [HumanResponse, Triage],
  run: (e) => {
    const value = e.get(HumanResponse).value as { approved?: boolean; reason?: string } | boolean;
    const approved = value === true || (typeof value === 'object' && value?.approved === true);
    if (approved) {
      e.add(Approved);
      e.set(Phase, 'approved');
    } else {
      e.set(Reply, { text: 'Declined by a human reviewer.' });
      e.add(Closed);
      e.set(Phase, 'declined');
    }
    e.remove(HumanResponse);
  },
});

const agentFor = (queue: Queue): string =>
  queue === 'billing' ? 'billing-desk' : queue === 'tech' ? 'oncall-engineer' : 'front-desk';

/** Low priority: needs an Sla; the guard vetoes high priority (visible in the trace). */
export const assignLow = defineSystem({
  name: 'assignLow',
  query: [Triage, Sla, Not(Assignment), Not(Closed)],
  when: (e) => e.get(Triage).priority === 'low',
  run: (e) => {
    e.set(Assignment, { agent: agentFor(e.get(Triage).queue) });
    e.set(Phase, 'assigned');
  },
});

/** High priority: assigned only once Approved has arrived (routing by query, not by guard). */
export const assignHigh = defineSystem({
  name: 'assignHigh',
  query: [Triage, Sla, Approved, Not(Assignment), Not(Closed)],
  run: (e) => {
    e.set(Assignment, { agent: `senior-${agentFor(e.get(Triage).queue)}` });
    e.set(Phase, 'assigned');
  },
});

/** Drafts a reply once assigned. */
export const draft = defineSystem({
  name: 'draft',
  query: [Ticket, Assignment, Not(Reply), Not(Closed)],
  run: (e) => {
    e.set(Reply, {
      text: `Hi ${e.get(Ticket).customer}, ${e.get(Assignment).agent} is on it and will follow up shortly.`,
    });
    e.set(Phase, 'replied');
  },
});

/** A replied ticket closes. */
export const close = defineSystem({
  name: 'close',
  query: [Reply, Not(Closed)],
  run: (e) => {
    e.add(Closed);
    e.set(Phase, 'closed');
  },
});

/** Labels VIP tickets. Both labellers `set` the same plain `Label` — see scenario 3. */
export const labelVip = defineSystem({
  name: 'labelVip',
  query: [Ticket, Vip, Not(Label)],
  run: (e) => e.set(Label, 'vip'),
});

export const labelRush = defineSystem({
  name: 'labelRush',
  query: [Ticket, Rush, Not(Label)],
  run: (e) => e.set(Label, 'rush'),
});

/**
 * What each system is for, in the recipe author's words. `explain` returns this
 * verbatim: guards are code, and the protocol never evaluates a guard to answer
 * "why not" (a guard may have side effects only its author knows about), so the
 * author's description is the evidence a controller gets about what a guard
 * checks.
 */
export const SYSTEM_NOTES: Record<string, string> = {
  triage: 'Classifies a Ticket into a queue and priority by keyword. One-shot: Not(Triage).',
  escalate:
    'High-priority tickets park on an "escalation" interrupt (AwaitingHuman) until a human resumes.',
  approve:
    'Consumes HumanResponse: approved → adds Approved; denied → Reply + Closed. Removes HumanResponse.',
  assignLow:
    'Assigns tickets that carry Triage AND Sla. Guard: priority must be "low" — a high-priority ticket is vetoed here and waits for assignHigh.',
  assignHigh: 'Assigns high-priority tickets once Approved is present (also requires Sla).',
  draft: 'Writes a Reply for an assigned ticket.',
  close: 'Adds Closed once a Reply exists.',
  labelVip: 'Sets the plain Label component to "vip" for Vip tickets.',
  labelRush:
    'Sets the plain Label component to "rush" for Rush tickets. Together with labelVip on one ticket this is a WriteConflictError (R30).',
};

// ------------------------------------------------------------------ model

/**
 * A stateless policy model for installed prompt systems when no API key is set.
 * It cannot author real proposals, so it returns an empty, valid one and says so
 * — the run stays honest instead of pretending.
 */
export function policyModel(): Model {
  const reply = (): Msg => ({
    role: 'assistant',
    content:
      '{"writes": {}, "note": "policy model: set OPENAI_API_KEY for a real model; no proposal made"}',
  });
  return {
    async generate() {
      return { message: reply(), finishReason: 'stop' };
    },
  };
}

// ------------------------------------------------------------------ world

/**
 * Registers the hand-written recipe on a world, in a FIXED order (barrier apply
 * order follows registration, R25 step 6; `forkFromSnapshot` replays this
 * exact function for every fork).
 */
export function buildRecipe(world: World, model: Model = policyModel()): void {
  for (const system of [
    triage,
    escalate,
    approve,
    assignLow,
    assignHigh,
    draft,
    close,
    labelVip,
    labelRush,
  ]) {
    world.use(system);
  }
  world.register(MODEL_RESOURCE, model);
}

export interface PlaygroundWorld {
  world: World;
  adapter: MemoryAdapter;
}

/** A world with the recipe installed and the three scenarios seeded (idle, unrun). */
export function createPlaygroundWorld(opts?: {
  model?: Model;
  adapter?: MemoryAdapter;
  id?: string;
}): PlaygroundWorld {
  const adapter = opts?.adapter ?? new MemoryAdapter();
  const world = createWorld({ id: opts?.id ?? WORLD_ID, persistence: adapter });
  buildRecipe(world, opts?.model ?? policyModel());
  // Scenario 0 — the happy path, for contrast.
  world.spawn(
    Ticket({ id: 'T-100', text: 'Please refund my duplicate charge', customer: 'Ada' }),
    Sla({ hours: 24 }),
    Rush(),
    Goal('refund the duplicate charge'),
    Phase('new'),
  );
  // Scenario 1 — quiet but incomplete: no Sla, so assign* never match.
  world.spawn(
    Ticket({ id: 'T-101', text: 'How do I export my data?', customer: 'Grace' }),
    Goal('answer the export question'),
    Phase('new'),
  );
  // Scenario 2 — parked on a human: high priority escalates.
  world.spawn(
    Ticket({ id: 'T-102', text: 'URGENT: the site is down for all our users', customer: 'Linus' }),
    Sla({ hours: 1 }),
    Goal('restore service'),
    Phase('new'),
  );
  return { world, adapter };
}

/**
 * Scenario 3 on demand: a ticket both labellers want to label. Spawn it idle,
 * then run — the barrier rejects with a `WriteConflictError` naming
 * `labelVip` and `labelRush`. Kept out of the seed so the seed run commits.
 */
export function spawnConflictTicket(world: World): { id: number } {
  return world.spawn(
    Ticket({ id: 'T-103', text: 'Invoice looks wrong', customer: 'Margaret' }),
    Sla({ hours: 48 }),
    Vip(),
    Rush(),
    Goal('fix the invoice'),
    Phase('new'),
  );
}
