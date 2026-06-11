# SQL agent

English → SQL → answer. A ReAct agent that answers natural-language questions
against a seeded SQLite database (3 tables: `artists`, `albums`, `tracks`) with
three read-only tools:

| tool | input | output |
|---|---|---|
| `list_tables` | — | comma-separated table names |
| `get_schema` | comma-separated table names | `CREATE TABLE` DDL + 3 sample rows per table |
| `run_query` | a single `SELECT` | rows as JSON; **anything non-SELECT is rejected** |

There is no graph. The agent is the stdlib `reactAgent` preset plus a SQL
system prompt; the loop *LLM → tool → LLM → … → answer* emerges from
dirty-triggering: `executeTools` appending a `tool` message to `Messages` is
foreign dirt that re-fires `callLLM`, and a reply without tool calls removes
`MessageWaiting`, so the world goes quiescent — that's the answer.

Files:

- `db.ts` — `node:sqlite` database seeding + the three `ToolDef`s
- `agent.ts` — the agent definition (the actual "agent" is ~10 lines) and a
  `createSqlAgentWorld(model)` helper shared by demo and test
- `main.ts` — live demo: streams tokens, prints step progress and tool traffic
- `sql-agent.test.ts` — deterministic choreography tests (`scriptedModel`, zero network)

## Run

Requires **Node ≥ 22.5** for `node:sqlite` (below 23.4 you need
`--experimental-sqlite`; on 23.4+ it works out of the box but prints an
`ExperimentalWarning` — this repo targets Node 24). Put `OPENAI_API_KEY` in the
repo-root `.env.local`, then:

```sh
pnpm -C examples sql-agent
pnpm -C examples sql-agent "What is the longest track?"          # your own question
pnpm -C examples sql-agent "Which album has the most tracks?" --trace   # + flight recorder
```

Deterministic tests (no network, no API key):

```sh
pnpm -C examples exec vitest run sql-agent
```

The live run takes 7–9 steps depending on how many `get_schema` calls the model
decides to make; the scripted test pins one canonical 7-step choreography.

## Comparison with the LangGraph.js original

