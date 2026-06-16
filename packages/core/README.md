# @langecs/core

The LangECS engine: an Entity-Component-System runtime for LLM agents and multi-agent
systems. **Zero runtime dependencies, isomorphic** (no `node:*` imports, no Node-only
globals) — the same code runs in Node, browsers, and edge runtimes.

LangECS is an experiment: "LangGraph.js, but the runtime is a living ECS world." Instead
of a graph whose nodes pass state along edges, you get a world of **entities** (agents,
tasks, blackboards — just ids), **components** (all state, as plain serializable data),
and **systems** (query-driven logic that fires when the data it watches changes). The
[six example ports](../../examples/README.md) are the acceptance test for that
hypothesis. If you come from LangGraph.js, read the
[concept map](../../docs/langgraph-comparison.md) first.

The engineering contract is [SPEC.md](../../SPEC.md) (requirements R1–R44); the
rationale is [DESIGN.md](../../DESIGN.md). This README documents the full public API of
`@langecs/core` as exported from [`src/index.ts`](src/index.ts).

```ts
import { createWorld, defineComponent, defineSystem, defineTag } from '@langecs/core';

const Mail = defineComponent<{ from: number; content: string }[]>({
  name: 'Mail',
  reducer: (current, incoming) => [...current, ...incoming], // concurrent writes merge
});
const SendTo = defineComponent<number>({ name: 'SendTo' });
const Receiver = defineTag('Receiver');

const sender = defineSystem({
  name: 'sender',
  query: [SendTo],
  run: (e, ctx) => {
    ctx.write(e.get(SendTo), Mail, [{ from: e.id, content: 'ping' }]);
  },
});

const receiver = defineSystem({
  name: 'receiver',
  query: [Mail, Receiver],
  when: (e) => e.get(Mail).length > 0, // sync guard; a veto consumes the trigger
  run: (e) => {
    console.log(e.get(Mail).map((m) => m.content)); // ['ping']
  },
});

const world = createWorld();
world.use(sender);
world.use(receiver);
const target = world.spawn(Receiver(), Mail([]));
world.spawn(SendTo(target.id));

const result = await world.run();
// step 1: sender fires (receiver vetoed — empty Mail);
// step 2: sender's foreign Mail append wakes receiver; then nothing is dirty.
console.log(result.status); // 'done'
```

No edges anywhere. The "graph" emerges from which systems read what other systems write.

---

## Execution model in one screen

- `world.run()` drives discrete **steps** (Pregel-style super-steps) until **quiescence**
  — no (system, entity) pair is both matching and dirty.
- A pair is **dirty** for the next step iff: its query newly matches the entity; a
  queried component changed **by a writer other than the pair itself** (self-write
  exclusion — `callLLM` appending to `Messages` does not re-call itself); external
  mutation touched it while idle; or `ctx.invalidate` targeted it.
- All eligible pairs in a step run **concurrently** (`Promise.all`). Reads see
  step-start state; mutations buffer per pair and apply at the **barrier** in
  deterministic order (system registration index, then entity id).
- Two pairs writing the same **reducer** component in one step merge deterministically.
  Two pairs writing the same **plain** component throw `WriteConflictError` — silent
  last-write-wins is impossible by construction.
- A throwing system discards its buffered writes and appends a `SystemError` record to
  the entity; other pairs commit normally. Failure is state you can query.
- After every barrier, the world is at a consistent boundary: snapshots are taken there,
  events are emitted there, and a configured persistence adapter saves there.

Component values are handed out **by reference and must be treated as immutable**.
Mutate only through the API (`add`/`set`/`remove`/`ctx.write`); in-place mutation of a
`get()` result is undefined behavior — it generates no dirt and no conflict.

---

## Components

### `defineComponent<T>(opts): ComponentType<T>`

```ts
function defineComponent<T>(opts: {
  name: string;                                  // globally unique; duplicate throws
  reducer?: (current: T, incoming: T) => T;      // merge concurrent same-step adds
  transient?: boolean;                           // excluded from snapshots
  serialize?: (value: T) => unknown;             // applied when snapshotting
  deserialize?: (raw: unknown) => T;             // applied when loading
}): ComponentType<T>
```

