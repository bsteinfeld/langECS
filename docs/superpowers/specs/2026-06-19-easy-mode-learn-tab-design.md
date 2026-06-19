# Easy Mode — Guided Learn tab + dedicated tour world

**Date:** 2026-06-19
**Status:** Approved design, pending implementation plan
**Authority note:** This is tooling/examples (devtools UI + an example world). It must respect
engine invariants but does not change engine semantics. SPEC.md > DESIGN.md still governs the
engine; this doc governs the new example + UI surface only.

## Problem

A user familiar with the idea of an ECS but new to LangECS finds the DevTools inspector
(7 tabs) overwhelming and can't find or understand the recently added benchmarking
(`@langecs/eval`, `@langecs/bench`) and prompt-management (`@langecs/stdlib` prompt registry)
features. They want a simple, guided "easy mode" that teaches the mental model and shows the
new features in action, then a running dev server to explore.

## Goal

Deliver two things that work together:

1. **`examples/tour/`** — one new, fully **deterministic and offline (no API key)** example
   world that seeds every concept the lessons reference, started with a single command.
2. **A `📖 Learn` tab** in the existing DevTools UI — a step-by-step guided panel that explains
   each concept in plain English and can drive the rest of the UI ("Show me ▶") to the thing
   being described.

Non-goals (YAGNI): no standalone parallel UI app; no new persistence; no engine changes; no
authoring tool for lessons (steps are hardcoded data); no live model calls anywhere in the tour.

## Approach (chosen)

Decided during brainstorming:

- **Guided layer inside existing DevTools**, not a separate app — demystifies the real tabs
  rather than hiding them.
- **One dedicated tour world** seeding all exhibits at once, not teaching against several
  separate examples — one command, one coherent story.
- **Auto-navigate ("Show me")** — steps actively switch tab + select entity + highlight,
  rather than only instructing.
- **Keep OTel/Traces** in the tour so the Traces tab has real spans to explain.
- **Opt-in `welcome: true`** flag on `startDevtools` so the tour lands on the Learn tab while
  every other world is unchanged (still lands on Inspector).

## Component 1 — The tour world (`examples/tour/`)

All exhibits are data-only and offline, using `scriptedModel` from `@langecs/core`.

### Files

| File | Purpose |
|------|---------|
| `world.ts` | Pure builder `buildTourWorld()`: creates world, registers a `scriptedModel`, prompt registry, builtin scorers + eval systems, spawns the four exhibits, returns `{ world, refs }` (entity handles). No I/O, no devtools. |
| `main.ts` | Calls `buildTourWorld()`; runs one greeter exchange + resolves the prompt + scores the eval case so tabs have content; wires OTel→devtools; `startDevtools(world, { welcome: true })`; prints URL; SIGINT/SIGTERM close cleanly. |
| `tour.test.ts` | Deterministic vitest (zero network) asserting each exhibit's end state. |
| `README.md` | The same walkthrough in prose, for readers. |

Add `"tour": "tsx tour/main.ts"` to `examples/package.json` scripts.

### The four exhibits

1. **greeter** — the `hello-world` pattern: `Chat` (reducer-merged message array) +
   `WaitingReply` tag, with a `respond` system that calls the model and removes the tag. One
   scripted exchange is pre-run in `main.ts` so the transcript is non-empty and the entity is
   quiescent. Teaches entities / components / tags / systems / queries / quiescence.

2. **support** — a `reactAgent({ name: 'support', model: 'model:main' })` spawned with
   `PromptRef('tour-greeting@1.0.0')` + `PromptVars({...})`. The `resolvePrompt` system renders
   it to `RenderedPrompt`. Registry built with `inMemoryRegistry(definePrompts([...]))` +
   `registerPrompts`. Teaches versioned, pinned, injection-safe prompts.

3. **eval case** — an entity carrying `EvalInput` / `EvalExpected` / `EvalOutput` / `ScorerRef`
   (e.g. `'scorer:contains'`). After `registerBuiltinScorers` + `registerEvalSystems`, the
   engine's `scoreCase` → `verdictSystem` compute `Score` + `Verdict` live during a run. Teaches
   scorer → score → verdict, with one line on `llmJudgeScorer`. (We deliberately let the engine
   produce the verdict rather than hardcoding it, so step 7 shows systems *doing work*.)

4. **bench report** — a small **canned** `ComparisonReportData` (mirroring
   `examples/bench-devtools-demo/report.json`: gpt-5-nano vs gpt-4o-mini, 3 cases, pass/latency/
   tokens/cost) written into the world via `writeComparisonReport(world, report)` from
   `@langecs/bench`. No model calls. Teaches model comparison in the inspector.

### Determinism

`scriptedModel` supplies the greeter's reply and any support-agent turn. The bench report is a
literal object. The eval case's expected/output are literals; the scorer is deterministic
(`contains`). No `OPENAI_API_KEY` is read anywhere in the tour. OTel is wired purely to forward
engine spans (run/step/system) to devtools — it needs no key.

## Component 2 — The Learn tab (DevTools UI)

### Files touched

