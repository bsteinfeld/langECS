// @langecs/core — Entity-Component-System runtime for LLM agents.
// Zero runtime dependencies, isomorphic (no node:* imports).

export { type AgentDef, defineAgent } from './agent';
export {
  AwaitingHuman,
  type CancellationRecord,
  Cancelled,
  type ErrorRecord,
  HumanResponse,
  type InterruptRecord,
  interrupt,
  SystemError,
} from './builtins';
// Cooperative cancellation (R49): helpers for `Model`s, tools and systems that
// honour `ctx.signal`.
export { abortReason, anySignal, delay, throwIfAborted } from './cancel';
export {
  type ComponentInfo,
  type ComponentInit,
  type ComponentOptions,
  type ComponentType,
  defineComponent,
  defineTag,
  getComponentByName,
  listComponents,
  Not,
  type NotTerm,
  type QueryTerm,
  type TagType,
} from './component';
export {
  CancelledError,
  DeserializeError,
  DuplicateComponentError,
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
  UnknownComponentError,
  UnknownEntityError,
  UnknownSystemError,
  WorldRunningError,
  WriteConflictError,
} from './errors';
// Typed resource references (R18 amended): replace stringly-typed hops like
// `ctx.resource<Model>('model:main')` with
// `const MainModel = defineResource<Model>('model:main')` + `ctx.resource(MainModel)`.
export {
  defineEvent,
  type EventRef,
  isEventRef,
} from './event';
export type {
  ChangeRecord,
  PairRef,
  Run,
  RunEvent,
  RunResult,
  RunStatus,
} from './events';
export { hashRequest, requestKey } from './hash';
// Model middleware (R61): retry/timeout/fallback/rate-limit/cost/cache, composed
// at the resource-registration site and entirely outside engine semantics.
export {
  type CacheOptions,
  type ModelMiddleware,
  type RateLimitOptions,
  type RetryOptions,
  type UsageReport,
  withCache,
  withCost,
  withFallback,
  withRateLimit,
  withRetry,
  withTimeout,
  wrapModel,
} from './middleware';
export {
  type Model,
  type ModelRequest,
  type ModelResult,
  type Msg,
  type ScriptedModelOptions,
  type ScriptedTurn,
  scriptedModel,
  type ToolSpec,
} from './model';
// Observability & introspection (SPEC §14): `world.observe(...)` for devtools
// and telemetry bridges (passive event tap, external-change notifications,
// system-run middleware), plus `world.systems()`/`world.resources()`.
export type {
  ExternalChange,
  ObserverEvent,
  QueryStat,
  RunInfo,
  SystemInfo,
  SystemRunInfo,
  WorldObserver,
} from './observe';
export { MemoryAdapter, type PersistenceAdapter } from './persistence';
// Record/replay (R62): turn a real run into a deterministic fixture.
export {
  formatRecording,
  type Recording,
  type RecordingEntry,
  type RecordingModel,
  type ReplayOptions,
  recordingModel,
  replayModel,
} from './recording';
// Standard reducers (R59) — the merge functions every fan-in needs.
export {
  appendReducer,
  boundedAppend,
  dedupeByReducer,
  maxByReducer,
  mergeReducer,
  type Reducer,
  sumReducer,
} from './reducers';
export { defineResource, type ResourceRef } from './resource';
export type {
  LoadCheck,
  LoadReport,
  Migration,
  PendingPair,
  Snapshot,
  SnapshotEntity,
} from './snapshot';
export {
  type ComponentValue,
  defineSystem,
  type EntityHandle,
  type EntityReadView,
  type EntityTarget,
  type EntityView,
  type GetResult,
  type GuardCtx,
  type PositiveTerms,
  type SystemCtx,
  type SystemDef,
  type WorldReadView,
} from './system';
export { type DroppedWrite, formatTrace, type StepTrace, type TraceRun } from './trace';
export { createWorld, type RunningPair, type World, type WorldOptions } from './world';
