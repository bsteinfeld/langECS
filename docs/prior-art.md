# Prior Art & Adjacent Work

*Web research survey, 2026-06-10. Companion to `DESIGN.md`. The job of this document is to
keep us honest: what already exists, what we're actually adding, and which claims to soften.*

**Method note.** Searches combined "entity component system" with LLM/agent terms across web,
arXiv, GitHub (API repo search), and HN/Reddit. Two caveats from the process itself:
(1) "ECS" is badly polluted by AWS/Alibaba Elastic Container/Compute Service, so absence of
results is weaker evidence than usual; (2) several AI-generated search summaries *hallucinated*
ECS into papers — three candidate papers ([2603.09337](https://arxiv.org/abs/2603.09337),
[2410.10039](https://arxiv.org/html/2410.10039v1),
[2506.04699](https://arxiv.org/pdf/2506.04699)) were fetched and verified to contain **no** ECS
content. Everything below was verified against the primary source unless marked otherwise.

---

## 1. Direct prior art: ECS applied to LLM agents

**Bottom line first: "agents as entities in an ECS" is not a novel idea.** At least two
serious efforts and one academic framework exist. What none of them have is LangECS's
execution model (reactive dirty-triggering, self-write exclusion, reducer-merged barriers,
quiescence-as-pause) or its goal (drop-in parity with graph orchestrators, validated by
porting). The novelty claim must be scoped to the *combination*, not the mapping.

### 1.1 ArgOS / Project 89 — the closest thing to LangECS that exists

- Repo: [project-89/argOS](https://github.com/project-89/argOS) — "Experimental framework
  for ECS based AI agent simulations." TypeScript, built on
  [bitECS](https://github.com/NateTheGreatt/bitECS). Created Nov 2024, last push Mar 2026,
  36 stars / 9 forks, no license file, 5 open issues. Alpha-quality, crypto-adjacent
  (Project 89 is a token project), minimal adoption.
- Mapping is the same as ours: each agent is an entity; components include `Agent` (name,
  model ref), `Perception`, `Memory`, `Goal`, `Plan`; systems include Perception, Thinking,
  Action, Goal-Planning ([architecture write-up](https://www.aicoin.com/en/article/440331),
  [second write-up](https://followin.io/en/feed/15922789)).
- **Key difference: scheduling.** ArgOS systems run on *fixed time intervals* organized into
  "consciousness tiers" (conscious systems ~10s, subconscious ~25s, unconscious 50s+). It is
  a polling game-loop, not a reactive scheduler. No step barrier, no determinism story, no
  checkpoint/time-travel, no write-conflict semantics, no quiescence concept. It targets
  open-ended simulation/emergence, not task orchestration.
- Honest take: ArgOS proves someone independently reached "TypeScript ECS + LLM agents" a
  year and a half before us. If LangECS ships a README implying the mapping itself is new,
  someone will link this repo within a day. Cite it preemptively.

### 1.2 Simulation Streams (Google DeepMind, Jan 2025)

- Paper: [Simulation Streams: A Programming Paradigm for Controlling Large Language Models
  and Building Complex Systems with Generative AI](https://arxiv.org/abs/2501.18668)
  (Sunehag & Leibo, with code release).
- A state-based paradigm where sequential "operators" modify a shared state stream, with an
  explicit ECS layer: "This ECS approach enhances the modularity of the output stream,
  allowing for complex, multi-entity simulations while maintaining format consistency,
  information control, and rule enforcement" — and it "facilitates reuse of workflows across
  different components and entities."
- Demonstrated on a market-economy simulation, a social simulation, and RL benchmarks.
  Execution is a *sequential* operator stream — no parallel step barrier, no reactive
  triggering, no persistence/HITL story. Again simulation-oriented, not orchestration.
- This is the most citable "ECS × LLM" prior art (real research group, real paper).

### 1.3 HECATE (academic, Sept 2025)

- Paper: [HECATE: An ECS-based Framework for Teaching and Developing Multi-Agent
  Systems](https://arxiv.org/pdf/2509.06431) (Casals & Brandão). Entities = agents,
  components = agent state, systems = behaviors; built to teach *classical* MAS (BDI-style,
  JADE/SPADE lineage) from a distributed-systems perspective.
- No LLMs involved. Relevant mostly as evidence that the ECS↔agent mapping is established
  enough to be teaching material — i.e., further deflation of any "first ever" claim.

### 1.4 Minor and near-miss prior art

- [ECSAI](https://github.com/lebressa2/ECSAI) — 1-star Python "ECS Framework for AI Agents."
  In practice it's event-driven components-as-processors (components contain logic), so it's
  ECS-in-name-only; noted for completeness.
- Generative-agent simulations — [Generative Agents](https://arxiv.org/abs/2304.03442)
  (Park et al.), [AI Town](https://github.com/a16z-infra/ai-town) (custom tick-based
  simulation engine on Convex), [ReplicantLife](https://blog.jtoy.net/a-simulation-engine-for-generative-llm-agents/) —
  all game-style worlds hosting LLM agents, none use ECS (AI Town's engine was checked; it's
  shared global state + transactions, not entities/components/systems).
- [Project Sid / PIANO](https://arxiv.org/abs/2411.00114) (Altera) — concurrent stateless
  modules reading/writing a shared Agent State with a bottlenecked decision step. That's a
  blackboard at single-agent scale, not ECS, but it independently validates two LangECS
  bets: state-centric agent decomposition, and concurrency mediated through shared state
  rather than module-calls-module. See also [A Concurrent Modular
  Agent](https://arxiv.org/pdf/2508.19042).
- Mature TS ECS libraries exist to learn from (or build on):
  [bitECS](https://github.com/NateTheGreatt/bitECS),
  [Becsy](https://lastolivegames.github.io/becsy/guide/introduction),
  Thyseus (see [ECS curated list](https://github.com/jslee02/awesome-entity-component-system)).
  None ship LLM/agent affordances.
- Searched and *not found*: any flecs- or Bevy-community project using ECS as an LLM agent
  runtime; any "ECS for agent orchestration" blog/HN thread predating this design; any npm
  package in this niche. Confidence is moderate, not high, given the ECS naming collision.

### 1.5 Novelty assessment (the honest version)

| Claim | Verdict |
|---|---|
| "Agents as entities, state as components, logic as systems" | **Not novel** — ArgOS (2024), Simulation Streams (2025), HECATE (2025) |
| ECS for *production agent orchestration* with graph-framework parity (checkpointing, HITL, streaming, reducers) | **No prior art found** — every existing ECS×agents project targets simulation/emergence |
| Reactive dirty-trigger scheduling (vs. ticks) for LLM agents | **No prior art found**; closest analogs are flecs observers/monitors (§3.2), which are engine features, not an agent execution model |
| Self-write exclusion as loop-prevention for LLM cost control | **Apparently novel**; Bevy documents the *absence* of this as a footgun (§3.3) |
| Quiescence-as-pause HITL surviving process death | Durable-execution platforms achieve the same outcome via journaling (§2.6); the *mechanism* (world snapshot, no replay) differs |

---

## 2. Adjacent paradigms and how LangECS relates

### 2.1 Actor-model agent runtimes

- [Microsoft AutoGen v0.4](https://www.microsoft.com/en-us/research/articles/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/)
  rebuilt AutoGen as an event-driven actor runtime: agents exchange async messages, the
  runtime is swappable, and the distributed implementation is built on Orleans
  ([architecture discussion](https://github.com/microsoft/autogen/discussions/3601),
  [launch post](https://devblogs.microsoft.com/autogen/autogen-reimagined-launching-autogen-0-4/)).
- [Akka's Agentic Platform](https://akka.io/blog/announcing-akkas-agentic-ai-release) puts
  LLM agents directly on the 15-year-old actor runtime (orchestration, durable memory,
  streaming as platform components).
- Relation: in actors, *messages* are primary and state is encapsulated per-actor; in
  LangECS, *state* is primary and messages are just component writes (the stdlib `Inbox` is
  an actor-mailbox convention layered on ECS). Actors scale out naturally (no global
  barrier) but lose global queryability — a supervisor can't ask "which workers currently
  have an error?" without building that index. LangECS inverts the trade. The actor camp
  owns the distribution story; LangECS v1's global barrier concedes it (DESIGN §12 already
  admits this — keep it conceded).

### 2.2 Blackboard architectures (classic AI, now re-emerging)

- The classic: [blackboard systems](https://en.wikipedia.org/wiki/Blackboard_system)
  (Hearsay-II lineage) — independent knowledge sources opportunistically triggered by
  changes to a shared blackboard, plus a control component deciding who fires.
- Direct LLM revivals: [Exploring Advanced LLM Multi-Agent Systems Based on Blackboard
  Architecture](https://arxiv.org/abs/2507.01701) and [LLM-Based Multi-Agent Blackboard
  System for Information Discovery in Data Science](https://arxiv.org/abs/2510.01285)
  (reports 13–57% relative improvement over master-slave/RAG baselines on its tasks).
- Relation: this is LangECS's nearest *conceptual* ancestor. A LangECS world **is** a
  structured blackboard — components are the board, queries+`when` guards are trigger
  conditions, the step scheduler is the control loop. DESIGN §7 even names the blackboard
  convention. Useful honesty: blackboard systems historically struggled with control-
  strategy opacity ("why did that knowledge source fire?"); the flight-recorder trace
  (DESIGN §8.3) is the right answer and should be marketed as such.

### 2.3 Pregel / BSP — the step model's heritage

- LangGraph explicitly documents its runtime as Pregel/BSP: plan → execute all selected
  actors in parallel → apply channel updates at the barrier, repeat until no actor fires or
  step limit ([LangGraph Pregel docs](https://docs.langchain.com/oss/python/langgraph/pregel),
  [concepts/pregel.md](https://github.com/langchain-ai/langgraph/blob/main/docs/docs/concepts/pregel.md)).
  Original: [Pregel, Malewicz et al. 2010](https://dl.acm.org/doi/10.1145/1807167.1807184);
  [BSP, Valiant](https://en.wikipedia.org/wiki/Bulk_synchronous_parallel).
- Relation: LangECS keeps LangGraph's super-step semantics *exactly* (deliberately, for port
  fidelity) and changes what gets scheduled: open-world (system, entity) pairs selected by
  queries over a live world, instead of nodes subscribed to named channels in a compiled
  graph. The accurate one-liner: **LangGraph = Pregel over a closed graph; LangECS = Pregel
  over an open world.** That's a sharper and more defensible pitch than "ECS for agents."

### 2.4 Production systems / rule engines (the unnamed ancestor)

- A dirty-triggered query+guard+handler that runs to quiescence is, structurally, a
  [production system](https://en.wikipedia.org/wiki/Production_system_(computer_science)):
  rules with conditions over working memory, fired by a recognize-act cycle until fixpoint,
  with incremental matching ([Rete algorithm](https://en.wikipedia.org/wiki/Rete_algorithm)).
  LangECS's "compute which pairs now match from buffered mutations" is a coarse-grained
  Rete. Worth acknowledging — and worth borrowing their vocabulary for known hazards:
  conflict resolution (we use deterministic ordering), refraction (a rule shouldn't refire
  on the same data — our self-write exclusion is a variant), and runaway rule loops (our
  `recursionLimit`). Forty years of OPS5/CLIPS/Drools experience says debugging "why did/
  didn't this rule fire" is the #1 pain — independent confirmation that the trace's
  veto-reporting (DESIGN §8.3) is core, not garnish.

### 2.5 Tuple spaces / Linda

- [Linda's generative communication](https://en.wikipedia.org/wiki/Linda_(coordination_language)):
  decoupled processes coordinating through an associatively-matched shared space.
- A pointed 2026 essay, [Our AI Orchestration Frameworks Are Reinventing Linda
  (1985)](https://otavio.cat/posts/ai-orchestration-reinventing-linda/), argues current
  agent-coordination systems (Beads, AgentFS, OpenHands event streams, Anthropic agent
  mailboxes) are ad-hoc Linda reimplementations missing its atomicity and blocking-read
  guarantees: "coordination is orthogonal to computation."
- Relation: "components ARE the channel" is generative communication, with entity+component
  type as the addressing scheme and reducers replacing `in()`'s atomic-removal semantics.
  LangECS should cite Linda rather than appear to rediscover it — and note we dodge Linda's
  race problems only because of the single-world step barrier (the same dodge stops working
  under v2 per-entity stepping; the Linda literature is where to look when it does).

### 2.6 Durable execution runtimes (the other resilience story)

- Temporal ([AI agents on Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal) —
  OpenAI's Codex runs on it), [Inngest](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents),
  Restate ([comparison](https://www.spheron.network/blog/ai-agent-workflow-orchestration-temporal-inngest-restate-gpu-cloud/))
  all deliver crash-survival via *journaled execution + replay*.
- Relation: the "kill the process mid-conversation, resume elsewhere" demo (DESIGN §9) is
  table stakes in this world. LangECS's differentiator is *what* persists: a queryable,
  forkable, inspectable world-state snapshot vs. an opaque execution journal. State-centric
  persistence enables time-travel and fork-from-step-N as primitives; journals make those
  awkward. Sharpen the claim along that axis, not "we survive crashes."

### 2.7 The incumbent TS graph frameworks (the actual competition, 2026)

- [Mastra](https://www.generative.inc/mastra-ai-the-complete-guide-to-the-typescript-agent-framework-2026):
  the TS mindshare leader — 22k+ GitHub stars in 15 months, 1.0 in Jan 2026, 300k+ weekly
  npm downloads; agents + workflows + memory + evals batteries-included.
- LangGraph.js: deepest orchestration + checkpointing, but the JS SDK [trails the Python
  one](https://www.everydev.ai/p/blog-typescript-agent-frameworks-in-2026-loop-runtime-sandbox)
  and teams publicly defect to Mastra over TS DX
  ([framework comparison](https://www.speakeasy.com/blog/ai-agent-framework-comparison)).
- [VoltAgent](https://github.com/VoltAgent/voltagent), Vercel AI SDK, OpenAI Agents SDK fill
  out the field ([2026 landscape](https://dzone.com/articles/top-js-ts-genai-frameworks-2026),
  [hands-on comparison](https://xavidop.me/genkit/2026-04-16-top-jsts-genai-frameworks-2026/)).
- Relation: nobody in this tier uses ECS, and notably *nobody competes on runtime semantics*
  — they compete on DX, integrations, and consoles. That's both the opening (semantics are
  uncontested ground) and the warning (the market may not care about semantics; Mastra won
  on DX). The six-port validation gate is the correct response to that warning.
- Also notable: [Electric Agents](https://electric.ax/docs/agents/) — agents as addressable,
  schema-typed *entities* whose state lives on durable event streams. Entity-flavored but
  event-sourced, not ECS; evidence that "agent = durable addressable state" is in the air.

---

## 3. ECS theory worth borrowing later

### 3.1 Storage: archetypes vs. sparse sets — mostly irrelevant to v1, by design

- The canonical reference: [Sander Mertens' ECS FAQ](https://github.com/SanderMertens/ecs-faq)
  and [Building an ECS #3: Storage in Pictures](https://ajmmertens.medium.com/building-an-ecs-storage-in-pictures-642b8bfd6e04).
  Archetypes (tables: fast iteration, expensive add/remove) vs. sparse sets (fast
  add/remove, slower multi-component iteration); flecs 4.1 supports both per-component
  ([release post](https://ajmmertens.medium.com/flecs-4-1-is-out-fab4f32e36f6)).
- Honest note: ECS storage theory exists to iterate *millions* of entities per 16ms frame.
  LangECS worlds will have tens of entities and steps gated on multi-second LLM calls.
  Adopting archetype machinery for v1 would be cargo-culting; a `Map` is fine. Where it
  *does* matter: query-match bookkeeping for dirty-triggering (archetype-style "queries
  cache matched tables" is the pattern to steal if match computation ever shows up in
  profiles), and the long-lived server-world with thousands of entities.
- Cautionary tale from the same author: [Why Storing State Machines in ECS is a bad
  idea](https://ajmmertens.medium.com/why-storing-state-machines-in-ecs-is-a-bad-idea-742de7a18e59) —
  relevant skepticism for stdlib design, since agent presets will be tempted to encode
  control-flow state ("phase: planning | executing") as components. That's exactly the
  pattern he warns about; the ported examples will tell us if he's right in our domain.

### 3.2 Reactive ECS: flecs observers and monitors

- [Flecs Observers Manual](https://www.flecs.dev/flecs/md_docs_2ObserversManual.html):
  `OnAdd` / `OnRemove` / `OnSet` events matched against full queries; events only fire on
  actual transitions (add of an already-present component is a no-op — same idempotence
  LangECS wants); **monitors** fire when an entity *starts or stops matching* a query —
  precisely DESIGN §3.3's "query newly matches" trigger, already named and battle-tested.
- **Yield-existing** is the feature to steal: an observer created after entities already
  match can be invoked retroactively for them, making code order-independent. LangECS will
  hit the same bug class (system registered after `world.send`, or added to a resumed
  world, never fires because nothing "changed"). Decide the semantics now: does a
  newly-registered system see the existing world as all-new? Flecs says: offer it, opt-in.

### 3.3 Bevy change detection vs. LangECS self-write exclusion

- [Bevy's change detection](https://bevy-cheatbook.github.io/programming/change-detection.html):
  per-system change ticks (`Changed<T>`/`Added<T>` filters see only changes since that
  system last ran); triggering is on *mutable access*, not value inequality — "Bevy does not
  check if the new value is actually different"; and **systems do see their own writes**,
  which the community documents as an infinite-loop footgun mitigated by convention
  (`set_if_neq`, [opt-out discussions](https://github.com/bevyengine/bevy/issues/4882),
  [query-level change detection](https://github.com/bevyengine/bevy/issues/14510)).
- LangECS's self-write exclusion is a deliberate inversion of Bevy's choice, and Bevy's
  documented pain validates it — in a domain where a spurious retrigger costs $0.10 and
  10 seconds rather than a wasted frame, exclusion-by-default is the right call. Two specs
  Bevy's experience says we must nail down *before* porting examples:
  1. **Change = write, or change = value-inequality?** DESIGN §3.3 says "value changed."
     Bevy chose write-counts-as-change for cheapness; if LangECS means deep-equality it
     must say so (and pay for deep compares on big `Messages` arrays); if it means
     write-counts, a system rewriting an identical value retriggers others — pick one,
     test both behaviors.
  2. **Granularity of exclusion.** Pair-level (this system × this entity) vs. system-level:
     if `callLLM` writes agent B's component, does `callLLM`-on-B fire? DESIGN implies
     pair-level ("a pair's own writes"); the supervisor port will exercise this — make the
     deterministic tests cover it explicitly.

### 3.4 Flecs relationships — the map for "deep ECS"

- [Flecs Relationships](https://www.flecs.dev/flecs/md_docs_2Relationships.html) and the
  [design roadmap](https://ajmmertens.medium.com/a-roadmap-to-entity-relationships-5b1d11ebb4eb):
  first-class entity pairs (`(Eats, Apples)`, `(ChildOf, parent)`), queryable graphs,
  relationship traversal in queries (match `Position` on the entity *or up the `ChildOf`
  edge*), and cleanup policies (deleting a parent deletes children).
- DESIGN §11's deferred "deep ECS" (`BelongsTo`, `IssuedBy` on message/tool-call entities)
  is exactly flecs pairs. The pieces to borrow when that day comes: cleanup policies
  (despawn an agent ⇒ cascade-despawn its messages — otherwise the long-lived server-world
  leaks entities, which DESIGN §11 already flags as "entity GC"), and traversal queries
  (a supervisor matching `SystemError` *up the `ManagedBy` edge* replaces bespoke watcher
  code). Flecs proves relationships can stay pure-ECS (pairs are just components), so deep
  ECS needn't add a second data model.

---

## 4. What this means for the experiment

1. **Drop any "first ECS agent framework" framing.** [ArgOS](https://github.com/project-89/argOS)
   (TS + bitECS, Nov 2024) and [Simulation Streams](https://arxiv.org/abs/2501.18668)
   (DeepMind, Jan 2025) got there first. Cite both in the README's prior-art section before
   someone else does. The defensible claim: *first ECS runtime aimed at production agent
   orchestration with graph-framework parity — reactive scheduling, reducers, checkpointing,
   HITL — validated by side-by-side ports.*

2. **The real differentiator is the scheduler, not the mapping.** Every prior ECS×agents
   system ticks on wall-clock or runs sequentially; none has dirty-triggering with
   self-write exclusion, reducer-merged barriers, or quiescence semantics. Pitch line worth
   keeping: LangGraph is Pregel over a closed graph; LangECS is Pregel over an open world.

3. **Two semantics gaps surfaced by Bevy's scars — fix before porting:** define "changed"
   (write vs. value-inequality, §3.3), and pin pair-level self-write exclusion in the
   deterministic test suite. These are exactly where DESIGN §12's "subtlest part of the
   engine" warning will come true.

4. **Steal from flecs:** monitors confirm "newly matches" is a sound primitive;
   *yield-existing* answers the "system added to an already-populated/resumed world" bug
   class — spec it now (§3.2). When deep ECS lands, use flecs-style pairs + cleanup
   policies rather than inventing a relation model (§3.4).

5. **Acknowledge ancestors or get corrected publicly:** the design is a blackboard system
   with production-rule triggering (Rete-lite) and Linda-style generative communication,
   wearing ECS storage. That lineage is a strength — cite it — and it imports known failure
   modes: rule-firing opacity (the trace's veto-reporting is the mitigation; treat it as
   core) and shared-space races under future per-entity stepping (§2.4, §2.5).

6. **Soften the resilience pitch.** Temporal/Inngest/Restate already own
   "survives process death" ([OpenAI runs Codex on Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal)).
   The claim that survives scrutiny is state-centric persistence: the snapshot is
   queryable, forkable, time-travelable *data*, not a replay journal (§2.6).

7. **The market warning:** the 2026 TS field (Mastra's 22k-star DX-led win over a
   semantically deeper LangGraph.js, §2.7) shows runtime semantics don't sell by
   themselves. The six-port gate with honest verdicts is the right experiment design —
   resist shipping anything before the supervisor/reflection ports clearly win.

8. **Watch the simulation/orchestration boundary.** All found ECS×LLM work lives on the
   simulation side (emergence, NPCs, social worlds); LangECS bets the same substrate wins
   on the orchestration side. If port verdicts come back "par, not better," the honest
   conclusion may be that ECS's payoff only appears at many-entity scale — which is the
   long-lived server-world, not the single-conversation examples. Design the verdict
   write-up to distinguish those two outcomes.
