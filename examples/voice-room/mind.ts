// The "fast model" — two cheap, deterministic, non-LLM functions that run every
// beat, orders of magnitude faster and cheaper than a model call:
//
//   * appraise(): given a persona and what it just heard, drift its mindset
//     (eagerness / mood). This is a persona's gut reaction — it happens for
//     everyone, every utterance, whether or not they end up speaking.
//   * heuristicTurnModel: given everyone's mindset and the last utterance, score
//     who is most likely to speak next and pick one (or nobody — a lull).
//
// Both are intentionally simple and explainable. The point of the POC is the ECS
// choreography around them; either could be swapped for a trained tiny model
// (logistic regression / a distilled classifier over the same features) without
// touching a single system — they are just the `turn:model` resource and a pure
// helper. Determinism (no Math.random) keeps the choreography test stable; the
// live server can opt into a little jitter via `TurnModelOptions.temperature`.

import type { MindsetValue, TurnModel, TurnModelInput, TurnScore, Utterance } from './room';

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const lower = (s: string): string => s.toLowerCase();

/** Rough word overlap between an utterance and a set of interest phrases. Cheap
 *  proxy for "is this about something I care about?". */
function relevance(text: string, interests: string[]): number {
  if (interests.length === 0) return 0;
  const hay = lower(text);
  let hits = 0;
  for (const interest of interests) {
    for (const word of lower(interest).split(/\s+/)) {
      if (word.length >= 4 && hay.includes(word)) hits += 1;
    }
  }
  return clamp01(hits / 3);
}

/** Did the last utterance address this persona by name (or ask them a question)? */
function directlyAddressed(name: string, last: Utterance | null): boolean {
  if (last === null) return false;
  return lower(last.text).includes(lower(name));
}

// --------------------------------------------------------------- appraisal

/** How a persona's mindset drifts after hearing one utterance. Pure function of
 *  (current mindset, the persona's static traits, the utterance, the step). The
 *  persona-scoped `appraise` system just writes back whatever this returns. */
export function appraise(
  current: MindsetValue,
  traits: { name: string; interests: string[] },
  last: Utterance,
  step: number,
): MindsetValue {
  const mine = last.speakerId !== null && last.speaker === traits.name;
  const rel = relevance(last.text, traits.interests);
  const addressed = directlyAddressed(traits.name, last);

  // Just spoke: eagerness crashes (you don't monologue), stress eases a touch.
  if (mine) {
    return {
      ...current,
      eagerness: clamp01(current.eagerness * 0.25),
      stress: clamp01(current.stress - 0.05),
      lastSpokeStep: step,
      wantsToSay: '',
    };
  }

  // Heard someone else. Interest and being named pull you toward the floor;
  // sitting silent a while also slowly raises the urge to contribute.
  const idle = current.lastSpokeStep < 0 ? 3 : step - current.lastSpokeStep;
  const patience = clamp01(idle / 8); // longer silent -> more eager over time
  const eagerness = clamp01(
    current.eagerness * 0.7 + rel * 0.5 + (addressed ? 0.6 : 0) + patience * 0.25,
  );

  // Mood colouring — deliberately light-touch and legible.
  const positive = /\b(great|love|agree|yes|nice|good|exciting|beautiful)\b/i.test(last.text);
  const negative = /\b(no|wrong|bad|hate|stupid|disagree|terrible|boring)\b/i.test(last.text);
  return {
    eagerness,
    happiness: clamp01(current.happiness + (positive ? 0.08 : 0) - (negative ? 0.06 : 0)),
    anxiety: clamp01(current.anxiety + (addressed ? 0.05 : 0) - 0.02),
    anger: clamp01(current.anger + (negative ? 0.1 : 0) - 0.03),
    stress: clamp01(current.stress + rel * 0.03 - 0.02),
    lastSpokeStep: current.lastSpokeStep,
    wantsToSay: current.wantsToSay,
  };
}

// ------------------------------------------------------------- turn model

export interface TurnModelOptions {
  /** Minimum top probability required to grant the floor; below it the room
   *  lulls and waits for the human. */
  threshold?: number;
  /** Softmax temperature. Higher = flatter (more surprising) turn-taking. */
  temperature?: number;
}

/** The default fast turn model: a transparent weighted score per persona folded
 *  through a softmax. `pick()` (in systems.ts) takes the argmax above threshold. */
export function heuristicTurnModel(options: TurnModelOptions = {}): TurnModel {
  const temperature = options.temperature ?? 0.6;
  return {
    score(input: TurnModelInput): TurnScore[] {
      const raw = input.candidates.map((c) => {
        const m = c.mindset;
        const rel = relevance(input.last?.text ?? '', c.interests);
        const addressed = directlyAddressed(c.name, input.last);
        const justSpoke = input.last !== null && input.last.speaker === c.name;
        const arousal = (m.anger + m.anxiety + m.stress) / 3;

        let s =
          m.eagerness * 1.0 + // core drive to talk
          rel * 0.8 + // on-topic for them
          arousal * 0.4 + // agitation adds urgency...
          m.happiness * 0.2; // ...but so does being into it
        if (addressed) s += 1.2; // named / questioned -> strong pull
        if (justSpoke) s -= 1.5; // don't immediately re-take the floor
        return { id: c.id, name: c.name, s };
      });

      // Softmax over the raw scores.
      const t = Math.max(temperature, 0.05);
      const max = Math.max(...raw.map((r) => r.s));
      const exps = raw.map((r) => Math.exp((r.s - max) / t));
      const sum = exps.reduce((a, b) => a + b, 0) || 1;
      return raw.map((r, i) => ({ id: r.id, name: r.name, p: (exps[i] as number) / sum }));
    },
  };
}

/** Pick the next speaker from a score distribution, or `null` for a lull.
 *  Deterministic (argmax); ties broken by the lower entity id for stability. */
export function pickSpeaker(scores: TurnScore[], threshold: number): TurnScore | null {
  let best: TurnScore | null = null;
  for (const s of scores) {
    if (best === null || s.p > best.p || (s.p === best.p && s.id < best.id)) best = s;
  }
  if (best === null || best.p < threshold) return null;
  return best;
}
