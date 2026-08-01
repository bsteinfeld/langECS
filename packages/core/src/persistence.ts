import type { Snapshot } from './snapshot';

/**
 * Checkpointer contract (R37). The engine awaits `save` at the cadence set by
 * `createWorld({ saveEvery })` — every step barrier by default — and once at run
 * end (the quiescent boundary).
 */
export interface PersistenceAdapter {
  save(snapshot: Snapshot): void | Promise<void>;
  load(worldId: string): Promise<Snapshot | null> | Snapshot | null;
  history?(
    worldId: string,
  ): Promise<{ step: number; savedAt: number }[]> | { step: number; savedAt: number }[];
  loadStep?(worldId: string, step: number): Promise<Snapshot | null> | Snapshot | null;
  /**
   * Claims the right to write `step` for `worldId` (R57). Returns `false` when
   * another instance already owns that step or a later one, and the engine then
   * rejects the run with `FenceError` rather than let two worlds diverge.
   *
   * Optional, and only consulted by worlds created with `{ fence: true }` — so
   * single-process users and time-travel worlds pay nothing. It must be
   * **monotonic per worldId**: granting a step implicitly refuses every step at
   * or below it, which is what makes two workers resuming the same snapshot
   * resolve to exactly one winner.
   *
   * Implementations should make the check-and-claim atomic with respect to other
   * writers (a conditional write, a compare-and-set, `O_EXCL`); a read followed
   * by a separate write reintroduces the race it exists to close.
   */
  fence?(worldId: string, step: number): boolean | Promise<boolean>;
}

// Snapshots are JSON-stringifiable by contract (R35), so a JSON round-trip is a
// safe deep copy without reaching for host-specific APIs (isomorphism, R1).
function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
}

/**
 * In-memory adapter with full history per worldId (R38). Time travel:
 * `createWorld()` + `world.use(...)` + `world.load(await adapter.loadStep(id, n))`.
 */
export class MemoryAdapter implements PersistenceAdapter {
  private readonly worlds = new Map<string, Map<number, { snapshot: Snapshot; savedAt: number }>>();
  /** Highest step claimed per worldId (R57); only fenced worlds ever populate this. */
  private readonly claimed = new Map<string, number>();

  save(snapshot: Snapshot): void {
    let history = this.worlds.get(snapshot.worldId);
    if (!history) {
      history = new Map();
      this.worlds.set(snapshot.worldId, history);
    }
    history.set(snapshot.step, { snapshot: cloneSnapshot(snapshot), savedAt: Date.now() });
  }

  load(worldId: string): Snapshot | null {
    const history = this.worlds.get(worldId);
    if (!history || history.size === 0) return null;
    const latest = Math.max(...history.keys());
    const entry = history.get(latest);
    return entry ? cloneSnapshot(entry.snapshot) : null;
  }

  history(worldId: string): { step: number; savedAt: number }[] {
    const history = this.worlds.get(worldId);
    if (!history) return [];
    return [...history.entries()]
      .map(([step, entry]) => ({ step, savedAt: entry.savedAt }))
      .sort((a, b) => a.step - b.step);
  }

  loadStep(worldId: string, step: number): Snapshot | null {
    const entry = this.worlds.get(worldId)?.get(step);
    return entry ? cloneSnapshot(entry.snapshot) : null;
  }

  /**
   * Monotonic in-memory fence (R57). Synchronous and therefore atomic by
   * construction on one event loop — enough to make the two-workers-one-snapshot
   * test real, and the reference for what a durable adapter must do atomically.
   */
  fence(worldId: string, step: number): boolean {
    const owned = this.claimed.get(worldId);
    if (owned !== undefined && step <= owned) return false;
    this.claimed.set(worldId, step);
    return true;
  }
}
