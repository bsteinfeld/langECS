// The room's behaviour — five systems and one spawnable persona agent. Nobody
// calls anybody. Each system fires because a *foreign* write dirtied a component
// its query watches; the conversation continues as long as the fast turn model
// keeps handing someone the floor, and lulls (quiesces) when nobody is eager
// enough. This is the whole point: "who speaks next in a room" is exactly a
// dirty-triggered scheduling problem, so the engine's scheduler *is* the
// conversation manager. Read SPEC.md §5 (R25–R32) for the scheduler contract.
//
// One beat = one utterance:
//
//   speak appends to Transcript
//        └─(foreign dirt)─▶ broadcast: copy the line into every persona's Heard,
//                            open a fresh appraisal round
//        └─(foreign dirt)─▶ appraise ×N: each persona drifts its own Mindset,
//                            reports into Appraised (fan-in via reducer)
//        └─(count guard)──▶ arbitrate: once every mind is current, score everyone
//                            with the fast turn model and grant the floor to one
//                            (or nobody → the room lulls and waits for the human)
//        └─(foreign dirt)─▶ speak: the chosen persona generates + is voiced,
//                            appends to Transcript … and the beat repeats.
//
// The driver (driver.ts) opens the floor one beat at a time via the FloorOpen
// gate, so a full `world.run()` yields exactly one utterance — leaving room to
// play its audio and let the user barge in between turns.

import {
  type AgentDef,
  defineAgent,
  defineSystem,
  type Model,
  type SystemCtx,
  type World,
} from '@langecs/core';
import { appraise, pickSpeaker } from './mind';
import {
  AppraisalRound,
  Appraised,
  Floor,
  FloorOpen,
  Heard,
  Mindset,
  type MindsetValue,
  PendingUserInput,
  Persona,
  type PersonaValue,
  RoomConfig,
  RoomRef,
  Speaking,
  STTRef,
  Transcript,
  TTSRef,
  TurnModelRef,
  type TurnScore,
  TurnScores,
  type Utterance,
  Voice,
} from './room';

// ------------------------------------------------------------ live event feed
// ctx.emit pushes these onto the run's event stream (observation only, never
// stored). The CLI, the test, and the SSE server all consume this one union.

export type RoomEvent =
  | { kind: 'user'; text: string }
  | { kind: 'token'; who: string; whoId: number; text: string }
  | { kind: 'scores'; scores: TurnScore[]; pickId: number | null }
  | { kind: 'audio-chunk'; whoId: number; base64: string }
  | {
      kind: 'utterance';
      who: string;
      whoId: number;
      text: string;
      voice: string;
      audioBase64?: string;
      approxMs: number;
      streamed: boolean; // audio-chunk events preceded this (use MSE playback)
    }
  | { kind: 'lull' };

// ---------------------------------------------------------------- global systems

/** The human's turn. Text arrives directly, or as an `audioToken` this system
 *  transcribes through the STT resource (speech-to-text as a system, with the
 *  raw audio kept out of component storage). Appending the user line is foreign
 *  dirt for `broadcast`; clearing the Floor is the preemption — whoever the
 *  arbiter might have been about to pick no longer holds it. */
export const ingestUser = defineSystem({
  name: 'ingestUser',
  query: [PendingUserInput, Transcript, Floor],
  run: async (e, ctx) => {
    const input = e.get(PendingUserInput);
    const text = input.text ?? (await ctx.resource(STTRef).transcribe(input.audioToken ?? ''));
    const utterance: Utterance = { speaker: 'user', speakerId: null, text, step: ctx.step };
    e.add(Transcript, [utterance]);
    e.set(Floor, { holder: null, since: ctx.step });
    e.remove(PendingUserInput);
    ctx.emit({ kind: 'user', text } satisfies RoomEvent);
  },
});

/** Fan-out. Every new Transcript line (from the user or a persona) is copied into
 *  each persona's Heard inbox and opens a fresh appraisal round. This is where a
 *  change to the *shared* blackboard becomes per-persona dirt: writing Heard onto
 *  each persona is foreign dirt that wakes their `appraise`. broadcast queries
 *  ONLY Transcript, so the AppraisalRound/Appraised it writes (and the Appraised
 *  the personas later report into) are not in its query — they can never
 *  re-trigger it. Only the next foreign Transcript append does. */
