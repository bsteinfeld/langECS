// The voice room's data model. Everything the room "is" lives in components on
// two kinds of entity:
//
//   * the ROOM entity — one shared blackboard carrying the conversation everyone
//     hears (Transcript), who currently holds the floor (Floor), and the
//     bookkeeping the turn-taking loop runs on (AppraisalRound / Appraised /
//     TurnScores).
//   * one PERSONA entity per AI voice in the room — its identity (Persona), the
//     synthesized voice it speaks in (Voice), its private up-to-the-moment
//     feelings (Mindset), and its per-beat inbox of things it just Heard.
//
// Behaviour (the LLM clients, the fast turn model, the speech engines) is NEVER
// stored here — components are pure JSON data (R3). Each persona references its
// model/voice by *name*; the implementations register on the world as resources
// (see audio.ts / personas.ts). That one rule is why a room is a plain-JSON
// snapshot you could pause, diff, or fork.

import { defineComponent, defineResource, defineTag, type Model } from '@langecs/core';

const append = <T>(current: T[], incoming: T[]): T[] => [...current, ...incoming];

// --------------------------------------------------------------- shared types

/** One line of the conversation everyone in the room hears. `speaker` is the
 *  persona's name, or `'user'` for the human. Entity ids are kept alongside so
 *  the transcript stays a plain, serializable record. */
export interface Utterance {
  speaker: string;
  speakerId: number | null; // persona entity id, or null for the user
  text: string;
  step: number;
}

/** A persona's live emotional state — the "mindset" the fast turn model reads to
 *  decide who is most likely to jump in next, and the LLM reads to colour how it
 *  speaks. All fields are 0..1 unless noted; they drift every beat (see mind.ts). */
export interface MindsetValue {
  eagerness: number; // how much they want the floor right now
  happiness: number; // warmth / positive affect
  anxiety: number; // nervous energy
  anger: number; // irritation, wanting to push back
  stress: number; // cognitive load / overwhelm
  lastSpokeStep: number; // step of their most recent utterance (-1 = never)
  wantsToSay: string; // a short private note-to-self about their next contribution
}

/** A persona's fixed identity. `model` and `interests` make each one modular:
 *  swap the resource name to give a persona a different brain, edit `interests`
 *  to change what pulls them into the conversation. `knowledge` is private
 *  context only this persona knows — it makes cross-talk actually interesting. */
export interface PersonaValue {
  name: string;
  blurb: string; // one-line description (shown in the UI roster)
  systemPrompt: string; // who they are, in their own model's system slot
  interests: string[]; // topics that raise their eagerness when mentioned
  knowledge: string; // private facts only this persona knows
  model: string; // resource name of this persona's Model client
  baseline: Pick<MindsetValue, 'eagerness' | 'happiness' | 'anxiety' | 'anger' | 'stress'>;
}

/** How a persona's voice is rendered. `openaiVoice` drives server-side OpenAI
 *  TTS; `web` drives the zero-dependency browser Web Speech fallback (distinct
 *  rate/pitch so three voices are audibly different with no API key). */
export interface VoiceValue {
  openaiVoice: string; // e.g. 'onyx' | 'nova' | 'echo'
  web: { rate: number; pitch: number; langHint?: string };
}

/** The weighted contributions behind one persona's raw turn score — surfaced so
 *  the "wants the floor" number is fully explainable, never a black box. Each
 *  field is the signed amount that feature added to `raw` this beat. */
export interface TurnFactors {
  eagerness: number; // core drive to talk (from Mindset)
  relevance: number; // topic overlap with this persona's interests
  arousal: number; // agitation (anger+anxiety+stress) adds urgency
  happiness: number; // positive affect adds willingness
  addressed: number; // bonus for being named / questioned
  justSpoke: number; // penalty for having just held the floor
}

/** The arbiter's latest per-persona speaking probability — pure observation,
 *  rendered in the CLI and the UI so the turn decision is legible, never hidden.
 *  `factors`/`raw` expose exactly where `p` came from (see mind.ts). */
export interface TurnScore {
  id: number;
  name: string;
  p: number; // probability this persona speaks next (softmax, sums to ~1)
  raw?: number; // pre-softmax weighted score
  factors?: TurnFactors; // the per-feature contributions to `raw`
}

// ----------------------------------------------------------- ROOM components

/** The shared conversation. Append reducer: the user and a speaking persona can
 *  land lines in the same barrier without conflicting (R30). Every append is
 *  foreign dirt for `broadcast`, which is what drives the next beat. */
export const Transcript = defineComponent<Utterance[]>({
  name: 'room:Transcript',
  reducer: append,
});

/** Who is holding the floor right now (persona entity id), or null between turns
 *  / after the user preempts. `since` is the step the floor was taken. */
export const Floor = defineComponent<{ holder: number | null; since: number }>({
  name: 'room:Floor',
});

