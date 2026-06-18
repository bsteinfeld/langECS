// BENCH-04: assertBudget — descriptive throw on any exceeded dimension, silent
// pass under budget. A thrown assertion in vitest exits non-zero → CI red (the
// Phase 8 ci-gate precedent). Estimate-derived budgets are ADVISORY (Pitfall 5);
// these tests exercise the throw/pass contract, not a hard correctness gate.

import { describe, expect, test } from 'vitest';
import { assertBudget } from '../src/budget';

describe('assertBudget — under budget passes silently (BENCH-04)', () => {
  test('all dimensions under their max returns void without throwing', () => {
    expect(() =>
      assertBudget(
        { costUsd: 0.5, latencyMs: 100, tokens: 1000 },
        { maxCostUsd: 1, maxLatencyMs: 200, maxTokens: 2000 },
      ),
    ).not.toThrow();
  });

  test('an omitted budget dimension is never asserted', () => {
    // tokens are huge but maxTokens is undefined → no throw on tokens.
    expect(() => assertBudget({ tokens: 999_999 }, { maxCostUsd: 1 })).not.toThrow();
    // exactly at the budget is NOT over (strict >).
    expect(() => assertBudget({ costUsd: 1 }, { maxCostUsd: 1 })).not.toThrow();
  });
});

describe('assertBudget — over budget throws descriptively (BENCH-04)', () => {
  test('cost over budget names the dimension, budget, and actual (4dp)', () => {
    let message = '';
    try {
      assertBudget({ costUsd: 2 }, { maxCostUsd: 1 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/cost/i);
    expect(message).toContain('1.0000');
    expect(message).toContain('2.0000');
  });

  test('latency over budget names latency + actual + budget', () => {
    let message = '';
    try {
      assertBudget({ latencyMs: 500 }, { maxLatencyMs: 100 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/latency/i);
    expect(message).toContain('500');
    expect(message).toContain('100');
  });

  test('tokens over budget names tokens + actual + budget', () => {
    let message = '';
    try {
      assertBudget({ tokens: 5000 }, { maxTokens: 1000 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/token/i);
    expect(message).toContain('5000');
    expect(message).toContain('1000');
  });

  test('multiple simultaneous over-budget dimensions are all reported in one message', () => {
    let message = '';
    try {
      assertBudget(
        { costUsd: 2, latencyMs: 500, tokens: 5000 },
        { maxCostUsd: 1, maxLatencyMs: 100, maxTokens: 1000 },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/cost/i);
    expect(message).toMatch(/latency/i);
    expect(message).toMatch(/token/i);
  });

  test('a missing actual defaults to 0 and never spuriously throws', () => {
    // actual.costUsd undefined → treated as 0, under any positive budget.
    expect(() => assertBudget({}, { maxCostUsd: 1, maxLatencyMs: 1, maxTokens: 1 })).not.toThrow();
  });
});
