import type { SerializedError } from './errors';
import type { ChangeRecord, PairRef } from './events';

/** One executed pair within a step trace (R42). */
export interface TraceRun {
  system: string;
  entity: number;
  ms: number;
  error?: SerializedError;
  /** The pair's buffered writes as recorded (discarded buffers trace as empty). */
  writes: ChangeRecord[];
}

/**
 * An op dropped at the barrier because its target entity was despawned this
 * step or never existed: writes/removes per R25.5, invalidates per R24
 * (amended) — phantom dirt never reaches `pendingPairs`.
 */
export interface DroppedWrite {
  system: string;
  entity: number;
  component?: string;
  kind: 'write' | 'remove' | 'invalidate';
}

export interface StepTrace {
  /**
   * The step this entry describes. For a committed step this is the step
   * counter's value after the barrier; for the fully-vetoed, zero-step
   * iteration that ends a run (`committed: false`) it is the step that
   * iteration WOULD have been — no step commits, so a later run reuses the
   * number and `getTrace()` can hold two entries labelled alike.
   */
  step: number;
  /** All matched+dirty candidates this step, before `when` guards. */
  scheduled: PairRef[];
  /** Candidates vetoed by their `when` guard (dirt consumed). */
  vetoed: PairRef[];
  runs: TraceRun[];
  /** Committed changes, including engine writes (SystemError append/auto-clear). */
  applied: ChangeRecord[];
  spawned: number[];
  /** Creator attribution for every in-system spawn (R29). */
  spawnedBy?: { entity: number; system: string; parent: number }[];
  despawned: number[];
  droppedWrites?: DroppedWrite[];
  durationMs: number;
  /**
   * `false` on the fully-vetoed, zero-step iteration that quiesces a run
   * (R42/R45): every candidate's `when` guard vetoed, so the entry records the
   * vetoes and consumed dirt but **nothing was committed** and the step counter
   * did not advance. Absent on every committed step.
   */
  committed?: false;
}

const pair = (p: PairRef): string => `${p.system}#${p.entity}`;

/** Compact human-readable rendering of flight-recorder steps (R42). */
export function formatTrace(steps: StepTrace[]): string {
  const lines: string[] = [];
  for (const s of steps) {
    const label = s.committed === false ? ' (vetoed only, not committed)' : '';
    lines.push(`step ${s.step}${label} (${s.durationMs.toFixed(1)}ms)`);
    if (s.scheduled.length > 0) lines.push(`  scheduled: ${s.scheduled.map(pair).join(', ')}`);
    if (s.vetoed.length > 0) lines.push(`  vetoed:    ${s.vetoed.map(pair).join(', ')}`);
    for (const r of s.runs) {
      const status = r.error ? ` ERROR ${r.error.name}: ${r.error.message}` : '';
      lines.push(`  run ${pair(r)} ${r.ms.toFixed(1)}ms${status}`);
      for (const w of r.writes) {
        lines.push(`    ${w.kind} ${w.component} on #${w.entity}`);
      }
    }
    if (s.applied.length > 0) {
      lines.push(
        `  applied: ${s.applied.map((c) => `${c.kind} ${c.component}#${c.entity}`).join(', ')}`,
      );
    }
    if (s.spawned.length > 0)
      lines.push(`  spawned: ${s.spawned.map((id) => `#${id}`).join(', ')}`);
    if (s.despawned.length > 0) {
      lines.push(`  despawned: ${s.despawned.map((id) => `#${id}`).join(', ')}`);
    }
    if (s.droppedWrites && s.droppedWrites.length > 0) {
      lines.push(
        `  dropped: ${s.droppedWrites
          .map(
            (d) =>
              `${d.kind}${d.component ? ` ${d.component}` : ''} on #${d.entity} by ${d.system}`,
          )
          .join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}