Component names live in a **process-global registry** (that is how snapshots rehydrate
reducers and serializers by name); defining a duplicate name throws
`DuplicateComponentError` immediately. Values must be structured-clone/JSON-serializable
— behavior (model clients, tools, DB handles) goes into world **resources** instead, and
components reference it by name.

A `ComponentType<T>` is **callable**: `Mail([...])` produces a `ComponentInit<T>` usable
in `world.spawn(...)`, `world.send(...)`, `ctx.spawn(...)`, and
`defineAgent({ components })`.

```ts
interface ComponentType<T, N extends string = string> {
  (value: T): ComponentInit<T>;
  readonly componentName: N;
  readonly reducer: ((current: T, incoming: T) => T) | undefined;
  readonly transient: boolean;
  readonly serialize: ((value: T) => unknown) | undefined;
  readonly deserialize: ((raw: unknown) => T) | undefined;
}

interface ComponentInit<T = unknown> {
  readonly component: ComponentType<T>;
  readonly value: T;
}
```

### `defineTag(name): TagType`

A tag is a `ComponentType<true>` callable with zero arguments: `Busy()`. The name
literal is captured in the type, so distinct tags are distinct types.

### `Not(component): NotTerm`

Negates a query term: `Not(Busy)` matches entities that do **not** have the component.
`QueryTerm = ComponentType<any> | NotTerm`. System queries need at least one positive
term; `world.query()` (debugging API) also accepts zero terms or negative-only terms.

### `getComponentByName(name): ComponentType<any> | undefined`

Registry lookup by name — how `world.load()` resolves snapshot component names.

---

## Systems

### `defineSystem(def): SystemDef`

```ts
const callLLM = defineSystem({
  name: 'callLLM',                                    // unique per registration scope
  query: [Messages, ModelRef, Not(Busy)],             // >= 1 positive term (throws otherwise)
  when: (e, ctx) => e.get(Messages).length > 0,       // optional SYNC guard, read-only
  run: async (e, ctx) => { /* ... */ },               // once per dirty matching entity per step
});
```

- `when` receives a read-only `EntityReadView` and a restricted
  `GuardCtx = { step, world, resource }` — guards cannot write, spawn, despawn,
  invalidate, or emit, at both the type level and at runtime. Returning `false` vetoes
  the pair and consumes its dirt (it will not re-fire until new dirt arrives). A
  throwing guard is treated like a throwing `run`.
- `run` may be sync or async. All its mutations buffer until the step barrier.

### Entity views

```ts
interface EntityReadView<Q> {
  readonly id: number;
  has(component: ComponentType<any>): boolean;
  get<C extends ComponentType<any>>(component: C): GetResult<C, Q>;
  components(): string[];                      // component names present
}

interface EntityView<Q> extends EntityReadView<Q> {
  add(tag: TagType): void;                     // tags: zero-value add
  add<C>(component: C, value: ComponentValue<C>): void;  // merge via reducer, else set
  set<C>(component: C, value: ComponentValue<C>): void;  // replace, bypasses reducer
  remove(component: ComponentType<any>): void;
  despawn(): void;
}

type EntityHandle<Q> = EntityView<Q>;          // external flavor (world.spawn/query)
```

The same shape has two behaviors. **Inside a system** (the `EntityView` passed to
`run`), mutations buffer to the barrier. **Externally** (the `EntityHandle` from
`world.spawn`/`world.query`/`world.entity`), mutations apply immediately while the world
is idle and throw `WorldRunningError` while a run is in flight.

**Typing (R39).** `e.get(C)` returns `T` (non-nullable) when `C` is a positive query
term, `T | undefined` otherwise — with tuple inference, no manual generics:

```ts
const Messages = defineComponent<Msg[]>({ name: 'messages', reducer: (a, b) => [...a, ...b] });
const ModelRef = defineComponent<string>({ name: 'modelRef' });
const Busy = defineTag('busy');

const callLLM = defineSystem({
  name: 'callLLM',
  query: [Messages, ModelRef, Not(Busy)],
  when: (e) => e.get(Messages).length > 0,          // Msg[] (non-nullable)
  run: async (e, ctx) => {
    const m: string = e.get(ModelRef);              // string (positive term)
    e.add(Messages, [{ role: 'assistant', content: 'hi' }]); // value typed as Msg[]
    const other = e.get(Busy);                      // true | undefined (not a positive term)
  },
});
```

