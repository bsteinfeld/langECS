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
  DuplicateSystemError,
  LangECSError,
  MissingResourceError,
  type SerializedError,
  SnapshotVersionError,
  SystemTimeoutError,
  UnknownComponentError,
  UnknownEntityError,
  UnknownSystemError,
  WorldRunningError,
  WriteConflictError,
} from './errors';
export type {
  ChangeRecord,
  PairRef,
  Run,
  RunEvent,
  RunResult,
  RunStatus,
} from './events';
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
// Typed resource references (R18 amended): replace stringly-typed hops like
// `ctx.resource<Model>('model:main')` with
// `const MainModel = defineResource<Model>('model:main')` + `ctx.resource(MainModel)`.
export { defineResource, type ResourceRef } from './resource';
export type { PendingPair, Snapshot, SnapshotEntity } from './snapshot';
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
