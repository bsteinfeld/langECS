// The browser room — a tiny node:http server (Server-Sent Events, no WebSocket
// dependency) that drives one live LangECS voice-room world and streams every
// utterance to the page. Open it and push-to-talk:
//
//   pnpm -C examples voice-room-server        # http://localhost:8787
//
// Audio is zero-key by default: the browser does speech recognition and speaks
// each persona with the free Web Speech API (distinct rate/pitch per persona).
// Set OPENAI_API_KEY (in <repo-root>/.env.local) to voice each persona with
// gpt-4o-mini; add VOICE_ROOM_OPENAI_AUDIO=1 to also use OpenAI Whisper + TTS
// (real mp3 audio streamed to the page) instead of the browser's built-in voices.
//
// Pacing and barge-in are driven from the page: after each utterance the server
// waits for a /continue (the page finished playing) before generating the next
// beat, and a /say at any time preempts — the world only ever mutates while it is
// idle between beats (R16).

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import { AudioStore, mockSTT, mockTTS, openaiSTT, openaiTTS } from './audio';
import { RoomDriver } from './driver';
import { heuristicTurnModel } from './mind';
import { cannedModel } from './offline';
import { buildRoom, DEFAULT_PERSONAS } from './personas';
import { STTRef, TTSRef, TurnModelRef } from './room';
import type { RoomEvent } from './systems';

loadEnvLocal();

const PORT = Number(process.env.VOICE_ROOM_PORT ?? 8787);
const HERE = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.OPENAI_API_KEY;
const useOpenAiAudio = Boolean(apiKey) && process.env.VOICE_ROOM_OPENAI_AUDIO === '1';

// ---------------------------------------------------------------- the world

const world = createWorld({ id: 'voice-room-web' });
for (const spec of DEFAULT_PERSONAS) {
  world.register(
    spec.persona.model,
    apiKey ? fromAiSdk(openai('gpt-4o-mini')) : cannedModel(spec.persona.name),
  );
}
world.register(TurnModelRef, heuristicTurnModel({ temperature: 0.7 }));

const audioStore = new AudioStore();
if (useOpenAiAudio && apiKey) {
  world.register(TTSRef, openaiTTS({ apiKey }));
  world.register(STTRef, openaiSTT({ apiKey }, audioStore));
} else {
  world.register(TTSRef, mockTTS());
  world.register(STTRef, mockSTT());
}

const handles = buildRoom(world);

// ------------------------------------------------------------- SSE plumbing

const clients = new Set<ServerResponse>();

function broadcast(message: unknown): void {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(line);
}

// The driver streams every room event (tokens, scores, utterances, lulls)
// straight out to every connected page.
const driver = new RoomDriver(world, handles.room.id, (e: RoomEvent) =>
  broadcast({ t: 'event', e }),
);

// ------------------------------------------------------------ the pump loop

let pending: { text?: string; audioToken?: string } | null = null;
let running = false;
let gate: (() => void) | null = null;

/** Wait until the page acknowledges it finished playing the current utterance
 *  (/continue) or the user barges in (/say). */
function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    gate = resolve;
  });
}
function releaseGate(): void {
  const g = gate;
  gate = null;
  g?.();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (pending !== null) {
        const input = pending;
        pending = null;
        broadcast({ t: 'thinking' });
        await driver.userSays(input); // world is idle here — legal (R16)
      }
      const beat = await driver.beat();
      if (beat.status === 'lull') {
        broadcast({ t: 'lull' });
        if (pending !== null) continue; // user spoke during the beat — keep going
        break; // quiet: wait for the next /say to restart the pump
      }
      broadcast({ t: 'beat', approxMs: beat.utterance?.approxMs ?? 800 });
      await waitForContinue(); // page plays the audio, then unblocks us
    }
  } finally {
    running = false;
  }
}

/** A human turn (text or audio token). Preempts playback and (re)starts the pump. */
function submitUser(input: { text?: string; audioToken?: string }): void {
  pending = input;
  broadcast({ t: 'preempt' }); // pages stop any in-flight playback immediately
  releaseGate(); // let a waiting pump proceed to process the new turn
  void pump();
}

// --------------------------------------------------------------- http layer

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
  try {
    const body = await readFile(join(HERE, 'ui', file));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html'))
    return serveStatic(res, 'index.html');
  if (req.method === 'GET' && path === '/app.js') return serveStatic(res, 'app.js');

  if (req.method === 'GET' && path === '/roster') {
    return json(res, {
      audioMode: useOpenAiAudio ? 'openai' : 'web',
      thinking: apiKey ? 'gpt-4o-mini' : 'offline (canned lines)',
      personas: handles.personas.map((p) => ({
        id: p.id,
        name: p.spec.persona.name,
        blurb: p.spec.persona.blurb,
        openaiVoice: p.spec.voice.openaiVoice,
        web: p.spec.voice.web,
      })),
    });
  }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/say') {
    const body = await readBody(req);
    const { text } = JSON.parse(body.toString() || '{}') as { text?: string };
    if (text?.trim()) submitUser({ text: text.trim() });
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/say-audio') {
    const body = await readBody(req);
    const token = audioStore.put({
      bytes: new Uint8Array(body),
      mime: req.headers['content-type'] ?? 'audio/webm',
    });
    submitUser({ audioToken: token });
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/continue') {
    releaseGate();
    return json(res, { ok: true });
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  voice-room is live → http://localhost:${PORT}`);
  console.log(
    `  thinking: ${apiKey ? 'gpt-4o-mini per persona' : 'offline canned lines (set OPENAI_API_KEY for real replies)'}`,
  );
  console.log(
    `  audio:    ${useOpenAiAudio ? 'OpenAI Whisper + TTS' : 'browser Web Speech (zero-key)'}`,
  );
  console.log(`  in the room: ${handles.personas.map((p) => p.spec.persona.name).join(', ')}\n`);
});
