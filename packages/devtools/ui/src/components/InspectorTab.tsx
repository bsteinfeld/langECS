// Inspector: per-entity component cards with a collapsible JSON tree, inline
// JSON editing (set, or add-merge when the component has a reducer), add /
// remove component, despawn, and the chat view for stdlib `Messages`.

import { memo, useEffect, useMemo, useState } from 'react';
import type { ComponentState, EntityState } from '../../../src/protocol';
import { copyText, prettyJson } from '../format';
import { entityById, useStore } from '../store';
import { ChatComposer, ChatTranscript, isChatTranscript } from './ChatTranscript';
import { EmptyState } from './EmptyState';
import { CopyIcon, PencilIcon, PlusIcon, TrashIcon } from './icons';
import { JsonTree, parseJson } from './JsonTree';

/** Two-step destructive button: first click arms, second confirms. */
function ConfirmButton({
  label,
  confirmLabel,
  ariaLabel,
  onConfirm,
  icon,
}: {
  label: string;
  confirmLabel: string;
  ariaLabel: string;
  onConfirm(): void;
  icon?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (!armed) {
    return (
      <button
        type="button"
        className="btn btn-danger-ghost"
        aria-label={ariaLabel}
        onClick={() => setArmed(true)}
      >
        {icon !== false && <TrashIcon />}
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-pair">
      <button type="button" className="btn btn-danger" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button type="button" className="btn" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

const ComponentCard = memo(function ComponentCard({
  entityId,
  comp,
  highlighted,
}: {
  entityId: number;
  comp: ComponentState;
  highlighted: boolean;
}) {
  const { command } = useStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [merge, setMerge] = useState(false);
  const [view, setView] = useState<'chat' | 'json'>('chat');
  const [busy, setBusy] = useState(false);

  const chat = comp.name === 'Messages' && isChatTranscript(comp.value) ? comp.value : null;
  const parsed = useMemo(() => parseJson(text), [text]);
  // The server substitutes `{ $unserializable }` for JSON-hostile values
  // (state.ts); editing that placeholder would overwrite the real value.
  const degraded =
    typeof comp.value === 'object' && comp.value !== null && '$unserializable' in comp.value;

  const startEdit = (): void => {
    setText(prettyJson(comp.value));
    setMerge(false);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    if (!parsed.ok || busy) return;
    setBusy(true);
    const result = await command({
      type: 'mutate',
      entity: entityId,
      component: comp.name,
      action: merge ? 'add' : 'set',
      value: parsed.value,
    });
    setBusy(false);
    if (result.ok) setEditing(false);
  };

  const remove = (): void => {
    void command({ type: 'mutate', entity: entityId, component: comp.name, action: 'remove' });
  };

  return (
    <section className={highlighted ? 'card pulse' : 'card'}>
      <div className="card-head">
        <span className="card-title">{comp.name}</span>
        {comp.tag && <span className="chip chip-flag">tag</span>}
        {comp.reducer && <span className="chip chip-flag">reducer</span>}
        {comp.transient && <span className="chip chip-flag">transient</span>}
        {degraded && (
          <span className="chip chip-flag" title="Value is not JSON-serializable; shown degraded">
            unserializable
          </span>
        )}
        <span className="card-head-spacer" />
        {chat && !editing && (
          <div className="seg">
            <button
              type="button"
              className={view === 'chat' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setView('chat')}
            >
              chat
            </button>
            <button
              type="button"
              className={view === 'json' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setView('json')}
            >
              json
            </button>
          </div>
        )}
        {!comp.tag && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Copy ${comp.name} value`}
            title="Copy value"
            onClick={() => copyText(prettyJson(comp.value))}
          >
            <CopyIcon />
          </button>
        )}
        {!comp.tag && !editing && !degraded && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Edit ${comp.name}`}
            title="Edit as JSON"
            onClick={startEdit}
          >
            <PencilIcon />
          </button>
        )}
        <ConfirmButton
          label=""
          confirmLabel="Remove"
          ariaLabel={`Remove ${comp.name}`}
          onConfirm={remove}
        />
      </div>

      {editing ? (
        <div className="card-body">
          <textarea
            className={parsed.ok ? 'input editor-area' : 'input editor-area invalid'}
            aria-label={`${comp.name} JSON value`}
            value={text}
            rows={Math.min(18, Math.max(4, text.split('\n').length))}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {!parsed.ok && <div className="json-input-error">{parsed.error}</div>}
          <div className="editor-actions">
            {comp.reducer && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={merge}
                  onChange={(e) => setMerge(e.target.checked)}
                />
                add (merge via reducer)
              </label>
            )}
            <span className="card-head-spacer" />
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={!parsed.ok || busy}
              onClick={() => void save()}
            >
              Save{merge ? ' (add)' : ''}
            </button>
          </div>
        </div>
      ) : comp.tag ? null : (
        <div className="card-body">
          {chat && view === 'chat' ? (
            <>
              <ChatTranscript messages={chat} />
              <ChatComposer entity={entityId} />
            </>
          ) : (
            <JsonTree value={comp.value} />
          )}
        </div>
      )}
    </section>
  );
});

function AddComponentRow({ entity }: { entity: EntityState }) {
  const { state, command } = useStore();
  const [name, setName] = useState('');
  const [text, setText] = useState('null');
  const [busy, setBusy] = useState(false);

  const present = new Set(entity.components.map((c) => c.name));
  const options = (state.world?.components ?? []).filter((c) => !present.has(c.name));
  const selected = options.find((c) => c.name === name);
  const parsed = useMemo(() => parseJson(text), [text]);
  const valid = selected !== undefined && (selected.tag || parsed.ok);

  const add = async (): Promise<void> => {
    if (!valid || !selected || busy) return;
    setBusy(true);
    const result = await command({
      type: 'mutate',
      entity: entity.id,
      component: selected.name,
      action: 'add',
      value: selected.tag ? true : parsed.value,
    });
    setBusy(false);
    if (result.ok) {
      setName('');
      setText('null');
    }
  };

  if (options.length === 0) return null;

  return (
    <div className="add-comp">
      <select
        className="input"
        aria-label="Component to add"
        value={name}
        onChange={(e) => setName(e.target.value)}
      >
        <option value="">Add component…</option>
        {options.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
            {c.tag ? ' (tag)' : ''}
          </option>
        ))}
      </select>
      {selected && !selected.tag && (
        <textarea
          className={parsed.ok ? 'input add-comp-value' : 'input add-comp-value invalid'}
          aria-label="New component value (JSON)"
          value={text}
          rows={2}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <button type="button" className="btn" disabled={!valid || busy} onClick={() => void add()}>
        <PlusIcon />
        Add
      </button>
      {selected && !selected.tag && !parsed.ok && (
        <div className="json-input-error">{parsed.error}</div>
      )}
    </div>
  );
}

export function InspectorTab() {
  const { state, command, dispatch } = useStore();
  const entity = entityById(state.world, state.selectedEntity);

  if (state.selectedEntity === null) {
    return (
      <EmptyState
        title="No entity selected"
        hint="Pick an entity from the sidebar to inspect and edit its components."
      />
    );
  }
  if (!entity) {
    return (
      <EmptyState
        title={`Entity #${state.selectedEntity} no longer exists`}
        hint="It was despawned — select another entity from the sidebar."
      />
    );
  }

  const despawn = async (): Promise<void> => {
    const result = await command({ type: 'despawn', entity: entity.id });
    if (result.ok) dispatch({ type: 'select-entity', entity: null });
  };

  return (
    // Keyed by entity: switching the selection must remount every card —
    // otherwise an open editor, armed confirm, or composer draft keyed only
    // by component name silently retargets the newly selected entity.
    <div className="inspector" key={entity.id}>
      <div className="inspector-head">
        <h2 className="inspector-id">#{entity.id}</h2>
        {entity.agents.map((agent) => (
          <span key={agent} className="badge badge-agent">
            {agent}
          </span>
        ))}
        <span className="card-head-spacer" />
        <ConfirmButton
          label="Despawn"
          confirmLabel="Confirm despawn"
          ariaLabel={`Despawn entity ${entity.id}`}
          onConfirm={() => void despawn()}
        />
      </div>
      {entity.components.length === 0 && (
        <EmptyState title="No components" hint="Add one below to give this entity state." />
      )}
      {entity.components.map((comp) => (
        <ComponentCard
          key={comp.name}
          entityId={entity.id}
          comp={comp}
          highlighted={state.highlight?.components?.includes(comp.name) ?? false}
        />
      ))}
      <AddComponentRow entity={entity} />
    </div>
  );
}
