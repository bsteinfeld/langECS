import type { AgentDef } from './agent';
import type { ComponentInit, ComponentType, QueryTerm, TagType } from './component';
import { isComponentType } from './component';
import { LangECSError } from './errors';
import type { ResourceRef } from './resource';

/** Value type carried by a component type. */
export type ComponentValue<C> = C extends ComponentType<infer T> ? T : never;

/** The positive (non-`Not`) component types of a query tuple. */
export type PositiveTerms<Q extends readonly QueryTerm[]> = Extract<Q[number], ComponentType<any>>;

/**
 * `e.get(C)` returns `T` (non-optional) for positive query terms, `T | undefined`
 * otherwise (R39). Tuple-wrapped to avoid distributing over `C`.
 */
export type GetResult<C extends ComponentType<any>, Q extends readonly QueryTerm[]> = [C] extends [
  PositiveTerms<Q>,
]
  ? ComponentValue<C>
  : ComponentValue<C> | undefined;

/** Read-only view of an entity; `when` guards receive this (R21). */
export interface EntityReadView<Q extends readonly QueryTerm[] = readonly never[]> {
  readonly id: number;
  has(component: ComponentType<any>): boolean;
  /**
   * Returns the committed value **by reference**; treat it as immutable (R17
   * amended). Mutating it in place is undefined behavior: the engine does not
   * detect it, no dirt or conflict is generated, and other pairs may observe
   * the mutation mid-step. Mutate only via `add`/`set`/`remove`/`ctx.write`.
   *
   * Type caveat (R39): positive-term membership — and so non-nullability — is
   * decided structurally. Tags (`defineTag`) and agent auto-tags are branded
   * with their name literal and never collide, but two
   * `defineComponent<T>(...)` results with the same `T` are
   * type-interchangeable: `get()` of an absent same-shaped component can
   * typecheck as non-nullable `T` yet return `undefined` at runtime. When in
   * doubt, guard with `has(C)`.
   */
  get<C extends ComponentType<any>>(component: C): GetResult<C, Q>;
  components(): string[];
}

/**
 * Entity view with mutators (R15). Inside a system, mutations buffer until the
 * step barrier (R17); on an external `EntityHandle` they apply immediately (R16).
 */
export interface EntityView<Q extends readonly QueryTerm[] = readonly never[]>
  extends EntityReadView<Q> {
  /** Merge via the component's reducer when it has one, else set. */
  add(tag: TagType): void;
  add<C extends ComponentType<any>>(component: C, value: ComponentValue<C>): void;
  /** Replace, bypassing any reducer. */
  set(tag: TagType): void;
  set<C extends ComponentType<any>>(component: C, value: ComponentValue<C>): void;
  remove(component: ComponentType<any>): void;
  despawn(): void;
}

/** External entity handle returned by `world.spawn`/`world.query` (R14, R20). */
export type EntityHandle<Q extends readonly QueryTerm[] = readonly never[]> = EntityView<Q>;

/** Targets accepted by `ctx.*` mutators: an id, an `EntityHandle`, or an `EntityView` (R22). */
export type EntityTarget = number | { readonly id: number };

/** Read view of the world over step-start committed state (R22). */
export interface WorldReadView {
  query<const Q extends readonly QueryTerm[]>(...terms: Q): EntityReadView<Q>[];
  entity(id: number): EntityReadView | undefined;
}

/**
 * Restricted context passed to `when` guards (R21 amended): read-only access
 * only — no mutators, no `emit`. Guards receive this at both the type level
 * and at runtime; they cannot buffer writes, spawn, despawn, invalidate, or
 * emit events.
 */
export type GuardCtx = Pick<SystemCtx, 'step' | 'world' | 'resource'>;

