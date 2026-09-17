# agent-playground — a world an outside agent operates

A LangECS world served over the [Model Context Protocol](https://modelcontextprotocol.io)
so that a coding agent — Claude Code, or any MCP client — can **inspect, diagnose, repair,
run, cancel, resume and fork** it, and (opt-in) **extend it with data-only components and
prompt systems**. It is the test bed for the first hypothesis in
[docs/agents-as-users.md](../../docs/agents-as-users.md): that the properties this engine
already has — every fact is a component, every step is a checkpoint, every "why didn't it
fire?" has a recorded answer — make a world cheap for an agent to operate from the outside.

```sh
pnpm -C examples agent-playground -- --tour       # scripted in-process walkthrough, prints every tool result
node --import tsx examples/agent-playground/main.ts --allow-authoring   # MCP server on stdio
```

No API key needed. To let Claude Code drive it, add [`mcp.json`](mcp.json) to your project
(`.mcp.json` at the repo root, or merge the `mcpServers` entry into yours), then ask it
something like *"inspect the playground world, find the ticket that is stuck, explain why,
and fix it."* With `OPENAI_API_KEY` in the repo-root `.env.local`, installed prompt systems
call `gpt-4o-mini`; without it a policy model answers with an empty, valid proposal.

## The world

A small ticket desk written by hand ([`world.ts`](world.ts)): `triage` → `escalate` /
`approve` → `assignLow` / `assignHigh` → `draft` → `close`, plus two labellers. No model
calls; every system is a few lines of plain code. It is seeded with three tickets and run
once, which leaves it in exactly the shapes emergent control flow gets stuck in:

| Ticket | What happened | The controller's job |
|---|---|---|
| T-100 (entity 1) | Triaged, assigned, replied, closed — the happy path | nothing |
| T-101 (entity 2) | **Quiet but incomplete.** Triaged, then nothing: it has no `pg.Sla`, and both `assign*` systems query it | `explain(2, 'assignLow')` names the missing positive term; `edit` adds `pg.Sla`; `run` |
| T-102 (entity 3) | **Parked on a human.** High priority → `escalate` wrote an interrupt; the run is `'pending'`; `assignLow` was **vetoed** by its guard | `explain(3, 'assignLow')` shows the veto as trace evidence and the author's note; `resume(3, { approved: true })` |
| T-103 (on demand) | **Conflict after work.** `Vip` + `Rush` → `labelVip` and `labelRush` both `set` the plain `pg.Label` in one step → the barrier rejects (R30) | `run` reports `rejected` naming both systems, nothing committed; `edit` removes one tag; `run` |

`--tour` performs all four, then lists the checkpoint history and forks a fresh world from
the first step.

## The protocol

Eight tools, all thin wrappers over the public `World` API and the observer surface
(SPEC §14). Nothing bypasses engine invariants; nothing evaluates code a caller sent.

| Tool | Does | Notes |
|---|---|---|
| `inspect` | `summary` · `entities` · `entity` · `systems` · `trace` · `ledger` · `recipe` | Read-only; individual values, narration lines, interrupts, proposals, ledger rows and run events are clipped to `maxValueChars` (default 2000); lists are paged but total bytes per call are not otherwise capped |
| `explain` | Why a system did / did not fire for an entity | Structured facts: missing positive terms, blocking exclusions, pending dirt, in-flight execution, last run / last guard veto from the flight recorder, the recipe author's note. **Never evaluates a guard.** |
| `edit` | One external mutation: `spawn`, `add`, `set`, `remove`, `despawn` | Needs the current `revision` (moves on every external change and every committed step); refused while a run is in flight (R16) |
| `run` | Run to quiescence, optionally after adding input to an entity | Bounded **response** wait; past it: `operationStatus: 'running'` with a `runId` — never a fake terminal status |
| `run_status` | Poll the run by id: events since a cursor, running pairs, result or rejection | |
| `cancel` | `world.cancel(reason)` | Explicit and separate from a response timeout; cooperative (R50) |
| `resume` | Answer an interrupt and run (R33) | The trusted path for approvals |
| `checkpoint` | `history` · `fork` · `list` · `activate` | `fork` builds a **new** world from a snapshot with the exact recipe (`forkFromSnapshot`); in-place rewind is not offered because `load` replaces entities, not installed systems |
| `install` *(opt-in)* | Declare a component or a prompt system as JSON | See below |

`edit` is one scoped operation with an optimistic-concurrency token; `run` input, `resume`
and `install` are also external mutations but are guarded only by the idle check and their own
validation (no revision, no idempotency key — retrying an input-bearing `run` after a lost
response can add the input twice, so prefer `edit` + `run` when that matters); every long
operation returns a handle. Two more rules hold the authoring boundary: `Recipe` cannot be
written through `edit` or `run` input (only `install`), and a server started without
`--allow-authoring` refuses to fork a checkpoint that carries declarations, so a stored
manifest never becomes executable behind the host's back. Values of declared components are
validated on `edit` exactly as a prompt system's proposal would be. All of these came out of
adversarial review and are what make the surface safe to hand to an agent that cannot see the
process.

## Authoring, as data

With `--allow-authoring`, `install` exposes the stdlib
[declarative layer](../../packages/stdlib/README.md#declarative-layer-experimental):

```jsonc
// install { kind: "component", decl: … }
{ "name": "pg.Sentiment", "schema": { "type": "object",
  "properties": { "tone": { "type": "string", "enum": ["angry", "neutral", "happy"] } },
  "required": ["tone"], "additionalProperties": false } }

// install { kind: "system", decl: … }
{ "name": "sentiment", "query": ["pg.Ticket"], "not": ["pg.Sentiment"],
  "writes": ["pg.Sentiment"], "model": "model:playground",
  "prompt": "Judge the tone of the customer text." }
```

A prompt system's `run` is a model call: the entity's queried components go in as JSON, a
structured proposal comes back, the whole proposal is validated against the declared
schemas **before** anything is buffered, and it is applied through the ordinary `add`/
`remove`. It may only touch the components it declared on the entity it matched; control and
capability components (`HumanResponse`, `Cancelled`, `PendingToolCalls`, budgets, the
recipe…) are refused at declaration time; a malformed reply becomes `ProposalRejected`
state rather than an exception; every model call is recorded in a host-owned ledger
(`inspect ledger`) that survives barrier rollback; and a per-entity `maxRuns` guard brakes
two data-defined systems that would otherwise wake each other forever. Declarations are
recorded in the world's `Recipe` component, so `checkpoint fork` carries them.

## What this does and does not show

Verified here, deterministically ([`agent-playground.test.ts`](agent-playground.test.ts),
zero network): the three repairs through the protocol; the running/`run_status` handle
semantics; cancel; fork with the recipe; refusal of stale revisions, busy edits, reserved
targets and unknown model resources; a declared prompt system running and surviving a fork.

**Not shown**: that an agent is actually better off with this substrate than with a JSON
store and a rules engine. That is the experiment
[docs/agents-as-users.md](../../docs/agents-as-users.md) lays out — same agent, same
model, same budget, same tasks, this world versus a baseline — and this example is the
apparatus for it, not the result.
