// The beat driver — the thin real-time layer around the world. It does three
// things and nothing else:
//
//   * userSays()  — inject a human turn while the world is idle (the ONLY time
//     external mutation is legal, R16). This is the interrupt path: it preempts
//     the floor and re-routes the conversation.
//   * beat()      — open the floor for exactly one utterance and run to
//     quiescence, returning what was said (or a lull). Between beats the world
//     is idle, so audio can play and the user can barge in.
//   * turns()     — an async generator of beats until the room lulls or a
//     consecutive-AI cap is hit. The consumer (CLI or server) drives playback
//     and barge-in around it.
//
// Why one utterance per beat: a persona speaking takes real wall-clock time to
// hear. If a whole exchange ran to quiescence in one go, all the audio would be
// generated up front and the user could never cut in. Gating the arbiter with
// FloorOpen (added here, consumed there) makes each `world.run()` yield a single
// utterance, so barge-in is just "inject on the next idle boundary".

import type { EntityTarget, Run, World } from '@langecs/core';
import { FloorOpen, PendingUserInput, RoomConfig } from './room';
import type { RoomEvent } from './systems';

export interface Beat {
  status: 'spoke' | 'lull';
  utterance?: Extract<RoomEvent, { kind: 'utterance' }>;
  events: RoomEvent[]; // every room event emitted during the beat, in order
  steps: number;
}

async function collect(run: Run, onEvent?: (e: RoomEvent) => void): Promise<RoomEvent[]> {
  const events: RoomEvent[] = [];
  for await (const ev of run) {
    if (ev.type === 'custom') {
      const data = ev.data as RoomEvent;
      events.push(data);
      onEvent?.(data);
    }
  }
  await run; // surface any rejection
  return events;
}

export class RoomDriver {
  private readonly maxConsecutiveAI: number;

  constructor(
    private readonly world: World,
    private readonly room: EntityTarget,
    private readonly onEvent?: (e: RoomEvent) => void,
  ) {
    const cfg = world.entity(typeof room === 'number' ? room : room.id)?.get(RoomConfig);
    this.maxConsecutiveAI = cfg?.maxConsecutiveAI ?? 6;
  }

  /** Inject a human turn and let it settle (ingest + appraise). Idle-only. The
   *  new line preempts the floor and refreshes every persona's mindset, so the
   *  next beat's arbitration already accounts for what the user just said. */
  async userSays(input: { text?: string; audioToken?: string }): Promise<RoomEvent[]> {
    if (this.world.running) throw new Error('userSays() must be called while the world is idle');
    return collect(this.world.send(this.room, PendingUserInput(input)), this.onEvent);
  }

  /** Run exactly one beat: open the floor, run to quiescence, report the single
   *  utterance (or lull). */
  async beat(): Promise<Beat> {
    const roomHandle = this.world.entity(typeof this.room === 'number' ? this.room : this.room.id);
    roomHandle?.add(FloorOpen); // external dirt: newly matches arbitrate
    const run = this.world.run();
    const events = await collect(run, this.onEvent);
    const result = await run;
    const utterance = events.find((e): e is Extract<RoomEvent, { kind: 'utterance' }> => e.kind === 'utterance');
    return {
      status: utterance ? 'spoke' : 'lull',
      utterance,
      events,
      steps: result.steps,
    };
  }

  /** Beats until the room lulls or the consecutive-AI cap is reached. The
   *  consumer plays each beat's audio between iterations; to let the user barge
   *  in, buffer their input, `break` this loop, then call `userSays()`. */
  async *turns(max = this.maxConsecutiveAI): AsyncGenerator<Beat> {
    for (let i = 0; i < max; i++) {
      const beat = await this.beat();
      yield beat;
      if (beat.status === 'lull') return;
    }
  }
}
