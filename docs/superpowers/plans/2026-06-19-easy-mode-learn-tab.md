# Easy Mode — Guided Learn tab + tour world — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a beginner "easy mode" to LangECS: one deterministic offline `tour` example world plus a guided `📖 Learn` tab in DevTools that explains ECS basics + the eval/bench/prompt features and drives the UI ("Show me ▶") to each concept.

**Architecture:** A new `examples/tour/` builds a single world seeding four exhibits (greeter agent, prompt-registry agent, scored eval case, canned bench report), all offline. A new `LearnTab` React component in the existing DevTools reads world state and dispatches the store's existing `select-entity`/`set-tab` actions plus a new `highlight` action to walk a learner through that world. The tour lands on Learn via an opt-in `welcome` flag threaded through the `hello` message.

**Tech Stack:** TypeScript, `@langecs/core` / `stdlib` / `eval` / `bench` / `devtools` / `otel`, React (DevTools UI, Vite), Vitest, OpenTelemetry SDK (node).

## Global Constraints

- `@langecs/core` stays zero-runtime-dependency and isomorphic (R1) — not touched here.
- Components are data-only, JSON/structured-clone serializable (R3); behavior (models, scorers, prompt render closures) lives in named world registries.
- DevTools mutations are idle-only (R16); the Learn tab only reads world state and uses existing commands (`send`/`run`) — it never bypasses the engine.
- All tour code is deterministic and zero-network — no `OPENAI_API_KEY` read anywhere; greeter uses a constant in-process `Model`, eval uses deterministic scorers.
- Node >= 20, pnpm. Run `pnpm lint:fix` before each commit. Component names share one global registry per process — the tour reuses the engine's existing component names (`Chat`, `WaitingReply`) and the prefixed eval/bench names.
- Examples do NOT depend on `@langecs/bench`; import its source via relative path `../../packages/bench/src/index.ts` (matches `examples/bench-devtools-demo`).
- Pinned prompt refs only — `PromptRef('tour-greeting@1.0.0')`, never `@latest` (CI `prompts:gate`).

---

### Task 1: Tour world builder + test

**Files:**
- Create: `examples/tour/world.ts`
- Test: `examples/tour/tour.test.ts`
- Modify: `examples/package.json` (add `"tour"` script)

**Interfaces:**
- Produces: `buildTourWorld(): { world: World; refs: TourRefs }` and `seedTour(world: World, refs: TourRefs): Promise<void>`, plus exported components `Chat` (`ComponentType<Msg[]>`) and `WaitingReply` (tag). `TourRefs = { greeter: EntityHandle; support: EntityHandle; evalCase: EntityHandle }`. Consumed by Task 3 (`main.ts`).

- [ ] **Step 1: Write the failing test**

Create `examples/tour/tour.test.ts`:

```ts
// Deterministic, zero-network: build the tour world, seed it, and assert every
// exhibit the Learn tab points at ends in its expected state.
import { describe, expect, it } from 'vitest';
import { RenderedPrompt } from '@langecs/stdlib';
import { Score, Verdict } from '@langecs/eval';
import { buildTourWorld, Chat, seedTour, WaitingReply } from './world';

describe('tour world', () => {
  it('seeds greeter, support, eval case, and bench report', async () => {
    const { world, refs } = buildTourWorld();
    await seedTour(world, refs);

    // greeter: replied and is quiescent (WaitingReply removed)
    const chat = refs.greeter.get(Chat);
    expect(chat?.at(-1)?.role).toBe('assistant');
    expect(refs.greeter.has(WaitingReply)).toBe(false);

    // support: prompt resolved with the injected vars
    const rendered = refs.support.get(RenderedPrompt);
    expect(rendered).toContain('Ada');
    expect(rendered).toContain('getting started with LangECS');

    // eval case: scored and judged a pass
    expect(refs.evalCase.get(Score)).toBe(1);
    expect(refs.evalCase.get(Verdict)).toBe('pass');

    // bench report: present on its own entity, two candidates
    const report = world
      .snapshot()
      .entities.flatMap((e) => Object.entries(e.components))
      .find(([name]) => name === 'bench:ComparisonReport')?.[1] as
      | { candidates: unknown[] }
      | undefined;
    expect(report?.candidates).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C examples exec vitest run tour`
