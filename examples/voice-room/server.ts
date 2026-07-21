// The browser room — a tiny node:http server (Server-Sent Events, no WebSocket
// dependency) that drives one live LangECS voice-room world and streams every
// utterance to the page. Open it and push-to-talk:
//
//   pnpm -C examples voice-room-server        # http://localhost:8787
//
// The room is a rebuildable SESSION: the page's setup panel lets you add / edit /
// remove personas and choose the audio backend before the conversation starts,
// then POSTs /session to rebuild the world from scratch. Endpoints:
//
//   GET  /config    — current personas + audio settings + available options
//   GET  /events     — the live SSE stream (tokens, scores, utterances, audio…)
//   POST /session    — rebuild the room from a posted roster + audio settings
//   POST /say         — a human turn (text); also the barge-in signal
//   POST /say-audio   — a human turn (raw audio, transcribed via OpenAI STT)
//   POST /stop        — halt the conversation and silence playback
//   POST /continue    — "page finished playing that utterance; send the next beat"
//
// Audio backends: `web` (zero-key; the browser speaks each persona with the Web
// Speech API) or `openai` (server-side Whisper + TTS, real audio streamed to the
// page; needs OPENAI_API_KEY). Persona *thinking* uses gpt-4o-mini when a key is
// present, otherwise deterministic canned lines.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { createWorld, type Model, type World } from '@langecs/core';
import { loadEnvLocal } from '../_shared/env';
import {
  AudioStore,
  mockSTT,
  mockTTS,
  OPENAI_TTS_MODELS,
  OPENAI_VOICES,
  openaiSTT,
  openaiStreamingTTS,
  openaiTTS,
} from './audio';
import { RoomDriver } from './driver';
import { heuristicTurnModel } from './mind';
import { cannedModel } from './offline';
import { buildRoom, DEFAULT_PERSONAS, type PersonaSpec, type RoomHandles } from './personas';
import { STTRef, TTSRef, TurnModelRef, type VoiceValue } from './room';
import type { RoomEvent } from './systems';

loadEnvLocal();

const PORT = Number(process.env.VOICE_ROOM_PORT ?? 8787);
const HERE = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.OPENAI_API_KEY;

// ------------------------------------------------------------ config types
// What the page's setup panel sends. Personas here carry no resource names — the
// server assigns and registers a model per persona on (re)build.

interface AudioSettings {
  backend: 'web' | 'openai';
  openaiModel: string; // one of OPENAI_TTS_MODELS
  streaming: boolean; // openai only: stream audio for lower latency
}

interface PersonaConfig {
  name: string;
  blurb: string;
  systemPrompt: string;
  interests: string[];
  knowledge: string;
  baseline: {
    eagerness: number;
    happiness: number;
    anxiety: number;
    anger: number;
    stress: number;
  };
  voice: VoiceValue;
}

interface SessionConfig {
  personas: PersonaConfig[];
  audio: AudioSettings;
  threshold?: number;
  maxConsecutiveAI?: number;
}

const DEFAULT_AUDIO: AudioSettings = {
  backend: 'web',
  openaiModel: 'gpt-4o-mini-tts',
  streaming: true,
};

const configFromSpec = (spec: PersonaSpec): PersonaConfig => ({
  name: spec.persona.name,
  blurb: spec.persona.blurb,
  systemPrompt: spec.persona.systemPrompt,
  interests: spec.persona.interests,
  knowledge: spec.persona.knowledge,
  baseline: spec.persona.baseline,
  voice: spec.voice,
});

const specFromConfig = (c: PersonaConfig, index: number): PersonaSpec => ({
  persona: {
    name: c.name,
    blurb: c.blurb,
    systemPrompt: c.systemPrompt,
    interests: c.interests,
    knowledge: c.knowledge,
    model: `model:p${index}`, // assigned + registered by the session
    baseline: c.baseline,
  },
  voice: c.voice,
});

// --------------------------------------------------------------- SSE clients

const clients = new Set<ServerResponse>();
function broadcast(message: unknown): void {
  const line = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(line);
}

// -------------------------------------------------------------- room session
// One conversation: its own world, driver, and pump state. Rebuilt whenever the
// user applies new personas / audio settings.

class RoomSession {
  readonly world: World;
  readonly handles: RoomHandles;
  readonly audio: AudioSettings;
  readonly specs: PersonaSpec[];
  readonly audioStore = new AudioStore();
  private readonly driver: RoomDriver;

  private pending: { text?: string; audioToken?: string } | null = null;
  private running = false;
  private stopping = false;
  private gate: (() => void) | null = null;

