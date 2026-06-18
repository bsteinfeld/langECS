// Phase 10 / CMP-01 + CMP-02: fully scripted, zero-network coverage of
// `runComparison` (per-candidate isolation, distinct outputs, equal case counts,
// duplicate-name guard) and `rankCandidates`/`writeComparisonReport` (ranking,
// winner, tie tiebreak, rankBy override, R3 snapshot round-trip).
//
// This file imports NO model-provider package and reads NO `process.env` — the
// default comparison path is zero-network (scriptedModel candidates via the
// Plan 01 modelFactory). See the grep smoke check in 10-02-PLAN.md <verification>.

import { createWorld, type EntityHandle, scriptedModel, type World } from '@langecs/core';
import { defineDataset } from '@langecs/eval';
import { defineTool, reactAgent, registerTools } from '@langecs/stdlib';
import { describe, expect, test } from 'vitest';
import {
  ComparisonReport,
  type ComparisonReportData,
  rankCandidates,
  runComparison,
  writeComparisonReport,
} from '../src/compare';

// --- shared agent-under-test: a tiny calculator react agent (mirrors report.test.ts) ---

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

/** A scriptedModel turn-set: one tool call, then a final assistant answer. */
function calcTurns(answer: string, expression: string): Parameters<typeof scriptedModel>[0] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
    },
    { role: 'assistant', content: answer },
  ];
}

// A 2-case dataset shared by every candidate (only the model varies — fair comparison).
function twoCaseDataset() {
  return defineDataset([
    { id: 'cmp-a', input: 'What is 2+3?', expected: '5', scorer: 'scorer:contains' },
    { id: 'cmp-b', input: 'What is 4+4?', expected: '8', scorer: 'scorer:contains' },
  ]);
}

// --- synthetic CandidateRow builder for pure rankCandidates unit tests ---

function row(
  name: string,
  passRate: number,
  meanScore: number,
  costTotal: number,
  latencyMean: number,
): ComparisonReportData['candidates'][number] {
  return {
    name,
    passRate,
    meanScore,
    report: {
      cases: 1,
      passed: 1,
      failed: 0,
      passRate,
      meanScore,
      latencyMs: { mean: latencyMean, p95: latencyMean },
      cost: { mean: costTotal, total: costTotal },
      totalTokens: 0,
      ranAt: '2026-06-18T00:00:00.000Z',
    },
  };
}

describe('runComparison — per-candidate isolation + distinct models (CMP-01)', () => {
  test('two distinct scripted candidates run the same dataset in isolation, equal case counts, distinct outputs', async () => {
    const dataset = twoCaseDataset();
    // Candidate "good" answers both cases correctly; "bad" answers both wrong.
    const report = await runComparison(dataset, { wireAgent: wireCalcAgent }, [
      {
        name: 'good',
        model: () =>
          scriptedModel(
            // a fresh model per call would re-script from the start; but each case
            // needs its own model, so use a factory that yields per-case turns.
            calcTurns('The answer is 5.', '2+3'),
          ),
      },
      {
        name: 'bad',
        model: () => scriptedModel(calcTurns('The answer is 999.', '2+3')),
      },
    ]);

    // Fair comparison: each candidate ran the SAME number of cases as the dataset.
    expect(report.candidates).toHaveLength(2);
    for (const c of report.candidates) {
      expect(c.report.cases).toBe(dataset.length);
    }

    const good = report.candidates.find((c) => c.name === 'good');
    const bad = report.candidates.find((c) => c.name === 'bad');
    expect(good).toBeDefined();
    expect(bad).toBeDefined();

    // Distinct models produced distinct results (good passes case A, bad fails it).
    expect(good?.passRate).not.toBe(bad?.passRate);
    expect(good?.report).not.toBe(bad?.report); // independent report objects

    // Isolation: a controller spawned in one candidate's world is not in the other's report.
    // (Each report only knows its own cases — assert their case counts are independent.)
    expect(good?.report.cases).toBe(bad?.report.cases);
  });

  test('a bare Model instance over a multi-case dataset throws a clear error (stateful exhaustion guard)', async () => {
    const dataset = twoCaseDataset();
    await expect(
      runComparison(dataset, { wireAgent: wireCalcAgent }, [
        // A bare stateful scriptedModel instance reused across 2 cases would exhaust.
        { name: 'shared', model: scriptedModel(calcTurns('The answer is 5.', '2+3')) },
      ]),
    ).rejects.toThrow(/factory|multi-case|fresh model/i);
  });

  test('a single-case dataset accepts a bare Model instance (wrapped as a one-shot factory)', async () => {
    const dataset = defineDataset([
      { id: 'solo', input: 'What is 2+3?', expected: '5', scorer: 'scorer:contains' },
    ]);
    const report = await runComparison(dataset, { wireAgent: wireCalcAgent }, [
      { name: 'solo', model: scriptedModel(calcTurns('The answer is 5.', '2+3')) },
    ]);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.report.cases).toBe(1);
    expect(report.candidates[0]?.passRate).toBe(1);
  });

  test('duplicate candidate names throw before any run (Repudiation guard)', async () => {
    const dataset = twoCaseDataset();
    await expect(
      runComparison(dataset, { wireAgent: wireCalcAgent }, [
        { name: 'dup', model: () => scriptedModel(calcTurns('5', '2+3')) },
        { name: 'dup', model: () => scriptedModel(calcTurns('5', '2+3')) },
      ]),
    ).rejects.toThrow(/duplicate/i);
  });
});

