import { type ComponentInit, defineComponent } from './component';
import type { SerializedError } from './errors';

/** One failed (system, entity) execution, appended by the engine at the barrier (R31). */
export interface ErrorRecord {
  system: string;
  step: number;
  error: SerializedError;
}

/** One pending human-in-the-loop interrupt (R10). */
export interface InterruptRecord {
  id: string;
  kind: string;
  payload?: unknown;
}

/** Append-reducer list of failed executions per entity (R9). */
export const SystemError = defineComponent<ErrorRecord[]>({
  name: 'SystemError',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** Append-reducer list of pending interrupts; non-empty => run status 'pending' (R10, R28). */
export const AwaitingHuman = defineComponent<InterruptRecord[]>({
  name: 'AwaitingHuman',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** Why and when a world was cancelled, stamped on every entity by `world.cancel` (R50). */
export interface CancellationRecord {
  /** The step boundary the cancellation landed at. */
  step: number;
  /** Operator-supplied explanation, surfaced in `ctx.signal`'s abort reason. */
  reason?: string;
}

/**
 * Stamped on **every** entity by `world.cancel(reason?)` (R50) — the third
 * member of the queryable-run-state family, alongside `SystemError` (failure)
 * and `AwaitingHuman` (waiting).
 *
 * It is ordinary component data, so it costs the engine nothing and survives
 * snapshot/load for free: a cancelled world reloads cancelled. Cancellation is
 * **cooperative** and opt-in at the query level — the standard guard is a
 * `Not(Cancelled)` term, which every stdlib system carries. A system without
 * that term keeps matching after a cancel, by design: the engine refuses to
 * decide which of your systems are safe to stop.
 */
export const Cancelled = defineComponent<CancellationRecord>({ name: 'Cancelled' });

/** The human's answer set by `world.resume(...)`; systems consume it with `remove` (R11, R33). */
export const HumanResponse = defineComponent<{ value: unknown }>({
  name: 'HumanResponse',
});

let interruptCounter = 0;
// Per-process entropy: interrupt ids are durable data (persisted inside
// AwaitingHuman by snapshots, R35), so ids minted after a kill-and-resume in a
// fresh process must not collide with ids loaded from a snapshot.
const interruptNonce = Math.random().toString(36).slice(2, 8).padEnd(4, '0');

/**
 * Helper producing an `AwaitingHuman` init with a single interrupt record (R10).
 *
 * When `id` is omitted one is generated as `interrupt-<counter>-<nonce>`,
 * where the nonce is random per-process entropy — generated ids stay unique
 * across snapshot/load process boundaries (the format is otherwise opaque; do
 * not parse it). Flows that key approvals by id across snapshot boundaries may
 * also supply their own stable `id`.
 */
export function interrupt(
  kind: string,
  payload?: unknown,
  id?: string,
): ComponentInit<InterruptRecord[]> {
  const record: InterruptRecord = {
    id: id ?? `interrupt-${++interruptCounter}-${interruptNonce}`,
    kind,
  };
  if (payload !== undefined) record.payload = payload;
  return AwaitingHuman([record]);
}
