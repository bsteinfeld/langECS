import { DuplicateComponentError } from './errors';

/**
 * A pending (component, value) pair produced by calling a `ComponentType`.
 * Usable in `world.spawn(...)`, `world.send(...)` and `defineAgent({ components })`.
 *
 * Component values must be treated as immutable: the engine hands out committed
 * values by reference, and only mutations recorded through the API (`add`/`set`/
 * `remove`/`ctx.write`) participate in dirty-triggering and conflict detection.
 */
export interface ComponentInit<T = unknown> {
  readonly component: ComponentType<T>;
  readonly value: T;
}

export interface ComponentOptions<T> {
  name: string;
  /** Merge function for concurrent `add`s within one step (R30) and reducer-aware `add` semantics. */
  reducer?: (current: T, incoming: T) => T;
  /** Transient components are excluded from snapshots (R35). */
  transient?: boolean;
  /** Applied when snapshotting; output must be JSON-serializable (R3). */
  serialize?: (value: T) => unknown;
  /** Applied when loading a snapshot. */
  deserialize?: (raw: unknown) => T;
}

/**
 * A component definition. Callable: `Messages([...])` returns a `ComponentInit` (R5).
 *
 * `N` brands the type with the component's name literal: where the literal is
 * captured (`defineTag`, agent auto-tags) distinct components are distinct
 * types, so R39's positive-term detection cannot confuse them.
 */
export interface ComponentType<T, N extends string = string> {
  (value: T): ComponentInit<T>;
  readonly componentName: N;
  readonly reducer: ((current: T, incoming: T) => T) | undefined;
  readonly transient: boolean;
  readonly serialize: ((value: T) => unknown) | undefined;
  readonly deserialize: ((raw: unknown) => T) | undefined;
}

/**
 * A `ComponentType<true>` callable with zero args (R6), branded with its name
 * literal — `defineTag('busy')` and `defineTag('done')` are distinct types.
 */
export interface TagType<N extends string = string> extends ComponentType<true, N> {
  (value?: true): ComponentInit<true>;
}

/** Negative query term produced by `Not(C)` (R8). */
export interface NotTerm {
  readonly not: ComponentType<any>;
}

export type QueryTerm = ComponentType<any> | NotTerm;

/**
 * Negates a query term (R8): `Not(Busy)` matches entities that do NOT have the
 * component. Queries need at least one positive (non-`Not`) term (R21);
 * `e.get(C)` stays `T | undefined` for negated components (R39).
 */
export function Not(component: ComponentType<any>): NotTerm {
  return { not: component };
}

export function isComponentType(term: QueryTerm): term is ComponentType<any> {
  return typeof term === 'function';
}

// Global registry: component name -> definition, so snapshots rehydrate by name
// and reducers/serializers re-attach (R7).
const registry = new Map<string, ComponentType<any>>();

function makeComponent<T>(opts: ComponentOptions<T>, zeroArgDefault?: T): ComponentType<T> {
  if (registry.has(opts.name)) throw new DuplicateComponentError(opts.name);
  const callable = (value: T): ComponentInit<T> => ({
    component: type,
    value: value === undefined && zeroArgDefault !== undefined ? zeroArgDefault : value,
  });
  const type = Object.assign(callable, {
    componentName: opts.name,
    reducer: opts.reducer,
    transient: opts.transient ?? false,
    serialize: opts.serialize,
    deserialize: opts.deserialize,
  }) as unknown as ComponentType<T>;
  // Make the function's own `name` match for debugging/DX.
  Object.defineProperty(type, 'name', { value: opts.name, configurable: true });
  registry.set(opts.name, type);
  return type;
}

/**
 * Defines a component type and registers it under its globally unique name —
 * a duplicate name throws immediately (R4, R7). The result is callable:
 * `Messages([...])` produces a `ComponentInit` for `spawn`/`send`/agent
 * bundles (R5). Values must be structured-clone/JSON-serializable (R3);
 * `serialize`/`deserialize` hooks adapt exotic values, `transient: true`
 * excludes the component from snapshots (R35), and a `reducer` makes
 * concurrent same-step `add`s merge instead of conflict (R30).
 *
 * Type caveat: because `T` is passed explicitly, the returned type is branded
 * by value shape only — two `defineComponent<string>(...)` results are
 * type-interchangeable. See `EntityReadView.get` for the R39 consequence;
 * `defineTag` captures the name literal and does not share this caveat.
 */
export function defineComponent<T>(opts: ComponentOptions<T>): ComponentType<T> {
  return makeComponent(opts);
}

/**
 * Defines a tag: a `ComponentType<true>` callable with zero args (R6),
 * registered like any component (R7). The name literal is captured in the
 * type, so distinct tags are distinct types and `e.get(SomeOtherTag)` cannot
 * masquerade as a positive query term (R39).
 */
export function defineTag<const N extends string>(name: N): TagType<N> {
  return makeComponent<true>({ name }, true) as TagType<N>;
}

/**
 * Looks up a component definition in the global registry by name (R7) —
 * how snapshots rehydrate reducers/serializers on `world.load` (R36).
 * Returns `undefined` when no component with that name has been defined.
 */
export function getComponentByName(name: string): ComponentType<any> | undefined {
  return registry.get(name);
}
