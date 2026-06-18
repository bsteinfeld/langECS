// BENCH-05: forwardBenchToOtel observer-isolation + emission engagement.
//
// Proves the optional OTel bridge is a PASSIVE observer (R45–R48): running the
// same scripted benchmark suite WITH forwarding attached yields an IDENTICAL
// EvalSuiteResult/BenchmarkReport to running WITHOUT it (modulo clock-derived
// ranAt/latency, normalized out). Also proves forwarding actually ENGAGES the
// otel path — the returned model is a distinct instrumented wrapper, not the
// no-op identity — and that the wrapped model returns a byte-identical
// ModelResult to the inner model (Pitfall 6 — an observer never alters output).
//
// Deterministic, zero-network, and imports NO `@opentelemetry/*` package: the
// span/attribute emission itself is exhaustively covered by Phase 5's
// `packages/otel` tests. Here we only assert bench wires those primitives in
// without changing the run. `@langecs/otel` resolves in the workspace, so the
// happy path (not the no-op) is exercised.

import { createWorld, type Model, scriptedModel, type World } from '@langecs/core';
import { defineDataset, type EvalCase, type EvalSuiteResult } from '@langecs/eval';
import { defineTool, reactAgent, registerTools } from '@langecs/stdlib';
import { describe, expect, test } from 'vitest';
import { type BenchmarkReportData, forwardBenchToOtel, runBenchmarkSuite } from '../src/index';

// --- a tiny deterministic scripted agent reused for both runs ---

const calculatorTool = defineTool({
  name: 'calculator',
  description: 'Evaluate a simple integer addition like "2+3".',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
    additionalProperties: false,
  },
  execute: (args) => {
    const expr = String((args as { expression?: unknown }).expression ?? '');
    const [a, b] = expr.split('+').map((n) => Number(n.trim()));
    return String((a ?? 0) + (b ?? 0));
  },
});

const calcAgent = reactAgent({
  name: 'calc',
  model: 'model:main',
  tools: [calculatorTool],
  systemPrompt: 'Use the calculator tool for arithmetic.',
});

function calcScript(answer: string, expression: string): EvalCase['script'] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
    },
    { role: 'assistant', content: answer },
  ] as EvalCase['script'];
}

const cases: { input: string; expected: string; script: EvalCase['script'] }[] = [
  { input: 'What is 2+3?', expected: '5', script: calcScript('The answer is 5.', '2+3') },
  { input: 'What is 4+5?', expected: '9', script: calcScript('The answer is 9.', '4+5') },
];

const dataset = defineDataset(
  cases.map((c, i) => ({
    id: `bench-${i}`,
    input: c.input,
    expected: c.expected,
    scorer: 'scorer:contains',
    script: c.script,
  })),
);

/** Deterministic clock: every per-case run is timed as exactly +25ms. */
function fakeClock(): () => number {
  const ticks: number[] = [];
  for (let i = 0; i < dataset.length; i++) ticks.push(100 + i * 1000, 125 + i * 1000);
  let i = 0;
  return () => ticks[i++] ?? 0;
}

/** Plain wiring: register the tools and spawn the react agent. */
function wirePlain(world: World): ReturnType<World['spawn']> {
  registerTools(world, [calculatorTool]);
  return world.spawn(calcAgent);
}

/**
 * Builds a forwarding `wireAgent`. Resource values are never externally readable
 * (R18) and `wireAgent` is synchronous, so we (1) eagerly resolve `@langecs/otel`
 * once before the suite, then (2) inside each `wireAgent` rebuild the per-case
 * scripted model from the same script the harness used, tap the sub-world with
 * `instrumentWorld` (passive, R45), and re-register the `instrumentModel`-wrapped
 * model as `model:main` — all SYNCHRONOUSLY, so it lands before the harness runs.
 *
 * This mirrors exactly what `forwardBenchToOtel` does (instrumentWorld + return
 * instrumentModel); a separate identity test exercises `forwardBenchToOtel`
 * itself. The eager import keeps the wiring deterministic (no microtask race) and
 * imports only `@langecs/otel` — never an `@opentelemetry/*` package.
 */
