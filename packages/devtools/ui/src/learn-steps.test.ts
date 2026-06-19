import { expect, test } from 'vitest';
import type { WorldState } from '../../src/protocol';
import { byAgent, byComponent, LEARN_STEPS } from './learn-steps';
import type { Tab } from './store';

const VALID_TABS: Tab[] = [
  'learn',
  'inspector',
  'systems',
  'timeline',
  'traces',
  'events',
  'interrupts',
  'timetravel',
];

test('steps are well-formed and uniquely identified', () => {
  expect(LEARN_STEPS.length).toBeGreaterThanOrEqual(8);
  const ids = new Set<string>();
  for (const step of LEARN_STEPS) {
    expect(step.id).toBeTruthy();
    expect(step.title).toBeTruthy();
    expect(step.body).toBeTruthy();
    expect(ids.has(step.id)).toBe(false);
    ids.add(step.id);
    if (step.showMe) expect(VALID_TABS).toContain(step.showMe.tab);
  }
});

test('component/agent predicates resolve against a tour-shaped world', () => {
  // Minimal WorldState fixture mirroring the tour exhibits.
  const world = {
    worldId: 'tour',
    step: 2,
    running: false,
    entities: [
      { id: 1, agents: ['greeter'], components: [{ name: 'Chat' }, { name: 'WaitingReply' }] },
      {
        id: 2,
        agents: ['support'],
        components: [{ name: 'PromptRef' }, { name: 'RenderedPrompt' }],
      },
      { id: 3, agents: [], components: [{ name: 'eval:Score' }, { name: 'eval:Verdict' }] },
    ],
  } as unknown as WorldState;

  expect(byComponent('Chat')(world)).toBe(1);
  expect(byAgent('support')(world)).toBe(2);
  expect(byComponent('eval:Verdict')(world)).toBe(3);
  expect(byComponent('does-not-exist')(world)).toBeUndefined();
});