Expected: FAIL — `Cannot find module './world'`.

- [ ] **Step 3: Write `examples/tour/world.ts`**

```ts
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
  definePrompts,
  inMemoryRegistry,
  PromptRef,
  PromptVars,
  registerPrompts,
  renderSlots,
  resolvePrompt,
} from '@langecs/stdlib';
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
```

- [ ] **Step 4: Add the `tour` script**

In `examples/package.json`, add to `scripts` (after the `prompt-registry` line):

```json
    "tour": "tsx tour/main.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C examples exec vitest run tour`
Expected: PASS (1 test). If `refs.greeter.has` is not a method, use `refs.greeter.get(WaitingReply) === undefined` instead (confirm the handle API against `EntityHandle` in `packages/core/src/system.ts`).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
pnpm -C examples exec tsc --noEmit
pnpm lint:fix
git add examples/tour/world.ts examples/tour/tour.test.ts examples/package.json
git commit -m "feat(examples): tour world builder seeding greeter/support/eval/bench"
```

---

### Task 2: DevTools `welcome` flag (land on the Learn tab)

**Files:**
- Modify: `packages/devtools/src/protocol.ts:92` (the `hello` message)
- Modify: `packages/devtools/src/server.ts:28-39` (`DevtoolsOptions`) and `:445` (hello send)
- Test: `packages/devtools/test/server.test.ts`

**Interfaces:**
- Produces: `hello` message gains optional `welcome?: boolean`; `startDevtools(world, { welcome: true })` makes the server send `welcome: true` on connect. Consumed by Task 3 (`main.ts`) and Task 4 (store).

- [ ] **Step 1: Write the failing test**

Append to `packages/devtools/test/server.test.ts` (it already has `startDevtools`, `TestClient`, and an `afterEach` that closes servers — reuse the existing harness; check the file's existing server-lifecycle helper and mirror it):

```ts
test('hello carries welcome:true only when the option is set', async () => {
  const world = createWorld({ id: `dtsrv-welcome-${Math.random().toString(36).slice(2)}` });
  const server = await startDevtools(world, { port: 0, welcome: true });
  servers.push(server); // if the file tracks servers for afterEach cleanup; else close manually
  const client = await TestClient.connect(`${server.url.replace('http', 'ws')}/ws`);
  const hello = await client.waitFor((m) => m.type === 'hello', 'hello');
  expect(hello).toMatchObject({ type: 'hello', welcome: true });
});

test('hello omits welcome by default', async () => {
  const world = createWorld({ id: `dtsrv-nowelcome-${Math.random().toString(36).slice(2)}` });
  const server = await startDevtools(world, { port: 0 });
  servers.push(server);
  const client = await TestClient.connect(`${server.url.replace('http', 'ws')}/ws`);
  const hello = (await client.waitFor((m) => m.type === 'hello', 'hello')) as {
    welcome?: boolean;
  };
  expect(hello.welcome).toBeUndefined();
});
```

Note: match the existing test file's server-cleanup convention. Read `packages/devtools/test/server.test.ts:1-130` first; if it closes servers via a local array + `afterEach`, push to that array; otherwise `await server.close()` at the end of each test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/devtools exec vitest run test/server.test.ts -t welcome`
Expected: FAIL — `welcome` is `undefined` in the first test (option not yet honored).

- [ ] **Step 3: Add `welcome` to the protocol hello message**

In `packages/devtools/src/protocol.ts`, change the `hello` variant (line ~92):

```ts
  | { type: 'hello'; protocol: typeof PROTOCOL_VERSION; worldId: string; welcome?: boolean }
```

- [ ] **Step 4: Thread `welcome` through the server**

In `packages/devtools/src/server.ts`, add to `DevtoolsOptions` (after `open?: boolean;`):

```ts
  /** Land the inspector on the guided "Learn" tab on first connect (e.g. the tour). */
  welcome?: boolean;
```

