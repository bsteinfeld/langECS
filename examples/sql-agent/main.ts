// English -> SQL -> answer, live against OpenAI.
//
//   pnpm -C examples sql-agent ["your question"] [--trace]
//
// Requires OPENAI_API_KEY in repo-root .env.local, and Node >= 22.5 for
// node:sqlite (no flag needed on >= 23.4; this repo targets Node 24).

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { formatTrace, type Msg } from '@langecs/core';
import { lastAssistant, Messages, sendMessage } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { createSqlAgentWorld } from './agent';

const MODEL = 'gpt-4o-mini';

loadEnvLocal();
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set. Add it to the repo-root .env.local and re-run.');
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--trace');
const showTrace = process.argv.includes('--trace');
const question = args[0] ?? 'Which artist has the most tracks?';

const { world, agent } = createSqlAgentWorld(fromAiSdk(openai(MODEL)));

const short = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Pretty-print messages committed since the last barrier (tool traffic). */
let seen = 0;
function printNewMessages(): void {
  const messages: Msg[] = agent.get(Messages) ?? [];
  for (const msg of messages.slice(seen)) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        console.log(`  → ${call.name}(${short(JSON.stringify(call.args) ?? '')})`);
      }
    } else if (msg.role === 'tool') {
      console.log(`  ← ${msg.name}: ${short(msg.content)}`);
    }
  }
  seen = messages.length;
}

console.log(`Q: ${question}\n`);
const run = sendMessage(world, agent, question);

let streamedThisStep = false;
for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(`── step ${event.step}: ${event.scheduled.map((p) => p.system).join(' + ')}`);
      break;
    case 'custom': {
      // callLLM streams model tokens mid-step via ctx.emit.
      const data = event.data as { kind?: string; text?: string };
      if (data.kind === 'token' && data.text) {
        if (!streamedThisStep) process.stdout.write('  ');
        process.stdout.write(data.text);
        streamedThisStep = true;
      }
      break;
    }
    case 'system:end':
      if (streamedThisStep) {
        process.stdout.write('\n');
        streamedThisStep = false;
      }
      console.log(`  ✓ ${event.system} (${event.ms.toFixed(0)}ms)`);
      break;
    case 'system:error':
      console.error(`  ✗ ${event.system}: ${event.error.message}`);
      break;
    case 'step:applied':
      printNewMessages();
      break;
    case 'run:end':
      console.log(`\nrun finished: status=${event.status} steps=${event.steps}`);
      break;
    default:
      break;
  }
}

const result = await run;
if (result.status === 'done') {
  console.log(`\nA: ${lastAssistant(world, agent)?.content}`);
} else {
  console.error(`\nRun did not complete cleanly:`, result);
}

if (showTrace) {
  console.log('\n— flight recorder —');
  console.log(formatTrace(world.getTrace()));
}