Caveat: positive-term membership is decided structurally, so two
`defineComponent<string>(...)` results are type-interchangeable — `get()` of an absent
same-shaped component can typecheck as non-nullable yet return `undefined` at runtime.
Tags and agent auto-tags are name-branded and never collide. When in doubt, guard with
`has(C)`.

### `SystemCtx`

The second argument to `run`:

```ts
interface SystemCtx {
  readonly step: number;
  readonly world: WorldReadView;       // query/entity over step-start committed state
  spawn(...items: (ComponentInit | AgentDef)[]): EntityView;  // id allocated eagerly,
                                       // components materialize at the barrier
  despawn(target: EntityTarget): void;
  write<C>(target: EntityTarget, component: C, value: ComponentValue<C>,
           op?: 'add' | 'set'): void;  // cross-entity write (default 'add')
  remove(target: EntityTarget, component: ComponentType<any>): void;
  emit(data: unknown): void;           // push a 'custom' event live, mid-step;
                                       // observation only, never stored
  resource<T>(ref: ResourceRef<T>): T; // typed lookup, T inferred from the ref
  resource<T>(name: string): T;        // string form, same slot as the ref form;
                                       // both throw MissingResourceError if absent
  invalidate(target: EntityTarget, system?: string): void;  // manual dirt for next step
}

type EntityTarget = number | { readonly id: number };  // id, EntityHandle, or EntityView
```

`ctx.write` to another entity is **foreign dirt** for that entity's pairs — this is the
multi-agent communication primitive (see the `Inbox` pattern in
[@langecs/stdlib](../stdlib/README.md)). Writes targeting an entity despawned in the
same step are dropped and recorded in the trace's `droppedWrites`.

---

## Agents

### `defineAgent(opts): AgentDef`

```ts
function defineAgent<const N extends string>(opts: {
  name: N;
  components?: ComponentInit[];
  systems?: SystemDef[];
}): AgentDef<N>
```

A named, spawnable bundle of components + systems. Spawning an `AgentDef` (via
`world.spawn` or `ctx.spawn`):

- applies the component bundle (**deep-copied** — spawned entities never alias the
  template or each other),
- adds the auto-tag component `agent:<name>` (a real component, present in snapshots),
- idempotently registers each declared system under the key `<agentName>:<systemName>`
  with its query **automatically narrowed by the agent tag** — an agent's systems only
  run on its own instances, with zero new engine concepts underneath (it is plain tags
  and queries).

Spawn-time extra inits override bundle inits for the same component:
`world.spawn(myAgent, ModelRef('model:cheap'))`. Defining an agent registers its tag in
the global component registry, so duplicate agent names throw immediately.

Systems registered via `world.use(systemDef)` are **global** (no narrowing) — that is
how cross-cutting systems work (supervisors watching all workers, error healing,
budget guards).

```ts
interface AgentDef<N extends string = string> {
  readonly kind: 'agent';
  readonly name: N;
  readonly components: readonly ComponentInit[];
  readonly systems: readonly SystemDef[];
  readonly tag: TagType<`agent:${N}`>;   // queryable: world.query(myAgent.tag)
}
```

---

## World

### `createWorld(opts?): World`

```ts
interface WorldOptions {
  id?: string;                       // default 'world'; the persistence key
  persistence?: PersistenceAdapter;  // save() awaited after every step barrier
  recursionLimit?: number;           // default 50; per-run step cap
  trace?: boolean | { keep?: number };  // default: on, keeping last 1000 steps
}
```

### `World` methods