Then in the `wss.on('connection', ...)` handler, change the hello send (line ~445):

```ts
    send(client, {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      worldId: world.id,
      ...(options?.welcome ? { welcome: true } : {}),
    });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C packages/devtools exec vitest run test/server.test.ts -t welcome`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint + commit**

```bash
pnpm -C packages/devtools typecheck
pnpm lint:fix
git add packages/devtools/src/protocol.ts packages/devtools/src/server.ts packages/devtools/test/server.test.ts
git commit -m "feat(devtools): opt-in welcome flag on hello to land on the Learn tab"
```

---

### Task 3: Tour `main.ts` + README

**Files:**
- Create: `examples/tour/main.ts`
- Create: `examples/tour/README.md`

**Interfaces:**
- Consumes: `buildTourWorld`, `seedTour` from `./world` (Task 1); `startDevtools(world, { welcome: true })` (Task 2); `instrumentWorld` from `@langecs/otel`.

- [ ] **Step 1: Write `examples/tour/main.ts`**

```ts
// LangECS "Easy Mode" tour — a single offline world plus the DevTools inspector,
// landing on the guided 📖 Learn tab.
//
// Run with: pnpm -C examples tour        (no API key needed)
//
// Seeds four exhibits the Learn tab walks through: a greeter chat agent (ECS
// basics), a support agent with a resolved prompt (prompt registry), a scored
// eval case (eval), and a model-comparison bench report (benchmarking). OTel
// forwards run/step/system spans to the inspector so the Traces tab is populated.

import { startDevtools } from '@langecs/devtools';
import { instrumentWorld } from '@langecs/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { buildTourWorld, seedTour } from './world';

const { world, refs } = buildTourWorld();

// 1. Inspector first, so the OTLP exporter can target its /v1/traces receiver.
//    `welcome: true` lands the UI on the guided Learn tab.
const server = await startDevtools(world, { welcome: true });

// 2. Standard OpenTelemetry SDK, exporting to the devtools server.
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'tour' }),
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${server.url}/v1/traces` }), {
      scheduledDelayMillis: 500,
    }),
  ],
});
provider.register();

// 3. Bridge run/step/system events to spans (no model wrapping needed — the
//    greeter model is a constant; the run/step/system waterfall is the point).
const detach = instrumentWorld(world);

// 4. Drive the world so every tab has content (prompt resolved, eval scored,
//    greeter replied).
await seedTour(world, refs);

console.log(`
  LangECS — Easy Mode tour ➜  ${server.url}

  The inspector opens on the 📖 Learn tab — follow the steps with "Show me ▶".
  Exhibits: greeter #${refs.greeter.id} · support #${refs.support.id} · eval #${refs.evalCase.id}.

  No API key needed. Ctrl+C to exit.
`);

