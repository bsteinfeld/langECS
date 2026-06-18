// Harness behavioral coverage (EVAL-04 sub-world isolation + score-after-
// quiescence + non-done-throws; EVAL-05 dual scripted/real model path). All
// tests are deterministic and zero-network: each case carries its own scripted
// model turns and the real-model path is exercised only by the gated example.

import { createWorld, type EntityHandle, type Msg, scriptedModel, type World } from '@langecs/core';
import { defineTool, Messages, reactAgent, registerTools } from '@langecs/stdlib';
import { describe, expect, test } from 'vitest';
import { defineDataset, type EvalCase, runEvalSuite } from '../src/index';

// --- Minimal self-contained agent under test (scripted, zero-network) ---
// A single calculator tool keeps the package independent of the examples
// workspace while still exercising a real ReAct tool-call cycle.
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

// A scripted two-turn flow: request the tool, then answer with the result.
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

describe('runEvalSuite — sub-world isolation (EVAL-04)', () => {
  test('each case runs in its own eval-<id> throwaway world', async () => {
    const dataset = defineDataset([
      {
        id: 'case-a',
        input: 'What is 2+3?',
        expected: '5',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
      {
        id: 'case-b',
        input: 'What is 4+4?',
        expected: '8',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 8.', '4+4'),
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });

    expect(result.total).toBe(2);
    // Distinct per-case worldIds prove each case ran in its own sub-world.
    expect(result.cases.map((c) => c.snapshot.worldId)).toEqual(['eval-case-a', 'eval-case-b']);
    expect(new Set(result.cases.map((c) => c.snapshot.worldId)).size).toBe(2);
  });
});

describe('runEvalSuite — score only after quiescence (EVAL-04)', () => {
  test('a passing case yields done + numeric score + pass, scoring chain fires once', async () => {
    const dataset = defineDataset([
      {
        id: 'pass-case',
        input: 'What is 2+3?',
        expected: '5',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });

    const row = result.cases[0];
    expect(row?.status).toBe('done');
    expect(typeof row?.score).toBe('number');
    expect(row?.score).toBeGreaterThanOrEqual(1);
    expect(row?.verdict).toBe('pass');

    // The outer-world trace shows scoreCase and verdictSystem each fired once.
    const fired = world.getTrace().flatMap((s) => s.runs.map((r) => r.system));
    expect(fired.filter((s) => s === 'eval:scoreCase')).toHaveLength(1);
    expect(fired.filter((s) => s === 'eval:verdictSystem')).toHaveLength(1);
  });
});

describe('runEvalSuite — non-done status throws (EVAL-04)', () => {
  test('a non-quiescing run (limit) rejects naming the case id and status; no verdict', async () => {
    // A model that ALWAYS requests the tool never quiesces -> 'limit'.
    const looper = (): Msg => ({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-loop', name: 'calculator', args: { expression: '1+1' } }],
    });
    // 60 scripted looping turns exceeds the default recursion limit (50).
    const loopScript = Array.from({ length: 60 }, () => looper()) as EvalCase['script'];

    const dataset = defineDataset([
      {
        id: 'looping-case',
        input: 'loop forever',
        expected: 'never',
        scorer: 'scorer:contains',
        script: loopScript,
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    await expect(runEvalSuite(world, dataset, { wireAgent: wireCalcAgent })).rejects.toThrow(
      /looping-case.*limit/s,
    );

    // No case entity was ever scored — no Score component was produced anywhere.
    const scored = world.getTrace().flatMap((s) => s.runs.map((r) => r.system));
    expect(scored).not.toContain('eval:scoreCase');
  });
});

describe('runEvalSuite — dual model path (EVAL-05)', () => {
  test('default = scriptedModel passes with no realModel and no OPENAI_API_KEY', async () => {
    const dataset = defineDataset([
      {
        id: 'scripted-default',
        input: 'What is 2+3?',
        expected: '5',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });
    expect(result.passRate).toBe(1);
  });

  test('realModel set but OPENAI_API_KEY absent falls back to scriptedModel (no test edit)', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // A bogus "real" model that would throw if ever called proves the fallback.
      const explodingRealModel = {
        generate: async () => {
          throw new Error('real model must not be called when OPENAI_API_KEY is absent');
        },
      };
      const dataset = defineDataset([
        {
          id: 'dual-fallback',
          input: 'What is 4+4?',
          expected: '8',
          scorer: 'scorer:contains',
          script: calcScript('The answer is 8.', '4+4'),
        },
      ]);

      const world = createWorld({ id: 'eval-outer' });
      // SAME call site as a real-model run — only the env toggles the path.
      const result = await runEvalSuite(world, dataset, {
        wireAgent: wireCalcAgent,
        realModel: explodingRealModel,
      });
      expect(result.passRate).toBe(1); // scripted path used; exploding model untouched.
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe('runEvalSuite — ungated per-case model factory (CMP-01)', () => {
  // The factory's turns mirror calcScript but are fed to scriptedModel directly,
  // bypassing the per-case `EvalCase.script` path. A FRESH scriptedModel per call
  // is required because the instance advances an index and exhausts (R44).
  function factoryTurns(answer: string, expression: string): Parameters<typeof scriptedModel>[0] {
    return [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
      },
      { role: 'assistant', content: answer },
    ];
  }

  test('a fresh-per-call factory survives a 2-case dataset where one shared model would exhaust', async () => {
    // The dataset carries NO per-case script; only the factory supplies models.
    // Each case consumes 2 turns; a single shared scriptedModel([...4 turns]) is
    // not what we pass — the factory returns a fresh 2-turn model per case, so
    // neither case throws "scriptedModel exhausted".
    const dataset = defineDataset([
      { id: 'fac-a', input: 'What is 2+3?', expected: '5', scorer: 'scorer:contains' },
      { id: 'fac-b', input: 'What is 4+4?', expected: '5', scorer: 'scorer:contains' },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, {
      wireAgent: wireCalcAgent,
      modelFactory: () => scriptedModel(factoryTurns('The answer is 5.', '2+3')),
    });

    expect(result.total).toBe(2);
    expect(result.cases.every((c) => c.status === 'done')).toBe(true);
    expect(result.passRate).toBe(1);
  });

  test('two DIFFERENT factory models over one dataset produce DIFFERENT outputs', async () => {
    const dataset = defineDataset([
      { id: 'distinct', input: 'What is 2+3?', expected: 'answer', scorer: 'scorer:contains' },
    ]);

    const worldA = createWorld({ id: 'eval-outer-a' });
    const resultA = await runEvalSuite(worldA, dataset, {
      wireAgent: wireCalcAgent,
      modelFactory: () => scriptedModel(factoryTurns('candidate A answer', '2+3')),
    });

    const worldB = createWorld({ id: 'eval-outer-b' });
    const resultB = await runEvalSuite(worldB, dataset, {
      wireAgent: wireCalcAgent,
      modelFactory: () => scriptedModel(factoryTurns('candidate B answer', '2+3')),
    });

    expect(resultA.cases[0]?.output).toBe('candidate A answer');
    expect(resultB.cases[0]?.output).toBe('candidate B answer');
    expect(resultA.cases[0]?.output).not.toBe(resultB.cases[0]?.output);
  });

  test('realModel + OPENAI_API_KEY still takes precedence over modelFactory', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-fake-key';
    try {
      // realModel answers '5'; the factory (if ever consulted) would answer
      // 'FACTORY' — proving precedence by which output appears.
      const realModel = scriptedModel(factoryTurns('The answer is 5.', '2+3'));
      const dataset = defineDataset([
        { id: 'precedence', input: 'What is 2+3?', expected: '5', scorer: 'scorer:contains' },
      ]);

      const world = createWorld({ id: 'eval-outer' });
      const result = await runEvalSuite(world, dataset, {
        wireAgent: wireCalcAgent,
        realModel,
        modelFactory: () => scriptedModel(factoryTurns('FACTORY answer', '2+3')),
      });

      expect(result.cases[0]?.output).toBe('The answer is 5.');
      expect(result.passRate).toBe(1);
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('runEvalSuite — additive per-case steps/wallMs (Phase 9 BENCH-03)', () => {
  test('each case carries numeric steps and a wallMs driven by an injected clock', async () => {
    const dataset = defineDataset([
      {
        id: 'metered-case',
        input: 'What is 2+3?',
        expected: '5',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
    ]);

    // A fake clock returning [100, 125] across the single case's sendMessage:
    // t0 = 100 (before), now() = 125 (after) → wallMs === 25, deterministic.
    const ticks = [100, 125];
    let i = 0;
    const clock = () => ticks[i++] ?? 0;

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent, clock });

    const row = result.cases[0];
    expect(row?.wallMs).toBe(25);
    expect(typeof row?.steps).toBe('number');
    expect(row?.steps).toBeGreaterThan(0);
  });

  test('omitting clock leaves steps populated and wallMs a finite number (default Date.now)', async () => {
    const dataset = defineDataset([
      {
        id: 'default-clock-case',
        input: 'What is 4+4?',
        expected: '8',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 8.', '4+4'),
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, { wireAgent: wireCalcAgent });

    const row = result.cases[0];
    expect(typeof row?.steps).toBe('number');
    expect(row?.steps).toBeGreaterThan(0);
    expect(Number.isFinite(row?.wallMs)).toBe(true);
    expect(row?.wallMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runEvalSuite — output extractor override', () => {
  test('opts.extractOutput overrides the default lastAssistant extractor', async () => {
    const dataset = defineDataset([
      {
        id: 'extract-override',
        input: 'What is 2+3?',
        expected: 'CUSTOM',
        scorer: 'scorer:contains',
        script: calcScript('The answer is 5.', '2+3'),
      },
    ]);

    const world = createWorld({ id: 'eval-outer' });
    const result = await runEvalSuite(world, dataset, {
      wireAgent: wireCalcAgent,
      // Ignore the agent transcript; emit a fixed string to prove the hook is used.
      extractOutput: (w, agent) => {
        // sanity: the agent did run and has messages in its sub-world.
        const msgs = w.entity(typeof agent === 'number' ? agent : agent.id)?.get(Messages) ?? [];
        expect(msgs.length).toBeGreaterThan(0);
        return 'CUSTOM output';
      },
    });
    expect(result.cases[0]?.output).toBe('CUSTOM output');
    expect(result.cases[0]?.verdict).toBe('pass');
  });
});
