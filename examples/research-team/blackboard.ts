// The research team's data model. One entity — the blackboard — carries the
// whole investigation as components: Question → Plan → Findings → Answer,
// plus the token ledger. Researchers are separate entities holding the
// assignment/memory components further down.

import { defineComponent, defineResource, defineTag, type Model } from '@langecs/core';

const append = <T>(current: T[], incoming: T[]): T[] => [...current, ...incoming];

// ----------------------------------------------------- blackboard components

/** The research question under investigation. */
export const Question = defineComponent<string>({ name: 'research:Question' });

/** Sub-questions by index; its presence means decomposition already happened. */
export const Plan = defineComponent<string[]>({ name: 'research:Plan' });

export type Finding = { researcher: number; index: number; text: string; revised: boolean };

/** Append reducer: researchers landing in the same barrier merge, never conflict. */
export const Findings = defineComponent<Finding[]>({ name: 'research:Findings', reducer: append });

/** The critic's green light; its arrival is what wakes the synthesizer. */
export const Approved = defineTag('research:Approved');

/** The synthesized final answer. */
export const Answer = defineComponent<string>({ name: 'research:Answer' });

/** Latest finding per sub-question slot — revisions append, so later wins. */
export const latestFindings = (findings: Finding[]): Map<number, Finding> => {
  const latest = new Map<number, Finding>();
  for (const f of findings) latest.set(f.index, f);
  return latest;
};

// ----------------------------------------------------- researcher components

/** A researcher's assignment: which board to report to, and which slot. */
export const SubQuestion = defineComponent<{ board: number; index: number; text: string }>({
  name: 'research:SubQuestion',
});

/** The researcher's private working memory — every draft it ever wrote. */
export const Notes = defineComponent<string[]>({ name: 'research:Notes', reducer: append });

/** Written by the critic onto a researcher; its arrival re-fires the agent. */
export const RevisionRequest = defineComponent<string>({ name: 'research:RevisionRequest' });

// --------------------------------------------------------- token accounting
//
// This example is where the budget-watchdog pattern was worked out, and stdlib
// now ships it (R63) — so the hand-rolled components are gone and these are
// re-exports. What is left here is the part that is genuinely ours: WHICH
// entities the brake has to reach (see `stampOn` in team.ts).

export {
  BudgetExceeded,
  type Spend,
  spendOf,
  spentTokens,
  TokenBudget,
  TokenUsage,
} from '@langecs/stdlib';

/** The one shared chat model, registered by main.ts or the test (typed ref). */
export const ResearchModel = defineResource<Model>('model:research');
