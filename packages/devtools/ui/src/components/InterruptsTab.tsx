// Human-in-the-loop: one card per entity with pending AwaitingHuman records
// (R33). Resume writes HumanResponse({ value }) and starts a run.

import type { InterruptRecord } from '@langecs/core';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { EmptyState } from './EmptyState';
import { HandIcon } from './icons';
import { JsonInput, JsonTree, parseJson } from './JsonTree';

function InterruptCard({ entity, interrupts }: { entity: number; interrupts: InterruptRecord[] }) {
  const { state, command, dispatch } = useStore();
  const [text, setText] = useState('null');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseJson(text), [text]);
  const running = state.world?.running === true;

  const resume = async (): Promise<void> => {
    if (!parsed.ok || busy) return;
    setBusy(true);
    await command({ type: 'resume', entity, value: parsed.value });
    setBusy(false);
  };

  return (
    <section className="card interrupt-card">
      <div className="card-head">
        <span className="badge badge-hand">
          <HandIcon size={11} />
        </span>
        <button
          type="button"
          className="card-title card-title-link"
          onClick={() => {
            dispatch({ type: 'select-entity', entity });
            dispatch({ type: 'set-tab', tab: 'inspector' });
          }}
        >
          Entity #{entity}
        </button>
        <span className="dim">
          {interrupts.length} interrupt{interrupts.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="card-body">
        {interrupts.map((record) => (
          <div key={record.id} className="interrupt-record">
            <div className="interrupt-record-head">
              <span className="chip chip-kind">{record.kind}</span>
              <span className="dim mono">{record.id}</span>
            </div>
            {record.payload !== undefined && <JsonTree value={record.payload} openDepth={2} />}
          </div>
        ))}
        <div className="interrupt-resume">
          <JsonInput label="Response value (JSON)" text={text} onText={setText} rows={3} />
          <button
            type="button"
            className="btn btn-accent"
            disabled={!parsed.ok || busy || running || state.status !== 'open'}
            onClick={() => void resume()}
          >
            Resume
          </button>
        </div>
        <div className="hint">
          Resume writes <code>HumanResponse({'{ value }'})</code> to this entity and runs — systems
          consume it with <code>remove()</code>.
        </div>
      </div>
    </section>
  );
}

export function InterruptsTab() {
  const { state } = useStore();
  const interrupts = state.world?.interrupts ?? [];

  if (interrupts.length === 0) {
    return (
      <EmptyState
        title="No interrupts pending"
        hint="Systems request human input by appending AwaitingHuman records (R33); a run that stops on them reports status 'pending' until you resume each entity with a value."
      />
    );
  }

  return (
    <div className="interrupts">
      {interrupts.map((item) => (
        <InterruptCard key={item.entity} entity={item.entity} interrupts={item.interrupts} />
      ))}
    </div>
  );
}
