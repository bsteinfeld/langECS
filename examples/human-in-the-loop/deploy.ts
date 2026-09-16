// Two deployments of the same app, so the example can show what happens when you
// ship a component rename while somebody's world is paused awaiting approval.
//
// This is the failure the persistence story lives or dies on: quiescence IS the
// pause, so a world can sit parked for a day — and `world.load` throws on any
// component name it cannot resolve. Deploy a rename in between and that world is
// permanently unloadable.
//
// Both vocabularies are defined here because component names are process-global
// (R7): a single test process plays both deployments, so it must know both names.
// In production each name exists only in the build that owns it.

import {
  AwaitingHuman,
  defineComponent,
  defineSystem,
  type Migration,
  Not,
  type World,
} from '@langecs/core';

/** v1 vocabulary: the app stamps a review note when an approval is raised. */
export const ReviewerNote = defineComponent<{ raisedAtStep: number; queue: string }>({
  name: 'hitl.ReviewerNote',
});

/** v2 vocabulary: same data, renamed — the deploy that breaks paused worlds. */
export const ApproverNote = defineComponent<{ raisedAtStep: number; queue: string }>({
  name: 'hitl.ApproverNote',
});

export const RECIPE_V1 = 1;
export const RECIPE_V2 = 2;

/** v1: writes the old component under the old system name. */
export const attachReviewerNote = defineSystem({
  name: 'attachReviewerNote',
  query: [AwaitingHuman, Not(ReviewerNote)],
  run: (e, ctx) => {
    e.set(ReviewerNote, { raisedAtStep: ctx.step, queue: 'records-review' });
  },
});

/** v2: same behavior, new component name and new system name. */
export const attachApproverNote = defineSystem({
  name: 'attachApproverNote',
  query: [AwaitingHuman, Not(ApproverNote)],
  run: (e, ctx) => {
    e.set(ApproverNote, { raisedAtStep: ctx.step, queue: 'records-review' });
  },
});

/**
 * The one-to-two migration. Renames the component on every entity, and renames
 * the system in any outstanding dirt — `pendingPairs` reference systems by key,
 * so a renamed system leaves dirt pointing at a name that no longer resolves.
 * Forgetting that second loop is the classic mistake.
 */
export const renameReviewerToApprover: Migration = (snapshot) => {
  for (const entity of snapshot.entities) {
    if (ReviewerNote.componentName in entity.components) {
      entity.components[ApproverNote.componentName] = entity.components[ReviewerNote.componentName];
      delete entity.components[ReviewerNote.componentName];
    }
  }
  for (const pair of snapshot.pendingPairs) {
    if (pair.system === attachReviewerNote.name) pair.system = attachApproverNote.name;
  }
  return snapshot;
};

/** Registers the v2 world's migration chain. Call before `load`. */
export function installMigrations(world: World): void {
  world.migration(RECIPE_V1, RECIPE_V2, renameReviewerToApprover);
}
