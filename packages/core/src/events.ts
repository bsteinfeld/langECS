import type { ErrorRecord, InterruptRecord } from './builtins';
import type { SerializedError } from './errors';

/** A (system, entity) pair reference as it appears in events and traces. */
export interface PairRef {
  system: string;
  entity: number;
}

/** One committed mutation, as reported by `step:applied` and the trace (R41). */
export interface ChangeRecord {
  entity: number;
  component: string;
  kind: 'set' | 'merge' | 'remove';
  value?: unknown;
}

export type RunStatus = 'cancelled' | 'done' | 'pending' | 'error' | 'idle' | 'limit';

export interface RunResult {
  status: RunStatus;
  steps: number;
  pending: { entity: number; interrupts: InterruptRecord[] }[];
  errors: { entity: number; records: ErrorRecord[] }[];
}

export type RunEvent =
  | { type: 'run:start'; runId: string }
  | { type: 'step:start'; step: number; scheduled: PairRef[] }
  | { type: 'system:start'; step: number; system: string; entity: number }
  | { type: 'system:end'; step: number; system: string; entity: number; ms: number }
  | { type: 'system:error'; step: number; system: string; entity: number; error: SerializedError }
  | { type: 'custom'; step: number; system: string; entity: number; data: unknown }
  | {
      type: 'step:applied';
      step: number;
      changes: ChangeRecord[];
      spawned: number[];
      despawned: number[];
    }
  | { type: 'run:end'; status: RunStatus; steps: number };

/**
 * Handle returned by `world.run()` (R40): awaitable for the `RunResult` and
 * async-iterable over `RunEvent`s. Iterators replay buffered events from run
 * start, then go live — no missed events regardless of when iteration starts.
 */
export interface Run extends PromiseLike<RunResult>, AsyncIterable<RunEvent> {}

export class RunStream implements Run {
  private readonly events: RunEvent[] = [];
  private settled = false;
  private rejected = false;
  private rejection: unknown;
  private notifiers: (() => void)[] = [];
  private readonly promise: Promise<RunResult>;
  private resolveFn!: (result: RunResult) => void;
  private rejectFn!: (err: unknown) => void;

  constructor() {
    this.promise = new Promise<RunResult>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // The rejection always surfaces through then(); this guard avoids
    // unhandled-rejection noise when callers only iterate events.
    this.promise.then(undefined, () => {});
  }

  emit(event: RunEvent): void {
    this.events.push(event);
    this.wake();
  }

  resolve(result: RunResult): void {
    this.settled = true;
    this.resolveFn(result);
    this.wake();
  }

  reject(err: unknown): void {
    this.settled = true;
    this.rejected = true;
    this.rejection = err;
    this.rejectFn(err);
    this.wake();
  }

  private wake(): void {
    const waiting = this.notifiers;
    this.notifiers = [];
    for (const notify of waiting) notify();
  }

  // biome-ignore lint/suspicious/noThenProperty: Run is PromiseLike by contract (R40).
  then<TResult1 = RunResult, TResult2 = never>(
    onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    let at = 0;
    while (true) {
      while (at < this.events.length) {
        const event = this.events[at];
        at += 1;
        yield event as RunEvent;
      }
      if (this.settled) {
        // A rejected run is never silent for iterate-only consumers (R40
        // amended): buffered events drain first, then the rejection throws.
        if (this.rejected) throw this.rejection;
        return;
      }
      await new Promise<void>((notify) => this.notifiers.push(notify));
    }
  }
}
