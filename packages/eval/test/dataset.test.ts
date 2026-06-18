// Tests for loadDataset (JSONL via node:fs) and defineDataset (inline) — EVAL-03.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { defineDataset, type EvalCase, loadDataset } from '../src/dataset';

const FIXTURE = fileURLToPath(new URL('./fixtures/dataset.jsonl', import.meta.url));

test('defineDataset wraps an inline array as a frozen EvalCase[]', () => {
  const cases = defineDataset([
    { id: 'c1', input: 'hello', expected: 'world', scorer: 'scorer:exact-match' },
  ]);
  expect(cases).toHaveLength(1);
  expect(Object.isFrozen(cases)).toBe(true);
  expect(cases[0]).toEqual({
    id: 'c1',
    input: 'hello',
    expected: 'world',
    scorer: 'scorer:exact-match',
  });
});

test('loadDataset parses a JSONL file and skips blank lines', () => {
  const cases = loadDataset(FIXTURE);
  // Three non-blank lines (the blank line between case-2 and case-3 is skipped).
  expect(cases).toHaveLength(3);
  expect(cases[0]).toEqual({
    id: 'case-1',
    input: 'What is 2+2?',
    expected: '4',
    scorer: 'scorer:exact-match',
  });
  expect(cases[1]?.id).toBe('case-2');
  expect(cases[2]?.scorer).toBe('scorer:regex');
});

test('loadDataset throws a line-numbered, path-qualified error on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-dataset-'));
  const badPath = join(dir, 'bad.jsonl');
  writeFileSync(
    badPath,
    [
      '{"id":"ok","input":"a","expected":"a","scorer":"scorer:exact-match"}',
      '{ this is not json }',
    ].join('\n'),
    'utf8',
  );

  expect(() => loadDataset(badPath)).toThrow(/line 2/);
  expect(() => loadDataset(badPath)).toThrow(badPath);
});

test('loadDataset and defineDataset produce identically-shaped EvalCase objects', () => {
  const loaded = loadDataset(FIXTURE)[0] as EvalCase;
  const defined = defineDataset([
    { id: 'x', input: 'i', expected: 'e', scorer: 'scorer:exact-match' },
  ])[0] as EvalCase;
  expect(Object.keys(loaded).sort()).toEqual(Object.keys(defined).sort());
});
