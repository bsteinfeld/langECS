import type { ComponentInit, TagType } from './component';
import { defineTag } from './component';
import type { SystemDef } from './system';

/**
 * A named, spawnable bundle of components + scoped systems (R34).
 *
 * Spawning adds the hidden-by-convention tag `agent:<name>` (a real component,
 * present in snapshots) and idempotently registers each declared system under
 * the key `<agentName>:<systemName>` with its query narrowed by the tag.
 */
export interface AgentDef<N extends string = string> {
  readonly kind: 'agent';
  readonly name: N;
  readonly components: readonly ComponentInit<any>[];
  readonly systems: readonly SystemDef<any>[];
  /** The `agent:<name>` auto-tag, name-branded so two agents' tags are distinct types (R39). */
  readonly tag: TagType<`agent:${N}`>;
}

/**
 * Defines a named, spawnable agent (R34): a component bundle plus systems
 * scoped to entities spawned from it. Spawning (via `world.spawn` or
 * `ctx.spawn`) applies the bundle (deep-copied — spawns never alias the
 * template), adds the `agent:<name>` auto-tag, and idempotently registers each
 * system under `<agentName>:<systemName>` with its query narrowed by the tag.
 * Spawn-time extra inits override bundle inits for the same component.
 * Defining the tag registers `agent:<name>` in the global component registry,
 * so a duplicate agent name throws immediately (R7).
 */
export function defineAgent<const N extends string>(opts: {
  name: N;
  components?: ComponentInit<any>[];
  systems?: SystemDef<any>[];
}): AgentDef<N> {
  // Registers `agent:<name>` in the global component registry; a duplicate
  // agent name therefore throws immediately (R7).
  const tag = defineTag(`agent:${opts.name}` as `agent:${N}`);
  return {
    kind: 'agent',
    name: opts.name,
    components: opts.components ?? [],
    systems: opts.systems ?? [],
    tag,
  };
}

export function isAgentDef(item: unknown): item is AgentDef {
  return (
    typeof item === 'object' &&
    item !== null &&
    'kind' in item &&
    (item as { kind: unknown }).kind === 'agent'
  );
}
