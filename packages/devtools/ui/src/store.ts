// Global UI store: a useReducer state machine fed by batched server messages,
// plus pure derive helpers (entity lookup, trace grouping, system activity).
// The provider lives in main.tsx; components consume via `useStore()`.

import type { ObserverEvent, StepTrace, SystemInfo } from '@langecs/core';
import { createContext, type Dispatch, useContext } from 'react';
import type { EntityState, ServerMessage, SpanRecord, WorldState } from '../../src/protocol';
import { toNano } from './format';
import type { CommandInput, ConnectionStatus } from './ws';

export const EVENT_CAP = 2000;
export const SPAN_CAP = 5000;

export type Tab =
  | 'inspector'
  | 'systems'
  | 'timeline'
  | 'traces'
  | 'events'
  | 'interrupts'
  | 'timetravel';

export interface RunEventEntry {
  seq: number;
  runId: string;
  event: ObserverEvent;
}

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

export interface State {
  status: ConnectionStatus;
  world: WorldState | null;
  trace: StepTrace[];
  events: RunEventEntry[];
  spans: SpanRecord[];
  selectedEntity: number | null;
  tab: Tab;
  toasts: Toast[];
}

export const initialState: State = {
  status: 'connecting',
  world: null,
  trace: [],
  events: [],
  spans: [],
  selectedEntity: null,
  tab: 'inspector',
  toasts: [],
};

export type Action =
  | { type: 'status'; status: ConnectionStatus }
  /** Batched server messages — one dispatch per animation frame. */
  | { type: 'server'; messages: ServerMessage[] }
  | { type: 'select-entity'; entity: number | null }
  | { type: 'set-tab'; tab: Tab }
  | { type: 'toast'; kind: Toast['kind']; text: string }
  | { type: 'dismiss-toast'; id: number };

let eventSeq = 0;
let toastSeq = 0;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'status':
      return state.status === action.status ? state : { ...state, status: action.status };
    case 'server': {
      let next = state;
      let events: RunEventEntry[] | null = null;
      let spans: SpanRecord[] | null = null;
      for (const msg of action.messages) {
        switch (msg.type) {
          case 'hello':
            break;
          case 'world':
            next = next === state ? { ...state } : next;
            next.world = msg.state;
            break;
          case 'trace':
            next = next === state ? { ...state } : next;
            next.trace = msg.steps;
            break;
          case 'run-event':
            events = events ?? [...state.events];
            events.push({ seq: ++eventSeq, runId: msg.runId, event: msg.event });
            break;
          case 'spans':
            spans = spans ?? [...state.spans];
            spans.push(...msg.spans);
            break;
          default:
            break;
        }
      }
      if (events) {
        next = next === state ? { ...state } : next;
        next.events = events.length > EVENT_CAP ? events.slice(events.length - EVENT_CAP) : events;
      }
      if (spans) {
        // Dedupe by (traceId, spanId), last write wins: the server replays its
        // whole ring buffer on reconnect, and exporters may retry batches —
        // naive appending would duplicate every span (and a duplicated spanId
        // corrupts the waterfall tree).
        const byKey = new Map<string, SpanRecord>();
        for (const span of spans) byKey.set(`${span.traceId}:${span.spanId}`, span);
        const deduped = [...byKey.values()];
        next = next === state ? { ...state } : next;
        next.spans = deduped.length > SPAN_CAP ? deduped.slice(deduped.length - SPAN_CAP) : deduped;
      }
      return next;
    }
    case 'select-entity':
      return { ...state, selectedEntity: action.entity };
    case 'set-tab':
      return { ...state, tab: action.tab };
    case 'toast':
      return {
        ...state,
        toasts: [...state.toasts, { id: ++toastSeq, kind: action.kind, text: action.text }],
      };
    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
}

// -------------------------------------------------------------------- context

export type CommandResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface StoreValue {
  state: State;
  dispatch: Dispatch<Action>;
  /** Send a command. Rejections toast automatically and resolve `{ ok: false }`. */
  command(cmd: CommandInput): Promise<CommandResult>;
}

export const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside the devtools provider');
  return value;
}

// ------------------------------------------------------------ derive helpers

export function entityById(world: WorldState | null, id: number | null): EntityState | undefined {
  if (!world || id === null) return undefined;
  return world.entities.find((e) => e.id === id);
}

