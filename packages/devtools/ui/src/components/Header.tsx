// Top bar: product mark, world identity, run state, and global actions.

import { useState } from 'react';
import { downloadJson } from '../format';
import { useStore } from '../store';
import { DownloadIcon, MarkIcon, PlayIcon } from './icons';

export function Header() {
  const { state, command } = useStore();
  const { world, status } = state;
  const connected = status === 'open';
  const running = world?.running === true;
  const [saving, setSaving] = useState(false);

  const pill = !connected
    ? { className: 'status-pill disconnected', label: 'disconnected' }
    : running
      ? { className: 'status-pill running', label: 'running' }
      : { className: 'status-pill idle', label: 'idle' };

  const downloadSnapshot = async (): Promise<void> => {
    if (!world || saving) return;
    setSaving(true);
    try {
      const result = await command({ type: 'snapshot' });
      if (result.ok) {
        const step = String(world.step).padStart(2, '0');
        downloadJson(`${world.worldId}-step${step}.json`, result.data);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <header className="header">
      <div className="brand">
        <MarkIcon />
        <span className="brand-name">
          LangECS <span className="brand-sub">DevTools</span>
        </span>
      </div>

      {world && (
        <>
          <span className="chip chip-world" title="World id">
            {world.worldId}
          </span>
          <span className="chip" title="Committed step counter">
            step <strong>{world.step}</strong>
          </span>
        </>
      )}

      <span className={pill.className}>
        <span className="status-dot" />
        {pill.label}
      </span>

      <div className="header-spacer" />

      <button
        type="button"
        className="btn btn-accent"
        disabled={!connected || running}
        onClick={() => void command({ type: 'run' })}
        title={running ? 'A run is in flight' : 'Start a run (drains pending dirt)'}
      >
        <PlayIcon size={12} />
        Run
      </button>
      <button
        type="button"
        className="btn"
        disabled={!connected || !world || saving}
        onClick={() => void downloadSnapshot()}
        title="Download a snapshot of the current boundary"
      >
        <DownloadIcon size={13} />
        Snapshot
      </button>

      <span
        className={`conn-dot conn-${status}`}
        title={`WebSocket: ${status}`}
        aria-label={`Connection ${status}`}
        role="img"
      />
    </header>
  );
}
