// Liveness signals derived from the run-event stream the store already holds
// (spec: the scene gives existing data a body, it invents nothing).
// - activePairs: which (system, entity) pairs are executing right now
//   (system:start seen, no system:end/system:error yet, run not over).
// - bubblesSince: assistant messages that landed in chat-transcript
//   components via step:applied changes — works whether the change value is
//   the full merged transcript or just the appended delta, because in both
//   cases the last element is the new assistant message.

import { isChatTranscript } from '../chat-shape';
import type { RunEventEntry } from '../store';

export function activePairs(events: RunEventEntry[]): Map<number, string[]> {
  const active = new Map<number, string[]>();
  for (const { event } of events) {
    switch (event.type) {
      case 'system:start': {
        const list = active.get(event.entity) ?? [];
        list.push(event.system);
        active.set(event.entity, list);
        break;
      }
      case 'system:end':
      case 'system:error': {
        const list = active.get(event.entity);
        if (list) {
          const next = list.filter((s) => s !== event.system);
          if (next.length === 0) active.delete(event.entity);
          else active.set(event.entity, next);
        }
        break;
      }
      case 'run:end':
      case 'run:reject':
        active.clear();
        break;
      default:
        break;
    }
  }
  return active;
}

export interface BubbleSpec {
  seq: number;
  entity: number;
  text: string;
  tool: boolean;
}

const BUBBLE_MAX = 80;

export function bubblesSince(events: RunEventEntry[], afterSeq: number): BubbleSpec[] {
  const bubbles: BubbleSpec[] = [];
  for (const { seq, event } of events) {
    if (seq <= afterSeq || event.type !== 'step:applied') continue;
    for (const change of event.changes) {
      if (change.kind === 'remove') continue;
      if (!isChatTranscript(change.value) || change.value.length === 0) continue;
      const last = change.value[change.value.length - 1];
      if (last === undefined || last.role !== 'assistant') continue;
      const content = typeof last.content === 'string' ? last.content : '…';
      const text = content.length > BUBBLE_MAX ? `${content.slice(0, BUBBLE_MAX - 1)}…` : content;
      bubbles.push({ seq, entity: change.entity, text, tool: (last.toolCalls?.length ?? 0) > 0 });
    }
  }
  return bubbles;
}
