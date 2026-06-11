// ReAct agent demo — LangECS port of the LangGraph.js quickstart
// (https://github.com/langchain-ai/langgraphjs/tree/main/examples/quickstart).
//
// Run with: pnpm -C examples react-agent
// Needs OPENAI_API_KEY in the repo-root .env.local.
//
// Watch the dirty-trigger cycle live: step 1 callLLM requests tool calls,
// step 2 executeTools runs them (tool results are foreign dirt on Messages),
// step 3 callLLM streams the final answer and removes MessageWaiting →
// quiescence. No graph edges anywhere; the loop emerges from data.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { lastAssistant, sendMessage, type ToolCall } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { MODEL, MODEL_RESOURCE, spawnReactAgent } from './agent';

loadEnvLocal();
if (process.env.OPENAI_API_KEY === undefined) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and retry.');
  process.exit(1);
}

const world = createWorld({ id: 'react-agent-demo' });
world.register(MODEL_RESOURCE, fromAiSdk(openai(MODEL)));
const agent = spawnReactAgent(world);

const question = "What's the weather in San Francisco right now, and what is (23.5 * 4) - 7?";
console.log(`user> ${question}`);

const run = sendMessage(world, agent, question);

let streaming = false;
const endStream = (): void => {
  if (streaming) {
    process.stdout.write('\n');
    streaming = false;
  }
};

for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(
        `\n[step ${event.step}] scheduled: ${event.scheduled.map((p) => p.system).join(', ')}`,
      );
      break;
    case 'custom': {
      // callLLM pipes model stream chunks through ctx.emit (live, mid-step).
      const data = event.data as { kind?: string; text?: string };
      if (data.kind === 'token' && data.text !== undefined) {
        if (!streaming) {
          process.stdout.write('  assistant> ');
          streaming = true;
        }
        process.stdout.write(data.text);
      }
      break;
    }
    case 'system:end':
      endStream();
      console.log(`  ${event.system} done in ${event.ms.toFixed(0)}ms`);
      break;
    case 'system:error':
      endStream();
      console.log(`  ${event.system} FAILED: ${event.error.message}`);
      break;
    case 'step:applied':
      for (const change of event.changes) {
        if (change.component === 'PendingToolCalls' && change.kind === 'set') {
          for (const call of change.value as ToolCall[]) {
            console.log(`  tool requested -> ${call.name}(${JSON.stringify(call.args)})`);
          }
        }
      }
      console.log(`  applied: ${event.changes.map((c) => `${c.kind} ${c.component}`).join(', ')}`);
      break;
    case 'run:end':
      endStream();
      console.log(`\n[run ${event.status} after ${event.steps} step(s)]`);
      break;
    default:
      break;
  }
}

const result = await run;
if (result.status !== 'done') {
  console.error(`Run did not finish cleanly: ${JSON.stringify(result, null, 2)}`);
  process.exit(1);
}
console.log(`\nfinal answer> ${lastAssistant(world, agent)?.content ?? '(none)'}`);