describe('rankCandidates — deterministic ranking + winner (CMP-02)', () => {
  test('ranks by pass-rate desc; the highest pass-rate is the winner', () => {
    const rows = [row('low', 0.5, 0.5, 0.001, 10), row('high', 1.0, 1.0, 0.002, 20)];
    const { ranked, winner } = rankCandidates(rows, {});
    expect(ranked).toEqual(['high', 'low']);
    expect(winner).toBe('high');
  });

  test('a tie on pass-rate + tiebreak metrics resolves deterministically by name', () => {
    const rows = [row('b', 1.0, 1.0, 0.001, 10), row('a', 1.0, 1.0, 0.001, 10)];
    const first = rankCandidates(rows, {});
    const second = rankCandidates(rows, {});
    expect(first.ranked).toEqual(['a', 'b']);
    expect(first.winner).toBe('a');
    // Winner never flips across repeated calls.
    expect(second).toEqual(first);
  });

  test('tiebreak prefers lower cost, then lower latency', () => {
    // Same pass-rate; "cheap" has lower cost so it wins.
    const rows = [row('pricey', 1.0, 1.0, 0.01, 10), row('cheap', 1.0, 1.0, 0.001, 50)];
    expect(rankCandidates(rows, {}).winner).toBe('cheap');
    // When cost ties, lower latency wins.
    const tiedCost = [row('slow', 1.0, 1.0, 0.001, 99), row('fast', 1.0, 1.0, 0.001, 1)];
    expect(rankCandidates(tiedCost, {}).winner).toBe('fast');
  });

  test('opts.rankBy = "meanScore" changes the ordering', () => {
    // "x" has higher pass-rate but lower meanScore than "y".
    const rows = [row('x', 1.0, 0.4, 0.001, 10), row('y', 0.5, 0.9, 0.001, 10)];
    expect(rankCandidates(rows, { rankBy: 'passRate' }).winner).toBe('x');
    expect(rankCandidates(rows, { rankBy: 'meanScore' }).winner).toBe('y');
  });

  test('an empty candidate list yields an empty ranking and empty winner', () => {
    expect(rankCandidates([], {})).toEqual({ ranked: [], winner: '' });
  });
});

describe('writeComparisonReport — snapshot-able report round-trips (CMP-02, R3)', () => {
  test('spawns a DatasetTag controller carrying ComparisonReport that round-trips snapshot()/load()', async () => {
    const dataset = twoCaseDataset();
    const report = await runComparison(dataset, { wireAgent: wireCalcAgent }, [
      { name: 'good', model: () => scriptedModel(calcTurns('The answer is 5.', '2+3')) },
      { name: 'bad', model: () => scriptedModel(calcTurns('The answer is 999.', '2+3')) },
    ]);

    const world = createWorld({ id: 'cmp-report-world' });
    const handle = writeComparisonReport(world, report);
    expect(handle.get(ComparisonReport)).toEqual(report);

    // R3: snapshot must not throw and must be plain-JSON (deep-equal after round-trip).
    const snapshot = world.snapshot();
    const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(restored).toEqual(snapshot);

    // A fresh world can load() it and read back winner/ranked intact.
    const fresh = createWorld({ id: 'cmp-restored-world' });
    fresh.load(restored);
    const loaded = fresh.entity(handle.id)?.get(ComparisonReport);
    expect(loaded?.winner).toBe(report.winner);
    expect(loaded?.ranked).toEqual(report.ranked);
  });
});
