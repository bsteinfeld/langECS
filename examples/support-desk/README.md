# Support desk — entities are not only agents

Most frameworks make "an agent" the unit of everything, so a queue of work
becomes a swarm of agent instances. Here the unit is the **ticket**: four
customer tickets are four plain entities (`Ticket { from, subject, body }`),
and every "worker" is a **system** swept across whatever tickets currently
match its query. No per-ticket agent is ever spawned.

What it teaches:

1. **Entities as work items, systems as workers.** All freshly spawned tickets
   match `[Ticket, Not(Triaged)]`, so step 1 runs four classification calls
   *concurrently* — fan-out with no loop, no graph, no orchestrator.
2. **Routing as a `when` guard.** Both specialists wake on the same dirt
   (`Triaged` appearing). The guard (`category === 'billing'`) picks the lane;
   the losing lane's veto consumes its dirt without burning a model call.
3. **Per-entity interrupts.** Low triage confidence writes `AwaitingHuman` via
   `interrupt()` on *that ticket only*. The specialists' `Not(AwaitingHuman)`
   term keeps them away while every other ticket completes normally.
4. **Typed resources + `extractJson`.** The desk model is a
   `defineResource<Model>` ref (no stringly-typed hops), and triage gets
   strict-JSON classification out of any `Model` with `extractJson`.

## Flow

```
spawn 4 tickets
step 1  triage x4 (CONCURRENT LLM calls)   -> Triaged on all four;
                                              the garbled one also gets AwaitingHuman
step 2  respondBilling@1, respondTechnical@2, respondTechnical@3   (one step,
        slaWatchdog@3 (priority 1 -> SlaRisk)                       all parallel)
        -> run quiesces: status 'pending'
-- world.resume(ticket4, { category: 'billing', priority: 2 }) --
step 3  applyHumanTriage@4   -> Triaged replaced with the human verdict,
                                HumanResponse consumed
step 4  respondBilling@4     -> Reply + Drafted -> status 'done'
```

## The `'pending'` nuance, honestly

`await world.run()` returns `status: 'pending'` — and that status describes
the **run as a whole**. But nothing was globally blocked: `AwaitingHuman` sits
on the escalated ticket alone, and by the time the run returns, the three
confident tickets already carry replies. Escalation here is per-entity
back-pressure, not a per-run pause button. The board printed after run #1
shows exactly that: three replies, one `ESCALATED -> human queue`.

## The watchdog's timing, honestly

`slaWatchdog` queries `[Ticket, Triaged, Not(Drafted)]` and fires in the
**same step** as the specialists — all three woke on `Triaged` appearing. It
reads the step-start state, where no draft exists yet (SPEC R17 isolation), so
the priority-1 ticket is flagged deterministically even though its reply
commits at the same barrier. In a long-lived desk where drafting takes extra
steps (tool calls, approvals), that same query would catch tickets aging in
the queue; here it demonstrates that a global system observes a consistent,
race-free snapshot alongside the workers it is watching.

## Run it

```bash
# repo-root .env.local must contain OPENAI_API_KEY=...
pnpm -C examples support-desk            # add --trace for the flight recorder

# deterministic tests: scriptedModel only, zero network
pnpm -C examples exec vitest run support-desk
```