const shutdown = async (): Promise<void> => {
  detach();
  await provider.shutdown().catch(() => {});
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
```

- [ ] **Step 2: Write `examples/tour/README.md`**

````markdown
# Tour — LangECS Easy Mode

A single offline world plus the DevTools inspector, landing on a guided **📖 Learn**
tab. No API key, no network.

```sh
pnpm -C examples tour
```

Open the printed URL. The inspector starts on the **Learn** tab — step through it with
**"Show me ▶"**, which jumps to the right tab and highlights what each step describes.

## What it seeds

| Exhibit | Teaches | Where to look |
|---------|---------|---------------|
| `greeter` agent | entities, components, tags, systems, queries, quiescence | Inspector → `Chat`, `WaitingReply`; Systems → `respond` |
| `support` agent | versioned, injection-safe prompt registry | Inspector → `PromptRef`, `RenderedPrompt` |
| eval case | scorer → score → verdict | Inspector → `eval:Score`, `eval:Verdict` |
| bench report | comparing models (pass-rate, latency, tokens, cost) | Inspector → `bench:ComparisonReport` |

## Where to go next

- `pnpm -C examples eval-react-agent` — run an agent against a dataset
- `pnpm -C examples prompt-registry` — versioned prompts end to end
- `pnpm -C examples exec tsx bench-devtools-demo/main.ts` — a real model comparison
- `SPEC.md` — the engine contract (R1–R48)
````

- [ ] **Step 3: Verify it runs (manual smoke)**

Run: `pnpm -C examples tour`
Expected: prints `LangECS — Easy Mode tour ➜ http://127.0.0.1:4477` (or next free port) and stays running. `Ctrl+C` exits cleanly. (UI lands on Learn after Task 6; for now it lands on Inspector — the server is up and entities are present.) Confirm no unhandled errors in the console.

- [ ] **Step 4: Typecheck + lint + commit**

```bash
pnpm -C examples exec tsc --noEmit
pnpm lint:fix
git add examples/tour/main.ts examples/tour/README.md
git commit -m "feat(examples): tour main.ts (devtools + OTel) and README"
```

---

### Task 4: Store — `learn` tab, `highlight` state, welcome handling

**Files:**
- Modify: `packages/devtools/ui/src/store.ts`
- Test: `packages/devtools/test/learn-store.test.ts` (new)

**Interfaces:**
- Produces: `Tab` union includes `'learn'`; `State` gains `highlight: Highlight | null` and `appliedWelcome: boolean`; new `Highlight` interface `{ components?: string[]; system?: string }`; new action `{ type: 'highlight'; highlight: Highlight | null }`. The `server` reducer case sets `tab: 'learn'` once when a `hello` with `welcome: true` arrives. Consumed by Tasks 6 & 7.

- [ ] **Step 1: Write the failing test**

Create `packages/devtools/test/learn-store.test.ts`:

```ts
import { expect, test } from 'vitest';
import { initialState, reducer, type State } from '../ui/src/store';
import type { ServerMessage } from '../src/protocol';

const helloWelcome: ServerMessage = {
  type: 'hello',
  protocol: 1,
  worldId: 'tour',
  welcome: true,
};

test('a welcome hello switches to the learn tab exactly once', () => {
  const afterFirst = reducer(initialState, { type: 'server', messages: [helloWelcome] });
  expect(afterFirst.tab).toBe('learn');
  expect(afterFirst.appliedWelcome).toBe(true);

  // User navigates away; a replayed hello (reconnect) must NOT yank them back.
  const navigated: State = { ...afterFirst, tab: 'inspector' };
  const afterReconnect = reducer(navigated, { type: 'server', messages: [helloWelcome] });
  expect(afterReconnect.tab).toBe('inspector');
});

test('a hello without welcome does not change the tab', () => {
  const hello: ServerMessage = { type: 'hello', protocol: 1, worldId: 'x' };
  const next = reducer(initialState, { type: 'server', messages: [hello] });
  expect(next.tab).toBe('inspector');
  expect(next.appliedWelcome).toBe(false);
});

test('highlight action sets and clears highlight', () => {
  const set = reducer(initialState, {
    type: 'highlight',
    highlight: { components: ['Chat'] },
  });
  expect(set.highlight).toEqual({ components: ['Chat'] });
  const cleared = reducer(set, { type: 'highlight', highlight: null });
  expect(cleared.highlight).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/devtools exec vitest run test/learn-store.test.ts`
Expected: FAIL — `appliedWelcome`/`highlight` don't exist; tab stays `inspector`.

- [ ] **Step 3: Extend `store.ts`**

In `packages/devtools/ui/src/store.ts`:

(a) Add `'learn'` to the `Tab` union (first member):

```ts
export type Tab =
  | 'learn'
  | 'inspector'
  | 'systems'
  | 'timeline'
  | 'traces'
  | 'events'
  | 'interrupts'
  | 'timetravel';
```

(b) Add the `Highlight` interface (near `Toast`):

```ts
/** What a Learn-tab "Show me" pulses: component cards (Inspector) or a system row (Systems). */
export interface Highlight {
  components?: string[];
  system?: string;
}
```

(c) Add fields to `State` (after `tab: Tab;`):

```ts
  highlight: Highlight | null;
  /** True once a `welcome` hello has steered us to the Learn tab (apply once). */
  appliedWelcome: boolean;
```

(d) Add to `initialState` (after `tab: 'inspector',`):

```ts
  highlight: null,
  appliedWelcome: false,
```

(e) Add the action to the `Action` union (after the `set-tab` line):

```ts
  | { type: 'highlight'; highlight: Highlight | null }
```

(f) In the `server` reducer case, replace `case 'hello': break;` with:

```ts
          case 'hello':
            if (msg.welcome && !next.appliedWelcome) {
              next = next === state ? { ...state } : next;
              next.tab = 'learn';
              next.appliedWelcome = true;
            }
            break;
```

(g) Add a top-level case in `reducer` (after the `set-tab` case):

```ts
    case 'highlight':
      return { ...state, highlight: action.highlight };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/devtools exec vitest run test/learn-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
pnpm -C packages/devtools typecheck
pnpm lint:fix
git add packages/devtools/ui/src/store.ts packages/devtools/test/learn-store.test.ts
git commit -m "feat(devtools): store support for learn tab, highlight, and welcome"
```

---

### Task 5: Learn steps data + integrity test

**Files:**
- Create: `packages/devtools/ui/src/learn-steps.ts`
- Test: `packages/devtools/test/learn-steps.test.ts` (new)

**Interfaces:**
- Produces: `LEARN_STEPS: readonly LearnStep[]`; helper predicates `byComponent(name)` and `byAgent(name)` returning `(world: WorldState) => number | undefined`. `LearnStep` shape below. Consumed by Task 6 (`LearnTab`).

- [ ] **Step 1: Write the failing test**

Create `packages/devtools/test/learn-steps.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { Tab } from '../ui/src/store';
import { byAgent, byComponent, LEARN_STEPS } from '../ui/src/learn-steps';
import type { WorldState } from '../src/protocol';

const VALID_TABS: Tab[] = [
  'learn',
  'inspector',
  'systems',
  'timeline',
  'traces',
  'events',
  'interrupts',
  'timetravel',
];

test('steps are well-formed and uniquely identified', () => {
  expect(LEARN_STEPS.length).toBeGreaterThanOrEqual(8);
  const ids = new Set<string>();
  for (const step of LEARN_STEPS) {
    expect(step.id).toBeTruthy();
    expect(step.title).toBeTruthy();
    expect(step.body).toBeTruthy();
    expect(ids.has(step.id)).toBe(false);
    ids.add(step.id);
    if (step.showMe) expect(VALID_TABS).toContain(step.showMe.tab);
  }
});

test('component/agent predicates resolve against a tour-shaped world', () => {
  // Minimal WorldState fixture mirroring the tour exhibits.
  const world = {
    worldId: 'tour',
    step: 2,
    running: false,
    entities: [
      { id: 1, agents: ['greeter'], components: [{ name: 'Chat' }, { name: 'WaitingReply' }] },
      { id: 2, agents: ['support'], components: [{ name: 'PromptRef' }, { name: 'RenderedPrompt' }] },
      { id: 3, agents: [], components: [{ name: 'eval:Score' }, { name: 'eval:Verdict' }] },
    ],
  } as unknown as WorldState;

  expect(byComponent('Chat')(world)).toBe(1);
  expect(byAgent('support')(world)).toBe(2);
  expect(byComponent('eval:Verdict')(world)).toBe(3);
  expect(byComponent('does-not-exist')(world)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/devtools exec vitest run test/learn-steps.test.ts`
Expected: FAIL — `Cannot find module '../ui/src/learn-steps'`.

- [ ] **Step 3: Write `packages/devtools/ui/src/learn-steps.ts`**

```ts
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
      'Components are an entity\'s entire memory — just serializable data. The greeter ' +
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/devtools exec vitest run test/learn-steps.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
pnpm -C packages/devtools typecheck
pnpm lint:fix
git add packages/devtools/ui/src/learn-steps.ts packages/devtools/test/learn-steps.test.ts
git commit -m "feat(devtools): guided learn-steps data + integrity test"
```

---

### Task 6: LearnTab component + App wiring

**Files:**
- Create: `packages/devtools/ui/src/components/LearnTab.tsx`
- Modify: `packages/devtools/ui/src/App.tsx:15-23` (TABS) and `:25-44` (TabBody)
- Modify: `packages/devtools/ui/src/styles.css` (learn-panel styles)

**Interfaces:**
- Consumes: `LEARN_STEPS`, `LearnStep` (Task 5); `useStore`, `Highlight` (Task 4); existing `command` for the `send` action.
- Produces: `LearnTab` React component; `'learn'` rendered as the first tab.

- [ ] **Step 1: Write `packages/devtools/ui/src/components/LearnTab.tsx`**

```tsx
// The guided 📖 Learn tab: walks LEARN_STEPS over the tour world, driving the
// rest of the inspector via "Show me" (select entity + switch tab + pulse) and a
// one-click "send a message" action. Pure consumer of the store + existing
// commands — it never mutates the world directly (R16).

import { useState } from 'react';
import { LEARN_STEPS, type LearnStep } from '../learn-steps';
import { useStore } from '../store';

const HIGHLIGHT_MS = 2500;

function StepNav({ index, count, onPrev, onNext }: {
  index: number;
  count: number;
  onPrev(): void;
  onNext(): void;
}) {
  return (
    <div className="learn-nav">
      <button type="button" className="btn" disabled={index === 0} onClick={onPrev}>
        ◀ Back
      </button>
      <span className="learn-progress">
        Step {index + 1} of {count}
      </span>
      <button type="button" className="btn btn-accent" disabled={index === count - 1} onClick={onNext}>
        Next ▶
      </button>
    </div>
  );
}

export function LearnTab() {
  const { state, dispatch, command } = useStore();
  const [index, setIndex] = useState(0);
  const step: LearnStep = LEARN_STEPS[index];
  const world = state.world;

  const pulse = (highlight: { components?: string[]; system?: string }): void => {
    dispatch({ type: 'highlight', highlight });
    window.setTimeout(() => dispatch({ type: 'highlight', highlight: null }), HIGHLIGHT_MS);
  };

  const showMe = (): void => {
    const sm = step.showMe;
    if (!sm || !world) return;
    if (sm.find) {
      const id = sm.find(world);
      if (id !== undefined) dispatch({ type: 'select-entity', entity: id });
    }
    dispatch({ type: 'set-tab', tab: sm.tab });
    if (sm.highlightComponents) pulse({ components: sm.highlightComponents });
    else if (sm.highlightSystem) pulse({ system: sm.highlightSystem });
  };

  const runAction = async (): Promise<void> => {
    const act = step.action;
    if (!act || !world) return;
    const id = act.find(world);
    if (id === undefined) return;
    await command({ type: 'send', entity: id, components: act.components });
  };

  // "Show me" can only resolve its target when the matching entity is present.
  const showMeReady =
    step.showMe !== undefined &&
    world !== null &&
    (step.showMe.find === undefined || step.showMe.find(world) !== undefined);
  const actionReady = step.action !== undefined && world !== null && step.action.find(world) !== undefined;

  return (
    <div className="learn">
      <div className="learn-card">
        <h2 className="learn-title">{step.title}</h2>
        <p className="learn-body">{step.body}</p>
        <div className="learn-actions">
          {step.showMe && (
            <button
              type="button"
              className="btn"
              disabled={!showMeReady}
              title={showMeReady ? undefined : 'Run `pnpm -C examples tour` to see this exhibit.'}
              onClick={showMe}
            >
              Show me ▶
            </button>
          )}
          {step.action && (
            <button
              type="button"
              className="btn btn-accent"
              disabled={!actionReady || state.world?.running === true}
              onClick={() => void runAction()}
            >
              {step.action.label}
            </button>
          )}
        </div>
      </div>
      <StepNav
        index={index}
        count={LEARN_STEPS.length}
        onPrev={() => setIndex((i) => Math.max(0, i - 1))}
        onNext={() => setIndex((i) => Math.min(LEARN_STEPS.length - 1, i + 1))}
      />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Add the import (with the other component imports):

```ts
import { LearnTab } from './components/LearnTab';
```

Prepend to the `TABS` array (make `learn` first):

```ts
const TABS: { id: Tab; label: string }[] = [
  { id: 'learn', label: '📖 Learn' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'systems', label: 'Systems' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
  { id: 'interrupts', label: 'Interrupts' },
  { id: 'timetravel', label: 'Time travel' },
];
```

Add the case to `TabBody` (first case):

```ts
    case 'learn':
      return <LearnTab />;
```

- [ ] **Step 3: Add learn-panel styles**

Append to `packages/devtools/ui/src/styles.css` (match existing variable/class conventions — reuse `.card`, `.btn` colors; read the top of `styles.css` for the CSS custom properties in use, e.g. `--bg`, `--border`, `--accent`, and use those):

```css
/* ----------------------------------------------------------------- Learn tab */
.learn {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 44rem;
  margin: 0 auto;
  padding: 1.5rem 1rem;
}
.learn-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem 1.5rem;
  background: var(--panel, var(--bg));
}
.learn-title {
  margin: 0 0 0.5rem;
  font-size: 1.15rem;
}
.learn-body {
  margin: 0;
  line-height: 1.6;
  color: var(--fg);
}
.learn-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}
.learn-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.learn-progress {
  font-variant-numeric: tabular-nums;
  color: var(--muted, var(--fg));
  opacity: 0.7;
}
```

- [ ] **Step 4: Build the UI and verify it renders**

```bash
pnpm -C packages/devtools build
```
Then in one terminal: `pnpm -C examples tour`; open the printed URL.
Expected: the inspector opens on the **📖 Learn** tab (welcome flag works), showing Step 1 of 10 with Back/Next. Clicking **Next** advances steps. On the "Entities & components" step, **Show me ▶** switches to Inspector and selects the greeter. On "Run a step", **Send a message ▶** appends a reply (watch the greeter's Chat grow). The visual pulse is added in Task 7.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
pnpm -C packages/devtools typecheck
pnpm lint:fix
git add packages/devtools/ui/src/components/LearnTab.tsx packages/devtools/ui/src/App.tsx packages/devtools/ui/src/styles.css
git commit -m "feat(devtools): guided Learn tab with Show me + send actions"
```

