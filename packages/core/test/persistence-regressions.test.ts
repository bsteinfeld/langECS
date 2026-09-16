import { expect, test } from 'vitest';
import {
  createWorld,
  defineComponent,
  defineSystem,
  MemoryAdapter,
  type Snapshot,
} from '../src/index';

const Value = defineComponent<number>({ name: 'persistReview.Value' });

test('R55 external removal of a preserved name is persisted on an idle run', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'opaque-ext', persistence: adapter });
  const snapshot: Snapshot = {
    version: 1,
    worldId: world.id,
    step: 0,
    nextEntityId: 2,
    entities: [{ id: 1, components: { 'persistReview.LazyExternal': 42 } }],
    pendingPairs: [],
  };
  adapter.save(snapshot);
  world.load(snapshot, { strict: false });
  const Lazy = defineComponent<number>({ name: 'persistReview.LazyExternal' });
  world.entity(1)!.remove(Lazy);
  expect(world.snapshot().entities[0]!.components).not.toHaveProperty(Lazy.componentName);
  await world.run();
  expect(adapter.load(world.id)!.entities[0]!.components).not.toHaveProperty(Lazy.componentName);
});

test('R55 an in-system removal evicts the opaque value at commit', async () => {
  const world = createWorld();
  const snapshot: Snapshot = {
    version: 1,
    worldId: world.id,
    step: 0,
    nextEntityId: 2,
    entities: [{ id: 1, components: { 'persistReview.LazySystem': 42, [Value.componentName]: 1 } }],
    pendingPairs: [],
  };
  world.load(snapshot, { strict: false });
  const Lazy = defineComponent<number>({ name: 'persistReview.LazySystem' });
  world.use(defineSystem({ name: 'removeLazy', query: [Value], run: (e) => e.remove(Lazy) }));
  await world.run();
  expect(world.snapshot().entities[0]!.components).not.toHaveProperty(Lazy.componentName);
});

test('R58 newly registered pending work survives a zero-limit persisted boundary', async () => {
  const adapter = new MemoryAdapter();
  const world = createWorld({ id: 'new-system', persistence: adapter });
  world.spawn(Value(1));
  await world.run();
  world.use(defineSystem({ name: 'newWork', query: [Value], run: () => {} }));
  await world.run({ limit: 0 });
  expect(adapter.load(world.id)!.pendingPairs).toEqual(world.snapshot().pendingPairs);
});

test('R25/R55 a rejected barrier keeps an opaque removal pending and preserves the snapshot', async () => {
  const world = createWorld();
  world.load(
    {
      version: 1,
      worldId: world.id,
      step: 0,
      nextEntityId: 2,
      entities: [
        { id: 1, components: { 'persistReview.AtomicLazy': 42, [Value.componentName]: 1 } },
      ],
      pendingPairs: [],
    },
    { strict: false },
  );
  const Lazy = defineComponent<number>({ name: 'persistReview.AtomicLazy' });
  const Fragile = defineComponent<number>({
    name: 'persistReview.Fragile',
    reducer: () => {
      throw new Error('reject staging');
    },
  });
  world.entity(1)!.set(Fragile, 0);
  world.use(
    defineSystem({
      name: 'removeThenReject',
      query: [Value],
      run: (e) => {
        e.remove(Lazy);
        e.add(Fragile, 1);
      },
    }),
  );
  const before = world.snapshot();
  await expect(world.run()).rejects.toThrow('reject staging');
  expect(world.snapshot()).toEqual(before);
});

test('R57 the deferred ownership API is absent from the runtime surface', () => {
  expect(createWorld()).not.toHaveProperty('claim');
  expect(new MemoryAdapter()).not.toHaveProperty('fence');
});
