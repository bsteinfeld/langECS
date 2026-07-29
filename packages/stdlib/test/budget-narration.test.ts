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
      const result = await model.generate({ messages: [{ role: 'user', content: e.get(Task) }] });
      e.set(Result, result.message.content);
      // Usage lands on the board, which is where the budget lives.
      ctx.write(board(), TokenUsage, [spendOf('spender', result)], 'add');
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
  // scriptedModel reports nothing; a silent zero would make every budget test
  // pass vacuously.
  const estimated = spendOf('s', { message: { role: 'assistant', content: 'x'.repeat(40) } }, 20);
  expect(estimated.tokens).toBe(15);
  expect(spendOf('s', { message: { role: 'assistant', content: '' } }).tokens).toBe(1);
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

  // A budget of 1 token: the first barrier's spend already blows it.
  const board = world.spawn(TokenBudget(1), TokenUsage([]));
  boardId = board.id;
  const workers = [
    world.spawn(Worker(), Task('a')),
    world.spawn(Worker(), Task('b')),
    world.spawn(Worker(), Task('c')),
  ];

  const result = await world.run();

  // Graceful quiesce: nothing threw, so the run is 'done', not 'error'.
  expect(result.status).toBe('done');
  expect(world.entity(board.id)?.get(BudgetExceeded)).toMatchObject({ budget: 1 });
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