/** Entity ids matched by a system's effective query, computed client-side. */
export function matchedEntities(world: WorldState, system: SystemInfo): number[] {
  const out: number[] = [];
  for (const entity of world.entities) {
    const names = new Set(entity.components.map((c) => c.name));
    if (
      system.query.include.every((n) => names.has(n)) &&
      system.query.exclude.every((n) => !names.has(n))
    ) {
      out.push(entity.id);
    }
  }
  return out;
}

export interface LastRun {
  step: number;
  ms: number;
  error: boolean;
}

/** Latest flight-recorder activity per system key (steps are ordered, later wins). */
export function lastRunBySystem(trace: StepTrace[]): Map<string, LastRun> {
  const map = new Map<string, LastRun>();
  for (const step of trace) {
    for (const run of step.runs) {
      map.set(run.system, { step: step.step, ms: run.ms, error: run.error !== undefined });
    }
  }
  return map;
}

// ------------------------------------------------------------- span grouping

export interface TraceGroup {
  traceId: string;
  spans: SpanRecord[];
  rootName: string;
  startNano: bigint;
  endNano: bigint;
  hasError: boolean;
}

/** Group spans into traces by traceId, newest (latest end time) first. */
export function groupTraces(spans: SpanRecord[]): TraceGroup[] {
  const byId = new Map<string, SpanRecord[]>();
  for (const span of spans) {
    const list = byId.get(span.traceId);
    if (list) list.push(span);
    else byId.set(span.traceId, [span]);
  }
  const groups: TraceGroup[] = [];
  for (const [traceId, list] of byId) {
    let startNano = toNano(list[0]?.startTimeUnixNano);
    let endNano = startNano;
    let hasError = false;
    for (const span of list) {
      const start = toNano(span.startTimeUnixNano);
      const end = toNano(span.endTimeUnixNano);
      if (start < startNano) startNano = start;
      if (end > endNano) endNano = end;
      if (span.statusCode === 2) hasError = true;
    }
    const ids = new Set(list.map((s) => s.spanId));
    const roots = list.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
    roots.sort((a, b) => {
      const d = toNano(a.startTimeUnixNano) - toNano(b.startTimeUnixNano);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    });
    groups.push({
      traceId,
      spans: list,
      rootName: roots[0]?.name ?? list[0]?.name ?? traceId,
      startNano,
      endNano,
      hasError,
    });
  }
  groups.sort((a, b) => (a.endNano > b.endNano ? -1 : a.endNano < b.endNano ? 1 : 0));
  return groups;
}

export interface SpanNode {
  span: SpanRecord;
  depth: number;
}

/** Flatten a trace into waterfall rows: parent/child by spanId, orphans at root. */
export function spanTreeRows(spans: SpanRecord[]): SpanNode[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const span of spans) {
    // Self-parented spans (a real broken-exporter case) count as roots, not
    // as their own children — they would otherwise never be visited.
    const parent =
      span.parentSpanId && span.parentSpanId !== span.spanId && ids.has(span.parentSpanId)
        ? span.parentSpanId
        : null;
    if (parent === null) {
      roots.push(span);
    } else {
      const list = children.get(parent);
      if (list) list.push(span);
      else children.set(parent, [span]);
    }
  }
  const byStart = (a: SpanRecord, b: SpanRecord): number => {
    const d = toNano(a.startTimeUnixNano) - toNano(b.startTimeUnixNano);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  };
  const rows: SpanNode[] = [];
  const seen = new Set<SpanRecord>();
  const visit = (span: SpanRecord, depth: number): void => {
    if (seen.has(span)) return; // parent cycles must not recurse forever
    seen.add(span);
    rows.push({ span, depth });
    const kids = children.get(span.spanId);
    if (kids) {
      kids.sort(byStart);
      for (const kid of kids) visit(kid, depth + 1);
    }
  };
  roots.sort(byStart);
  for (const root of roots) visit(root, 0);
  // Multi-span parent cycles never get reached from a root: surface them as
  // depth-0 rows rather than silently hiding data the tool exists to show.
  for (const span of spans) {
    if (!seen.has(span)) visit(span, 0);
  }
  return rows;
}

export type SpanCategory = 'run' | 'step' | 'system' | 'genai' | 'other';

/** Hue bucket for waterfall bars: langecs run/step/system spans + GenAI spans. */
export function spanCategory(span: SpanRecord): SpanCategory {
  if (span.attributes['gen_ai.operation.name'] !== undefined) return 'genai';
  const name = span.name;
  if (name.startsWith('langecs.run') || name === 'run') return 'run';
  if (name.startsWith('langecs.step') || /^step\b/.test(name)) return 'step';
  if (name.startsWith('langecs.system') || /^system\b/.test(name)) return 'system';
  return 'other';
}
