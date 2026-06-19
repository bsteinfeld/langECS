// The guided 📖 Learn tab: walks LEARN_STEPS over the tour world, driving the
// rest of the inspector via "Show me" (select entity + switch tab + pulse) and a
// one-click "send a message" action. Pure consumer of the store + existing
// commands — it never mutates the world directly (R16).

import { useState } from 'react';
import { LEARN_STEPS, type LearnStep } from '../learn-steps';
import { useStore } from '../store';

const HIGHLIGHT_MS = 2500;

function StepNav({ index, count, onPrev, onNext }: {
  index: number;
  count: number;
  onPrev(): void;
  onNext(): void;
}) {
  return (
    <div className="learn-nav">
      <button type="button" className="btn" disabled={index === 0} onClick={onPrev}>
        ◀ Back
      </button>
      <span className="learn-progress">
        Step {index + 1} of {count}
      </span>
      <button type="button" className="btn btn-accent" disabled={index === count - 1} onClick={onNext}>
        Next ▶
      </button>
    </div>
  );
}

export function LearnTab() {
  const { state, dispatch, command } = useStore();
  const [index, setIndex] = useState(0);
  // index is always clamped to [0, LEARN_STEPS.length - 1] by the nav callbacks.
  // biome-ignore lint/style/noNonNullAssertion: index is always in-range
  const step: LearnStep = LEARN_STEPS[index]!;
  const world = state.world;

  const pulse = (highlight: { components?: string[]; system?: string }): void => {
    dispatch({ type: 'highlight', highlight });
    window.setTimeout(() => dispatch({ type: 'highlight', highlight: null }), HIGHLIGHT_MS);
  };

  const showMe = (): void => {
    const sm = step.showMe;
    if (!sm || !world) return;
    if (sm.find) {
      const id = sm.find(world);
      if (id !== undefined) dispatch({ type: 'select-entity', entity: id });
    }
    dispatch({ type: 'set-tab', tab: sm.tab });
    if (sm.highlightComponents) pulse({ components: sm.highlightComponents });
    else if (sm.highlightSystem) pulse({ system: sm.highlightSystem });
  };

  const runAction = async (): Promise<void> => {
    const act = step.action;
    if (!act || !world) return;
    const id = act.find(world);
    if (id === undefined) return;
    await command({ type: 'send', entity: id, components: act.components });
  };

  // "Show me" can only resolve its target when the matching entity is present.
  const showMeReady =
    step.showMe !== undefined &&
    world !== null &&
    (step.showMe.find === undefined || step.showMe.find(world) !== undefined);
  const actionReady = step.action !== undefined && world !== null && step.action.find(world) !== undefined;

  return (
    <div className="learn">
      <div className="learn-card">
        <h2 className="learn-title">{step.title}</h2>
        <p className="learn-body">{step.body}</p>
        <div className="learn-actions">
          {step.showMe && (
            <button
              type="button"
              className="btn"
              disabled={!showMeReady}
              title={showMeReady ? undefined : 'Run `pnpm -C examples tour` to see this exhibit.'}
              onClick={showMe}
            >
              Show me ▶
            </button>
          )}
          {step.action && (
            <button
              type="button"
              className="btn btn-accent"
              disabled={!actionReady || state.world?.running === true}
              onClick={() => void runAction()}
            >
              {step.action.label}
            </button>
          )}
        </div>
      </div>
      <StepNav
        index={index}
        count={LEARN_STEPS.length}
        onPrev={() => setIndex((i) => Math.max(0, i - 1))}
        onNext={() => setIndex((i) => Math.min(LEARN_STEPS.length - 1, i + 1))}
      />
    </div>
  );
}
