// The 🌍 World tab — a pannable, zoomable top-down scene of the live world.
// Zones mode: entities grouped into inferred districts (agents/evals/bench/
// other), flowing in a deterministic order. Selection opens a side panel that
// reuses the Inspector's EntityPanel — same commands, same idle-only rule.

import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { EntityState } from '../../../src/protocol';
import { entityById, useStore } from '../store';
import { fallbackSlot, type Layout, loadLayout, saveLayout } from '../world/layout-store';
import { activePairs, bubblesSince } from '../world/liveness';
import {
  classifyEntity,
  displayName,
  type Point,
  spatialPosition,
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
const SPATIAL_SCALE = 60;
const SPATIAL_OFFSET = 60;

interface ViewState {
  zoom: number;
  x: number;
  y: number;
}

type LayoutMode = 'zones' | 'free' | 'spatial';

interface Ghost {
  id: number;
  icon: string;
  name: string;
  pos: Point;
}

function Token({
  entity,
  running,
  selected,
  bubble,
  onSelect,
}: {
  entity: EntityState;
  running: string[];
  selected: boolean;
  bubble: { text: string; tool: boolean } | null;
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
      {bubble !== null && (
        <span className={bubble.tool ? 'world-bubble tool' : 'world-bubble'}>
          {bubble.tool && <span aria-hidden="true">🔧 </span>}
          {bubble.text}
        </span>
      )}
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

  const [mode, setMode] = useState<LayoutMode>('zones');
  const [layout, setLayout] = useState<Layout>({});
  const worldId = world?.worldId;
  // Reload saved positions when the connected world changes.
  useEffect(() => {
    if (worldId !== undefined) setLayout(loadLayout(worldId, window.localStorage));
  }, [worldId]);

  const active = useMemo(() => activePairs(state.events), [state.events]);
  const selected = entityById(world, state.selectedEntity);

  const [bubbles, setBubbles] = useState<Map<number, { text: string; tool: boolean; seq: number }>>(
    new Map(),
  );
  // Cursor starts at the newest replayed event: history must not bubble on mount.
  const bubbleCursor = useRef<number | null>(null);
  useEffect(() => {
    const newest = state.events[state.events.length - 1]?.seq ?? 0;
    if (bubbleCursor.current === null) {
      bubbleCursor.current = newest;
      return;
    }
    const fresh = bubblesSince(state.events, bubbleCursor.current);
    bubbleCursor.current = Math.max(bubbleCursor.current, newest);
    if (fresh.length === 0) return;
    setBubbles((prev) => {
      const next = new Map(prev);
      for (const b of fresh) next.set(b.entity, { text: b.text, tool: b.tool, seq: b.seq });
      return next;
    });
    // Each batch schedules its own expiry; stale entries are dropped by seq —
    // a newer bubble for the same entity survives an older batch's timeout.
    const seqs = new Set(fresh.map((b) => b.seq));
    window.setTimeout(() => {
      setBubbles((prev) => {
        const next = new Map<number, { text: string; tool: boolean; seq: number }>();
        for (const [entity, bubble] of prev) if (!seqs.has(bubble.seq)) next.set(entity, bubble);
        return next;
      });
    }, 4000);
  }, [state.events]);

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

  const hasSpatial = useMemo(
    () => (world?.entities ?? []).some((e) => spatialPosition(e) !== null),
    [world],
  );
  // A world without coordinates cannot stay in spatial mode.
  useEffect(() => {
    if (mode === 'spatial' && !hasSpatial) setMode('zones');
  }, [mode, hasSpatial]);

  const dragRef = useRef<{
    pointerId: number;
    id: number;
    startX: number;
    startY: number;
    origin: Point;
  } | null>(null);

  /** Free-mode position: saved layout, else a deterministic grid slot. */
  const freePos = (entity: EntityState, index: number): Point => layout[entity.id] ?? fallbackSlot(index);

  const placeable = useMemo(() => {
    const entities = world?.entities ?? [];
    if (mode === 'spatial') {
      return entities.flatMap((entity) => {
        const p = spatialPosition(entity);
        return p === null
          ? []
          : [{ entity, pos: { x: SPATIAL_OFFSET + p.x * SPATIAL_SCALE, y: SPATIAL_OFFSET + p.y * SPATIAL_SCALE } }];
      });
    }
    return entities.map((entity, index) => ({ entity, pos: freePos(entity, index) }));
  }, [world, mode, layout]);

  const unplaced = useMemo(
    () => (mode === 'spatial' ? (world?.entities ?? []).filter((e) => spatialPosition(e) === null) : []),
    [world, mode],
  );

  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  // Snapshot of the last render's placeable tokens, to know where the departed stood.
  const lastPlaceable = useRef<Map<number, { icon: string; name: string; pos: Point }>>(new Map());
  // Invariant: ghosts render only for entities that left the *world* (despawn),
  // never for entities that merely left the current layout — e.g. a free→spatial
  // switch moves position-less entities to the unplaced tray; they stay alive
  // and must not ghost.
  useEffect(() => {
    if (mode === 'zones') {
      lastPlaceable.current = new Map();
      return;
    }
    const liveIds = new Set((world?.entities ?? []).map((e) => e.id));
    const current = new Map(
      placeable.map(({ entity, pos }) => [
        entity.id,
        { icon: zoneIcon(classifyEntity(entity)), name: displayName(entity), pos },
      ]),
    );
    const departed: Ghost[] = [];
    for (const [id, info] of lastPlaceable.current) {
      if (!current.has(id) && !liveIds.has(id)) departed.push({ id, ...info });
    }
    lastPlaceable.current = current;
    if (departed.length > 0) {
      const ids = new Set(departed.map((d) => d.id));
      // Replace any same-id ghost instead of appending a duplicate key.
      setGhosts((g) => [...g.filter((x) => !ids.has(x.id)), ...departed]);
      window.setTimeout(() => setGhosts((g) => g.filter((ghost) => !ids.has(ghost.id))), 500);
    }
  }, [placeable, mode, world]);

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

  const onTokenPointerDown = (e: ReactPointerEvent<HTMLElement>, entity: EntityState, index: number): void => {
    if (mode !== 'free') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      id: entity.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: freePos(entity, index),
    };
  };

  const onTokenPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next: Point = {
      x: drag.origin.x + (e.clientX - drag.startX) / view.zoom,
      y: drag.origin.y + (e.clientY - drag.startY) / view.zoom,
    };
    setLayout((l) => ({ ...l, [drag.id]: next }));
  };

  const onTokenPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (worldId !== undefined) {
      // Persist the position the drag ended on (state updates are async —
      // recompute from the ref origin + final pointer, same math as move).
      const finalPos: Point = {
        x: drag.origin.x + (e.clientX - drag.startX) / view.zoom,
        y: drag.origin.y + (e.clientY - drag.startY) / view.zoom,
      };
      setLayout((l) => {
        const next = { ...l, [drag.id]: finalPos };
        saveLayout(worldId, next, window.localStorage);
        return next;
      });
    }
  };

  const modes: LayoutMode[] = hasSpatial ? ['zones', 'free', 'spatial'] : ['zones', 'free'];

  return (
    <div className="world">
      <div className="world-toolbar">
        <div className="seg" role="group" aria-label="Layout mode">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
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
            ) : mode === 'zones' ? (
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
                            bubble={bubbles.get(entity.id) ?? null}
                            onSelect={onSelect}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="world-free">
                {placeable.map(({ entity, pos }, index) => (
                  <div
                    key={entity.id}
                    className={mode === 'free' ? 'world-place draggable' : 'world-place'}
                    style={{ left: pos.x, top: pos.y }}
                    onPointerDown={(e) => onTokenPointerDown(e, entity, index)}
                    onPointerMove={onTokenPointerMove}
                    onPointerUp={onTokenPointerUp}
                  >
                    <Token
                      entity={entity}
                      running={active.get(entity.id) ?? []}
                      selected={entity.id === state.selectedEntity}
                      bubble={bubbles.get(entity.id) ?? null}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
                {ghosts.map((ghost) => (
                  <div
                    key={`ghost-${ghost.id}`}
                    className="world-place world-ghost"
                    style={{ left: ghost.pos.x, top: ghost.pos.y }}
                  >
                    <span className="world-token-icon">{ghost.icon}</span>
                    <span className="world-token-name">{ghost.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {mode === 'spatial' && unplaced.length > 0 && (
            <div className="world-tray">
              <span className="world-tray-label">no position →</span>
              {unplaced.map((entity) => (
                <button key={entity.id} type="button" className="chip chip-comp" onClick={() => onSelect(entity.id)}>
                  {zoneIcon(classifyEntity(entity))} {displayName(entity)}
                </button>
              ))}
            </div>
          )}
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
