// Tools from scratch — the LLM-tools loop with no preset, no graph, no loop.
//
// Run with: pnpm -C examples tools-from-scratch        (add --trace for the
// flight recorder). Needs OPENAI_API_KEY in the repo-root .env.local.
//
// One awaited send drives the whole conversation: think queues tool calls,
// act executes them, the foreign Convo write re-fires think — repeat until
// the model answers in plain text and removes NeedsReply. See agent.ts.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, formatTrace } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { ChatModel, Convo, NeedsReply, spawnMathAgent } from './agent';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'tools-from-scratch' });
world.register(ChatModel, fromAiSdk(openai('gpt-4o-mini')));
const agent = spawnMathAgent(world);

const question =
  'A marathon is 26.2 miles. Convert that to kilometers, then calculate how many ' +
  'kilometers 4 marathons cover.';
console.log(`user> ${question}\n`);

const result = await world.send(agent, Convo([{ role: 'user', content: question }]), NeedsReply());

// Everything that happened is committed state now — replay the transcript.
for (const msg of agent.get(Convo) ?? []) {
  for (const call of msg.toolCalls ?? []) {
    console.log(`tool call>   ${call.name}(${JSON.stringify(call.args)})`);
  }
  if (msg.role === 'tool') {
    console.log(`tool result> ${msg.content}`);
  } else if (msg.role === 'assistant' && msg.content !== '') {
    console.log(`\nassistant> ${msg.content}`);
  }
}
console.log(`\n[${result.status} after ${result.steps} steps of think/act alternation]`);

if (process.argv.includes('--trace')) {
  console.log(`\n${formatTrace(world.getTrace())}`);
}
