# Reflection — writer ↔ critic on a shared blackboard

Port of the LangGraph.js [reflection example](https://github.com/langchain-ai/langgraphjs/tree/main/examples/reflection)
(essay generator + grader) to LangECS.

## What it does

One **blackboard entity** holds the whole loop as data: a `Messages` transcript
(append reducer), a `Reflecting` tag, and a `MaxCritiques` budget. Two systems
query that entity:

- **`writer`** — drafts an essay for the task, and revises it on every critique.
- **`critic`** — grades each fresh draft. After `MaxCritiques` (= 2) critique
  rounds it appends an approval message and **removes the `Reflecting` tag**.

There is no router and there are no edges. The alternation is the engine's
dirty-tracking: a system's own `Messages` append never re-triggers itself
(self-write exclusion), but it is *foreign* dirt for the other system — so
writer wakes critic, critic wakes writer, six steps in a row:

```
step 1  writer   draft            (critic scheduled too, vetoes: nothing to review)
step 2  critic   critique #1
step 3  writer   revision #1
step 4  critic   critique #2
step 5  writer   revision #2
step 6  critic   approval + remove Reflecting  → both queries unmatch → quiescent
```

The loop *ends by component removal*: once `Reflecting` is gone neither query
matches, and the world simply has nothing left to do.

## Files

- `agent.ts` — components (`Reflecting`, `MaxCritiques`), the two systems, and
  the spawnable `reflection` agent bundle.
- `main.ts` — live demo with `gpt-4o-mini` via `@ai-sdk/openai`: streamed
  tokens per author, step-by-step progress, and the flight recorder at the end.
- `reflection.test.ts` — deterministic test (core `scriptedModel`, zero
  network) asserting the exact step-by-step choreography from the world trace.

## Run it

```sh
pnpm install                                  # repo root, once
pnpm -C examples reflection                   # live demo (OPENAI_API_KEY in <repo-root>/.env.local)
pnpm -C examples exec vitest run reflection   # deterministic test, no network
```

## Side-by-side with the LangGraph.js original

The original wires the same two nodes with explicit edges and a counting
router ([reflection.ipynb](https://github.com/langchain-ai/langgraphjs/blob/main/examples/reflection/reflection.ipynb)):

```ts
// LangGraph.js
const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: (x, y) => x.concat(y) }),
});

const workflow = new StateGraph(State)
  .addNode("generate", generationNode)
  .addNode("reflect", reflectionNode)
  .addEdge(START, "generate");

const shouldContinue = (state: typeof State.State) => {
  const { messages } = state;
  if (messages.length > 6) return END;   // end after 3 iterations
  return "reflect";
};

workflow.addConditionalEdges("generate", shouldContinue).addEdge("reflect", "generate");
const app = workflow.compile({ checkpointer: new MemorySaver() });
```

The LangECS equivalent has no graph object at all:

```ts
// LangECS
export const writer = defineSystem({
  name: 'writer',
  query: [Messages, Reflecting],
  when: (e) => authorOf(e.get(Messages).at(-1)!) !== 'writer',
  run: async (e, ctx) => { /* call model */ e.add(Messages, [draft]); },
});

export const critic = defineSystem({
  name: 'critic',
  query: [Messages, Reflecting, MaxCritiques],
  when: (e) => authorOf(e.get(Messages).at(-1)!) === 'writer',
  run: async (e, ctx) => {
    if (delivered >= e.get(MaxCritiques)) {
      e.add(Messages, [approval]);
      e.remove(Reflecting);              // end of loop: both queries unmatch
      return;
    }
    /* call model */ e.add(Messages, [critique]);
  },
});

export const reflection = defineAgent({
  name: 'reflection',
  components: [Messages([]), Reflecting(), MaxCritiques(2)],
  systems: [writer, critic],
});
```

Both use the identical state idea — a `messages` channel with a concat
reducer — and both flip ai/human roles so the critic grades a "submission".
The difference is purely in how control flow is expressed.

### Where LangECS comes out better

- **Termination is explicit state, not arithmetic.** LangGraph stops when
  `messages.length > 6` — a magic number that silently breaks if a node ever
  appends two messages. Here the critic removes a `Reflecting` tag; the stop
  condition is visible in the final state (`has(Reflecting) === false`) and
  the budget is plain data you can override per spawn
  (`world.spawn(reflection, MaxCritiques(5))`) without recompiling a graph.
- **No routing code.** START/conditional/loop-back edges and `shouldContinue`
  disappear entirely; the writer→critic→writer ping-pong falls out of two
  engine rules (self-write exclusion + foreign-append dirt).
- **Testability.** `reflection.test.ts` asserts the *exact* choreography —
  which system fired at which step, the critic's step-1 veto, the tag removal
  in step 6, then quiescence — deterministically against the flight recorder,
  with zero network. The original is a notebook; LangGraph's own testing story
  for this example is "look at the LangSmith trace".
- **Local observability.** Streamed tokens, scheduled/vetoed pairs, and every
  committed write come out of the run event stream and `formatTrace(world.getTrace())`
  with no hosted service.
- **It scales sideways for free.** Spawn ten blackboards and the same two
  systems run all ten loops concurrently inside the same step barrier;
  LangGraph would run one graph invocation per thread.

### Where LangGraph comes out better

- **The loop is legible at a glance.** `generate → reflect → generate` is right
  there in the edge declarations, and LangGraph can render the graph as a
  diagram. In LangECS the alternation is *emergent*: you must know the dirty
  rules (self-write exclusion, when-veto consumes dirt) to predict the run.
  For a fixed two-node cycle, edges are honestly easier to read.
- **Turn-taking here is a stringly-typed convention.** The `when` guards key
  off `msg.meta.author`; mistag a message and the loop just quiesces early
  (silent stop) instead of failing loudly. LangGraph's structural
  `messages.length` check is cruder but harder to get half-wrong.
- **Not less code.** `agent.ts` is roughly the same size as the original's
  graph + node definitions. The win is *where* logic lives (data + local
  guards), not line count.
- **Steeper concept ramp.** Entity, component, reducer, system, dirt, barrier,
  veto — versus node, edge, state. For someone porting this example the
  LangGraph version is the gentler on-ramp, and its ecosystem (checkpointer
  back-ends, LangSmith, docs, community) is years ahead.

**Honest verdict:** this example is the dirty-triggering showcase — the cycle
LangGraph needs three edges and a router for is simply *what the scheduler
does*, and the termination-by-tag-removal is cleaner and more inspectable than
counting messages. But the control flow is implicit, so it reads worse to a
newcomer than the original's explicit graph. Better runtime semantics and
testability; worse immediate legibility; roughly equal code volume.
