# Examples

Sixteen runnable examples, organized as a learning path: minimal starters,
real-world workflows, multi-agent patterns, and the six LangGraph.js ports that
gated the v1 experiment — each port's README contains a deliberately honest
side-by-side comparison with the original, including where the original wins.
If you're coming from LangGraph.js, read
[the concept map](../docs/langgraph-comparison.md) first; for the patterns these
examples share (fan-out/fan-in, reducer-merge, supervisor, reflection…) see
[PATTERNS.md](PATTERNS.md).

Each example has the same shape:

- a definition module (`agent.ts`, `pipeline.ts`, `crew.ts`, …) —
  components/systems/agent bundles shared by demo and test (hello-world is so
  small that `main.ts` is the whole program)
- `main.ts` — live demo against OpenAI `gpt-4o-mini` (via `@langecs/ai-sdk`);
  order-pipeline is the exception with zero model calls
- `*.test.ts` — deterministic choreography test using core's `scriptedModel`:
  zero network, no API key, asserts the exact step-by-step schedule from the
  flight recorder (`world.getTrace()`)
- `README.md` — what it teaches; for the ports, also the honest comparison

## Running them

```sh
pnpm install                                # repo root, once
echo 'OPENAI_API_KEY=sk-...' >> .env.local  # repo root, gitignored
pnpm -C examples <name>                     # live demo (any name from the tables below)
```

The `main.ts` demos read `OPENAI_API_KEY` from the repo-root `.env.local`
(loaded by [`_shared/env.ts`](_shared/env.ts) — no dotenv dependency; real env
vars take precedence).

The tests need **no key and no network** — every model turn is scripted:

```sh
pnpm -C examples test                          # all thirteen
pnpm -C examples exec vitest run react-agent   # one example
```

Node ≥ 20 works for everything except **sql-agent**, which uses `node:sqlite`
and needs **Node ≥ 22.5** (add `--experimental-sqlite` below 23.4; this repo
targets Node 24, where it just works modulo an `ExperimentalWarning`).

**No event handling required.** Every new example's `main.ts` is
await-and-read-state: `await world.run()` (or `ask`/`sendMessage`), then read
components straight off the entities. Streaming is opt-in — the run is also an
`AsyncIterable<RunEvent>`; see [supervisor](supervisor/) for the full
event-stream demo (live tokens, step logging, error events).

## Start here

| Example | One teaching sentence | Run |
|---|---|---|
| [hello-world](hello-world/) | A chat agent from raw parts — one component, one tag, one system; the reply appends, the tag is removed, quiescence ends the run, and conversation memory is just state that never went anywhere | `pnpm -C examples hello-world` |
| [order-pipeline](order-pipeline/) | A no-LLM workflow engine — five orders flow through stage components concurrently, one fails and is healed by the stdlib `retry` system while the others keep advancing in the same steps | `pnpm -C examples order-pipeline` |
| [tools-from-scratch](tools-from-scratch/) | The tool loop demystified — `think` ↔ `act` built by hand with no loop construct, so `reactAgent` stops being magic (self-writes never retrigger; a foreign append is the return edge) | `pnpm -C examples tools-from-scratch` |
| [devtools-demo](devtools-demo/) | The whole world on screen — the [`@langecs/devtools`](../packages/devtools) inspector plus OpenTelemetry traces on a seeded support desk: edit components live, approve a refund interrupt, watch retry heal a failure, time-travel; **no API key needed** (run `pnpm build` once first for the UI) | `pnpm -C examples devtools-demo` |

## Real-world workflows

| Example | Demonstrates | Run |
|---|---|---|
| [support-desk](support-desk/) | Entities as work items, systems as workers: four tickets triaged in one concurrent step, routed by `when` guards, with per-ticket `AwaitingHuman` escalation that blocks nobody else; `extractJson` for typed triage | `pnpm -C examples support-desk` |
| [content-pipeline](content-pipeline/) | A staged blog-post pipeline with no orchestrator or edges: `ctx.spawn` fan-out to one `Section` entity per heading, all drafted in a single step, fan-in via an append reducer and a count guard | `pnpm -C examples content-pipeline` |
| [code-review-crew](code-review-crew/) | Three reviewer systems share one query, so a single send fans out to three parallel model calls; the step barrier is the join — `Findings` can't be deduped until every reviewer's append commits | `pnpm -C examples code-review-crew` |
| [rag-qa](rag-qa/) | Retrieval-Augmented Generation as a pipeline: `extractJson` decomposes the question into sub-queries, one retriever entity is spawned per query and they all run in parallel, and an append reducer fans their passages back in before a grounded, cited answer | `pnpm -C examples rag-qa` |
| [context-window](context-window/) | Keep a long conversation under a token budget with one line — `withMessageWindow` trims what each model call sees while the full transcript stays durable state; shows the honest memory trade-off | `pnpm -C examples context-window` |

## Multi-agent

| Example | Demonstrates | Run |
|---|---|---|
| [research-team](research-team/) | A planner spawns one researcher *agent* per sub-question at runtime; researchers fill a shared blackboard in parallel, a critic drives one bounded revision cycle, and a global token-budget watchdog quiesces the team gracefully with partial results | `pnpm -C examples research-team` |
| [supervisor](supervisor/) | Parallel worker fan-out in one step, deterministic `Inbox` fan-in via reducer, mid-run agent spawning, crash → `SystemError` → heal — also the full run event-stream demo (a LangGraph port; verdict below) | `pnpm -C examples supervisor` |
| [reflection](reflection/) | Writer ↔ critic alternation from self-write exclusion alone; the loop terminates by removing a `Reflecting` tag, not by counting messages (a LangGraph port; verdict below) | `pnpm -C examples reflection` |

