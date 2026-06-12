// Deterministic, zero-network: validation is pure logic and the "gateway" is
// a local object that fails exactly once. Asserts the stage choreography
// straight from the flight recorder — every ready order advances in the SAME
// step, the rejected order stops at validate, and the flaky charge is healed
// by stdlib retry without ever stalling the other orders.

import { SystemError } from '@langecs/core';
import { RetryPolicy } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import {
  buildWorld,
  Charged,
  flakyGateway,
  Order,
  type OrderInfo,
  Rejected,
  Reserved,
  Shipped,
  Validated,
} from './pipeline';

test('orders flow concurrently: one rejected, one healed by retry, the rest never wait', async () => {
  const gateway = flakyGateway('ORD-3'); // times out once, then recovers
  const world = buildWorld(gateway, 'order-pipeline-test');
  const spawnOrder = (o: OrderInfo) => world.spawn(Order(o), RetryPolicy({ max: 2, baseMs: 1 }));

  const a = spawnOrder({ id: 'ORD-1', items: ['keyboard'], total: 100 });
  const b = spawnOrder({ id: 'ORD-2', items: ['desk'], total: 250 });
  const flaky = spawnOrder({ id: 'ORD-3', items: ['monitor arm'], total: 300 });
  const bad = spawnOrder({ id: 'ORD-4', items: [], total: 400 });
  const c = spawnOrder({ id: 'ORD-5', items: ['desk mat'], total: 500 });

  const result = await world.run();
  expect(result.status).toBe('done');
  expect(result.errors).toEqual([]); // the transient gateway failure left no residue
  expect(result.steps).toBe(6);

  // --- final states ------------------------------------------------------
  for (const e of [a, b, flaky, c]) {
    expect(e.has(Validated)).toBe(true);
    expect(e.has(Reserved)).toBe(true);
    expect(e.get(Shipped)?.tracking).toBe(`TRK-${e.get(Order)?.id}`);
  }

  // The rejected order: stopped at validate, never touched the gateway.
  expect(bad.get(Rejected)).toEqual({ reason: 'order has no items' });
  expect(bad.has(Validated)).toBe(false);
  expect(bad.has(Shipped)).toBe(false);
  expect(gateway.attempts['ORD-4']).toBeUndefined();

  // The retried order: charged on the second attempt, SystemError auto-cleared
  // by the engine on success (R32), receipt from the retry attempt.
  expect(gateway.attempts['ORD-3']).toBe(2);
  expect(flaky.has(SystemError)).toBe(false);
  expect(flaky.get(Charged)).toEqual({ receipt: 'ch_ORD-3_300' });

  // --- the choreography, straight from the flight recorder ---------------
  const trace = world.getTrace();
  const p = (system: string, e: { id: number }) => `${system}#${e.id}`;
  const fired = trace.map((s) => s.runs.map((r) => `${r.system}#${r.entity}`).sort());
  expect(fired).toEqual([
    // step 1: ALL five orders validate in one step (parallel pairs, R25.5)
    [a, b, flaky, bad, c].map((e) => p('validate', e)).sort(),
    // step 2: the four validated orders charge together; ORD-3's gateway call throws
    [
      p('chargePayment', a),
      p('chargePayment', b),
      p('chargePayment', flaky),
      p('chargePayment', c),
    ].sort(),
    // step 3: a, b, c keep moving while retry handles ORD-3's SystemError —
    // the failure blocked nobody
    [
      p('reserveInventory', a),
      p('reserveInventory', b),
      p('reserveInventory', c),
      p('retry', flaky),
    ].sort(),
    // step 4: a, b, c ship while the invalidated chargePayment#ORD-3 re-fires and succeeds
    [p('ship', a), p('ship', b), p('ship', c), p('chargePayment', flaky)].sort(),
    // steps 5-6: the healed order catches up through the remaining stages
    [p('reserveInventory', flaky)],
    [p('ship', flaky)],
  ]);

  // Multiple orders in the same step, by entity count too.
  expect(new Set(trace[0]?.runs.map((r) => r.entity)).size).toBe(5);

  // The failure and the healed retry are both on record.
  const failed = trace[1]?.runs.find((r) => r.entity === flaky.id);
  expect(failed?.system).toBe('chargePayment');
  expect(failed?.error?.message).toContain('card network timeout');
  const healed = trace[3]?.runs.find((r) => r.system === 'chargePayment');
  expect(healed?.entity).toBe(flaky.id);
  expect(healed?.error).toBeUndefined();

  // Everything shipped or rejected: nothing matches any system, so a fresh
  // run schedules zero steps.
  const again = await world.run();
  expect(again.status).toBe('idle');
  expect(again.steps).toBe(0);
});

test('a non-positive total is rejected with a reason and never reaches the gateway', async () => {
  const gateway = flakyGateway();
  const world = buildWorld(gateway, 'order-pipeline-reject');
  const e = world.spawn(
    Order({ id: 'ORD-9', items: ['cable'], total: -5 }),
    RetryPolicy({ max: 2, baseMs: 1 }),
  );

  const result = await world.run();
  expect(result.status).toBe('done');
  expect(result.steps).toBe(1); // validate fired once; writing Rejected breaks its own match
  expect(e.get(Rejected)).toEqual({ reason: 'total must be positive (got -5)' });
  expect(e.has(Validated)).toBe(false);
  expect(gateway.attempts).toEqual({});
});
