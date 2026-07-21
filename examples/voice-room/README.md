# voice-room

**A real-time, multi-persona voice conversation — several AI personas who talk
to you *and* to each other, each with its own voice, memory, and moment-to-moment
mood — built as an ECS world where "who speaks next" is the scheduler's job.**

You hold a button and talk; the room hears you (speech-to-text), decides who
should respond, that persona thinks and speaks in its own voice (text-to-speech),
and the others react — sometimes to you, sometimes to each other. You can cut in
at any time and the room re-routes around you.

```sh
pnpm -C examples voice-room          # narrated CLI demo (no key needed)
pnpm -C examples voice-room-server   # the browser room → http://localhost:8787
```

The browser room works with **zero API keys**: it uses the browser's built-in
Web Speech API for recognition and gives each persona a distinct synthesized
voice. Set `OPENAI_API_KEY` in the repo-root `.env.local` to have each persona
*think* with `gpt-4o-mini`; add `VOICE_ROOM_OPENAI_AUDIO=1` to also swap in
OpenAI Whisper + TTS for higher-quality audio.

## Why this is an ECS problem

Turn-taking in a room *is* a scheduling problem: given everyone's state and what
was just said, decide who acts next. That is exactly what the LangECS scheduler
already does — a `(system, entity)` pair fires when a *foreign* write dirties a
component its query watches ([SPEC](../../SPEC.md) R25–R32). So the conversation
manager isn't code we wrote; it's the engine. One utterance dirties the world and
the next speaker falls out.

The whole room is two kinds of entity:

| Entity | Components |
|---|---|
| **The room** (one shared blackboard) | `Transcript` (everyone hears it, append reducer), `Floor` (who's speaking), `AppraisalRound` / `Appraised` / `TurnScores` (turn-taking bookkeeping) |
| **Each persona** (one agent) | `Persona` (prompt, interests, private knowledge, model ref), `Voice`, `Mindset` (eagerness / happiness / anxiety / anger / stress / last-spoke), `Heard` (per-beat inbox) |

Behaviour is never stored — the LLM clients, the fast turn model, and the speech
engines are all **named world resources** the components reference by name (R18).
That's why a room is plain-JSON state you could pause, snapshot, or fork.

## The beat: one utterance, pure dirty-triggering

```
speak appends to Transcript
     └▶ broadcast   copy the new line into every persona's Heard; open a round
     └▶ appraise ×N each persona drifts its OWN Mindset, reports into Appraised
     └▶ arbitrate   once every mind is current, the fast turn model scores everyone
                    and grants the Floor to one persona (or nobody → a lull)
     └▶ speak       the chosen persona generates + is voiced, appends … and repeat
```

Nobody calls anybody. `broadcast` wakes because `speak` appended to `Transcript`;
`appraise` wakes because `broadcast` wrote its `Heard`; `arbitrate` waits on a
count guard (`Appraised.length >= expect`) exactly like a fan-in join; `speak`
wakes because `arbitrate` granted it the `Speaking` tag. Self-write exclusion is
what keeps it honest — a persona hearing its *own* line next beat crashes its
eagerness, so it won't monologue. The choreography, asserted step-by-step from
the flight recorder, is in [`voice-room.test.ts`](voice-room.test.ts).

The driver ([`driver.ts`](driver.ts)) runs **one beat per `world.run()`** via a
`FloorOpen` gate (added by the driver, consumed by the arbiter). That's what makes
real-time possible: each utterance quiesces the world so its audio can play and
**you can barge in on the next idle boundary** — the only moment external mutation
is legal (R16). Barging in is just a user turn: it preempts the `Floor` and the
room re-routes.

## The fast "who speaks next" model

The arbiter delegates to a `turn:model` resource — a **non-LLM, sub-millisecond**
scorer ([`mind.ts`](mind.ts)). The default is a transparent weighted function:

```
score = eagerness + 0.8·relevance(topic, interests) + 0.4·arousal + 0.2·happiness
        + 1.2·(named/questioned)  − 1.5·(just spoke)
```

folded through a softmax into a probability per persona; the argmax above a
threshold takes the floor, or the room lulls. It's deliberately simple and
explainable — the CLI prints the full distribution every beat — and it is a pure
resource, so it swaps for a trained tiny classifier over the same features
without touching a single system.

The same file holds `appraise()`, the equally-cheap function that drifts each
persona's mindset every beat (being named raises eagerness; hearing your own
voice crashes it; sitting silent slowly raises the urge to speak).

## Layout

| File | What it is |
|---|---|
| [`room.ts`](room.ts) | Components, resource refs, shared types — the data model |
| [`mind.ts`](mind.ts) | The fast turn model + mindset appraisal (the non-LLM "fast model") |
| [`systems.ts`](systems.ts) | `ingestUser` / `broadcast` / `arbitrate` (global) + `appraise` / `speak` (persona) + the `persona` agent |
| [`personas.ts`](personas.ts) | The three default voices (Sage, Nova, Rex) + `buildRoom()` |
| [`audio.ts`](audio.ts) | STT/TTS resources — mock (Web Speech) and OpenAI (Whisper + TTS) |
| [`driver.ts`](driver.ts) | The beat loop: `userSays` / `beat` / `turns`, barge-in |
| [`main.ts`](main.ts) | The narrated CLI demo |
| [`server.ts`](server.ts) + [`ui/`](ui/) | The browser room: SSE server + push-to-talk page |
| [`voice-room.test.ts`](voice-room.test.ts) | Deterministic choreography + turn-model unit tests |

## Honest notes

- **This stresses the scheduler, which is the point** — but a global step barrier
  means the room advances in lockstep: one slow model call holds the beat. For a
  handful of personas that's fine; a crowd would want per-entity stepping (on the
  roadmap) or speculative generation (below).
- **Barge-in is between beats, not mid-token.** Because the engine forbids
  external mutation during a run (R16), the user's interrupt lands the instant the
  current utterance quiesces. Since a beat is one short utterance, in practice the
  page silences playback immediately on button-press and the new turn is picked up
  on the next boundary — which feels immediate, but the model is honest: the ECS
  never mutates mid-run.
- **A dedicated realtime stack (e.g. streaming duplex audio) would beat this on
  latency.** What LangECS buys is that the *conversation logic* — turn-taking,
  per-persona mood, memory, interruption — is legible, testable state, not
  callbacks. The whole "who talks next" policy is one swappable resource and a
  30-line test.
- **Shared history is a simplification.** Everyone sees the full `Transcript`.
  Private per-persona memory (`Heard`, and the `Persona.knowledge` field) is
  already modelled; giving personas divergent *views* of history is a natural next
  step (a per-persona projection component).

## Future work

- **Speculative next-speaker pre-generation.** Run the turn model continuously and,
  when one persona's probability crosses a high threshold *before* the current
  speaker finishes, spawn a speculative `speak` for the likely next persona and
  keep it iff the prediction holds. This is a natural ECS move — concurrent pairs
  in a step, the loser's buffer discarded at the barrier — and would hide model
  latency. Deferred to keep the core turn-taking loop clear.
- **A learned turn model** trained on real multi-party transcripts, dropped in as
  the `turn:model` resource.
- **Emotion via appraisal LLM** — an optional slow path that periodically refines
  `Mindset` with a model, layered under the fast heuristic.
