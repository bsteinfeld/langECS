// Devtools wire protocol — JSON messages over the `/ws` WebSocket, shared by
// the server (src/server.ts) and the UI (ui/). Type-only imports so the UI
// bundle never pulls server code.
//
// Conventions:
// - The server pushes a full `world` message after anything that can change
//   what the UI renders (external change, every committed step, run end).
//   The UI is a dumb renderer of the latest `world` — no client-side diffing.
// - Commands carry a client-chosen `id`; the server always answers with a
//   matching `result`. Mutations while a run is in flight fail with a clear
//   error (R16 is enforced by the engine; the server reports, never bypasses).
// - OTLP spans arrive out-of-band via `POST /v1/traces` (OTLP/HTTP JSON) and
//   are forwarded to clients as `spans` messages (ring-buffered for replay).

import type {
  ComponentInfo,
  InterruptRecord,
  ObserverEvent,
  PendingPair,
  Snapshot,
  StepTrace,
  SystemInfo,
} from '@langecs/core';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- world state

export interface ComponentState {
  name: string;
  /** Detached JSON value; `{ $unserializable: string }` when JSON-hostile. */
  value: unknown;
  tag: boolean;
  reducer: boolean;
  transient: boolean;
}

export interface EntityState {
  id: number;
  components: ComponentState[];
  /** Agent names derived from `agent:<name>` tags, for badges. */
  agents: string[];
}

export interface WorldState {
  worldId: string;
  step: number;
  running: boolean;
  entities: EntityState[];
  systems: SystemInfo[];
  /** Global component registry — the add-component picker's options. */
  components: ComponentInfo[];
  resources: string[];
  /** Pending dirt at the current boundary (who fires next, and why). */
  pendingPairs: PendingPair[];
  /** Entities awaiting a human (R33), with their interrupt records. */
  interrupts: { entity: number; interrupts: InterruptRecord[] }[];
  /** Steps restorable via `load-step`; `null` when no history adapter is wired. */
  historySteps: number[] | null;
}

// ----------------------------------------------------------------- OTLP spans

/**
 * One span decoded from an OTLP/HTTP JSON export (trace/span ids hex, times
 * as unix-nano strings to avoid double precision loss). Attribute values are
 * decoded from OTLP AnyValue into plain JSON.
 */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind enum value (0–5). */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  statusCode: number;
  statusMessage?: string;
  events: { timeUnixNano: string; name: string; attributes: Record<string, unknown> }[];
  /** Flattened resource attributes (service.name etc.). */
  resource: Record<string, unknown>;
  /** Instrumentation scope name/version. */
  scope?: { name: string; version?: string };
}

// ------------------------------------------------------------ server → client

export type ServerMessage =
  | { type: 'hello'; protocol: typeof PROTOCOL_VERSION; worldId: string; welcome?: boolean }
  | { type: 'world'; state: WorldState }
  /** Live tap of one run's events (includes the observer-only `run:reject`). */
  | { type: 'run-event'; runId: string; event: ObserverEvent }
  /** Full flight-recorder buffer (server pushes after every step). */
  | { type: 'trace'; steps: StepTrace[] }
  /** Newly ingested OTLP spans (replayed from the ring buffer on connect). */
  | { type: 'spans'; spans: SpanRecord[] }
  | { type: 'result'; id: number; ok: true; data?: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

// ------------------------------------------------------------ client → server

export type ClientCommand =
  /** Re-push `world` + `trace` (e.g. after reconnect). */
  | { id: number; type: 'refresh' }
  /** External component mutation — idle only (R16). `value` ignored for `remove`. */
  | {
      id: number;
      type: 'mutate';
      entity: number;
      component: string;
      action: 'set' | 'add' | 'remove';
      value?: unknown;
    }
  | { id: number; type: 'spawn'; components: { name: string; value: unknown }[] }
  | { id: number; type: 'despawn'; entity: number }
  /** Start a run (no-op dirt → status 'idle'). */
  | { id: number; type: 'run' }
  /** External adds then run — `world.send` (R25). */
  | { id: number; type: 'send'; entity: number; components: { name: string; value: unknown }[] }
  /** Answer an interrupt — `world.resume` (R33). */
  | { id: number; type: 'resume'; entity: number; value: unknown }
  /** Snapshot of the current boundary (R35); returned in `result.data`. */
  | { id: number; type: 'snapshot' }
  /** Time travel: load a historical snapshot (requires a history adapter). */
  | { id: number; type: 'load-step'; step: number };

/** `result.data` for a successful `snapshot` command. */
export type SnapshotResult = Snapshot;