| Member | Signature | Behavior |
|---|---|---|
| `id` | `readonly string` | World id; the key adapters store snapshots under. |
| `step` | `readonly number` | Committed step counter; increments at each barrier. |
| `spawn` | `(...items: (ComponentInit \| AgentDef)[]) => EntityHandle` | Creates an entity (ids start at 1, never reused). Idle-only. |
| `use` | `(def: SystemDef \| AgentDef) => void` | Registers a global system, or an agent's scoped systems **without spawning** — required before `load()` of a snapshot containing that agent's entities. Idempotent per definition; same name + different definition throws. |
| `register` | `(name: string, resource: unknown) => void` \| `<T>(ref: ResourceRef<T>, value: T) => void` | Named resource for `ctx.resource`. The typed overload checks `value` against the ref's `T` (see below). Never snapshotted; re-register after `load()`. |
| `query` | `(...terms: QueryTerm[]) => EntityHandle[]` | Committed state, ordered by entity id. Zero-term and negative-only queries allowed (debugging). |
| `entity` | `(id: number) => EntityHandle \| undefined` | Lookup by id. |
| `run` | `(opts?: { limit?: number }) => Run` | Drives the step loop to quiescence. One run at a time (second call throws `WorldRunningError`). |
| `send` | `(target, ...inits: ComponentInit[]) => Run` | External `add`s (reducers merge) + `run()` — "give the agent input and let it work". |
| `pending` | `() => { entity, interrupts }[]` | Entities with `AwaitingHuman` records, as detached copies. |
| `resume` | `(target, value: unknown) => Run` | Removes `AwaitingHuman`, sets `HumanResponse({ value })`, runs to quiescence. |
| `snapshot` | `() => Snapshot` | Sync, JSON-stringifiable, detached. |
| `load` | `(snapshot: Snapshot) => void` | Restores entities, counters, and pending dirt; discards the previous timeline and clears the trace buffer. Throws `SnapshotVersionError` on an unknown version and `DeserializeError` (with entity + component) if a `deserialize` hook fails. |
| `getTrace` | `() => StepTrace[]` | The flight recorder's ring buffer. |
| `running` | `readonly boolean` | Whether a run is in flight (external mutation throws while `true`). |
| `observe` | `(observer: WorldObserver) => () => void` | Attaches an observer (event tap, external-change notifications, system-run middleware); returns an idempotent detach. The integration point for `@langecs/otel` and `@langecs/devtools`. |
| `systems` | `() => SystemInfo[]` | Registered systems with effective queries (auto-tag included) and scoping, in registration order. |
| `resources` | `() => string[]` | Registered resource names, sorted (values never exposed). |
| `systemsMatching` | `(entityId: number) => SystemInfo[]` | Forward introspection: which systems' queries currently match an entity — "what could fire for this entity?" Great for "why isn't my system running?" |
| `queryStats` | `() => QueryStat[]` | Per-system `matchCount` (live) + `runCount`/`errorCount`/`totalMs`/`lastStepFired` aggregated from the retained trace — "which systems are hot / never fire / keep erroring". |

### `defineResource<T>(name): ResourceRef<T>`

A **typed resource reference**: the resource name carrying the resource's type. Purely a
type-level affordance — at runtime a ref is just `{ resourceName }`; there is no global
registry and no uniqueness rule, and a ref interoperates with the plain string form
(same name = same slot, register by one and read by the other).

```ts
// Before — stringly typed; T asserted at every call site:
world.register('model:main', client);
const model = ctx.resource<Model>('model:main');

// After — typed name; register value checked, lookup type inferred:
const MainModel = defineResource<Model>('model:main');
world.register(MainModel, client);      // value must be a Model
const model = ctx.resource(MainModel);  // Model — no manual generic
```

A missing resource still throws `MissingResourceError` naming the resource, whichever
form looked it up.

---

## Runs and events

`world.run()` returns a `Run` — both `PromiseLike<RunResult>` **and**
`AsyncIterable<RunEvent>`. Iterators replay buffered events from run start, then go
live: no missed events regardless of when you start iterating.

```ts
type RunStatus = 'done' | 'pending' | 'error' | 'idle' | 'limit';

interface RunResult {
  status: RunStatus;
  steps: number;
  pending: { entity: number; interrupts: InterruptRecord[] }[];  // detached copies
  errors: { entity: number; records: ErrorRecord[] }[];          // detached copies
}
```

Status precedence at quiescence: `'error'` (some entity has `SystemError` records) >
`'pending'` (some entity has `AwaitingHuman` records) > `'done'`. A run that scheduled
zero steps returns `'idle'`. Hitting the step limit returns `'limit'` **with all
remaining dirt intact** — a later `run()` resumes the pending work.

