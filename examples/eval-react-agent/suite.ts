// Deterministic eval dataset for the shipped reactAgent (CI-04).
//
// This reuses the EXACT react-agent wiring (assistantAgent + spawnReactAgent +
// the get_weather/calculator tools) as the agent-under-test, so the eval gate
// exercises the same agent the live demo runs — only the model differs. Every
// case carries an inline-typed `script` of scripted assistant turns (08-RESEARCH
// Pitfall F: author tool-call turns in TS, never load them from JSONL) so the
// suite is fully deterministic and zero-network. The real model is opt-in via
// main.ts; this file never reads OPENAI_API_KEY.

import type { EvalCase } from '@langecs/eval';
import { defineDataset } from '@langecs/eval';
import { assistantAgent, spawnReactAgent } from '../react-agent/agent';

// Re-export the agent-under-test so the test file imports a single module.
export { assistantAgent, spawnReactAgent };

/**
 * A scripted ReAct two-turn flow: turn 1 requests both tools in one assistant
 * message (matching examples/react-agent/react-agent.test.ts verbatim), turn 2
 * answers in plain text with the value the scorer checks for. Authored inline so
 * the tool-call shape is well-typed (Pitfall F).
 */
function weatherMathScript(answer: string, city: string, expression: string): EvalCase['script'] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-weather', name: 'get_weather', args: { city } },
        { id: 'call-calc', name: 'calculator', args: { expression } },
      ],
    },
    { role: 'assistant', content: answer },
  ] as EvalCase['script'];
}

/** A single-tool calculator flow for a pure-arithmetic case. */
function mathScript(answer: string, expression: string): EvalCase['script'] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-calc', name: 'calculator', args: { expression } }],
    },
    { role: 'assistant', content: answer },
  ] as EvalCase['script'];
}

/**
 * The deterministic reactAgent eval dataset. Each case is scored by a built-in
 * scorer the scripted answer satisfies — `scorer:contains` looks for the result
 * substring in the agent's final answer. Three small characterization cases;
 * the bulk of the gate's signal is passRate/Verdict (08-RESEARCH Pitfall E),
 * not full-snapshot locking.
 */
export const reactAgentDataset = defineDataset([
  {
    id: 'weather-and-math',
    input: "What's the weather in San Francisco, and what is (23.5 * 4) - 7?",
    expected: '87',
    scorer: 'scorer:contains',
    script: weatherMathScript(
      'It is 64°F and foggy in San Francisco; (23.5 * 4) - 7 = 87.',
      'San Francisco',
      '(23.5 * 4) - 7',
    ),
    tags: ['weather', 'math'],
  },
  {
    id: 'weather-only',
    input: "What's the weather in Tokyo?",
    expected: 'light rain',
    scorer: 'scorer:contains',
    script: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-weather', name: 'get_weather', args: { city: 'Tokyo' } }],
      },
      { role: 'assistant', content: 'It is 71°F with light rain in Tokyo.' },
    ] as EvalCase['script'],
    tags: ['weather'],
  },
  {
    id: 'math-only',
    input: 'What is 12 * 12?',
    expected: '144',
    scorer: 'scorer:contains',
    script: mathScript('12 * 12 = 144.', '12 * 12'),
    tags: ['math'],
  },
]);
