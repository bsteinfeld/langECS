// Time travel: restore any snapshot the persistence adapter kept. Restoring
// forks the timeline — the confirm dialog says exactly that.

import { useState } from 'react';
import { useStore } from '../store';
import { EmptyState } from './EmptyState';
import { HistoryIcon } from './icons';

export function TimeTravelTab() {
  const { state, command } = useStore();
  const world = state.world;
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  if (!world || world.historySteps === null) {
    return (
      <EmptyState
        title="Time travel unavailable"
        hint={
          <>
            Pass a persistence adapter with <code>history</code> to <code>startDevtools</code> (e.g.{' '}
            <code>MemoryAdapter</code> or <code>@langecs/persist-fs</code>) to restore earlier
            steps.
          </>
        }
      />
    );
  }

  const steps = [...world.historySteps].sort((a, b) => a - b);
  if (steps.length === 0) {
    return (
      <EmptyState
        title="No snapshots yet"
        hint="Run the world — each committed step is persisted and becomes restorable here."
      />
    );
  }

  const restore = async (step: number): Promise<void> => {
    setBusy(true);
    await command({ type: 'load-step', step });
    setBusy(false);
    setConfirming(null);
  };

  return (
    <div className="timetravel">
      <div className="hint timetravel-hint">
        <HistoryIcon />
        Restoring replaces live entities and pending dirt with the chosen snapshot. The next run
        continues from there — a fork, not an undo.
      </div>
      <ol className="tt-list">
        {steps.map((step) => {
          const current = step === world.step;
          return (
            <li key={step} className={current ? 'tt-row current' : 'tt-row'}>
              <span className="tt-step mono">step {step}</span>
              {current && <span className="chip chip-current">current</span>}
              <span className="card-head-spacer" />
              {confirming === step ? (
                <span className="confirm-pair">
                  <span className="tt-confirm-text">
                    Forks the timeline — entities and trace are replaced.
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => void restore(step)}
                  >
                    Restore
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || state.status !== 'open' || world.running}
                  onClick={() => setConfirming(step)}
                >
                  Restore
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
