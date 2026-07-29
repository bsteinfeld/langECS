import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, defineComponent, defineSystem } from '@langecs/core';
import { afterAll, expect, test } from 'vitest';
import { fsAdapter } from '../src/index';

// ------------------------------------------------------------------ fixtures

const tmpDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'langecs-persist-fs-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const append = <T>(a: T[], b: T[]): T[] => [...a, ...b];
const Input = defineComponent<string[]>({ name: 'pfsInput', reducer: append });
const Output = defineComponent<string[]>({ name: 'pfsOutput', reducer: append });
// The canonical Inbox pattern: each new Input appends `<last>-echo` to Output.
const echo = defineSystem({
  name: 'pfsEcho',
  query: [Input],
  run: (e) => {
    e.add(Output, [`${e.get(Input).at(-1)}-echo`]);
  },
});

// --------------------------------------------------------------------- tests

test('snapshot/save/load roundtrip drives a real world through steps and resumes', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  const world = createWorld({ id: 'w1', persistence: adapter });
  world.use(echo);
  const e = world.spawn(Input(['a']));
  const r1 = await world.run();
  expect(r1.status).toBe('done');
  await world.send(e, Input(['b']));
  expect(e.get(Output)).toEqual(['a-echo', 'b-echo']);

  // On-disk layout: one step file per boundary + latest.json, no tmp leftovers.
  const files = (await readdir(join(dir, 'w1'))).sort();
  expect(files).toEqual(['latest.json', 'step-000001.json', 'step-000002.json']);

  // latest.json reflects the newest boundary and is a valid core snapshot.
  const snap = await adapter.load('w1');
  expect(snap).not.toBeNull();
  expect(snap?.worldId).toBe('w1');
  expect(snap?.step).toBe(2);

  // A fresh world resumes from it identically and keeps going.
  const world2 = createWorld({ id: 'w1' });
  world2.use(echo);
  world2.load(snap!);
  expect(world2.step).toBe(2);
  expect(world2.entity(e.id)?.get(Output)).toEqual(['a-echo', 'b-echo']);
  await world2.send(e.id, Input(['c']));
  expect(world2.entity(e.id)?.get(Output)).toEqual(['a-echo', 'b-echo', 'c-echo']);
});

test('history lists steps in ascending order with savedAt timestamps', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  const world = createWorld({ id: 'hist', persistence: adapter });
  world.use(echo);
  const e = world.spawn(Input(['1']));
  await world.run();
  await world.send(e, Input(['2']));
  await world.send(e, Input(['3']));

  const history = await adapter.history('hist');
  expect(history.map((h) => h.step)).toEqual([1, 2, 3]);
  for (const entry of history) {
    expect(typeof entry.savedAt).toBe('number');
    expect(entry.savedAt).toBeGreaterThan(0);
  }
  // Each step file is loadable on its own.
  expect((await adapter.loadStep('hist', 2))?.step).toBe(2);
});

test('loadStep forks the timeline at an earlier step (time travel)', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  const world = createWorld({ id: 'tt', persistence: adapter });
  world.use(echo);
  const e = world.spawn(Input(['a']));
  await world.send(e, Input(['b']));
  await world.send(e, Input(['c']));
  expect(e.get(Output)).toEqual(['b-echo', 'c-echo']);

  const snap1 = await adapter.loadStep('tt', 1);
  expect(snap1).not.toBeNull();
  const fork = createWorld({ id: 'tt-fork' });
  fork.use(echo);
  fork.load(snap1!);
  expect(fork.step).toBe(1);
  await fork.send(e.id, Input(['z']));

  // Divergent states; the original timeline (memory and disk) is untouched.
  expect(fork.entity(e.id)?.get(Output)).toEqual(['b-echo', 'z-echo']);
  expect(fork.entity(e.id)?.get(Input)).toEqual(['a', 'b', 'z']);
  expect(e.get(Output)).toEqual(['b-echo', 'c-echo']);
  expect((await adapter.load('tt'))?.step).toBe(2);

  // Unknown step -> null.
  expect(await adapter.loadStep('tt', 99)).toBeNull();
});

