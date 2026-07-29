// @langecs/persist-fs — filesystem persistence adapter for LangECS worlds.
//
// Layout: <dir>/<worldId>/step-NNNNNN.json (one file per step boundary) plus
// <dir>/<worldId>/latest.json. All writes are atomic (tmp file + rename), so a
// reader never observes a partially-written snapshot. `history()`/`loadStep()`
// work from the directory listing; every read is tolerant of missing dirs.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistenceAdapter, Snapshot } from '@langecs/core';

export interface FsAdapterOptions {
  /** Root directory; one subdirectory per worldId. Created on first save. */
  dir: string;
}

/** `PersistenceAdapter` with `history`/`loadStep`/`fence` guaranteed (like core's `MemoryAdapter`). */
export interface FsAdapter extends PersistenceAdapter {
  save(snapshot: Snapshot): Promise<void>;
  load(worldId: string): Promise<Snapshot | null>;
  history(worldId: string): Promise<{ step: number; savedAt: number }[]>;
  loadStep(worldId: string, step: number): Promise<Snapshot | null>;
  fence(worldId: string, step: number): Promise<boolean>;
}

const STEP_FILE = /^step-(\d+)\.json$/;
const FENCE_FILE = /^fence-(\d+)\.lock$/;

const stepFileName = (step: number): string => `step-${String(step).padStart(6, '0')}.json`;
const fenceFileName = (step: number): string => `fence-${String(step).padStart(6, '0')}.lock`;

/** Highest step any writer has claimed in `worldDir`, or undefined if none (R57). */
async function highestFence(worldDir: string): Promise<number | undefined> {
  let names: string[];
  try {
    names = await readdir(worldDir);
  } catch (err) {
    if (isENOENT(err)) return undefined;
    throw err;
  }
  let highest: number | undefined;
  for (const name of names) {
    const match = FENCE_FILE.exec(name);
    if (match?.[1] === undefined) continue;
    const step = Number.parseInt(match[1], 10);
    if (highest === undefined || step > highest) highest = step;
  }
  return highest;
}

const isENOENT = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';

/** Write `data` to `<dir>/<name>` atomically: unique tmp file in the same dir, then rename. */
async function writeFileAtomic(dir: string, name: string, data: string): Promise<void> {
  // A random tmp name keeps concurrent saves (e.g. multiple workers sharing a
  // pid, or two worlds writing the same dir) from colliding on the tmp file
  // and racing the rename.
  const tmpPath = join(dir, `.${name}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, data, 'utf8');
  await rename(tmpPath, join(dir, name));
}

/** Step files in `worldDir`, sorted ascending by step. Missing dir -> []. */
async function listStepFiles(worldDir: string): Promise<{ step: number; name: string }[]> {
  let names: string[];
  try {
    names = await readdir(worldDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const steps: { step: number; name: string }[] = [];
  for (const name of names) {
    const match = STEP_FILE.exec(name);
    if (match?.[1] !== undefined) steps.push({ step: Number.parseInt(match[1], 10), name });
  }
  return steps.sort((a, b) => a.step - b.step);
}

/** Read + parse a snapshot file. Missing file -> null. */
async function readSnapshot(path: string): Promise<Snapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  return JSON.parse(raw) as Snapshot;
}

/**
 * Filesystem persistence adapter. The engine awaits `save` after every step
 * barrier and once at run end (R37), so each step boundary lands on disk as
 * `step-NNNNNN.json`; `latest.json` always mirrors the newest snapshot.
 *
 * Time travel: `createWorld()` + `world.use(...)` + `world.load(await adapter.loadStep(id, n))`.
 */
export function fsAdapter(options: FsAdapterOptions): FsAdapter {
  const root = options.dir;
  const worldDir = (worldId: string): string => join(root, worldId);

  return {
    async save(snapshot: Snapshot): Promise<void> {
      const dir = worldDir(snapshot.worldId);
      await mkdir(dir, { recursive: true });
      const data = JSON.stringify(snapshot);
      await writeFileAtomic(dir, stepFileName(snapshot.step), data);
      await writeFileAtomic(dir, 'latest.json', data);
    },

    async load(worldId: string): Promise<Snapshot | null> {
      const dir = worldDir(worldId);
      const latest = await readSnapshot(join(dir, 'latest.json'));
      if (latest) return latest;
      // latest.json absent (e.g. crash between the two writes): newest step file wins.
      const last = (await listStepFiles(dir)).at(-1);
      return last ? readSnapshot(join(dir, last.name)) : null;
    },

    async history(worldId: string): Promise<{ step: number; savedAt: number }[]> {
      const dir = worldDir(worldId);
      const steps = await listStepFiles(dir);
      return Promise.all(
        steps.map(async ({ step, name }) => {
          const info = await stat(join(dir, name));
          return { step, savedAt: Math.round(info.mtimeMs) };
        }),
      );
    },

    async loadStep(worldId: string, step: number): Promise<Snapshot | null> {
      const dir = worldDir(worldId);
      const match = (await listStepFiles(dir)).find((s) => s.step === step);
      return match ? readSnapshot(join(dir, match.name)) : null;
    },

    /**
     * Monotonic fence via exclusive create, then validate (R57).
     *
     * `wx` fails with EEXIST if the file exists, and that check-and-create is
     * atomic in the kernel — but only against an **identical filename**, i.e. an
     * identical step. Two workers claiming DIFFERENT steps never contend on the
     * name at all, so a plain read-then-write left them both granted: each read
     * the directory before the other wrote, saw nothing higher, and proceeded.
     *
     * So the order is inverted: create the lock first, then look around. If a
     * higher claim exists, this caller is stale — it withdraws its own lock and
     * loses. Concurrently or not, the highest step always wins, and exactly one
     * caller keeps its lock for any given step.
     *
     * One lock file per step (`fence-NNNNNN.lock`) rather than one mutable file,
     * because "claim step N" must refuse N and everything below it: the presence
     * of any lock at or above N is the refusal.
     */
    async fence(worldId: string, step: number): Promise<boolean> {
      const dir = worldDir(worldId);
      await mkdir(dir, { recursive: true });
      const name = fenceFileName(step);
      try {
        await writeFile(join(dir, name), String(step), { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        // EEXIST: this exact step is already claimed, by us or by someone else.
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
      const highest = await highestFence(dir);
      if (highest !== undefined && highest > step) {
        // Someone is further ahead: withdraw so we do not hold a claim we lost.
        await rm(join(dir, name), { force: true });
        return false;
      }
      return true;
    },
  };
}
