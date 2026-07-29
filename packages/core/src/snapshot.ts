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
  /**
   * The **envelope format** version — owned by the engine, bumped only when the
   * shape of this object changes. Not to be confused with `recipeVersion`, which
   * versions the caller's own component vocabulary (R54). Conflating the two is
   * tempting and wrong: the engine's format and an application's schema change
   * on completely independent schedules.
   */
  version: 1;
  /**
   * The **application vocabulary** version this snapshot was written with
   * (R54) — the caller's own number, from `createWorld({ recipeVersion })`.
   * Absent (treated as 0) for worlds that never declared one, including every
   * snapshot written before the field existed.
   *
   * This is what migrations are keyed on: renaming a component is a change to
   * *your* schema, not to the engine's.
   */
  recipeVersion?: number;
  worldId: string;
  step: number;
  nextEntityId: number;
  entities: SnapshotEntity[];
  pendingPairs: PendingPair[];
}

/**
 * A migration between two `recipeVersion`s (R54), applied by `world.load`.
 *
 * Receives a detached deep copy, so mutating and returning it is safe and is the
 * expected style. Migrations must be pure data transforms over the snapshot —
 * they run before any component is resolved against the registry, which is
 * precisely what lets them rename a component the running code no longer knows.
 */
export type Migration = (snapshot: Snapshot) => Snapshot;

/**
 * What `world.load` did, beyond restoring state (R36 amended).
 *
 * Empty everywhere on a clean strict load, so callers can ignore it; the fields
 * exist so a non-strict load (`{ strict: false }`) can never lose something
 * silently.
 */
export interface LoadReport {
  /** Migrations applied, in the order they ran (R54). */
  migrated: { from: number; to: number }[];
  /**
   * Components whose names are not in the registry, kept as opaque data rather
   * than dropped (R55). They take part in nothing — no query, no dirt, no
   * reducer — but they are written back out by the next `snapshot()`, so a
   * rolling deploy cannot destroy the state of a component the other version
   * still owns.
   */
  preserved: { entity: number; component: string }[];
  /**
   * Pending dirt discarded because its system is not registered (R55). Unlike a
   * component value there is nowhere to keep this: dirt names a system that has
   * to be *scheduled*. It is therefore reported loudly — the work it described
   * will not run.
   */
  droppedPairs: PendingPair[];
}

/** Result of `world.canLoad(snapshot)` — a pre-flight check with no side effects (R56). */
export type LoadCheck =
  | { ok: true }
  | {
      ok: false;
      /** Unsupported envelope format (R35): the engine cannot read this at all. */
      formatVersion?: { found: unknown; supported: number };
      /** Snapshot written by NEWER application code than this build (R54). */
      recipeVersion?: { found: number; supported: number };
      /** No migration path from the snapshot's `recipeVersion` to this world's. */
      missingMigration?: { from: number; to: number };
      /** Component names absent from the global registry (R36). */
      components: string[];
      /** `pendingPairs` systems not registered on this world (R36). */
      systems: string[];
    };