test('tolerates missing directories', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir: join(dir, 'does-not-exist') });
  expect(await adapter.load('ghost')).toBeNull();
  expect(await adapter.history('ghost')).toEqual([]);
  expect(await adapter.loadStep('ghost', 1)).toBeNull();
});

test('load falls back to the newest step file when latest.json is missing', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  const world = createWorld({ id: 'fb', persistence: adapter });
  world.use(echo);
  const e = world.spawn(Input(['a']));
  await world.run();
  await world.send(e, Input(['b']));

  await rm(join(dir, 'fb', 'latest.json'));
  const snap = await adapter.load('fb');
  expect(snap?.step).toBe(2);
  expect(snap?.worldId).toBe('fb');
});

test('fence grants a step once and refuses that step or lower (R57)', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  expect(await adapter.fence('fenced', 3)).toBe(true);
  // The same step twice is a refusal: two workers resuming one snapshot both
  // want to write the same next step, and only one may.
  expect(await adapter.fence('fenced', 3)).toBe(false);
  // Anything at or below a claimed step is stale.
  expect(await adapter.fence('fenced', 2)).toBe(false);
  // Forward progress by the winner is still allowed.
  expect(await adapter.fence('fenced', 4)).toBe(true);
  // Fencing is per world id.
  expect(await adapter.fence('other', 1)).toBe(true);
});

test('fence resolves a concurrent race to exactly one winner (R57)', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  // `wx` is atomic, but only against an identical filename — so this covers
  // same-step contention only. The different-step case is the one that actually
  // bit us, and it is the next test.
  const results = await Promise.all(Array.from({ length: 8 }, () => adapter.fence('stampede', 1)));
  expect(results.filter(Boolean)).toHaveLength(1);
});

test('a fenced world stops rather than diverge, and the winner keeps its history', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  const seed = createWorld({ id: 'race', persistence: adapter });
  seed.use(echo);
  seed.spawn(Input(['seed']));
  await seed.run();
  const shared = await adapter.load('race');
  if (shared === null) throw new Error('expected a seeded snapshot');

  const worker = () => {
    const w = createWorld({ id: 'race', persistence: adapter, fence: true });
    w.use(echo);
    w.load(shared);
    w.query(Input)[0]?.add(Input, ['contended']);
    return w;
  };
  const [a, b] = await Promise.allSettled([worker().run(), worker().run()]);

  expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
  const loser = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
  expect((loser.reason as Error).name).toBe('FenceError');

  // Exactly one snapshot exists for the contended step — no interleaved timeline
  // on disk, which is the whole point.
  const history = await adapter.history('race');
  expect(history.filter((h) => h.step === shared.step + 1)).toHaveLength(1);
});

test('fence refuses a lower step raced against a higher one (R57)', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  // The case a read-then-write fence silently allowed: two workers at DIFFERENT
  // steps never contend on the lock filename, so each read the directory before
  // the other wrote and both were granted — two divergent timelines, no error.
  const [lower, higher] = await Promise.all([adapter.fence('race', 8), adapter.fence('race', 9)]);
  expect({ lower, higher }).toEqual({ lower: false, higher: true });

  // The winner keeps its claim and can move forward; the loser stays refused.
  expect(await adapter.fence('race', 10)).toBe(true);
  expect(await adapter.fence('race', 8)).toBe(false);
});

test('fence withdraws a lost claim rather than holding it (R57)', async () => {
  const dir = await makeDir();
  const adapter = fsAdapter({ dir });

  await Promise.all([adapter.fence('w', 3), adapter.fence('w', 7)]);
  // The loser must not leave a lock behind, or step 3 would look claimed to a
  // later legitimate caller and the directory would accrue phantom claims.
  expect(await adapter.fence('w', 3)).toBe(false); // still refused (7 is ahead)
  expect(await adapter.fence('w', 8)).toBe(true);
});