Original: [`examples/sql-agent/sql_agent.ts`](https://github.com/langchain-ai/langgraphjs/tree/main/examples/sql-agent)
(~400 lines; also published as the [SQL agent tutorial](https://langchain-ai.github.io/langgraphjs/tutorials/sql-agent/)).
It builds a fixed pipeline of dedicated nodes over `MessagesAnnotation` state:

```ts
const builder = new StateGraph(MessagesAnnotation)
  .addNode("list_tables", listTables)
  .addNode("call_get_schema", callGetSchema)
  .addNode("get_schema", getSchemaNode)
  .addNode("generate_query", generateQuery)
  .addNode("check_query", checkQuery)
  .addNode("run_query", runQueryNode)
  .addEdge(START, "list_tables")
  .addEdge("list_tables", "call_get_schema")
  .addEdge("call_get_schema", "get_schema")
  .addEdge("get_schema", "generate_query")
  .addConditionalEdges("generate_query", shouldContinue)
  .addEdge("check_query", "run_query")
  .addEdge("run_query", "generate_query");
```

plus a second near-duplicate graph for the human-in-the-loop variant, an
`interrupt()`-wrapping query tool, and a TypeORM/`better-sqlite3`/`SqlDatabase`
stack for DB access. The LangECS version is `reactAgent` + 3 tools + 1 prompt;
the equivalent of the graph above is zero lines.

### Where LangECS is better

- **Less machinery for the loop itself.** The original spends ~120 lines on
  node functions and graph wiring to express "call tools until you have an
  answer". Here that loop is engine semantics; the example's code is almost
  entirely *domain* code (the DB and the tools). `agent.ts` is 63 lines, most
  of which is the system prompt.
- **Deterministic, step-resolution tests.** `scriptedModel` + the flight
  recorder let the test assert the exact (system, entity) schedule of every
  step, that `toolApproval` was scheduled-and-vetoed, what the model was sent
  each turn, and that each tool result landed as a `tool` message — with zero
  network. The original example ships with no tests, and testing it would mean
  mocking `ChatOpenAI` inside the compiled graph.
- **Observability is uniform, not bolted on.** One `for await` over the run
  yields typed events: step schedules, per-system timings, mid-step streamed
  tokens (`ctx.emit`), applied changes. `--trace` dumps the same data
  post-hoc from the ring buffer. The original gets streaming of *values* via
  `streamMode: "values"` but nothing equivalent to the vetoed/writes/timing
  trace.
- **Error handling is engine policy, not per-tool boilerplate.** A throwing
  tool becomes an `Error: ...` tool message the model can react to (tested:
  `DELETE FROM tracks` → rejection → model retries with a `SELECT`). A
  throwing *system* becomes a `SystemError` component that the stdlib `retry`
  system can heal. The original hand-writes try/catch inside `queryTool`.
- **Footprint.** `node:sqlite` + workspace packages versus `typeorm`,
  `better-sqlite3`, `zod`, `@langchain/classic`, `@langchain/core`,
  `@langchain/langgraph`, `@langchain/openai`.

### Where LangGraph is better

- **The original's whole point is an *enforced* workflow, and LangECS can't
  cheaply replicate it.** `START → list_tables → call_get_schema → …` is a
  guarantee: the first node always runs, no tokens are spent deciding to list
  tables, and `tool_choice: "any"` *forces* the schema fetch. Our version only
  *prompts* the model into that order — and in testing this README, gpt-4o-mini
  initially skipped the `albums` schema and joined `tracks` to `artists` on the
  wrong column, returning a **wrong answer** until the prompt was sharpened.
  Reproducing dedicated stages honestly would mean writing custom systems with
  trigger components — at which point the original's `addEdge` wiring is
  shorter and far easier to read.
- **No `check_query` stage.** The original runs every generated query through
  a second LLM pass with a dedicated "SQL expert" prompt before execution.
  The stdlib `callLLM` supports exactly one system prompt per agent; per-step
  prompts and forced tool choice (`ModelRequest` has no `toolChoice` field)
  would require a custom system and/or a core change.
- **Control flow is explicit there, emergent here.** You can read the
  `addEdge` chain top-to-bottom and draw the graph. Predicting a LangECS run
  requires internalizing dirty rules (self-write exclusion, `Not()` terms,
  when-veto consuming dirt). The trace compensates, but the learning curve for
  *why did this fire* is real.
- **Richer interrupt vocabulary.** The original's human-in-the-loop variant
  resumes with `accept` / `edit` (patch the SQL!) / `response`. The stdlib
  approval flow is approve/deny with a reason; an "edit the query" resume would
  be a custom system. (Core interrupts can carry arbitrary payloads, so it's
  buildable — it just doesn't exist as a preset.)
- **Ecosystem.** `SqlDatabase` gave the original schema + sample rows for
  free, for any TypeORM-supported database; our `db.ts` hand-rolls that for
  SQLite in ~60 lines.

### Par

- **Human-in-the-loop & persistence**: both support it (LangGraph:
  `interrupt()` + checkpointer + `Command({ resume })`; LangECS:
  `needsApproval` tools → `AwaitingHuman` → `world.resume()`, snapshots via
  `MemoryAdapter`/`@langecs/persist-fs`). Not exercised in this example —
  see the human-in-the-loop example.
- **Token streaming**: both stream; same UX.

### Verdict

Honest score for *this* example: **roughly par, with opposite strengths**.
The LangGraph original is a *staged pipeline* example, and staged pipelines
are LangGraph's home turf — its version enforces ordering and query-checking
that ours only encourages via prompt, which measurably matters with a small
model. LangECS wins decisively on testability (the choreography test in this
directory simply has no LangGraph equivalent), observability, error policy,
and amount of ceremony. If your SQL agent is "ReAct with good tools", LangECS
is the clearer program; if it must be "exactly these five stages in this
order", port the graph, or expect to write custom systems.