---

### Task 7: Highlight visualization (pulse) in Inspector & Systems

**Files:**
- Modify: `packages/devtools/ui/src/components/InspectorTab.tsx` (pulse highlighted component cards)
- Modify: `packages/devtools/ui/src/components/SystemsTab.tsx` (pulse highlighted system row)
- Modify: `packages/devtools/ui/src/styles.css` (`.pulse` keyframes)

**Interfaces:**
- Consumes: `state.highlight` (Task 4). No new exports.

- [ ] **Step 1: Pulse highlighted component cards (InspectorTab)**

In `packages/devtools/ui/src/components/InspectorTab.tsx`:

(a) Give `ComponentCard` a `highlighted` prop. Change its signature/`<section>`:

```tsx
const ComponentCard = memo(function ComponentCard({
  entityId,
  comp,
  highlighted,
}: {
  entityId: number;
  comp: ComponentState;
  highlighted: boolean;
}) {
```

and the root element:

```tsx
    <section className={highlighted ? 'card pulse' : 'card'}>
```

(b) In `InspectorTab`, read the highlight and pass it down. The component already calls `useStore()` as `const { state, command, dispatch } = useStore();` — reuse `state`. Change the `.map` render:

```tsx
      {entity.components.map((comp) => (
        <ComponentCard
          key={comp.name}
          entityId={entity.id}
          comp={comp}
          highlighted={state.highlight?.components?.includes(comp.name) ?? false}
        />
      ))}
```

