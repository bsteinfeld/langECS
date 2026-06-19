import { expect, test } from 'vitest';
import type { ServerMessage } from '../src/protocol';
import { initialState, reducer, type State } from '../ui/src/store';

const helloWelcome: ServerMessage = {
  type: 'hello',
  protocol: 1,
  worldId: 'tour',
  welcome: true,
};

test('a welcome hello switches to the learn tab exactly once', () => {
  const afterFirst = reducer(initialState, { type: 'server', messages: [helloWelcome] });
  expect(afterFirst.tab).toBe('learn');
  expect(afterFirst.appliedWelcome).toBe(true);

  // User navigates away; a replayed hello (reconnect) must NOT yank them back.
  const navigated: State = { ...afterFirst, tab: 'inspector' };
  const afterReconnect = reducer(navigated, { type: 'server', messages: [helloWelcome] });
  expect(afterReconnect.tab).toBe('inspector');
});

test('a hello without welcome does not change the tab', () => {
  const hello: ServerMessage = { type: 'hello', protocol: 1, worldId: 'x' };
  const next = reducer(initialState, { type: 'server', messages: [hello] });
  expect(next.tab).toBe('inspector');
  expect(next.appliedWelcome).toBe(false);
});

test('highlight action sets and clears highlight', () => {
  const set = reducer(initialState, {
    type: 'highlight',
    highlight: { components: ['Chat'] },
  });
  expect(set.highlight).toEqual({ components: ['Chat'] });
  const cleared = reducer(set, { type: 'highlight', highlight: null });
  expect(cleared.highlight).toBeNull();
});
