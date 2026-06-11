// Inbox wake: appending to the append-reducer Inbox is value-change dirt that
// wakes an already-matching system (the actor-style mailbox convention).

import { createWorld, defineComponent, defineSystem, defineTag } from '@langecs/core';
import { expect, test } from 'vitest';
import { Inbox } from '../src/index';

test('external Inbox append wakes an already-matching system', async () => {
  const Listener = defineTag('inboxListener');
  const seen: string[][] = [];
  const onMail = defineSystem({
    name: 'onMail',
    query: [Inbox, Listener],
    run: (e) => {
      seen.push(e.get(Inbox).map((item) => item.content));
    },
  });

  const world = createWorld();
  world.use(onMail);
  const e = world.spawn(Listener(), Inbox([{ from: 'boot', content: 'hello' }]));

  const r1 = await world.run(); // fires once: new match
  expect(r1.steps).toBe(1);
  expect(seen).toEqual([['hello']]);

  // Append while idle: reducer merges, and the value change re-wakes the
  // system even though it matched all along.
  const r2 = await world.send(e, Inbox([{ from: 42, content: 'wake up', meta: { urgent: true } }]));
  expect(r2.status).toBe('done');
  expect(r2.steps).toBe(1);
  expect(seen).toEqual([['hello'], ['hello', 'wake up']]);
  expect(e.get(Inbox)).toEqual([
    { from: 'boot', content: 'hello' },
    { from: 42, content: 'wake up', meta: { urgent: true } },
  ]);

  // No new mail, no dirt: quiescent immediately.
  const r3 = await world.run();
  expect(r3.status).toBe('idle');
  expect(seen).toHaveLength(2);
});

test('a system appending to another entity Inbox wakes the recipient next step', async () => {
  const SendTo = defineComponent<number>({ name: 'inboxSendTo' });
  const Receiver = defineTag('inboxReceiver');
  const received: { step: number; contents: string[] }[] = [];

  const sender = defineSystem({
    name: 'sender',
    query: [SendTo],
    run: (e, ctx) => {
      ctx.write(e.get(SendTo), Inbox, [{ from: e.id, content: 'ping' }]);
    },
  });
  const receiver = defineSystem({
    name: 'receiver',
    query: [Inbox, Receiver],
    when: (e) => e.get(Inbox).length > 0,
    run: (e, ctx) => {
      received.push({ step: ctx.step, contents: e.get(Inbox).map((m) => m.content) });
    },
  });

  const world = createWorld();
  world.use(sender);
  world.use(receiver);
  const target = world.spawn(Receiver(), Inbox([]));
  const source = world.spawn(SendTo(target.id));

  const result = await world.run();
  expect(result.status).toBe('done');
  // step 1: sender fires (receiver vetoed: empty inbox); step 2: the foreign
  // Inbox append wakes the receiver.
  expect(received).toEqual([{ step: 2, contents: ['ping'] }]);
  expect(target.get(Inbox)).toEqual([{ from: source.id, content: 'ping' }]);
});
