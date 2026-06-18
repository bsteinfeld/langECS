// BENCH-03: plain-JS aggregation (buildBenchmarkReport), the runBenchmarkSuite
// wrapper (deterministic latency via an injected clock; steps from EvalCaseResult),
// and the snapshot-able writeBenchmarkReport. Latency is sourced from
// EvalCaseResult.wallMs (NEVER asserted as real ms — 09-RESEARCH Pitfall 3).

import {
  createWorld,
  type EntityHandle,
  type Snapshot,
  scriptedModel,
  type World,
} from '@langecs/core';
import { defineDataset, type EvalCase, type EvalSuiteResult } from '@langecs/eval';
import { defineTool, reactAgent, registerTools } from '@langecs/stdlib';
import { describe, expect, test } from 'vitest';
import { BenchmarkReport } from '../src/components';
import { buildBenchmarkReport, runBenchmarkSuite, writeBenchmarkReport } from '../src/report';

// --- helpers to build a synthetic EvalSuiteResult for the unit test ---

function snapWith(cost: number, inTok: number, outTok: number): Snapshot {
  return {
    worldId: 'synthetic',
    step: 0,
    entityCounter: 1,
    entities: [
      {
        id: 1,
        components: {
          'bench:CostEstimate': cost,
          'bench:TokenUsage': [{ system: 'callLLM', inputTokens: inTok, outputTokens: outTok }],
        },
      },
    ],
    pendingPairs: [],
  } as unknown as Snapshot;
}

function syntheticSuite(): EvalSuiteResult {
  // wallMs values [10,20,30,40,100] → mean 40, p95 = value at ceil(0.95*5)-1 = idx 4 = 100.
  const wall = [10, 20, 30, 40, 100];
  const costs = [0.001, 0.002, 0.003, 0.004, 0.005];
  const cases = wall.map((wallMs, i) => ({
    id: `c${i}`,
    output: 'x',
    score: 1,
    verdict: 'pass' as const,
    status: 'done' as const,
    snapshot: snapWith(costs[i]!, 100, 50),
    steps: i + 1,
    wallMs,
  }));
  const total = cases.length;
  return {
    cases,
    total,
    passed: total,
    failed: 0,
    passRate: 1,
    passThreshold: 1,
    meanScore: 1,
    ranAt: '2026-06-18T00:00:00.000Z',
  };
}

describe('buildBenchmarkReport — plain-JS aggregation (BENCH-03)', () => {
  test('computes pass-rate/score/mean+p95 latency (from wallMs)/cost/totalTokens exactly', () => {
    const report = buildBenchmarkReport(syntheticSuite());

    expect(report.cases).toBe(5);
    expect(report.passed).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.meanScore).toBe(1);

    // Latency from wallMs [10,20,30,40,100]: mean 40, p95 100.
    expect(report.latencyMs.mean).toBe(40);
    expect(report.latencyMs.p95).toBe(100);

    // Cost: total = 0.015, mean = 0.003.
    expect(report.cost.total).toBeCloseTo(0.015, 12);
    expect(report.cost.mean).toBeCloseTo(0.003, 12);

    // Tokens: 5 cases × (100+50) = 750.
    expect(report.totalTokens).toBe(750);
  });

  test('an empty suite yields zeroed means and p95 without throwing', () => {
    const empty: EvalSuiteResult = {
      cases: [],
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      passThreshold: 1,
      meanScore: 0,
      ranAt: '2026-06-18T00:00:00.000Z',
    };
    const report = buildBenchmarkReport(empty);
    expect(report.latencyMs).toEqual({ mean: 0, p95: 0 });
    expect(report.cost).toEqual({ mean: 0, total: 0 });
    expect(report.totalTokens).toBe(0);
  });
});

// --- integration: runBenchmarkSuite against a tiny scripted agent + fake clock ---

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

function wireCalcAgent(world: World): EntityHandle {
  registerTools(world, [calculatorTool]);
  return world.spawn(calcAgent);
}

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

describe('runBenchmarkSuite — deterministic wrapper (BENCH-03)', () => {
  test('latency from injected clock; report reflects sub-world steps via EvalCaseResult; tokens/cost metered', async () => {
    const dataset = defineDataset([
      {
        id: 'bench-a',
        input: 'What is 2+3?',
        expected: '5',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
    ]);

    // Fake clock: each case's sendMessage is timed as +25ms exactly.
    const ticks = [100, 125];
    let i = 0;
    const clock = () => ticks[i++] ?? 0;

    const world = createWorld({ id: 'bench-outer' });
    const { suite, report } = await runBenchmarkSuite(world, dataset, {
      wireAgent: wireCalcAgent,
      clock,
      modelName: 'gpt-4o',
    });

    expect(report.cases).toBe(1);
    expect(report.passRate).toBe(1);
    expect(report.latencyMs.mean).toBe(25);
    expect(report.latencyMs.p95).toBe(25);

    // Steps surfaced from each EvalCaseResult (sub-world RunResult.steps).
    expect(suite.cases[0]?.steps).toBeGreaterThan(0);

    // Tokens/cost were metered into the per-case snapshot and aggregated.
    expect(report.totalTokens).toBeGreaterThan(0);
    expect(report.cost.total).toBeGreaterThan(0);
  });
});

describe('runBenchmarkSuite — forwards modelFactory (CMP-01 pass-through)', () => {
  // The factory's turns mirror calcScript but feed scriptedModel directly,
  // bypassing per-case EvalCase.script. A FRESH model per call is required —
  // scriptedModel is stateful and exhausts (R44) — so two cases over one shared
  // instance would throw; the factory yields a new model per case instead.
  function factoryTurns(answer: string, expression: string): Parameters<typeof scriptedModel>[0] {
    return [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
      },
      { role: 'assistant', content: answer },
    ];
  }

  test('modelFactory flows through to runEvalSuite; 2-case dataset runs zero-network', async () => {
    // Dataset carries NO per-case script; only the inherited factory supplies models.
    const dataset = defineDataset([
      { id: 'fac-bench-a', input: 'What is 2+3?', expected: '5', scorer: 'scorer:contains' },
      { id: 'fac-bench-b', input: 'What is 4+4?', expected: '5', scorer: 'scorer:contains' },
    ]);

    const world = createWorld({ id: 'bench-outer' });
    const { report } = await runBenchmarkSuite(world, dataset, {
      wireAgent: wireCalcAgent,
      // Inherited from RunEvalSuiteOptions; forwarded via the `{ ...opts }` spread.
      modelFactory: () => scriptedModel(factoryTurns('The answer is 5.', '2+3')),
      modelName: 'gpt-4o',
    });

    expect(report.cases).toBe(2);
    expect(report.passRate).toBe(1);
    // Metering still ran off the transcript (no realModel, no env read).
    expect(report.totalTokens).toBeGreaterThan(0);
  });
});

describe('writeBenchmarkReport — snapshot-able report (BENCH-03)', () => {
  test('spawns a controller entity carrying BenchmarkReport that round-trips JSON', () => {
    const report = buildBenchmarkReport(syntheticSuite());
    const world = createWorld({ id: 'report-world' });
    const handle = writeBenchmarkReport(world, report);

    expect(handle.get(BenchmarkReport)).toEqual(report);

    const snapshot = world.snapshot();
    const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(restored).toEqual(snapshot);
    const cc = restored.entities.find((x) => x.id === handle.id)?.components;
    expect(cc?.['bench:BenchmarkReport']).toEqual(report);
    expect(cc?.['eval:DatasetTag']).toBeDefined();
  });
});
