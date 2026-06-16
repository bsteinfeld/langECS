// routeJson: type-safe LLM routing with validated, retrying choice. Driven by
// scriptedModel — deterministic, zero network.

import { type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { routeJson } from '../src/index';

const capture =
  (requests: ModelRequest[], content: string) =>
  (req: ModelRequest): Msg => {
    requests.push(req);
    return { role: 'assistant', content };
  };

test('chooses a route and exposes the reason; system lists the options', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([
    capture(requests, '{"route":"billing","reason":"asks about a refund"}'),
  ]);

  const decision = await routeJson<'billing' | 'tech' | 'sales'>(model, {
    routes: [
      { name: 'billing', description: 'invoices, refunds, payment' },
      { name: 'tech', description: 'bugs, errors, how-to' },
      { name: 'sales', description: 'pricing, plans' },
    ],
    prompt: 'I want a refund on my last invoice.',
  });

  expect(decision).toEqual({ route: 'billing', reason: 'asks about a refund' });
  expect(requests[0]?.system).toContain('billing: invoices, refunds, payment');
  expect(requests[0]?.system).toContain('Choose exactly one route');
});

test('accepts bare string routes and omits reason when absent', async () => {
  const model = scriptedModel([{ role: 'assistant', content: '{"route":"b"}' }]);
  const decision = await routeJson<'a' | 'b'>(model, { routes: ['a', 'b'], prompt: 'x' });
  expect(decision).toEqual({ route: 'b' });
});

test('rejects an out-of-set route and retries with the validation error', async () => {
  const requests: ModelRequest[] = [];
  const model = scriptedModel([
    capture(requests, '{"route":"refunds"}'), // not one of the options
    capture(requests, '{"route":"billing"}'),
  ]);
  const decision = await routeJson<'billing' | 'tech'>(model, {
    routes: ['billing', 'tech'],
    prompt: 'refund please',
  });
  expect(decision.route).toBe('billing');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.messages.at(-1)?.content).toContain('must be exactly one of: billing, tech');
});

test('throws after two invalid choices', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: '{"route":"nope"}' },
    { role: 'assistant', content: '{"route":"still-nope"}' },
  ]);
  await expect(routeJson<'a' | 'b'>(model, { routes: ['a', 'b'], prompt: 'x' })).rejects.toThrow(
    '2 attempts',
  );
});

test('throws when no routes are supplied', async () => {
  const model = scriptedModel([]);
  await expect(routeJson(model, { routes: [], prompt: 'x' })).rejects.toThrow('at least one route');
});
