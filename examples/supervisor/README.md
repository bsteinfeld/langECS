# Multi-agent supervisor

A supervisor agent routes a user request to two worker agents — a **researcher**
and a **writer** — that run **in parallel within a single step**. Workers report
back through the supervisor's `Inbox` (an append-reducer component, so the
fan-in merges deterministically at the step barrier), and the supervisor
aggregates both results into the final answer.

The example also demonstrates two things the graph version cannot express:

- **Dynamic spawning** — the writer agent is not pre-spawned; the supervisor
  creates it mid-run with `ctx.spawn(writer, Task(...))`. The spawned entity
  gets the agent's full component bundle, its scoped `work` system registers on
  the fly, and the new pair fires in the very next step.
- **Failure as state** — the demo wraps the writer's model to throw on its
  first call. The engine catches the crash, discards the failed pair's writes
  (the researcher's sibling write still commits), and appends a `SystemError`
  component to the worker entity. A global `heal` system matches
  `[SystemError, Task]`, re-arms the failed pair with `ctx.invalidate`, and the
  retry's success auto-clears the error record.

## Flow

```
step 1  supervisor:plan       1 LLM call → {"researcher": "...", "writer": "..."}
                              writes Task → researcher, spawns writer with Task
step 2  researcher:work  ┐    both workers run CONCURRENTLY in one step;
        writer:work      ┘    writer's model crashes → SystemError (researcher's
                              Inbox append commits anyway); aggregate vetoes (1/2)
step 3  heal                  sees [SystemError, Task], ctx.invalidate(writer:work)
step 4  writer:work           retry succeeds → Inbox append; SystemError auto-cleared
step 5  supervisor:aggregate  2/2 results → 1 LLM call → final answer, quiescence
```

Total: 2 supervisor-side LLM calls (routing + aggregation) regardless of how
many workers are dispatched. Worker calls: 2 (+1 for the retried crash).

## Run it

```bash
# repo-root .env.local must contain OPENAI_API_KEY=...
pnpm -C examples supervisor
```

Streams tokens from all three agents live (interleaved while the workers run in
parallel), narrates dispatches / crash / heal, then prints the final answer and
the flight-recorder trace.

```bash
# deterministic tests: scriptedModel only, zero network
pnpm -C examples exec vitest run supervisor
```

The test asserts the step-by-step choreography from the world trace: both
workers executed **in the same step**, the runtime spawn is attributed to
`supervisor:plan`, the Inbox fan-in merged both results in one barrier, the
aggregation model call saw both findings, and the scripted crash →
`SystemError` → heal → retry → auto-clear path completes with status `done`.

## Comparison with the LangGraph.js original

Original: [`examples/multi_agent/agent_supervisor.ipynb`](https://github.com/langchain-ai/langgraphjs/blob/main/examples/multi_agent/agent_supervisor.ipynb)
(supervisor + researcher + chart generator). Its shape:

```ts
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (x, y) => x.concat(y), default: () => [] }),
  next: Annotation<string>({ reducer: (x, y) => y ?? x ?? END, default: () => END }),
});

const routingTool = {
  name: "route",
  description: "Select the next role.",
  schema: z.object({ next: z.enum([END, ...members]) }),
};
// supervisorChain = prompt | llm.bindTools([routingTool], { tool_choice: "route" })

const workflow = new StateGraph(AgentState)
  .addNode("researcher", researcherNode)
  .addNode("chart_generator", chartGenNode)
  .addNode("supervisor", supervisorChain);
members.forEach((member) => { workflow.addEdge(member, "supervisor"); });
workflow.addConditionalEdges("supervisor", (x) => x.next);
workflow.addEdge(START, "supervisor");
const graph = workflow.compile();
```

### Where LangECS comes out ahead

- **Parallel fan-out, fewer router calls.** The original's supervisor selects
  *one* worker at a time via the `next` channel: supervisor → researcher →
  supervisor → chart_generator → supervisor → FINISH. Every hop is another
  supervisor LLM call (≈ N+1 router calls, fully sequential). Here one routing
  call dispatches both workers, they execute concurrently in a single step
  (`Promise.all` under one barrier), and the `Inbox` reducer merges the fan-in
  deterministically — 2 supervisor calls total, ~half the wall-clock for the
  worker phase. (LangGraph *can* fan out with the `Send` API, but that is not
  what this canonical example does, and `Send` dispatches to existing nodes.)
- **Dynamic agent spawning.** `graph.compile()` fixes the topology; you cannot
  add a new agent node mid-run. `ctx.spawn(writerAgent, Task(...))` creates a
  whole agent — components *and* its scoped systems — during a step, and the
  trace attributes the spawn to the creating pair.
- **Failure is queryable state, progress survives.** A throwing node in
  LangGraph fails the graph invocation (node-level `retryPolicy` exists, but
  the failure itself isn't addressable state, and a supervisor node can't
  observe it). Here the crash becomes a `SystemError` component on the worker:
  the researcher's same-step result still commits, any system can match on it
  (our `heal` is 20 lines), and a retried success auto-clears it.
- **Deterministic choreography tests.** `supervisor.test.ts` asserts
  *step-level* facts — "both workers ran in step 2", "the spawn was made by
  `supervisor:plan`", "the failed pair's writes were discarded" — straight from
  the flight recorder, with a scripted model and zero mocks of the engine.
  Testing the equivalent in the notebook would mean intercepting LangSmith
  traces or stream chunks.

### Where the original is better

- **Structured routing.** LangGraph forces the routing decision through a
  zod-validated tool call (`tool_choice: "route"`, `next: z.enum([...])`) —
  typed, validated, impossible to mis-parse. Our supervisor asks for raw JSON
  and hand-parses it with a fallback; core has no structured-output helper yet.
  This is the weakest part of the port.
- **The flow is explicit.** `addNode` / `addEdge` / `addConditionalEdges` reads
  as a diagram; you can render it. The ECS choreography is *emergent* from
  queries + dirty-tracking — to see why `aggregate` fired you read the trace,
  not the wiring. More flexible, less immediately legible, and component-name
  coupling between systems is implicit.
- **Richer workers.** The original's workers are full `createReactAgent` loops
  with real tools (Tavily search, D3 chart generation). Ours are single LLM
  calls to keep the choreography readable — you'd compose stdlib's
  `reactAgent` per worker to match, which this example doesn't show.
- **Ecosystem and maturity.** Checkpointer backends, LangSmith tracing, Studio,
  streaming modes, docs, community. LangECS is an experiment with a memory/fs
  snapshot adapter and a console trace printer.
- **Barrier cost.** Within a step the world waits for the slowest pair: a slow
  researcher holds the writer's *commit* (results apply at the barrier even
  though both run concurrently). LangGraph super-steps share this property, but
  its sequential routing sidesteps it for this example by never running two
  workers at once.

### Verdict

**Better than the original for the mechanics this pattern is about** — parallel
dispatch with deterministic fan-in, runtime team growth, and supervised failure
recovery are all natural ECS moves and one-liners here, versus impossible or
restructure-required in the compiled-graph version. **Worse on routing
ergonomics (no structured output), flow legibility, and ecosystem** — for a
production supervisor today, LangGraph's tooling still wins; this port's value
is showing the same pattern with strictly fewer moving parts and stronger
runtime introspection.
