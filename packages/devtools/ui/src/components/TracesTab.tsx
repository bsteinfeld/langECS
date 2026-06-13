// OTLP trace explorer: trace list (left) + hierarchical waterfall (right)
// with a span detail drawer. Span times are unix-nano strings — all math is
// BigInt to avoid double precision loss.

import { memo, useEffect, useMemo, useState } from 'react';
import type { SpanRecord } from '../../../src/protocol';
import {
  copyText,
  formatNanos,
  jsonPreview,
  nanoPercent,
  nanosToMs,
  relativeAge,
  toNano,
} from '../format';
import { groupTraces, spanCategory, spanTreeRows, type TraceGroup, useStore } from '../store';
import { EmptyState } from './EmptyState';
import { CloseIcon, CopyIcon } from './icons';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const TraceListItem = memo(function TraceListItem({
  group,
  selected,
  now,
  onSelect,
}: {
  group: TraceGroup;
  selected: boolean;
  now: number;
  onSelect(traceId: string): void;
}) {
  const classes = ['trace-item'];
  if (selected) classes.push('selected');
  if (group.hasError) classes.push('error');
  return (
    <button type="button" className={classes.join(' ')} onClick={() => onSelect(group.traceId)}>
      <div className="trace-item-top">
        <span className="trace-item-name">{group.rootName}</span>
        <span className="mono">{formatNanos(group.endNano - group.startNano)}</span>
      </div>
      <div className="trace-item-sub">
        <span>
          {group.spans.length} span{group.spans.length === 1 ? '' : 's'}
        </span>
        <span>{relativeAge(nanosToMs(group.endNano), now)}</span>
      </div>
    </button>
  );
});

function tokenBadge(span: SpanRecord): string | null {
  const input = span.attributes['gen_ai.usage.input_tokens'];
  const output = span.attributes['gen_ai.usage.output_tokens'];
  if (input === undefined && output === undefined) return null;
  return `${typeof input === 'number' ? input : '?'}/${typeof output === 'number' ? output : '?'} tok`;
}

const WaterfallRow = memo(function WaterfallRow({
  span,
  depth,
  traceStart,
  window,
  selected,
  onSelect,
}: {
  span: SpanRecord;
  depth: number;
  traceStart: bigint;
  window: bigint;
  selected: boolean;
  onSelect(spanId: string): void;
}) {
  const start = toNano(span.startTimeUnixNano);
  const end = toNano(span.endTimeUnixNano);
  const left = nanoPercent(start - traceStart, window);
  const width = Math.max(0.5, nanoPercent(end - start, window));
  const category = spanCategory(span);
  const tokens = category === 'genai' ? tokenBadge(span) : null;
  const classes = ['wf-row'];
  if (selected) classes.push('selected');
  if (span.statusCode === 2) classes.push('error');

  return (
    <button type="button" className={classes.join(' ')} onClick={() => onSelect(span.spanId)}>
      <span className="wf-name" style={{ paddingLeft: `${depth * 14}px` }}>
        <span className={`wf-dot cat-${category}`} />
        <span className="wf-name-text">{span.name}</span>
        {tokens !== null && <span className="chip chip-tokens">{tokens}</span>}
      </span>
      <span className="wf-dur mono">{formatNanos(end - start)}</span>
      <span className="wf-track">
        <span
          className={`wf-bar cat-${category}`}
          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
        />
      </span>
    </button>
  );
});