export const broadcast = defineSystem({
  name: 'broadcast',
  query: [Transcript],
  run: (e, ctx) => {
    const transcript = e.get(Transcript);
    const latest = transcript.at(-1);
    if (latest === undefined) return; // fires once on spawn with an empty transcript
    const personas = personaEntities(ctx);
    for (const p of personas) ctx.write(p.id, Heard, [latest], 'add');
    e.set(AppraisalRound, { id: ctx.step, expect: personas.length });
    e.set(Appraised, []); // set() bypasses the append reducer — a clean reset
  },
});

/** The arbiter — the fast turn model wired into the world. It can only act when
 *  (a) the driver has opened the floor (FloorOpen, one beat) and (b) every
 *  persona has appraised the latest line (the count guard, like a fan-in join).
 *  Then it scores everyone and grants the floor to exactly one persona, or lets
 *  the room lull. Removing FloorOpen consumes the beat gate. */
export const arbitrate = defineSystem({
  name: 'arbitrate',
  query: [Transcript, Floor, Appraised, AppraisalRound, RoomConfig, FloorOpen],
  when: (e) => {
    const round = e.get(AppraisalRound);
    return round.expect > 0 && e.get(Appraised).length >= round.expect;
  },
  run: (e, ctx) => {
    const transcript = e.get(Transcript);
    const candidates = personaEntities(ctx).map((p) => {
      const identity = p.get(Persona);
      return {
        id: p.id,
        name: identity.name,
        interests: identity.interests,
        mindset: p.get(Mindset),
      };
    });
    const scores = ctx.resource(TurnModelRef).score({
      candidates,
      last: transcript.at(-1) ?? null,
      step: ctx.step,
    });
    const pick = pickSpeaker(scores, e.get(RoomConfig).threshold);

    e.set(TurnScores, scores);
    e.remove(FloorOpen); // consume the beat gate: one grant per opened floor
    ctx.emit({ kind: 'scores', scores, pickId: pick?.id ?? null } satisfies RoomEvent);

    if (pick === null) {
      e.set(Floor, { holder: null, since: ctx.step });
      ctx.emit({ kind: 'lull' } satisfies RoomEvent);
      return;
    }
    ctx.write(pick.id, Speaking, true); // foreign dirt -> wakes that persona's speak
    e.set(Floor, { holder: pick.id, since: ctx.step });
  },
});

// -------------------------------------------------------------- persona systems

/** A persona's gut reaction to what it just heard. Runs for every persona on
 *  every utterance — this is the "current state and mindset that stays up to
 *  date". Mindset is written only here, so its self-write never re-triggers
 *  appraise; draining Heard with set([]) is also a self-write. Reporting into the
 *  room's Appraised is the fan-in the arbiter waits on. Only the next foreign
 *  Heard append (from broadcast) wakes appraise again. */
const appraiseSystem = defineSystem({
  name: 'appraise',
  query: [Persona, Mindset, Heard, RoomRef],
  run: (e, ctx) => {
    const identity = e.get(Persona);
    let mindset: MindsetValue = e.get(Mindset);
    for (const utterance of e.get(Heard)) {
      mindset = appraise(
        mindset,
        { name: identity.name, interests: identity.interests },
        utterance,
        ctx.step,
      );
    }
    e.set(Mindset, mindset);
    e.set(Heard, []); // drained
    ctx.write(e.get(RoomRef), Appraised, [e.id], 'add');
  },
});

/** The chosen persona speaks: one model call (streamed if the model supports it),
 *  synthesized to audio in its own voice, appended to the shared Transcript. The
 *  Transcript append is foreign dirt that restarts the beat via `broadcast`;
 *  removing Speaking closes this turn. `speak` deliberately does NOT touch its own
 *  Mindset — that would be foreign dirt for appraise; instead appraise crashes the
 *  persona's eagerness next beat when it hears its own line, so it won't monologue. */
