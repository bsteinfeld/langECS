// The 🌍 World tab — a pannable, zoomable top-down scene of the live world.
// Zones mode: entities grouped into inferred districts (agents/evals/bench/
// other), flowing in a deterministic order. Selection opens a side panel that
// reuses the Inspector's EntityPanel — same commands, same idle-only rule.

import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { EntityState } from '../../../src/protocol';
import { entityById, useStore } from '../store';
import { activePairs } from '../world/liveness';
import {
  classifyEntity,
  displayName,
  statusLine,
  ZONE_ORDER,
  type Zone,
  zoneIcon,
  zoneLabel,
} from '../world/zones';
import { EmptyState } from './EmptyState';
import { PlusIcon } from './icons';
import { EntityPanel } from './InspectorTab';
import { SpawnModal } from './SpawnModal';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

interface ViewState {
  zoom: number;
  x: number;
  y: number;
}

function Token({
  entity,
  running,
  selected,
  onSelect,
}: {
  entity: EntityState;
  running: string[];
  selected: boolean;
  onSelect(id: number): void;
}) {
  const zone = classifyEntity(entity);
  const status = statusLine(entity, running);
  const classes = ['world-token'];
  if (selected) classes.push('selected');
  if (running.length > 0) classes.push('running');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-label={`Select entity ${entity.id}`}
      aria-pressed={selected}
      onClick={() => onSelect(entity.id)}
    >
      <span className="world-token-icon">{zoneIcon(zone)}</span>
      <span className="world-token-name">
        {displayName(entity)} <span className="world-token-id">#{entity.id}</span>
      </span>
      {status !== null && <span className="world-token-status">{status}</span>}
    </button>
  );
}

export function WorldTab() {
  const { state, dispatch } = useStore();
  const world = state.world;
  const [view, setView] = useState<ViewState>({ zoom: 1, x: 0, y: 0 });
  const [spawning, setSpawning] = useState(false);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; origin: ViewState } | null>(null);

  const active = useMemo(() => activePairs(state.events), [state.events]);
  const selected = entityById(world, state.selectedEntity);

  const byZone = useMemo(() => {
    const groups = new Map<Zone, EntityState[]>();
    for (const entity of world?.entities ?? []) {
      const zone = classifyEntity(entity);
      const list = groups.get(zone);
      if (list) list.push(entity);
      else groups.set(zone, [entity]);
    }
    for (const list of groups.values()) list.sort((a, b) => a.id - b.id);
    return groups;
  }, [world]);

  if (!world) {
    return <EmptyState title="Connecting…" hint="Waiting for the world snapshot." />;
  }

  const onSelect = (id: number): void => {
    dispatch({ type: 'select-entity', entity: state.selectedEntity === id ? null : id });
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => ({ ...v, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor)) }));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Pan only when grabbing the background, not a token/zone content.
    if (e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: view };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    setView({
      ...pan.origin,
      x: pan.origin.x + (e.clientX - pan.startX),
      y: pan.origin.y + (e.clientY - pan.startY),
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
  };

  return (
    <div className="world">
      <div className="world-toolbar">
        <div className="seg" role="group" aria-label="Zoom">
          <button
            type="button"
            className="seg-btn"
            aria-label="Zoom out"
            onClick={() =>
              setView((v) => ({ ...v, zoom: Math.max(ZOOM_MIN, v.zoom / 1.25) }))
            }
          >
            −
          </button>
          <button
            type="button"
            className="seg-btn"
            title="Reset view"
            onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            className="seg-btn"
            aria-label="Zoom in"
            onClick={() =>
              setView((v) => ({ ...v, zoom: Math.min(ZOOM_MAX, v.zoom * 1.25) }))
            }
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => setSpawning(true)}
          disabled={state.status !== 'open'}
        >
          <PlusIcon />
          Spawn
        </button>
        <span className="card-head-spacer" />
        <span className={world.running ? 'world-live running' : 'world-live'}>
          {world.running ? '● running' : '○ idle'} · step {world.step}
        </span>
      </div>

      <div className="world-body">
        <div
          className="world-canvas"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div
            className="world-surface"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          >
            {world.entities.length === 0 ? (
              <EmptyState title="No entities yet" hint="Spawn one from the toolbar." />
            ) : (
              <div className="world-zones">
                {ZONE_ORDER.map((zone) => {
                  const entities = byZone.get(zone);
                  if (!entities) return null;
                  return (
                    <section key={zone} className={`world-zone world-zone--${zone}`}>
                      <span className="world-zone-label">{zoneLabel(zone)}</span>
                      <div className="world-zone-tokens">
                        {entities.map((entity) => (
                          <Token
                            key={entity.id}
                            entity={entity}
                            running={active.get(entity.id) ?? []}
                            selected={entity.id === state.selectedEntity}
                            onSelect={onSelect}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {state.selectedEntity !== null && (
          <aside className="world-panel">
            <div className="world-panel-head">
              <button
                type="button"
                className="btn"
                aria-label="Close panel"
                onClick={() => dispatch({ type: 'select-entity', entity: null })}
              >
                ✕
              </button>
            </div>
            {selected ? (
              <EntityPanel key={selected.id} entity={selected} />
            ) : (
              <EmptyState
                title={`Entity #${state.selectedEntity} no longer exists`}
                hint="It was despawned."
              />
            )}
          </aside>
        )}
      </div>

      {spawning && <SpawnModal onClose={() => setSpawning(false)} />}
    </div>
  );
}
