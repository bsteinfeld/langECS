import type { AgentDef } from './agent';
import { isAgentDef } from './agent';
import type { ErrorRecord, InterruptRecord } from './builtins';
import { AwaitingHuman, HumanResponse, SystemError } from './builtins';
import type { ComponentInit, ComponentType, QueryTerm } from './component';
import { getComponentByName, isComponentType } from './component';
import {
  DuplicateSystemError,
  MissingResourceError,
  type SerializedError,
  serializeError,
  UnknownComponentError,
  UnknownEntityError,
  UnknownSystemError,
  WorldRunningError,
  WriteConflictError,
} from './errors';
import type { ChangeRecord, PairRef, Run, RunResult, RunStatus } from './events';
import { RunStream } from './events';
import type { PersistenceAdapter } from './persistence';
import type { ResourceRef } from './resource';
import type { Snapshot } from './snapshot';
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
}

export interface World {
  /** World id (default `'world'`, R12) — the persistence key for adapters (R37). */
  readonly id: string;
  /** Committed step counter; increments at each barrier commit (R25), restored by `load` (R36). */
  readonly step: number;
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
   */
  load(snapshot: Snapshot): void;
  /**
   * The flight recorder's ring buffer of recent `StepTrace`s (R42) — last
   * 1000 steps by default, empty when created with `trace: false`. Render
   * with `formatTrace(steps)`.
   */
  getTrace(): StepTrace[];
}

interface RegisteredSystem {
  key: string;
  def: SystemDef<any>;
  query: readonly QueryTerm[];
  positives: Set<string>;
  index: number;
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
  private readonly systems: RegisteredSystem[] = [];
  private readonly systemsByKey = new Map<string, RegisteredSystem>();
  private readonly resources = new Map<string, unknown>();
  /** systemKey -> entityId -> reason. The "pending pairs" of R26/R35. */
  private dirt = new Map<string, Map<number, string>>();
  /** Match set per system as of the last commit point (newly-matched detection). */
  private matched = new Map<string, Set<number>>();
  private running = false;
  private traceBuf: StepTrace[] = [];
  private runCounter = 0;

  constructor(opts?: WorldOptions) {
    this.id = opts?.id ?? 'world';
    this.persistence = opts?.persistence;
    this.recursionLimit = opts?.recursionLimit ?? 50;
    const trace = opts?.trace;
    this.traceKeep =
      trace === false ? 0 : trace === true || trace === undefined ? 1000 : (trace.keep ?? 1000);
  }

  get step(): number {
    return this.stepCount;
  }

  // ---------------------------------------------------------------- helpers

