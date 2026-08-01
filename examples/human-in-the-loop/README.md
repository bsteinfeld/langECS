# Human-in-the-Loop — Tool Approval with Kill-and-Resume

A records-admin agent has two tools: `lookup_record` (safe) and `delete_record`
(defined with `needsApproval: true`). When the model asks to delete, the world
goes quiescent with status `'pending'` — an `AwaitingHuman` component sitting on
the agent entity — and the process **exits**. Every step boundary was already
persisted to disk by `@langecs/persist-fs`, so a *different process* can load the
snapshot, ask you `y/n` on stdin, and `world.resume(...)` to the final answer.

## Run it

```bash
# repo root: put your key in .env.local (OPENAI_API_KEY=sk-...)
pnpm -C examples human-in-the-loop            # phase 1: streams until 'pending', persists, exits
pnpm -C examples human-in-the-loop --resume   # phase 2: new process loads .world/, asks y/n, finishes
```

Phase 1 prints streamed tokens and step progress live, then stops with the
interrupt payload (`{"calls":[{"id":...,"name":"delete_record","args":{"id":42}}]}`)
and exits **without executing the tool**. The world state is plain JSON under
`examples/human-in-the-loop/.world/records-world/` (`step-000001.json`, …,
`latest.json`) — open it; the parked `AwaitingHuman` interrupt and the
`PendingToolCalls` are right there. Answer `n` on resume and the model gets an
ordinary tool message saying the call was denied, and reacts to it.

The deterministic test (no network, `scriptedModel` only) simulates the restart
with two world instances sharing one tmp adapter directory and asserts the
step-by-step choreography from the flight recorder, for both approval and denial:

```bash
pnpm -C examples exec vitest run human-in-the-loop
```

## How the interrupt actually works

There is no interrupt machinery. Five ordinary mechanics compose:

1. `callLLM` replies with tool calls → sets `PendingToolCalls` (step 1).
2. `toolApproval` matches `[PendingToolCalls, Tools]`, sees a `needsApproval`
   tool, appends an `AwaitingHuman` record (step 2). In the same step
   `executeTools`' `when` guard **vetoes**, consuming its dirt.
3. `executeTools` queries `[PendingToolCalls, Tools, Not(AwaitingHuman)]`, so it
   no longer matches at all. Nothing is eligible → quiescence; non-empty
   `AwaitingHuman` makes the run status `'pending'`. The engine saved a snapshot
   after every barrier, so killing the process loses nothing.
4. A new process re-registers systems (`world.use(recordsAgent)`) and resources
   (model, tools — behavior is never snapshotted), then `world.load(snapshot)`.
5. `world.resume(entity, decision)` removes `AwaitingHuman` (the `Not()` term
   re-matches `executeTools`) and sets `HumanResponse` (satisfies its guard).
   Approved → the tool executes; denied → a "denied" tool message. Either way
   the appended tool message re-fires `callLLM`, which answers and removes
   `MessageWaiting`. Quiescence: `'done'`.

The pause is *the absence of an eligible system*, and the resume is *two
component edits*. Both are visible in `world.getTrace()` like any other step.

## What happens when the resuming deploy isn't the one that paused

`resume-safety.test.ts` picks up where the kill-and-resume test stops, because a
world that can sit paused for a day will eventually be resumed by a *different
build*. Two failure modes, both asserted:

**A component rename orphans the paused world.** Quiescence is the pause, and
`world.load` throws on any name it cannot resolve — so shipping a rename while
someone's approval is parked makes their world permanently unloadable. The
example ships two vocabularies ([`deploy.ts`](deploy.ts)): v1 writes
`hitl.ReviewerNote`, v2 renames it to `hitl.ApproverNote` and renames the system
that writes it. A `world.migration(1, 2, …)` bridges them, and the parked approval
resumes and completes in the new build:

```ts
const report = next.load(pausedSnapshot)      // migrated on the way in
report.migrated                                // [{ from: 1, to: 2 }]
await next.resume(agent, true)                 // 'done'; the record is deleted once
```

Migrations run **before** any component name is resolved, which is the only
reason a build that no longer defines the old name can read the old snapshot. The
test also shows the deploy that *forgot*: `canLoad` reports
`missingMigration: { from: 1, to: 2 }` with no side effects, so CI can fail the
build instead of the user.

**Two workers resume the same approval.** Resuming enqueues a new job that loads
the snapshot, so a double-click or a queue retry delivers it twice. With
`fence: true` plus `await world.claim()` before running, one worker wins and the
other rejects with `FenceError` — and `delete_record` executes **exactly once**
across both:

```ts
world.load(snapshot)
await world.claim()          // FenceError if another worker already owns it
await world.resume(agent, true)
```

The ordering is the point. Fencing only at save time would stop the loser from
writing a divergent timeline, but by then it has already deleted the record.
Claiming before any step runs is what makes the side effect exactly-once. See
[schema evolution and resume safety](../../docs/guides/schema-evolution-and-resume-safety.md).

## Side-by-side with the LangGraph.js original