const speakSystem = defineSystem({
  name: 'speak',
  query: [Persona, Mindset, Voice, RoomRef, Speaking],
  run: async (e, ctx) => {
    const identity = e.get(Persona);
    const voice = e.get(Voice);
    const room = ctx.world.entity(e.get(RoomRef));
    const transcript = (room?.get(Transcript) as Utterance[] | undefined) ?? [];

    const model = ctx.resource<Model>(identity.model);
    const request = {
      system: buildSystemPrompt(identity, e.get(Mindset)),
      messages: [{ role: 'user' as const, content: renderConversation(transcript, identity.name) }],
      temperature: 0.8,
      maxTokens: 160,
    };

    let result: Awaited<ReturnType<Model['generate']>>;
    if (model.stream !== undefined) {
      result = await model.stream(request, (chunk) => {
        if (chunk.text)
          ctx.emit({
            kind: 'token',
            who: identity.name,
            whoId: e.id,
            text: chunk.text,
          } satisfies RoomEvent);
      });
    } else {
      result = await model.generate(request);
    }
    const text = result.message.content.trim();

    // Synthesize the voice. If the TTS resource supports streaming, prefer it and
    // emit audio chunks as they arrive (mirrors the model's token streaming) so
    // the page can start playing before synthesis finishes.
    const tts = ctx.resource(TTSRef);
    const streamFn = tts.stream?.bind(tts);
    const streamed = streamFn !== undefined;
    const clip = streamFn
      ? await streamFn(text, voice, (base64) =>
          ctx.emit({ kind: 'audio-chunk', whoId: e.id, base64 } satisfies RoomEvent),
        )
      : await tts.synthesize(text, voice);

    const utterance: Utterance = { speaker: identity.name, speakerId: e.id, text, step: ctx.step };
    ctx.write(e.get(RoomRef), Transcript, [utterance], 'add');
    e.remove(Speaking);

    ctx.emit({
      kind: 'utterance',
      who: identity.name,
      whoId: e.id,
      text,
      voice: clip.voice,
      audioBase64: clip.audioBase64,
      approxMs: clip.approxMs,
      streamed,
    } satisfies RoomEvent);
  },
});

// --------------------------------------------------------------------- helpers

/** The persona roster: every entity carrying the `agent:persona` tag, queried
 *  with Persona + Mindset so callers get typed, non-optional identity and mood.
 *  Global systems use it to reach every voice in the room at once. */
function personaEntities(ctx: SystemCtx) {
  return ctx.world.query(persona.tag, Persona, Mindset);
}

/** Render the multi-party conversation for one persona's prompt. Everyone else's
 *  lines are attributed by name; the persona sees its own as "You". */
function renderConversation(transcript: Utterance[], self: string): string {
  const lines = transcript
    .slice(-16)
    .map((u) => `${u.speaker === self ? 'You' : u.speaker}: ${u.text}`)
    .join('\n');
  return (
    `${lines}\n\n` +
    `[You are ${self}. Reply out loud in the conversation with ONE short, natural spoken turn ` +
    `(1–2 sentences). Talk to the others or the user directly; use their names. Do not narrate ` +
    `or use stage directions. If you genuinely have nothing to add, say a brief aside.]`
  );
}

/** Fold the persona's identity, private knowledge, and live mood into the system
 *  prompt, so the same model client voices each persona differently. */
function buildSystemPrompt(identity: PersonaValue, mindset: MindsetValue): string {
  return (
    `${identity.systemPrompt}\n\n` +
    `Private context only you know: ${identity.knowledge}\n` +
    `Right now you feel: ${describeMood(mindset)}. Let it colour your tone, not your words.`
  );
}

function describeMood(m: MindsetValue): string {
  const parts: string[] = [];
  const note = (label: string, v: number) => {
    if (v >= 0.66) parts.push(`very ${label}`);
    else if (v >= 0.4) parts.push(label);
  };
  note('eager to talk', m.eagerness);
  note('happy', m.happiness);
  note('anxious', m.anxiety);
  note('irritated', m.anger);
  note('stressed', m.stress);
  return parts.length > 0 ? parts.join(', ') : 'calm and neutral';
}

// ----------------------------------------------------------- the persona agent

/** One AI voice in the room, as a real agent: its own Mindset/Heard memory plus
 *  the two scoped systems (`appraise`, `speak`). Spawned once per persona; the
 *  identity/voice/model come in as spawn-time inits (see personas.ts). */
export const persona: AgentDef = defineAgent({
  name: 'persona',
  components: [Heard([])],
  systems: [appraiseSystem, speakSystem],
});

/** Register the room's global systems + the persona agent (idempotent). Call
 *  before spawning the room, or before `world.load()` of a saved room. */
export function registerRoomSystems(world: World): void {
  world.use(ingestUser);
  world.use(broadcast);
  world.use(arbitrate);
  world.use(persona);
}