```ts
type RunEvent =
  | { type: 'run:start'; runId: string }
  | { type: 'step:start'; step: number; scheduled: PairRef[] }
  | { type: 'system:start'; step: number; system: string; entity: number }
  | { type: 'system:end'; step: number; system: string; entity: number; ms: number }
  | { type: 'system:error'; step: number; system: string; entity: number; error: SerializedError }
  | { type: 'custom'; step: number; system: string; entity: number; data: unknown }  // ctx.emit
  | { type: 'step:applied'; step: number; changes: ChangeRecord[]; spawned: number[]; despawned: number[] }
  | { type: 'run:end'; status: RunStatus; steps: number };

interface ChangeRecord {
  entity: number;
  component: string;
  kind: 'set' | 'merge' | 'remove';
  value?: unknown;   // detached copy, never a live reference
}

interface PairRef { system: string; entity: number }
```

> **Note:** `step:start.scheduled` is the **post-guard** eligible pairs (vetoed pairs are not in
> it), while `StepTrace.scheduled` in the [flight recorder](#flight-recorder) is the **pre-guard**
> matched+dirty candidate list with vetoes broken out into `vetoed` — so the two lists differ for
> any step where a `when` guard said no.

Live consumption, adapted from the [react-agent example](../../examples/react-agent/main.ts):

```ts
const run = world.send(agent, Messages([userMsg]), MessageWaiting());

for await (const event of run) {
  switch (event.type) {
    case 'step:start':
      console.log(`[step ${event.step}] ${event.scheduled.map((p) => p.system).join(', ')}`);
      break;
    case 'custom': // e.g. streamed model tokens emitted mid-step via ctx.emit
      process.stdout.write((event.data as { text?: string }).text ?? '');
      break;
    case 'step:applied':
      console.log(event.changes.map((c) => `${c.kind} ${c.component}`).join(', '));
      break;
  }
}
const result = await run; // same Run object resolves to the RunResult
```

When a run **rejects** (e.g. `WriteConflictError`, a throwing reducer), iterators drain
all buffered events and then throw the rejection; promise consumers see the same
rejection; no `run:end` is emitted. The world state, dirt, step counter, and trace are
all left at the step-start boundary, so re-running reproduces the problem instead of
silently losing work.

---

## Flight recorder

With tracing enabled (the default), every step records a structured `StepTrace` into a
ring buffer — including pairs **vetoed** by `when` guards, which answers "why didn't my
system fire":

```ts
interface StepTrace {
  step: number;
  scheduled: PairRef[];        // all matched+dirty candidates, BEFORE guards
                               // (unlike step:start's post-guard `scheduled`)
  vetoed: PairRef[];           // guard vetoes (dirt consumed)
  runs: TraceRun[];            // { system, entity, ms, error?, writes: ChangeRecord[] }
  applied: ChangeRecord[];     // committed changes, incl. engine SystemError writes
  spawned: number[];
  spawnedBy?: { entity: number; system: string; parent: number }[];
  despawned: number[];
  droppedWrites?: DroppedWrite[];  // ops on entities despawned this step
  durationMs: number;
}
```

`world.getTrace()` returns the buffer; `formatTrace(steps)` renders a compact
human-readable block:

```ts
console.log(formatTrace(world.getTrace()));
// step 3 (12.4ms)
//   scheduled: mathbot:callLLM#1
//   run mathbot:callLLM#1 12.1ms
//     merge Messages on #1
//     remove MessageWaiting on #1
//   applied: merge Messages#1, remove MessageWaiting#1
```

Trace values are detached copies — later mutation of committed state can never rewrite
recorded history.

---

## Snapshots and persistence

### `world.snapshot()` / `world.load(snapshot)`

```ts
interface Snapshot {
  version: 1;
  worldId: string;
  step: number;
  nextEntityId: number;
  entities: { id: number; components: Record<string, unknown> }[]; // transient excluded,
                                                                   // serialize() applied
  pendingPairs: { entity: number; system: string; reason: string }[]; // dirt at boundary
}
```

A snapshot is always plain JSON. Because it includes `pendingPairs`, a loaded world
continues **identically** from the boundary — including work that had not fired yet.
`load()` requires every component name resolvable in the registry (import the defining
modules) and every `pendingPairs` system registered via `world.use(...)`; otherwise it
throws `UnknownComponentError`/`UnknownSystemError` listing what is missing. Resources
are never snapshotted; re-register them.

### `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  save(snapshot: Snapshot): void | Promise<void>;   // awaited after every step barrier
  load(worldId: string): Promise<Snapshot | null> | Snapshot | null;
  history?(worldId: string): Promise<{ step: number; savedAt: number }[]> | { step: number; savedAt: number }[];
  loadStep?(worldId: string, step: number): Promise<Snapshot | null> | Snapshot | null;
}
```

### `MemoryAdapter`

Ships in core; keeps **full history per worldId** with `history()`/`loadStep()` — which
makes time travel and forking free:

```ts
const adapter = new MemoryAdapter();
const world = createWorld({ id: 'conv', persistence: adapter });
// ... world.use(...), spawn, run a few steps ...

