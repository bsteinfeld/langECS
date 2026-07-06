// A tiny world to explore in DevTools — a few entities, a few data-only
// components, no systems. Nothing runs; it just sits idle for you to poke at.
//
// Run with: pnpm -C examples exec tsx playground/main.ts   (no API key needed)

import { type ComponentType, createWorld, defineComponent } from '@langecs/core';
import { startDevtools } from '@langecs/devtools';

// Three data-only components (R3: plain JSON, no behavior). Component names are
// globally unique (R7), so we pick names nothing else in this world uses.
const Name: ComponentType<string> = defineComponent<string>({ name: 'Name' });

interface PositionData {
  x: number;
  y: number;
}
const Position: ComponentType<PositionData> = defineComponent<PositionData>({ name: 'Position' });

interface HealthData {
  hp: number;
  max: number;
}
const Health: ComponentType<HealthData> = defineComponent<HealthData>({ name: 'Health' });

const world = createWorld({ id: 'playground' });

// A couple of entities. They deliberately differ — Chest has no Health — so you
// can see that entities are just whatever components they happen to carry.
world.spawn(Name('Alice'), Position({ x: 0, y: 0 }), Health({ hp: 100, max: 100 }));
world.spawn(Name('Bob'), Position({ x: 5, y: 3 }), Health({ hp: 72, max: 100 }));
world.spawn(Name('Chest'), Position({ x: 10, y: 8 }));

const server = await startDevtools(world);

console.log(`
  LangECS DevTools (playground) ➜  ${server.url}

  3 entities, 3 components (Name, Position, Health) — all data-only, no systems.
  You land on the 🌍 World tab: Alice, Bob and the Chest as tokens. Try the
  Spatial layout — this world has real Position coordinates. Then:
    • Click a token to read its components as JSON trees.
    • Edit a value (e.g. Bob's Health.hp) — the change goes through the engine's
      idle-only external-mutation API (R16), not a back door.
    • Add a component to Chest, or despawn an entity, and watch the scene update.
  (Systems / Timeline / Traces tabs are empty by design — nothing is running.)

  Ctrl+C to exit.
`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
