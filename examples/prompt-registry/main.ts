// Runnable demo of the versioned prompt registry (PROMPT-01/02/03).
//
// Run with: pnpm -C examples prompt-registry
//
// THIS FILE IS THE ONLY PLACE the OPENAI_API_KEY gate lives — a caller site.
// The suite/test never read it (enforced by `grep`), so the default path
// (`pnpm -C examples prompt-registry`, no key) registers the deterministic
// scripted model and runs fully offline. When OPENAI_API_KEY is present, an
// ADVISORY real model is swapped in under `model:main`; its answer is printed but
// no CI gate ever depends on a live model (the .test.ts gate stays scripted).

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, scriptedModel } from '@langecs/core';
import {
  inMemoryRegistry,
  lastAssistant,
  PromptRef,
  PromptVars,
  RenderedPrompt,
  registerPrompts,
  resolvePrompt,
  sendMessage,
} from '@langecs/stdlib';
import { loadEnvLocal } from '../_shared/env';
import {
  AGENT_NAME,
  applyRenderedPrompt,
  MODEL_REF,
  promptTemplates,
  SUPPORT_GREETING_REF,
  type SupportGreetingVars,
  supportAgent,
} from './suite';

/** The real model id, used only on the advisory key-gated path. */
const REAL_MODEL = 'gpt-4o-mini';

/** The render inputs for this demo turn. */
const VARS: SupportGreetingVars = { user: 'Ada', topic: 'a billing question' };

loadEnvLocal();

const world = createWorld({ id: 'prompt-registry-demo' });

// The OPENAI_API_KEY gate — the env read lives ONLY here (a caller site).
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined) {
  console.log('No OPENAI_API_KEY set — running the deterministic SCRIPTED model.\n');
  world.register(
    MODEL_REF,
    scriptedModel([{ role: 'assistant', content: 'Happy to help — what can I do for you?' }]),
  );
} else {
  console.log(`OPENAI_API_KEY set — registering an ADVISORY real model (${REAL_MODEL}).`);
  console.log('The real answer is printed for inspection only; no CI gate depends on it.\n');
  // The real provider is constructed only on this branch, only when the key is
  // present (structural gating). The key is never logged or stored.
  world.register(MODEL_REF, fromAiSdk(openai(REAL_MODEL)));
}

// Identical wiring to suite.ts's `wirePromptWorld`, minus the model choice above.
registerPrompts(world, inMemoryRegistry(promptTemplates));
world.use(resolvePrompt);
world.use(applyRenderedPrompt);

// ONE entity that is the reactAgent AND carries the PINNED PromptRef + PromptVars.
const agent = world.spawn(supportAgent, PromptRef(SUPPORT_GREETING_REF), PromptVars(VARS));

// Phase 1: resolve the pinned PromptRef → RenderedPrompt → SystemPrompt.
await world.run();
const rendered = world.entity(agent.id)?.get(RenderedPrompt);
console.log(`Resolved PromptRef('${SUPPORT_GREETING_REF}') for agent:${AGENT_NAME}`);
console.log(`RenderedPrompt (system): ${rendered}\n`);

// Phase 2: the conversation turn — callLLM now sees the resolved SystemPrompt.
const result = await sendMessage(world, agent, 'Hello!');
if (result.status !== 'done') {
  console.error(`World did not quiesce cleanly (status: ${result.status}).`);
  process.exit(1);
}

const reply = lastAssistant(world, agent);
console.log(`User: Hello!`);
console.log(`Agent: ${reply?.content ?? '(no reply)'}`);

// Provenance: the resolved version string is in the snapshot — version → outcome
// linkage for free, with NO @langecs/eval involvement (R3, R35).
const snapshot = world.snapshot();
const agentSnap = snapshot.entities.find((s) => s.id === agent.id);
console.log(
  `\nProvenance (world.snapshot): agent carries PromptRef='${agentSnap?.components.PromptRef}' ` +
    'alongside its RenderedPrompt and Messages — the snapshot IS the record.',
);

if (apiKey !== undefined) {
  console.log('\n(Advisory real-model run — this answer is informational, not a CI gate.)');
}
