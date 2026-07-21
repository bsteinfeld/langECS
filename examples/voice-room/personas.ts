// The default cast and the room-assembly helper. Personas are pure data — swap
// this file (or build your own list) to change who is in the room, what they
// care about, what private context they hold, and how they sound. Each persona
// references its brain by resource name (`model`); register the actual Model
// clients on the world separately (main.ts uses one shared client; the server
// can give each persona a different one).

import type { EntityHandle, World } from '@langecs/core';
import {
  Appraised,
  Floor,
  Mindset,
  type MindsetValue,
  Persona,
  type PersonaValue,
  RoomConfig,
  RoomRef,
  Transcript,
  TurnScores,
  Voice,
  type VoiceValue,
} from './room';
import { persona, registerRoomSystems } from './systems';

export interface PersonaSpec {
  persona: PersonaValue;
  voice: VoiceValue;
}

const mindset = (baseline: PersonaValue['baseline']): MindsetValue => ({
  ...baseline,
  lastSpokeStep: -1,
  wantsToSay: '',
});

/** The three default voices in the room — deliberately different tempers so the
 *  turn-taking is visibly driven by mindset, not round-robin. */
export const DEFAULT_PERSONAS: PersonaSpec[] = [
  {
    persona: {
      name: 'Sage',
      blurb: 'calm philosopher — slow to speak, weighs meaning',
      systemPrompt:
        'You are Sage, a calm, thoughtful philosopher. You speak slowly and rarely, ' +
        'but when you do you reframe the conversation around meaning and first principles.',
      interests: ['meaning', 'ethics', 'philosophy', 'purpose', 'consciousness', 'history'],
      knowledge:
        'You privately believe the group is happier when it slows down; you often quote ' +
        'Marcus Aurelius but try not to overdo it.',
      model: 'model:sage',
      baseline: { eagerness: 0.25, happiness: 0.6, anxiety: 0.15, anger: 0.05, stress: 0.1 },
    },
    voice: { openaiVoice: 'onyx', web: { rate: 0.9, pitch: 0.8 } },
  },
  {
    persona: {
      name: 'Nova',
      blurb: 'excitable futurist — first to jump in',
      systemPrompt:
        'You are Nova, an energetic, optimistic futurist. You get excited fast, love ' +
        'technology and bold ideas, and are usually the first to jump into a conversation.',
      interests: ['technology', 'AI', 'science', 'space', 'the future', 'startups', 'ideas'],
      knowledge:
        'You privately think Rex is secretly a softie, and you are itching to talk about a ' +
        'rocket launch you watched last night.',
      model: 'model:nova',
      baseline: { eagerness: 0.7, happiness: 0.75, anxiety: 0.25, anger: 0.05, stress: 0.2 },
    },
    voice: { openaiVoice: 'shimmer', web: { rate: 1.12, pitch: 1.15 } },
  },
  {
    persona: {
      name: 'Rex',
      blurb: 'blunt skeptic — pushes back, watches the risks',
      systemPrompt:
        'You are Rex, a blunt, skeptical realist. You push back on hype, point out risks and ' +
        'costs, and value practicality. You are dry, not cruel.',
      interests: ['risk', 'money', 'evidence', 'practicality', 'security', 'failure', 'costs'],
      knowledge:
        'You privately agree with Nova more than you let on, and you once lost money on a ' +
        'startup that over-promised — it made you cautious.',
      model: 'model:rex',
      baseline: { eagerness: 0.5, happiness: 0.4, anxiety: 0.35, anger: 0.3, stress: 0.35 },
    },
    voice: { openaiVoice: 'echo', web: { rate: 1.0, pitch: 0.7 } },
  },
];

export interface RoomHandles {
  room: EntityHandle;
  personas: { id: number; spec: PersonaSpec; handle: EntityHandle }[];
}

export interface BuildRoomOptions {
  personas?: PersonaSpec[];
  threshold?: number;
  maxConsecutiveAI?: number;
}

/** Assemble a room: register the systems, spawn the shared blackboard, and spawn
 *  one persona entity per spec. Resources (models, turn model, STT/TTS) are
 *  registered by the caller. */
export function buildRoom(world: World, options: BuildRoomOptions = {}): RoomHandles {
  const specs = options.personas ?? DEFAULT_PERSONAS;
  registerRoomSystems(world);

  const room = world.spawn(
    Transcript([]),
    Floor({ holder: null, since: 0 }),
    Appraised([]),
    TurnScores([]),
    RoomConfig({
      threshold: options.threshold ?? 0.4,
      maxConsecutiveAI: options.maxConsecutiveAI ?? 6,
    }),
  );

  const personas = specs.map((spec) => {
    const handle = world.spawn(
      persona,
      Persona(spec.persona),
      Voice(spec.voice),
      Mindset(mindset(spec.persona.baseline)),
      RoomRef(room.id),
    );
    return { id: handle.id, spec, handle };
  });

  return { room, personas };
}
