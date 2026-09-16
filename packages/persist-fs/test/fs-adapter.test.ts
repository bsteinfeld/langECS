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