  private assertIdle(operation: string): void {
    if (this.running) throw new WorldRunningError(operation);
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
    for (const sys of this.systems) {
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
    const name = component.componentName;
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
  }

  register<T>(ref: ResourceRef<T>, value: NoInfer<T>): void;
  register(name: string, resource: unknown): void;
  register(nameOrRef: string | ResourceRef<unknown>, resource: unknown): void {
    this.resources.set(resourceNameOf(nameOrRef), resource);
  }

  private registerAgent(agent: AgentDef): void {
    for (const sysDef of agent.systems) {
      this.registerSystemInternal(`${agent.name}:${sysDef.name}`, sysDef, [
        agent.tag,
        ...sysDef.query,
      ]);
    }
  }

  private registerSystemInternal(
    key: string,
    def: SystemDef<any>,
    query: readonly QueryTerm[],
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
    const reg: RegisteredSystem = { key, def, query, positives, index: this.systems.length };
    this.systems.push(reg);
    this.systemsByKey.set(key, reg);
    this.matched.set(key, new Set());
  }

  // ------------------------------------------------------ external mutations

  spawn(...items: (ComponentInit<any> | AgentDef)[]): EntityHandle {
    this.assertIdle('spawn entities');
    const id = this.nextEntityId++;
    this.entities.set(id, new Map());
    const changes: AttributedChange[] = [];
    this.applySpawnItems(id, items, changes, 'external');
    this.refreshDirt(changes);
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
  }

  private externalRemove(id: number, component: ComponentType<any>): void {
    this.assertIdle('mutate entities externally');
    const comps = this.entities.get(id);
    if (!comps) throw new UnknownEntityError(id);
    const name = component.componentName;
    if (!comps.has(name)) return;
    comps.delete(name);
    this.refreshDirt([
      { record: { entity: id, component: name, kind: 'remove' }, writer: 'external' },
    ]);
  }

  private externalDespawn(id: number): void {
    this.assertIdle('despawn entities externally');
    if (!this.entities.has(id)) throw new UnknownEntityError(id);
    this.entities.delete(id);
    for (const entityMap of this.dirt.values()) entityMap.delete(id);
    for (const matchSet of this.matched.values()) matchSet.delete(id);
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
    if (this.running) throw new WorldRunningError('start a second run');
    this.running = true;
    const stream = new RunStream();
    stream.emit({ type: 'run:start', runId: `${this.id}:run-${++this.runCounter}` });
    this.driveLoop(stream, opts?.limit ?? this.recursionLimit).then(
      (result) => {
        this.running = false;
        stream.emit({ type: 'run:end', status: result.status, steps: result.steps });
        stream.resolve(result);
      },
      (err) => {
        this.running = false;
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

  private async driveLoop(stream: RunStream, limit: number): Promise<RunResult> {
    let steps = 0;
    let limitHit = false;

    while (true) {
      const stepNo = this.stepCount + 1;

      // 1. Candidates: matched ∩ dirty, in (system registration index, entity id) order.
      const candidates: { sys: RegisteredSystem; entity: number }[] = [];
      for (const sys of this.systems) {
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
            const exec = this.makeExec(c.sys, c.entity, stepNo, stream);
            exec.error = serializeError(err);
            execs.push(exec);
            continue;
          }
        }
        execs.push(this.makeExec(c.sys, c.entity, stepNo, stream));
      }

      // Quiescent-by-veto: every candidate vetoed. No barrier runs; the veto
      // dirt is consumed here, at this run's final boundary (R26).
      if (execs.length === 0) {
        for (const veto of vetoed) this.dirt.get(veto.system)?.delete(veto.entity);
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
      stream.emit({
        type: 'step:start',
        step: stepNo,
        scheduled: execs.map((x) => ({ system: x.sys.key, entity: x.entity })),
      });
      const stepStart = now();
      await Promise.all(
        execs.map(async (exec) => {
          if (exec.error) {
            // `when` already threw; report it like a failed run — with the
            // system:start/system:error pairing intact (R41 amended).
            stream.emit({
              type: 'system:start',
              step: stepNo,
              system: exec.sys.key,
              entity: exec.entity,
            });
            stream.emit({
              type: 'system:error',
              step: stepNo,
              system: exec.sys.key,
              entity: exec.entity,
              error: exec.error,
            });
            return;
          }
          stream.emit({
            type: 'system:start',
            step: stepNo,
            system: exec.sys.key,
            entity: exec.entity,
          });
          const start = now();
          try {
            await exec.sys.def.run(exec.view, exec.ctx);
            exec.ms = now() - start;
            stream.emit({
              type: 'system:end',
              step: stepNo,
              system: exec.sys.key,
              entity: exec.entity,
              ms: exec.ms,
            });
          } catch (err) {
            exec.ms = now() - start;
            exec.error = serializeError(err);
            exec.ops = []; // discard the buffer entirely (R31)
            stream.emit({
              type: 'system:error',
              step: stepNo,
              system: exec.sys.key,
              entity: exec.entity,
              error: exec.error,
            });
          }
        }),
      );

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

      stream.emit({
        type: 'step:applied',
        step: stepNo,
        changes: changeRecords,
        spawned: outcome.spawned,
        despawned: outcome.despawned,
      });

      this.stepCount += 1;
      if (this.persistence) await this.persistence.save(this.snapshot());
    }

    const status: RunStatus = limitHit
      ? 'limit'
      : steps === 0
        ? 'idle'
        : this.collectErrors().length > 0
          ? 'error'
          : this.pending().length > 0
            ? 'pending'
            : 'done';
    if (this.persistence) await this.persistence.save(this.snapshot());
    return { status, steps, pending: this.pending(), errors: this.collectErrors() };
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
    if (!this.resources.has(name)) throw new MissingResourceError(name);
    return this.resources.get(name) as T;
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
    stream: RunStream,
  ): PairExec {
    const ops: BufferOp[] = [];
    const exec = { sys, entity, ops, ms: 0 } as PairExec;
    const ctx: SystemCtx = {
      step: stepNo,
      world: this.worldReadView(),
      spawn: (...items) => {
        // Id allocated eagerly (R29); components materialize at the barrier.
        const id = this.nextEntityId++;
        exec.ops.push({ kind: 'spawn', entity: id, items });
        return this.bufferedView(id, exec);
      },
      despawn: (target) => {
        exec.ops.push({ kind: 'despawn', entity: resolveTarget(target) });
      },
      write: (target, component, value, op = 'add') => {
        exec.ops.push({ kind: 'write', entity: resolveTarget(target), component, value, op });
      },
      remove: (target, component) => {
        exec.ops.push({ kind: 'remove', entity: resolveTarget(target), component });
      },
      emit: (data) => {
        stream.emit({ type: 'custom', step: stepNo, system: sys.key, entity, data });
      },
      resource: <T>(nameOrRef: string | ResourceRef<T>): T => this.lookupResource(nameOrRef),
      invalidate: (target, system) => {
        const op: BufferOp = { kind: 'invalidate', entity: resolveTarget(target) };
        if (system !== undefined) op.system = system;
        exec.ops.push(op);
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
        exec.ops.push({
          kind: 'write',
          entity: id,
          component: c,
          value: value === undefined ? true : value,
          op: 'add',
        }),
      set: (c: ComponentType<any>, value?: unknown) =>
        exec.ops.push({
          kind: 'write',
          entity: id,
          component: c,
          value: value === undefined ? true : value,
          op: 'set',
        }),
      remove: (c) => exec.ops.push({ kind: 'remove', entity: id, component: c }),
      despawn: () => exec.ops.push({ kind: 'despawn', entity: id }),
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
            const name = op.component.componentName;
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
            const name = op.component.componentName;
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
    for (const exec of execs) this.dirt.get(exec.sys.key)?.delete(exec.entity);
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
      if (item.op === 'set') comps.set(item.name, item.value);
      else comps.delete(item.name);
      changes.push(item.change);
    }

    // Despawns, after all writes.
    const despawned: number[] = [];
    for (const id of [...despawnSet].sort((a, b) => a - b)) {
      if (!this.entities.has(id)) continue;
      this.entities.delete(id);
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
      for (const sys of this.systems) {
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
      for (const sys of this.systems) this.markDirt(sys.key, entity, 'invalidate');
      return;
    }
    const exact = this.systemsByKey.get(systemName);
    if (exact) {
      this.markDirt(exact.key, entity, 'invalidate');
      return;
    }
    const byName = this.systems.filter((s) => s.def.name === systemName);
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
    for (const sys of this.systems) {
      const entityMap = this.dirt.get(sys.key);
      if (!entityMap) continue;
      for (const [entity, reason] of [...entityMap.entries()].sort((a, b) => a[0] - b[0])) {
        pendingPairs.push({ entity, system: sys.key, reason });
      }
    }
    // JSON round-trip: detaches the snapshot from live state and enforces R3/R35.
    return JSON.parse(
      JSON.stringify({
        version: 1 as const,
        worldId: this.id,
        step: this.stepCount,
        nextEntityId: this.nextEntityId,
        entities,
        pendingPairs,
      }),
    ) as Snapshot;
  }

  load(snapshot: Snapshot): void {
    this.assertIdle('load a snapshot');
    const missingComponents = new Set<string>();
    for (const entity of snapshot.entities) {
      for (const name of Object.keys(entity.components)) {
        if (!getComponentByName(name)) missingComponents.add(name);
      }
    }
    if (missingComponents.size > 0) throw new UnknownComponentError([...missingComponents]);
    const missingSystems = new Set<string>();
    for (const pair of snapshot.pendingPairs) {
      if (!this.systemsByKey.has(pair.system)) missingSystems.add(pair.system);
    }
    if (missingSystems.size > 0) throw new UnknownSystemError([...missingSystems]);

    // Wholesale replacement of the previous timeline — including the flight
    // recorder (R36/R42 amended): a trace that mixed steps from two histories
    // would lie about the loaded world. (Validation above runs first, so a
    // failed load leaves the old trace intact.)
    this.traceBuf = [];
    this.entities = new Map();
    for (const entity of [...snapshot.entities].sort((a, b) => a.id - b.id)) {
      const comps = new Map<string, unknown>();
      for (const [name, raw] of Object.entries(entity.components)) {
        const def = getComponentByName(name);
        const detached = JSON.parse(JSON.stringify({ raw })).raw as unknown;
        comps.set(name, def?.deserialize ? def.deserialize(detached) : detached);
      }
      this.entities.set(entity.id, comps);
    }
    this.stepCount = snapshot.step;
    this.nextEntityId = snapshot.nextEntityId;
    this.dirt = new Map();
    for (const pair of snapshot.pendingPairs) this.markDirt(pair.system, pair.entity, pair.reason);
    // Match sets reflect the restored committed state; no dirt is generated so
    // the loaded world continues identically from the boundary (R36).
    this.matched = new Map();
    for (const sys of this.systems) {
      const matchSet = new Set<number>();
      for (const [id, comps] of this.entities) {
        if (this.matchesQuery(sys.query, comps)) matchSet.add(id);
      }
      this.matched.set(sys.key, matchSet);
    }
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
