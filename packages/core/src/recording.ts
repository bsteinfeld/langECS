// Record and replay real model calls (R62).
//
// `scriptedModel` (R44) is why the choreography tests exist, but it requires you
// to write the script BY HAND. That is fine for a five-turn test and impractical
// for a realistic multi-agent run — which is exactly where the interesting bugs
// are, and exactly the case the engine's determinism story most wants to show off.
//
// Record/replay turns any real run into a deterministic fixture: a production
// incident becomes a regression test, a prompt refactor becomes verifiable, and a
// contributor with no API key can run a realistic suite.

import { hashRequest } from './hash';
import type { Model, ModelRequest, ModelResult, Msg } from './model';

/** One captured call (R62). Plain JSON, so a recording is a checkable fixture. */
export interface RecordingEntry {
  /** Stable hash of the request minus `signal` — the primary match key. */
  hash: string;
  /** Call ordinal within the recording, 0-based — the fallback match key. */
  index: number;
  /** The request as sent, minus `signal`. Kept for readable diffs, not for matching. */
  request: Omit<ModelRequest, 'signal'>;
  result: ModelResult;
  /** Which entry point produced it; a replayed `stream` re-chunks the text. */
  via: 'generate' | 'stream';
}

/** A recorded session (R62). */
export interface Recording {
  version: 1;
  entries: RecordingEntry[];
}

/** A `Model` that also exposes what it captured (R62). */
export interface RecordingModel extends Model {
  /** The recording so far — a detached copy, safe to serialize or keep. */
  recording(): Recording;
}

/**
 * Wraps a live model and captures every call (R62).
 *
 * `sink` is invoked after each captured call with the recording so far, so a demo
 * can write the fixture incrementally and still have something usable if the run
 * crashes halfway.
 *
 * Only successes are recorded: a failed call has no result to replay, and
 * recording the error would bake one provider blip into a fixture forever.
 */
export function recordingModel(
  model: Model,
  sink?: (recording: Recording) => void,
): RecordingModel {
  const entries: RecordingEntry[] = [];
  const snapshot = (): Recording =>
    JSON.parse(JSON.stringify({ version: 1, entries })) as Recording;

  const capture = (req: ModelRequest, result: ModelResult, via: 'generate' | 'stream'): void => {
    const { signal: _signal, ...request } = req;
    entries.push({
      hash: hashRequest(req),
      index: entries.length,
      // Detached, so a later mutation of the live request cannot rewrite history.
      request: JSON.parse(JSON.stringify(request)) as Omit<ModelRequest, 'signal'>,
      // `raw` is provider-specific and often circular; drop it so a recording
      // stays JSON and stays diffable.
      result: { message: result.message, ...usageOf(result) },
      via,
    });
    sink?.(snapshot());
  };

  const out: RecordingModel = {
    recording: snapshot,
    async generate(req) {
      const result = await model.generate(req);
      capture(req, result, 'generate');
      return result;
    },
  };
  if (model.stream !== undefined) {
    const streamFn = model.stream.bind(model);
    out.stream = async (req, onChunk) => {
      const result = await streamFn(req, onChunk);
      capture(req, result, 'stream');
      return result;
    };
  }
  return out;
}

function usageOf(result: ModelResult): Partial<ModelResult> {
  const out: Partial<ModelResult> = {};
  if (result.usage !== undefined) out.usage = result.usage;
  if (result.finishReason !== undefined) out.finishReason = result.finishReason;
  return out;
}

export interface ReplayOptions {
  /**
   * Refuse to fall back to ordinal matching. Use in CI to catch a fixture that
   * has silently drifted from the prompts it was recorded against.
   */
  strict?: boolean;
  /** Called whenever a request did not hash-match and the ordinal was used instead. */
  onMismatch?: (info: { index: number; expectedHash: string; actualHash: string }) => void;
}

