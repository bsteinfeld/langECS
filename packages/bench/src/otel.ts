// forwardBenchToOtel — optional OTel forwarding for benchmark runs (BENCH-05).
//
// Composes two EXISTING `@langecs/otel` primitives behind a LAZY import so this
// stays a no-op when the optional peer is absent:
//   - `instrumentWorld(world)` taps `world.observe` (a passive observer, R45–R48)
//     to emit run/step/system spans. By contract an observer can never change
//     scheduling, state, or a run's result — so attaching it cannot alter the
//     benchmarked outcome (the isolation test proves this empirically).
//   - `instrumentModel(model)` wraps the model so each `generate` lands a GenAI
//     `chat` span carrying `gen_ai.usage.*` from `ModelResult.usage`. The wrapper
//     only observes; it returns the inner `ModelResult` byte-for-byte unchanged.
//
// PRIVACY: forwarding carries USAGE NUMBERS (token counts), NOT message content,
// by default. Content capture stays opt-in behind `@langecs/otel`'s
// `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` env var
// (09-RESEARCH Security Domain, T-09-10).
//
// `@langecs/otel` is an OPTIONAL peer (see package.json). It is NEVER statically
// imported — that would make it a hard dependency and break installs without it.
// A failed dynamic import (peer uninstalled, or `@opentelemetry/api` absent) is a
// SILENT no-op: the original model is returned unchanged (T-09-11).

import type { Model, World } from '@langecs/core';

export interface ForwardBenchToOtelOptions {
  /** `gen_ai.request.model` / `chat {model}` span name. Default `'bench'`. */
  model?: string;
}

/**
 * Attaches optional OpenTelemetry forwarding to a benchmark run. When
 * `@langecs/otel` resolves, taps `world` with `instrumentWorld` (passive,
 * R45) and returns an `instrumentModel`-wrapped `model` so each `generate`
 * emits `gen_ai.usage.*` spans. When the optional peer is NOT resolvable, this
 * is a no-op and returns the ORIGINAL `model` unchanged — no error surfaces.
 *
 * Requires ZERO changes to `@langecs/core` / `@langecs/eval`: it uses only the
 * public `world.observe` tap (via `instrumentWorld`) and model wrapping. The
 * returned model produces an identical `ModelResult` to the input — forwarding
 * observes, it never alters output (R45 / 09-RESEARCH Pitfall 6).
 */
export async function forwardBenchToOtel(
  world: World,
  model: Model,
  opts: ForwardBenchToOtelOptions = {},
): Promise<Model> {
  let otel: typeof import('@langecs/otel') | undefined;
  try {
    otel = await import('@langecs/otel');
  } catch {
    // Optional peer (or @opentelemetry/api) absent — forwarding is a no-op.
    return model;
  }
  // Passive run/step/system spans from world.observe (R45 — cannot alter the run).
  otel.instrumentWorld(world);
  // GenAI chat spans with gen_ai.usage.* from ModelResult.usage; output unchanged.
  return otel.instrumentModel(model, { model: opts.model ?? 'bench' });
}
