// Unit tests for the six built-in scorers + registry resolution (EVAL-02, R3).
// Scorers are pure functions — no model, no scriptedModel, no network.

import { createWorld, defineSystem, defineTag } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  containsScorer,
  customPredicateScorer,
  exactMatchScorer,
  jsonSchemaScorer,
  numericToleranceScorer,
  regexScorer,
  registerBuiltinScorers,
  type Scorer,
  scorerResourceName,
} from '../src/scorers';

test('exactMatchScorer: trim-equal returns 1, mismatch returns 0', () => {
  expect(exactMatchScorer.score('hello ', ' hello')).toBe(1);
  expect(exactMatchScorer.score('hello', 'world')).toBe(0);
});

test('containsScorer: substring presence returns 1, absence returns 0', () => {
  expect(containsScorer.score('the answer is 4', '4')).toBe(1);
  expect(containsScorer.score('nope', '4')).toBe(0);
});

test('regexScorer: bare source and JSON {source,flags} both work', () => {
  expect(regexScorer.score('42', '\\d+')).toBe(1);
  expect(regexScorer.score('xx', '\\d+')).toBe(0);
  expect(regexScorer.score('a1b2', '{"source":"\\\\d+","flags":"g"}')).toBe(1);
});

test('jsonSchemaScorer: type + required check; malformed output scores 0', () => {
  expect(jsonSchemaScorer.score('{"a":1}', '{"type":"object","required":["a"]}')).toBe(1);
  expect(jsonSchemaScorer.score('{"b":1}', '{"type":"object","required":["a"]}')).toBe(0);
  expect(jsonSchemaScorer.score('not json', '{"type":"object","required":["a"]}')).toBe(0);
});

test('numericToleranceScorer: absolute and relative tolerance', () => {
  expect(numericToleranceScorer.score('41.8', '{"expected":42,"tolerance":0.5}')).toBe(1);
  expect(numericToleranceScorer.score('50', '{"expected":42,"tolerance":0.5}')).toBe(0);
  expect(
    numericToleranceScorer.score('109', '{"expected":100,"tolerance":0.1,"relative":true}'),
  ).toBe(1);
});

test('numericToleranceScorer: non-numeric output scores 0', () => {
  expect(numericToleranceScorer.score('not a number', '{"expected":42,"tolerance":0.5}')).toBe(0);
});

test('customPredicateScorer: boolean→1/0 and number passthrough', () => {
  const startsWith = customPredicateScorer((o, e) => o.startsWith(e));
  expect(startsWith.score('hello world', 'hello')).toBe(1);
  expect(startsWith.score('hello world', 'world')).toBe(0);

  const numeric = customPredicateScorer(() => 0.42);
  expect(numeric.score('whatever', 'whatever')).toBe(0.42);
});

test('scorerResourceName: adds scorer: prefix, idempotent on prefixed input', () => {
  expect(scorerResourceName('exact-match')).toBe('scorer:exact-match');
  expect(scorerResourceName('scorer:exact-match')).toBe('scorer:exact-match');
});

test('registerBuiltinScorers: five concrete scorers resolve from the world registry', async () => {
  const world = createWorld();
  registerBuiltinScorers(world);

  // Resource resolution is system-side (ctx.resource); resolve inside a one-shot
  // system, mirroring how scoreCase resolves ScorerRef in Phase 8.
  const Probe = defineTag('scorerProbe');
  const results: Record<string, number> = {};
  let customMissing = false;

  const resolveScorers = defineSystem({
    name: 'resolveScorers',
    query: [Probe],
    run: (_e, ctx) => {
      const exact = ctx.resource<Scorer>('scorer:exact-match');
      results['exact-match-1'] = exact.score('4', '4') as number;
      results['exact-match-0'] = exact.score('4', '5') as number;

      for (const name of [
        'scorer:exact-match',
        'scorer:contains',
        'scorer:regex',
        'scorer:json-schema',
        'scorer:numeric-tolerance',
      ]) {
        // Throws (MissingResourceError) if any concrete scorer is unregistered.
        const scorer = ctx.resource<Scorer>(name);
        results[name] = typeof scorer.score === 'function' ? 1 : 0;
      }

      // customPredicateScorer is a factory — NOT registered as a builtin.
      try {
        ctx.resource<Scorer>('scorer:custom-predicate');
      } catch {
        customMissing = true;
      }
    },
  });

  world.use(resolveScorers);
  world.spawn(Probe());
  const r = await world.run();

  expect(r.status).toBe('done');
  expect(results['exact-match-1']).toBe(1);
  expect(results['exact-match-0']).toBe(0);
  for (const name of [
    'scorer:exact-match',
    'scorer:contains',
    'scorer:regex',
    'scorer:json-schema',
    'scorer:numeric-tolerance',
  ]) {
    expect(results[name]).toBe(1);
  }
  expect(customMissing).toBe(true);
});