export interface SystemCtx {
  readonly step: number;
  readonly world: WorldReadView;
  /**
   * Allocates the entity id eagerly and returns a handle whose components
   * materialize at the barrier (R29). Accepts `AgentDef`s (supervisors spawn workers).
   */
  spawn(...items: (ComponentInit<any> | AgentDef)[]): EntityView;
  despawn(target: EntityTarget): void;
  write<C extends ComponentType<any>>(
    target: EntityTarget,
    component: C,
    value: ComponentValue<C>,
    op?: 'add' | 'set',
  ): void;
  remove(target: EntityTarget, component: ComponentType<any>): void;
  /** Pushes a `custom` event to the live run stream immediately, mid-step (R23). */
  emit(data: unknown): void;
  /**
   * Typed resource lookup via a `ResourceRef` (R18 amended): `T` comes from
   * the ref, no manual generic. Throws `MissingResourceError` (naming the
   * resource) when nothing is registered under the ref's name.
   */
  resource<T>(ref: ResourceRef<T>): T;
  /** String-keyed resource lookup (R18); same slot as the ref form. */
  resource<T>(name: string): T;
  /** Manually marks (system, entity) — or all systems for the entity — dirty (R24). */
  invalidate(target: EntityTarget, system?: string): void;
  /**
   * Cancellation signal for this (pair, step) (R51). Aborts when the world is
   * cancelled (`world.cancel`, R50) **or** this system's `timeoutMs` elapses
   * (R52) — never because a sibling pair timed out.
   *
   * Pass it to every awaited call the pair makes (`ctx.signal` →
   * `ModelRequest.signal`, `fetch`, a DB driver) and honour it in long loops
   * with `throwIfAborted(ctx.signal)`. Doing so is what makes "stop" mean stop:
   * the engine can stop *waiting* on its own, but only the system can stop the
   * work.
   */
  readonly signal: AbortSignal;
}

export interface SystemDef<Q extends readonly QueryTerm[] = readonly QueryTerm[]> {
  /** Unique per registration scope (R21). */
  readonly name: string;
  /** At least one positive term (R21). */
  readonly query: Q;
  /**
   * Sync guard over a read-only view and a restricted `GuardCtx` (R21 amended);
   * returning `false` vetoes — the veto's dirt is consumed at the barrier
   * commit (R26 amended).
   */
  readonly when?: (entity: EntityReadView<Q>, ctx: GuardCtx) => boolean;
  readonly run: (entity: EntityView<Q>, ctx: SystemCtx) => void | Promise<void>;
  /**
   * Wall-clock budget for one execution of this system (R52); falls back to the
   * world's `systemTimeoutMs`. On expiry the engine aborts `ctx.signal`, stops
   * waiting for the pair, discards its buffered writes, and records a
   * `SystemTimeoutError` on the entity's `SystemError` — the same path as a
   * throw (R31), so `retry` can heal it.
   *
   * This is the escape from a hung barrier: without it, one system that never
   * settles stalls the step forever — no commit, no snapshot, and
   * `world.running` stuck true. Guards are never timed (they are sync).
   */
  readonly timeoutMs?: number;
}

/**
 * Defines a system (R21): a `query` with at least one positive term (throws
 * otherwise), an optional **sync** `when` guard over read-only views (a veto
 * consumes the pair's dirt, R26), and a `run` executed once per dirty matching
 * entity per step — concurrently with the step's other pairs, with all
 * mutations buffered to the barrier (R17, R25). Register globally with
 * `world.use(system)` or scope to an agent via `defineAgent({ systems })`
 * (R19, R34). The query tuple is captured `const`, so `e.get(C)` is
 * non-nullable exactly for the positive terms (R39).
 */
export function defineSystem<const Q extends readonly QueryTerm[]>(
  def: SystemDef<Q>,
): SystemDef<Q> {
  if (!def.query.some((term) => isComponentType(term))) {
    throw new LangECSError(
      `System "${def.name}" must have at least one positive query term (R21).`,
    );
  }
  return def;
}

export function resolveTarget(target: EntityTarget): number {
  return typeof target === 'number' ? target : target.id;
}
