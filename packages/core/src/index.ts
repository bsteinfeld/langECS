// @langecs/core — Entity-Component-System runtime for LLM agents.
// Zero runtime dependencies, isomorphic (no node:* imports).

export { type AgentDef, defineAgent } from './agent';
export {
  AwaitingHuman,
  type ErrorRecord,
  HumanResponse,
  type InterruptRecord,
  interrupt,
  SystemError,
} from './builtins';
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
  DuplicateComponentError,
  DuplicateSystemError,
  LangECSError,
  MissingResourceError,
  type SerializedError,
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
  scriptedModel,
  type ToolSpec,
} from './model';
// Observability & introspection (SPEC §14): `world.observe(...)` for devtools
// and telemetry bridges (passive event tap, external-change notifications,
// system-run middleware), plus `world.systems()`/`world.resources()`.
export type {
  ExternalChange,
  ObserverEvent,
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
export { createWorld, type World, type WorldOptions } from './world';