- [ ] **Step 2: Pulse the highlighted system row (SystemsTab)**

In `packages/devtools/ui/src/components/SystemsTab.tsx`, the row className currently is `open ? 'sys-row open' : 'sys-row'`. Read the highlight from the store (the component already has `const { state, dispatch } = useStore();`) and fold it in:

```tsx
                <tr
                  className={[
                    'sys-row',
                    open ? 'open' : '',
                    state.highlight?.system === sys.key ? 'pulse' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
```

- [ ] **Step 3: Add the `.pulse` animation**

Append to `packages/devtools/ui/src/styles.css`:

```css
/* Learn-tab "Show me" attention pulse (auto-clears after ~2.5s via the store). */
@keyframes langecs-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  30% {
    box-shadow: 0 0 0 3px var(--accent, #6ea8fe);
  }
}
.pulse {
  animation: langecs-pulse 1.2s ease-in-out 2;
  border-color: var(--accent, #6ea8fe) !important;
}
```

- [ ] **Step 4: Build + verify the pulse**

```bash
pnpm -C packages/devtools build
```
Run `pnpm -C examples tour`, open the URL. On the **Learn** tab:
- "Entities & components" → **Show me ▶** pulses the `Chat` card in Inspector.
- "Systems & queries" → **Show me ▶** switches to Systems and pulses the `greeter:respond` row.
- "Prompt registry" → pulses `PromptRef` + `RenderedPrompt` on the support entity.
- "Evaluation" → pulses `eval:Score` + `eval:Verdict`.
Each pulse fades after ~2.5s. Confirm no console errors.

