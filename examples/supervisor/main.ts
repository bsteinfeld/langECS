// Runnable demo: a supervisor routes one request to two workers (researcher,
// writer) that execute in parallel within a single step; the writer's model is
// wrapped to fail once, so the SystemError -> heal -> retry path fires live;
// the supervisor then aggregates both results into the final answer.
//
// Run:  pnpm -C examples supervisor
// Needs OPENAI_API_KEY in the repo-root .env.local.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, formatTrace, type Model } from '@langecs/core';
import { lastAssistant, sendMessage } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { spawnTeam } from './agents';

loadEnvLocal();

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to the repo-root .env.local and re-run.');
  process.exit(1);
}

const MODEL = 'gpt-4o-mini';

/** Wraps a model to throw on its first call — demos SystemError + heal live. */
function flakyOnce(model: Model): Model {
  let tripped = false;
  const trip = (): void => {
    if (tripped) return;
    tripped = true;
    throw new Error('simulated transient failure (first call to the writer model)');
  };
  return {
    generate(req) {
      trip();
      return model.generate(req);
    },
    stream(req, onChunk) {
      trip();
      return model.stream ? model.stream(req, onChunk) : model.generate(req);
    },
  };
}

const world = createWorld({ id: 'supervisor-demo' });
const model = fromAiSdk(openai(MODEL));
world.register('model:supervisor', model);
world.register('model:researcher', model);
world.register('model:writer', flakyOnce(model));

const team = spawnTeam(world);

const request =
  'Explain why entity-component-system architectures are a good fit for LLM agents, ' +
  'and finish with a two-line tagline.';

console.log(`multi-agent supervisor demo — model: ${MODEL}`);
console.log(`user → supervisor#${team.supervisor.id}: ${request}`);

const run = sendMessage(world, team.supervisor, request);

// Live narration: step progress, streamed tokens, dispatches, failures, heals.
let currentStreamer: string | undefined;
let midStream = false;
const line = (text: string): void => {
  if (midStream) {
    process.stdout.write('\n');
    midStream = false;
    currentStreamer = undefined;
  }
  console.log(text);
};

for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      line(
        `\n── step ${event.step}: ${event.scheduled.map((p) => `${p.system}#${p.entity}`).join('  ')}`,
      );
      break;
    case 'custom': {
      const data = event.data as { kind?: string } & Record<string, unknown>;
      if (data.kind === 'token') {
        const who = `${String(data.who)}#${event.entity}`;
        if (currentStreamer !== who) {
          if (midStream) process.stdout.write('\n');
          process.stdout.write(`  ${who} ▸ `);
          currentStreamer = who;
          midStream = true;
        }
        process.stdout.write(String(data.text));
      } else if (data.kind === 'dispatch') {
        const spawned = data.spawned === true ? ' (agent spawned at runtime)' : '';
        line(`  ⇒ dispatch → ${String(data.to)}#${data.entity}${spawned}: ${String(data.task)}`);
      } else if (data.kind === 'heal:retry') {
        line(
          `  ⟳ heal: re-arming ${String(data.system)} on #${data.entity} (failure ${data.attempt})`,
        );
      } else if (data.kind === 'heal:giveup') {
        line(`  ✖ heal: giving up on ${String(data.system)} on #${data.entity}`);
      }
      break;
    }
    case 'system:error':
      line(`  ✗ ${event.system}#${event.entity} failed: ${event.error.message}`);
      break;
    case 'step:applied':
      if (event.spawned.length > 0) {
        line(`  + spawned ${event.spawned.map((id) => `#${id}`).join(', ')}`);
      }
      break;
    default:
      break;
  }
}

const result = await run;
line(`\nrun finished: status=${result.status}, steps=${result.steps}`);

console.log('\nfinal answer');
console.log('────────────');
console.log(lastAssistant(world, team.supervisor)?.content ?? '(no answer)');

console.log('\nflight recorder');
console.log('───────────────');
console.log(formatTrace(world.getTrace()));
