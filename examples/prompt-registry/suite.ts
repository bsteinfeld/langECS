// Shared wiring for the prompt-registry example (PROMPT-01/02/03).
//
// This ships a tiny VERSIONED prompt registry and an agent that reads a
// resolved prompt as its SystemPrompt — the full Plan 01 flow end to end:
//
//   definePrompts → inMemoryRegistry → registerPrompts
//     → resolvePrompt renders a pinned PromptRef('name@version') into a
//       RenderedPrompt → an example-local applyRenderedPrompt copies it into
//       the agent's SystemPrompt → callLLM (reactAgent) sends it to the model.
//
// Everything here is deterministic and zero-network: the model is a
// `scriptedModel`, this file reads no env var and imports no provider package.
// The optional real-model gate lives ONLY in main.ts (a caller site).

import {
  type AgentDef,
  createWorld,
  defineSystem,
  type EntityHandle,
  type ModelRequest,
  type Msg,
  Not,
  scriptedModel,
  type World,
} from '@langecs/core';
import {
  definePrompts,
  inMemoryRegistry,
  PromptRef,
  type PromptTemplate,
  PromptVars,
  RenderedPrompt,
  reactAgent,
  registerPrompts,
  renderSlots,
  resolvePrompt,
  SystemPrompt,
  sendMessage,
} from '@langecs/stdlib';

/** The model resource name the agent references by string (R3). */
export const MODEL_REF = 'model:main' as const;

/** The agent's auto-tag name (`agent:support`). */
export const AGENT_NAME = 'support' as const;

/**
 * The reactAgent definition, built ONCE at module load. `reactAgent` registers a
 * globally-unique `agent:support` tag (R7), so it must NOT be called per-world —
 * every world spawns this shared `AgentDef`. It reads its model by the
 * `model:main` string (R3) and gets its SystemPrompt from the resolved prompt
 * (no fixed `systemPrompt` here — that is filled by `applyRenderedPrompt`).
 */
export const supportAgent: AgentDef = reactAgent({ name: AGENT_NAME, model: MODEL_REF });

/**
 * The PINNED prompt reference for this demo. NEVER use the mutable `@latest`
 * form — `pnpm prompts:gate` rejects it in committed examples/tests, and an
 * unpinned ref would let an outcome silently track a different prompt version.
 */
export const SUPPORT_GREETING_REF = 'support-greeting@1.0.0' as const;

/**
 * Typed render inputs for the support-greeting template. A type alias (not an
 * `interface`) so it carries an index signature and is assignable to the
 * `Record<string, unknown>` that `renderSlots`/`PromptVars` accept.
 */
export type SupportGreetingVars = {
  user: string;
  topic: string;
} & Record<string, unknown>;

/**
 * The versioned template registry. `render` is injection-safe single-pass slot
 * substitution (`renderSlots`): a var value lands as opaque DATA in the prompt,
 * never re-parsed as template syntax — so an adversarial value cannot open a new
 * `{{slot}}` or escape a delimiter (PROMPT-02). Behavior (the render closure)
 * lives only here in the registry resource, never in a component (R3).
 */
export const promptTemplates: PromptTemplate<SupportGreetingVars>[] = definePrompts([
  {
    name: 'support-greeting',
    version: '1.0.0',
    render: ({ user, topic }) =>
      renderSlots('You are a support agent helping {{user}} with {{topic}}. Be concise.', {
        user,
        topic,
      }),
  },
]);

/**
 * Example-local one-shot system that promotes a `RenderedPrompt` into the
 * agent's `SystemPrompt` so `callLLM` (reactAgent) sends it to the model.
 * `Not(SystemPrompt)` makes it fire exactly once per entity (self-write
 * exclusion, R26): writing `SystemPrompt` removes the entity from the match set.
 * This is example glue — it touches no package source.
 */
export const applyRenderedPrompt = defineSystem({
  name: 'applyRenderedPrompt',
  query: [RenderedPrompt, Not(SystemPrompt)],
  run: (e) => {
    e.set(SystemPrompt, e.get(RenderedPrompt));
  },
});

/**
 * A scriptedModel whose single turn is a function so a caller can observe the
 * exact `req.system` the model received — i.e. the resolved RenderedPrompt that
 * actually reached the model. `captured.system` is filled on generate.
 * Deterministic and offline.
 */
export function captureModel(): {
  model: ReturnType<typeof scriptedModel>;
  captured: { system?: string };
} {
  const captured: { system?: string } = {};
  const turn = (req: ModelRequest): Msg => {
    captured.system = req.system;
    return { role: 'assistant', content: 'Happy to help — what can I do for you?' };
  };
  return { model: scriptedModel([turn]), captured };
}

/** What `wirePromptWorld` returns: the agent handle, the captured req, and the pinned ref. */
export interface PromptWiring {
  agent: EntityHandle;
  captured: { system?: string };
  ref: string;
  expectedSystem: string;
}

/**
 * Wires a world for the prompt-registry flow and returns the handles the test
 * (and main.ts) assert against. By default `vars` greets a benign topic; pass
 * an adversarial `topic` to demonstrate injection-safe rendering (PROMPT-02).
 *
 * Steps:
 *  1. register the (scripted, capturing) model under `model:main`;
 *  2. registerPrompts(inMemoryRegistry(promptTemplates));
 *  3. world.use(resolvePrompt) + world.use(applyRenderedPrompt);
 *  4. spawn ONE entity that is a reactAgent AND carries the pinned PromptRef +
 *     PromptVars (so resolvePrompt → applyRenderedPrompt fills its SystemPrompt).
 */
export function wirePromptWorld(
  world: World,
  vars: SupportGreetingVars = { user: 'Ada', topic: 'a billing question' },
): PromptWiring {
  const { model, captured } = captureModel();
  world.register(MODEL_REF, model);
  registerPrompts(world, inMemoryRegistry(promptTemplates));
  world.use(resolvePrompt);
  world.use(applyRenderedPrompt);

  const agent = world.spawn(supportAgent, PromptRef(SUPPORT_GREETING_REF), PromptVars(vars));

  // The rendered prompt the model SHOULD receive (same single-pass renderer).
  const expectedSystem = renderSlots(
    'You are a support agent helping {{user}} with {{topic}}. Be concise.',
    vars,
  );

  return { agent, captured, ref: SUPPORT_GREETING_REF, expectedSystem };
}

/**
 * Convenience: build a fresh world, wire it, resolve the prompt, then drive one
 * user turn. Returns wiring + the final run status.
 *
 * The prompt is resolved to a `SystemPrompt` (a first `world.run()` quiesces
 * `resolvePrompt` → `applyRenderedPrompt`) BEFORE the user message is sent, so
 * `callLLM` already sees the rendered SystemPrompt when it fires. This models the
 * real-world ordering: the prompt is bound to the agent at spawn, the
 * conversation happens after.
 */
export async function runPromptWorld(
  vars?: SupportGreetingVars,
): Promise<{ world: World; wiring: PromptWiring; status: string }> {
  const world = createWorld({ id: 'prompt-registry' });
  const wiring = wirePromptWorld(world, vars);
  // Phase 1: resolve PromptRef → RenderedPrompt → SystemPrompt to quiescence.
  await world.run();
  // Phase 2: the conversation turn — callLLM now sees the resolved SystemPrompt.
  const result = await sendMessage(world, wiring.agent, 'Hello!');
  return { world, wiring, status: result.status };
}
