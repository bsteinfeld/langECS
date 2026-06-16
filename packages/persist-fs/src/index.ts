// @langecs/persist-fs — filesystem persistence adapter for LangECS worlds.
//
// Layout: <dir>/<worldId>/step-NNNNNN.json (one file per step boundary) plus
// <dir>/<worldId>/latest.json. All writes are atomic (tmp file + rename), so a
// reader never observes a partially-written snapshot. `history()`/`loadStep()`
// work from the directory listing; every read is tolerant of missing dirs.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistenceAdapter, Snapshot } from '@langecs/core';

export interface FsAdapterOptions {
  /** Root directory; one subdirectory per worldId. Created on first save. */
  dir: string;
}

/** `PersistenceAdapter` with `history`/`loadStep` guaranteed (like core's `MemoryAdapter`). */
export interface FsAdapter extends PersistenceAdapter {
  save(snapshot: Snapshot): Promise<void>;
  load(worldId: string): Promise<Snapshot | null>;
  history(worldId: string): Promise<{ step: number; savedAt: number }[]>;
  loadStep(worldId: string, step: number): Promise<Snapshot | null>;
}

const STEP_FILE = /^step-(\d+)\.json$/;

const stepFileName = (step: number): string => `step-${String(step).padStart(6, '0')}.json`;

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
  };
}
