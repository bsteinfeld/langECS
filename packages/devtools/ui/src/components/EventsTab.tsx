// Live run-event log: type-colored rows, type/text filtering, run boundaries
// as separators, `custom` payloads highlighted, newest at the bottom.

import type { ObserverEvent } from '@langecs/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { formatMs, jsonPreview } from '../format';
import { type RunEventEntry, useStore } from '../store';
import { EmptyState } from './EmptyState';

const EVENT_TYPES = [
  'run:start',
  'step:start',
  'system:start',
  'system:end',
  'system:error',
  'custom',
  'step:applied',
  'run:end',
  'run:reject',
] as const;

type EventType = (typeof EVENT_TYPES)[number];

function typeClass(type: string): string {
  return `evt-${type.replace(':', '-')}`;
}

function eventDetail(event: ObserverEvent): string {
  switch (event.type) {
    case 'run:start':
      return event.runId;
    case 'step:start':
      return `scheduled ${event.scheduled.length} pair${event.scheduled.length === 1 ? '' : 's'}: ${event.scheduled
        .map((p) => `${p.system}#${p.entity}`)
        .join(', ')}`;
    case 'system:start':
      return '';
    case 'system:end':
      return formatMs(event.ms);
    case 'system:error':
      return `${event.error.name}: ${event.error.message}`;
    case 'custom':
      return jsonPreview(event.data, 160);
    case 'step:applied': {
      const parts = [`${event.changes.length} change${event.changes.length === 1 ? '' : 's'}`];
      if (event.spawned.length > 0) parts.push(`+${event.spawned.map((id) => `#${id}`).join(' ')}`);
      if (event.despawned.length > 0)
        parts.push(`−${event.despawned.map((id) => `#${id}`).join(' ')}`);
      return parts.join(' · ');
    }
    case 'run:end':
      return `${event.status} after ${event.steps} step${event.steps === 1 ? '' : 's'}`;
    case 'run:reject':
      return `${event.error.name}: ${event.error.message}`;
    default:
      return '';
  }
}

function searchText(entry: RunEventEntry): string {
  const e = entry.event;
  const pair = 'system' in e && 'entity' in e ? `${e.system}#${e.entity}` : '';
  return `${e.type} ${pair} ${eventDetail(e)} ${entry.runId}`.toLowerCase();
}

const EventRow = memo(function EventRow({ entry }: { entry: RunEventEntry }) {
  const e = entry.event;

  if (e.type === 'run:start') {
    return (
      <div className="evt-separator">
        <span className="evt-separator-line" />
        <span className="evt-separator-label mono">run {e.runId}</span>
        <span className="evt-separator-line" />
      </div>
    );
  }

  if (e.type === 'run:reject') {
    return (
      <div className="evt-row evt-banner-error">
        <span className={`evt-tag ${typeClass(e.type)}`}>run:reject</span>
        <span className="evt-detail">{eventDetail(e)}</span>
      </div>
    );
  }

  const step = 'step' in e ? e.step : undefined;
  const pair = 'system' in e && 'entity' in e ? `${e.system}#${e.entity}` : undefined;

  return (
    <div className={e.type === 'custom' ? 'evt-row evt-row-custom' : 'evt-row'}>
      <span className={`evt-tag ${typeClass(e.type)}`}>{e.type}</span>
      {step !== undefined && <span className="evt-step mono">s{step}</span>}
      {pair !== undefined && <span className="evt-pair mono">{pair}</span>}
      <span className={e.type === 'custom' ? 'evt-detail evt-custom-json mono' : 'evt-detail'}>
        {eventDetail(e)}
      </span>
    </div>
  );
});

export function EventsTab() {
  const { state } = useStore();
  const [types, setTypes] = useState<ReadonlySet<EventType>>(new Set());
  const [text, setText] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return state.events.filter((entry) => {
      if (types.size > 0 && !types.has(entry.event.type as EventType)) return false;
      if (needle !== '' && !searchText(entry).includes(needle)) return false;
      return true;
    });
  }, [state.events, types, text]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-stick to the bottom when the list grows
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [follow, filtered.length]);

  const toggleType = (type: EventType): void => {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (state.events.length === 0) {
    return (
      <EmptyState
        title="No run events yet"
        hint="Press Run — every scheduler event streams here live, including ctx.emit() payloads."
      />
    );
  }

  return (
    <div className="events">
      <div className="panel-toolbar wrap">
        <div className="evt-filters">
          {EVENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={
                types.size === 0 || types.has(type)
                  ? `chip chip-filter active ${typeClass(type)}`
                  : 'chip chip-filter'
              }
              aria-pressed={types.has(type)}
              onClick={() => toggleType(type)}
            >
              {type}
            </button>
          ))}
        </div>
        <span className="card-head-spacer" />
        <input
          type="search"
          className="input"
          placeholder="Filter…"
          aria-label="Filter events by text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          auto-scroll
        </label>
      </div>
      <div className="events-scroll" ref={scrollRef}>
        {filtered.length === 0 ? (
          <div className="dim events-none">No events match the current filter.</div>
        ) : (
          filtered.map((entry) => <EventRow key={entry.seq} entry={entry} />)
        )}
      </div>
    </div>
  );
}
