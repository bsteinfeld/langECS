// BENCH-01: meteredModel wrapper — token capture with the mandatory estimateTokens
// fallback (the scriptedModel path every CI token assertion rides), reported-usage
// preference, cost write, and R3 snapshot round-trip. Driven inside a real one-system
// world so ctx.write buffers to the barrier exactly as in production (research-team prior art).

import { createWorld, defineSystem, defineTag, type Model, scriptedModel } from '@langecs/core';
import { describe, expect, test } from 'vitest';
import { CostEstimate, TokenUsage } from '../src/components';
import { estimateCost } from '../src/cost';
import { meteredModel } from '../src/metered';

const Trigger = defineTag('bench:test:meteredTrigger');

describe('meteredModel — scriptedModel fallback path (BENCH-01)', () => {
  test('writes split TokenUsage (positive in/out from estimate) + CostEstimate, round-trips snapshot', async () => {
    const world = createWorld({ id: 'metered-fallback' });
    world.register('model:main', scriptedModel([{ role: 'assistant', content: 'hello world' }]));

    const callLLM = defineSystem({
      name: 'bench:test:callMetered',
      query: [Trigger],
      run: async (e, ctx) => {
        const model = meteredModel(ctx, e, 'callLLM', { modelName: 'gpt-4o' });
        await model.generate({
          messages: [{ role: 'user', content: 'a fairly long user prompt to estimate' }],
        });
      },
    });
    world.use(callLLM);
    const e = world.spawn(Trigger(), TokenUsage([]), CostEstimate(0));

    await world.run();

    const ledger = e.get(TokenUsage) ?? [];
    expect(ledger).toHaveLength(1);
    const spend = ledger[0]!;
    expect(spend.system).toBe('callLLM');
    // scriptedModel reports NO usage → estimateTokens fallback yields positive non-zero tokens.
    expect(spend.inputTokens).toBeGreaterThan(0);
    expect(spend.outputTokens).toBeGreaterThan(0);

    // Cost equals estimateCost over the same tokens for the known model.
    const expectedCost = estimateCost(
      { inputTokens: spend.inputTokens, outputTokens: spend.outputTokens },
      'gpt-4o',
    );
    expect(e.get(CostEstimate)).toBeCloseTo(expectedCost, 12);
    expect(e.get(CostEstimate)).toBeGreaterThan(0);

    // R3: the metric writes round-trip world.snapshot() / JSON.
    const snapshot = world.snapshot();
    const restored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(restored).toEqual(snapshot);
    const cc = restored.entities.find((x) => x.id === e.id)?.components;
    expect(cc?.['bench:TokenUsage']).toEqual(ledger);
  });

  test('omitting modelName writes no CostEstimate', async () => {
    const world = createWorld({ id: 'metered-no-cost' });
    world.register('model:main', scriptedModel([{ role: 'assistant', content: 'hi' }]));

    const callLLM = defineSystem({
      name: 'bench:test:callMeteredNoCost',
      query: [Trigger],
      run: async (e, ctx) => {
        const model = meteredModel(ctx, e, 'callLLM');
        await model.generate({ messages: [{ role: 'user', content: 'q' }] });
      },
    });
    world.use(callLLM);
    const e = world.spawn(Trigger(), TokenUsage([]));

    await world.run();

    expect(e.get(TokenUsage)).toHaveLength(1);
    expect(e.has(CostEstimate)).toBe(false);
  });
});

describe('meteredModel — reported usage wins over the estimate (BENCH-01)', () => {
  test('an inner model that reports usage records the provider numbers verbatim', async () => {
    // A hand-written model that DOES report usage; estimate would differ from these.
    const reporting: Model = {
      async generate() {
        return {
          message: { role: 'assistant', content: 'answer' },
          usage: { inputTokens: 4242, outputTokens: 1717 },
        };
      },
    };

    const world = createWorld({ id: 'metered-reported' });
    const callLLM = defineSystem({
      name: 'bench:test:callMeteredReported',
      query: [Trigger],
      run: async (e, ctx) => {
        const model = meteredModel(ctx, e, 'callLLM', { inner: reporting, modelName: 'gpt-4o' });
        await model.generate({ messages: [{ role: 'user', content: 'q' }] });
      },
    });
    world.use(callLLM);
    const e = world.spawn(Trigger(), TokenUsage([]), CostEstimate(0));

    await world.run();

    const ledger = e.get(TokenUsage) ?? [];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual({ system: 'callLLM', inputTokens: 4242, outputTokens: 1717 });
    expect(e.get(CostEstimate)).toBeCloseTo(
      estimateCost({ inputTokens: 4242, outputTokens: 1717 }, 'gpt-4o'),
      12,
    );
  });
});