## LangGraph ports + verdicts

Six ports of canonical LangGraph.js examples — the acceptance gate for the v1
experiment ("is ECS a good organizing structure for LLM agents?"). The
aggregate judgment is in [docs/experiment-verdict.md](../docs/experiment-verdict.md).

| Example | Demonstrates | LangGraph.js original | Run |
|---|---|---|---|
| [react-agent](react-agent/) | The `callLLM` ↔ `executeTools` dirty-trigger loop (an agent loop with no edges), token streaming through the single run event stream | [quickstart](https://github.com/langchain-ai/langgraphjs/tree/main/examples/quickstart) | `pnpm -C examples react-agent` |
| [sql-agent](sql-agent/) | English → SQL → answer over a seeded `node:sqlite` DB; tool errors fed back as `tool` messages the model recovers from; `--trace` flight-recorder dump | [sql-agent](https://github.com/langchain-ai/langgraphjs/tree/main/examples/sql-agent) | `pnpm -C examples sql-agent "Which album has the most tracks?"` |
| [supervisor](supervisor/) | Parallel worker fan-out, `Inbox` fan-in, mid-run spawning (`ctx.spawn`), crash → heal → auto-clear | [agent_supervisor.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/agent_supervisor.ipynb) | `pnpm -C examples supervisor` |
| [reflection](reflection/) | Writer ↔ critic cycle with no router; termination by tag removal | [reflection.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/reflection/reflection.ipynb) | `pnpm -C examples reflection` |
| [human-in-the-loop](human-in-the-loop/) | `needsApproval` tool → run status `'pending'`; process exits mid-conversation and a **different process** loads the `@langecs/persist-fs` snapshot and resumes | [review-tool-calls.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/review-tool-calls.ipynb) | `pnpm -C examples human-in-the-loop`, then `... --resume` |
| [time-travel](time-travel/) | Per-step checkpoint history (`MemoryAdapter`), rewind via `loadStep`, fork into a fresh world while the original timeline stays intact | [time-travel.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/time-travel.ipynb) | `pnpm -C examples time-travel` |

One honest verdict per port, condensed. Read the full per-example READMEs for
the receipts.

**react-agent — par, with different strengths.** For a single ReAct agent,
LangGraph's `createReactAgent({ llm, tools })` is genuinely shorter and better
supported. LangECS wins on runtime transparency (one typed event stream versus
four `streamMode`s; the trace asserts the exact choreography in ~20 lines) and
the total absence of routing code — `callLLM` setting `PendingToolCalls` *is*
the routing, quiescence *is* `__end__`. [Full comparison →](react-agent/README.md)

**sql-agent — roughly par, with opposite strengths.** Staged pipelines are
LangGraph's home turf: its graph *enforces* the
`list_tables → … → check_query → run` ordering this port only encourages via
prompt — which measurably mattered. LangECS wins decisively on testability,
observability, error-as-policy (a rejected `DELETE` comes back as a tool
message the model reacts to), and ceremony: the equivalent of the ~120-line
graph is zero lines. [Full comparison →](sql-agent/README.md)

**supervisor — better than the original at the mechanics this pattern is
about.** Parallel dispatch in one step, deterministic `Inbox` fan-in,
mid-run spawning, and crash-as-queryable-state are all natural ECS moves —
impossible or restructure-required in the compiled graph. Routing is now typed
and validated via stdlib `extractJson` (a schema + a one-shot retry, no
hand-parsing); it still loses on flow legibility and ecosystem.
[Full comparison →](supervisor/README.md)

**reflection — the dirty-triggering showcase.** The writer↔critic cycle that
LangGraph needs three edges and a counting router for is simply what the
scheduler does, and tag-removal termination beats the original's
`messages.length > 6` magic number. But the control flow is *emergent* — a
newcomer reads explicit edges faster. Better runtime semantics and
testability; worse immediate legibility. [Full comparison →](reflection/README.md)

**human-in-the-loop — genuinely nicer for tool approval specifically.** One
`needsApproval: true` flag replaces `interrupt()` + `Command({ resume })` +
checkpoint plumbing, with no replay-on-resume footgun and human-readable JSON
suspended state. The flip side: LangGraph's `interrupt()` can pause *anywhere*
with typed payloads; a LangECS pause point must be designed in advance.
[Full comparison →](human-in-the-loop/README.md)

**time-travel — par overall.** LangECS wins on snapshot transparency (diffable
JSON keyed by a plain step integer), fork isolation, and deterministic testing
of exact-boundary resume. LangGraph wins on ergonomics: in-place branching,
one-call replay, node-attributed state edits. Exploring interactively: the
original has less friction; auditing your timelines: this version is easier to
trust. [Full comparison →](time-travel/README.md)

## See also

- [LangECS for LangGraph.js developers](../docs/langgraph-comparison.md) — the concept map
- [DESIGN.md](../DESIGN.md) — why ECS; [SPEC.md](../SPEC.md) — the engine contract (R1–R44)
- [Prior art](../docs/prior-art.md) · [Naming](../docs/naming.md)