/** Tunable room policy, kept as data so tests and the UI can adjust it.
 *  `threshold`: minimum top speaking probability to grant the floor (below it the
 *  room lulls and waits for the human). `maxConsecutiveAI`: how many AI turns in
 *  a row the driver allows before forcing a lull, so the room can't run away. */
export const RoomConfig = defineComponent<{ threshold: number; maxConsecutiveAI: number }>({
  name: 'room:Config',
});

/** The driver's per-beat gate. `arbitrate` lists it as a positive term, so the
 *  arbiter can only pick a speaker when the driver has opened the floor — that is
 *  how one `world.run()` yields exactly one utterance (so audio can play and the
 *  user can barge in between turns). The arbiter removes it once it grants. */
export const FloorOpen = defineTag('room:FloorOpen');

/** Fresh each beat: how many personas must appraise before the arbiter may act.
 *  `expect` is the roster size; `id` is the step the round opened (debugging). */
export const AppraisalRound = defineComponent<{ id: number; expect: number }>({
  name: 'room:AppraisalRound',
});

/** Persona ids that have finished appraising the latest utterance this round.
 *  Append reducer = deterministic fan-in; the arbiter's `when` guard waits until
 *  `Appraised.length >= AppraisalRound.expect` (every mind is up to date). */
export const Appraised = defineComponent<number[]>({ name: 'room:Appraised', reducer: append });

/** The arbiter's most recent probability distribution (observation only). */
export const TurnScores = defineComponent<TurnScore[]>({ name: 'room:TurnScores' });

/** The human's turn, injected from outside while the world is idle. Carries text
 *  directly, or an `audioToken` that `ingestUser` transcribes via the STT
 *  resource (raw audio never lives in a component — R3). Its arrival preempts
 *  whoever held the floor: that is the "user interrupts and takes precedence". */
export const PendingUserInput = defineComponent<{ text?: string; audioToken?: string }>({
  name: 'room:PendingUserInput',
});

// -------------------------------------------------------- PERSONA components

export const Persona = defineComponent<PersonaValue>({ name: 'room:Persona' });
export const Voice = defineComponent<VoiceValue>({ name: 'room:Voice' });
export const Mindset = defineComponent<MindsetValue>({ name: 'room:Mindset' });

/** Which room this persona belongs to (entity id) — how a persona-scoped system
 *  finds the shared blackboard to read the Transcript / report Appraised. */
export const RoomRef = defineComponent<number>({ name: 'room:RoomRef' });

/** A persona's per-beat inbox: utterances broadcast to it that it has not yet
 *  appraised. Append reducer; `appraise` drains it with `set(Heard, [])`. */
export const Heard = defineComponent<Utterance[]>({ name: 'room:Heard', reducer: append });

/** The floor grant. The arbiter adds it to the chosen persona; its arrival is the
 *  foreign dirt that wakes that persona's `speak`. `speak` removes it when done. */
export const Speaking = defineTag('room:Speaking');

// -------------------------------------------------------------- resource refs

/** The fast, non-LLM "who talks next" model. Given every persona's mindset and
 *  the last thing said, it returns a speaking probability per persona in well
 *  under a millisecond. Swappable for a trained classifier (see mind.ts). */
export interface TurnModel {
  score(input: TurnModelInput): TurnScore[];
}

export interface TurnModelInput {
  candidates: {
    id: number;
    name: string;
    interests: string[];
    mindset: MindsetValue;
  }[];
  last: Utterance | null; // the utterance everyone just heard
  step: number;
}

export const TurnModelRef = defineResource<TurnModel>('turn:model');

/** Speech in / speech out, as named resources (behaviour, never component data).
 *  Mock and real (OpenAI) implementations both satisfy these; see audio.ts. */
export interface SpeechClip {
  format: 'text' | 'mp3';
  voice: string;
  text: string;
  audioBase64?: string; // present only for real (mp3) synthesis
  approxMs: number; // playback estimate, for pacing the driver
}

export interface SpeechToText {
  transcribe(audioToken: string): Promise<string>;
}
export interface TextToSpeech {
  synthesize(text: string, voice: VoiceValue): Promise<SpeechClip>;
  /** Optional low-latency path: emit base64 audio chunks as they arrive (for
   *  progressive playback), resolving to the full clip. When present, `speak`
   *  prefers it — mirroring the model's token-streaming path. */
  stream?(
    text: string,
    voice: VoiceValue,
    onChunk: (base64Chunk: string) => void,
  ): Promise<SpeechClip>;
}

export const STTRef = defineResource<SpeechToText>('audio:stt');
export const TTSRef = defineResource<TextToSpeech>('audio:tts');

/** A convenience alias — personas each register their own Model under their own
 *  name, but they may all point at one shared client. Re-exported for callers. */
export type { Model };