/**
 * Replays a recording deterministically (R62).
 *
 * **Matching is hash-first, ordinal-fallback**, and that combination is the whole
 * design. Hash matching alone breaks the moment you edit a prompt — the very
 * refactor a fixture is supposed to let you verify — so a pure content-addressed
 * replay would be useless for the case it exists to serve. Ordinal matching alone
 * would silently line the wrong answers up against reordered calls. So:
 *
 * 1. An exact hash match replays that entry. Unchanged prompts replay exactly,
 *    and call order may change freely (concurrent pairs, R29).
 * 2. Otherwise the next unconsumed entry by ordinal is used, and `onMismatch`
 *    fires. A prompt edit therefore still replays in order rather than exploding —
 *    "survives a prompt edit gracefully" means *this*, not that the hash somehow
 *    still matches.
 * 3. `strict: true` turns step 2 into an error, which is what you want in CI.
 *
 * Entries are consumed once each, so a recording of N calls answers N calls.
 */
export function replayModel(recording: Recording, opts?: ReplayOptions): Model {
  if (recording.version !== 1) {
    throw new Error(
      `Unsupported recording version ${JSON.stringify(recording.version)}; this build reads version 1.`,
    );
  }
  const remaining = [...recording.entries].sort((a, b) => a.index - b.index);
  const consumed = new Set<number>();

  const take = (req: ModelRequest): RecordingEntry => {
    const hash = hashRequest(req);
    const exact = remaining.find((e) => !consumed.has(e.index) && e.hash === hash);
    if (exact !== undefined) {
      consumed.add(exact.index);
      return exact;
    }
    const next = remaining.find((e) => !consumed.has(e.index));
    if (next === undefined) {
      throw new Error(
        `replayModel exhausted: ${recording.entries.length} call(s) recorded, ` +
          `call ${consumed.size + 1} requested. Re-record the fixture, or check for an ` +
          'extra model call the recording predates.',
      );
    }
    if (opts?.strict === true) {
      throw new Error(
        `replayModel: request hash ${hash} does not match recorded entry ${next.index} ` +
          `(${next.hash}), and strict mode forbids the ordinal fallback. The prompts have ` +
          'drifted from this fixture — re-record it, or drop strict mode to replay by order.',
      );
    }
    opts?.onMismatch?.({ index: next.index, expectedHash: next.hash, actualHash: hash });
    consumed.add(next.index);
    return next;
  };

  return {
    async generate(req) {
      return replayResult(take(req));
    },
    async stream(req, onChunk) {
      const entry = take(req);
      // Re-chunked rather than replayed verbatim: chunk boundaries are a network
      // artefact, not part of the answer, so a fixture must not pretend to
      // preserve them.
      const text = entry.result.message.content;
      const size = Math.max(1, Math.ceil(text.length / 4));
      for (let at = 0; at < text.length; at += size) onChunk({ text: text.slice(at, at + size) });
      return replayResult(entry);
    },
  };
}

function replayResult(entry: RecordingEntry): ModelResult {
  // Detached per call, so a system that mutates a returned message cannot
  // corrupt the fixture for a later replay.
  return JSON.parse(JSON.stringify(entry.result)) as ModelResult;
}

/**
 * Renders a recording as a readable summary (R62) — the human-facing half, for
 * reviewing a fixture in a diff without reading raw JSON.
 */
export function formatRecording(recording: Recording): string {
  const lines: string[] = [`recording v${recording.version}: ${recording.entries.length} call(s)`];
  for (const entry of recording.entries) {
    const req = entry.request as ModelRequest;
    const last = req.messages.at(-1);
    lines.push(
      `  #${entry.index} ${entry.hash} via ${entry.via}` +
        `${req.tools && req.tools.length > 0 ? ` tools=[${req.tools.map((t) => t.name).join(',')}]` : ''}`,
    );
    if (last !== undefined) lines.push(`    ← ${last.role}: ${preview(last)}`);
    lines.push(`    → assistant: ${preview(entry.result.message)}`);
  }
  return lines.join('\n');
}

function preview(message: Msg): string {
  const calls = message.toolCalls;
  if (calls !== undefined && calls.length > 0) {
    return `[tool ${calls.map((c) => c.name).join(', ')}] ${message.content}`.trim();
  }
  const text = message.content.replaceAll('\n', ' ');
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
