// ask(): the one-liner Q&A path — happy path plus a thrown, actionable Error
// for every non-answer quiescence (pending / error / limit / idle / silent).

import {
  AwaitingHuman,
  createWorld,
  defineResource,
  defineSystem,
  interrupt,
  type Model,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';
import { ask, Messages, MessageWaiting, reactAgent } from '../src/index';

test('ask returns the assistant reply text on done', async () => {
  const world = createWorld();
  world.register('model:ask', scriptedModel([{ role: 'assistant', content: 'The answer is 5.' }]));
  const agent = world.spawn(reactAgent({ name: 'askbot', model: 'model:ask' }));
  await expect(ask(world, agent, 'What is 2 + 3?')).resolves.toBe('The answer is 5.');
});

test('reactAgent accepts a typed ResourceRef<Model>; only the name is stored', async () => {
  const world = createWorld();
  const AskModel = defineResource<Model>('model:ask-ref');
  world.register(AskModel, scriptedModel([{ role: 'assistant', content: 'Refs work.' }]));
  const agent = world.spawn(reactAgent({ name: 'refbot', model: AskModel }));
  await expect(ask(world, agent, 'Do typed refs work?')).resolves.toBe('Refs work.');
});

// Parks the run: raises an AwaitingHuman interrupt instead of answering.
const interruptOnAsk = defineSystem({
  name: 'interruptOnAsk',
  query: [Messages, MessageWaiting],
  run: (e) => {
    e.add(AwaitingHuman, interrupt('confirm-send').value);
    e.remove(MessageWaiting);
  },
});

test("ask on 'pending' throws pointing at world.pending()/world.resume()", async () => {
  const world = createWorld();
  world.use(interruptOnAsk);
  const agent = world.spawn(Messages([]));

  const failing = ask(world, agent, 'do something risky');
  await expect(failing).rejects.toThrow("status 'pending'");
  await expect(failing).rejects.toThrow("'confirm-send'");
  await expect(failing).rejects.toThrow('world.pending()');
  await expect(failing).rejects.toThrow('world.resume(entity, value)');
  // The interrupt is really parked there for the caller to answer.
  expect(world.pending()).toMatchObject([{ entity: agent.id }]);
});

// Fails the pair: the engine appends a SystemError record (R31) -> status 'error'.
const explodeOnAsk = defineSystem({
  name: 'explodeOnAsk',
  query: [Messages, MessageWaiting],
  run: () => {
    throw new Error('upstream model is down');
  },
});

test("ask on 'error' throws including the failing system names and messages", async () => {
  const world = createWorld();
  world.use(explodeOnAsk);
  const agent = world.spawn(Messages([]));

  const failing = ask(world, agent, 'hello?');
  await expect(failing).rejects.toThrow("status 'error'");
  await expect(failing).rejects.toThrow(`explodeOnAsk (entity ${agent.id})`);
  await expect(failing).rejects.toThrow('upstream model is down');
});

// Never quiesces: re-arms itself every step via ctx.invalidate (R24).
const spinOnAsk = defineSystem({
  name: 'spinOnAsk',
  query: [Messages, MessageWaiting],
  run: (e, ctx) => {
    ctx.invalidate(e);
  },
});

test("ask on 'limit' throws explaining recursionLimit", async () => {
  const world = createWorld({ recursionLimit: 3 });
  world.use(spinOnAsk);
  const agent = world.spawn(Messages([]));

  const failing = ask(world, agent, 'spin forever');
  await expect(failing).rejects.toThrow("status 'limit'");
  await expect(failing).rejects.toThrow('after 3 step(s)');
  await expect(failing).rejects.toThrow('recursionLimit');
});

test("ask on 'idle' (no system matched) throws suggesting reactAgent/world.use", async () => {
  const world = createWorld();
  const agent = world.spawn(Messages([]));

  const failing = ask(world, agent, 'anyone there?');
  await expect(failing).rejects.toThrow("status 'idle'");
  await expect(failing).rejects.toThrow('reactAgent');
});

// Consumes MessageWaiting without ever replying.
const silentOnAsk = defineSystem({
  name: 'silentOnAsk',
  query: [Messages, MessageWaiting],
  run: (e) => {
    e.remove(MessageWaiting);
  },
});

test("ask on 'done' without an assistant message throws a clear wiring error", async () => {
  const world = createWorld();
  world.use(silentOnAsk);
  const agent = world.spawn(Messages([]));

  const failing = ask(world, agent, 'say something');
  await expect(failing).rejects.toThrow('no assistant message');
  await expect(failing).rejects.toThrow('callLLM');
});