// Rewind to step 1 in a FRESH world and fork the timeline:
const fork = createWorld({ id: 'conv-fork' });
fork.use(sysA);                            // same registrations as the original
fork.use(sysB);
fork.load(adapter.loadStep('conv', 1)!);   // entities, counters, pending dirt
// diverge from here; the original world and its history are untouched
```

See the [time-travel example](../../examples/time-travel/main.ts) for the full demo and
[@langecs/persist-fs](../persist-fs/README.md) for the filesystem adapter
(kill the process, resume in a new one).

---

## Built-ins: errors as state, humans in the loop

Three components are defined by core itself (in the registry like any other):

```ts
const SystemError: ComponentType<ErrorRecord[]>;        // append reducer; engine-written
interface ErrorRecord { system: string; step: number; error: SerializedError }

const AwaitingHuman: ComponentType<InterruptRecord[]>;  // append reducer
interface InterruptRecord { id: string; kind: string; payload?: unknown }

const HumanResponse: ComponentType<{ value: unknown }>; // plain (replace)
```

**Errors.** When a pair's `run` (or `when`) throws, the engine discards that pair's
buffered writes and appends an `ErrorRecord` to the entity's `SystemError` at the
barrier. When the pair later succeeds, the engine removes its records (auto-clear). Both
count as foreign dirt — so a retry/healing system can simply query
`[SystemError, ...]` (the stdlib [`retry`](../stdlib/README.md#retry) system does
exactly this).

**Interrupts.** There is no engine pause machinery — quiescence IS the pause. A system
writes `AwaitingHuman` and stops producing trigger components; the run goes quiescent
with status `'pending'`. Adapted from the core test suite:

```ts
const asker = defineSystem({
  name: 'ask',
  query: [Question, Not(AwaitingHuman), Not(HumanResponse)],
  run: (e) => {
    e.add(AwaitingHuman, [{ id: 'q1', kind: 'question', payload: e.get(Question) }]);
  },
});
const handler = defineSystem({
  name: 'handle',
  query: [Question, HumanResponse],
  run: (e) => {
    e.set(Answer, String(e.get(HumanResponse).value));
    e.remove(HumanResponse);  // convention: consume the response when you act on it
    e.remove(Question);
  },
});

const r1 = await world.run();
r1.status;          // 'pending'
world.pending();    // [{ entity, interrupts: [{ id: 'q1', kind: 'question', ... }] }]
const r2 = await world.resume(e, 'blue');   // removes AwaitingHuman, sets HumanResponse, runs
r2.status;          // 'done'
```

Because `AwaitingHuman` is ordinary component state, a pending world survives snapshot,
process death, and `load()` in a new process — resume works anywhere.

### `interrupt(kind, payload?, id?)`

Helper producing an `AwaitingHuman` init with one record:
`e.add(AwaitingHuman, interrupt('tool-approval', { calls }).value)`. Generated ids are
unique across snapshot/load process boundaries; supply your own `id` to key approvals
stably.

---

## Model contracts

Core depends on **zero LLM packages**. It defines the plain-data contracts that
adapters ([@langecs/ai-sdk](../ai-sdk/README.md),
[@langecs/langchain](../langchain/README.md)) and the
[stdlib](../stdlib/README.md) build on — the engine itself never uses them:

```ts
type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  name?: string;
  thinking?: string;   // reasoning trace (o1/o3, Claude thinking, R1); output-only, captured by adapters
  meta?: Record<string, unknown>;
};

type ToolSpec = { name: string; description?: string; parameters?: Record<string, unknown> };

