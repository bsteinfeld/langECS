import type { Snapshot } from './snapshot';

/**
 * Checkpointer contract (R37). The engine awaits `save` after every step
 * barrier and once at run end (the quiescent boundary).
 */
export interface PersistenceAdapter {
  save(snapshot: Snapshot): void | Promise<void>;
  load(worldId: string): Promise<Snapshot | null> | Snapshot | null;
  history?(
    worldId: string,
  ): Promise<{ step: number; savedAt: number }[]> | { step: number; savedAt: number }[];
  loadStep?(worldId: string, step: number): Promise<Snapshot | null> | Snapshot | null;
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
}