function AttrTable({ title, attrs }: { title: string; attrs: Record<string, unknown> }) {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return null;
  return (
    <>
      <div className="drawer-label">{title}</div>
      <table className="attr-table">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="attr-key">{key}</td>
              <td className="attr-val">{jsonPreview(value, 200)}</td>
              <td className="attr-copy">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Copy ${key}`}
                  onClick={() => copyText(jsonPreview(value, 100_000))}
                >
                  <CopyIcon size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SpanDrawer({ span, onClose }: { span: SpanRecord; onClose(): void }) {
  const start = toNano(span.startTimeUnixNano);
  const end = toNano(span.endTimeUnixNano);
  const status = span.statusCode === 2 ? 'error' : span.statusCode === 1 ? 'ok' : 'unset';
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{span.name}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close span details"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="drawer-body">
        <div className="drawer-meta">
          <span className={`chip cat-chip cat-${spanCategory(span)}`}>{spanCategory(span)}</span>
          <span className="mono">{formatNanos(end - start)}</span>
          <span className={`chip chip-status-${status}`}>
            {status}
            {span.statusMessage ? `: ${span.statusMessage}` : ''}
          </span>
        </div>
        <div className="drawer-ids mono">
          <div>
            trace {span.traceId}
            <button
              type="button"
              className="icon-btn"
              aria-label="Copy trace id"
              onClick={() => copyText(span.traceId)}
            >
              <CopyIcon size={11} />
            </button>
          </div>
          <div>
            span {span.spanId}
            {span.parentSpanId !== undefined && (
              <span className="dim"> · parent {span.parentSpanId}</span>
            )}
          </div>
          {span.scope && (
            <div className="dim">
              scope {span.scope.name}
              {span.scope.version ? `@${span.scope.version}` : ''}
            </div>
          )}
        </div>
        <AttrTable title="Attributes" attrs={span.attributes} />
        <AttrTable title="Resource" attrs={span.resource} />
        {span.events.length > 0 && (
          <>
            <div className="drawer-label">Events</div>
            <ul className="span-events">
              {span.events.map((event, i) => (
                <li key={`${event.timeUnixNano}:${event.name}:${String(i)}`}>
                  <span className="mono dim">
                    +{formatNanos(toNano(event.timeUnixNano) - start)}
                  </span>{' '}
                  <span className="span-event-name">{event.name}</span>
                  {Object.keys(event.attributes).length > 0 && (
                    <div className="span-event-attrs mono">
                      {jsonPreview(event.attributes, 160)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

export function TracesTab() {
  const { state } = useStore();
  const now = useNow(15_000);
  const groups = useMemo(() => groupTraces(state.spans), [state.spans]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [spanId, setSpanId] = useState<string | null>(null);

  const selected = groups.find((g) => g.traceId === traceId) ?? groups[0];
  const rows = useMemo(() => (selected ? spanTreeRows(selected.spans) : []), [selected]);
  const selectedSpan = selected?.spans.find((s) => s.spanId === spanId);

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No spans yet"
        hint={
          <>
            Point an OTLP http/json exporter at <code>POST /v1/traces</code> — e.g.{' '}
            <code>@langecs/otel</code> with an OTLPTraceExporter using this server's URL.
          </>
        }
      />
    );
  }

  const window = selected ? selected.endNano - selected.startNano : 0n;

  return (
    <div className={selectedSpan ? 'traces with-drawer' : 'traces'}>
      <div className="trace-list">
        {groups.map((group) => (
          <TraceListItem
            key={group.traceId}
            group={group}
            now={now}
            selected={group.traceId === selected?.traceId}
            onSelect={(id) => {
              setTraceId(id);
              setSpanId(null);
            }}
          />
        ))}
      </div>
      <div className="waterfall">
        {selected && (
          <>
            <div className="panel-toolbar">
              <span className="trace-item-name">{selected.rootName}</span>
              <span className="dim mono">{selected.traceId.slice(0, 16)}…</span>
              <span className="card-head-spacer" />
              <span className="mono">{formatNanos(window)}</span>
            </div>
            <div className="waterfall-rows">
              {rows.map(({ span, depth }) => (
                <WaterfallRow
                  key={span.spanId}
                  span={span}
                  depth={depth}
                  traceStart={selected.startNano}
                  window={window}
                  selected={span.spanId === spanId}
                  onSelect={(id) => setSpanId(id === spanId ? null : id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {selectedSpan && <SpanDrawer span={selectedSpan} onClose={() => setSpanId(null)} />}
    </div>
  );
}