```
packages/devtools/ui/src/
  components/LearnTab.tsx      NEW  guided panel: renders current step, Back/Next, "Show me ▶"
  learn-steps.ts               NEW  step content as data + target-resolution helpers
  store.ts                     EDIT add 'learn' to Tab; add `highlight` state + 'highlight' action;
                                    default tab driven by hello.welcome
  App.tsx                      EDIT Learn as first tab entry + TabBody case
  components/InspectorTab.tsx  EDIT pulse a component card when it matches state.highlight
  components/SystemsTab.tsx    EDIT pulse a system row when it matches state.highlight
  styles.css                   EDIT learn-panel layout + highlight-pulse keyframes
packages/devtools/src/
  protocol.ts                  EDIT add optional `welcome?: boolean` to the `hello` message
  server.ts / index.ts         EDIT thread `welcome` from startDevtools options into hello
```

### Step data shape (`learn-steps.ts`)

```ts
type FindTarget = (world: WorldState) => number | undefined; // resolve entity by predicate
interface ShowMe {
  tab: Tab;                       // which tab to switch to
  find?: FindTarget;              // which entity to select (omit for tabs without a selection)
  highlight?: string[];          // component names (Inspector) or a system key (Systems)
}
interface LearnStep {
  id: string;
  title: string;
  body: string;                   // plain-English explanation (may include short inline code)
  showMe?: ShowMe;                // optional "Show me ▶" action
  action?: { kind: 'send'; ... }; // optional command (step 5 sends a message)
}
```

Targets resolve via predicates over `state.world.entities` (e.g. "entity that has a `Chat`
component", "entity whose components include `PromptRef`"), never hardcoded IDs — robust to
spawn order and reusable against other worlds.

### "Show me ▶" data flow

Button handler: resolve `find` against `state.world`; if undefined, the button is **disabled**
with a tooltip ("not present in this world"). Otherwise dispatch `select-entity`, `set-tab`, and
`highlight`. The target tab reads `state.highlight` and applies a pulse class; highlight clears
on the next step change or entity click. No new server round-trip — pure client state reusing
the engine's existing introspection surface. Step 5's "Send a message ▶" uses the **existing**
`send`/`run` command path (idle-only, R16); the Learn tab never bypasses it.

### Landing on Learn

`startDevtools(world, { welcome?: boolean })` → `welcome` carried on the `hello` message → on
`hello`, if `welcome` is true the store sets initial `tab` to `'learn'`. Default remains
`'inspector'` for every other world. This is the only protocol addition.

## The tour script (10 steps)

Part A — ECS mental model (greeter):
1. **Welcome** — what a "world" is + the one-line ECS vocabulary. (no Show me)
2. **Entities & Components** — Inspector / greeter, pulse `Chat`. "Components are plain data — the agent's whole memory."
3. **Tags** — pulse `WaitingReply`. "A valueless flag = a work order."
4. **Systems & queries** — Systems tab, pulse the `respond` row. "Fires when its query newly matches `[Chat, WaitingReply]`."
5. **Run & quiescence** — "Send a message ▶" (existing `send` command) → reply lands → Timeline tab shows the step. "Nothing left to run = quiescent = the run ends."

Part B — new features:
6. **Prompts** — Inspector / support, pulse `PromptRef` + `RenderedPrompt`. Versioned, pinned `@1.0.0`, injection-safe.
7. **Eval** — Inspector / eval-case, pulse `Score` + `Verdict`. Scorer → score → verdict; one line on llm-judge.
8. **Bench** — the bench report entity: pass-rate, latency, tokens, cost across two models.
9. **Traces** — Traces tab. "The same run, viewed as OpenTelemetry spans."
10. **Where next** — exact `pnpm` commands for `eval-react-agent`, `prompt-registry`, `bench-devtools-demo`, and a pointer to `SPEC.md`.

## Testing

- **`examples/tour/tour.test.ts`** (deterministic, zero network): build via `buildTourWorld()`,
  run the same setup `main.ts` does, then assert:
  - greeter ended quiescent with an assistant reply appended and `WaitingReply` removed;
  - support has a non-empty `RenderedPrompt` containing the injected vars;
  - the eval case has `Verdict === 'pass'` and `Score === 1`;
  - the bench report component is present with two candidates.
- **Step-integrity unit test**: every `LearnStep.showMe.find` predicate resolves to an entity in
  the freshly built tour world (catches a step pointing at a renamed/removed component).
- UI rendering itself is not unit-tested (consistent with the existing UI, which has none);
  correctness of navigation is covered by the step-integrity test + manual verification.

## Invariants honored

- Components stay **data-only** (R3); behavior (model, scorers, prompt render closures) lives in
  registries.
- DevTools mutations stay **idle-only** (R16); the Learn tab only reads + uses existing commands.
- `@langecs/core` stays dependency-free/isomorphic (R1) — untouched.
- Tour is **deterministic, zero-network** per the project test rule.

## Open implementation details (confirm while building, not blocking)

- Exact `ComparisonReportData` type import path from `@langecs/bench` (re-exported from its
  index; mirror the `report.json` literal).
- Whether `SystemsTab` keys systems by `system.key` for highlight matching (confirm field name
  on `SystemInfo`).
- `reactAgent` support-agent wiring detail: ensure it reaches quiescence after `resolvePrompt`
  without needing a live model turn (may carry a scripted turn or simply resolve the prompt and
  stop).
