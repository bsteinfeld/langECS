// buildWorldState — synchronous full-state capture for the `world` message.
import {
  createWorld,
  defineAgent,
  defineComponent,
  defineSystem,
  defineTag,
  interrupt,
} from '@langecs/core';
import { expect, test } from 'vitest';
import { buildWorldState } from '../src/state';

// Component names share one global registry per vitest process — prefix.
const Doc = defineComponent<string>({ name: 'dtstDoc' });
const Count = defineComponent<number>({ name: 'dtstCount', reducer: (a, b) => a + b });
const Scratch = defineComponent<unknown>({ name: 'dtstScratch', transient: true });
const Ready = defineTag('dtstReady');
const bot = defineAgent({ name: 'dtstBot' });

const finish = defineSystem({
  name: 'dtstFinish',
  query: [Doc],
  run: () => {},
});

test('captures entities, flags, agents, systems, components, resources, pending dirt', () => {
  const world = createWorld({ id: 'dtst-world' });
  world.use(finish);
  world.register('model:dtst', { fake: true });

  const e1 = world.spawn(Doc('hello'), Count(3), Ready(), bot);
  e1.set(Scratch, { temp: true });
  const e2 = world.spawn(interrupt('approval', { tool: 'search' }, 'dtst-int-1'));

  const state = buildWorldState(world, [1, 2, 3]);

  expect(state.worldId).toBe('dtst-world');
  expect(state.step).toBe(0);
  expect(state.running).toBe(false);
  expect(state.historySteps).toEqual([1, 2, 3]);

  expect(state.entities.map((e) => e.id)).toEqual([e1.id, e2.id]);
  const first = state.entities[0]!;
  expect(first.agents).toEqual(['dtstBot']);

  const byName = new Map(first.components.map((c) => [c.name, c]));
  expect(byName.get('dtstDoc')).toEqual({
    name: 'dtstDoc',
    value: 'hello',
    tag: false,
    reducer: false,
    transient: false,
  });
  expect(byName.get('dtstCount')).toMatchObject({ value: 3, reducer: true });
  expect(byName.get('dtstReady')).toMatchObject({ value: true, tag: true });
  // The agent auto-tag is a real component — present in the list too.
  expect(byName.get('agent:dtstBot')).toMatchObject({ tag: true });
  // Transient components are snapshot-excluded but VISIBLE live state.
  expect(byName.get('dtstScratch')).toMatchObject({ value: { temp: true }, transient: true });

  expect(state.systems.map((s) => s.key)).toContain('dtstFinish');
  expect(state.components.map((c) => c.name)).toContain('dtstDoc');
  expect(state.resources).toContain('model:dtst');

  // Spawn marked the (system, entity) pair dirty; no run yet, so it's pending.
  expect(state.pendingPairs).toContainEqual({
    entity: e1.id,
    system: 'dtstFinish',
    reason: 'new-match',
  });

  expect(state.interrupts).toEqual([
    {
      entity: e2.id,
      interrupts: [{ id: 'dtst-int-1', kind: 'approval', payload: { tool: 'search' } }],
    },
  ]);
});

test('historySteps null passes through when no history adapter is wired', () => {
  const world = createWorld({ id: 'dtst-nohist' });
  expect(buildWorldState(world, null).historySteps).toBeNull();
});

test('JSON-hostile values degrade to $unserializable instead of breaking the message', () => {
  const world = createWorld({ id: 'dtst-hostile' });
  const e = world.spawn(Doc('x'));
  // External writes are stored by reference (no clone), and transient
  // components never hit snapshot serialization — so a circular value can
  // legally live in the world (R3 only binds snapshot-able components).
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  e.set(Scratch, circular);

  const state = buildWorldState(world, null);
  const scratch = state.entities[0]!.components.find((c) => c.name === 'dtstScratch');
  expect(scratch?.value).toEqual({ $unserializable: expect.stringContaining('circular') });

  // BigInt is the other classic JSON-hostile value.
  e.set(Scratch, BigInt(7));
  const again = buildWorldState(world, null);
  const scratch2 = again.entities[0]!.components.find((c) => c.name === 'dtstScratch');
  expect(scratch2?.value).toEqual({ $unserializable: expect.stringContaining('BigInt') });

  // The healthy component on the same entity still serializes normally.
  expect(again.entities[0]!.components.find((c) => c.name === 'dtstDoc')?.value).toBe('x');
});
