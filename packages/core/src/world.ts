import type { AgentDef } from './agent';
import { isAgentDef } from './agent';
import type { CancellationRecord, ErrorRecord, InterruptRecord } from './builtins';
import { AwaitingHuman, Cancelled, HumanResponse, SystemError } from './builtins';
import { abortReason, anySignal } from './cancel';
import type { ComponentInit, ComponentType, QueryTerm } from './component';
import { getComponentByName, isComponentType } from './component';
import {
  CancelledError,
  DeserializeError,
  DuplicateMigrationError,
  DuplicateSystemError,
  FenceError,
  LangECSError,
  MissingResourceError,
  RecipeVersionError,
  type SerializedError,
  SnapshotVersionError,
  StaleSnapshotError,
  SystemTimeoutError,
  serializeError,
  UnknownComponentError,
  UnknownEntityError,
  UnknownSystemError,
  WorldRunningError,
  WriteConflictError,
} from './errors';
import type { ChangeRecord, PairRef, Run, RunEvent, RunResult, RunStatus } from './events';
import { RunStream } from './events';
import type {
  ExternalChange,
  ObserverEvent,
  QueryStat,
  SystemInfo,
  SystemRunInfo,
  WorldObserver,
} from './observe';
import type { PersistenceAdapter } from './persistence';
import type { ResourceRef } from './resource';
import type { LoadCheck, LoadReport, Migration, PendingPair, Snapshot } from './snapshot';
import type {
  EntityHandle,
  EntityReadView,
  EntityTarget,
  EntityView,
  GuardCtx,
  SystemCtx,
  SystemDef,
  WorldReadView,
} from './system';
import { resolveTarget } from './system';
import type { DroppedWrite, StepTrace, TraceRun } from './trace';

const perf = (globalThis as { performance?: { now(): number } }).performance;
const now: () => number = perf ? () => perf.now() : () => Date.now();

// Timers via `globalThis` rather than a type library, like `performance` above
// (R1). Used only for system timeouts (R52).
const timers = globalThis as unknown as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

