/** Base class for every error thrown by LangECS. */
export class LangECSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LangECSError';
  }
}

/** Thrown when `defineComponent`/`defineTag` reuses an existing component name (R7). */
export class DuplicateComponentError extends LangECSError {
  readonly componentName: string;

  constructor(componentName: string) {
    super(
      `Component name "${componentName}" is already defined. Component names are globally unique (R7).`,
    );
    this.name = 'DuplicateComponentError';
    this.componentName = componentName;
  }
}

/** Thrown when a system key is registered twice with a different definition. */
export class DuplicateSystemError extends LangECSError {
  readonly systemKey: string;

  constructor(systemKey: string) {
    super(
      `System "${systemKey}" is already registered with a different definition. System names must be unique per registration scope (R21).`,
    );
    this.name = 'DuplicateSystemError';
    this.systemKey = systemKey;
  }
}

/** Thrown at the barrier when two pairs write the same plain (reducer-less) component (R30). */
export class WriteConflictError extends LangECSError {
  readonly component: string;
  readonly entity: number;
  readonly step: number;
  /**
   * The conflicting (system, entity) pairs, in deterministic barrier order.
   * Structured for programmatic consumers: `entity` is the WRITER pair's own
   * entity, which matters because both writers can share a system name when
   * one writes cross-entity via `ctx.write` (R27).
   */
  readonly pairs: { system: string; entity: number }[];

  constructor(
    component: string,
    entity: number,
    step: number,
    pairs: { system: string; entity: number }[],
  ) {
    super(
      `Write conflict on plain component "${component}" of entity ${entity} at step ${step}: ` +
        `${pairs.map((p) => `${p.system} (entity ${p.entity})`).join(' and ')} wrote it in the same step. ` +
        `Give the component a reducer to merge concurrent writes, or serialize the writers.`,
    );
    this.name = 'WriteConflictError';
    this.component = component;
    this.entity = entity;
    this.step = step;
    this.pairs = pairs;
  }

  /** Display strings `"<system> (entity <id>)"` derived from `pairs`; prefer `pairs` for code. */
  get systems(): string[] {
    return this.pairs.map((p) => `${p.system} (entity ${p.entity})`);
  }
}

/** Thrown on external mutation (or a second `run()`) while a run is in flight (R16, R25). */
export class WorldRunningError extends LangECSError {
  constructor(operation: string) {
    super(
      `Cannot ${operation} while a run is in flight. ` +
        `Await the current run before mutating the world externally (R16).`,
    );
    this.name = 'WorldRunningError';
  }
}

/** Thrown by `world.load()` when a snapshot's `version` is not one this build understands (R36). */
export class SnapshotVersionError extends LangECSError {
  readonly version: unknown;
  readonly supported: number;

  constructor(version: unknown, supported: number) {
    super(
      `Unsupported snapshot version ${JSON.stringify(version)}; this build of @langecs/core ` +
        `reads version ${supported}. Load it with a matching version, or migrate the snapshot first.`,
    );
    this.name = 'SnapshotVersionError';
    this.version = version;
    this.supported = supported;
  }
}

/** Thrown when a component's `deserialize` hook fails while loading a snapshot (R36). */
export class DeserializeError extends LangECSError {
  readonly entity: number;
  readonly component: string;
  readonly cause: unknown;

  constructor(entity: number, component: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Failed to deserialize component "${component}" on entity ${entity}: ${detail}. ` +
        `Check the component's deserialize() hook against the snapshot's stored shape (R36).`,
    );
    this.name = 'DeserializeError';
    this.entity = entity;
    this.component = component;
    this.cause = cause;
  }
}

/** Thrown when a snapshot references component names missing from the registry (R36). */
export class UnknownComponentError extends LangECSError {
  readonly componentNames: string[];

  constructor(componentNames: string[]) {
    super(
      `Unknown component(s): ${componentNames.map((n) => `"${n}"`).join(', ')}. ` +
        `Import the module(s) that define them before loading this snapshot (R36).`,
    );
    this.name = 'UnknownComponentError';
    this.componentNames = componentNames;
  }
}

/** Thrown when pendingPairs reference unregistered systems, or `ctx.invalidate` names one (R36, R24). */
export class UnknownSystemError extends LangECSError {
  readonly systemNames: string[];

  constructor(systemNames: string[]) {
    super(
      `Unknown system(s): ${systemNames.map((n) => `"${n}"`).join(', ')}. ` +
        `Register them with world.use(...) first (R19/R36).`,
    );
    this.name = 'UnknownSystemError';
    this.systemNames = systemNames;
  }
}

/** Thrown by `ctx.resource(name)` when no resource was registered under that name (R18). */
export class MissingResourceError extends LangECSError {
  readonly resourceName: string;

  constructor(resourceName: string) {
    super(
      `No resource registered under "${resourceName}". ` +
        `Call world.register("${resourceName}", impl) before running (R18).`,
    );
    this.name = 'MissingResourceError';
    this.resourceName = resourceName;
  }
}

/** Thrown when an external mutation targets an entity that does not exist. */
export class UnknownEntityError extends LangECSError {
  readonly entity: number;

  constructor(entity: number) {
    super(`Entity ${entity} does not exist in this world (it may have been despawned).`);
    this.name = 'UnknownEntityError';
    this.entity = entity;
  }
}

/** Shape errors take when serialized into `SystemError` records and events (R9, R41). */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack !== undefined) out.stack = err.stack;
    return out;
  }
  return { name: 'Error', message: String(err) };
}
