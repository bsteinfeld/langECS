// Deterministic choreography test — core scriptedModel + a scripted turn model,
// zero network, no API key. Proves the room is pure dirty-triggering:
//
//   * one beat = one utterance, at a fixed step shape (arbitrate → speak →
//     broadcast → appraise×N), with no system re-triggering on its own writes;
//   * a lull is a one-step beat that grants no floor and quiesces;
//   * a user turn preempts the floor and re-routes the conversation.
//
// The turn model is stubbed so the running order is fixed; the real heuristic
// (mind.ts) is unit-tested separately below.

import { createWorld, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { mockSTT, mockTTS } from './audio';
import { RoomDriver } from './driver';
import { appraise, heuristicTurnModel, pickSpeaker } from './mind';
import { buildRoom } from './personas';
import {
  Floor,
  type MindsetValue,
  STTRef,
  Transcript,
  TTSRef,
  type TurnModel,
  TurnModelRef,
} from './room';

/** A turn model that grants the floor to a fixed sequence of persona ids (null =
 *  lull). Consumed once per arbitration (i.e. once per beat). */
function scriptedTurns(order: (number | null)[]): TurnModel {
  let i = 0;
  return {
    score(input) {
      const pick = order[i++] ?? null;
      return input.candidates.map((c) => ({
        id: c.id,
        name: c.name,
        p: c.id === pick ? 0.9 : 0.05,
      }));
    },
  };
}

function makeRoom(order: (number | null)[]) {
  const world = createWorld({ id: 'voice-test' });
  for (const name of ['Sage', 'Nova', 'Rex']) {
    world.register(
      `model:${name.toLowerCase()}`,
      scriptedModel([
        { role: 'assistant', content: `${name} says something.` },
        { role: 'assistant', content: `${name} adds a follow-up.` },
      ]),
    );
  }
  const handles = buildRoom(world, { threshold: 0.4 });
  const idByName = new Map(handles.personas.map((p) => [p.spec.persona.name, p.id]));
  world.register(TurnModelRef, scriptedTurns(order));
  world.register(STTRef, mockSTT());
  world.register(TTSRef, mockTTS());
  return { world, handles, idByName };
}

test('one beat = one utterance; fixed step shape; self-write exclusion; then a lull', async () => {
  const { world, handles, idByName } = makeRoom([]);
  const nova = idByName.get('Nova') as number;
  const rex = idByName.get('Rex') as number;
  const sage = idByName.get('Sage') as number;
  // Rebuild the turn model now that ids are known: Nova, Rex, Sage, then lull.
  world.register(TurnModelRef, scriptedTurns([nova, rex, sage, null]));

  const driver = new RoomDriver(world, handles.room.id);

  // The human opens. This settles ingest + appraisal with no speaker chosen
  // (the floor is closed until a beat opens it).
  await driver.userSays({ text: 'What do you all think about AI and rockets?' });
  expect(handles.room.get(Floor)?.holder).toBeNull();

  const beats = [];
  for await (const beat of driver.turns()) beats.push(beat);

  // Three personas spoke in the scripted order, then the room lulled.
  expect(beats.map((b) => b.status)).toEqual(['spoke', 'spoke', 'spoke', 'lull']);
  expect(beats.slice(0, 3).map((b) => b.utterance?.who)).toEqual(['Nova', 'Rex', 'Sage']);

  // A spoken beat is exactly 4 steps (arbitrate, speak, broadcast, appraise×N);
  // a lull is 1 (arbitrate grants nobody and the world quiesces).
  expect(beats.slice(0, 3).map((b) => b.steps)).toEqual([4, 4, 4]);
  expect(beats[3]?.steps).toBe(1);

  // Exactly one arbitration ('scores') and one utterance per spoken beat — no
  // system re-fired on its own writes.
  for (const beat of beats.slice(0, 3)) {
    expect(beat.events.filter((e) => e.kind === 'scores')).toHaveLength(1);
    expect(beat.events.filter((e) => e.kind === 'utterance')).toHaveLength(1);
    expect(beat.events.some((e) => e.kind === 'token')).toBe(true); // streamed
  }

  // The shared transcript: the user, then the three personas in order.
  const transcript = handles.room.get(Transcript) ?? [];
  expect(transcript.map((u) => u.speaker)).toEqual(['user', 'Nova', 'Rex', 'Sage']);

  // After the lull nobody holds the floor; a bare re-run does nothing.
  expect(handles.room.get(Floor)?.holder).toBeNull();
  const again = await world.run();
  expect(again.status).toBe('idle');

  // suppress unused-var lint for sage in case the order changes
  void sage;
});

test('user barge-in preempts the floor and re-routes the conversation', async () => {
  const { world, handles, idByName } = makeRoom([]);
  const nova = idByName.get('Nova') as number;
  const rex = idByName.get('Rex') as number;
  world.register(TurnModelRef, scriptedTurns([nova, rex, nova, rex]));

  const driver = new RoomDriver(world, handles.room.id);

  await driver.userSays({ text: 'Kick us off — talk about anything.' });
  const first = await driver.beat();
  expect(first.utterance?.who).toBe('Nova');

  // The user cuts in between beats (the world is idle here — the only legal
  // moment, R16). The floor is cleared and the human line lands in the transcript
  // before any further AI turn.
  await driver.userSays({ text: 'Stop — I want to change the subject.' });
  expect(handles.room.get(Floor)?.holder).toBeNull();

  const transcript = handles.room.get(Transcript) ?? [];
  expect(transcript.map((u) => u.speaker)).toEqual(['user', 'Nova', 'user']);
  expect(transcript.at(-1)?.text).toBe('Stop — I want to change the subject.');

  // The conversation continues from the new user turn on the next beat.
  const next = await driver.beat();
  expect(next.utterance?.who).toBe('Rex');
});

test('the fast turn model: interest and direct address raise speaking probability', () => {
  const model = heuristicTurnModel({ threshold: 0.4 });
  const base: MindsetValue = {
    eagerness: 0.4,
    happiness: 0.5,
    anxiety: 0.1,
    anger: 0.1,
    stress: 0.1,
    lastSpokeStep: -1,
    wantsToSay: '',
  };
  const scores = model.score({
    step: 5,
    last: {
      speaker: 'user',
      speakerId: null,
      text: 'Nova, tell me about rockets and space!',
      step: 4,
    },
    candidates: [
      { id: 2, name: 'Sage', interests: ['ethics', 'meaning'], mindset: base },
      { id: 3, name: 'Nova', interests: ['space', 'rockets', 'technology'], mindset: base },
      { id: 4, name: 'Rex', interests: ['risk', 'money'], mindset: base },
    ],
  });
  const byName = new Map(scores.map((s) => [s.name, s.p]));
  // Nova is named AND the topic is hers — clearly the most likely next speaker.
  expect(pickSpeaker(scores, 0.4)?.name).toBe('Nova');
  expect(byName.get('Nova') as number).toBeGreaterThan(byName.get('Sage') as number);
  expect(byName.get('Nova') as number).toBeGreaterThan(byName.get('Rex') as number);
});

test('appraisal: hearing your own line crashes eagerness; being named raises it', () => {
  const start: MindsetValue = {
    eagerness: 0.5,
    happiness: 0.5,
    anxiety: 0.2,
    anger: 0.1,
    stress: 0.2,
    lastSpokeStep: -1,
    wantsToSay: '',
  };
  const traits = { name: 'Nova', interests: ['space', 'rockets'] };

  const afterOwn = appraise(
    start,
    traits,
    { speaker: 'Nova', speakerId: 3, text: 'I just spoke.', step: 6 },
    6,
  );
  expect(afterOwn.eagerness).toBeLessThan(start.eagerness);
  expect(afterOwn.lastSpokeStep).toBe(6);

  const afterNamed = appraise(
    start,
    traits,
    { speaker: 'user', speakerId: null, text: 'Hey Nova, what about rockets?', step: 6 },
    6,
  );
  expect(afterNamed.eagerness).toBeGreaterThan(start.eagerness);
});
