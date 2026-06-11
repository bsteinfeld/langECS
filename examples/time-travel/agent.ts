// Shared agent module for the time-travel example. Both main.ts (real model)
// and time-travel.test.ts (scriptedModel) build their worlds from here, so the
// demo and the deterministic test exercise the exact same choreography.

import {
  createWorld,
  type Model,
  type PersistenceAdapter,
  type Snapshot,
  type World,
} from '@langecs/core';
import { defineTool, reactAgent, registerTools } from '@langecs/stdlib';

/** Small, cheap model for the live demo (main.ts only; tests never touch it). */
export const MODEL_ID = 'gpt-4o-mini';
/** worldId of the original timeline; checkpoints are stored under this key. */
export const WORLD_ID = 'time-travel';
/** Resource name the Model registers under (components reference it by name). */
export const MODEL_RESOURCE = 'model:main';

/** Placeholder search engine, same shape as the LangGraph.js time-travel how-to. */
export const searchTool = defineTool({
  name: 'search',
  description:
    'Use to surf the web, fetch current information, check the weather, and retrieve other information.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The query to use in your search.' },
    },
    required: ['query'],
  },
  execute: () => 'Cold, with a low of 13 ℃',
});

/**
 * The agent under time travel: a stock ReAct preset. Underneath it is plain
 * ECS — Messages/ModelRef components, callLLM/executeTools systems scoped by
 * the auto-tag `agent:time-traveler` (all of it lands in every snapshot).
 */
export const timeTraveler = reactAgent({
  name: 'time-traveler',
  model: MODEL_RESOURCE,
  tools: [searchTool],
});

/** A world wired with the model resource and tool implementations. */
export function buildWorld(opts: {
  id: string;
  model: Model;
  persistence?: PersistenceAdapter;
}): World {
  const world = createWorld({
    id: opts.id,
    ...(opts.persistence && { persistence: opts.persistence }),
  });
  world.register(MODEL_RESOURCE, opts.model);
  registerTools(world, [searchTool]);
  return world;
}

/**
 * Time travel: a FRESH world rewound to a saved snapshot. Order matters —
 * `world.use(agentDef)` registers the agent's scoped systems without spawning
 * (R19) so `world.load()` can resolve every component and pending pair (R36).
 */
export function forkFromSnapshot(opts: {
  id: string;
  model: Model;
  snapshot: Snapshot;
  persistence?: PersistenceAdapter;
}): World {
  const world = buildWorld(opts);
  world.use(timeTraveler);
  world.load(opts.snapshot);
  return world;
}