// `console` is allowed but not assumed (R1): observer faults are reported,
// never thrown (R45), and a console-less runtime just drops the report.
// Resolved at call time so test spies and runtime console swaps are honored.
const report = (...args: unknown[]): void => {
  (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console?.error?.(...args);
};

const nativeStructuredClone = (globalThis as { structuredClone?: <T>(value: T) => T })
  .structuredClone;
/**
 * Detached deep copy. Component values are structured-clone serializable by
 * contract (R3); the JSON fallback only covers exotic runtimes without
 * `structuredClone`. Used for spawn materialization (R34 amended) and for
 * observation surfaces (R28/R41/R42 amended) so nothing shares identity with
 * committed storage.
 */
const deepClone = <T>(value: T): T =>
  nativeStructuredClone
    ? nativeStructuredClone(value)
    : value === undefined
      ? value
      : (JSON.parse(JSON.stringify(value)) as T);

export interface WorldOptions {
  id?: string;
  persistence?: PersistenceAdapter;
  recursionLimit?: number;
  trace?: boolean | { keep?: number };
  /**
   * Default wall-clock budget for every system execution (R52), overridden
   * per system by `defineSystem({ timeoutMs })`. Unset means no timeout, which
   * is the historical behavior: one system that never settles hangs the barrier
   * forever. Set it on any world whose systems make network calls.
   */
  systemTimeoutMs?: number;
  /**
   * Version of **your** component/system vocabulary (R54) — not the engine's
   * snapshot format, which is versioned separately and independently. Stamped
   * into every snapshot and used to pick migrations on `load`. Bump it whenever
   * you rename or reshape a component, and register a `world.migration` for the
   * step; leaving it unset means version 0 and no migration.
   */
  recipeVersion?: number;
  /**
   * How often the engine persists (R58). `'barrier'` (default) saves after every
   * committed step — required for step-level time travel. `'quiescence'` saves
   * only at run end. A number saves every N steps. Run end always saves, at
   * every setting, so a quiesced world is never unpersisted.
   */
  saveEvery?: 'barrier' | 'quiescence' | number;
  /**
   * Ask the adapter to fence every write (R57). With `true`, the engine calls
   * `adapter.fence(worldId, step)` before each save and rejects the run with
   * `FenceError` if another instance already owns that step — the guard against
   * two workers resuming one snapshot and silently diverging.
   *
   * Off by default, and deliberately not implied by the adapter having a
   * `fence` method: a time-travel world replays steps it has already written, so
   * fencing it would refuse its own legitimate rewrites (R38).
   */
  fence?: boolean;
}

/** One pair executing right now, as reported by `world.runningPairs()` (R53). */
export interface RunningPair {
  system: string;
  entity: number;
  /** Step the pair is executing in. */
  step: number;
  /** Milliseconds elapsed since the pair's `run` was invoked. */
  elapsedMs: number;
  /** Effective timeout for this pair, when one applies (R52). */
  timeoutMs?: number;
  /**
   * True when the barrier stopped waiting for this pair (R52) but its `run` is
   * still executing. Kept visible on purpose: a system hung badly enough to be
   * abandoned is exactly what an operator is looking for here.
   */
  abandoned?: boolean;
}

export interface World {
  /** World id (default `'world'`, R12) — the persistence key for adapters (R37). */
  readonly id: string;
  /** Committed step counter; increments at each barrier commit (R25), restored by `load` (R36). */
  readonly step: number;
  /** Whether a run is in flight (R47) — external mutation throws while `true` (R16). */
  readonly running: boolean;
  /**
   * Creates an entity from component inits and/or `AgentDef` bundles (R14).
   * Agent bundles apply their components plus the `agent:<name>` auto-tag and
   * idempotently register the agent's systems; init values are deep-copied, so
   * spawned entities never alias the template (R34). External mutation: applies
   * immediately while idle, throws `WorldRunningError` mid-run (R16).
   */
  spawn(...items: (ComponentInit<any> | AgentDef)[]): EntityHandle;
  /**
   * Registers a global system, or an agent's scoped systems without spawning
   * (R19) — required before `load()` of a snapshot whose entities/pendingPairs
   * reference that agent (R36). Idempotent per definition; reusing a name with
   * a different definition throws `DuplicateSystemError` (R21).
   */
  use(def: SystemDef<any> | AgentDef): void;
  /**
   * Registers a resource under a typed `ResourceRef` (R18 amended): `value`
   * is checked against the ref's `T`, and `ctx.resource(ref)` reads it back
   * typed. Same string-keyed slot as the name form below.
   */
  register<T>(ref: ResourceRef<T>, value: NoInfer<T>): void;
  /**
   * Registers a named resource for `ctx.resource(name)` (R18) — models, DB
   * handles, anything non-serializable. Resources are never snapshotted;
   * re-register them after `load()`.
   */
  register(name: string, resource: unknown): void;
  /**
   * Queries committed state, ordered by entity id (R20). Returned handles
   * mutate immediately while idle and throw `WorldRunningError` during a run
   * (R16); their `get()` is non-nullable for this query's positive terms (R39).
   */
  query<const Q extends readonly QueryTerm[]>(...terms: Q): EntityHandle<Q>[];
  /**
   * Looks up one entity by id over committed state; `undefined` if despawned
   * or never spawned. Same external-handle semantics as `query` (R16, R20).
   */
  entity(id: number): EntityHandle | undefined;
  /**
   * Runs the step loop until quiescence (R25). One run at a time: calling
   * while a run is in flight throws `WorldRunningError`. `limit` caps steps
   * for this run (default: the world's `recursionLimit`, default 50); hitting
   * it returns status `'limit'` with all remaining dirt intact, so a later
   * `run()` resumes the pending work. The returned `Run` is both
   * `PromiseLike<RunResult>` and `AsyncIterable<RunEvent>` (R40); barrier
   * rejections (e.g. `WriteConflictError`) reject the promise and throw from
   * iterators after draining buffered events.
   */
  run(opts?: { limit?: number }): Run;
  /**
   * External `add`s of `inits` to `target` (reducers merge, R15/R16), then
   * `run()` — the one-liner for "give the agent input and let it work" (R25).
   */
  send(target: EntityTarget, ...inits: ComponentInit<any>[]): Run;
  /**
   * Entities with pending `AwaitingHuman` interrupts, from committed state,
   * ordered by entity id (R33). Returns detached copies — mutating them never
   * touches component state (R28).
   */
  pending(): { entity: number; interrupts: InterruptRecord[] }[];
  /**
   * Cancels the world (R50): aborts every in-flight pair's `ctx.signal` and
   * stamps `Cancelled({ step, reason })` on every entity, so systems carrying
   * the conventional `Not(Cancelled)` guard stop matching.
   *
   * Unlike every other external mutation (R16) this is legal **mid-run** —
   * being able to stop a run in flight is the entire point, and it never
   * mutates component state from outside a barrier: mid-run the stamp is an
   * engine write at the next step boundary, so the trace and every snapshot
   * stay boundary-consistent. Idle, it applies immediately like any other
   * external write.
   *
   * Cancellation is **cooperative**. The engine stops *waiting* for a pair only
   * when that pair has a `timeoutMs` (R52); otherwise it aborts `ctx.signal`
   * and a system that ignores the signal still runs to completion, with its
   * writes committing normally. For a hard bound, combine this with
   * `timeoutMs`.
   *
   * Because the state *is* the cancellation, it survives snapshot/load, and
   * removing `Cancelled` from the entities un-cancels the world.
   */
  cancel(reason?: string): void;
  /**
   * Pairs executing right now, in scheduling order (R53) — the complement of
   * `systems()` ("what could run") and `systemsMatching()` ("what could run for
   * this entity"): this is what *is* running, and for how long. Empty unless a
   * run is in flight. Safe to call mid-run, including from an observer.
   */
  runningPairs(): RunningPair[];
  /**
   * Answers a human-in-the-loop interrupt (R33): removes `AwaitingHuman`
   * entirely, sets `HumanResponse({ value })`, then runs to quiescence.
   * External and idle-only like all handle mutation (R16). Convention: systems
   * consume the answer with `remove(HumanResponse)`.
   */
  resume(target: EntityTarget, value: unknown): Run;
  /**
   * Serializes committed state at the current step boundary (R35): entities
   * (transient components excluded, `serialize` hooks applied), step counter,
   * entity-id counter, and pending dirt. Always JSON-stringifiable and
   * detached from live state. Resources and trace are not included.
   */
  snapshot(): Snapshot;
  /**
   * Restores a snapshot (R36). Preconditions: every component name must be
   * resolvable in the global registry (import the modules that define them)
   * and every pendingPairs system registered via `use()` — otherwise throws
   * `UnknownComponentError`/`UnknownSystemError` listing what's missing.
   * Restores entities (`deserialize` hooks applied), step and id counters,
   * and pending dirt, so the world continues identically from the boundary.
   * Pre-existing entities are discarded and the flight-recorder buffer is
   * cleared (R42): the trace never mixes steps from two timelines. Idle-only;
   * resources must be re-registered separately (R18).
   *
   * Registered migrations run first, bringing the snapshot's `recipeVersion` up
   * to this world's before anything is resolved (R54) — which is what lets a
   * migration rename a component this build no longer knows about.
   *
   * Options:
   * - `expectedStep` — throw `StaleSnapshotError` unless the snapshot sits at
   *   exactly this step (R57). The adapter-free half of resume safety: cheap,
   *   synchronous, and enough to catch a resume racing a worker that already
   *   advanced the world.
   * - `strict: false` — resolve what can be resolved and report the rest instead
   *   of throwing (R55). Unknown components are **preserved as opaque data** and
   *   written back by the next `snapshot()`; unknown `pendingPairs` are dropped
   *   and reported, because dirt names a system that has to be scheduled and
   *   there is nowhere to keep it.
   */
  load(snapshot: Snapshot, opts?: { strict?: boolean; expectedStep?: number }): LoadReport;
  /**
   * Registers a migration from one `recipeVersion` to another (R54), applied by
   * `load` in a forward chain. Two migrations sharing a `from` throw
   * `DuplicateMigrationError`, so the upgrade path is never ambiguous.
   *
   * This is the answer to the failure that otherwise lands on the users who
   * trusted persistence most: someone pauses a run awaiting approval, you deploy
   * a component rename, and their world becomes permanently unloadable.
   *
   * ```ts
   * const world = createWorld({ recipeVersion: 2 })
   * world.migration(1, 2, (s) => {
   *   for (const e of s.entities) {
   *     if ('Draft' in e.components) {
   *       e.components.Article = e.components.Draft
   *       delete e.components.Draft
   *     }
   *   }
   *   for (const p of s.pendingPairs) if (p.system === 'writeDraft') p.system = 'writeArticle'
   *   return s
   * })
   * ```
   */
  migration(from: number, to: number, fn: Migration): void;
  /**
   * Whether this world could `load` that snapshot — no side effects, nothing
   * mutated, nothing thrown (R56).
   *
   * Built for deploy-time and CI use: it answers "is any paused world about to
   * become unloadable?" from a build pipeline, rather than from the user who
   * paused it.
   */
  canLoad(snapshot: Snapshot): LoadCheck;
  /**
   * Claims ownership of this world at its current step (R57) — the async step of
   * the resume recipe, called once after `load`:
   *
   * ```ts
   * world.load(snapshot)
   * await world.claim()        // throws FenceError if another worker owns it
   * await world.resume(entity, true)
   * ```
   *
   * **This is what makes side effects exactly-once, and the save-time fence
   * alone does not.** Fencing at save time stops the loser from persisting a
   * divergent timeline, but by then its systems have already run — a duplicate
   * refund has been issued, a record already deleted. Claiming before any step
   * executes is what stops the loser from doing the work at all.
   *
   * Requires a `fence`-capable adapter; throws otherwise, rather than pretending
   * to protect anything.
   */
  claim(): Promise<void>;
  /**
   * The flight recorder's ring buffer of recent `StepTrace`s (R42) — last
   * 1000 steps by default, empty when created with `trace: false`. Render
   * with `formatTrace(steps)`.
   */
  getTrace(): StepTrace[];
  /**
   * Attaches an observer (R45): a passive `onEvent` tap on every run's event
   * stream (plus the observer-only `run:reject`), `onExternalChange` for idle
   * mutations and registration changes (R48), and the `wrapSystemRun`
   * middleware around pair execution (R46). Observer callbacks can never
   * affect engine semantics — `onEvent`/`onExternalChange` exceptions are
   * caught and reported via `console.error`. Returns a detach function
   * (idempotent).
   */
  observe(observer: WorldObserver): () => void;
  /**
   * Lists registered systems with their effective queries (R47): global
   * systems and agent-scoped systems (keyed `<agentName>:<systemName>`, query
   * narrowed by the auto-tag), in registration order.
   */
  systems(): SystemInfo[];
  /** Names of registered resources, sorted (R47). Values are never exposed (R18). */
  resources(): string[];
  /**
   * Forward introspection: which registered systems' queries currently match
   * `entityId` in committed state, in registration order. The complement of
   * `systems()` — answers "what could fire for this entity?" (an empty result
   * for a stalled agent usually means a missing component or a `Not()` term).
   * Returns `[]` for an unknown entity. Idle-only read; matching is a pure check
   * and never considers dirt or `when` guards.
   */
  systemsMatching(entityId: number): SystemInfo[];
  /**
   * Per-system run statistics aggregated from the flight recorder (R42) plus
   * current match counts — for "which systems are hot / never fire?" diagnostics
   * and the devtools Systems view. `matchCount` is live; the run counters cover
   * only the retained trace window (0 when `trace: false`). Read-only.
   */
  queryStats(): QueryStat[];
}

interface RegisteredSystem {
  key: string;
  def: SystemDef<any>;
  query: readonly QueryTerm[];
  positives: Set<string>;
  index: number;
  /** Owning agent for scoped systems (R34) — introspection only (R47). */
  agent?: string;
}

type BufferOp =
  | {
      kind: 'write';
      entity: number;
      component: ComponentType<any>;
      value: unknown;
      op: 'add' | 'set';
    }
  | { kind: 'remove'; entity: number; component: ComponentType<any> }
  | { kind: 'despawn'; entity: number }
  | { kind: 'spawn'; entity: number; items: (ComponentInit<any> | AgentDef)[] }
  | { kind: 'invalidate'; entity: number; system?: string };

interface PairExec {
  sys: RegisteredSystem;
  entity: number;
  ops: BufferOp[];
  ctx: SystemCtx;
  view: EntityView<any>;
  error?: SerializedError;
  ms: number;
  /**
   * Set when the pair's `timeoutMs` expired (R52). The barrier stops waiting
   * for it, and every subsequent buffered op is refused — an abandoned pair that
   * keeps running can never land a write, which is what makes the discarded
   * buffer of R31 hold for timeouts as well as throws.
   */
  abandoned?: boolean;
  /** True when this pair's failure was a timeout rather than a throw (R52). */
  timedOut?: boolean;
  /**
   * True when the pair failed because the world was cancelled (R50). Such a
   * failure is deliberately NOT recorded as `SystemError`: an ErrorRecord would
   * invite a retry system to re-arm work the operator just stopped.
   */
  abortedByCancel?: boolean;
  /** Aborts this pair's `ctx.signal` on timeout, independently of its siblings. */
  timeoutController?: AbortController;
  /** Effective timeout, resolved from the system then the world default (R52). */
  timeoutMs?: number;
  /** This pair's `ctx.signal` — the attribution key for a cancellation-caused failure. */
  signal?: AbortSignal;
  /** True iff this pair's own signal aborted (R51). */
  signalAborted(): boolean;
  /** The value this pair's signal was aborted with, for identity comparison. */
  abortValue(): unknown;
}

interface AttributedChange {
  record: ChangeRecord;
  writer: string;
}

interface BarrierOutcome {
  changes: AttributedChange[];
  spawned: number[];
  spawnedBy: { entity: number; system: string; parent: number }[];
  despawned: number[];
  dropped: DroppedWrite[];
}

const pairId = (systemKey: string, entity: number): string => `${systemKey}::${entity}`;

/**
 * Reads a component's registry name, rejecting anything that is not a
 * `ComponentType`.
 *
 * Guards against the easy slip of passing a `ComponentInit` where a
 * `ComponentType` belongs — `e.set(Topic('hi'))` instead of
 * `e.set(Topic, 'hi')`. That currently type-checks (the zero-arg tag overload
 * absorbs it) and used to store a component literally named `undefined`, which
 * then travelled into every snapshot (R35) and could never be resolved on load
 * (R36). Better to fail at the write with a message that names the mistake.
 */
const componentNameOf = (component: ComponentType<any>): string => {
  const name = (component as { componentName?: unknown } | undefined)?.componentName;
  if (typeof name !== 'string') {
    throw new LangECSError(
      'Expected a component type but got ' +
        `${component === undefined ? 'undefined' : typeof component === 'object' && component !== null && 'component' in component ? 'a ComponentInit — write `set(C, value)`, not `set(C(value))`' : JSON.stringify(component)}. ` +
        'A component with no name cannot be queried, snapshotted, or restored (R7/R35).',
    );
  }
  return name;
};

/**
 * Buffers one op for a pair, unless the pair was abandoned on timeout (R52).
 *
 * The refusal is the load-bearing half of the timeout design. When the barrier
 * stops waiting for a pair, that pair's `run` may still be executing — and it
 * still holds `ctx` and its entity view. Without this guard it could push writes
 * into the buffer after the buffer was discarded, and they would commit at a
 * barrier the system was no longer part of. R31's "discard the buffer entirely"
 * then would not actually hold for timeouts, only for throws.
 */
const pushOp = (exec: PairExec, op: BufferOp): void => {
  if (exec.abandoned === true) return;
  exec.ops.push(op);
};

/** The single snapshot format this build reads and writes (R35/R36). */
const SNAPSHOT_VERSION = 1;

/** A `ResourceRef` is just a typed name (R18 amended): unwrap to the slot key. */
const resourceNameOf = (nameOrRef: string | ResourceRef<unknown>): string =>
  typeof nameOrRef === 'string' ? nameOrRef : nameOrRef.resourceName;

class WorldImpl implements World {
  readonly id: string;
  private readonly persistence: PersistenceAdapter | undefined;
  private readonly recursionLimit: number;
  private readonly traceKeep: number;

  private stepCount = 0;
  private nextEntityId = 1;
  private entities = new Map<number, Map<string, unknown>>();
  private readonly systemList: RegisteredSystem[] = [];
  private readonly systemsByKey = new Map<string, RegisteredSystem>();
  private readonly resourceMap = new Map<string, unknown>();
  /** systemKey -> entityId -> reason. The "pending pairs" of R26/R35. */
  private dirt = new Map<string, Map<number, string>>();
  /** Match set per system as of the last commit point (newly-matched detection). */
  private matched = new Map<string, Set<number>>();
  private runInFlight = false;
  private traceBuf: StepTrace[] = [];
  private runCounter = 0;
  private readonly observers: WorldObserver[] = [];
  private readonly systemTimeoutMs: number | undefined;
  private readonly recipeVersion: number;
  private readonly saveEvery: 'barrier' | 'quiescence' | number;
  private readonly fenced: boolean;
  /** Forward migration chain keyed by `from` version (R54). */
  private readonly migrations = new Map<number, { to: number; fn: Migration }>();
  /**
   * Components a non-strict load could not resolve, kept verbatim so the next
   * `snapshot()` writes them back (R55). entity id -> component name -> raw value.
   */
  private preserved = new Map<number, Record<string, unknown>>();
  /**
   * Bumped on every committed state change. Persistence compares it against
   * `savedRevision` so a boundary is never written twice — see `persist()`.
   */
  private revision = 0;
  private savedRevision = 0;
  /** Step this world currently holds a fence claim for (R57), if any. */
  private ownedStep: number | undefined;
  /** Aborted by `cancel()` during a run; every pair's `ctx.signal` follows it (R50/R51). */
  private runCancel: AbortController | undefined;
  /** Cancellation requested during the current run but not yet stamped (R50). */
  private pendingCancel: CancellationRecord | undefined;
  /** True once `cancel()` was seen by the current run — reported even with no entities to stamp. */
  private cancelSeen = false;
  /** In-flight pairs for `runningPairs()` (R53), keyed by pair id. */
  private readonly inFlight = new Map<
    string,
    {
      system: string;
      entity: number;
      step: number;
      startedAt: number;
      timeoutMs?: number;
      abandoned?: boolean;
    }
  >();

  constructor(opts?: WorldOptions) {
    this.id = opts?.id ?? 'world';
    this.persistence = opts?.persistence;
    this.recursionLimit = opts?.recursionLimit ?? 50;
    this.systemTimeoutMs = opts?.systemTimeoutMs;
    this.recipeVersion = opts?.recipeVersion ?? 0;
    this.saveEvery = opts?.saveEvery ?? 'barrier';
    this.fenced = opts?.fence ?? false;
    const trace = opts?.trace;
    this.traceKeep =
      trace === false ? 0 : trace === true || trace === undefined ? 1000 : (trace.keep ?? 1000);
  }

  get step(): number {
    return this.stepCount;
  }

  get running(): boolean {
    return this.runInFlight;
  }

  // ---------------------------------------------------------------- helpers

  private assertIdle(operation: string): void {
    if (this.runInFlight) throw new WorldRunningError(operation);
  }

  /**
   * Records that committed state changed, so the next `persist()` writes (R58).
   *
   * EVERY path that mutates committed state must call this. Keying the save on a
   * revision rather than the step number is what lets a cancellation boundary be
   * persisted at all (it changes state without advancing the step) — but it also
   * means a path that forgets to bump is silently never saved. Idle external
   * mutations and an idle `cancel()` were exactly that: an idle run wrote nothing
   * at all, and a cancelled world could resume un-cancelled.
   */
  private markChanged(): void {
    this.revision += 1;
  }

  /** Drops an opaque value kept by a non-strict load, once live code owns the name (R55). */
  private forgetPreserved(entity: number, name: string): void {
    const kept = this.preserved.get(entity);
    if (kept === undefined || !(name in kept)) return;
    delete kept[name];
    if (Object.keys(kept).length === 0) this.preserved.delete(entity);
  }

  // ------------------------------------------------------------- observers

  observe(observer: WorldObserver): () => void {
    this.observers.push(observer);
    // Per-registration idempotency (R45): without the flag, double-calling
    // one detach would remove a SECOND registration of the same observer.
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const at = this.observers.indexOf(observer);
      if (at !== -1) this.observers.splice(at, 1);
    };
  }

  /** Observer isolation (R45): callbacks can never affect engine semantics. */
  private notifyEvent(event: ObserverEvent, runId: string): void {
    if (this.observers.length === 0) return;
    const info = { worldId: this.id, runId };
    for (const observer of [...this.observers]) {
      try {
        observer.onEvent?.(event, info);
      } catch (err) {
        report('[langecs] observer onEvent threw (ignored, R45):', err);
      }
    }
  }

  private notifyExternal(change: ExternalChange): void {
    for (const observer of [...this.observers]) {
      try {
        observer.onExternalChange?.(change);
      } catch (err) {
        report('[langecs] observer onExternalChange threw (ignored, R45):', err);
      }
    }
  }

  /**
   * Composes observers' `wrapSystemRun` middlewares around one pair's run
   * (R46): first-registered outermost. The composed wrapper's rejection is
   * treated by the caller exactly like the system throwing (R31).
   */
  private wrapPairRun(info: SystemRunInfo, fn: () => Promise<void>): Promise<void> {
    let next = fn;
    for (let i = this.observers.length - 1; i >= 0; i--) {
      const observer = this.observers[i];
      const wrap = observer?.wrapSystemRun;
      if (!wrap) continue;
      const inner = next;
      next = () => wrap.call(observer, info, inner);
    }
    return next();
  }

  private matchesQuery(query: readonly QueryTerm[], comps: Map<string, unknown>): boolean {
    for (const term of query) {
      if (isComponentType(term)) {
        if (!comps.has(term.componentName)) return false;
      } else if (comps.has(term.not.componentName)) {
        return false;
      }
    }
    return true;
  }

  private sortedEntityIds(): number[] {
    return [...this.entities.keys()].sort((a, b) => a - b);
  }

  private markDirt(systemKey: string, entity: number, reason: string): void {
    let entityMap = this.dirt.get(systemKey);
    if (!entityMap) {
      entityMap = new Map();
      this.dirt.set(systemKey, entityMap);
    }
    if (!entityMap.has(entity)) entityMap.set(entity, reason);
  }

  /**
   * Recomputes match sets and marks dirt per R26: newly-matched pairs, and
   * already-matching pairs whose positive-term components were changed by a
   * foreign writer (anyone but the pair itself; 'engine'/'external' count).
   */
  private refreshDirt(changes: AttributedChange[]): void {
    for (const sys of this.systemList) {
      const prev = this.matched.get(sys.key) ?? new Set<number>();
      const next = new Set<number>();
      for (const [id, comps] of this.entities) {
        if (this.matchesQuery(sys.query, comps)) next.add(id);
      }
      for (const id of next) {
        if (!prev.has(id)) {
          this.markDirt(sys.key, id, 'new-match');
          continue;
        }
        if (changes.length === 0) continue;
        const self = pairId(sys.key, id);
        for (const change of changes) {
          if (
            change.record.entity === id &&
            change.writer !== self &&
            sys.positives.has(change.record.component)
          ) {
            this.markDirt(sys.key, id, `changed:${change.record.component}`);
            break;
          }
        }
      }
      this.matched.set(sys.key, next);
    }
  }

  /** Reducer-aware committed write shared by the barrier and external mutation. */
  private commitWrite(
    entity: number,
    component: ComponentType<any>,
    value: unknown,
    op: 'add' | 'set',
    writer: string,
    changes: AttributedChange[],
  ): void {
    const comps = this.entities.get(entity);
    if (!comps) return;
    const name = componentNameOf(component);
    // Once live code writes this name, the opaque value kept from a non-strict
    // load is stale and must go (R55). Leaving it meant the next `snapshot()`
    // re-emitted the OLD value over the new one, and a deliberate `remove` was
    // silently undone by the other deployment's data.
    this.forgetPreserved(entity, name);
    let kind: 'set' | 'merge' = 'set';
    let next = value;
    if (op === 'add' && component.reducer && comps.has(name)) {
      next = component.reducer(comps.get(name), value);
      kind = 'merge';
    }
    comps.set(name, next);
    changes.push({ record: { entity, component: name, kind, value: next }, writer });
  }

  // ------------------------------------------------------------- registration

  use(def: SystemDef<any> | AgentDef): void {
    this.assertIdle('register systems');
    if (isAgentDef(def)) this.registerAgent(def);
    else this.registerSystemInternal(def.name, def, def.query);
    this.refreshDirt([]);
    this.notifyExternal({ kind: 'systems' });
  }

  register<T>(ref: ResourceRef<T>, value: NoInfer<T>): void;
  register(name: string, resource: unknown): void;
  register(nameOrRef: string | ResourceRef<unknown>, resource: unknown): void {
    const name = resourceNameOf(nameOrRef);
    this.resourceMap.set(name, resource);
    this.notifyExternal({ kind: 'resource', name });
  }

  private registerAgent(agent: AgentDef): void {
    for (const sysDef of agent.systems) {
      this.registerSystemInternal(
        `${agent.name}:${sysDef.name}`,
        sysDef,
        [agent.tag, ...sysDef.query],
        agent.name,
      );
    }
  }

  private registerSystemInternal(
    key: string,
    def: SystemDef<any>,
    query: readonly QueryTerm[],
    agent?: string,
  ): void {
    const existing = this.systemsByKey.get(key);
    if (existing) {
      if (existing.def !== def) throw new DuplicateSystemError(key);
      return;
    }
    const positives = new Set<string>();
    for (const term of query) {
      if (isComponentType(term)) positives.add(term.componentName);
    }
    const reg: RegisteredSystem = { key, def, query, positives, index: this.systemList.length };
    if (agent !== undefined) reg.agent = agent;
    this.systemList.push(reg);
    this.systemsByKey.set(key, reg);
    this.matched.set(key, new Set());
  }

  // ------------------------------------------------------------ introspection

  private systemInfo(sys: RegisteredSystem): SystemInfo {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const term of sys.query) {
      if (isComponentType(term)) include.push(term.componentName);
      else exclude.push(term.not.componentName);
    }
    const info: SystemInfo = {
      key: sys.key,
      name: sys.def.name,
      query: { include, exclude },
      hasGuard: sys.def.when !== undefined,
    };
    if (sys.agent !== undefined) info.agent = sys.agent;
    return info;
  }

  systems(): SystemInfo[] {
    return this.systemList.map((sys) => this.systemInfo(sys));
  }

  systemsMatching(entityId: number): SystemInfo[] {
    const comps = this.entities.get(entityId);
    if (!comps) return [];
    const out: SystemInfo[] = [];
    for (const sys of this.systemList) {
      if (this.matchesQuery(sys.query, comps)) out.push(this.systemInfo(sys));
    }
    return out;
  }

  queryStats(): QueryStat[] {
    // Aggregate run counters from the retained flight recorder.
    const runs = new Map<
      string,
      { runCount: number; errorCount: number; totalMs: number; last: number }
    >();
    for (const step of this.traceBuf) {
      for (const run of step.runs) {
        let agg = runs.get(run.system);
        if (!agg) {
          agg = { runCount: 0, errorCount: 0, totalMs: 0, last: 0 };
          runs.set(run.system, agg);
        }
        agg.runCount += 1;
        if (run.error) agg.errorCount += 1;
        agg.totalMs += run.ms;
        if (step.step > agg.last) agg.last = step.step;
      }
    }
    return this.systemList.map((sys) => {
      const agg = runs.get(sys.key);
      const stat: QueryStat = {
        key: sys.key,
        name: sys.def.name,
        matchCount: this.matched.get(sys.key)?.size ?? 0,
        runCount: agg?.runCount ?? 0,
        errorCount: agg?.errorCount ?? 0,
        totalMs: agg?.totalMs ?? 0,
      };
      if (sys.agent !== undefined) stat.agent = sys.agent;
      if (agg && agg.last > 0) stat.lastStepFired = agg.last;
      return stat;
    });
  }

  resources(): string[] {
    return [...this.resourceMap.keys()].sort();
  }

  // ------------------------------------------------------ external mutations

  spawn(...items: (ComponentInit<any> | AgentDef)[]): EntityHandle {
    this.assertIdle('spawn entities');
    const id = this.nextEntityId++;
    this.entities.set(id, new Map());
    const changes: AttributedChange[] = [];
    this.applySpawnItems(id, items, changes, 'external');
    this.refreshDirt(changes);
    this.markChanged();
    this.notifyExternal({ kind: 'spawn', entity: id });
    return this.externalHandle(id);
  }

  /**
   * External-spawn materialization. AgentDef bundles (and their tags) apply
   * first, then plain ComponentInits — see `flattenSpawnItems` (R34). Values
   * are deep-copied into storage (R34 amended): spawns never alias the
   * AgentDef template, a reused ComponentInit, or each other.
   */
  private applySpawnItems(
    id: number,
    items: readonly (ComponentInit<any> | AgentDef)[],
    changes: AttributedChange[],
    writer: string,
  ): void {
    const comps = this.entities.get(id);
    if (!comps) return;
    const { agents, sets } = flattenSpawnItems(items);
    for (const agent of agents) this.registerAgent(agent);
    for (const { component, value } of sets) {
      const stored = deepClone(value);
      comps.set(component.componentName, stored);
      changes.push({
        record: { entity: id, component: component.componentName, kind: 'set', value: stored },
        writer,
      });
    }
  }

  private externalWrite(
    id: number,
    component: ComponentType<any>,
    value: unknown,
    op: 'add' | 'set',
  ): void {
    this.assertIdle('mutate entities externally');
    if (!this.entities.has(id)) throw new UnknownEntityError(id);
    const changes: AttributedChange[] = [];
    this.commitWrite(id, component, value, op, 'external', changes);
    this.refreshDirt(changes);
    this.markChanged();
    this.notifyExternal({ kind: 'write', entity: id, component: component.componentName });
  }

  private externalRemove(id: number, component: ComponentType<any>): void {
    this.assertIdle('mutate entities externally');
    const comps = this.entities.get(id);
    if (!comps) throw new UnknownEntityError(id);
    const name = component.componentName;
    this.forgetPreserved(id, name);
    if (!comps.has(name)) return;
    comps.delete(name);
    this.refreshDirt([
      { record: { entity: id, component: name, kind: 'remove' }, writer: 'external' },
    ]);
    this.markChanged();
    this.notifyExternal({ kind: 'remove', entity: id, component: name });
  }

  private externalDespawn(id: number): void {
    this.assertIdle('despawn entities externally');
    if (!this.entities.has(id)) throw new UnknownEntityError(id);
    this.entities.delete(id);
    this.preserved.delete(id);
    for (const entityMap of this.dirt.values()) entityMap.delete(id);
    for (const matchSet of this.matched.values()) matchSet.delete(id);
    this.markChanged();
    this.notifyExternal({ kind: 'despawn', entity: id });
  }

  private externalHandle(id: number): EntityHandle {
    return {
      id,
      has: (c) => this.entities.get(id)?.has(c.componentName) ?? false,
      get: (c) => this.entities.get(id)?.get(c.componentName) as never,
      components: () => [...(this.entities.get(id)?.keys() ?? [])],
      add: (c: ComponentType<any>, value?: unknown) =>
        this.externalWrite(id, c, value === undefined ? true : value, 'add'),
      set: (c: ComponentType<any>, value?: unknown) =>
        this.externalWrite(id, c, value === undefined ? true : value, 'set'),
      remove: (c) => this.externalRemove(id, c),
      despawn: () => this.externalDespawn(id),
    };
  }

  private readOnlyView(id: number): EntityReadView<any> {
    return {
      id,
      has: (c) => this.entities.get(id)?.has(c.componentName) ?? false,
      get: (c) => this.entities.get(id)?.get(c.componentName) as never,
      components: () => [...(this.entities.get(id)?.keys() ?? [])],
    };
  }

  // ----------------------------------------------------------------- queries

  query<const Q extends readonly QueryTerm[]>(...terms: Q): EntityHandle<Q>[] {
    const out: EntityHandle<Q>[] = [];
    for (const id of this.sortedEntityIds()) {
      const comps = this.entities.get(id);
      if (comps && this.matchesQuery(terms, comps)) {
        out.push(this.externalHandle(id) as unknown as EntityHandle<Q>);
      }
    }
    return out;
  }

  entity(id: number): EntityHandle | undefined {
    return this.entities.has(id) ? this.externalHandle(id) : undefined;
  }

  pending(): { entity: number; interrupts: InterruptRecord[] }[] {
    const out: { entity: number; interrupts: InterruptRecord[] }[] = [];
    for (const id of this.sortedEntityIds()) {
      const records = this.entities.get(id)?.get(AwaitingHuman.componentName) as
        | InterruptRecord[]
        | undefined;
      // Detached copies (R28 amended): mutating the result never touches
      // committed state.
      if (records && records.length > 0) out.push({ entity: id, interrupts: deepClone(records) });
    }
    return out;
  }

  private collectErrors(): { entity: number; records: ErrorRecord[] }[] {
    const out: { entity: number; records: ErrorRecord[] }[] = [];
    for (const id of this.sortedEntityIds()) {
      const records = this.entities.get(id)?.get(SystemError.componentName) as
        | ErrorRecord[]
        | undefined;
      // Detached copies (R28 amended), like pending().
      if (records && records.length > 0) out.push({ entity: id, records: deepClone(records) });
    }
    return out;
  }

  // ------------------------------------------------------------------- runs

  run(opts?: { limit?: number }): Run {
    if (this.runInFlight) throw new WorldRunningError('start a second run');
    this.runInFlight = true;
    // Fresh per run (R50/R51): every pair's `ctx.signal` derives from this, and
    // a cancellation never leaks into a later run — removing `Cancelled` from
    // the entities is all it takes to un-cancel the world.
    this.runCancel = new AbortController();
    this.pendingCancel = undefined;
    this.cancelSeen = false;
    const runId = `${this.id}:run-${++this.runCounter}`;
    const stream = new RunStream();
    // Every stream emission also reaches observers (R45) — a passive tap,
    // independent of whether anyone iterates the Run.
    const emit = (event: RunEvent): void => {
      stream.emit(event);
      this.notifyEvent(event, runId);
    };
    emit({ type: 'run:start', runId });
    this.driveLoop(emit, opts?.limit ?? this.recursionLimit, runId).then(
      (result) => {
        this.runInFlight = false;
        this.forgetSettledPairs();
        emit({ type: 'run:end', status: result.status, steps: result.steps });
        stream.resolve(result);
      },
      (err) => {
        this.runInFlight = false;
        this.forgetSettledPairs();
        // A rejected run emits no run:end (R40); observers get the
        // observer-only run:reject instead (R45) so they can close out.
        this.notifyEvent({ type: 'run:reject', error: serializeError(err) }, runId);
        stream.reject(err);
      },
    );
    return stream;
  }

  send(target: EntityTarget, ...inits: ComponentInit<any>[]): Run {
    const id = resolveTarget(target);
    for (const init of inits) this.externalWrite(id, init.component, init.value, 'add');
    return this.run();
  }

  resume(target: EntityTarget, value: unknown): Run {
    const id = resolveTarget(target);
    this.externalRemove(id, AwaitingHuman);
    this.externalWrite(id, HumanResponse, { value }, 'set');
    return this.run();
  }

  // ------------------------------------------------------------ cancellation

  cancel(reason?: string): void {
    const record: CancellationRecord = { step: this.stepCount };
    if (reason !== undefined) record.reason = reason;

    if (!this.runInFlight) {
      // Idle: an ordinary external write, immediate like every other one (R16).
      this.stampCancelled(record, 'external');
      return;
    }
    // Mid-run: abort every pair's signal now, and let the run loop stamp the
    // component at the next step boundary (R50). Stamping from here would mutate
    // committed state from outside a barrier, which is exactly what R16 exists to
    // prevent — a snapshot taken mid-step would no longer be boundary-consistent.
    this.cancelSeen = true;
    this.pendingCancel = record;
    this.runCancel?.abort(new CancelledError(reason));
  }

  /** Whether any entity currently carries `Cancelled` — cancellation is state (R50). */
  private hasCancelled(): boolean {
    for (const comps of this.entities.values()) {
      if (comps.has(Cancelled.componentName)) return true;
    }
    return false;
  }

  /**
   * Writes `Cancelled` to every entity and refreshes dirt (R50). Returns the
   * changes so the caller can trace and emit them; the idle path notifies
   * observers per write instead, like any external mutation (R48).
   */
  private stampCancelled(record: CancellationRecord, writer: string): AttributedChange[] {
    const changes: AttributedChange[] = [];
    for (const id of this.sortedEntityIds()) {
      this.commitWrite(id, Cancelled, deepClone(record), 'set', writer, changes);
    }
    this.refreshDirt(changes);
    // Both branches, idle and mid-run: an unpersisted cancellation means the world
    // resumes un-cancelled and continues the work that was stopped.
    if (changes.length > 0) this.markChanged();
    if (writer === 'external') {
      for (const change of changes) {
        this.notifyExternal({
          kind: 'write',
          entity: change.record.entity,
          component: Cancelled.componentName,
        });
      }
    }
    return changes;
  }

  /**
   * Drops in-flight bookkeeping at run end, except for pairs the barrier
   * abandoned (R52) — those are genuinely still executing, and hiding them
   * defeats the one diagnostic `runningPairs()` exists for. Their own settlement
   * removes them.
   */
  private forgetSettledPairs(): void {
    for (const [key, info] of [...this.inFlight]) {
      if (info.abandoned !== true) this.inFlight.delete(key);
    }
  }

  runningPairs(): RunningPair[] {
    const at = now();
    return [...this.inFlight.values()].map((info) => {
      const pair: RunningPair = {
        system: info.system,
        entity: info.entity,
        step: info.step,
        elapsedMs: at - info.startedAt,
      };
      if (info.timeoutMs !== undefined) pair.timeoutMs = info.timeoutMs;
      if (info.abandoned === true) pair.abandoned = true;
      return pair;
    });
  }

  private async driveLoop(
    emit: (event: RunEvent) => void,
    limit: number,
    runId: string,
  ): Promise<RunResult> {
    let steps = 0;
    let limitHit = false;

    while (true) {
      const stepNo = this.stepCount + 1;

      // 0. Cancellation requested mid-step (R50). Stamped here, at a step
      // boundary, rather than inside `cancel()` — mutating committed state from
      // outside a barrier is exactly what R16 forbids, and a snapshot taken
      // mid-step would no longer be boundary-consistent. The step counter does
      // NOT advance: like a fully-vetoed iteration, this is a boundary event, so
      // it is recorded in the trace with no runs and the run ends.
      const cancellation = this.pendingCancel;
      if (cancellation !== undefined) {
        this.pendingCancel = undefined;
        // The step the stamp actually lands at, not the one `cancel()` was called
        // during — those differ whenever a step was in flight, and the record
        // documents itself as the boundary it landed at.
        cancellation.step = stepNo;
        const changes = this.stampCancelled(cancellation, 'engine');
        const applied = changes.map((c) => c.record);
        this.pushTrace({
          step: stepNo,
          scheduled: [],
          vetoed: [],
          runs: [],
          applied,
          spawned: [],
          despawned: [],
          durationMs: 0,
        });
        emit({ type: 'step:applied', step: stepNo, changes: applied, spawned: [], despawned: [] });
        // This boundary commits state, so it advances the step like any other
        // commit. Leaving the counter alone (the original choice, by analogy with
        // a fully-vetoed iteration) was wrong three ways: adapters key snapshots
        // by step, so the boundary OVERWROTE the pre-cancel step-N snapshot and
        // made the uncancelled world unrecoverable by time travel; `step:applied`
        // advertised a step that never existed, which R45 calls the truthful
        // label; and it left the save keyed on a revision while the fence was
        // keyed on the step, so a fenced world refused its own boundary. A veto
        // commits nothing, which is why that precedent does not apply here.
        this.stepCount += 1;
        this.markChanged();
        break;
      }

      // 1. Candidates: matched ∩ dirty, in (system registration index, entity id) order.
      const candidates: { sys: RegisteredSystem; entity: number }[] = [];
      for (const sys of this.systemList) {
        const dirtMap = this.dirt.get(sys.key);
        if (!dirtMap || dirtMap.size === 0) continue;
        const matchSet = this.matched.get(sys.key);
        for (const entity of [...dirtMap.keys()].sort((a, b) => a - b)) {
          if (matchSet?.has(entity)) candidates.push({ sys, entity });
        }
      }

      // 2. Quiescent? (No matched+dirty pair at all.)
      if (candidates.length === 0) break;

      // 3. Limit — checked before guard evaluation (R25 amended): at a limit
      // break no guard code runs and no dirt is consumed, so a later run
      // resumes (and replays) every pending pair, including guard vetoes and
      // guard throws.
      if (steps >= limit) {
        limitHit = true;
        break;
      }

      // 1c. `when` guards over a restricted GuardCtx (R21 amended) — guards
      // never see the mutator ctx. A veto consumes dirt at the barrier commit
      // (R26 amended); a throwing guard is treated as a throwing run (R31).
      const scheduledRefs: PairRef[] = candidates.map((c) => ({
        system: c.sys.key,
        entity: c.entity,
      }));
      const vetoed: PairRef[] = [];
      const execs: PairExec[] = [];
      const guardCtx = this.makeGuardCtx(stepNo);
      for (const c of candidates) {
        const when = c.sys.def.when;
        if (when) {
          try {
            if (when(this.readOnlyView(c.entity), guardCtx) === false) {
              vetoed.push({ system: c.sys.key, entity: c.entity });
              continue;
            }
          } catch (err) {
            const exec = this.makeExec(c.sys, c.entity, stepNo, emit);
            exec.error = serializeError(err);
            execs.push(exec);
            continue;
          }
        }
        execs.push(this.makeExec(c.sys, c.entity, stepNo, emit));
      }

      // Quiescent-by-veto: every candidate vetoed. No barrier runs; the veto
      // dirt is consumed here, at this run's final boundary (R26).
      if (execs.length === 0) {
        for (const veto of vetoed) this.dirt.get(veto.system)?.delete(veto.entity);
        // Consuming veto dirt changes `pendingPairs`, which is snapshot state
        // (R35) — without this the store keeps dirt the world already discarded.
        if (vetoed.length > 0) this.markChanged();
        this.pushTrace({
          step: stepNo,
          scheduled: scheduledRefs,
          vetoed,
          runs: [],
          applied: [],
          spawned: [],
          despawned: [],
          durationMs: 0,
        });
        break;
      }

      // 4. Execute all eligible pairs concurrently. (Dirt for executed and
      // vetoed pairs is consumed only when the barrier commits, R26 amended.)
      steps += 1;
      emit({
        type: 'step:start',
        step: stepNo,
        scheduled: execs.map((x) => ({ system: x.sys.key, entity: x.entity })),
      });
      const stepStart = now();
      await Promise.all(execs.map((exec) => this.executePair(exec, stepNo, runId, emit)));

      // 5. Barrier — two-phase (R25 amended). Staging may throw
      // (WriteConflictError, unknown invalidate system, a throwing reducer, a
      // duplicate agent-system key): the run rejects with component state,
      // dirt, step counter, and trace ALL at the step-start boundary. Once
      // staging passes, the commit is unconditional.
      const outcome = this.applyBarrier(execs, vetoed, stepNo);
      const durationMs = now() - stepStart;
      const changeRecords = outcome.changes.map((c) => c.record);

      const trace: StepTrace = {
        step: stepNo,
        scheduled: scheduledRefs,
        vetoed,
        runs: execs.map((x): TraceRun => {
          const run: TraceRun = {
            system: x.sys.key,
            entity: x.entity,
            ms: x.ms,
            writes: traceWrites(x),
          };
          if (x.error) run.error = x.error;
          return run;
        }),
        applied: changeRecords,
        spawned: outcome.spawned,
        despawned: outcome.despawned,
        durationMs,
      };
      if (outcome.spawnedBy.length > 0) trace.spawnedBy = outcome.spawnedBy;
      if (outcome.dropped.length > 0) trace.droppedWrites = outcome.dropped;
      this.pushTrace(trace);

      emit({
        type: 'step:applied',
        step: stepNo,
        changes: changeRecords,
        spawned: outcome.spawned,
        despawned: outcome.despawned,
      });

      this.stepCount += 1;
      this.markChanged();
      // Cadence (R58): 'barrier' persists every step, a number every N steps,
      // 'quiescence' not at all here — the run-end save below covers it.
      if (this.shouldSaveAtStep(this.stepCount)) await this.persist();
    }

    // Status precedence (R28 amended). `'cancelled'` outranks everything: it is
    // read from state (any entity carrying `Cancelled`) exactly the way
    // `'error'` and `'pending'` are, plus a flag so a cancel still reports even
    // when there were no entities to stamp. It has to come first — otherwise a
    // cancelled run whose aborted calls also left errors behind would report
    // `'error'`, and the caller could not tell "I stopped this" from "it broke".
    // A cancel landing during the run-end save must not vanish. `world.running`
    // is still true there, so `cancel()` takes the mid-run branch and sets
    // `pendingCancel` — which nothing read, because status was computed first and
    // the next run resets it. It returned void and left no trace, so a UI gating
    // its Cancel button on `world.running` showed a live control that did nothing.
    //
    // Run end always persists whatever changed since the last save (R58).
    await this.persist();
    if (this.pendingCancel !== undefined) {
      const late = this.pendingCancel;
      this.pendingCancel = undefined;
      late.step = this.stepCount + 1;
      const changes = this.stampCancelled(late, 'engine');
      const applied = changes.map((c) => c.record);
      this.pushTrace({
        step: this.stepCount + 1,
        scheduled: [],
        vetoed: [],
        runs: [],
        applied,
        spawned: [],
        despawned: [],
        durationMs: 0,
      });
      emit({
        type: 'step:applied',
        step: this.stepCount + 1,
        changes: applied,
        spawned: [],
        despawned: [],
      });
      this.stepCount += 1;
      this.markChanged();
      await this.persist();
    }

    // Status precedence (R28 amended). `'cancelled'` is scoped to THIS run, plus
    // the zero-step case so a world reloaded already-cancelled still reports it.
    //
    // It used to be `cancelSeen || hasCancelled()`, and that made the status
    // sticky world-wide and permanent: unlike `SystemError` (auto-cleared by R32)
    // and `AwaitingHuman` (removed by `resume`), `Cancelled` has no engine
    // clearing path, so ONE stale carrier on an unrelated entity masked
    // `'error'`, `'pending'` and `'limit'` forever. It also made a multi-agent
    // world un-resumable one agent at a time: un-cancelling one entity left the
    // run reporting `'cancelled'` while that agent answered perfectly, and
    // stdlib's `ask()` then threw "no answer is coming" about a reply already in
    // `Messages`. Requiring zero steps keeps the durability property without
    // hiding work that actually happened.
    const status: RunStatus = this.cancelSeen
      ? 'cancelled'
      : limitHit
        ? 'limit'
        : steps === 0
          ? this.hasCancelled()
            ? 'cancelled'
            : 'idle'
          : this.collectErrors().length > 0
            ? 'error'
            : this.pending().length > 0
              ? 'pending'
              : 'done';
    return { status, steps, pending: this.pending(), errors: this.collectErrors() };
  }

  // ------------------------------------------------------------ persistence

  async claim(): Promise<void> {
    const adapter = this.persistence;
    if (adapter?.fence === undefined) {
      throw new LangECSError(
        'world.claim() needs a persistence adapter implementing fence() (R57). ' +
          'Without one there is nothing to arbitrate between two workers, and claiming would ' +
          'give a false sense of exclusivity.',
      );
    }
    // Staleness is checked BEFORE the fence, because the fence alone cannot catch
    // it. A monotonic fence refuses a step at or below one already claimed — but a
    // worker resuming an OLDER snapshot claims a LOWER step, and if it gets there
    // first nothing has been claimed yet, so it is granted. It would then only be
    // refused at its first save, by which time its side effects have run: exactly
    // the failure `claim()` exists to prevent, one boundary further out.
    //
    // The adapter already knows the answer, and this costs one read per resume.
    const latest = await adapter.load(this.id);
    if (latest !== null && latest.step > this.stepCount) {
      throw new StaleSnapshotError(this.stepCount, latest.step);
    }
    const granted = await adapter.fence(this.id, this.stepCount);
    if (!granted) throw new FenceError(this.id, this.stepCount);
    this.ownedStep = this.stepCount;
  }

  /** Whether the configured cadence persists at this committed step (R58). */
  private shouldSaveAtStep(step: number): boolean {
    if (this.persistence === undefined) return false;
    if (this.saveEvery === 'quiescence') return false;
    if (this.saveEvery === 'barrier') return true;
    // A non-positive interval would divide by zero / save never; treat it as
    // every step rather than silently disabling persistence.
    const every = Math.max(1, Math.floor(this.saveEvery));
    return step % every === 0;
  }

  /**
   * Persists the current boundary, honouring the fence when enabled (R57).
   *
   * The fence is checked immediately before the write, not at load: that is the
   * point where divergence would actually become durable, and it is already an
   * async boundary the engine awaits. Losing the fence rejects the run — the
   * world stops rather than keep writing history nobody will read.
   *
   * Skips entirely when nothing has been committed since the last save. That
   * also removes a redundant write the engine always used to make (the final
   * step was persisted at its barrier and again at run end); harmless against an
   * idempotent adapter, but a monotonic fence would refuse the world's own second
   * claim on the same step. Tracked by revision rather than step number, because
   * a cancellation boundary (R50) changes state *without* advancing the step.
   */
  private async persist(): Promise<void> {
    const adapter = this.persistence;
    if (adapter === undefined) return;
    if (this.revision === this.savedRevision) return;
    const snapshot = this.snapshot();
    // Re-claiming a step this world already holds is skipped, not re-fenced.
    // The fence is keyed on the STEP while the save is keyed on the REVISION, and
    // those clocks disagree at any boundary that changes state without advancing
    // the step — a cancellation, most obviously. Without this, cancelling a fenced
    // world made it fence ITSELF out of its own step: the run rejected with
    // `FenceError` naming a nonexistent rival, and the cancellation was never
    // persisted, so the advice to "discard it and reload" resumed a live world.
    if (this.fenced && adapter.fence !== undefined && snapshot.step !== this.ownedStep) {
      const granted = await adapter.fence(this.id, snapshot.step);
      if (!granted) throw new FenceError(this.id, snapshot.step);
      this.ownedStep = snapshot.step;
    }
    await adapter.save(snapshot);
    this.savedRevision = this.revision;
  }

  // -------------------------------------------------------- pair execution

  /**
   * Runs one pair, bounded by its timeout (R52).
   *
   * The timeout races the pair's execution rather than wrapping it, because the
   * point is to stop *waiting*: when the deadline wins, this resolves and the
   * barrier proceeds without the abandoned pair, which is the escape from R25
   * step 5's `Promise.all` hanging forever on one system that never settles.
   * The abandoned promise keeps running — cancellation is cooperative (R49) —
   * but it can no longer affect anything: its buffer is discarded, further ops
   * are refused (`pushOp`), and its `ctx.signal` is aborted so a well-behaved
   * call unwinds on its own.
   */
  private async executePair(
    exec: PairExec,
    stepNo: number,
    runId: string,
    emit: (event: RunEvent) => void,
  ): Promise<void> {
    const info = { step: stepNo, system: exec.sys.key, entity: exec.entity } as const;
    if (exec.error) {
      // `when` already threw; report it like a failed run — with the
      // system:start/system:error pairing intact (R41 amended).
      emit({ type: 'system:start', ...info });
      emit({ type: 'system:error', ...info, error: exec.error });
      return;
    }
    emit({ type: 'system:start', ...info });

    const key = pairId(exec.sys.key, exec.entity);
    const start = now();
    const tracked: {
      system: string;
      entity: number;
      step: number;
      startedAt: number;
      timeoutMs?: number;
    } = { system: exec.sys.key, entity: exec.entity, step: stepNo, startedAt: start };
    if (exec.timeoutMs !== undefined) tracked.timeoutMs = exec.timeoutMs;
    this.inFlight.set(key, tracked);

    // Whichever of body/deadline lands first wins outright; the loser is inert.
    let settled = false;
    let timer: unknown;

    const body = (async () => {
      // The system's own failure is tracked out-of-band so a misbehaving
      // wrapper that SWALLOWS fn's rejection (violating R46) can never
      // turn a throwing system into a success — which would commit a
      // partial buffer (R31) and bogusly auto-clear SystemError (R32).
      let ownFailure = false;
      let ownError: unknown;
      try {
        // Observer middleware around the pair's run (R46); an async-only
        // thunk so a synchronously-throwing system still surfaces as a
        // rejection to wrappers. A wrapper rejection lands here like a
        // system throw (R31).
        await this.wrapPairRun(
          { worldId: this.id, runId, step: stepNo, system: exec.sys.key, entity: exec.entity },
          async () => {
            try {
              await exec.sys.def.run(exec.view, exec.ctx);
            } catch (err) {
              ownFailure = true;
              ownError = err;
              throw err;
            }
          },
        );
        if (ownFailure) throw ownError;
        if (settled) return; // abandoned on timeout: a late success changes nothing
        settled = true;
        exec.ms = now() - start;
        emit({ type: 'system:end', ...info, ms: exec.ms });
      } catch (err) {
        if (settled) return; // ditto for a late failure
        settled = true;
        exec.ms = now() - start;
        exec.error = serializeError(err);
        exec.ops = []; // discard the buffer entirely (R31)
        // A failure caused by cancellation is NOT recorded as SystemError
        // (R50): the run is being abandoned deliberately, and an ErrorRecord
        // would invite the stdlib `retry` system to re-arm the very work that
        // was just cancelled.
        //
        // Attributed to THIS pair by error identity, not to the run. A run-wide
        // `runCancel.aborted` test swallowed any failure that happened to land
        // after the cancel — a sibling's genuine TypeError became invisible with
        // no record anywhere durable, and the canonical
        // `const run = world.run(); world.cancel()` shape hit it every time.
        if (exec.timedOut !== true && exec.signalAborted() && err === exec.abortValue()) {
          exec.abortedByCancel = true;
        }
        emit({ type: 'system:error', ...info, error: exec.error });
      }
    })();

    const timeoutMs = exec.timeoutMs;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            timer = timers.setTimeout(() => {
              if (settled) return;
              settled = true;
              exec.abandoned = true;
              exec.timedOut = true;
              exec.ops = []; // R31's discarded buffer, for a hang instead of a throw
              const err = new SystemTimeoutError(exec.sys.key, exec.entity, timeoutMs);
              exec.error = serializeError(err);
              exec.ms = now() - start;
              // Aborts only THIS pair's signal — a sibling's slowness must never
              // cancel a healthy pair (R51).
              exec.timeoutController?.abort(err);
              emit({ type: 'system:error', ...info, error: exec.error });
              resolve();
            }, timeoutMs);
          });

    // `body` never rejects (it catches everything), but guard anyway: an
    // unhandled rejection from an abandoned pair would crash the host process.
    // Cleared when the BODY settles, not when the race does: the one case an
    // operator reaches for `runningPairs()` is a system hung badly enough to be
    // abandoned, and deleting on the race made exactly that case invisible (R53).
    body.catch(() => {}).then(() => this.inFlight.delete(key));
    await (deadline === undefined ? body : Promise.race([body, deadline]));
    if (timer !== undefined) timers.clearTimeout(timer);
    if (exec.abandoned === true) {
      const tracked2 = this.inFlight.get(key);
      if (tracked2 !== undefined) tracked2.abandoned = true;
    } else {
      this.inFlight.delete(key);
    }
  }

  // ------------------------------------------------------------ pair context

  private worldReadView(): WorldReadView {
    return {
      query: (...terms) => {
        const out: EntityReadView<any>[] = [];
        for (const id of this.sortedEntityIds()) {
          const comps = this.entities.get(id);
          if (comps && this.matchesQuery(terms, comps)) out.push(this.readOnlyView(id));
        }
        return out as never;
      },
      entity: (id) => (this.entities.has(id) ? this.readOnlyView(id) : undefined),
    };
  }

  /** Refs and plain names address the same slot (R18 amended). */
  private lookupResource<T>(nameOrRef: string | ResourceRef<T>): T {
    const name = resourceNameOf(nameOrRef);
    if (!this.resourceMap.has(name)) throw new MissingResourceError(name);
    return this.resourceMap.get(name) as T;
  }

  /** Restricted, mutator-free context handed to `when` guards (R21 amended). */
  private makeGuardCtx(stepNo: number): GuardCtx {
    return {
      step: stepNo,
      world: this.worldReadView(),
      resource: <T>(nameOrRef: string | ResourceRef<T>): T => this.lookupResource(nameOrRef),
    };
  }

  private makeExec(
    sys: RegisteredSystem,
    entity: number,
    stepNo: number,
    emit: (event: RunEvent) => void,
  ): PairExec {
    const ops: BufferOp[] = [];
    const exec = { sys, entity, ops, ms: 0 } as PairExec;
    const timeoutMs = sys.def.timeoutMs ?? this.systemTimeoutMs;
    if (timeoutMs !== undefined) {
      exec.timeoutMs = timeoutMs;
      exec.timeoutController = new AbortController();
    }
    // Per (pair, step) signal (R51): follows the run-wide cancellation signal
    // and this pair's own deadline — never a sibling's.
    const signal =
      anySignal([this.runCancel?.signal, exec.timeoutController?.signal]) ??
      new AbortController().signal;
    exec.signal = signal;
    exec.signalAborted = () => signal.aborted;
    exec.abortValue = () => abortReason(signal);
    const ctx: SystemCtx = {
      step: stepNo,
      world: this.worldReadView(),
      signal,
      spawn: (...items) => {
        // An abandoned pair gets a dead handle BEFORE the counter moves (R52).
        // `nextEntityId` is committed world state that lands in every snapshot,
        // so letting a zombie increment it advanced the counter after the run had
        // ended — a loop in an abandoned system would grow it without bound, and
        // ids from a later run interleaved with the zombie's.
        if (exec.abandoned === true) return this.bufferedView(0, exec);
        // Id allocated eagerly (R29); components materialize at the barrier.
        const id = this.nextEntityId++;
        pushOp(exec, { kind: 'spawn', entity: id, items });
        return this.bufferedView(id, exec);
      },
      despawn: (target) => {
        pushOp(exec, { kind: 'despawn', entity: resolveTarget(target) });
      },
      write: (target, component, value, op = 'add') => {
        pushOp(exec, { kind: 'write', entity: resolveTarget(target), component, value, op });
      },
      remove: (target, component) => {
        pushOp(exec, { kind: 'remove', entity: resolveTarget(target), component });
      },
      emit: (data) => {
        // An abandoned pair is silent (R52): its effects were discarded, so
        // letting late events through would narrate work that never happened.
        if (exec.abandoned === true) return;
        emit({ type: 'custom', step: stepNo, system: sys.key, entity, data });
      },
      resource: <T>(nameOrRef: string | ResourceRef<T>): T => this.lookupResource(nameOrRef),
      invalidate: (target, system) => {
        const op: BufferOp = { kind: 'invalidate', entity: resolveTarget(target) };
        if (system !== undefined) op.system = system;
        pushOp(exec, op);
      },
    };
    exec.ctx = ctx;
    exec.view = this.bufferedView(entity, exec);
    return exec;
  }

  /** Reads see step-start committed state; mutations buffer into the pair (R17). */
  private bufferedView(id: number, exec: PairExec): EntityView<any> {
    return {
      id,
      has: (c) => this.entities.get(id)?.has(c.componentName) ?? false,
      get: (c) => this.entities.get(id)?.get(c.componentName) as never,
      components: () => [...(this.entities.get(id)?.keys() ?? [])],
      add: (c: ComponentType<any>, value?: unknown) =>
        pushOp(exec, {
          kind: 'write',
          entity: id,
          component: c,
          value: value === undefined ? true : value,
          op: 'add',
        }),
      set: (c: ComponentType<any>, value?: unknown) =>
        pushOp(exec, {
          kind: 'write',
          entity: id,
          component: c,
          value: value === undefined ? true : value,
          op: 'set',
        }),
      remove: (c) => pushOp(exec, { kind: 'remove', entity: id, component: c }),
      despawn: () => pushOp(exec, { kind: 'despawn', entity: id }),
    };
  }

  // ---------------------------------------------------------------- barrier

  /**
   * Two-phase barrier (R25 amended).
   *
   * STAGE evaluates everything that can throw — the R30 conflict prescan, the
   * R24 invalidate prescan, every user reducer, and spawn-time agent-system
   * registration keys — against a staging overlay, without touching committed
   * state. Any throw rejects the run with component state, dirt, the step
   * counter, and the trace all at the step-start boundary.
   *
   * COMMIT runs no user code and cannot throw: it consumes dirt for executed
   * and vetoed pairs (R26 amended), applies the staged values in deterministic
   * order, registers staged agents, despawns, refreshes dirt, and applies
   * invalidations.
   */
  private applyBarrier(execs: PairExec[], vetoed: PairRef[], stepNo: number): BarrierOutcome {
    const ordered = [...execs].sort((a, b) => a.sys.index - b.sys.index || a.entity - b.entity);
    const okExecs = ordered.filter((x) => !x.error);

    // ------------------------------------------------------------------ stage

    // Despawns apply after all writes; collect targets up front so writes to
    // despawned entities can be dropped (and traced) during replay.
    const despawnSet = new Set<number>();
    for (const exec of okExecs) {
      for (const op of exec.ops) {
        if (op.kind === 'despawn') despawnSet.add(op.entity);
      }
    }

    // Conflict prescan (R30): throw before committing anything.
    const writers = new Map<
      string,
      { component: string; entity: number; pairs: Map<string, { system: string; entity: number }> }
    >();
    for (const exec of okExecs) {
      const pair = pairId(exec.sys.key, exec.entity);
      for (const op of exec.ops) {
        if (op.kind !== 'write' || op.component.reducer || despawnSet.has(op.entity)) continue;
        const key = `${op.entity}|${op.component.componentName}`;
        let entry = writers.get(key);
        if (!entry) {
          entry = { component: op.component.componentName, entity: op.entity, pairs: new Map() };
          writers.set(key, entry);
        }
        entry.pairs.set(pair, { system: exec.sys.key, entity: exec.entity });
      }
    }
    for (const entry of writers.values()) {
      if (entry.pairs.size > 1) {
        throw new WriteConflictError(entry.component, entry.entity, stepNo, [
          ...entry.pairs.values(),
        ]);
      }
    }

    // Invalidate prescan (R24): an unresolvable system name must reject the run
    // before anything commits (same invariant as WriteConflictError above), not
    // mid-barrier after writes have landed. Names resolve against systems that
    // will be registered once this barrier's AgentDef spawns apply, too.
    this.prescanInvalidates(okExecs, despawnSet);

    // Staging overlay over committed storage: entity -> name -> staged entry.
    const overlay = new Map<number, Map<string, { present: boolean; value?: unknown }>>();
    const shells = new Set<number>();
    const exists = (id: number): boolean => shells.has(id) || this.entities.has(id);
    const stagedLookup = (id: number, name: string): { present: boolean; value?: unknown } => {
      const entry = overlay.get(id)?.get(name);
      if (entry) return entry;
      const comps = this.entities.get(id);
      if (comps?.has(name)) return { present: true, value: comps.get(name) };
      return { present: false };
    };
    // Staged commit instructions, in deterministic replay order. ChangeRecord
    // values are detached copies — events/trace never alias storage (R41/R42
    // amended).
    const staged: {
      entity: number;
      name: string;
      op: 'set' | 'delete';
      value?: unknown;
      change: AttributedChange;
    }[] = [];
    const stage = (id: number, name: string, entry: { present: boolean; value?: unknown }) => {
      let names = overlay.get(id);
      if (!names) {
        names = new Map();
        overlay.set(id, names);
      }
      names.set(name, entry);
    };
    const stageSet = (
      entity: number,
      name: string,
      value: unknown,
      kind: 'set' | 'merge',
      writer: string,
    ): void => {
      stage(entity, name, { present: true, value });
      staged.push({
        entity,
        name,
        op: 'set',
        value,
        change: { record: { entity, component: name, kind, value: deepClone(value) }, writer },
      });
    };
    const stageDelete = (entity: number, name: string, writer: string): void => {
      stage(entity, name, { present: false });
      staged.push({
        entity,
        name,
        op: 'delete',
        change: { record: { entity, component: name, kind: 'remove' }, writer },
      });
    };

    // Spawn shells: collected first so writes from ANY pair can target eager ids.
    const spawned: number[] = [];
    const spawnedBy: { entity: number; system: string; parent: number }[] = [];
    for (const exec of okExecs) {
      for (const op of exec.ops) {
        if (op.kind !== 'spawn') continue;
        shells.add(op.entity);
        spawned.push(op.entity);
        spawnedBy.push({ entity: op.entity, system: exec.sys.key, parent: exec.entity });
      }
    }

    // Validate spawn-time agent registrations (DuplicateSystemError must reject
    // during staging, not mid-commit). Tracks intra-barrier keys too.
    const agentRegs: AgentDef[] = [];
    const stagedSystemKeys = new Map<string, SystemDef<any>>();
    const validateAgent = (agent: AgentDef): void => {
      for (const sysDef of agent.systems) {
        const key = `${agent.name}:${sysDef.name}`;
        const existing = this.systemsByKey.get(key)?.def ?? stagedSystemKeys.get(key);
        if (existing && existing !== sysDef) throw new DuplicateSystemError(key);
        stagedSystemKeys.set(key, sysDef);
      }
    };

    // Stage-replay ops in deterministic order: (system index, entity id), call
    // order within. Reducers (user code) run HERE, against the overlay.
    const dropped: DroppedWrite[] = [];
    const invalidations: { entity: number; system?: string }[] = [];
    for (const exec of okExecs) {
      const pair = pairId(exec.sys.key, exec.entity);
      for (const op of exec.ops) {
        switch (op.kind) {
          case 'write': {
            if (despawnSet.has(op.entity) || !exists(op.entity)) {
              dropped.push({
                system: exec.sys.key,
                entity: op.entity,
                component: op.component.componentName,
                kind: 'write',
              });
              break;
            }
            const name = componentNameOf(op.component);
            const current = stagedLookup(op.entity, name);
            let kind: 'set' | 'merge' = 'set';
            let next = op.value;
            if (op.op === 'add' && op.component.reducer && current.present) {
              next = op.component.reducer(current.value, op.value);
              kind = 'merge';
            }
            stageSet(op.entity, name, next, kind, pair);
            break;
          }
          case 'remove': {
            if (despawnSet.has(op.entity) || !exists(op.entity)) {
              dropped.push({
                system: exec.sys.key,
                entity: op.entity,
                component: op.component.componentName,
                kind: 'remove',
              });
              break;
            }
            const name = componentNameOf(op.component);
            if (stagedLookup(op.entity, name).present) stageDelete(op.entity, name, pair);
            break;
          }
          case 'spawn': {
            if (despawnSet.has(op.entity)) break;
            const { agents, sets } = flattenSpawnItems(op.items);
            for (const agent of agents) {
              validateAgent(agent);
              agentRegs.push(agent);
            }
            for (const item of sets) {
              // Deep-copied into storage (R34 amended): spawns never alias the
              // AgentDef template, a reused ComponentInit, or each other.
              stageSet(op.entity, item.component.componentName, deepClone(item.value), 'set', pair);
            }
            break;
          }
          case 'invalidate': {
            // R24 (amended): an invalidate whose target does not exist at the
            // barrier — never spawned, or despawned this step — is dropped and
            // traced. Dirt for nonexistent entities can never be consumed, so
            // letting it through would leak phantom pendingPairs into every
            // snapshot (R35).
            if (despawnSet.has(op.entity) || !exists(op.entity)) {
              dropped.push({ system: exec.sys.key, entity: op.entity, kind: 'invalidate' });
              break;
            }
            invalidations.push(op);
            break;
          }
          case 'despawn':
            break;
        }
      }
    }

    // Engine writes (foreign for dirt, exempt from R30): SystemError append for
    // failed pairs (R31), then auto-clear for pairs that succeeded (R32). Staged
    // like everything else; entities despawned this step are skipped.
    const seName = SystemError.componentName;
    for (const exec of ordered) {
      if (!exec.error) continue;
      // Cancellation is not failure (R50): a pair whose call was aborted because
      // the operator cancelled the world gets no ErrorRecord, so the run reports
      // 'cancelled' rather than 'error' and no retry system re-arms it. A
      // TIMEOUT is different and does record (R52) — that one is meant to heal.
      if (exec.abortedByCancel === true) continue;
      if (despawnSet.has(exec.entity) || !exists(exec.entity)) continue;
      const record: ErrorRecord = { system: exec.sys.key, step: stepNo, error: exec.error };
      const current = stagedLookup(exec.entity, seName);
      const next = current.present ? [...(current.value as ErrorRecord[]), record] : [record];
      stageSet(exec.entity, seName, next, current.present ? 'merge' : 'set', 'engine');
    }
    for (const exec of ordered) {
      if (exec.error) continue;
      if (despawnSet.has(exec.entity) || !exists(exec.entity)) continue;
      const current = stagedLookup(exec.entity, seName);
      if (!current.present) continue;
      const records = current.value as ErrorRecord[];
      if (!records.some((r) => r.system === exec.sys.key)) continue;
      const next = records.filter((r) => r.system !== exec.sys.key);
      if (next.length > 0) stageSet(exec.entity, seName, next, 'set', 'engine');
      else stageDelete(exec.entity, seName, 'engine');
    }

    // ----------------------------------------------------------------- commit
    // No user code from here on; nothing below can throw.

    // Dirt for executed pairs and when-vetoes is consumed only now (R26
    // amended): a staging throw above leaves it intact, so the work stays
    // re-runnable and any snapshot remains boundary-consistent (R30/R35).
    for (const exec of execs) {
      // A pair aborted BY the cancellation keeps its dirt (R50). Discarding a
      // buffer is only safe because the failure becomes state and that state is
      // itself foreign dirt; suppressing the ErrorRecord removed one leg, and
      // consuming the dirt removed the last one — no writes, no error, nothing
      // scheduled. A guard-less system was left permanently wedged with no
      // diagnostics, and "removing Cancelled un-cancels the world" was false for
      // it, because nothing re-matched to manufacture fresh dirt.
      if (exec.abortedByCancel === true) continue;
      this.dirt.get(exec.sys.key)?.delete(exec.entity);
    }
    for (const veto of vetoed) this.dirt.get(veto.system)?.delete(veto.entity);

    // Scoped systems of spawned AgentDefs register here, deterministically
    // (keys validated during staging; registration is idempotent).
    for (const agent of agentRegs) this.registerAgent(agent);

    // Materialize spawn shells, then apply staged values in replay order.
    for (const id of spawned) this.entities.set(id, new Map());
    const changes: AttributedChange[] = [];
    for (const item of staged) {
      const comps = this.entities.get(item.entity);
      if (!comps) continue; // unreachable: staged targets exist or were shelled
      this.forgetPreserved(item.entity, item.name);
      if (item.op === 'set') comps.set(item.name, item.value);
      else comps.delete(item.name);
      changes.push(item.change);
    }

    // Despawns, after all writes.
    const despawned: number[] = [];
    for (const id of [...despawnSet].sort((a, b) => a - b)) {
      if (!this.entities.has(id)) continue;
      this.entities.delete(id);
      this.preserved.delete(id);
      despawned.push(id);
      for (const entityMap of this.dirt.values()) entityMap.delete(id);
    }

    // 6. Dirty marks for the next step, then explicit invalidations (R26.4;
    // names were prescanned, so applyInvalidate cannot throw here).
    this.refreshDirt(changes);
    for (const inv of invalidations) this.applyInvalidate(inv.entity, inv.system);

    return { changes, spawned, spawnedBy, despawned, dropped };
  }

  /**
   * Throws UnknownSystemError before the barrier commits anything if any
   * buffered `ctx.invalidate` names a system that will not be resolvable by
   * `applyInvalidate` after this barrier — i.e. it matches neither a registered
   * system key, nor a registered definition name, nor a system contributed by
   * an AgentDef spawned (and not same-step despawned) in this barrier.
   */
  private prescanInvalidates(okExecs: PairExec[], despawnSet: Set<number>): void {
    let resolvable: Set<string> | undefined;
    const buildResolvable = (): Set<string> => {
      const names = new Set<string>();
      for (const sys of this.systemList) {
        names.add(sys.key);
        names.add(sys.def.name);
      }
      for (const exec of okExecs) {
        for (const op of exec.ops) {
          if (op.kind !== 'spawn' || despawnSet.has(op.entity)) continue;
          for (const item of op.items) {
            if (!isAgentDef(item)) continue;
            for (const sysDef of item.systems) {
              names.add(`${item.name}:${sysDef.name}`);
              names.add(sysDef.name);
            }
          }
        }
      }
      return names;
    };
    const unknown = new Set<string>();
    for (const exec of okExecs) {
      for (const op of exec.ops) {
        if (op.kind !== 'invalidate' || op.system === undefined) continue;
        resolvable ??= buildResolvable();
        if (!resolvable.has(op.system)) unknown.add(op.system);
      }
    }
    if (unknown.size > 0) throw new UnknownSystemError([...unknown]);
  }

  private applyInvalidate(entity: number, systemName: string | undefined): void {
    if (systemName === undefined) {
      for (const sys of this.systemList) this.markDirt(sys.key, entity, 'invalidate');
      return;
    }
    const exact = this.systemsByKey.get(systemName);
    if (exact) {
      this.markDirt(exact.key, entity, 'invalidate');
      return;
    }
    const byName = this.systemList.filter((s) => s.def.name === systemName);
    if (byName.length === 0) throw new UnknownSystemError([systemName]);
    for (const sys of byName) this.markDirt(sys.key, entity, 'invalidate');
  }

  // ------------------------------------------------------------------ trace

  private pushTrace(trace: StepTrace): void {
    if (this.traceKeep === 0) return;
    this.traceBuf.push(trace);
    if (this.traceBuf.length > this.traceKeep) this.traceBuf.shift();
  }

  getTrace(): StepTrace[] {
    return this.traceBuf.slice();
  }

  // -------------------------------------------------------------- snapshots

  snapshot(): Snapshot {
    const entities = this.sortedEntityIds().map((id) => {
      const comps = this.entities.get(id);
      const record: Record<string, unknown> = {};
      // Unresolved components from a non-strict load are written back first
      // (R55), so a live component of the same name always wins — but nothing
      // another deployment version owns is silently destroyed by a round-trip.
      const kept = this.preserved.get(id);
      if (kept) Object.assign(record, kept);
      if (comps) {
        for (const [name, value] of comps) {
          const def = getComponentByName(name);
          if (def?.transient) continue;
          record[name] = def?.serialize ? def.serialize(value) : value;
        }
      }
      return { id, components: record };
    });
    const pendingPairs: { entity: number; system: string; reason: string }[] = [];
    for (const sys of this.systemList) {
      const entityMap = this.dirt.get(sys.key);
      if (!entityMap) continue;
      for (const [entity, reason] of [...entityMap.entries()].sort((a, b) => a[0] - b[0])) {
        pendingPairs.push({ entity, system: sys.key, reason });
      }
    }
    // JSON round-trip: detaches the snapshot from live state and enforces R3/R35.
    const envelope: Snapshot = {
      version: 1 as const,
      worldId: this.id,
      step: this.stepCount,
      nextEntityId: this.nextEntityId,
      entities,
      pendingPairs,
    };
    // Omitted entirely at version 0 so worlds that never opted in keep writing
    // byte-identical snapshots (R54).
    if (this.recipeVersion !== 0) envelope.recipeVersion = this.recipeVersion;
    return JSON.parse(JSON.stringify(envelope)) as Snapshot;
  }

  migration(from: number, to: number, fn: Migration): void {
    // R54 says the chain is walked ASCENDING; nothing enforced it, so a
    // 1->9 plus 9->3 pair would happily walk a v1 snapshot up past the world's own
    // version and back down, and `canLoad` would call it fine — the very thing R54
    // refuses when it appears on the envelope.
    if (to <= from) {
      throw new LangECSError(
        `Migration ${from} -> ${to} does not move forward. Migrations form a single ascending ` +
          `chain (R54): a downgrade path cannot be replayed onto newer code, and a cycle would ` +
          `never converge.`,
      );
    }
    if (to > this.recipeVersion) {
      throw new LangECSError(
        `Migration ${from} -> ${to} overshoots this world's recipeVersion ${this.recipeVersion} ` +
          `(R54). Raise the world's recipeVersion, or split the step — otherwise the chain ` +
          `migrates past the schema this build understands and then fails on a hop nobody wrote.`,
      );
    }
    const existing = this.migrations.get(from);
    if (existing && existing.to !== to) {
      throw new DuplicateMigrationError(from, existing.to, to);
    }
    this.migrations.set(from, { to, fn });
  }

  /**
   * Walks the forward migration chain (R54). Returns the migrated snapshot and
   * the steps taken; `undefined` chain means no path exists.
   */
  private migrateChain(
    snapshot: Snapshot,
  ): { snapshot: Snapshot; applied: { from: number; to: number }[] } | { gap: number } {
    let current = snapshot.recipeVersion ?? 0;
    if (current === this.recipeVersion) return { snapshot, applied: [] };
    let working = snapshot;
    const applied: { from: number; to: number }[] = [];
    // A bound of one hop per registered migration: a cyclic or self-referential
    // chain can never spin the engine.
    for (let hops = 0; hops <= this.migrations.size; hops++) {
      if (current === this.recipeVersion) return { snapshot: working, applied };
      const step = this.migrations.get(current);
      if (!step) return { gap: current };
      // Migrations receive a detached copy, so mutate-and-return is safe (R54).
      working = step.fn(JSON.parse(JSON.stringify(working)) as Snapshot);
      applied.push({ from: current, to: step.to });
      current = step.to;
    }
    return { gap: current };
  }

  canLoad(snapshot: Snapshot): LoadCheck {
    if (snapshot.version !== SNAPSHOT_VERSION) {
      return {
        ok: false,
        formatVersion: { found: snapshot.version, supported: SNAPSHOT_VERSION },
        components: [],
        systems: [],
      };
    }
    const found = snapshot.recipeVersion ?? 0;
    if (found > this.recipeVersion) {
      return {
        ok: false,
        recipeVersion: { found, supported: this.recipeVersion },
        components: [],
        systems: [],
      };
    }
    let chain: ReturnType<typeof this.migrateChain>;
    try {
      chain = this.migrateChain(snapshot);
    } catch (err) {
      // A migration is user code and can throw. `canLoad` is the deploy gate, so a
      // broken migration is precisely what it should REPORT — crashing the
      // pipeline with a raw user error would break R56's no-throw contract at the
      // one moment it matters.
      return {
        ok: false,
        migrationFailed: { error: serializeError(err) },
        components: [],
        systems: [],
      };
    }
    if ('gap' in chain) {
      return {
        ok: false,
        missingMigration: { from: chain.gap, to: this.recipeVersion },
        components: [],
        systems: [],
      };
    }
    // Checked against the MIGRATED snapshot: a rename that a migration fixes is
    // not a missing component, which is the entire point of running the chain
    // before validation.
    const components = new Set<string>();
    for (const entity of chain.snapshot.entities) {
      for (const name of Object.keys(entity.components)) {
        if (!getComponentByName(name)) components.add(name);
      }
    }
    const systems = new Set<string>();
    for (const pair of chain.snapshot.pendingPairs) {
      if (!this.systemsByKey.has(pair.system)) systems.add(pair.system);
    }
    if (components.size === 0 && systems.size === 0) return { ok: true };
    return { ok: false, components: [...components], systems: [...systems] };
  }

  load(snapshot: Snapshot, opts?: { strict?: boolean; expectedStep?: number }): LoadReport {
    this.assertIdle('load a snapshot');
    // Fail loudly on a format we don't understand rather than misreading a
    // future/foreign snapshot against v1 field assumptions (R36).
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw new SnapshotVersionError(snapshot.version, SNAPSHOT_VERSION);
    }
    if (opts?.expectedStep !== undefined && snapshot.step !== opts.expectedStep) {
      throw new StaleSnapshotError(snapshot.step, opts.expectedStep);
    }

    // Migrations run BEFORE any name is resolved (R54) — that ordering is what
    // lets a migration rename a component this build no longer defines.
    const foundVersion = snapshot.recipeVersion ?? 0;
    if (foundVersion > this.recipeVersion) {
      throw new RecipeVersionError(foundVersion, this.recipeVersion, true);
    }
    const chain = this.migrateChain(snapshot);
    if ('gap' in chain) throw new RecipeVersionError(chain.gap, this.recipeVersion, false);
    const migrated = chain.snapshot;
    const report: LoadReport = { migrated: chain.applied, preserved: [], droppedPairs: [] };

    const strict = opts?.strict ?? true;
    const missingComponents = new Set<string>();
    for (const entity of migrated.entities) {
      for (const name of Object.keys(entity.components)) {
        if (!getComponentByName(name)) missingComponents.add(name);
      }
    }
    if (strict && missingComponents.size > 0) {
      throw new UnknownComponentError([...missingComponents]);
    }
    const missingSystems = new Set<string>();
    for (const pair of migrated.pendingPairs) {
      if (!this.systemsByKey.has(pair.system)) missingSystems.add(pair.system);
    }
    if (strict && missingSystems.size > 0) throw new UnknownSystemError([...missingSystems]);

    // Wholesale replacement of the previous timeline — including the flight
    // recorder (R36/R42 amended): a trace that mixed steps from two histories
    // would lie about the loaded world. (Validation above runs first, so a
    // failed load leaves the old trace intact.)
    this.traceBuf = [];
    this.entities = new Map();
    this.preserved = new Map();
    for (const entity of [...migrated.entities].sort((a, b) => a.id - b.id)) {
      const comps = new Map<string, unknown>();
      for (const [name, raw] of Object.entries(entity.components)) {
        const def = getComponentByName(name);
        const detached = JSON.parse(JSON.stringify({ raw })).raw as unknown;
        if (def === undefined) {
          // Non-strict only (a strict load already threw). Kept as inert data:
          // it joins no query and generates no dirt, but it survives the next
          // snapshot, so a rolling deploy cannot delete a component the other
          // version still owns (R55).
          let kept = this.preserved.get(entity.id);
          if (!kept) {
            kept = {};
            this.preserved.set(entity.id, kept);
          }
          kept[name] = detached;
          report.preserved.push({ entity: entity.id, component: name });
          continue;
        }
        if (def.deserialize) {
          try {
            comps.set(name, def.deserialize(detached));
          } catch (err) {
            throw new DeserializeError(entity.id, name, err);
          }
        } else {
          comps.set(name, detached);
        }
      }
      this.entities.set(entity.id, comps);
    }
    this.stepCount = migrated.step;
    this.nextEntityId = migrated.nextEntityId;
    this.dirt = new Map();
    for (const pair of migrated.pendingPairs) {
      if (!this.systemsByKey.has(pair.system)) {
        // Unlike a component value there is nowhere to keep this: dirt names a
        // system that must be scheduled. Reported rather than silently dropped —
        // the work it described will not run (R55).
        report.droppedPairs.push({ ...pair } as PendingPair);
        continue;
      }
      this.markDirt(pair.system, pair.entity, pair.reason);
    }
    // Match sets reflect the restored committed state; no dirt is generated so
    // the loaded world continues identically from the boundary (R36).
    this.matched = new Map();
    for (const sys of this.systemList) {
      const matchSet = new Set<number>();
      for (const [id, comps] of this.entities) {
        if (this.matchesQuery(sys.query, comps)) matchSet.add(id);
      }
      this.matched.set(sys.key, matchSet);
    }
    // A just-loaded boundary came FROM storage, so it needs no write of its own;
    // marking it saved keeps a fenced resume from immediately re-claiming the
    // step it just read (R57).
    this.markChanged();
    this.savedRevision = this.revision;
    this.notifyExternal({ kind: 'load' });
    return report;
  }
}