interface ModelRequest { messages: Msg[]; system?: string; tools?: ToolSpec[];
                         temperature?: number; maxTokens?: number;
                         // additional sampling controls, forwarded by adapters when set:
                         topP?: number; topK?: number; frequencyPenalty?: number;
                         presencePenalty?: number; seed?: number; stopSequences?: string[] }
interface ModelResult  { message: Msg; usage?: { inputTokens?: number; outputTokens?: number };
                         finishReason?: string; raw?: unknown }

interface Model {
  generate(req: ModelRequest): Promise<ModelResult>;
  stream?(req: ModelRequest, onChunk: (d: { text?: string }) => void): Promise<ModelResult>;
}
```

### `scriptedModel(turns)`

A deterministic `Model` for tests: returns the scripted turns in order (each turn a
`Msg` or `(req: ModelRequest) => Msg`), supports `stream` by chunking content, and
throws if called more times than scripted. The entire LangECS test suite — and every
example's test — runs on it with zero network.

```ts
world.register('model:main', scriptedModel([
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'add', args: { a: 2, b: 3 } }] },
  { role: 'assistant', content: 'The answer is 5.' },
]));
```

---

## Errors

All engine errors extend `LangECSError extends Error`.

| Class | Thrown when |
|---|---|
| `DuplicateComponentError` | `defineComponent`/`defineTag` reuses an existing name. Field: `componentName`. |
| `DuplicateSystemError` | A system key is registered twice with a different definition. Field: `systemKey`. |
| `WriteConflictError` | Two pairs write the same plain (reducer-less) component on one entity in one step. Fields: `component`, `entity`, `step`, and `pairs: { system, entity }[]` — the writer pairs in deterministic barrier order (`entity` is the **writer's** entity, which matters for cross-entity `ctx.write`). `systems` is a derived display-string getter; prefer `pairs` in code. |
| `WorldRunningError` | External mutation, registration, `load`, or a second `run()` while a run is in flight. |
| `UnknownComponentError` | `load()` meets component names missing from the registry. Field: `componentNames`. |
| `UnknownSystemError` | `load()` meets unregistered `pendingPairs` systems, or `ctx.invalidate` names an unresolvable system. Field: `systemNames`. |
| `SnapshotVersionError` | `load()` meets a snapshot whose `version` this build doesn't understand. Fields: `version`, `supported`. |
| `DeserializeError` | A component's `deserialize` hook throws during `load()`. Fields: `entity`, `component`, `cause`. |
| `MissingResourceError` | `ctx.resource(name)` with nothing registered under `name`. Field: `resourceName`. |
| `UnknownEntityError` | An external mutation targets a nonexistent (e.g. despawned) entity. Field: `entity`. |

`SerializedError = { name: string; message: string; stack?: string }` is the shape
errors take inside `SystemError` records and `system:error` events.

---

## Roadmap

Designed but deliberately deferred until after the example-port verdict
(see [DESIGN.md §8 and §11](../../DESIGN.md)):

- **OpenTelemetry export** — built strictly as a consumer of the flight-recorder
  `StepTrace` format above; no bespoke plumbing.
- **Visual world inspector** — watch components flow between agents, step slider, time
  travel; same trace format as its data source.
- Per-entity independent stepping, durable persistence adapters (SQLite/Postgres),
  a declarative YAML/JSON agent format, `interrupt()` sugar, LangGraph interop.

---

## See also

- [@langecs/stdlib](../stdlib/README.md) — Messages/Inbox components, the
  callLLM/executeTools/toolApproval choreography, the ReAct preset
- [@langecs/ai-sdk](../ai-sdk/README.md) · [@langecs/langchain](../langchain/README.md)
  — model adapters
- [@langecs/persist-fs](../persist-fs/README.md) — filesystem snapshots,
  kill-and-resume
- [Examples](../../examples/README.md) — the six LangGraph.js ports that gate v1
- [LangGraph comparison](../../docs/langgraph-comparison.md) ·
  [Prior art](../../docs/prior-art.md) · [Naming](../../docs/naming.md)
- [SPEC.md](../../SPEC.md) · [DESIGN.md](../../DESIGN.md) ·
  [CONTRIBUTING.md](../../CONTRIBUTING.md)
