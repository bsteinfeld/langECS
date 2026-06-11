# Naming the project (rename pass for "langecs")

*Research date: 2026-06-10. Context: DESIGN.md §10 flags `langecs` as a working title —
the "Lang—" prefix risks LangChain brand confusion and must be renamed before any
public release.*

## Methodology

1. **Brainstorm** (~40 raw candidates, ~25 carried forward) around two semantic fields:
   - **ECS concepts** — entities, components, systems, worlds, queries, archetypes, steps
   - **Living collectives** — swarms, colonies, hives, ecosystems, emergence, stigmergy
   Excluded by rule: any `lang`-prefix, anything with "GPT", names of existing ECS
   libraries (bevy, flecs, hecs, becsy, bitecs, ecsy, miniplex, koota, javelin) or
   major agent frameworks.
2. **npm check** — `npm view <name> version` for every serious candidate
   (`E404` = available) plus the scoped form `@<name>/core`. Caveat: absence of
   `@<name>/core` does **not** prove the npm *org* is unowned — orgs can exist with no
   published packages. Treated as a positive-but-not-conclusive signal.
3. **Web search** — for each finalist, searched for existing software projects,
   companies, and products (especially in dev tools / AI agents), and noted what the
   results imply about `.dev`/`.io` domains. Domains were **not** queried at a
   registrar; "plausible" below means "no occupant surfaced in search results."
4. **Score** the top 8 on distinctiveness, pronounceability/memorability, meaning fit
   ("does it evoke a living world of agents?"), and availability risk.

### Raw npm sweep (for the record)

Available (E404): `alveary`, `infusoria`, `animundi`, `worldling`, `querent`,
`eclosion`, `rotifer`, `carillon`, `vivaria`, `ecesis`, `mycelium` (unpublished
2026-02, republishable after the cooldown).

