import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { estimateCost, MODEL_PRICING } from '../src/cost';

test('estimateCost prices input tokens per 1M (BENCH-02)', () => {
  expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-4o')).toBeCloseTo(2.5, 10);
});

test('estimateCost prices output tokens per 1M (BENCH-02)', () => {
  expect(estimateCost({ inputTokens: 0, outputTokens: 1_000_000 }, 'gpt-4o')).toBeCloseTo(10.0, 10);
});

test('estimateCost sums input + output for a mixed call', () => {
  // 0.5M in + 0.25M out on gpt-4o-mini = 0.5*0.15 + 0.25*0.60 = 0.075 + 0.15
  expect(estimateCost({ inputTokens: 500_000, outputTokens: 250_000 }, 'gpt-4o-mini')).toBeCloseTo(
    0.225,
    10,
  );
});

test('every MODEL_PRICING entry produces the expected per-1M math', () => {
  for (const [name, row] of Object.entries(MODEL_PRICING)) {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, name)).toBeCloseTo(
      row.inputPerM,
      10,
    );
    expect(estimateCost({ inputTokens: 0, outputTokens: 1_000_000 }, name)).toBeCloseTo(
      row.outputPerM,
      10,
    );
  }
});

test('estimateCost returns 0 for an unknown model and never throws (V5, advisory)', () => {
  expect(() =>
    estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'no-such-model'),
  ).not.toThrow();
  expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'no-such-model')).toBe(
    0,
  );
  // Attacker-controlled / exotic strings are tolerated, not eval'd.
  expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, '__proto__')).toBe(0);
  expect(estimateCost({ inputTokens: 1, outputTokens: 1 }, '')).toBe(0);
});

test('cost.ts imports no network/fs module (no-network invariant)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/cost.ts', import.meta.url)), 'utf8');
  expect(src).not.toMatch(/from\s+['"]node:(https?|fs|net|dns|http2)['"]/);
  expect(src).not.toMatch(/\bfetch\s*\(/);
  expect(src).not.toMatch(/from\s+['"](node:)?(http|https)['"]/);
  expect(src).not.toMatch(/require\(\s*['"](node:)?(http|https|fs|net)['"]\s*\)/);
});
