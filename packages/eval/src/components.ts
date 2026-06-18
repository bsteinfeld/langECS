// Eval components for LangECS eval stack (EVAL-01, R3).
// All values are plain JSON data (R3); behavior (scorers) lives in named world resources.
// All component names carry the 'eval:' prefix to avoid global registry collisions (R7).

import { type ComponentType, defineComponent, defineTag, type TagType } from '@langecs/core';

// ---- Input/Output data components ----

/** The input payload for one eval case: prompt text, or multi-turn messages seed. */
export const EvalInput: ComponentType<string> = defineComponent<string>({
  name: 'eval:EvalInput',
});

/** The expected output descriptor: a literal string for exact/fuzzy scorers,
 *  or a stringified JSON object for schema/numeric scorers.
 *  Never a function (R3). */
export const EvalExpected: ComponentType<string> = defineComponent<string>({
  name: 'eval:EvalExpected',
});

/** The actual output captured from the agent-under-test after quiescence.
 *  Written by the harness (Phase 8); read by scorer systems. */
export const EvalOutput: ComponentType<string> = defineComponent<string>({
  name: 'eval:EvalOutput',
});

// ---- Scoring components ----

/** Numeric score in [0, 1] written by the scorer system.
 *  Exactly one scorer fires per case (Not(Score) guard). */
export const Score: ComponentType<number> = defineComponent<number>({
  name: 'eval:Score',
});

/** Pass/fail/skip verdict written by the verdict system after Score is present. */
export const Verdict: ComponentType<'pass' | 'fail' | 'skip'> = defineComponent<
  'pass' | 'fail' | 'skip'
>({
  name: 'eval:Verdict',
});

/** The name of the scorer resource to apply, e.g. 'scorer:exact-match'.
 *  Plain string — data only (R3). Never a function. Mirrors ModelRef pattern from stdlib. */
export const ScorerRef: ComponentType<string> = defineComponent<string>({
  name: 'eval:ScorerRef',
});

// ---- Tags ----

/** Marks an entity as an eval case entity (used in all scorer system queries). */
export const CaseTag: TagType<'eval:CaseTag'> = defineTag('eval:CaseTag');

/** Marks the dataset controller entity (used for aggregation in Phase 8+). */
export const DatasetTag: TagType<'eval:DatasetTag'> = defineTag('eval:DatasetTag');

/**
 * Stamped onto a case entity after the agent-under-test reaches quiescence
 * and EvalOutput is written. Its "newly matched" dirty state triggers scorer
 * systems exactly once per case (R26 rule 2). Written by the harness (Phase 8).
 */
export const EvalComplete: TagType<'eval:EvalComplete'> = defineTag('eval:EvalComplete');
