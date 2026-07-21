// The offline brain: a never-exhausting, deterministic Model per persona, so the
// room runs with no API key. Each persona rotates through a few in-character
// canned lines. Shared by the CLI demo and the server's no-key mode; swap in a
// real client (fromAiSdk/fromLangChain) to make the room actually think.

import type { Model, Msg } from '@langecs/core';

const CANNED: Record<string, string[]> = {
  Sage: [
    'Before we race ahead, what are we actually trying to make better here?',
    'Speed is seductive, but meaning is what we remember.',
    'I think the quiet question underneath this is about trust.',
    'Let us not confuse motion with progress.',
  ],
  Nova: [
    'Oh this is exciting — the tech to do this already basically exists!',
    'Imagine the upside though! We could prototype it this weekend.',
    'Rex, even you have to admit the trajectory here is wild.',
    'That rocket launch last night? Chills. This is the same energy.',
  ],
  Rex: [
    'Sure, but who pays for it when it breaks? Follow the money.',
    "I've seen this movie before. The demo dazzles, the bill arrives later.",
    'Fine, it is promising — I just want one honest risk on the table.',
    'Optimism is cheap. Show me the failure mode.',
  ],
};

export function cannedModel(name: string): Model {
  const pool = CANNED[name] ?? ['Hm.'];
  let i = 0;
  const turn = (): Msg => ({ role: 'assistant', content: pool[i++ % pool.length] as string });
  return { generate: () => Promise.resolve({ message: turn() }) };
}
