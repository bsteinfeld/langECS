// Token budgets (R63) and narration (R64). Zero network.

import {
  AwaitingHuman,
  Cancelled,
  createWorld,
  defineComponent,
  defineSystem,
  defineTag,
  interrupt,
  type Model,
  Not,
  SystemError,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';
import {
  BudgetExceeded,
  BudgetWarning,
  budgetWatchdog,
  spendOf,
  spentTokens,
  TokenBudget,
  TokenUsage,
} from '../src/budget';
import { Goal, narrate, narrateWorld, Phase } from '../src/narration';

const Task = defineComponent<string>({ name: 'bn.Task' });
const Result = defineComponent<string>({ name: 'bn.Result' });
const Worker = defineTag('bn.Worker');

/** A spender that reports its cost to the shared ledger on the board. */
const spender = (board: () => number) =>
  defineSystem({
    name: 'spender',
    query: [Task, Worker, Not(Result), Not(BudgetExceeded)],
    run: async (e, ctx) => {
      const model = ctx.resource<Model>('model');
      const req = { messages: [{ role: 'user' as const, content: e.get(Task) }] };
      const result = await model.generate(req);
      e.set(Result, result.message.content);
      // Usage lands on the board, which is where the budget lives. Passing `req`
      // bills the prompt too — omitting it made the prompt free.
      ctx.write(board(), TokenUsage, [spendOf('spender', result, req)], 'add');
    },
  });

test('R63 spendOf uses reported usage, and estimates when the provider reports none', () => {
  expect(
    spendOf('s', {
      message: { role: 'assistant', content: 'hi' },
      usage: { inputTokens: 7, outputTokens: 3 },
    }),
  ).toEqual({
    system: 's',
    tokens: 10,
  });
  // scriptedModel reports nothing, so the estimate covers BOTH halves — the
  // prompt used to be billed as zero unless every call site remembered a count.
  const withPrompt = spendOf(
    's',
    { message: { role: 'assistant', content: 'x'.repeat(40) } },
    { messages: [{ role: 'user', content: 'y'.repeat(400) }] },
  );
  const withoutPrompt = spendOf('s', {
    message: { role: 'assistant', content: 'x'.repeat(40) },
  });
  expect(withPrompt.tokens).toBeGreaterThan(withoutPrompt.tokens * 5);
  // An empty reply still costs at least a token — `estimateTokens` charges
  // per-message overhead, so a free call cannot slip past a budget.
  expect(
    spendOf('s', { message: { role: 'assistant', content: '' } }).tokens,
  ).toBeGreaterThanOrEqual(1);
  expect(
    spentTokens([
      { system: 'a', tokens: 2 },
      { system: 'b', tokens: 3 },
    ]),
  ).toBe(5);
});

test('R63 the watchdog stops a shared budget gracefully, keeping committed work', async () => {
  const exceeded: { spent: number; budget: number }[] = [];
  const world = createWorld();
  let boardId = 0;
  world.use(spender(() => boardId));
  world.use(budgetWatchdog({ stampOn: [Worker], onExceeded: (s) => exceeded.push(s) }));
  world.register(
    'model',
    scriptedModel([
      { role: 'assistant', content: 'answer one' },
      { role: 'assistant', content: 'answer two' },
      { role: 'assistant', content: 'answer three' },
    ]),
  );

  // A budget of 0, not 1: `spendOf` floors at 1 token and the guard is strict `>`,
  // so `TokenBudget(1)` only tripped because the scripted replies happened to be
  // long enough. Shortening a turn to <= 4 chars silently stopped asserting a stop.
  const board = world.spawn(TokenBudget(0), TokenUsage([]));
  boardId = board.id;
  const workers = [
    world.spawn(Worker(), Task('a')),
    world.spawn(Worker(), Task('b')),
    world.spawn(Worker(), Task('c')),
  ];

  const result = await world.run();

  // Graceful quiesce: nothing threw, so the run is 'done', not 'error'.
  expect(result.status).toBe('done');
  expect(world.entity(board.id)?.get(BudgetExceeded)).toMatchObject({ budget: 0 });
  expect(exceeded).toHaveLength(1);

  // The work already committed survives — a throw would have discarded it.
  for (const worker of workers) expect(world.entity(worker.id)?.has(Result)).toBe(true);
  // And the brake reached every spender, or their guards would never unmatch.
  for (const worker of workers) expect(world.entity(worker.id)?.has(BudgetExceeded)).toBe(true);
  // Stopping is state, not an exception: no SystemError anywhere.
  expect(result.errors).toEqual([]);
});

test('R63 an under-budget world is never stamped, and the guard writes nothing', async () => {
  const world = createWorld();
  let boardId = 0;
  world.use(spender(() => boardId));
  world.use(budgetWatchdog());
  world.register('model', scriptedModel([{ role: 'assistant', content: 'cheap' }]));
  const board = world.spawn(TokenBudget(1_000_000), TokenUsage([]));
  boardId = board.id;
  const worker = world.spawn(Worker(), Task('a'));

  await world.run();
  expect(world.entity(board.id)?.has(BudgetExceeded)).toBe(false);
  expect(world.entity(worker.id)?.get(Result)).toBe('cheap');
  // The watchdog was scheduled and vetoed — dirt consumed, nothing written.
  const vetoes = world.getTrace().flatMap((s) => s.vetoed.map((v) => v.system));
  expect(vetoes).toContain('budgetWatchdog');
});

test('R63 onApproachingCap fires once at the warning fraction, before the hard stop', async () => {
  const warnings: { spent: number; budget: number }[] = [];
  const world = createWorld();
  world.use(budgetWatchdog({ warnAt: 0.5, onApproachingCap: (s) => warnings.push(s) }));
  const board = world.spawn(TokenBudget(100), TokenUsage([{ system: 's', tokens: 60 }]));

  await world.run();
  expect(world.entity(board.id)?.get(BudgetWarning)).toEqual({ spent: 60, budget: 100 });
  expect(world.entity(board.id)?.has(BudgetExceeded)).toBe(false);
  expect(warnings).toEqual([{ spent: 60, budget: 100 }]);

  // More spend under the cap must not re-warn: re-stamping would churn dirt for
  // no new information.
  world.entity(board.id)?.add(TokenUsage, [{ system: 's', tokens: 5 }]);
  await world.run();
  expect(warnings).toHaveLength(1);

  // Crossing the cap then stamps the hard stop.
  world.entity(board.id)?.add(TokenUsage, [{ system: 's', tokens: 50 }]);
  await world.run();
  expect(world.entity(board.id)?.get(BudgetExceeded)).toEqual({ spent: 115, budget: 100 });
});

test('R64 narrate renders goal, phase, and whichever engine state is in force', () => {
  const world = createWorld();
  const working = world.spawn(Goal('answer the research question'), Phase('synthesizing'));
  const bare = world.spawn(Phase('drafting'));
  const waiting = world.spawn(
    Goal('delete record 42'),
    Phase('awaiting-approval'),
    interrupt('tool-approval'),
  );
  const failed = world.spawn(
    Goal('call the pricing API'),
    Phase('fetching'),
    SystemError([{ system: 'fetch', step: 2, error: { name: 'TypeError', message: 'boom' } }]),
  );
  const stopped = world.spawn(
    Goal('research'),
    Phase('planning'),
    Cancelled({ step: 3, reason: 'user stopped' }),
  );

  expect(narrate(world.entity(working.id) as never).sentence).toBe(
    `#${working.id} aims to answer the research question; is synthesizing`,
  );
  const bareNarration = narrate(world.entity(bare.id) as never);
  expect(bareNarration).toMatchObject({ state: 'working', phase: 'drafting' });
  // A missing goal is omitted rather than rendered as "aims to undefined".
  expect(bareNarration.goal).toBeUndefined();
  expect(bareNarration.sentence).toBe(`#${bare.id} is drafting`);
  expect(narrate(world.entity(waiting.id) as never).sentence).toContain(
    'WAITING for a human (tool-approval)',
  );
  expect(narrate(world.entity(failed.id) as never).sentence).toContain('FAILED in fetch: boom');
  expect(narrate(world.entity(stopped.id) as never).sentence).toContain('CANCELLED: user stopped');
  // Engine state outranks the app's phase: a cancelled entity is not "planning".
  expect(narrate(world.entity(stopped.id) as never).state).toBe('cancelled');
  expect(world.entity(waiting.id)?.has(AwaitingHuman)).toBe(true);
});

test('R64 narration has no scheduling role: writing Phase never fires anything', async () => {
  const ran: string[] = [];
  const worker = defineSystem({
    name: 'phaseWorker',
    query: [Task],
    run: (e, ctx) => {
      ran.push(`step${ctx.step}`);
      // Writing narration is a self-write on a component nothing queries, so it
      // cannot retrigger this pair or wake any other system.
      e.set(Phase, 'working');
      e.set(Result, 'done');
    },
  });
  const world = createWorld();
  world.use(worker);
  const entity = world.spawn(Task('a'), Goal('do the thing'));

  const result = await world.run();
  // Exactly one step: narration generated no dirt of its own.
  expect(result.steps).toBe(1);
  expect(ran).toEqual(['step1']);
  expect(world.systemsMatching(entity.id).map((s) => s.key)).toEqual(['phaseWorker']);

  expect(narrateWorld(world).map((n) => n.sentence)).toEqual([
    `#${entity.id} aims to do the thing; is working`,
  ]);
});

test('R64 narrateWorld covers entities with either component, in entity order', () => {
  const world = createWorld();
  const a = world.spawn(Phase('one'));
  const b = world.spawn(Goal('two'));
  world.spawn(Task('neither')); // no narration components: not listed
  expect(narrateWorld(world).map((n) => n.entity)).toEqual([a.id, b.id]);
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial review of PR #5. The first three are the
// tests the reviewer identified as the ones that would have caught the HIGHs.
// ---------------------------------------------------------------------------

test('R64 two systems narrating one entity in one step commit deterministically', async () => {
  // Plain components would make this a WriteConflictError that rejects the WHOLE
  // run with zero steps committed — from a one-line narration the docs invite.
  // support-desk already asserts two systems on one entity in one step, so adding
  // narration to both would have stopped the desk working.
  const narrateA = defineSystem({
    name: 'zzNarrA',
    query: [Task],
    run: (e) => {
      e.set(Phase, 'from-a');
    },
  });
  const narrateB = defineSystem({
    name: 'zzNarrB',
    query: [Task],
    run: (e) => {
      e.set(Goal, 'goal-b');
      e.set(Phase, 'from-b');
    },
  });
  const world = createWorld();
  world.use(narrateA);
  world.use(narrateB);
  const entity = world.spawn(Task('a'));

  const result = await world.run();
  expect(result.status).toBe('done');
  expect(world.getTrace()).toHaveLength(1);
  // Later writer in barrier order (system registration index) wins, so the
  // outcome is deterministic rather than order-dependent.
  expect(world.entity(entity.id)?.get(Phase)).toBe('from-b');
  expect(world.entity(entity.id)?.get(Goal)).toBe('goal-b');
});

test('R63 a spender spawned AFTER the brake fired is still stopped', async () => {
  const world = createWorld();
  let boardId = 0;
  world.use(spender(() => boardId));
  world.use(budgetWatchdog({ stampOn: [Worker] }));
  world.register(
    'model',
    scriptedModel([
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'LATE spender answer' },
    ]),
  );
  const board = world.spawn(TokenBudget(0), TokenUsage([]));
  boardId = board.id;
  world.spawn(Worker(), Task('first'));
  await world.run();
  expect(world.entity(board.id)?.has(BudgetExceeded)).toBe(true);

  // A second planning round, a retry-spawned worker: `Not(BudgetExceeded)` on the
  // watchdog's own query used to unmatch it PERMANENTLY once it stamped, freezing
  // the braked set at whoever existed then — so this worker ran unbounded, billed
  // the ledger, and the run still reported 'done'.
  const late = world.spawn(Worker(), Task('late'));
  await world.run();

  // Braked. It still gets the documented one-step lag — it was unstamped when it
  // newly matched, so one call lands before the watchdog sees the ledger move —
  // but that is one call, not free rein: previously it was never stamped at all.
  expect(world.entity(late.id)?.has(BudgetExceeded)).toBe(true);
  expect(world.entity(late.id)?.get(Result)).toBe('LATE spender answer');

  // And it stops there. A third run makes no further model call; the scripted
  // model has exactly two turns, so another would throw 'exhausted'.
  const third = await world.run();
  // 'idle': nothing matches any more, which is the graceful quiesce R63 promises.
  expect(third.status).toBe('idle');
  expect(third.errors).toEqual([]);
  expect(world.query(TokenUsage)[0]?.get(TokenUsage)).toHaveLength(2);
});

test('R63 two budget holders sharing a spender merge instead of rejecting the run', async () => {
  const world = createWorld();
  world.use(budgetWatchdog({ stampOn: [Worker] }));
  const boardA = world.spawn(TokenBudget(0), TokenUsage([{ system: 's', tokens: 5 }]));
  const boardB = world.spawn(TokenBudget(0), TokenUsage([{ system: 's', tokens: 9 }]));
  const shared = world.spawn(Worker(), Task('shared'));

  // Two distinct pairs writing one plain component in one step rejected the run
  // and stamped NOTHING — the budget brake failing and destroying the run, the
  // exact inverse of "state that stops work, not an exception that discards it".
  const result = await world.run();
  expect(result.status).toBe('done');
  expect(world.entity(boardA.id)?.has(BudgetExceeded)).toBe(true);
  expect(world.entity(boardB.id)?.has(BudgetExceeded)).toBe(true);
  // The merge keeps the larger overspend, so it cannot depend on registration order.
  expect(world.entity(shared.id)?.get(BudgetExceeded)).toMatchObject({ spent: 9 });
});

test('R63 warnAt rejects values that could never fire', () => {
  // `warnAt: 1` reads as "warn at 100%" and produced zero warnings forever;
  // `warnAt: 80` is what someone thinking in percent writes. Both silent.
  expect(() => budgetWatchdog({ warnAt: 1 })).toThrow(/strictly between 0 and 1/);
  expect(() => budgetWatchdog({ warnAt: 80 })).toThrow(/did you mean 0.8/);
  expect(() => budgetWatchdog({ warnAt: 0 })).toThrow(/strictly between 0 and 1/);
  expect(() => budgetWatchdog({ warnAt: 0.9 })).not.toThrow();
});

test('R63 a single spend past the cap still reports the warning', async () => {
  const warnings: number[] = [];
  const world = createWorld();
  world.use(budgetWatchdog({ warnAt: 0.5, onApproachingCap: (s) => warnings.push(s.spent) }));
  // 0 -> 130% in one append: the over-budget branch returned first, so a
  // coarse-grained agent (one big call per step) never saw onApproachingCap at all.
  const board = world.spawn(TokenBudget(100), TokenUsage([{ system: 's', tokens: 130 }]));

  await world.run();
  expect(world.entity(board.id)?.has(BudgetExceeded)).toBe(true);
  expect(warnings).toEqual([130]);
});

test('R63 a world can hold more than one budget', async () => {
  const world = createWorld();
  // The name was hardcoded and `use` dedupes by identity, so a global cap plus a
  // per-team cap was impossible — the second registration threw.
  expect(() => {
    world.use(budgetWatchdog({ name: 'globalBudget', stampOn: [Worker] }));
    world.use(budgetWatchdog({ name: 'teamBudget' }));
  }).not.toThrow();
  expect(
    world
      .systems()
      .map((s) => s.name)
      .sort(),
  ).toEqual(['globalBudget', 'teamBudget']);
});
