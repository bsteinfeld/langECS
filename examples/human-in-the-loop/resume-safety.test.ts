// The operational sequel to kill-and-resume: what happens when the deploy that
// resumes a paused world is not the same build that paused it.
//
// Zero network — the model is core's scriptedModel. The "deploy" is a second
// world built from a renamed vocabulary, using the kill-and-resume adapter.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, type Snapshot, scriptedModel, type World } from '@langecs/core';
import { type FsAdapter, fsAdapter } from '@langecs/persist-fs';
import { registerTools } from '@langecs/stdlib';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MODEL_RESOURCE, recordsAgent, recordTools, WORLD_ID } from './agent';
import {
  ApproverNote,
  attachApproverNote,
  attachReviewerNote,
  installMigrations,
  RECIPE_V1,
  RECIPE_V2,
  ReviewerNote,
} from './deploy';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'langecs-resume-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DELETE_CALL = { id: 'call-1', name: 'delete_record', args: { id: 42 } };

/** Deployment v1: the build that takes the request and parks it awaiting approval. */
function deployV1(adapter: FsAdapter): World {
  const world = createWorld({ id: WORLD_ID, persistence: adapter, recipeVersion: RECIPE_V1 });
  world.use(recordsAgent);
  world.use(attachReviewerNote);
  world.register(
    MODEL_RESOURCE,
    scriptedModel([{ role: 'assistant', content: '', toolCalls: [DELETE_CALL] }]),
  );
  registerTools(world, recordTools());
  return world;
}

/** Deployment v2: renamed vocabulary. `migrate: false` is the deploy that forgot. */
function deployV2(
  adapter: FsAdapter,
  opts?: { migrate?: boolean },
): {
  world: World;
  deletions: number[];
} {
  const deletions: number[] = [];
  const world = createWorld({
    id: WORLD_ID,
    persistence: adapter,
    recipeVersion: RECIPE_V2,
  });
  world.use(recordsAgent);
  world.use(attachApproverNote);
  if (opts?.migrate !== false) installMigrations(world);
  world.register(
    MODEL_RESOURCE,
    scriptedModel([{ role: 'assistant', content: 'Record 42 is gone.' }]),
  );
  registerTools(
    world,
    recordTools((id) => deletions.push(id)),
  );
  return { world, deletions };
}

/** Drives v1 to the pending boundary and returns the snapshot from disk. */
async function parkedSnapshot(adapter: FsAdapter): Promise<{ snapshot: Snapshot; agent: number }> {
  const world = deployV1(adapter);
  const agent = world.spawn(recordsAgent);
  const { sendMessage } = await import('@langecs/stdlib');
  const result = await sendMessage(world, agent, 'Delete record 42.');
  expect(result.status).toBe('pending');
  // The app's own component was stamped alongside the interrupt, under its v1 name.
  expect(world.entity(agent.id)?.get(ReviewerNote)).toMatchObject({ queue: 'records-review' });
  const snapshot = await adapter.load(WORLD_ID);
  if (snapshot === null) throw new Error('expected a parked snapshot on disk');
  expect(snapshot.recipeVersion).toBe(RECIPE_V1);
  return { snapshot, agent: agent.id };
}

test('a rename deployed while a world is paused makes it unloadable — and canLoad says so first', async () => {
  const adapter = fsAdapter({ dir });
  const { snapshot } = await parkedSnapshot(adapter);

  // The deploy that forgot the migration. This is the production failure: the
  // approval is sitting on disk, and the new build cannot read it.
  const forgot = deployV2(adapter, { migrate: false });
  const check = forgot.world.canLoad(snapshot);
  expect(check.ok).toBe(false);
  if (!check.ok) expect(check.missingMigration).toEqual({ from: RECIPE_V1, to: RECIPE_V2 });
  expect(() => forgot.world.load(snapshot)).toThrow(/No migration path/);

  // canLoad is the deploy gate: run it over your paused worlds in CI and the
  // rename fails the build, rather than failing the user who paused it. It has
  // no side effects, so asking is free.
  expect(forgot.world.step).toBe(0);
  expect(forgot.world.query().length).toBe(0);
});

test('with a migration, the paused approval survives the rename and completes', async () => {
  const adapter = fsAdapter({ dir });
  const { snapshot, agent } = await parkedSnapshot(adapter);

  const next = deployV2(adapter);
  expect(next.world.canLoad(snapshot)).toEqual({ ok: true });
  const report = next.world.load(snapshot);

  // Migrated on the way in, before any name was resolved — which is the only
  // reason a build that no longer defines `hitl.ReviewerNote` can read this.
  expect(report.migrated).toEqual([{ from: RECIPE_V1, to: RECIPE_V2 }]);
  expect(next.world.entity(agent)?.has(ReviewerNote)).toBe(false);
  expect(next.world.entity(agent)?.get(ApproverNote)).toMatchObject({ queue: 'records-review' });

  // The interrupt itself came through untouched, so the human can still answer.
  expect(next.world.pending()).toEqual([
    { entity: agent, interrupts: [expect.objectContaining({ kind: 'tool-approval' })] },
  ]);

  const result = await next.world.resume(agent, true);
  expect(result.status).toBe('done');
  expect(next.deletions).toEqual([42]); // approved once, executed once, in the new build

  // And the world is written back at the new version, so the migration runs once
  // and never again.
  expect(next.world.snapshot().recipeVersion).toBe(RECIPE_V2);
});

test('expectedStep catches a resume that read a stale snapshot, with no adapter involved', async () => {
  const adapter = fsAdapter({ dir });
  const { snapshot, agent } = await parkedSnapshot(adapter);

  // A worker advances the world…
  const winner = deployV2(adapter);
  winner.world.load(snapshot);
  await winner.world.resume(agent, true);
  const advanced = await adapter.load(WORLD_ID);

  // …and a second worker is still holding the snapshot it read before that.
  const late = deployV2(adapter);
  expect(() => late.world.load(snapshot, { expectedStep: advanced?.step })).toThrow(
    /Snapshot is at step \d+, but step \d+ was expected/,
  );
});