  constructor(config: SessionConfig) {
    this.audio = config.audio;
    this.specs = config.personas.map(specFromConfig);
    this.world = createWorld({ id: 'voice-room-web' });

    for (const spec of this.specs) {
      const model: Model = apiKey
        ? fromAiSdk(openai('gpt-4o-mini'))
        : cannedModel(spec.persona.name);
      this.world.register(spec.persona.model, model);
    }
    this.world.register(TurnModelRef, heuristicTurnModel({ temperature: 0.7 }));

    if (this.audio.backend === 'openai' && apiKey) {
      const opts = { apiKey, ttsModel: this.audio.openaiModel };
      this.world.register(
        TTSRef,
        this.audio.streaming ? openaiStreamingTTS(opts) : openaiTTS(opts),
      );
      this.world.register(STTRef, openaiSTT({ apiKey }, this.audioStore));
    } else {
      this.world.register(TTSRef, mockTTS());
      this.world.register(STTRef, mockSTT());
    }

    this.handles = buildRoom(this.world, {
      personas: this.specs,
      threshold: config.threshold,
      maxConsecutiveAI: config.maxConsecutiveAI,
    });
    this.driver = new RoomDriver(this.world, this.handles.room.id, (e: RoomEvent) =>
      broadcast({ t: 'event', e }),
    );
  }

  roster() {
    return {
      audioMode: this.audio.backend,
      streaming: this.audio.streaming,
      thinking: apiKey ? 'gpt-4o-mini' : 'offline (canned lines)',
      personas: this.handles.personas.map((p) => ({
        id: p.id,
        name: p.spec.persona.name,
        blurb: p.spec.persona.blurb,
        openaiVoice: p.spec.voice.openaiVoice,
        web: p.spec.voice.web,
      })),
    };
  }

  private waitForContinue(): Promise<void> {
    return new Promise((resolve) => {
      this.gate = resolve;
    });
  }
  private releaseGate(): void {
    const g = this.gate;
    this.gate = null;
    g?.();
  }

  submitUser(input: { text?: string; audioToken?: string }): void {
    this.stopping = false;
    this.pending = input;
    broadcast({ t: 'preempt' }); // pages stop any in-flight playback immediately
    this.releaseGate();
    void this.pump();
  }

  stop(): void {
    this.stopping = true;
    this.pending = null;
    this.releaseGate();
    broadcast({ t: 'stopped' });
  }

  continue(): void {
    this.releaseGate();
  }

  putAudio(bytes: Uint8Array, mime: string): string {
    return this.audioStore.put({ bytes, mime });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.stopping) break;
        if (this.pending !== null) {
          const input = this.pending;
          this.pending = null;
          broadcast({ t: 'thinking' });
          await this.driver.userSays(input); // world is idle here — legal (R16)
        }
        const beat = await this.driver.beat();
        if (this.stopping) break;
        if (beat.status === 'lull') {
          broadcast({ t: 'lull' });
          if (this.pending !== null) continue;
          break;
        }
        broadcast({ t: 'beat', approxMs: beat.utterance?.approxMs ?? 800 });
        await this.waitForContinue(); // page plays audio, then unblocks us
      }
    } finally {
      this.running = false;
    }
  }
}

let session = new RoomSession({
  personas: DEFAULT_PERSONAS.map(configFromSpec),
  audio: apiKey ? DEFAULT_AUDIO : { ...DEFAULT_AUDIO, backend: 'web' },
});

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

  if (req.method === 'GET' && path === '/config') {
    return json(res, {
      openaiAvailable: Boolean(apiKey),
      ttsModels: OPENAI_TTS_MODELS,
      voices: OPENAI_VOICES,
      audio: session.audio,
      roster: session.roster(),
      personas: session.specs.map(configFromSpec),
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

  if (req.method === 'POST' && path === '/session') {
    const body = await readBody(req);
    const config = JSON.parse(body.toString() || '{}') as SessionConfig;
    if (!Array.isArray(config.personas) || config.personas.length === 0)
      return json(res, { error: 'need at least one persona' }, 400);
    if (config.personas.length > 6) return json(res, { error: 'max 6 personas' }, 400);
    session.stop(); // halt any running conversation before swapping worlds
    session = new RoomSession({ ...config, audio: config.audio ?? DEFAULT_AUDIO });
    broadcast({ t: 'reset' }); // pages clear the transcript and refetch /config
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/say') {
    const body = await readBody(req);
    const { text } = JSON.parse(body.toString() || '{}') as { text?: string };
    if (text?.trim()) session.submitUser({ text: text.trim() });
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/say-audio') {
    const body = await readBody(req);
    const token = session.putAudio(
      new Uint8Array(body),
      req.headers['content-type'] ?? 'audio/webm',
    );
    session.submitUser({ audioToken: token });
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/stop') {
    session.stop();
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && path === '/continue') {
    session.continue();
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
    `  audio:    web speech by default${apiKey ? ' · OpenAI TTS available in setup' : ''}`,
  );
  console.log('  edit the cast + audio in the setup panel, then push-to-talk.\n');
});
