// E-commerce order fulfillment with ZERO LLM calls — LangECS as a plain
// workflow runtime. Five orders flow Validated -> Charged -> Reserved ->
// Shipped concurrently; one fails validation, one survives a flaky payment
// gateway thanks to the stdlib retry system. No graph, no router: stage
// components on each order entity drive the whole choreography.
//
//   pnpm -C examples order-pipeline           # status table
//   pnpm -C examples order-pipeline --trace   # + the flight recorder

import { formatTrace } from '@langecs/core';
import { RetryPolicy } from '@langecs/stdlib';
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

const ORDERS: OrderInfo[] = [
  { id: 'ORD-1001', items: ['mechanical keyboard', 'usb hub'], total: 18900 },
  { id: 'ORD-1002', items: ['standing desk'], total: 64900 },
  { id: 'ORD-1003', items: ['monitor arm', 'webcam'], total: 21500 }, // survives a flaky charge
  { id: 'ORD-1004', items: ['hdmi cable'], total: 0 }, // fails validation
  { id: 'ORD-1005', items: ['laptop stand', 'desk mat'], total: 8900 },
];

// The gateway times out exactly once, charging ORD-1003. The engine records
// that as SystemError on the order; RetryPolicy lets stdlib retry heal it
// while every other order keeps moving.
const world = buildWorld(flakyGateway('ORD-1003'));
for (const order of ORDERS) {
  world.spawn(Order(order), RetryPolicy({ max: 2, baseMs: 25 }));
}

const result = await world.run();

console.log(`run ${result.status} after ${result.steps} steps\n`);
console.log(
  `${'order'.padEnd(10)} ${'items'.padEnd(30)} ${'total'.padEnd(9)} ${'status'.padEnd(10)} detail`,
);
for (const e of world.query(Order)) {
  const order = e.get(Order);
  let status = 'received';
  if (e.has(Validated)) status = 'validated';
  if (e.has(Charged)) status = 'charged';
  if (e.has(Reserved)) status = 'reserved';
  if (e.has(Shipped)) status = 'SHIPPED';
  if (e.has(Rejected)) status = 'REJECTED';
  const detail =
    e.get(Rejected)?.reason ?? `${e.get(Shipped)?.tracking} (${e.get(Charged)?.receipt})`;
  console.log(
    `${order.id.padEnd(10)} ${order.items.join(', ').padEnd(30)} ${`$${(order.total / 100).toFixed(2)}`.padEnd(9)} ${status.padEnd(10)} ${detail}`,
  );
}

if (process.argv.includes('--trace')) {
  console.log(`\n${formatTrace(world.getTrace())}`);
}
