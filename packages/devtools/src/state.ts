// Builds the `world` message payload — a full, detached `WorldState` built
// synchronously from the introspection surface (SPEC §14, R47). Called inside
// observer callbacks at barrier boundaries, where committed state is
// consistent (R25), so everything here MUST stay synchronous.

import { getComponentByName, listComponents, type World } from '@langecs/core';
import type { ComponentState, EntityState, WorldState } from './protocol';

/**
 * Detaches a component value via a JSON round-trip so the wire payload never
 * aliases live storage. Component values are serializable by contract (R3),
 * but transient components can legally hold JSON-hostile values (circular
 * refs, BigInt) — those degrade to a `$unserializable` marker instead of
 * taking the whole `world` message down.
 */
function detachValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    // `undefined`/functions serialize to nothing; render as null, not a crash.
    return json === undefined ? null : (JSON.parse(json) as unknown);
  } catch (err) {
    return { $unserializable: String(err) };
  }
}

const AGENT_TAG_PREFIX = 'agent:';

/** Synchronous full-state capture; `historySteps` is the server's cached list. */
export function buildWorldState(world: World, historySteps: number[] | null): WorldState {
  const components = listComponents();
  const infoByName = new Map(components.map((info) => [info.name, info]));

  const entities: EntityState[] = world.query().map((handle) => {
    const componentStates: ComponentState[] = [];
    const agents: string[] = [];
    for (const name of handle.components()) {
      if (name.startsWith(AGENT_TAG_PREFIX)) agents.push(name.slice(AGENT_TAG_PREFIX.length));
      const def = getComponentByName(name);
      const info = infoByName.get(name);
      componentStates.push({
        name,
        value: detachValue(def ? handle.get(def) : undefined),
        tag: info?.tag ?? false,
        reducer: def?.reducer !== undefined,
        transient: def?.transient ?? false,
      });
    }
    return { id: handle.id, components: componentStates, agents };
  });

  return {
    worldId: world.id,
    step: world.step,
    running: world.running,
    entities,
    systems: world.systems(),
    components,
    resources: world.resources(),
    // snapshot() is synchronous and boundary-consistent (R35) — safe inside
    // observer callbacks.
    pendingPairs: world.snapshot().pendingPairs,
    interrupts: world.pending(),
    historySteps,
  };
}
