// The guided "Learn" tour: plain-English steps over the `tour` example world.
// Each step optionally drives the UI via `showMe` — switch tab, select an entity
// (resolved by predicate, never a hardcoded id), and pulse the named pieces.

import type { WorldState } from '../../src/protocol';
import type { Tab } from './store';

/** Resolve the entity that carries a given component (first match). */
export function byComponent(name: string): (world: WorldState) => number | undefined {
  return (world) => world.entities.find((e) => e.components.some((c) => c.name === name))?.id;
}

/** Resolve the entity spawned from a given agent (`agent:<name>` badge). */
export function byAgent(name: string): (world: WorldState) => number | undefined {
  return (world) => world.entities.find((e) => e.agents.includes(name))?.id;
}

export interface ShowMe {
  tab: Tab;
  /** Which entity to select (omit for tabs without a selection, e.g. Timeline). */
  find?: (world: WorldState) => number | undefined;
  /** Component names to pulse in Inspector. */
  highlightComponents?: string[];
  /** System key to pulse in Systems. */
  highlightSystem?: string;
}

export interface SendAction {
  kind: 'send';
  /** Entity to send to (the greeter). */
  find: (world: WorldState) => number | undefined;
  components: { name: string; value: unknown }[];
  label: string;
}

export interface LearnStep {
  id: string;
  title: string;
  body: string;
  showMe?: ShowMe;
  action?: SendAction;
}

const greeterEntity = byAgent('greeter');

export const LEARN_STEPS: readonly LearnStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to LangECS',
    body:
      'A LangECS world holds entities. Each entity carries components (plain data), ' +
      'and systems are logic that fire when their query matches. This tour walks one ' +
      'small world. Hit Next, and use "Show me" to jump to what each step describes.',
  },
  {
    id: 'components',
    title: 'Entities & components',
    body:
      "Components are an entity's entire memory — just serializable data. The greeter " +
      'agent holds a Chat transcript. Everything an agent "remembers" is a component.',
    showMe: { tab: 'inspector', find: greeterEntity, highlightComponents: ['Chat'] },
  },
  {
    id: 'tags',
    title: 'Tags are work orders',
    body:
      'WaitingReply is a tag: a value-less component whose mere presence is a signal — ' +
      '"the last word was the user\'s, someone owes a reply." Systems key off tags like this.',
    showMe: { tab: 'inspector', find: greeterEntity, highlightComponents: ['WaitingReply'] },
  },
  {
    id: 'systems',
    title: 'Systems & queries',
    body:
      'The respond system has the query [Chat, WaitingReply]. It fires only when an entity ' +
      'NEWLY matches — not every tick. That is the whole scheduler in one line.',
    showMe: { tab: 'systems', highlightSystem: 'greeter:respond' },
  },
  {
    id: 'run',
    title: 'Run a step → quiescence',
    body:
      'Send the greeter a message: it adds Chat + WaitingReply, respond fires, appends a ' +
      'reply, and removes the tag. When nothing is left to run, the world is quiescent — ' +
      'that, not an "end" node, is how a run finishes. Then peek at the Timeline.',
    action: {
      kind: 'send',
      find: greeterEntity,
      label: 'Send a message ▶',
      components: [
        { name: 'Chat', value: [{ role: 'user', content: 'What can you do?' }] },
        { name: 'WaitingReply', value: true },
      ],
    },
  },
  {
    id: 'prompts',
    title: 'Prompt registry',
    body:
      'The support agent carries PromptRef("tour-greeting@1.0.0") — a pinned, versioned ' +
      'template — plus PromptVars. The resolvePrompt system renders it into RenderedPrompt. ' +
      'Substitution is single-pass and injection-safe; the version is recorded for provenance.',
    showMe: {
      tab: 'inspector',
      find: byAgent('support'),
      highlightComponents: ['PromptRef', 'RenderedPrompt'],
    },
  },
  {
    id: 'eval',
    title: 'Evaluation',
    body:
      'The eval case carries an output and an expected value plus a ScorerRef. The scoreCase ' +
      'system runs the named scorer to write a Score, and verdictSystem turns it into a ' +
      'pass/fail Verdict. Swap the ScorerRef for an LLM judge (llmJudgeScorer) and the rest is identical.',
    showMe: {
      tab: 'inspector',
      find: byComponent('eval:Verdict'),
      highlightComponents: ['eval:Score', 'eval:Verdict'],
    },
  },
  {
    id: 'bench',
    title: 'Benchmarking',
    body:
      'A bench:ComparisonReport entity holds a model comparison: pass-rate, mean score, ' +
      'latency (mean/p95), tokens, and cost for each candidate, plus the ranking. It is plain ' +
      'data written into the world — open it to compare gpt-5-nano vs gpt-4o-mini.',
    showMe: { tab: 'inspector', find: byComponent('bench:ComparisonReport') },
  },
  {
    id: 'traces',
    title: 'Traces',
    body:
      'The same run, viewed as OpenTelemetry spans: run → step → system. Every LangECS run ' +
      'can export standard OTLP traces to any backend; the inspector is just one receiver.',
    showMe: { tab: 'traces' },
  },
  {
    id: 'next',
    title: 'Where to go next',
    body:
      'You have seen the whole model. Try the standalone examples: `pnpm -C examples ' +
      'eval-react-agent`, `pnpm -C examples prompt-registry`, and the bench-devtools-demo. ' +
      'SPEC.md is the engine contract (R1–R48).',
  },
];
