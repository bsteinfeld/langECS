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

export type Spend = { system: string; tokens: number };

/** Ledger of every model call's cost; appends are what wake tokenBudget. */
export const TokenUsage = defineComponent<Spend[]>({
  name: 'research:TokenUsage',
  reducer: append,
});

/** Max total tokens for the run; plain data, so tests shrink it to 1. */
export const TokenBudget = defineComponent<number>({ name: 'research:TokenBudget' });

/** Stamped on the blackboard AND every researcher once the ledger exceeds the
 * budget. Every model-calling system excludes it with Not(), so its arrival
 * unmatches them all and the world quiesces with whatever work is committed. */
export const BudgetExceeded = defineComponent<{ spent: number; budget: number }>({
  name: 'research:BudgetExceeded',
});

export const totalTokens = (ledger: Spend[]): number => ledger.reduce((n, s) => n + s.tokens, 0);

/** The one shared chat model, registered by main.ts or the test (typed ref). */
export const ResearchModel = defineResource<Model>('model:research');