Taken: `terrarium` (2.1.1), `vivarium` (0.0.1, stale 2022), `formicary` (React forms
lib), `apiary` (0.0.2), `murmuration` (active DB lib, 2026), `umwelt` (0.1.0, stale
2022), `zoetic` (0.5.0, stale 2022), `zoetrope`, `tardigrade` (1.0.1, stale 2022),
`microcosm` (Viget's archived Redux-like lib), `orrery` (squatted 0.0.0 **and**
`@orrery/core@0.4.2` exists), `stigmergy` (active 2026 — "Multi-Agents Cross-AI CLI
Tools Collaboration System"), `holon` (stale 2022), `myrmidon` (active utils lib),
`agentarium` (active 2026 — "agent development environment… web IDE"), `entia`
(placeholder squat), `menagerie`, `diorama`, `biotope`, `oikos`, `steppe`, `covey`,
`gaggle`, `hatchery`, `antfarm`, `hypha`, `skep`, `rookery`, `instar`, `imago`,
`warren`, `drover`, `thicket`.

---

## Scored shortlist (top 8)

Scales 1–5 (higher better); availability risk Low / Medium / High (lower better).

| Name | Distinct. | Pronounce. | Meaning fit | Avail. risk | npm bare | npm `@name/core` | Known collisions / domain notes |
|---|---|---|---|---|---|---|---|
| **alveary** | 5 | 4 | 4 | **Low** | **E404 available** | absent (org unverified) | An alveary is a beehive. Only notable occupant: Charlotte Mason "Alveary" homeschool curriculum (alveary.org) — different field entirely. No dev-tools hits. `alveary.dev`/`.io` plausible. |
| **worldling** | 4 | 5 | 4 | **Low** | **E404 available** | absent (org unverified) | No software occupant found. Mild adjacency to Worldle/Wordling games (spelling, not space). `worldling.dev` plausible. |
| **umwelt** | 5 | 3 | 5 | **Medium** | taken (stale 2022 note-taking lib, v0.1.0) | absent (org unverified) | Biosemiotics term: *an agent's experienced world* — the single best concept match found. But `umwelt.dev` is taken (active Elixir/Ruby codegen project), plus a web3 experiment and an academic a11y-viz tool. Bare npm only via dispute/adoption — uncertain. |
| **zoetic** | 4 | 4 | 4 | **Medium** | taken (stale 2022 reactive-programming lib, v0.5.0) | absent (org unverified) | "Of or pertaining to life." Several small non-dev companies (Zoetic AI robotics, Zoetic Motion, Zoetic Global); soundalike Zoetis (animal pharma). Nothing in dev tools. `zoetic.dev` plausible. |
| **infusoria** | 5 | 3 | 4 | **Low** | **E404 available** | absent (org unverified) | The teeming microscopic life in a drop of pond water — a world of tiny agents. Search found no software occupant at all (aquarium-hobby term only). Domains plausible. Spelling/length is the cost. |
| **tardigrade** | 4 | 4 | 4 | **Medium** | taken (stale 2022 template tool, v1.0.1) | absent (org unverified) | Perfect resilience story (survives anything dormant, rehydrates and resumes = quiescence + snapshot/restore). But Storj ran a storage product as "Tardigrade" 2020–2021 (`tardigrade.io` still redirects to Storj) — brand retired, trademark history unclear. |
| **eclosion** | 4 | 3 | 3 | **Low–Med** | **E404 available** | absent (org unverified) | The emergence of an adult insect — "emergence" is on-theme. Several small consultancies (Eclosion Tech, Data Éclosion, eclosion.tech taken) but none in frameworks. `eclosion.dev` plausible. |
| **terrarium** | 4 | 5 | 5 | **High** | taken (stale 2022 JS sandbox lib, v2.1.1) | absent (org unverified) | Meaning is ideal — a sealed living world you watch through glass (the inspector!). But: npm occupant is itself a JS sandbox (adjacent), Mapzen "Terrarium" terrain-tile format is widely referenced, Microsoft Terrarium history. Crowded. |

Honest uncertainties, applying to every row: npm **org/scope ownership** was not
verifiable without auth (only package absence was checked), domains were assessed
from search results only, and no trademark register was queried. Any finalist needs a
USPTO/EUIPO check before release.

---

## Top 3 recommendation

### 1. `alveary`

The cleanest combination of availability and meaning on the board. The bare npm name
is genuinely free (E404), `@alveary/core` is unoccupied, and the only notable existing
user of the word is a homeschool curriculum — no dev-tools, no AI, no infrastructure
collisions found. An alveary is a beehive: one structure housing a living colony of
autonomous agents that coordinate by leaving things where others find them — which is
literally this engine (components are the channel; the blackboard and `Inbox` patterns
are stigmergy). It's a real-but-rare English word, so it's distinctive and searchable
("alveary npm" will be yours from day one), and package names read well:
`@alveary/core`, `@alveary/stdlib`, `world = createWorld()` inside a hive. Pronunciation
(AL-vee-air-ee) is the only real weakness, and it's minor.

### 2. `worldling`

The safest, friendliest option. npm-free, no software occupant found, instantly
pronounceable and spellable, and it carries the project's central noun — *world* —
right in the name. The `-ling` diminutive ("a small inhabitant of a world") matches the
dev-UX tone the design doc wants: you spawn worldlings into a little living world. It's
slightly less distinctive than the others (Worldle/Wordling word-game adjacency could
add search noise, though no confusion risk in dev tools), and it evokes the inhabitants
more than the system. If the priority ranking is "zero availability drama + warm DX,"
this is the pick.

### 3. `umwelt`

The best *concept* fit found, scored down only for availability friction. "Umwelt" is
von Uexküll's term for the world as a particular agent perceives and acts in it — used
in exactly this sense in robotics and agent literature. A framework whose pitch is "the
runtime is a living world" and whose systems each see only their queried slice of that
world could not ask for a more precise name. The friction: the bare npm name is held by
an abandoned 2022 package (an adoption/dispute request is possible but not guaranteed),
`umwelt.dev` is occupied by an active Elixir tooling project, and English speakers will
wobble on "OOM-velt." Choose it only if you're willing to ship under a scoped org
(e.g. `@umwelt-ts/*` or similar) and lose the `.dev` domain.

---

## Rejected but fun

- **stigmergy** — the actual technical term for coordination-by-environment, i.e. the
  exact mechanism of this engine. Heartbreaker: npm `stigmergy` is an *actively
  published 2026 multi-agent CLI collaboration system*. Direct competitor collision.
- **orrery** — a clockwork model of a living system driven in discrete steps: the
  super-step scheduler as a brass machine. Taken three ways: squatted bare name,
  `@orrery/core@0.4.2`, and a GitHub "workflow planning and orchestration CLI for AI
  agents." Someone had the same idea.
- **mycelium** — the underground network through which a forest's agents trade
  resources; perfect metaphor for component-mediated comms, and the bare npm name was
  just unpublished. But the space is hopelessly crowded: ThreeFold's Rust overlay
  network, an "AI tool orchestrator" at mycelium.to, the Bitcoin wallet, two companies
  named Mycelium Software.
- **vivaria / vivarium** — "a place where life is kept" — and METR named their AI-agent
  evaluation platform *Vivaria*, while *vivarium* is used by at least four simulation
  frameworks (including a Jax multi-agent simulator). The right idea, claimed by the
  right neighbors.
- **tun** — the tardigrade's dormant state: alive, serialized, survives anything,
  rehydrates and resumes. That *is* `world.send` → quiescence → snapshot → restore.
  Three letters. Also the name of every TUN/TAP network interface on Earth.
- **bevy** — a collective noun for agents… and the dominant Rust ECS engine. The single
  most-taken name possible for an ECS project.
- **ecstatic** — contains "ecs", means joy. Was a famous (now-deprecated) static file
  server. Also the docs would be unbearable.
- **hivecs** — hive + ECS. Read it again slowly.
- **entmoot** — a deliberative gathering of slow, persistent tree-agents. The Tolkien
  Estate's lawyers are neither slow nor deliberative.
- **petri** — petri dish (a watched culture of living things) *and* Petri nets (the
  formal model closest to the step scheduler). Anthropic shipped an agent-auditing tool
  named Petri in 2025. Adjacent space, instant confusion.
- **murmuration** — a thousand starlings acting as one organism; gorgeous. Bare npm is
  an actively maintained database library, and the Murmurations data-commons protocol
  exists.
- **microcosm** — "a little world," dictionary-perfect. Viget's well-known (archived)
  Redux alternative still owns npm and the search results.
- **sugarscape / wa-tor / boids / lenia** — the classic living-world simulations. All
  already *are* names of famous things; borrowing them buys confusion, not resonance.
- **agentarium** — agents + -arium, pleasingly on the nose. An npm package by this name
  (an "agent development environment" IDE) published a release six weeks ago.
- **carillon** (one keyboard, many bells — orchestration): Carillon ERP since 1992.
  **ecesis** (a species establishing in new habitat): an EHS software product.
  **querent** (one who queries): Querent AI, Austin. **formicary** (ant nest): a
  capital-markets consultancy acquired by Accenture. **myrmidon** (loyal agents of
  Achilles): at least four projects, including — fittingly — an ant-tracking GUI.
