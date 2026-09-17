// The JSON Schema subset validator behind the declarative layer, and its use as
// an `extractJson` validate hook. Zero network.

import { type ModelRequest, type Msg, scriptedModel } from '@langecs/core';
import { expect, test } from 'vitest';
import { extractJson, schemaValidator, validateJson } from '../src/index';

test('types, integer vs number, and arrays of types', () => {
  expect(validateJson('x', { type: 'string' })).toEqual([]);
  expect(validateJson(1.5, { type: 'integer' })).toEqual(['$: expected integer, got 1.5']);
  expect(validateJson(2, { type: 'integer' })).toEqual([]);
  expect(validateJson(Number.NaN, { type: 'number' })).toHaveLength(1);
  expect(validateJson(null, { type: ['string', 'null'] })).toEqual([]);
  expect(validateJson(undefined, { type: 'string' })).toEqual([
    '$: expected string, got undefined',
  ]);
  expect(validateJson([1], { type: 'object' })).toEqual(['$: expected object, got [1]']);
  // A wrong type short-circuits the remaining keywords — one error, not a cascade.
  expect(validateJson('x', { type: 'array', minItems: 3 })).toHaveLength(1);
});

test('enum, const, string and number bounds, pattern', () => {
  expect(validateJson('mid', { enum: ['low', 'high'] })).toEqual([
    '$: must be one of "low", "high", got "mid"',
  ]);
  expect(validateJson({ a: 1 }, { enum: [{ a: 1 }] })).toEqual([]);
  expect(validateJson(2, { const: 1 })).toEqual(['$: must equal 1, got 2']);
  expect(validateJson('ab', { minLength: 3 })).toEqual(['$: length 2 is below minLength 3']);
  expect(validateJson('abcd', { maxLength: 3 })).toEqual(['$: length 4 exceeds maxLength 3']);
  expect(validateJson(11, { maximum: 10 })).toEqual(['$: 11 exceeds maximum 10']);
  expect(validateJson(-1, { minimum: 0 })).toEqual(['$: -1 is below minimum 0']);
  expect(validateJson('abc', { pattern: '^a' })).toEqual([]);
  expect(validateJson('xbc', { pattern: '^a' })).toEqual(['$: does not match pattern ^a']);
  // A malformed schema reads as invalid rather than throwing out of the validator.
  expect(validateJson('x', { pattern: '(' })).toEqual([
    '$: schema pattern "(" is not a valid regular expression',
  ]);
});

test('objects: required, properties, additionalProperties (false and schema)', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' }, n: { type: 'integer', minimum: 0 } },
    required: ['id'],
    additionalProperties: false,
  };
  expect(validateJson({ id: 'a', n: 1 }, schema)).toEqual([]);
  expect(validateJson({ n: -1, extra: true }, schema)).toEqual([
    '$: missing required property "id"',
    '$.n: -1 is below minimum 0',
    '$: unexpected property "extra"',
  ]);
  expect(
    validateJson({ a: 1, b: 'no' }, { type: 'object', additionalProperties: { type: 'number' } }),
  ).toEqual(['$.b: expected number, got "no"']);
});

test('arrays: items, minItems, maxItems, with indexed paths', () => {
  const schema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 };
  expect(validateJson(['a'], schema)).toEqual([]);
  expect(validateJson([], schema)).toEqual(['$: 0 item(s) is below minItems 1']);
  expect(validateJson(['a', 2, 'c'], schema)).toEqual([
    '$: 3 item(s) exceeds maxItems 2',
    '$[1]: expected string, got 2',
  ]);
});

test('anyOf, oneOf, allOf, nullable', () => {
  expect(validateJson('x', { anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual([]);
  expect(validateJson(true, { anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual([
    '$: matches none of the 2 anyOf alternatives',
  ]);
  expect(validateJson(3, { oneOf: [{ type: 'number' }, { minimum: 0 }] })).toEqual([
    '$: matches 2 of the oneOf alternatives; exactly one is required',
  ]);
  expect(validateJson('ab', { allOf: [{ type: 'string' }, { minLength: 3 }] })).toEqual([
    '$: length 2 is below minLength 3',
  ]);
  expect(validateJson(null, { type: 'string', nullable: true })).toEqual([]);
  expect(validateJson(null, { type: 'string' })).toEqual(['$: expected string, got null']);
});

test("schemaValidator feeds every violation into extractJson's retry", async () => {
  const requests: ModelRequest[] = [];
  const reply =
    (content: string) =>
    (req: ModelRequest): Msg => {
      requests.push(req);
      return { role: 'assistant', content };
    };
  const schema = {
    type: 'object',
    properties: { route: { type: 'string', enum: ['a', 'b'] } },
    required: ['route'],
  };
  const model = scriptedModel([reply('{"route": "c"}'), reply('{"route": "b"}')]);
  const out = await extractJson<{ route: string }>(
    model,
    { prompt: 'pick', schema },
    schemaValidator(schema),
  );
  expect(out).toEqual({ route: 'b' });
  expect(requests).toHaveLength(2);
  const retry = requests[1]?.messages.at(-1)?.content ?? '';
  expect(retry).toContain('does not match the schema');
  expect(retry).toContain('$.route: must be one of "a", "b", got "c"');
});

test('membership is own-property only: prototype names neither satisfy required nor slip past additionalProperties', () => {
  expect(validateJson({}, { type: 'object', required: ['constructor'] })).toEqual([
    '$: missing required property "constructor"',
  ]);
  expect(
    validateJson(
      { constructor: 5 },
      { type: 'object', properties: {}, additionalProperties: false },
    ),
  ).toEqual(['$: unexpected property "constructor"']);
  expect(
    validateJson({ toString: 1 }, { type: 'object', properties: { toString: { type: 'string' } } }),
  ).toEqual(['$.toString: expected string, got 1']);
});
