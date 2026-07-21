// Voice-room CLI demo — the multi-persona room narrated in the terminal, so you
// can see the back end without a microphone. For the full talk-and-listen
// experience, run the browser room instead:
//
//   pnpm -C examples voice-room-server        # then open http://localhost:8787
//
// This CLI drives the same world. It prints, for every beat, the fast turn
// model's speaking-probability bar (who the arbiter considered and picked), the
// line that was spoken, and the speaker's live mindset. With OPENAI_API_KEY set
// (in <repo-root>/.env.local) each persona is voiced by gpt-4o-mini; without a
// key it falls back to canned, deterministic lines so the choreography still
// runs offline.
//
//   pnpm -C examples voice-room

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { mockSTT, mockTTS } from './audio';
import { RoomDriver } from './driver';
import { heuristicTurnModel } from './mind';
import { cannedModel } from './offline';
import { buildRoom, DEFAULT_PERSONAS } from './personas';
import { Mindset, type MindsetValue, Persona, STTRef, TTSRef, TurnModelRef } from './room';
import type { Beat } from './driver';
import type { RoomEvent } from './systems';
import type { RoomHandles } from './personas';

loadEnvLocal();
const live = Boolean(process.env.OPENAI_API_KEY);

const world = createWorld({ id: 'voice-room-cli' });
for (const spec of DEFAULT_PERSONAS) {
  const model = live ? fromAiSdk(openai('gpt-4o-mini')) : cannedModel(spec.persona.name);
  world.register(spec.persona.model, model);
}
world.register(TurnModelRef, heuristicTurnModel({ temperature: 0.55 }));
world.register(STTRef, mockSTT());
world.register(TTSRef, mockTTS());

const handles = buildRoom(world);
const driver = new RoomDriver(world, handles.room.id);

// ---------------------------------------------------------------- rendering

const bar = (p: number): string => {
  const n = Math.round(p * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
};

function renderScores(beat: Beat): void {
  const scores = beat.events.find((e): e is Extract<RoomEvent, { kind: 'scores' }> => e.kind === 'scores');
  if (!scores) return;
  console.log('   turn model → who speaks next:');
  for (const s of [...scores.scores].sort((a, b) => b.p - a.p)) {
    const marker = s.id === scores.pickId ? ' ◀ floor' : '';
    console.log(`     ${s.name.padEnd(5)} ${bar(s.p)} ${s.p.toFixed(2)}${marker}`);
  }
}

function renderMindset(speakerId: number): void {
  const m = world.entity(speakerId)?.get(Mindset) as MindsetValue | undefined;
  const who = world.entity(speakerId)?.get(Persona)?.name ?? '?';
  if (!m) return;
  const f = (v: number) => v.toFixed(2);
  console.log(
    `   ${who} mindset · eager ${f(m.eagerness)} · happy ${f(m.happiness)} · ` +
      `anxious ${f(m.anxiety)} · angry ${f(m.anger)} · stressed ${f(m.stress)}`,
  );
}

function renderBeat(beat: Beat): void {
  console.log('');
  renderScores(beat);
  if (beat.status === 'lull') {
    console.log('   … the room falls quiet, waiting for you.');
    return;
  }
  const u = beat.utterance;
  if (u) {
    console.log(`\n   🗣  ${u.who}: ${u.text}`);
    renderMindset(u.whoId);
  }
}

async function humanTurn(text: string): Promise<void> {
  console.log(`\n\n🎙  You: ${text}`);
  await driver.userSays({ text });
  for await (const beat of driver.turns()) renderBeat(beat);
}

// -------------------------------------------------------------------- run

async function main(handlesRef: RoomHandles): Promise<void> {
  console.log(`voice-room — ${live ? 'live (gpt-4o-mini per persona)' : 'offline (canned lines)'}`);
  console.log('in the room:');
  for (const p of handlesRef.personas) console.log(`   • ${p.spec.persona.name} — ${p.spec.persona.blurb}`);

  await humanTurn('Hey everyone — should we trust AI to run important things?');
  // A barge-in: the user changes the subject; the floor is preempted and the
  // room re-routes around the new turn.
  await humanTurn('Nova, switch gears — tell me about that rocket launch.');

  console.log('\n\n— end of demo. In the browser room you can push-to-talk and hear each voice. —');
}

await main(handles);
