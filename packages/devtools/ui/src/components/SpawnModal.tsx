// Spawn-entity modal: rows of (component picker, JSON value). Tag components
// need no value; everything validates before the spawn command is enabled.

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { CloseIcon, PlusIcon, TrashIcon } from './icons';
import { parseJson } from './JsonTree';

interface Row {
  key: number;
  name: string;
  text: string;
}

let rowKey = 0;

export function SpawnModal({ onClose }: { onClose(): void }) {
  const { state, command } = useStore();
  const registry = state.world?.components ?? [];
  const [rows, setRows] = useState<Row[]>([{ key: ++rowKey, name: '', text: '' }]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isTag = (name: string): boolean => registry.find((c) => c.name === name)?.tag === true;

  // Rows are few — validate on render, no memo needed.
  const validation = rows.map((row) => {
    if (row.name === '') return 'Pick a component';
    if (isTag(row.name)) return null;
    const parsed = parseJson(row.text);
    return parsed.ok ? null : (parsed.error ?? 'Invalid JSON');
  });

  const valid = rows.length > 0 && validation.every((v) => v === null);

  const update = (key: number, patch: Partial<Row>): void => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const spawn = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    const components = rows.map((row) => ({
      name: row.name,
      value: isTag(row.name) ? true : parseJson(row.text).value,
    }));
    const result = await command({ type: 'spawn', components });
    setBusy(false);
    if (result.ok) onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Spawn entity">
        <div className="modal-head">
          <h2 className="modal-title">Spawn entity</h2>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">
          {rows.map((row, i) => (
            <div key={row.key} className="spawn-row">
              <div className="spawn-row-main">
                <select
                  className="input"
                  aria-label="Component"
                  value={row.name}
                  onChange={(e) => update(row.key, { name: e.target.value })}
                >
                  <option value="">component…</option>
                  {registry.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                      {c.tag ? ' (tag)' : ''}
                    </option>
                  ))}
                </select>
                <textarea
                  className="input spawn-row-value"
                  aria-label="Component value (JSON)"
                  placeholder={isTag(row.name) ? 'tag — no value' : 'JSON value'}
                  value={isTag(row.name) ? '' : row.text}
                  rows={2}
                  spellCheck={false}
                  disabled={isTag(row.name)}
                  onChange={(e) => update(row.key, { text: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove component row"
                  onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
                >
                  <TrashIcon />
                </button>
              </div>
              {validation[i] !== null && row.name !== '' && (
                <div className="json-input-error">{validation[i]}</div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setRows((rs) => [...rs, { key: ++rowKey, name: '', text: '' }])}
          >
            <PlusIcon />
            Add component
          </button>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-accent"
            disabled={!valid || busy}
            onClick={() => void spawn()}
          >
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
