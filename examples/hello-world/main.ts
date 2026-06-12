// Hello, LangECS — a chat agent built from raw parts in one file.
//
// Run with: pnpm -C examples hello-world        (OPENAI_API_KEY in repo-root .env.local)
// Append --trace to print the flight recorder when the run is over.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import {
  createWorld,
  defineAgent,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  formatTrace,
  type Model,
  type Msg,
} from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

// --- State. Components are the agent's entire memory. -----------------------

// The transcript. The reducer turns `add` into "append": concurrent writers
// merge into one history instead of overwriting each other.
const Chat = defineComponent<Msg[]>({
  name: 'Chat',
  reducer: (current, incoming) => [...current, ...incoming],
});

// A tag is a value-less component. Its presence is the work order: "the last
// word is the user's — someone owes a reply".
const WaitingReply = defineTag('WaitingReply');

// A typed name for the model resource: register/look up without raw strings.
const ChatModel = defineResource<Model>('model:chat');

// --- Logic. One system; no graph, no loop, no router. ------------------------

const respond = defineSystem({
  name: 'respond',
  // Fires when an entity NEWLY has both Chat and WaitingReply — exactly what
  // world.send() below causes by adding the tag.
  query: [Chat, WaitingReply],
  run: async (e, ctx) => {
    const { message } = await ctx.resource(ChatModel).generate({ messages: e.get(Chat) });
    // Appending to Chat is a self-write, so it does NOT re-trigger respond...
    e.add(Chat, [message]);
    // ...and removing the tag un-matches the query. Nothing is left to run, so
    // the world is quiescent — that, not a return value or an END edge, is how
    // a run ends.
    e.remove(WaitingReply);
  },
});

// An agent is just a spawnable bundle: starting components + scoped systems.
const greeter = defineAgent({
  name: 'greeter',
  components: [Chat([])],
  systems: [respond],
});

// --- Run. --------------------------------------------------------------------

const world = createWorld({ id: 'hello-world' });
world.register(ChatModel, fromAiSdk(openai('gpt-4o-mini')));
const agent = world.spawn(greeter);

// send = add components, then run until quiescent.
console.log('user> Hi! My name is Ada.');
await world.send(agent, Chat([{ role: 'user', content: 'Hi! My name is Ada.' }]), WaitingReply());
console.log(`assistant> ${agent.get(Chat)?.at(-1)?.content}`);

// Second send, same entity: the Chat component is still there, so the model
// sees the whole history. "Memory" is nothing special — it's just state.
console.log("user> What's my name?");
await world.send(agent, Chat([{ role: 'user', content: "What's my name?" }]), WaitingReply());
console.log(`assistant> ${agent.get(Chat)?.at(-1)?.content}`);

if (process.argv.includes('--trace')) console.log(formatTrace(world.getTrace()));
