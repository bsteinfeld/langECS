import { createWorld } from '@langecs/core';
import { expect, test } from 'vitest';
import {
  CaseTag,
  DatasetTag,
  EvalComplete,
  EvalExpected,
  EvalInput,
  EvalOutput,
  Score,
  ScorerRef,
  Verdict,
} from '../src/components';

test('R3 round-trip: all eval components survive world.snapshot() / JSON.stringify', async () => {
  const world = createWorld();
  const caseEntity = world.spawn(
    CaseTag(),
    EvalInput('What is 2+2?'),
    EvalExpected('4'),
    ScorerRef('scorer:exact-match'),
    EvalOutput('4'),
    Score(1),
    Verdict('pass'),
    EvalComplete(),
  );
  const controller = world.spawn(DatasetTag());

  // Snapshot must be JSON-serializable (R3)
  const snapshot = world.snapshot();
  const json = JSON.stringify(snapshot);
  expect(() => JSON.parse(json)).not.toThrow();

  // Round-trip must preserve all component values
  const restored = JSON.parse(json) as typeof snapshot;
  const cc = restored.entities.find((e) => e.id === caseEntity.id)?.components;
  expect(cc?.['eval:EvalInput']).toBe('What is 2+2?');
  expect(cc?.['eval:EvalExpected']).toBe('4');
  expect(cc?.['eval:ScorerRef']).toBe('scorer:exact-match');
  expect(cc?.['eval:EvalOutput']).toBe('4');
  expect(cc?.['eval:Score']).toBe(1);
  expect(cc?.['eval:Verdict']).toBe('pass');
  expect(cc?.['eval:CaseTag']).toBe(true);
  expect(cc?.['eval:EvalComplete']).toBe(true);

  const ctrl = restored.entities.find((e) => e.id === controller.id)?.components;
  expect(ctrl?.['eval:DatasetTag']).toBe(true);
});
