# Examples

Six ports of canonical LangGraph.js examples, rebuilt on LangECS. They are the
acceptance gate for the v1 experiment ("is ECS a good organizing structure for LLM
agents?"), so each directory's README contains a deliberately honest side-by-side
comparison with the original — including where the original wins. If you're coming
from LangGraph.js, read [the concept map](../docs/langgraph-comparison.md) first.

Each example has the same shape:

- `agent.ts` — components/systems/agent definition, shared by demo and test
- `main.ts` — live demo against OpenAI `gpt-4o-mini` (via `@langecs/ai-sdk`)
- `*.test.ts` — deterministic choreography test using core's `scriptedModel`:
  zero network, no API key, asserts the exact step-by-step schedule from the
  flight recorder (`world.getTrace()`)
- `README.md` — how it works + the honest comparison

## Running them

```sh
pnpm install                                # repo root, once
echo 'OPENAI_API_KEY=sk-...' >> .env.local  # repo root, gitignored
pnpm -C examples <name>                     # live demo (any name from the table below)
```

The `main.ts` demos read `OPENAI_API_KEY` from the repo-root `.env.local`
(loaded by [`_shared/env.ts`](_shared/env.ts) — no dotenv dependency; real env
vars take precedence).

The tests need **no key and no network** — every model turn is scripted:

```sh
pnpm -C examples test                          # all six
pnpm -C examples exec vitest run react-agent   # one example
```

Node ≥ 20 works for everything except **sql-agent**, which uses `node:sqlite`
and needs **Node ≥ 22.5** (add `--experimental-sqlite` below 23.4; this repo
targets Node 24, where it just works modulo an `ExperimentalWarning`).

## Index

| Example | Demonstrates | LangGraph.js original | Run |
|---|---|---|---|
| [react-agent](react-agent/) | The `callLLM` ↔ `executeTools` dirty-trigger loop (an agent loop with no edges), token streaming through the single run event stream | [quickstart](https://github.com/langchain-ai/langgraphjs/tree/main/examples/quickstart) | `pnpm -C examples react-agent` |
| [sql-agent](sql-agent/) | English → SQL → answer over a seeded `node:sqlite` DB; tool errors fed back as `tool` messages the model recovers from; `--trace` flight-recorder dump | [sql-agent](https://github.com/langchain-ai/langgraphjs/tree/main/examples/sql-agent) | `pnpm -C examples sql-agent "Which album has the most tracks?"` |
| [supervisor](supervisor/) | Parallel worker fan-out in one step, deterministic `Inbox` fan-in via reducer, mid-run agent spawning (`ctx.spawn`), crash → `SystemError` → heal → auto-clear | [agent_supervisor.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/agent_supervisor.ipynb) | `pnpm -C examples supervisor` |
| [reflection](reflection/) | Writer ↔ critic alternation from self-write exclusion alone; loop terminates by removing a `Reflecting` tag, not by counting messages | [reflection.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/reflection/reflection.ipynb) | `pnpm -C examples reflection` |
| [human-in-the-loop](human-in-the-loop/) | `needsApproval` tool → run status `'pending'`; process exits mid-conversation and a **different process** loads the `@langecs/persist-fs` snapshot and resumes | [review-tool-calls.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/review-tool-calls.ipynb) | `pnpm -C examples human-in-the-loop`, then `... --resume` |
| [time-travel](time-travel/) | Per-step checkpoint history (`MemoryAdapter`), rewind via `loadStep`, fork into a fresh world with a divergent input while the original timeline stays intact | [time-travel.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/time-travel.ipynb) | `pnpm -C examples time-travel` |

## Verdicts

One honest paragraph per example, condensed from each directory's comparison
section. Read the full per-example READMEs for the receipts.

**react-agent — par, with different strengths.** For a single ReAct agent,
LangGraph's `createReactAgent({ llm, tools })` is genuinely shorter and better
supported; LangECS needs three wiring steps (model resource, `registerTools`,
`spawn`) and its `'model:main'` indirection is stringly-typed. LangECS wins on
runtime transparency — one typed event stream covers steps, timings, and tokens
(versus four `streamMode`s), and the trace lets the test assert the exact
choreography in ~20 lines — and on the total absence of routing code: `callLLM`
setting `PendingToolCalls` *is* the routing, quiescence *is* `__end__`. The ECS
shape is a bet that pays off later (many agents, one world), not a clear win at
quickstart size. [Full comparison →](react-agent/README.md)

**sql-agent — roughly par, with opposite strengths.** The original is a staged
pipeline (`list_tables → get_schema → generate → check_query → run`), and staged
pipelines are LangGraph's home turf: its graph *enforces* an ordering and a
query-review pass that this port only encourages via prompt — which measurably
mattered, as gpt-4o-mini initially joined on the wrong column and returned a
wrong answer until the prompt was sharpened. LangECS wins decisively on
testability (the step-resolution choreography test has no LangGraph
equivalent), observability, error-as-policy (a rejected `DELETE` comes back as
a tool message the model reacts to), and sheer ceremony — the equivalent of the
~120-line graph is zero lines. If your SQL agent is "ReAct with good tools",
LangECS is the clearer program; if it must be exactly five stages in order,
port the graph. [Full comparison →](sql-agent/README.md)

**supervisor — better than the original at the mechanics this pattern is
about.** Parallel dispatch (both workers in one step, one routing call instead
of N+1 sequential supervisor hops), deterministic `Inbox` fan-in at the
barrier, spawning the writer agent mid-run, and crash-as-queryable-state with a
20-line `heal` system are all natural ECS moves — impossible or
restructure-required in the compiled graph. It loses on routing ergonomics
(LangGraph forces the decision through a zod-validated tool call; our
supervisor hand-parses raw JSON — the weakest part of the port), on flow
legibility, and on ecosystem. For a production supervisor today LangGraph's
tooling still wins; this port's value is the same pattern with strictly fewer
moving parts and stronger runtime introspection.
[Full comparison →](supervisor/README.md)

**reflection — the dirty-triggering showcase.** The writer↔critic cycle that
LangGraph needs three edges and a counting router for is simply what the
scheduler does: each system's own `Messages` append never re-fires itself but
wakes the other. Termination by removing the `Reflecting` tag is cleaner and
more inspectable than the original's `messages.length > 6` magic number, and
the budget is overridable per spawn. But the control flow is *emergent* — a
newcomer reads `generate → reflect → generate` edges faster than dirty rules —
the turn-taking convention (`msg.meta.author`) can fail silently, and the code
volume is roughly equal. Better runtime semantics and testability; worse
immediate legibility. [Full comparison →](reflection/README.md)

**human-in-the-loop — genuinely nicer for tool approval specifically.** One
`needsApproval: true` flag replaces `interrupt()`, `Command({ resume })`, and
checkpoint/thread plumbing; there is no replay-on-resume footgun (LangGraph
re-executes the interrupted node from the top — the test here proves the tool
runs exactly once); and the suspended state is human-readable JSON you can
`cat`. Kill-and-resume across real processes is the demo, not an exercise. The
flip side: `interrupt()` can pause *anywhere* in a node with typed
payload/resume values, while a LangECS pause point must be designed in advance
as guard + `Not()` choreography — real work the stdlib has only done for tool
approval (approve/deny; no edit-the-call preset).
[Full comparison →](human-in-the-loop/README.md)

**time-travel — par overall.** LangECS wins on snapshot transparency (a
checkpoint is diffable JSON keyed by a plain step integer, not an opaque
checkpoint UUID found by sniffing `getStateHistory`), fork isolation (a fork is
a separate world; the test proves the original timeline and its history are
untouched), and deterministic testing of exact-boundary resume. LangGraph wins
on ergonomics: in-place branching within one thread, one-call replay from any
checkpoint, and node-attributed state edits, versus LangECS's
construct-world → `use` → re-register resources → `load` per fork. Exploring
trajectories interactively: the original has less friction. Auditing and
trusting your timelines: this version is easier to reason about.
[Full comparison →](time-travel/README.md)

## See also

- [LangECS for LangGraph.js developers](../docs/langgraph-comparison.md) — the concept map
- [DESIGN.md](../DESIGN.md) — why ECS; [SPEC.md](../SPEC.md) — the engine contract (R1–R44)
- [Prior art](../docs/prior-art.md) · [Naming](../docs/naming.md)