- [ ] **Step 5: Full test sweep + typecheck + lint + commit**

```bash
pnpm -C packages/devtools test
pnpm -C examples exec vitest run tour
pnpm -C packages/devtools typecheck
pnpm lint:fix
git add packages/devtools/ui/src/components/InspectorTab.tsx packages/devtools/ui/src/components/SystemsTab.tsx packages/devtools/ui/src/styles.css
git commit -m "feat(devtools): pulse highlighted cards/rows for Learn 'Show me'"
```

---

## Self-Review

**Spec coverage:**
- Tour world with four exhibits → Task 1 (greeter, support, eval, bench all in `world.ts`). ✓
- Deterministic/offline → Task 1 (constant `greeterModel`, deterministic `contains` scorer, canned bench data). ✓
- `welcome` flag (only protocol addition) → Task 2. ✓
- Tour `main.ts` + OTel + README → Task 3. ✓
- Store: `learn` tab, highlight, welcome handling → Task 4. ✓
- 10-step guided script + predicate targeting → Task 5. ✓
- LearnTab with auto-navigate "Show me" + send → Task 6. ✓
- Highlight visualization → Task 7. ✓
- Testing: tour world test (Task 1), welcome server test (Task 2), store reducer test (Task 4), step-integrity test (Task 5). ✓
- Invariants (R3 data-only, R16 idle-only, deterministic/zero-network) → Global Constraints + enforced by reusing existing commands. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Two flagged confirmations are real verification steps, not gaps: (1) Task 1 Step 5 — confirm `EntityHandle.has` vs `.get(...) === undefined`; (2) Task 6 Step 3 — read `styles.css` custom-property names before using them. Both are "verify the exact local name," with a concrete fallback given.

