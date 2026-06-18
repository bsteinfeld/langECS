// CI-01 threshold gate coverage. The gate is a plain vitest assertion on the
// returned passRate: `expect(passRate).toBeGreaterThanOrEqual(passThreshold)`.
// A failing expect makes `vitest run` exit non-zero, which `pnpm test`
// propagates to the CI "Test" step (.github/workflows/ci.yml) -> CI red.
//
// These tests DOCUMENT the gate without ever letting it throw: the passing
// suite clears the gate (green here), and the sub-threshold suite is asserted
// detectable via the inverse inequality (so this documenting file stays green
// while proving a real failing suite would break the build). All scripted,
// zero-network. No process-level exit calls — the gate is a failing expect,
// the repo's actual CI mechanism.

import { createWorld, type EntityHandle, type World } from '@langecs/core';
import { defineTool, reactAgent, registerTools } from '@langecs/stdlib';
import { expect, test } from 'vitest';
import { defineDataset, type EvalCase, runEvalSuite } from '../src/index';

// --- Reused scripted scaffolding (mirrors harness.test.ts) ---
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

function calcScript(answer: string, expression: string): EvalCase['script'] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
    },
    { role: 'assistant', content: answer },
  ] as EvalCase['script'];
}

test('passing suite meets threshold (CI-01 gate is green)', async () => {
  const dataset = defineDataset([
    {
      id: 'pass-1',
      input: 'What is 2+3?',
      expected: '5',
      scorer: 'scorer:contains',
      script: calcScript('The answer is 5.', '2+3'),
    },
    {
      id: 'pass-2',
      input: 'What is 4+4?',
      expected: '8',
      scorer: 'scorer:contains',
      script: calcScript('The answer is 8.', '4+4'),
    },
  ]);

  const world = createWorld({ id: 'ci-gate-pass' });
  const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });

  expect(result.passRate).toBe(1);
  // The literal CI-01 gate assertion — green here.
  expect(result.passRate).toBeGreaterThanOrEqual(result.passThreshold);
});

test('sub-threshold suite is detectable (CI-01 gate would break the build)', async () => {
  // One case fails its scorer: the answer deliberately omits the expected value
  // under scorer:contains, so passed < total -> passRate < passThreshold.
  const dataset = defineDataset([
    {
      id: 'good',
      input: 'What is 2+3?',
      expected: '5',
      scorer: 'scorer:contains',
      script: calcScript('The answer is 5.', '2+3'),
    },
    {
      id: 'bad',
      input: 'What is 4+4?',
      expected: '8',
      scorer: 'scorer:contains',
      // Answer omits "8" entirely -> scorer:contains fails -> verdict 'fail'.
      script: calcScript('I am not sure about that one.', '4+4'),
    },
  ]);

  const world = createWorld({ id: 'ci-gate-fail' });
  const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });

  expect(result.passed).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.passRate).toBe(0.5);
  // Prove the gate WOULD break the build: the inverse of the gate assertion holds.
  // (We assert the inequality positively so this documenting test stays green;
  //  in a real suite `expect(passRate).toBeGreaterThanOrEqual(passThreshold)`
  //  would throw and exit vitest non-zero.)
  expect(result.passRate).toBeLessThan(result.passThreshold);
});

test('passThreshold defaults to 1.0 and is echoed from opts', async () => {
  const dataset = defineDataset([
    {
      id: 'echo',
      input: 'What is 2+3?',
      expected: '5',
      scorer: 'scorer:contains',
      script: calcScript('The answer is 5.', '2+3'),
    },
  ]);

  const defaulted = await runEvalSuite(createWorld({ id: 'ci-gate-default' }), dataset, {
    wireAgent: wireCalcAgent,
  });
  expect(defaulted.passThreshold).toBe(1.0);

  const custom = await runEvalSuite(createWorld({ id: 'ci-gate-custom' }), dataset, {
    wireAgent: wireCalcAgent,
    passThreshold: 0.5,
  });
  expect(custom.passThreshold).toBe(0.5);
});
