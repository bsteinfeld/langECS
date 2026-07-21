// Speech in / speech out, as swappable world resources. Two implementations of
// each interface:
//
//   * mock — deterministic, zero-network, zero-key. The mock TTS returns no audio
//     bytes; it just tags the clip with the persona's voice so the browser can
//     speak it locally with the free Web Speech API (distinct rate/pitch per
//     persona). This is what tests and the default browser room use.
//   * OpenAI — real Whisper transcription and TTS synthesis, gated on
//     OPENAI_API_KEY. The TTS clip carries base64 mp3 the browser plays directly.
//
// Nothing else in the room changes between mock and real: they are the same two
// `audio:stt` / `audio:tts` resources, referenced by name (SPEC R18).

import type { SpeechClip, SpeechToText, TextToSpeech, VoiceValue } from './room';

/** Rough spoken-duration estimate (~165 wpm), for pacing the driver / UI. */
export function estimateMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(600, Math.round((words / 2.75) * 1000));
}

// ------------------------------------------------------------------- mock

/** Deterministic TTS: no audio, just the voice tag. The browser speaks it with
 *  Web Speech; the CLI/test just reads the text. */
export function mockTTS(): TextToSpeech {
  return {
    synthesize(text: string, voice: VoiceValue): Promise<SpeechClip> {
      return Promise.resolve({
        format: 'text',
        voice: voice.openaiVoice,
        text,
        approxMs: estimateMs(text),
      });
    },
  };
}

/** Deterministic STT stand-in: treats the token as the already-known text (the
 *  browser default does recognition client-side and sends text, so real STT is
 *  only exercised on the OpenAI-audio path). */
export function mockSTT(): SpeechToText {
  return { transcribe: (audioToken: string) => Promise.resolve(audioToken) };
}

// --------------------------------------------------------- raw-audio store
// Raw audio never belongs in a component (R3). The server stashes an uploaded
// clip here under a token and puts only the token in PendingUserInput; the STT
// resource resolves the token back to bytes. Kept tiny and in-memory on purpose.

export interface AudioBlob {
  bytes: Uint8Array;
  mime: string;
}

export class AudioStore {
  private readonly blobs = new Map<string, AudioBlob>();
  private seq = 0;

  put(blob: AudioBlob): string {
    const token = `audio-${++this.seq}`;
    this.blobs.set(token, blob);
    return token;
  }

  take(token: string): AudioBlob | undefined {
    const blob = this.blobs.get(token);
    this.blobs.delete(token);
    return blob;
  }
}

// ------------------------------------------------------------------ OpenAI

export interface OpenAIAudioOptions {
  apiKey: string;
  ttsModel?: string; // default 'gpt-4o-mini-tts'
  sttModel?: string; // default 'gpt-4o-transcribe'
  baseUrl?: string; // default 'https://api.openai.com/v1'
}

/** Real OpenAI text-to-speech. Returns base64 mp3 in the clip. */
export function openaiTTS(options: OpenAIAudioOptions): TextToSpeech {
  const base = options.baseUrl ?? 'https://api.openai.com/v1';
  const model = options.ttsModel ?? 'gpt-4o-mini-tts';
  return {
    async synthesize(text: string, voice: VoiceValue): Promise<SpeechClip> {
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, voice: voice.openaiVoice, input: text, response_format: 'mp3' }),
      });
      if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
      const audioBase64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { format: 'mp3', voice: voice.openaiVoice, text, audioBase64, approxMs: estimateMs(text) };
    },
  };
}

/** Real OpenAI speech-to-text (Whisper / gpt-4o-transcribe). Resolves the
 *  PendingUserInput audio token to bytes via the shared AudioStore. */
export function openaiSTT(options: OpenAIAudioOptions, store: AudioStore): SpeechToText {
  const base = options.baseUrl ?? 'https://api.openai.com/v1';
  const model = options.sttModel ?? 'gpt-4o-transcribe';
  return {
    async transcribe(audioToken: string): Promise<string> {
      const blob = store.take(audioToken);
      if (blob === undefined) throw new Error(`no audio for token ${audioToken}`);
      const form = new FormData();
      form.set('model', model);
      form.set('file', new Blob([blob.bytes], { type: blob.mime }), 'speech.webm');
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { text: string };
      return json.text;
    },
  };
}
