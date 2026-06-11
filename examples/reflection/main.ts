// Live reflection demo: writer drafts -> critic critiques -> writer revises,
// twice, then the critic approves and the loop ends by component removal.
//
//   pnpm -C examples reflection
//
// Needs OPENAI_API_KEY in <repo-root>/.env.local.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, formatTrace } from '@langecs/core';
import { Messages, userMessage } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { authorOf, MODEL_RESOURCE, Reflecting, reflection } from './agent';

loadEnvLocal();

const MODEL = 'gpt-4o-mini';
const TOPIC =
  'Write a short three-paragraph essay on why The Little Prince is still relevant in modern childhood.';

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY — add it to <repo-root>/.env.local to run this demo.');
  process.exit(1);
}

const world = createWorld({ id: 'reflection-demo' });
world.register(MODEL_RESOURCE, fromAiSdk(openai(MODEL)));
const blackboard = world.spawn(reflection);

console.log(`reflection demo — model ${MODEL}`);
console.log(`task: ${TOPIC}`);

const run = world.send(blackboard, Messages([userMessage(TOPIC)]));

let streaming: string | undefined; // author currently streaming tokens
for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(
        `\n━━ step ${event.step} · fires: ${event.scheduled.map((p) => p.system).join(' + ')}`,
      );
      break;
    case 'custom': {
      const data = event.data as { kind?: string; author?: string; text?: string };
      if (data.kind !== 'token') break;
      if (data.author !== streaming) {
        streaming = data.author;
        process.stdout.write(`\n[${data.author}] `);
      }
      process.stdout.write(data.text ?? '');
      break;
    }
    case 'step:applied': {
      streaming = undefined;
      process.stdout.write('\n');
      const ended = event.changes.some(
        (c) => c.kind === 'remove' && c.component === Reflecting.componentName,
      );
      if (ended) console.log('━━ critic approved — Reflecting removed, both systems unmatch');
      break;
    }
    case 'run:end':
      console.log(`\n━━ run ${event.status} after ${event.steps} steps`);
      break;
    default:
      break;
  }
}
await run;

const transcript = blackboard.get(Messages) ?? [];
const finalDraft = [...transcript].reverse().find((m) => authorOf(m) === 'writer');
const critiques = transcript.filter((m) => authorOf(m) === 'critic' && m.meta?.approved !== true);
console.log(`\ntranscript: ${transcript.length} messages, ${critiques.length} critique rounds`);
console.log('\n═══ final essay ═══\n');
console.log(finalDraft?.content ?? '(no draft produced)');

console.log('\n═══ flight recorder ═══\n');
console.log(formatTrace(world.getTrace()));
