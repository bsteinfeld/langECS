// Human-in-the-loop: tool approval with kill-and-resume.
//
//   pnpm -C examples human-in-the-loop            # phase 1: run until pending, persist, EXIT
//   pnpm -C examples human-in-the-loop --resume   # phase 2: new process, y/n on stdin, finish
//
// Phase 1 asks the agent to delete a record. `delete_record` is defined with
// `needsApproval: true`, so the world goes quiescent with status 'pending'
// (an AwaitingHuman component on the agent entity), the @langecs/persist-fs
// adapter has already written every step boundary to disk, and the process
// exits. Phase 2 is a brand-new process: it rebuilds the world shell
// (systems + resources), loads the snapshot, asks you on stdin, and
// `world.resume(...)`s to completion.

import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, type Run, type World } from '@langecs/core';
import { fsAdapter } from '@langecs/persist-fs';
import { lastAssistant, registerTools, sendMessage } from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import { MODEL_RESOURCE, recordsAgent, recordTools, WORLD_ID } from './agent';

loadEnvLocal(); // repo-root .env.local -> process.env (OPENAI_API_KEY)

const MODEL = 'gpt-4o-mini';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '.world');

/** Fresh world shell: same recipe in both processes; only the snapshot differs. */
function buildWorld(): World {
  const world = createWorld({ id: WORLD_ID, persistence: fsAdapter({ dir: DATA_DIR }) });
  world.register(MODEL_RESOURCE, fromAiSdk(openai(MODEL)));
  registerTools(
    world,
    recordTools((id) => console.log(`\n   [db] delete_record EXECUTED for record ${id}`)),
  );
  return world;
}

/** Live progress: step headers, streamed tokens, applied-change summaries. */
async function watch(run: Run): Promise<void> {
  let streaming = false;
  const breakLine = (): void => {
    if (streaming) {
      process.stdout.write('\n');
      streaming = false;
    }
  };
  for await (const event of run) {
    switch (event.type) {
      case 'step:start':
        breakLine();
        console.log(
          `\n── step ${event.step} ── ${event.scheduled
            .map((pair) => `${pair.system} @e${pair.entity}`)
            .join(', ')}`,
        );
        break;
      case 'custom': {
        const data = event.data as { kind?: string; text?: string };
        if (data.kind === 'token' && data.text) {
          process.stdout.write(data.text); // live model tokens, mid-step
          streaming = true;
        }
        break;
      }
      case 'system:end':
        breakLine();
        console.log(`   ✓ ${event.system} (${event.ms.toFixed(0)} ms)`);
        break;
      case 'step:applied': {
        const changes = [...new Set(event.changes.map((c) => `${c.kind} ${c.component}`))];
        console.log(`   barrier: ${changes.join(', ') || '(no changes)'}`);
        break;
      }
      case 'run:end':
        console.log(`\n══ run ended: status=${event.status} after ${event.steps} step(s)`);
        break;
      default:
        break;
    }
  }
}

async function freshRun(): Promise<void> {
  await rm(DATA_DIR, { recursive: true, force: true }); // start a clean episode
  const world = buildWorld();
  const agent = world.spawn(recordsAgent);

  console.log(`User: Look up record 42, then delete it.`);
  const run = sendMessage(world, agent, 'Look up record 42, then delete it.');
  await watch(run);
  const result = await run;

  if (result.status !== 'pending') {
    console.log(`\nNo approval was needed. Agent: ${lastAssistant(world, agent)?.content}`);
    return;
  }

  for (const { entity, interrupts } of result.pending) {
    for (const interrupt of interrupts) {
      console.log(`\nAwaitingHuman on entity ${entity} (${interrupt.kind}):`);
      console.log(`   ${JSON.stringify(interrupt.payload)}`);
    }
  }
  console.log(
    `\nWorld persisted to ${join(DATA_DIR, WORLD_ID)} — exiting WITHOUT running the tool.`,
  );
  console.log('Continue with:  pnpm -C examples human-in-the-loop --resume');
  process.exit(0); // the kill. Nothing survives but the snapshot files.
}

async function resumeRun(): Promise<void> {
  const adapter = fsAdapter({ dir: DATA_DIR });
  const snapshot = await adapter.load(WORLD_ID);
  if (!snapshot) {
    console.error('Nothing to resume. Run `pnpm -C examples human-in-the-loop` first.');
    process.exit(1);
  }

  const world = buildWorld();
  world.use(recordsAgent); // register the agent's systems BEFORE load (R19)
  world.load(snapshot); // entities, step counter, pending dirt — the lot (R36)
  console.log(`Loaded snapshot of '${WORLD_ID}' at step ${snapshot.step}.`);

  const pending = world.pending();
  const first = pending[0];
  if (!first) {
    console.log('Nothing is awaiting a human; the world is already settled.');
    return;
  }
  for (const interrupt of first.interrupts) {
    console.log(`Pending ${interrupt.kind} on entity ${first.entity}:`);
    console.log(`   ${JSON.stringify(interrupt.payload)}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nApprove delete_record? (y/n) ')).trim().toLowerCase();
  rl.close();
  const approved = answer === 'y' || answer === 'yes';

  const run = world.resume(
    first.entity,
    approved ? true : { approved: false, reason: 'denied at the terminal' },
  );
  await watch(run);
  await run;
  console.log(`\nAgent: ${lastAssistant(world, first.entity)?.content}`);
}

if (process.argv.includes('--resume')) {
  await resumeRun();
} else {
  await freshRun();
}