**Type consistency:**
- `Highlight { components?: string[]; system?: string }` defined in Task 4, consumed identically in Tasks 6 (`pulse({ components })` / `pulse({ system })`) and 7 (`state.highlight?.components`, `state.highlight?.system`). ✓
- `LearnStep.showMe.highlightComponents` / `highlightSystem` (Task 5) map to `pulse({ components })` / `pulse({ system })` (Task 6). ✓ (note the deliberate name difference: step fields are `highlightComponents`/`highlightSystem`; the store `Highlight` fields are `components`/`system` — Task 6 translates between them.)
- `buildTourWorld`/`seedTour`/`Chat`/`WaitingReply` signatures identical across Task 1 (def), Task 1 test, and Task 3 (`main.ts`). ✓
- `welcome?: boolean` identical in protocol (Task 2), server option (Task 2), and reducer read `msg.welcome` (Task 4). ✓
- Component names referenced by predicates (`Chat`, `WaitingReply`, `PromptRef`, `RenderedPrompt`, `eval:Score`, `eval:Verdict`, `bench:ComparisonReport`) match those defined/seeded in Task 1 and the engine packages. System key `greeter:respond` matches `defineAgent({name:'greeter'})` + `defineSystem({name:'respond'})` (agent-scoped key is `<agent>:<system>`). ✓
