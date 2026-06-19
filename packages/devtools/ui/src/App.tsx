// Shell: header bar, entity sidebar, tabbed main area, toast stack.

import { EntityList } from './components/EntityList';
import { EventsTab } from './components/EventsTab';
import { Header } from './components/Header';
import { InspectorTab } from './components/InspectorTab';
import { InterruptsTab } from './components/InterruptsTab';
import { LearnTab } from './components/LearnTab';
import { SystemsTab } from './components/SystemsTab';
import { TimelineTab } from './components/TimelineTab';
import { TimeTravelTab } from './components/TimeTravelTab';
import { Toasts } from './components/Toasts';
import { TracesTab } from './components/TracesTab';
import { type Tab, useStore } from './store';

const TABS: { id: Tab; label: string }[] = [
  { id: 'learn', label: '📖 Learn' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'systems', label: 'Systems' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
  { id: 'interrupts', label: 'Interrupts' },
  { id: 'timetravel', label: 'Time travel' },
];

function TabBody({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'learn':
      return <LearnTab />;
    case 'inspector':
      return <InspectorTab />;
    case 'systems':
      return <SystemsTab />;
    case 'timeline':
      return <TimelineTab />;
    case 'traces':
      return <TracesTab />;
    case 'events':
      return <EventsTab />;
    case 'interrupts':
      return <InterruptsTab />;
    case 'timetravel':
      return <TimeTravelTab />;
    default:
      return null;
  }
}

export function App() {
  const { state, dispatch } = useStore();
  const interruptCount = state.world?.interrupts.length ?? 0;

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <EntityList />
        <main className="main">
          <nav className="tabs" aria-label="Panels">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={state.tab === tab.id ? 'tab active' : 'tab'}
                aria-current={state.tab === tab.id ? 'page' : undefined}
                onClick={() => dispatch({ type: 'set-tab', tab: tab.id })}
              >
                {tab.label}
                {tab.id === 'interrupts' && interruptCount > 0 && (
                  <span className="tab-badge">{interruptCount}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            <TabBody tab={state.tab} />
          </div>
        </main>
      </div>
      <Toasts />
    </div>
  );
}
