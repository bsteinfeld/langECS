// Order fulfillment as pure ECS data flow — no LLM anywhere in this example.
// An order's lifecycle IS the set of components on its entity:
//
//   Order ──validate──> Validated ──chargePayment──> Charged
//         ──reserveInventory──> Reserved ──ship──> Shipped
//   (or Rejected, a dead end written by validate)
//
// There is no pipeline object, no step list, no router: each system queries
// "previous stage present + next stage absent", so writing a stage component
// is what wakes the next system (newly-matched dirt, SPEC R26). Orders never
// wait for each other — every order that is ready for a stage runs in the
// same step, concurrently.

import {
  createWorld,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  Not,
  type World,
} from '@langecs/core';
import { retry } from '@langecs/stdlib';

/** What the customer ordered. `total` is in cents. */
export type OrderInfo = { id: string; items: string[]; total: number };

export const Order = defineComponent<OrderInfo>({ name: 'Order' });

// Stage components — one per fulfillment milestone.
export const Validated = defineTag('Validated');
export const Charged = defineComponent<{ receipt: string }>({ name: 'Charged' });
export const Reserved = defineTag('Reserved');
export const Shipped = defineComponent<{ tracking: string }>({ name: 'Shipped' });
export const Rejected = defineComponent<{ reason: string }>({ name: 'Rejected' });

/** The payment gateway lives behind a typed resource ref (R18): systems stay pure data-in/data-out. */
export interface PaymentGateway {
  charge(orderId: string, amountCents: number): Promise<{ receipt: string }>;
}

export const PaymentsGateway = defineResource<PaymentGateway>('gateway:payments');

/**
 * In-memory gateway that times out exactly once for `failOnceFor`, then
 * recovers — deterministic flakiness, so the retry path is testable.
 */
export function flakyGateway(
  failOnceFor?: string,
): PaymentGateway & { attempts: Record<string, number> } {
  const attempts: Record<string, number> = {};
  return {
    attempts,
    async charge(orderId, amountCents) {
      attempts[orderId] = (attempts[orderId] ?? 0) + 1;
      if (orderId === failOnceFor && attempts[orderId] === 1) {
        throw new Error(`card network timeout while charging ${orderId}`);
      }
      return { receipt: `ch_${orderId}_${amountCents}` };
    },
  };
}

// Fires once per order: a freshly spawned Order newly matches this query, and
// whichever component it writes (Validated or Rejected) breaks the match, so
// it can never run twice on the same order.
export const validate = defineSystem({
  name: 'validate',
  query: [Order, Not(Validated), Not(Rejected)],
  run: (e) => {
    const order = e.get(Order);
    if (order.items.length === 0) {
      e.add(Rejected, { reason: 'order has no items' });
      return;
    }
    if (order.total <= 0) {
      e.add(Rejected, { reason: `total must be positive (got ${order.total})` });
      return;
    }
    // Writing Validated is the hand-off: chargePayment's query newly matches
    // this entity, so the next stage fires on the next step — for every order
    // validated this step, in parallel.
    e.add(Validated);
  },
});

// Woken by validate's Validated write. If the gateway throws, the engine
// discards this pair's writes and appends a SystemError record (R31); the
// stdlib retry system then re-fires exactly this (system, entity) pair via
// ctx.invalidate, and the eventual success auto-clears the record (R32).
// Nothing here knows about retries — failure handling is someone else's query.
export const chargePayment = defineSystem({
  name: 'chargePayment',
  query: [Order, Validated, Not(Charged)],
  run: async (e, ctx) => {
    const order = e.get(Order);
    const { receipt } = await ctx.resource(PaymentsGateway).charge(order.id, order.total);
    e.add(Charged, { receipt });
  },
});

// Woken by chargePayment's Charged write — only paid orders reserve stock.
export const reserveInventory = defineSystem({
  name: 'reserveInventory',
  query: [Order, Charged, Not(Reserved)],
  run: (e) => {
    e.add(Reserved);
  },
});

// Woken by Reserved. Nothing queries Shipped, so a shipped order goes quiet:
// quiescence is reached per order, not per pipeline.
export const ship = defineSystem({
  name: 'ship',
  query: [Order, Reserved, Not(Shipped)],
  run: (e) => {
    const order = e.get(Order);
    e.add(Shipped, { tracking: `TRK-${order.id}` });
  },
});

/**
 * A world with the four stage systems plus stdlib `retry`. Behavior only —
 * orders (the data) are spawned by the caller.
 */
export function buildWorld(gateway: PaymentGateway, id = 'order-pipeline'): World {
  const world = createWorld({ id });
  world.register(PaymentsGateway, gateway);
  world.use(validate);
  world.use(chargePayment);
  world.use(reserveInventory);
  world.use(ship);
  // retry knows nothing about payments: it watches [SystemError, RetryPolicy]
  // and re-invalidates whichever system failed — here that's chargePayment.
  world.use(retry);
  return world;
}
