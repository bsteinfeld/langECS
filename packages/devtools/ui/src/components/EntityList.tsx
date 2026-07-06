// Left sidebar: filterable entity list with agent/component badges, plus the
// spawn-entity modal trigger.

import { memo, useMemo, useState } from 'react';
import type { EntityState } from '../../../src/protocol';
import { useStore } from '../store';
import { EmptyState } from './EmptyState';
import { AlertIcon, HandIcon, PlusIcon } from './icons';
import { SpawnModal } from './SpawnModal';

const CHIP_LIMIT = 3;

const EntityRow = memo(function EntityRow({
  entity,
  selected,
  onSelect,
}: {
  entity: EntityState;
  selected: boolean;
  onSelect(id: number): void;
}) {
  const names = entity.components.map((c) => c.name);
  const hasError = names.includes('SystemError');
  const awaiting = names.includes('AwaitingHuman');
  const chips = names.filter((n) => !n.startsWith('agent:')).slice(0, CHIP_LIMIT);
  const more = names.filter((n) => !n.startsWith('agent:')).length - chips.length;

  return (
    <button
      type="button"
      className={selected ? 'entity-row selected' : 'entity-row'}
      onClick={() => onSelect(entity.id)}
    >
      <div className="entity-row-top">
        <span className="entity-id">#{entity.id}</span>
        {entity.agents.map((agent) => (
          <span key={agent} className="badge badge-agent">
            {agent}
          </span>
        ))}
        <span className="entity-row-spacer" />
        {hasError && (
          <span className="badge badge-error" title="Has SystemError records">
            <AlertIcon size={10} />
          </span>
        )}
        {awaiting && (
          <span className="badge badge-hand" title="Awaiting human input">
            <HandIcon size={10} />
          </span>
        )}
      </div>
      <div className="entity-row-chips">
        {chips.map((name) => (
          <span key={name} className="chip chip-comp">
            {name}
          </span>
        ))}
        {more > 0 && <span className="chip chip-more">+{more}</span>}
        {chips.length === 0 && <span className="entity-row-none">no components</span>}
      </div>
    </button>
  );
});

export function EntityList() {
  const { state, dispatch } = useStore();
  const { world, selectedEntity } = state;
  const [filter, setFilter] = useState('');
  const [spawning, setSpawning] = useState(false);

  const entities = useMemo(() => {
    const all = world?.entities ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter((e) => {
      if (`#${e.id}`.includes(needle) || String(e.id) === needle) return true;
      if (e.agents.some((a) => a.toLowerCase().includes(needle))) return true;
      return e.components.some((c) => c.name.toLowerCase().includes(needle));
    });
  }, [world, filter]);

  const onSelect = (id: number): void => {
    dispatch({ type: 'select-entity', entity: id });
    if (state.tab !== 'world') dispatch({ type: 'set-tab', tab: 'inspector' });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input
          type="search"
          className="input sidebar-filter"
          placeholder="Filter entities…"
          aria-label="Filter entities by id, agent or component"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-block"
          onClick={() => setSpawning(true)}
          disabled={!world || state.status !== 'open'}
        >
          <PlusIcon />
          Spawn entity
        </button>
      </div>
      <div className="sidebar-list">
        {entities.length === 0 ? (
          <EmptyState
            title={filter ? 'No matching entities' : 'No entities yet'}
            hint={
              filter
                ? 'Try a different id, agent or component name.'
                : 'Spawn one here, or run a world that spawns them.'
            }
          />
        ) : (
          entities.map((entity) => (
            <EntityRow
              key={entity.id}
              entity={entity}
              selected={entity.id === selectedEntity}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
      <div className="sidebar-foot">
        {world ? `${world.entities.length} entities · ${world.systems.length} systems` : '—'}
      </div>
      {spawning && <SpawnModal onClose={() => setSpawning(false)} />}
    </aside>
  );
}
