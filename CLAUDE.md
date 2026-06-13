# CLAUDE.md

## What this is

LangECS: a TypeScript pnpm monorepo implementing an Entity-Component-System runtime for
LLM agents — "LangGraph.js, but the runtime is a living ECS world". v1 is a
validate-by-porting experiment: six LangGraph.js example ports in `examples/` are the
acceptance gate.

## Authority order

For engine semantics: **SPEC.md > DESIGN.md**. SPEC.md is the contract with numbered
requirements (R1…R48) and the required test matrix (T1–T26); DESIGN.md records *why*.
Code conforming to SPEC wins disputes. Cite requirement numbers when touching the engine.

## Commands

```sh
pnpm install                      # setup (Node >= 20, pnpm 11 via corepack)
pnpm build / test / typecheck     # root, all workspace packages
pnpm lint / lint:fix              # Biome; run lint:fix before committing
pnpm -C packages/<name> test      # core | stdlib | ai-sdk | langchain | persist-fs
pnpm -C packages/<name> typecheck | build | test:watch
pnpm -C examples <example>        # react-agent | sql-agent | supervisor | reflection |
                                  # human-in-the-loop | time-travel (runs main.ts via tsx)
```

sql-agent example needs Node >= 22.5 (`node:sqlite`). Packages export `./src/index.ts`
directly — no build step needed for dev.

## Hard invariants

- **`@langecs/core` has zero runtime dependencies and is isomorphic** — no `node:*`
  imports, no Node-only globals (R1).
- **Components are data-only** (JSON/structured-clone serializable, R3). Behavior (tools,
  model clients, DB handles) lives in named world registries; components reference it by
  name (`world.register('model:main', …)` + `ModelRef('model:main')`).
- **Dirty-triggered step scheduler with self-write exclusion**: pairs fire only on
  foreign writes or new query matches; a pair's own writes never retrigger it.
  **Read SPEC.md §5 (R25–R32) before touching the scheduler** — it is the subtlest part
  of the engine. Reads inside a step see step-start state; writes buffer to the barrier.
- **Same-step writes to one component+entity by different pairs**: merged via the
  component's reducer if it has one, otherwise `WriteConflictError` at the barrier (R30).
  Silent last-write-wins must stay impossible.
- **Tests are deterministic, zero network** — use `scriptedModel` from core. Integration
  tests gate on `OPENAI_API_KEY` and skip when absent.

## Where things live

- `packages/core` — engine (world, scheduler, snapshot, events, trace, MemoryAdapter,
  scriptedModel)
- `packages/stdlib` — standard components/systems + ReAct preset
- `packages/ai-sdk`, `packages/langchain` — model adapters (Vercel AI SDK / LangChain.js)
- `packages/persist-fs` — filesystem persistence adapter
- `packages/otel` — OpenTelemetry bridge over `world.observe` (SPEC §14); peer-deps only
  `@opentelemetry/api`, GenAI semconv for model/tool spans
- `packages/devtools` — inspector GUI: Node server (WS + OTLP/HTTP JSON receiver at
  `/v1/traces`) + React UI (`ui/`, built to `dist/ui` via Vite); idle-only mutation (R16)
- `examples/` — the six v1-gating LangGraph ports; `examples/_shared/env.ts` loads
  `.env.local`

## Secrets

Repo-root `.env.local` holds `OPENAI_API_KEY` for examples and integration tests. It is
gitignored — never commit it, never read or print its contents.
