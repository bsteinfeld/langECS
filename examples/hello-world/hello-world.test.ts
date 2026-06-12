// Deterministic replica of main.ts: identical Chat/WaitingReply/respond/greeter
// definitions, but the model is core's scriptedModel — zero network. Asserts
// the step choreography via final state and the flight recorder.
// (main.ts runs its demo at import time, so the parts are re-declared here.)

import {
  createWorld,
  defineAgent,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  type Model,
  type Msg,
  scriptedModel,
} from '@langecs/core';
import { expect, test } from 'vitest';

const Chat = defineComponent<Msg[]>({
  name: 'Chat',
  reducer: (current, incoming) => [...current, ...incoming],
});
const WaitingReply = defineTag('WaitingReply');
const ChatModel = defineResource<Model>('model:chat');

const respond = defineSystem({
  name: 'respond',
  query: [Chat, WaitingReply],
  run: async (e, ctx) => {
    const { message } = await ctx.resource(ChatModel).generate({ messages: e.get(Chat) });
    e.add(Chat, [message]);
    e.remove(WaitingReply); // un-match the query -> quiescence
  },
});

const greeter = defineAgent({ name: 'greeter', components: [Chat([])], systems: [respond] });

test('two sends: one respond step each, transcript persists across turns', async () => {
  const world = createWorld();
  world.register(
    ChatModel,
    scriptedModel([
      { role: 'assistant', content: 'Hello, Ada!' },
      (req) => {
        // The second turn's request carries the full first exchange: state
        // persisted on the entity, not in any session object.
        expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        return { role: 'assistant', content: 'Your name is Ada.' };
      },
    ]),
  );
  const agent = world.spawn(greeter);

  // Send 1: external adds raise WaitingReply -> respond newly matches.
  const first = await world.send(
    agent,
    Chat([{ role: 'user', content: 'Hi! My name is Ada.' }]),
    WaitingReply(),
  );
  // One step: respond fired once. Its own Chat append is a self-write (no
  // re-trigger) and it removed WaitingReply, so the world went quiescent.
  expect(first.status).toBe('done');
  expect(first.steps).toBe(1);
  expect(agent.has(WaitingReply)).toBe(false);
  expect(agent.get(Chat)?.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(agent.get(Chat)?.at(-1)?.content).toBe('Hello, Ada!');

  // Send 2: re-adding the tag is new dirt -> the same system fires again.
  const second = await world.send(
    agent,
    Chat([{ role: 'user', content: "What's my name?" }]),
    WaitingReply(),
  );
  expect(second.status).toBe('done');
  expect(second.steps).toBe(1);
  expect(agent.get(Chat)?.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(agent.get(Chat)?.at(-1)?.content).toBe('Your name is Ada.');

  // Choreography from the flight recorder: exactly one respond run per send,
  // and each run ends by removing WaitingReply (the quiescence move).
  const trace = world.getTrace();
  expect(trace.map((s) => s.runs.map((r) => r.system))).toEqual([
    ['greeter:respond'],
    ['greeter:respond'],
  ]);
  for (const step of trace) {
    expect(step.applied).toContainEqual({
      entity: agent.id,
      component: 'WaitingReply',
      kind: 'remove',
    });
  }
});
