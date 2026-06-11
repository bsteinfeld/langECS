// Integration test: one ReAct-style round trip against a real OpenAI model.
// Gated on OPENAI_API_KEY (loaded from the repo-root .env.local); skipped
// entirely when the key is absent. All other tests in this package are
// deterministic and network-free.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Msg, ToolSpec } from '@langecs/core';
import { describe, expect, it } from 'vitest';
import { fromAiSdk } from '../src/index';

/**
 * Tiny repo-root `.env.local` loader (KEY=VALUE lines, optional quotes,
 * existing env vars win). No dotenv dependency; values are never logged.
 */
function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let text: string;
  try {
    text = readFileSync(resolve(here, '../../../.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

const addTool: ToolSpec = {
  name: 'add',
  description: 'Add two numbers and return their sum.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First addend' },
      b: { type: 'number', description: 'Second addend' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

const system =
  'You are a calculator assistant. You must use the add tool for any addition; ' +
  'never compute sums yourself. After receiving the tool result, state the answer.';

describe.skipIf(!process.env.OPENAI_API_KEY)('OpenAI integration (real network)', () => {
  it('runs a ReAct round trip: tool call, tool result, final text', {
    timeout: 90_000,
  }, async () => {
    const { openai } = await import('@ai-sdk/openai');
    const model = fromAiSdk(openai('gpt-4o-mini'));

    const messages: Msg[] = [{ role: 'user', content: 'What is 2384 plus 5821?' }];

    // Turn 1: the model must request the add tool.
    const first = await model.generate({ messages, system, tools: [addTool], temperature: 0 });
    expect(first.message.role).toBe('assistant');
    expect(first.message.toolCalls?.length).toBeGreaterThanOrEqual(1);
    const call = first.message.toolCalls?.[0];
    expect(call?.name).toBe('add');
    const args = call?.args as { a: number; b: number };
    expect(typeof args.a).toBe('number');
    expect(typeof args.b).toBe('number');
    expect(first.usage?.inputTokens).toBeGreaterThan(0);

    // Execute the tool locally and append the tool result.
    const sum = args.a + args.b;
    expect(sum).toBe(8205);
    messages.push(first.message);
    messages.push({ role: 'tool', content: String(sum), toolCallId: call?.id, name: 'add' });

    // Turn 2 (streamed): a final text answer arrives, no further tool calls.
    const chunks: string[] = [];
    const second = await model.stream?.(
      { messages, system, tools: [addTool], temperature: 0 },
      (d) => {
        if (d.text) chunks.push(d.text);
      },
    );
    expect(second).toBeDefined();
    expect(second?.message.toolCalls ?? []).toHaveLength(0);
    const finalText = second?.message.content ?? '';
    expect(finalText.length).toBeGreaterThan(0);
    expect(finalText.replace(/[,.\s]/g, '')).toContain('8205');
    expect(chunks.join('')).toBe(finalText);
  });
});
