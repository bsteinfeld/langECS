// Flight-recorder timeline: one block per StepTrace, newest at the bottom.
// Run lanes show normalized duration bars, write summaries, vetoes, applied
// changes, spawn/despawn and dropped-write warnings.

import type { ChangeRecord, StepTrace } from '@langecs/core';
import { memo, useEffect, useRef, useState } from 'react';
import { formatMs, jsonPreview } from '../format';
import { useStore } from '../store';
import { EmptyState } from './EmptyState';
import { AlertIcon, ChevronIcon } from './icons';

function barWidth(ms: number, maxMs: number): string {
  if (maxMs <= 0) return '3%';
  const frac = Math.log1p(Math.max(0, ms)) / Math.log1p(maxMs);
  return `${Math.max(3, frac * 100).toFixed(1)}%`;
}

function ChangeChip({ change, onInspect }: { change: ChangeRecord; onInspect(id: number): void }) {
  return (
    <button
      type="button"
      className={`chip chip-change chip-${change.kind}`}
      title={change.value !== undefined ? jsonPreview(change.value, 120) : undefined}
      onClick={() => onInspect(change.entity)}
    >
      {change.kind} {change.component}
      <span className="chip-entity-ref">#{change.entity}</span>
    </button>
  );
}

const StepBlock = memo(function StepBlock({
  step,
  onInspect,
}: {
  step: StepTrace;
  onInspect(id: number): void;
}) {
  const [showApplied, setShowApplied] = useState(false);
  const maxMs = step.runs.reduce((m, r) => Math.max(m, r.ms), 0);

  return (
    <article className="step-block">
      <header className="step-head">
        <span className="step-num">#{step.step}</span>
        <span className="mono">{formatMs(step.durationMs)}</span>
        <span className="dim">
          {step.runs.length} run{step.runs.length === 1 ? '' : 's'} · {step.applied.length} change
          {step.applied.length === 1 ? '' : 's'}
        </span>
        <span className="card-head-spacer" />
        {step.spawned.length > 0 && (
          <span className="badge badge-spawn">+{step.spawned.map((id) => `#${id}`).join(' ')}</span>
        )}
        {step.despawned.length > 0 && (
          <span className="badge badge-despawn">
            −{step.despawned.map((id) => `#${id}`).join(' ')}
          </span>
        )}
      </header>

      <div className="step-lanes">
        {step.runs.map((run) => (
          <div
            key={`${run.system}:${run.entity}`}
            className={run.error ? 'lane lane-error' : 'lane'}
          >
            <button
              type="button"
              className="lane-name"
              onClick={() => onInspect(run.entity)}
              title={run.error ? `${run.error.name}: ${run.error.message}` : undefined}
            >
              {run.error && <AlertIcon size={10} />}
              {run.system}
              <span className="chip-entity-ref">#{run.entity}</span>
            </button>
            <div className="lane-track">
              <div className="lane-bar" style={{ width: barWidth(run.ms, maxMs) }} />
              <span className="lane-ms mono">{formatMs(run.ms)}</span>
            </div>
            {run.writes.length > 0 && (
              <div className="lane-writes">
                {run.writes.map((w, i) => (
                  <ChangeChip
                    key={`${w.kind}:${w.component}:${w.entity}:${String(i)}`}
                    change={w}
                    onInspect={onInspect}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {step.vetoed.map((pair) => (
          <div key={`veto:${pair.system}:${pair.entity}`} className="lane lane-veto">
            <span className="lane-name dim">
              {pair.system}
              <span className="chip-entity-ref">#{pair.entity}</span>
            </span>
            <span className="chip chip-veto">veto</span>
          </div>
        ))}
      </div>

      {step.applied.length > 0 && (
        <div className="step-applied">
          <button
            type="button"
            className="step-applied-toggle"
            aria-expanded={showApplied}
            onClick={() => setShowApplied((s) => !s)}
          >
            <ChevronIcon open={showApplied} />
            applied ({step.applied.length})
          </button>
          {showApplied && (
            <div className="step-applied-list">
              {step.applied.map((change, i) => (
                <ChangeChip
                  key={`${change.kind}:${change.component}:${change.entity}:${String(i)}`}
                  change={change}
                  onInspect={onInspect}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {step.droppedWrites && step.droppedWrites.length > 0 && (
        <div className="step-dropped">
          <AlertIcon size={11} />
          dropped:{' '}
          {step.droppedWrites
            .map(
              (d) =>
                `${d.kind}${d.component ? ` ${d.component}` : ''} on #${d.entity} by ${d.system}`,
            )
            .join(', ')}
        </div>
      )}
    </article>
  );
});

export function TimelineTab() {
  const { state, dispatch } = useStore();
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const count = state.trace.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-stick to the bottom when steps arrive
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [follow, count]);

  const onInspect = (id: number): void => {
    dispatch({ type: 'select-entity', entity: id });
    dispatch({ type: 'set-tab', tab: 'inspector' });
  };

  if (count === 0) {
    return (
      <EmptyState
        title="No steps recorded yet"
        hint="Press Run — every committed step lands in the flight recorder."
      />
    );
  }

  return (
    <div className="timeline">
      <div className="panel-toolbar">
        <span className="dim">
          {count} step{count === 1 ? '' : 's'}
        </span>
        <span className="card-head-spacer" />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          auto-scroll
        </label>
      </div>
      <div className="timeline-scroll" ref={scrollRef}>
        {state.trace.map((step) => (
          <StepBlock key={step.step} step={step} onInspect={onInspect} />
        ))}
      </div>
    </div>
  );
}
