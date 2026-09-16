import { createWorld, defineSystem, defineTag, Not } from '@langecs/core';
import { expect, test, vi } from 'vitest';
import { BudgetExceeded, budgetWatchdog, TokenBudget, TokenUsage } from '../src/budget';

test('R63 a late looping spender can run twice before the budget stamp commits', async () => {
  const Worker = defineTag('budgetReview.LateWorker');
  const world = createWorld();
  const board = world.spawn(TokenBudget(0), TokenUsage([{ system: 'past', tokens: 1 }]));
  world.use(budgetWatchdog({ stampOn: [Worker] }));
  let calls = 0;
  world.use(
    defineSystem({
      name: 'spender',
      query: [Worker, Not(BudgetExceeded)],
      run: (e, ctx) => {
        calls++;
        ctx.write(board, TokenUsage, [{ system: 'spender', tokens: 1 }], 'add');
        ctx.invalidate(e);
      },
    }),
  );
  await world.run();
  world.spawn(Worker());
  await world.run();
  expect(calls).toBe(2);
});

test('R63 logging failure does not discard the budget brake', async () => {
  const log = vi
    .spyOn(
      (globalThis as unknown as { console: { error: (...args: unknown[]) => void } }).console,
      'error',
    )
    .mockImplementation(() => {});
  const world = createWorld();
  const board = world.spawn(TokenBudget(0), TokenUsage([{ system: 'past', tokens: 1 }]));
  world.use(
    budgetWatchdog({
      onExceeded: () => {
        throw new Error('logging unavailable');
      },
    }),
  );
  await world.run();
  expect(board.has(BudgetExceeded)).toBe(true);
  log.mockRestore();
});

test('R63 warning notification failure and mutation cannot discard or change the cap stamp', async () => {
  const log = vi
    .spyOn(
      (globalThis as unknown as { console: { error: (...args: unknown[]) => void } }).console,
      'error',
    )
    .mockImplementation(() => {});
  const world = createWorld();
  const board = world.spawn(TokenBudget(0), TokenUsage([{ system: 'past', tokens: 5 }]));
  world.use(
    budgetWatchdog({
      warnAt: 0.5,
      onApproachingCap: (status) => {
        status.spent = 0;
        throw new Error('warning unavailable');
      },
    }),
  );
  const result = await world.run();
  expect(result.errors).toEqual([]);
  expect(board.get(BudgetExceeded)?.spent).toBe(5);
  log.mockRestore();
});
