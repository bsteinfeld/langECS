# World tab — a scene view for DevTools

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan
**Authority note:** This is tooling only (devtools UI). It must respect engine invariants —
especially idle-only external mutation (R16) — but changes no engine semantics. SPEC.md >
DESIGN.md still governs the engine; this doc governs the new UI surface only.

## Problem

LangECS pitches "your agents live in a world", and the architecture genuinely is one — but
nothing ever *shows* the world. DevTools is Unity's Inspector panel without Unity's Scene
view: entity lists, JSON trees, timelines, all text. A newcomer who understands what an ECS
is still has nowhere to *look* to see entities existing in a place, systems acting on them,
and messages moving. The gap is a spatial, game-engine-style view of a running world.

## Goal

A new **🌍 World tab** in the existing DevTools UI: a pannable, zoomable top-down 2D scene
that renders **any** live LangECS world as tokens in space — playful (speech bubbles,
activity pulses), interactive (click a token, act on the entity), and truthful (every signal
derived from real engine state, every mutation through the engine's public API).

Non-goals (YAGNI): no standalone viewer app; no canvas/WebGL renderer; no engine changes;
no new server endpoints or protocol (at most additive fields on existing WS messages — see
Liveness); no graph/edge overlay (v2); no Learn-tab integration (v2); no custom token skins
(v2); no new npm dependencies in the UI.

## Approach (chosen)

Decided during brainstorming (visual companion mockups reviewed and approved):

- **Scene view, not graph, not diorama** — a top-down 2D board like Unity's scene view, but
  keeping the diorama's charm: expressive tokens, speech bubbles, animated activity.
- **Layout toggle, `Zones | Free`** — Zones auto-places tokens into inferred districts
  (zero setup, any world instantly legible); Free lets the user drag tokens anywhere and
  DevTools remembers the arrangement browser-side. A third option, **`Spatial`**, appears
  only when the world carries real `{x, y}` data (e.g. playground's `Position`) and renders
  entities at their true coordinates.
- **Full side panel on selection** — chat transcript + send box, editable component trees,
  add/remove component, despawn — composed from the machinery the Inspector tab already has.
- **DOM + React, no new deps** — tokens are React components; pan/zoom is a CSS transform;
  animations are CSS. Right-sized for real worlds (tens to low hundreds of entities); the
  token layer could be swapped for canvas later without changing the tab's design.
- **World is the leftmost tab and the default landing tab** — it is the approachable face of
  DevTools. The tour's opt-in `welcome` flow still lands on Learn, unchanged.

## UI structure

```
┌ tab bar: 🌍 World | Inspector | Systems | Timeline | Traces | Events | Interrupts |
│          Time travel | 📖 Learn                                                              ┐
├ toolbar: Layout [Zones|Free(|Spatial)] · zoom % · spawn ⊕ · ● live/idle · step N            ┤
├──────────────────────────────────────────────┬───────────────────────────────────────────────┤
│ canvas (pan/zoom)                            │ side panel (visible when a token is selected) │
│   dashed zone rectangles with labels         │   header: icon, name, entity id, despawn     │
│   tokens: icon, name, id, status line        │   chat transcript + send box (if Chat-like)  │
│   speech bubbles / pulses / tool effects     │   components as editable JSON trees          │
│                                              │   + add component                            │
└──────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

**Tokens.** Icon by kind — 🤖 agent, 🧪 eval, 📊 bench, ⬡ generic — plus the entity's
display name (a `Name`-like component when present, else the entity id), the id, and a
one-line status (e.g. "✓ replied", "⚙ renderPrompt running…", "score 1.0 · pass"). Click
selects (opens the side panel); selection is the store's existing entity selection, so it
stays in sync with the Inspector tab.

**Toolbar.** Layout toggle; zoom indicator/reset; a spawn button opening the existing
`SpawnModal`; a live indicator showing run state and current step.

## Placement engine

**Zone classification** is a pure function `classifyEntity(components) → 'agents' | 'evals'
| 'bench' | 'other'`, tested in isolation:

- any component name starting `eval:` → **Evals**
- any component name starting `bench:` → **Bench**
- agent-shaped → **Agents** — reuse the agent detection the server already applies for agent
  auto-tags (Systems tab) where the store has it; fall back to component-name heuristics
  (`Chat`, model-ref components) otherwise. Exact predicate finalized during implementation
  against stdlib's real names.
- else → **Other**

Zones render as labeled dashed rectangles sized to their population; tokens flow within a
zone in a deterministic order (by entity id) so re-renders don't shuffle the world. Empty
zones are hidden.

**Free layout** stores dragged positions in `localStorage` under
`langecs-devtools:world-layout:<worldId>` as `{ [entityId]: {x, y} }`. Entities without a
saved position get a deterministic grid slot. Nothing is ever written into the world —
layout is a browser-side concern, invisible to the engine.

**Spatial detection.** An entity is spatially placeable if some component's value is an
object with numeric `x` and `y` (first such component, alphabetical by name). The `Spatial`
toggle option renders only if at least one entity qualifies; non-qualifying entities collect
in an "unplaced" tray at the bottom edge.

## Liveness signals

All derived from streams the UI store already receives — the scene gives existing data a
body, it invents nothing:

| Signal | Source | Rendering |
|---|---|---|
| speech bubble (~4 s, truncated) | snapshot diff: a `Chat`-transcript-like component gained an assistant message | bubble above the token |
| system pulse | run events / timeline: a (system, entity) pair currently running | purple pulse ring + status line names the system |
| tool-call effect | tool events already present in the event stream | brief effect on the token |
| spawn / despawn | snapshot diff | token fades in / out |

Honor `prefers-reduced-motion`: animations collapse to static state changes (bubble appears
without bobbing, pulse becomes a plain highlight).

If some pair-level liveness detail turns out not to be in the existing WS messages, extend
an existing message shape additively — no new protocol, no new endpoints.

## Interaction & mutation

The side panel is composed from existing pieces: `JsonTree` (editable component values),
`ChatTranscript` + send, add/remove component, despawn — all through the existing command
plumbing. It therefore inherits idle-only mutation (R16) for free: while a run is in flight
the server rejects the edit and the existing toast surfaces the error. The World tab adds
zero new ways to bypass engine invariants.

Time travel composes for free: restoring a step replaces the store snapshot, so the scene
simply shows the world as it was.

## Files

| File | Purpose |
|------|---------|
| `packages/devtools/ui/src/components/WorldTab.tsx` | the tab: canvas, zones, tokens, toolbar, side panel composition |
| `packages/devtools/ui/src/world/zones.ts` | pure zone classification + spatial detection |
| `packages/devtools/ui/src/world/layout-store.ts` | free-layout persistence (localStorage) + deterministic fallback slots |
| `packages/devtools/ui/src/world/zones.test.ts` | unit tests: component sets → zones; spatial detection |
| `packages/devtools/ui/src/world/layout-store.test.ts` | store tests, same style as `learn-store.test.ts` |
| `App.tsx`, `store.ts`, `styles.css` (modify) | tab registration, default-tab change, any new store selectors, styles |
| `packages/devtools/README.md` (modify) | add World row to the panel table |
| `examples/playground/main.ts` (modify) | startup message points at the World tab |

## Testing

Follows the package's existing patterns — deterministic, zero network:

- **Unit:** `classifyEntity` over representative component sets (tour agents, eval case,
  bench report, playground entities, empty); spatial detection shapes.
- **Store:** free-layout persistence round-trip, fallback slots, per-world keying — same
  vitest setup as the existing `learn-store` tests (DOM-aware ui project).
- **Component:** token renders name/icon/status; clicking selects and opens the side panel;
  layout toggle switches placement; side panel edit path dispatches the existing commands.
- **Manual:** `examples/playground` (spatial world, idle) and `examples/tour` (agents, eval,
  bench, live steps) are the two demo worlds.

## v2 ideas (recorded, not built)

Graph-style relationship edges as an overlay toggle (who watches whom); Learn-tab "Show me"
steps that highlight World-tab tokens; canvas/WebGL token layer for very large worlds;
custom token icons per component.
