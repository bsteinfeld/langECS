// World-tab semantics: which zone an entity belongs to, what its token is
// called, whether it is spatially placeable, and its one-line status.
// Pure functions over protocol types — no React, no store.

import type { EntityState } from '../../../src/protocol';
import { isChatTranscript } from '../chat-shape';

export type Zone = 'agents' | 'evals' | 'bench' | 'other';

export const ZONE_ORDER: Zone[] = ['agents', 'evals', 'bench', 'other'];

const ZONE_META: Record<Zone, { label: string; icon: string }> = {
  agents: { label: 'AGENTS', icon: '🤖' },
  evals: { label: 'EVALS', icon: '🧪' },
  bench: { label: 'BENCH', icon: '📊' },
  other: { label: 'OTHER', icon: '⬡' },
};

export function zoneLabel(zone: Zone): string {
  return ZONE_META[zone].label;
}

export function zoneIcon(zone: Zone): string {
  return ZONE_META[zone].icon;
}

/**
 * Zone inference (spec §Placement engine): eval:* → evals, bench:* → bench,
 * then agent-shaped (server-derived agent tags, or a non-empty chat
 * transcript — an empty one is shape without evidence), else other.
 */
export function classifyEntity(entity: EntityState): Zone {
  const names = entity.components.map((c) => c.name);
  if (names.some((n) => n.startsWith('eval:'))) return 'evals';
  if (names.some((n) => n.startsWith('bench:'))) return 'bench';
  if (entity.agents.length > 0) return 'agents';
  if (entity.components.some((c) => isChatTranscript(c.value) && c.value.length > 0)) {
    return 'agents';
  }
  return 'other';
}

/** Token caption: a string `Name` component, else the first agent name, else #id. */
export function displayName(entity: EntityState): string {
  const name = entity.components.find((c) => c.name === 'Name');
  if (typeof name?.value === 'string' && name.value !== '') return name.value;
  return entity.agents[0] ?? `#${entity.id}`;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Spatial placement (spec): the first component — alphabetical by name, for
 * determinism — whose value is an object with numeric x and y.
 */
export function spatialPosition(entity: EntityState): Point | null {
  const sorted = [...entity.components].sort((a, b) => a.name.localeCompare(b.name));
  for (const comp of sorted) {
    const v = comp.value;
    if (
      v !== null &&
      typeof v === 'object' &&
      typeof (v as { x?: unknown }).x === 'number' &&
      typeof (v as { y?: unknown }).y === 'number'
    ) {
      return { x: (v as { x: number }).x, y: (v as { y: number }).y };
    }
  }
  return null;
}

/** One-line token status; null when there is nothing interesting to say. */
export function statusLine(entity: EntityState, runningSystems: string[]): string | null {
  if (runningSystems.length > 0) return `⚙ ${runningSystems[0]} running…`;
  const byName = new Map(entity.components.map((c) => [c.name, c.value]));
  if (byName.has('AwaitingHuman')) return '✋ awaiting human';
  if (byName.has('SystemError')) return '⚠ error';

  const score = byName.get('eval:Score');
  const verdict = byName.get('eval:Verdict');
  if (typeof score === 'number' || typeof verdict === 'string') {
    const parts: string[] = [];
    if (typeof score === 'number') parts.push(`score ${score}`);
    if (typeof verdict === 'string') parts.push(verdict);
    return parts.join(' · ');
  }

  const report = byName.get('bench:ComparisonReport');
  if (
    report !== null &&
    typeof report === 'object' &&
    Array.isArray((report as { candidates?: unknown }).candidates)
  ) {
    return `${(report as { candidates: unknown[] }).candidates.length} candidates`;
  }

  for (const comp of entity.components) {
    if (isChatTranscript(comp.value) && comp.value.length > 0) {
      const last = comp.value[comp.value.length - 1];
      if (last !== undefined) {
        return last.role === 'assistant' ? '✓ replied' : '… awaiting reply';
      }
    }
  }
  return null;
}
