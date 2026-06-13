// Observability & introspection surface (SPEC §14, R45–R48).
//
// `world.observe(...)` is the integration point for devtools and telemetry
// bridges (e.g. `@langecs/otel`): a passive tap on run events, notifications
// for external mutations, and a middleware hook around system execution for
// async-context propagation. Observers are strictly outside engine semantics —
// a buggy observer can never change scheduling, state, or run results (R45).

import type { SerializedError } from './errors';
import type { RunEvent } from './events';

/**
 * Everything `onEvent` can receive: every `RunEvent` (R41) plus the
 * observer-only `run:reject`, fired when a run rejects at the barrier
 * (`WriteConflictError`, a throwing reducer, …). A rejected run emits no
 * `run:end` (R40), so without this observers would see runs that never finish.
 */
export type ObserverEvent = RunEvent | { type: 'run:reject'; error: SerializedError };

/** Identifies the run an observer callback belongs to. */
export interface RunInfo {
  worldId: string;
  /** Same id as the `run:start` event's `runId`. */
  runId: string;
}

/** Identifies one executing (system, entity) pair for `wrapSystemRun`. */
export interface SystemRunInfo extends RunInfo {
  step: number;
  /** Registration key, e.g. `'researcher:callLLM'` for agent-scoped systems. */
  system: string;
  entity: number;
}

/**
 * A mutation that happened outside a run, while the scheduler was idle (R16),
 * or a registration change — anything that can move world state without run
 * events firing (R48). Coarse by design: consumers refetch what they render.
 */
export type ExternalChange =
  | { kind: 'spawn'; entity: number }
  | { kind: 'write'; entity: number; component: string }
  | { kind: 'remove'; entity: number; component: string }
  | { kind: 'despawn'; entity: number }
  | { kind: 'load' }
  | { kind: 'systems' }
  | { kind: 'resource'; name: string };

export interface WorldObserver {
  /**
   * Passive tap on the event stream of every run, regardless of whether
   * anyone iterates the `Run` (R45). Called synchronously at the same points
   * the stream emits; exceptions are caught and reported via `console.error`,
   * never affecting the run.
   */
  onEvent?(event: ObserverEvent, info: RunInfo): void;
  /**
   * Fired after an external mutation or registration change commits (R48).
   * Exceptions are isolated like `onEvent`.
   */
  onExternalChange?(change: ExternalChange): void;
  /**
   * Middleware around one pair's `run` execution (R46) — the hook tracing
   * integrations use to make a span's context active around user code.
   *
   * Contract: call `fn` **exactly once** and propagate its promise (resolve
   * and reject alike). `fn` rejects iff the system threw; the engine treats
   * any rejection of the composed wrapper as the system throwing (R31), so a
   * wrapper that throws on its own is indistinguishable from a system error —
   * keep wrappers infallible. Wrappers compose across observers: the
   * first-registered observer is outermost.
   */
  wrapSystemRun?(info: SystemRunInfo, fn: () => Promise<void>): Promise<void>;
}

/** One registered system, as reported by `world.systems()` (R47). */
export interface SystemInfo {
  /** Registration key — `<agentName>:<systemName>` for agent-scoped systems. */
  key: string;
  /** The definition's own name. */
  name: string;
  /** Owning agent, for systems registered via an `AgentDef`. */
  agent?: string;
  /** Effective query (auto-tag narrowing included), split by polarity. */
  query: { include: string[]; exclude: string[] };
  /** Whether the system has a `when` guard. */
  hasGuard: boolean;
}