Originals: [`review-tool-calls.ipynb`](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/review-tool-calls.ipynb)
and [`react-human-in-the-loop.ipynb`](https://github.com/langchain-ai/langgraphjs/blob/main/examples/how-tos/react-human-in-the-loop.ipynb)
from [langgraphjs/examples](https://github.com/langchain-ai/langgraphjs/tree/main/examples).

LangGraph's review pattern is a dedicated graph node that calls `interrupt()`,
plus checkpointer + thread config, resumed with a `Command`:

```ts
// LangGraph.js (review-tool-calls.ipynb, abridged)
const humanReviewNode = async (state): Promise<Command> => {
  const humanReview = interrupt<{ question: string; toolCall: ToolCall },
                                { action: string; data: any }>({
    question: 'Is this correct?',
    toolCall,
  });
  if (humanReview.action === 'continue') return new Command({ goto: 'run_tool' });
  // ... 'update' and 'feedback' branches route/patch state by hand
};
// graph wiring: call_llm -> human_review_node -> run_tool | call_llm, MemorySaver, thread_id
await graph.stream(new Command({ resume: { action: 'continue' } }), config);
```

The prebuilt variant gates **every** tool instead:
`createReactAgent({ llm, tools, interruptBefore: ['tools'], checkpointSaver: memory })`,
resumed by streaming `null`.

The LangECS equivalent of the whole pause/resume surface:

```ts
// LangECS
const deleteRecord = defineTool({ name: 'delete_record', needsApproval: true, execute });
const agent = world.spawn(reactAgent({ name: 'records-bot', model: 'model:records', tools }));
const result = await sendMessage(world, agent, 'Delete record 42.'); // status: 'pending' — exit, even crash

// later, any process:
world.use(recordsAgent);
world.load(await adapter.load('records-world'));
await world.resume(world.pending()[0].entity, true); // or { approved: false, reason: '...' }
```

### Where LangECS comes out better

- **No interrupt machinery.** LangGraph needs `interrupt()` (which works by
  throwing `GraphInterrupt`), `Command({ resume })`, `interruptBefore`, and a
  scratchpad of resume values. Here, "pending" is two ordinary components and
  "resume" is `remove(AwaitingHuman)` + `set(HumanResponse)` + run — the engine
  (`world.resume`, R33) knows nothing about tools or approval; the *stdlib*
  composes the flow from `when` guards and a `Not()` query term.
- **No replay-on-resume footgun.** LangGraph's `interrupt()` re-executes the
  interrupted node from the top on resume, so code before `interrupt()` runs
  twice and must be idempotent (a documented gotcha). In LangECS nothing
  re-executes: `executeTools` was vetoed and simply *hasn't run yet*; the test
  proves the tool executes exactly once, only in "process B".
- **Per-tool policy as data.** `needsApproval: true` on the tool definition vs.
  hand-wiring a `humanReviewNode` with routing, or `interruptBefore: ['tools']`
  which interrupts for *every* tool (in the LangECS test, a safe `lookup_record`
  in the same batch would execute without a pause — see stdlib's mixed-batch test).
- **Legible suspended state.** The on-disk snapshot is human-readable world
  JSON: the interrupt payload, the parked `PendingToolCalls`, and the pending
  dirty pairs. LangGraph checkpoints store channel values + versions + pending
  writes in a checkpointer-internal shape you inspect through `getState`.
- **Kill-and-resume is the demo, not an exercise.** The notebook keeps one
  process alive with `MemorySaver`; surviving a real restart needs a durable
  checkpointer and the same graph rebuilt. LangECS needs the same rebuild
  (agent def + resources) — but `main.ts` here literally `process.exit(0)`s
  mid-conversation and continues in a fresh process.

### Where LangGraph.js comes out better

- **`interrupt()` pauses anywhere; LangECS only pauses between systems.** A
  LangGraph node can interrupt mid-function, at any expression, with any
  payload, and the resume value is delivered to that exact call site. LangECS
  cannot stop in the middle of a system's `run` — a pause point must be
  *designed in advance* as a separate system + guard/`Not()` choreography. The
  stdlib did that design for tool approval; for a novel pause point you do it
  yourself, and that is real work `interrupt()` simply doesn't require.
- **Richer review actions out of the box.** The original handles approve /
  **edit the tool call** / **natural-language feedback** (`Command` with
  `goto` + state `update`). LangECS stdlib ships approve/deny only. Editing
  args before resuming is possible — `entity.set(PendingToolCalls, patched)` is
  just data — but nothing packages it.
- **Multiple resume conventions are typed.** `interrupt<Req, Res>()` types both
  the interrupt payload and the resume value. LangECS' `world.resume` value is
  `unknown`, parsed by convention (`true` / `{ approved, reason }`).
- **Ecosystem and maturity.** Threads, time-travel UI, LangGraph Studio /
  Platform, LangSmith tracing, battle-tested checkpointers (Postgres, SQLite),
  and years of docs. `@langecs/persist-fs` is a directory of JSON files and
  this framework is an experiment.

### Par

- Both need the app to rebuild behavior (graph/systems + tools + model) before
  resuming; neither serializes code.
- Both stream progress and deliver denials/feedback to the model as ordinary
  tool messages.
- Checkpoint-per-step costs are comparable (LangGraph checkpoints per
  super-step; LangECS snapshots per barrier).

**Verdict:** for *tool approval specifically*, LangECS is genuinely nicer — one
flag on the tool, no interrupt plumbing, no node-replay hazard, and a resumable
file you can read with `cat`. For *arbitrary* human-in-the-loop pauses,
LangGraph's `interrupt()` is the more general, more ergonomic primitive, and its
surrounding tooling is far more mature.
