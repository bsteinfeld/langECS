// Checkpoint time travel, live demo (port of the LangGraph.js time-travel
// how-to). Runs a short multi-step conversation with the core MemoryAdapter
// checkpointing every step, prints the checkpoint history, rewinds a FRESH
// world to an earlier step via adapter.loadStep, forks it with a different
// user input, and shows the two timelines diverge while the original stays
// intact. Requires OPENAI_API_KEY in the repo-root .env.local.
//
//   pnpm -C examples time-travel

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { MemoryAdapter, type Msg, type Run, type World } from '@langecs/core';
import { lastAssistant, Messages, sendMessage } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { buildWorld, forkFromSnapshot, MODEL_ID, timeTraveler, WORLD_ID } from './agent';

loadEnvLocal();
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY — add it to the repo-root .env.local to run this demo.');
  process.exit(1);
}

/** Streams a run to the console: step progress lines + live model tokens. */
async function watch(run: Run): Promise<void> {
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
          `  [step ${event.step}] firing: ${event.scheduled.map((p) => p.system).join(', ')}`,
        );
        break;
      case 'custom': {
        const data = event.data as { kind?: string; text?: string };
        if (data.kind === 'token' && data.text) {
          if (!streaming) {
            process.stdout.write('    | ');
            streaming = true;
          }
          process.stdout.write(data.text);
        }
        break;
      }
      case 'step:applied': {
        endStream();
        const changed = [...new Set(event.changes.map((c) => `${c.kind} ${c.component}`))];
        console.log(`  [step ${event.step}] applied: ${changed.join(', ')}`);
        break;
      }
      case 'run:end':
        endStream();
        console.log(`  [run] ${event.status} after ${event.steps} step(s)`);
        break;
      default:
        break;
    }
  }
  await run;
}

function printTimeline(label: string, world: World, entityId: number): void {
  console.log(`\n${label}`);
  const messages: Msg[] = world.entity(entityId)?.get(Messages) ?? [];
  for (const m of messages) {
    const calls = m.toolCalls?.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ');
    console.log(`  ${m.role.padEnd(9)} ${calls ? `→ ${calls}` : m.content}`);
  }
}

const adapter = new MemoryAdapter();
const model = fromAiSdk(openai(MODEL_ID));
const world = buildWorld({ id: WORLD_ID, model, persistence: adapter });
const agent = world.spawn(timeTraveler);

console.log(`\n=== Original timeline (worldId '${WORLD_ID}', model ${MODEL_ID}) ===`);
console.log("\nuser: Hi! I'm Jo.");
await watch(sendMessage(world, agent, "Hi! I'm Jo."));

console.log("\nuser: What's the weather like in SF currently?");
await watch(sendMessage(world, agent, "What's the weather like in SF currently?"));

// Every step barrier checkpointed a full JSON snapshot into the adapter.
console.log('\n=== Checkpoint history (adapter.history) ===');
const history = adapter.history(WORLD_ID);
for (const h of history) {
  const snap = adapter.loadStep(WORLD_ID, h.step);
  const count = (snap?.entities[0]?.components.Messages as Msg[] | undefined)?.length ?? 0;
  console.log(
    `  step ${h.step}  savedAt ${new Date(h.savedAt).toISOString()}  (${count} messages)`,
  );
}

// Rewind: load the step-1 snapshot (right after the greeting, before the
// weather question ever happened) into a FRESH world and fork the timeline.
const REWIND_TO = 1;
console.log(
  `\n=== Rewind: loadStep(${REWIND_TO}) into a fresh world, fork with different input ===`,
);
const snapshot = adapter.loadStep(WORLD_ID, REWIND_TO);
if (!snapshot) throw new Error(`no checkpoint at step ${REWIND_TO}`);
const fork = forkFromSnapshot({
  id: `${WORLD_ID}-fork`,
  model,
  snapshot,
  persistence: adapter, // the fork checkpoints its own history under its own worldId
});
console.log(`  fork.step = ${fork.step} (original world is at step ${world.step})`);

console.log('\nuser (fork): No weather questions after all — just tell me, what is my name?');
await watch(
  sendMessage(fork, agent.id, 'No weather questions after all — just tell me, what is my name?'),
);

printTimeline(
  `--- Original timeline (worldId '${WORLD_ID}', step ${world.step}) ---`,
  world,
  agent.id,
);
printTimeline(
  `--- Forked timeline (worldId '${WORLD_ID}-fork', step ${fork.step}) ---`,
  fork,
  agent.id,
);

const shared = (fork.entity(agent.id)?.get(Messages) ?? []).filter((m, i) => {
  const original: Msg[] = world.entity(agent.id)?.get(Messages) ?? [];
  return JSON.stringify(original[i]) === JSON.stringify(m);
}).length;
console.log(`\nShared prefix: ${shared} message(s); the timelines diverge from there.`);
console.log(`Original final answer: ${lastAssistant(world, agent)?.content}`);
console.log(`Fork final answer:     ${lastAssistant(fork, agent.id)?.content}`);
console.log(
  `\nBoth histories live side by side in the adapter: ` +
    `${WORLD_ID} → steps [${adapter.history(WORLD_ID).map((h) => h.step)}], ` +
    `${WORLD_ID}-fork → steps [${adapter.history(`${WORLD_ID}-fork`).map((h) => h.step)}]`,
);
