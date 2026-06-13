# Contributing to LangECS

LangECS is an Entity-Component-System runtime for LLM agents — an experiment in
"LangGraph.js, but the runtime is a living ECS world". Before writing code, read the two
design documents (see [Where design truth lives](#where-design-truth-lives)).

## Prerequisites

- **Node >= 20** (per `engines` in every `package.json`). The **sql-agent example needs
  Node >= 22.5** because it uses the built-in `node:sqlite` module (added in Node 22.5.0).
- **pnpm 11** — the repo pins `pnpm@11.1.0` via the `packageManager` field, so the easiest
  path is corepack:

  ```sh
  corepack enable
  ```

## Setup

```sh
pnpm install
```

That's it. Packages export TypeScript source directly during development
(`"exports": { ".": "./src/index.ts" }`), so you don't need a build step to run tests or
examples — `build` produces `dist/` for publishing.

## Commands

### Root (whole workspace)

| Command | What it does |
|---|---|
| `pnpm build` | Build all `packages/*` with tsdown (examples are excluded from build) |
| `pnpm test` | Run vitest across every workspace package, including `examples` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint` | `biome check .` |
| `pnpm lint:fix` | `biome check --write .` (format + autofix) |

### Per package

```sh
pnpm -C packages/<name> test        # vitest run
pnpm -C packages/<name> test:watch  # vitest watch mode
pnpm -C packages/<name> typecheck   # tsc --noEmit
pnpm -C packages/<name> build       # tsdown
```

where `<name>` is one of `core`, `stdlib`, `ai-sdk`, `langchain`, `persist-fs`,
`otel`, `devtools`. (`devtools` builds the React UI too: tsdown, then Vite into
`dist/ui`; `pnpm -C packages/devtools dev:ui` runs the UI dev server against a
live world.)

### Examples

Each example is a script in the single `examples` workspace package:

```sh
pnpm -C examples react-agent
pnpm -C examples sql-agent          # needs Node >= 22.5 (node:sqlite)
pnpm -C examples supervisor
pnpm -C examples reflection
pnpm -C examples human-in-the-loop
pnpm -C examples time-travel
```

Running a demo `main.ts` hits a real model and **requires `OPENAI_API_KEY` in a
repo-root `.env.local`** (loaded by `examples/_shared/env.ts`; no dotenv dependency).
`.env.local` is gitignored — never commit or print it.

**Tests never need network.** Every example ships a `*.test.ts` driven by `scriptedModel`
from `@langecs/core`, and unit tests across the repo are deterministic. The one
exception-shaped thing is the `ai-sdk` integration test, which is skipped automatically
when `OPENAI_API_KEY` is absent (`describe.skipIf`).

## Monorepo map

| Path | Package | Role |
|---|---|---|
| `packages/core` | `@langecs/core` | The engine: world, scheduler, snapshots, events, trace. **Zero runtime dependencies, isomorphic** (no `node:*` imports). Includes the in-memory persistence adapter and `scriptedModel`. |
| `packages/stdlib` | `@langecs/stdlib` | Standard components & systems (`Messages`, `Inbox`, retry, tool execution, approval) and agent presets (ReAct). |
| `packages/ai-sdk` | `@langecs/ai-sdk` | Model adapter wrapping the Vercel AI SDK (`ai` v6, peer dep). |
| `packages/langchain` | `@langecs/langchain` | Model adapter wrapping LangChain.js chat models (`@langchain/core` peer dep). |
| `packages/persist-fs` | `@langecs/persist-fs` | Filesystem persistence adapter (snapshots, history, time travel). |
| `packages/otel` | `@langecs/otel` | OpenTelemetry instrumentation over the observer surface (SPEC §14); `@opentelemetry/api` peer dep only, GenAI semconv for model/tool spans. |
| `packages/devtools` | `@langecs/devtools` | Visual inspector: Node server (WebSocket protocol + OTLP/HTTP JSON receiver) plus a React UI in `ui/` served from `dist/ui`. |
| `examples/` | `langecs-examples` | Six LangGraph.js ports (react-agent, sql-agent, supervisor, reflection, human-in-the-loop, time-travel). These are the **v1 acceptance test** — the experiment's verdict is judged on them. |

## Where design truth lives

- **`DESIGN.md`** — the decision record: *why* things are the way they are (execution
  model, persistence, multi-agent comms, deferred v2 items, known risks).
- **`SPEC.md`** — the engineering contract: *exact* engine semantics with numbered
  requirements (R1, R2, …) and the required test matrix (T1–T22). Where SPEC is more
  precise than DESIGN, **SPEC wins** — code conforming to SPEC wins disputes.

If you change engine behavior, cite the requirement number you're implementing or
amending.

## Engineering rules

- **Core stays zero-dependency and isomorphic** (SPEC R1). No runtime deps, no `node:*`
  imports, no Node-only globals in `packages/core`. Package boundaries enforce the
  architecture — don't weaken them.
- **Components hold only serializable data** (SPEC R3). Anything with functions — tool
  implementations, model clients, DB connections — registers on the world as a **named
  resource** (`world.register('tool:sql', impl)`) and is referenced from components by
  name. Snapshots must stay plain JSON.
- **Deterministic tests via `scriptedModel`; no network in unit tests.** The dirty-trigger
  scheduler is the subtlest part of the engine and is covered by an exhaustive
  deterministic test matrix (SPEC §12). Real-API integration tests are opt-in via
  `.env.local` and skip themselves when the key is missing.
- **Biome formats and lints** (single quotes, 2-space indent, 100-col lines — see
  `biome.json`). Run `pnpm lint:fix` before committing.
- ESM-only, TypeScript strict (`tsconfig.base.json`: `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). No `any` leaking into public
  signatures (SPEC R2).
