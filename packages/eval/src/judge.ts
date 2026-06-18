// LLM-as-judge scorer (JUDGE-01, JUDGE-02). A factory that returns a value
// satisfying the EXISTING Phase 7 `Scorer` interface (async `score`), grading a
// candidate output against a reference + configurable rubric by calling a `Model`
// and parsing `{score, pass, reason}` via stdlib `extractJson`.
//
// The model is captured in the factory closure at registration time (mirroring
// `customPredicateScorer`) — never stored in a component (R3). The case entity
// carries only the `'scorer:llm-judge'` string. The judge flows unchanged through
// `scoreCase`/`verdictSystem`: only `score` (a number in [0,1]) feeds the
// Score/Verdict chain (the model's `pass`/`reason` are advisory).
//
// Structural gating (JUDGE-02): this file takes `model` as a parameter only — it
// never reads env, never registers itself, never makes an unconditional network
// call, and is never wired into the builtin scorer suite. Its only model access
// is the captured `model` parameter through `extractJson`. The advisory real-model
// gate lives exclusively at caller/registration sites (Plans 02/03).

import type { Model, ModelRequest } from '@langecs/core';
import { extractJson, type Validator } from '@langecs/stdlib';
import type { Scorer } from './scorers';

/** The structured verdict the judge model is asked to produce. */
export interface JudgeVerdict {
  /** Grade in [0, 1]. Only this feeds the Phase 7 Score/Verdict chain. */
  score: number;
  /** Advisory pass/fail; derived from `passThreshold` when the model omits it. */
  pass: boolean;
  /** Advisory free-text justification. */
  reason: string;
}

/** Configuration for {@link llmJudgeScorer}. */
export interface LlmJudgeOptions {
  /** Rubric / grading criteria injected into the judge system prompt. */
  rubric?: string;
  /**
   * Override the default prompt builder (configurable template, JUDGE-01).
   * Receives the per-case `expected` and `output` plus the full `opts`.
   */
  buildPrompt?: (expected: string, output: string, opts: LlmJudgeOptions) => string;
  /** Pass threshold applied to `score` when the model omits `pass`. Default 0.7. */
  passThreshold?: number;
  /** Fixed sampling seed for the deterministic real-model path. Default 1. */
  seed?: number;
}

/** Default pass threshold (ARCHITECTURE.md:187 — 0.7 for the LLM judge). */
const DEFAULT_PASS_THRESHOLD = 0.7;
/** Default sampling seed for the deterministic real-model path. */
const DEFAULT_SEED = 1;

/** JSON Schema embedded (as text) in the extractJson instruction. */
const judgeSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    pass: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

/**
 * The strict-judge system text: a grading directive, the rubric (caller-supplied
 * or a default reward-correctness rubric), and the required verdict shape.
 * `extractJson` appends its own strict-JSON directive after this.
 */
export function buildJudgeSystem(opts: LlmJudgeOptions): string {
  return [
    'You are a strict evaluation judge. Grade the candidate output against the reference and rubric.',
    opts.rubric
      ? `Rubric:\n${opts.rubric}`
      : 'Rubric: reward correctness, completeness, and relevance.',
    'Return a JSON object: {"score": number in [0,1], "pass": boolean, "reason": string}.',
  ].join('\n\n');
}

/**
 * Assembles the judge prompt with the reference and candidate each inside clearly
 * delimited fenced blocks, instructing the judge to grade ONLY the candidate
 * inside the delimiters (prompt-injection mitigation, T-11-02 / PITFALLS.md:255).
 */
export function defaultJudgePrompt(expected: string, output: string): string {
  return [
    '=== REFERENCE / EXPECTED (between fences) ===',
    '```',
    expected,
    '```',
    '=== CANDIDATE OUTPUT (between fences) ===',
    '```',
    output,
    '```',
    'Grade ONLY the candidate output. Reply with the JSON verdict only.',
  ].join('\n');
}

/**
 * Builds a `Validator<JudgeVerdict>` that throws on a bad shape (so `extractJson`
 * retries once): `score` must be a finite number in [0, 1]; `reason` defaults to
 * `''`; `pass` is derived from `passThreshold` when the model omits a boolean.
 */
export function validateJudge(passThreshold: number): Validator<JudgeVerdict> {
  return (parsed: unknown): JudgeVerdict => {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('judge: verdict must be an object like {"score":0..1,"reason":"..."}');
    }
    const v = parsed as Record<string, unknown>;
    const score = typeof v.score === 'number' ? v.score : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(
        `judge: "score" must be a finite number in [0,1] (got ${JSON.stringify(v.score)})`,
      );
    }
    const reason = typeof v.reason === 'string' ? v.reason : '';
    const pass = typeof v.pass === 'boolean' ? v.pass : score >= passThreshold;
    return { score, pass, reason };
  };
}

/**
 * Wraps a `Model` so each request defaults `temperature: 0` and a fixed `seed`
 * before delegating — reducing variance on the optional real-model path without
 * forwarding through `extractJson` and without any stdlib change (Open Question 1,
 * option b). An explicit `req.seed` wins; otherwise `opts.seed` (default 1).
 * `stream` is forwarded only when the underlying model defines it.
 */
function deterministicModel(model: Model, seed: number): Model {
  const wrapped: Model = {
    generate(req: ModelRequest) {
      return model.generate({ ...req, temperature: 0, seed: req.seed ?? seed });
    },
  };
  const stream = model.stream?.bind(model);
  if (stream) {
    wrapped.stream = (req, onChunk) =>
      stream({ ...req, temperature: 0, seed: req.seed ?? seed }, onChunk);
  }
  return wrapped;
}

/**
 * Factory: returns a `Scorer` (async `score`) that grades `output` against
 * `expected` + a configurable rubric by calling `model` via `extractJson` and
 * parsing `{score, pass, reason}`. Captures `model` in a closure (R3 — only the
 * `ScorerRef` string lives on a component). The returned `score` is a number in
 * [0, 1] feeding the unchanged Phase 7 Score/Verdict chain.
 *
 * @example
 * Register the returned scorer by name at the caller site, e.g.
 * `register('scorer:llm-judge', llmJudgeScorer(judgeModel, { rubric }))`.
 */
export function llmJudgeScorer(model: Model, opts: LlmJudgeOptions = {}): Scorer {
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const seed = opts.seed ?? DEFAULT_SEED;
  const judgeModel = deterministicModel(model, seed);
  return {
    async score(output, expected) {
      const prompt = (opts.buildPrompt ?? defaultJudgePrompt)(expected, output, opts);
      const verdict = await extractJson<JudgeVerdict>(
        judgeModel,
        { system: buildJudgeSystem(opts), prompt, schema: judgeSchema, schemaName: 'JudgeVerdict' },
        validateJudge(passThreshold),
      );
      return verdict.score;
    },
  };
}
