// Context-window management — keep a long conversation under a token budget
// without losing durable history.
//
// Run with: pnpm -C examples context-window   (OPENAI_API_KEY in repo-root .env.local)
//
// The whole transcript lives on the entity (snapshot-able, time-travelable),
// but `withMessageWindow` trims what each model call actually SEES. One line of
// wiring solves the "infinite conversation" problem — no scheduler tricks, no
// mutation of the stored history.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, defineResource, type Model } from '@langecs/core';
import { ask, estimateTokens, Messages, reactAgent, withMessageWindow } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const Chatbot = defineResource<Model>('model:chat');

const world = createWorld({ id: 'context-window' });
// The only change from an unbounded chatbot: wrap the model. Every request's
// messages are windowed to the most recent 6 before the call; the SystemPrompt
// and the stored Messages history are untouched.
world.register(Chatbot, withMessageWindow(fromAiSdk(openai('gpt-4o-mini')), { maxMessages: 6 }));

const agent = world.spawn(
  reactAgent({
    name: 'chatbot',
    model: Chatbot,
    systemPrompt: 'You are a friendly assistant. Keep replies to one short sentence.',
  }),
);

const turns = [
  'My name is Ada and I study analytical engines.',
  'I have a cat named Charles.',
  'My favorite number is 1843.',
  'I live in London.',
  'I take my tea with no milk.',
  'What is 12 * 12?',
  'Name a fruit that is red.',
  'What did I say my favorite number was?', // likely out of the window now
];

for (const turn of turns) {
  const reply = await ask(world, agent, turn);
  console.log(`user> ${turn}`);
  console.log(`bot>  ${reply}\n`);
}

const history = world.entity(agent.id)?.get(Messages) ?? [];
console.log('---');
console.log(
  `Full history retained on the entity: ${history.length} messages ` +
    `(~${estimateTokens(history)} estimated tokens).`,
);
console.log(
  'But each model call only ever saw the 6 most recent — so the prompt stays ' +
    'bounded no matter how long the conversation runs.',
);
console.log(
  'Trade-off made visible: the bot likely cannot recall the favorite number, ' +
    'because that turn scrolled out of the window. Raise maxMessages (or switch ' +
    'to maxTokens, or summarize) to widen memory.',
);
