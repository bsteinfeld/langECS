/** Snapshot format (R35). Always JSON-stringifiable (R3 + serialize hooks). */

export interface SnapshotEntity {
  id: number;
  /** Component name -> serialized value. Transient components excluded. */
  components: Record<string, unknown>;
}

/** Dirt pending at the snapshot boundary, so a loaded world resumes identically (R36). */
export interface PendingPair {
  entity: number;
  system: string;
  reason: string;
}

export interface Snapshot {
  version: 1;
  worldId: string;
  step: number;
  nextEntityId: number;
  entities: SnapshotEntity[];
  pendingPairs: PendingPair[];
}