async function makeForwardingWire(): Promise<(world: World) => ReturnType<World['spawn']>> {
  const otel = await import('@langecs/otel');
  let caseIdx = 0;
  return (world: World) => {
    const script = cases[caseIdx++ % cases.length]?.script ?? [];
    const inner = scriptedModel(script as Parameters<typeof scriptedModel>[0]);
    otel.instrumentWorld(world);
    world.register('model:main', otel.instrumentModel(inner, { model: 'bench' }));
    registerTools(world, [calculatorTool]);
    return world.spawn(calcAgent);
  };
}

/** Drops clock-derived fields so two runs can be compared structurally. */
function normalizeSuite(suite: EvalSuiteResult): unknown {
  return {
    total: suite.total,
    passed: suite.passed,
    failed: suite.failed,
    passRate: suite.passRate,
    meanScore: suite.meanScore,
    cases: suite.cases.map((c) => ({
      id: c.id,
      output: c.output,
      score: c.score,
      verdict: c.verdict,
      status: c.status,
    })),
  };
}

function normalizeReport(report: BenchmarkReportData): unknown {
  const { ranAt: _ranAt, latencyMs: _latencyMs, ...rest } = report;
  return rest;
}

describe('forwardBenchToOtel — observer isolation (BENCH-05, R45)', () => {
  test('identical RunResult/scores/aggregates with and without forwarding', async () => {
    // RUN A: plain.
    const worldA = createWorld({ id: 'bench-plain' });
    const { suite: suiteA, report: reportA } = await runBenchmarkSuite(worldA, dataset, {
      wireAgent: wirePlain,
      clock: fakeClock(),
      modelName: 'gpt-4o',
    });

    // RUN B: identical suite, but each case's model is wired through forwarding.
    const worldB = createWorld({ id: 'bench-forwarded' });
    const { suite: suiteB, report: reportB } = await runBenchmarkSuite(worldB, dataset, {
      wireAgent: await makeForwardingWire(),
      clock: fakeClock(),
      modelName: 'gpt-4o',
    });

    // Observer isolation: the measured outcome is byte-identical (R45).
    expect(normalizeSuite(suiteB)).toEqual(normalizeSuite(suiteA));
    expect(normalizeReport(reportB)).toEqual(normalizeReport(reportA));

    // Sanity: both runs actually scored, passed, and metered cost/tokens.
    expect(suiteA.passRate).toBe(1);
    expect(reportA.cost.total).toBeGreaterThan(0);
    expect(reportA.totalTokens).toBeGreaterThan(0);
  });

  test('forwarding engages the otel path: returns a distinct instrumented wrapper', async () => {
    // The no-op branch returns the ORIGINAL model by reference. A distinct
    // object proves `@langecs/otel` resolved and `instrumentModel` wrapped it,
    // i.e. each generate will emit a GenAI span (emission itself is covered by
    // packages/otel's tests). This guards against a silent no-op regression.
    const inner: Model = scriptedModel([{ role: 'assistant', content: 'wrapped' }]);
    const world = createWorld({ id: 'bench-engage' });
    const wrapped = await forwardBenchToOtel(world, inner, { model: 'bench' });
    expect(wrapped).not.toBe(inner);
  });

  test('wrapped model returns an identical ModelResult to the inner model (Pitfall 6)', async () => {
    const inner = scriptedModel([{ role: 'assistant', content: 'identical output' }]);
    // Run the unwrapped model first on its own instance so the script cursor is
    // independent of the wrapped instance below.
    const a = await inner.generate({ messages: [{ role: 'user', content: 'hi' }] });

    const innerB = scriptedModel([{ role: 'assistant', content: 'identical output' }]);
    const world = createWorld({ id: 'bench-identity' });
    const wrapped = await forwardBenchToOtel(world, innerB, { model: 'bench' });
    const b = await wrapped.generate({ messages: [{ role: 'user', content: 'hi' }] });

    expect(b).toEqual(a);
  });
});