/**
 * Flattens spawn items per R34: AgentDef bundles (and their tags) first, then
 * plain ComponentInits, each group in argument order — so spawn-time extra
 * inits override bundle inits regardless of argument position.
 */
function flattenSpawnItems(items: readonly (ComponentInit<any> | AgentDef)[]): {
  agents: AgentDef[];
  sets: { component: ComponentType<any>; value: unknown }[];
} {
  const agents: AgentDef[] = [];
  const sets: { component: ComponentType<any>; value: unknown }[] = [];
  for (const item of items) {
    if (!isAgentDef(item)) continue;
    agents.push(item);
    for (const init of item.components) sets.push({ component: init.component, value: init.value });
    sets.push({ component: item.tag, value: true });
  }
  for (const item of items) {
    if (!isAgentDef(item)) sets.push({ component: item.component, value: item.value });
  }
  return { agents, sets };
}

function traceWrites(exec: PairExec): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const op of exec.ops) {
    if (op.kind === 'write') {
      out.push({
        entity: op.entity,
        component: op.component.componentName,
        kind: op.op === 'add' && op.component.reducer ? 'merge' : 'set',
        // Detached: the flight recorder never aliases live values (R42 amended).
        value: deepClone(op.value),
      });
    } else if (op.kind === 'remove') {
      out.push({ entity: op.entity, component: op.component.componentName, kind: 'remove' });
    }
  }
  return out;
}

/**
 * Creates a `World` (R12). Defaults: `id: 'world'`, `recursionLimit: 50`
 * (the per-run step cap; see `world.run`), trace enabled keeping the last
 * 1000 steps. With a `persistence` adapter the engine awaits
 * `adapter.save(snapshot)` after every committed step and once at run end
 * (R37). Entity ids start at 1 and are never reused within a world (R13).
 */
export function createWorld(opts?: WorldOptions): World {
  return new WorldImpl(opts);
}
