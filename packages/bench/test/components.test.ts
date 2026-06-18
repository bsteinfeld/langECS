import { createWorld, defineSystem, defineTag } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  BenchmarkReport,
  type BenchmarkReportData,
  CostEstimate,
  LatencyMs,
  type Spend,
  StepCount,
  TokenUsage,
} from '../src/components';

test('R3 round-trip: all bench metric components survive world.snapshot() / JSON.stringify', () => {
  const world = createWorld();

  const usage: Spend[] = [{ system: 'model:main', inputTokens: 1200, outputTokens: 340 }];
  const report: BenchmarkReportData = {
    cases: 3,
    passed: 2,
    failed: 1,
    passRate: 2 / 3,
    meanScore: 0.71,
    latencyMs: { mean: 812.5, p95: 1500 },
    cost: { mean: 0.0042, total: 0.0126 },
    totalTokens: 4620,
    ranAt: '2026-06-18T00:00:00.000Z',
  };

  const e = world.spawn(
    TokenUsage(usage),
    CostEstimate(0.0042),
    LatencyMs(812),
    StepCount(7),
    BenchmarkReport(report),
  );

  const snapshot = world.snapshot();
  const json = JSON.stringify(snapshot);
  expect(() => JSON.parse(json)).not.toThrow();

  // Round-trip must be lossless: parsing the stringified snapshot deep-equals it.
  const restored = JSON.parse(json) as typeof snapshot;
  expect(restored).toEqual(snapshot);

  const cc = restored.entities.find((x) => x.id === e.id)?.components;
  expect(cc?.['bench:TokenUsage']).toEqual(usage);
  expect(cc?.['bench:CostEstimate']).toBe(0.0042);
  expect(cc?.['bench:LatencyMs']).toBe(812);
  expect(cc?.['bench:StepCount']).toBe(7);
  expect(cc?.['bench:BenchmarkReport']).toEqual(report);
});

test('TokenUsage append reducer merges two same-barrier writes (R30) instead of throwing', async () => {
  const Trigger = defineTag('bench:test:TokenUsageTrigger');
  const a = defineSystem({
    name: 'bench:test:tokenWriterA',
    query: [Trigger],
    run: (e) => e.add(TokenUsage, [{ system: 'a', inputTokens: 10, outputTokens: 1 }]),
  });
  const b = defineSystem({
    name: 'bench:test:tokenWriterB',
    query: [Trigger],
    run: (e) => e.add(TokenUsage, [{ system: 'b', inputTokens: 20, outputTokens: 2 }]),
  });

  const world = createWorld();
  world.use(a);
  world.use(b);
  const e = world.spawn(Trigger(), TokenUsage([]));

  await world.run();

  const ledger = e.get(TokenUsage);
  expect(ledger).toHaveLength(2);
  expect(ledger?.map((s) => s.system).sort()).toEqual(['a', 'b']);
});

test('CostEstimate sum reducer accumulates two same-barrier writes (R30) instead of throwing', async () => {
  const Trigger = defineTag('bench:test:CostTrigger');
  const a = defineSystem({
    name: 'bench:test:costWriterA',
    query: [Trigger],
    run: (e) => e.add(CostEstimate, 0.01),
  });
  const b = defineSystem({
    name: 'bench:test:costWriterB',
    query: [Trigger],
    run: (e) => e.add(CostEstimate, 0.02),
  });

  const world = createWorld();
  world.use(a);
  world.use(b);
  const e = world.spawn(Trigger(), CostEstimate(0));

  await world.run();

  expect(e.get(CostEstimate)).toBeCloseTo(0.03, 10);
});
