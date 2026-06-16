// Systems table: effective queries, client-side matched counts, pending dirt
// (who fires next and why) and last flight-recorder activity per system.

import type { PendingPair } from '@langecs/core';
import { Fragment, useMemo, useState } from 'react';
import { formatMs } from '../format';
import { lastRunBySystem, matchedEntities, runStatsBySystem, useStore } from '../store';
import { EmptyState } from './EmptyState';
import { AlertIcon, ChevronIcon } from './icons';

export function SystemsTab() {
  const { state, dispatch } = useStore();
  const world = state.world;
  const [expanded, setExpanded] = useState<string | null>(null);

  const matches = useMemo(() => {
    const map = new Map<string, number[]>();
    if (world) for (const sys of world.systems) map.set(sys.key, matchedEntities(world, sys));
    return map;
  }, [world]);

  const pendingBySystem = useMemo(() => {
    const map = new Map<string, PendingPair[]>();
    for (const pair of world?.pendingPairs ?? []) {
      const list = map.get(pair.system);
      if (list) list.push(pair);
      else map.set(pair.system, [pair]);
    }
    return map;
  }, [world]);

  const lastRuns = useMemo(() => lastRunBySystem(state.trace), [state.trace]);
  const runStats = useMemo(() => runStatsBySystem(state.trace), [state.trace]);

  if (!world || world.systems.length === 0) {
    return (
      <EmptyState
        title="No systems registered"
        hint="Register systems with world.use(...) or spawn an agent — they appear here in registration order."
      />
    );
  }

  const inspect = (id: number): void => {
    dispatch({ type: 'select-entity', entity: id });
    dispatch({ type: 'set-tab', tab: 'inspector' });
  };

  return (
    <div className="systems">
      <table className="table">
        <thead>
          <tr>
            <th aria-label="Expand" />
            <th>System</th>
            <th>Query</th>
            <th className="num">Matched</th>
            <th className="num">Dirty</th>
            <th className="num">Runs</th>
            <th>Last run</th>
          </tr>
        </thead>
        <tbody>
          {world.systems.map((sys) => {
            const matched = matches.get(sys.key) ?? [];
            const pending = pendingBySystem.get(sys.key) ?? [];
            const last = lastRuns.get(sys.key);
            const stats = runStats.get(sys.key);
            const open = expanded === sys.key;
            return (
              <Fragment key={sys.key}>
                <tr className={open ? 'sys-row open' : 'sys-row'}>
                  <td className="sys-expand">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={open ? `Collapse ${sys.key}` : `Expand ${sys.key}`}
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : sys.key)}
                    >
                      <ChevronIcon open={open} />
                    </button>
                  </td>
                  <td>
                    <span className="sys-key">{sys.key}</span>
                    {sys.agent !== undefined && (
                      <span className="badge badge-agent">{sys.agent}</span>
                    )}
                    {sys.hasGuard && <span className="guard-dot" title="Has a when() guard" />}
                  </td>
                  <td>
                    <span className="query-chips">
                      {sys.query.include.map((name) => (
                        <span key={name} className="chip chip-include">
                          {name}
                        </span>
                      ))}
                      {sys.query.exclude.map((name) => (
                        <span key={name} className="chip chip-exclude">
                          Not: {name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="num">{matched.length}</td>
                  <td className="num">
                    {pending.length > 0 ? (
                      <span className="dirty-count">{pending.length}</span>
                    ) : (
                      <span className="dim">0</span>
                    )}
                  </td>
                  <td className="num">
                    {stats ? (
                      <span title={`${stats.runCount} run(s) in the retained trace`}>
                        {stats.runCount}
                        {stats.errorCount > 0 && (
                          <span className="err-count" title={`${stats.errorCount} errored`}>
                            {' '}
                            ✕{stats.errorCount}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="dim">0</span>
                    )}
                  </td>
                  <td>
                    {last ? (
                      <span className="last-run">
                        {last.error && (
                          <span className="err-icon" title="Last run errored">
                            <AlertIcon size={11} />
                          </span>
                        )}
                        <span className="mono">{formatMs(last.ms)}</span>
                        <span className="dim"> @ step {last.step}</span>
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr className="sys-detail">
                    <td />
                    <td colSpan={5}>
                      <div className="sys-detail-block">
                        <div className="sys-detail-label">Matched entities</div>
                        {matched.length === 0 ? (
                          <span className="dim">none</span>
                        ) : (
                          <div className="sys-detail-chips">
                            {matched.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="chip chip-entity"
                                onClick={() => inspect(id)}
                              >
                                #{id}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="sys-detail-label">Pending pairs</div>
                        {pending.length === 0 ? (
                          <span className="dim">none — fires only on new dirt</span>
                        ) : (
                          <ul className="sys-pending">
                            {pending.map((pair) => (
                              <li key={`${pair.entity}:${pair.reason}`}>
                                <button
                                  type="button"
                                  className="chip chip-entity"
                                  onClick={() => inspect(pair.entity)}
                                >
                                  #{pair.entity}
                                </button>
                                <span className="dim"> {pair.reason}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
