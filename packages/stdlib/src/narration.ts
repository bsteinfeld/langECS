// Narration components (R64): what the world would say it is doing, as data.
//
// The experiment verdict's one systematic weakness was that emergent control flow
// reads worse than drawn edges — a newcomer cannot see what the system is doing.
// The instinct is to fix that with better tooling over the trace, and devtools
// does some of that. But there is a cheaper and more honest fix: let the world
// SAY what it is doing, in a component that has no effect on scheduling and
// exists purely to be read by a human.
//
// A graph framework gets this narration for free and accidentally — the node you
// are on IS the answer to "what is it doing". LangECS has no such node, so it has
// to make the narration explicit. Making that a blessed convention rather than
// something every user reinvents is what turns "control flow is implicit" from a
// weakness into a deliberate trade: the engine does not need a phase, and you can
// have one anyway, for free, wherever you want it.
//
// NARRATION IS STATE, NOT LOGGING. It is a component, so it lands in snapshots,
// shows up in the devtools inspector, survives a restart, and can be read by a UI
// polling committed state — none of which is true of a log line. And because
// nothing queries it, writing it can never change what runs.

import {
  AwaitingHuman,
  Cancelled,
  type ComponentType,
  defineComponent,
  type EntityReadView,
  SystemError,
  type World,
} from '@langecs/core';

/**
 * What this entity is doing right now, in the app's own vocabulary
 * (`'drafting'`, `'awaiting-approval'`, `'synthesizing'`).
 *
 * **No scheduling role whatsoever.** Nothing in stdlib queries `Phase`, and
 * nothing should: the moment a system's query depends on it, it stops being
 * narration and becomes a state machine — which is the graph framework this
 * engine exists not to be. Write it freely; read it only to display.
 *
 * "Free" needs the reducer below to be true. Having no scheduling role is not the
 * same as having no effect on the run: a plain component written by two systems in
 * one step raises `WriteConflictError` and rejects the whole run, so narration
 * without a reducer could destroy a run precisely because it looked harmless.
 */
export const Phase: ComponentType<string> = defineComponent<string>({
  name: 'Phase',
  // An explicit last-write-wins reducer, and it is load-bearing. Without one,
  // two systems narrating the same entity in one step is a `WriteConflictError`
  // that rejects the ENTIRE run with zero steps committed (R30) — so the
  // "write it freely" invitation above would have been a trap. R30 forbids
  // *silent* last-write-wins; declaring it is the sanctioned way to ask for it,
  // and merges are ordered deterministically by (system index, entity id).
  //
  // This is reachable from a shipped example: support-desk asserts two systems
  // running on one entity in one step, and adding the blessed one-line narration
  // to both would have stopped the desk working.
  reducer: (_current, incoming) => incoming,
});

/**
 * What this entity is ultimately trying to achieve, in one human sentence. Set
 * once at spawn and rarely changed — it is the "why" that `Phase`'s "what" hangs
 * off. Also has no scheduling role.
 */
export const Goal: ComponentType<string> = defineComponent<string>({
  name: 'Goal',
  // Same reducer as `Phase`, for the same reason. Lower risk in practice (set
  // once at spawn) but narration must never be able to reject a run.
  reducer: (_current, incoming) => incoming,
});

/** One entity's current state, rendered for a human (R64). */
export interface Narration {
  entity: number;
  /** A single sentence: goal, phase, and whichever engine state is in force. */
  sentence: string;
  phase?: string;
  goal?: string;
  /** `'working' | 'waiting' | 'failed' | 'cancelled'` — derived, never stored. */
  state: 'working' | 'waiting' | 'failed' | 'cancelled';
}

/**
 * Renders one entity's narration (R64).
 *
 * Reads `Phase`/`Goal` **plus** the engine's own queryable run state — the three
 * builtins that already say something a human wants to know: `AwaitingHuman`
 * (waiting), `SystemError` (failed), `Cancelled` (stopped). Those need no
 * convention because the engine already writes them; `Phase` and `Goal` are the
 * part only the application can know.
 *
 * Deliberately does *not* synthesise from every component: a dump of arbitrary
 * state is what the devtools inspector is for, and guessing which components are
 * narratable would be exactly the kind of vocabulary the engine should not own.
 */
export function narrate(entity: EntityReadView<any>): Narration {
  const phase = entity.get(Phase);
  const goal = entity.get(Goal);
  const cancelled = entity.get(Cancelled);
  const errors = entity.get(SystemError) ?? [];
  const interrupts = entity.get(AwaitingHuman) ?? [];

  const state: Narration['state'] =
    cancelled !== undefined
      ? 'cancelled'
      : errors.length > 0
        ? 'failed'
        : interrupts.length > 0
          ? 'waiting'
          : 'working';

  const parts: string[] = [`#${entity.id}`];
  if (goal !== undefined) parts.push(`aims to ${goal};`);
  if (phase !== undefined) parts.push(`is ${phase}`);
  else parts.push('is running');

  if (state === 'cancelled') {
    const reason = cancelled?.reason;
    parts.push(`— CANCELLED${reason !== undefined ? `: ${reason}` : ''}`);
  } else if (state === 'failed') {
    const failing = [...new Set(errors.map((record) => record.system))].join(', ');
    parts.push(`— FAILED in ${failing}: ${errors.at(-1)?.error.message ?? 'unknown error'}`);
  } else if (state === 'waiting') {
    const kinds = [...new Set(interrupts.map((record) => record.kind))].join(', ');
    parts.push(`— WAITING for a human (${kinds})`);
  }

  const narration: Narration = { entity: entity.id, sentence: parts.join(' '), state };
  if (phase !== undefined) narration.phase = phase;
  if (goal !== undefined) narration.goal = goal;
  return narration;
}

/**
 * Narrates every entity carrying a `Phase` or `Goal`, in entity order (R64) —
 * the "what is this world doing?" one-liner for a CLI, a status endpoint, or the
 * top of a devtools panel.
 *
 * ```ts
 * for (const line of narrateWorld(world)) console.log(line.sentence)
 * // #1 aims to answer the research question; is synthesizing
 * // #2 aims to research sub-question 0; is drafting
 * // #3 aims to research sub-question 1; is drafting — WAITING for a human (source-check)
 * ```
 */
export function narrateWorld(world: World): Narration[] {
  const seen = new Set<number>();
  const out: Narration[] = [];
  for (const marker of [Phase, Goal]) {
    for (const entity of world.query(marker)) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      out.push(narrate(entity));
    }
  }
  return out.sort((a, b) => a.entity - b.entity);
}
