// Shared agent wiring for the react-agent example (SPEC §13: the
// "agent.ts-style shared module"). Both main.ts (real OpenAI model) and
// react-agent.test.ts (deterministic scriptedModel) spawn the exact same
// agent — only the resource registered under MODEL_RESOURCE differs.

import type { AgentDef, EntityHandle, World } from '@langecs/core';
import { defineTool, reactAgent, registerTools, type ToolDef } from '@langecs/stdlib';

/** Resource name the model is registered under (components hold data, resources hold behavior). */
export const MODEL_RESOURCE = 'model:main';

/** Small model for the live demo. */
export const MODEL = 'gpt-5-nano';

export const SYSTEM_PROMPT =
  'You are a helpful assistant. Use the get_weather tool for weather questions and the ' +
  'calculator tool for any arithmetic — never compute math yourself. Answer concisely.';

const CANNED_WEATHER: Record<string, { tempF: number; conditions: string }> = {
  'san francisco': { tempF: 64, conditions: 'foggy' },
  'new york': { tempF: 78, conditions: 'sunny' },
  tokyo: { tempF: 71, conditions: 'light rain' },
};

/**
 * Stubbed weather lookup — the LangGraph.js quickstart uses Tavily web search
 * here; we stub it so the demo needs only an OpenAI key (and the test, nothing).
 */
export const weatherTool: ToolDef = defineTool({
  name: 'get_weather',
  description: 'Look up the current weather for a city. Returns temperature (°F) and conditions.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name, e.g. "San Francisco"' } },
    required: ['city'],
    additionalProperties: false,
  },
  execute: (args) => {
    const city = String((args as { city?: unknown }).city ?? '').trim();
    const report = CANNED_WEATHER[city.toLowerCase()];
    if (report === undefined) {
      return JSON.stringify({
        city,
        error: `No data for "${city}" (stub covers: ${Object.keys(CANNED_WEATHER).join(', ')}).`,
      });
    }
    return JSON.stringify({ city, ...report, source: 'stubbed demo data' });
  },
});

/** Real calculator: evaluates `+ - * / ( )` expressions with a tiny recursive-descent parser. */
export const calculatorTool: ToolDef = defineTool({
  name: 'calculator',
  description: 'Evaluate an arithmetic expression supporting + - * / and parentheses.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'e.g. "(23.5 * 4) - 7"' } },
    required: ['expression'],
    additionalProperties: false,
  },
  execute: (args) => String(evaluate(String((args as { expression?: unknown }).expression ?? ''))),
});

/** Recursive-descent arithmetic evaluator (no eval, no deps). */
export function evaluate(expression: string): number {
  let pos = 0;
  const skipSpaces = (): void => {
    while (expression[pos] === ' ') pos += 1;
  };
  const parseFactor = (): number => {
    skipSpaces();
    if (expression[pos] === '(') {
      pos += 1;
      const inner = parseExpr();
      skipSpaces();
      if (expression[pos] !== ')') throw new Error(`calculator: expected ")" at ${pos}`);
      pos += 1;
      return inner;
    }
    const match = /^-?\d+(?:\.\d+)?/.exec(expression.slice(pos));
    if (!match) throw new Error(`calculator: unexpected input at "${expression.slice(pos)}"`);
    pos += match[0].length;
    return Number(match[0]);
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    skipSpaces();
    while (expression[pos] === '*' || expression[pos] === '/') {
      const op = expression[pos];
      pos += 1;
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : value / rhs;
      skipSpaces();
    }
    return value;
  };
  const parseExpr = (): number => {
    let value = parseTerm();
    skipSpaces();
    while (expression[pos] === '+' || expression[pos] === '-') {
      const op = expression[pos];
      pos += 1;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
      skipSpaces();
    }
    return value;
  };
  const result = parseExpr();
  skipSpaces();
  if (pos !== expression.length) {
    throw new Error(`calculator: trailing input at "${expression.slice(pos)}"`);
  }
  return result;
}

/**
 * The whole agent definition. Component names (including the auto-tag
 * `agent:assistant`) are globally unique (R7), so the AgentDef is created once
 * at module level; it can be spawned into any number of worlds.
 */
export const assistantAgent: AgentDef = reactAgent({
  name: 'assistant',
  model: MODEL_RESOURCE,
  tools: [weatherTool, calculatorTool],
  systemPrompt: SYSTEM_PROMPT,
});

/**
 * Registers both tools as world resources and spawns the ReAct preset.
 * Expects a `Model` already registered under MODEL_RESOURCE.
 */
export function spawnReactAgent(world: World): EntityHandle {
  registerTools(world, [weatherTool, calculatorTool]);
  return world.spawn(assistantAgent);
}
