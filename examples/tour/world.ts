// The Tour world — one deterministic, offline world that seeds every concept the
// DevTools "Learn" tab teaches: a chat agent (greeter, ECS basics), a
// prompt-registry agent (support), a scored eval case, and a model-comparison
// bench report. No OPENAI_API_KEY, no network. main.ts adds the devtools/OTel
// wiring; README.md is the guided walkthrough.

import {
  createWorld,
  defineAgent,
  defineComponent,
  defineResource,
  defineSystem,
  defineTag,
  type EntityHandle,
  type Model,
  type Msg,
  type World,
} from '@langecs/core';
import {
  CaseTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  registerBuiltinScorers,
  registerEvalSystems,
  ScorerRef,
} from '@langecs/eval';
import {
  definePrompts,
  inMemoryRegistry,
  PromptRef,
  PromptVars,
  registerPrompts,
  renderSlots,
  resolvePrompt,
} from '@langecs/stdlib';
// examples does NOT depend on @langecs/bench (matches bench-devtools-demo) — import source.
import {
  type ComparisonReportData,
  writeComparisonReport,
} from '../../packages/bench/src/index.ts';

// --- greeter: the hello-world chat agent (ECS basics) -----------------------

/** Chat transcript; the reducer turns `add` into append (concurrent writers merge). */
export const Chat = defineComponent<Msg[]>({
  name: 'Chat',
  reducer: (current, incoming) => [...current, ...incoming],
});

/** Value-less work order: "the last word was the user's — someone owes a reply". */
export const WaitingReply = defineTag('WaitingReply');

const ChatModel = defineResource<Model>('model:chat');

// A constant deterministic model: always replies, never exhausts. The Learn
// tab's "send a message" step can fire it any number of times — scriptedModel
// would throw once its scripted turns ran out.
const greeterModel: Model = {
  async generate() {
    return {
      message: {
        role: 'assistant',
        content: "Hi! 👋 I'm the greeter — a tiny ECS agent. Add a message and I reply.",
      },
      finishReason: 'stop',
    };
  },
};

const respond = defineSystem({
  name: 'respond',
  query: [Chat, WaitingReply],
  run: async (e, ctx) => {
    const { message } = await ctx.resource(ChatModel).generate({ messages: e.get(Chat) });
    e.add(Chat, [message]); // self-write: does NOT retrigger respond
    e.remove(WaitingReply); // un-match the query → quiescent
  },
});

const greeter = defineAgent({
  name: 'greeter',
  components: [Chat([])],
  systems: [respond],
});

// --- support: prompt-registry agent (prompt management) ---------------------

const promptTemplates = definePrompts([
  {
    name: 'tour-greeting',
    version: '1.0.0',
    render: ({ user, topic }: { user: string; topic: string }) =>
      renderSlots('You are a friendly guide helping {{user}} with {{topic}}. Be concise.', {
        user,
        topic,
      }),
  },
]);

// No scoped systems — the global `resolvePrompt` (world.use below) renders it.
const support = defineAgent({
  name: 'support',
  components: [
    PromptRef('tour-greeting@1.0.0'),
    PromptVars({ user: 'Ada', topic: 'getting started with LangECS' }),
  ],
});

// --- bench: a canned model-comparison report (benchmarking) -----------------

// Copied from a real examples/bench-devtools-demo run (gpt-5-nano vs gpt-4o-mini
// on 3 cases). Offline data only; no model is ever called here.
const benchReport: ComparisonReportData = {
  candidates: [
    {
      name: 'gpt-5-nano',
      passRate: 1,
      meanScore: 1,
      report: {
        cases: 3,
        passed: 3,
        failed: 0,
        passRate: 1,
        meanScore: 1,
        latencyMs: { mean: 3713.33, p95: 4449 },
        cost: { mean: 0, total: 0 },
        totalTokens: 166,
        ranAt: '2026-06-18T23:48:16.079Z',
      },
    },
    {
      name: 'gpt-4o-mini',
      passRate: 1,
      meanScore: 1,
      report: {
        cases: 3,
        passed: 3,
        failed: 0,
        passRate: 1,
        meanScore: 1,
        latencyMs: { mean: 2147.33, p95: 2642 },
        cost: { mean: 0.00002145, total: 0.00006435 },
        totalTokens: 171,
        ranAt: '2026-06-18T23:48:22.522Z',
      },
    },
  ],
  ranked: ['gpt-5-nano', 'gpt-4o-mini'],
  winner: 'gpt-5-nano',
  rankedBy: 'meanScore',
  ranAt: '2026-06-18T23:48:22.522Z',
};

// --- build + seed -----------------------------------------------------------

export interface TourRefs {
  greeter: EntityHandle;
  support: EntityHandle;
  evalCase: EntityHandle;
}

/** Builds the tour world with all four exhibits. Pure: no devtools, no I/O. */
export function buildTourWorld(): { world: World; refs: TourRefs } {
  const world = createWorld({ id: 'tour' });

  world.register(ChatModel, greeterModel);

  registerPrompts(world, inMemoryRegistry(promptTemplates));
  world.use(resolvePrompt);

  registerBuiltinScorers(world);
  registerEvalSystems(world);

  const greeterHandle = world.spawn(greeter);
  const supportHandle = world.spawn(support);

  // A finished eval case ready to score: scoreCase fires when EvalComplete is
  // present and Score is absent, then verdictSystem turns Score into Verdict.
  const evalCase = world.spawn(
    CaseTag(),
    EvalInput('What is (23.5 * 4) - 7?'),
    EvalExpected('87'),
    EvalOutput('It works out to 87.'),
    ScorerRef('scorer:contains'),
    EvalComplete(),
  );

  // bench report → a data-only 'bench:ComparisonReport' component (idle, R16).
  writeComparisonReport(world, benchReport);

  return { world, refs: { greeter: greeterHandle, support: supportHandle, evalCase } };
}

/**
 * Runs the world to populate every tab: one setup run resolves the support
 * prompt + scores the eval case, then one greeter exchange produces a reply.
 * Shared by main.ts and the test so both drive the world identically.
 */
export async function seedTour(world: World, refs: TourRefs): Promise<void> {
  await world.run(); // resolvePrompt (support) + scoreCase/verdictSystem (eval case)
  await world.send(refs.greeter, Chat([{ role: 'user', content: "Hi! I'm Ada." }]), WaitingReply());
}
