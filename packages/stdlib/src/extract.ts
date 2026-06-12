// Model-agnostic structured output (SPEC §13): strict-JSON extraction with
// markdown fence stripping and a single parse-failure retry. A pure `Model`
// helper — no world, no components; usable inside or outside systems.

import type { Model, Msg } from '@langecs/core';

export interface ExtractJsonOptions {
  /** One-shot user prompt; appended after `messages` when both are given. */
  prompt?: string;
  /** Conversation context to extract from. */
  messages?: Msg[];
  /** Caller system text; the strict-JSON instruction is appended after it. */
  system?: string;
  /** JSON Schema embedded as text in the instruction. Never validated against. */
  schema?: Record<string, unknown>;
  /** Display name for the schema in the instruction (e.g. `'Person'`). */
  schemaName?: string;
}

/** The system text: caller system, strict-JSON directive, then the schema. */
function buildSystem(opts: ExtractJsonOptions): string {
  const parts: string[] = [];
  if (opts.system !== undefined) parts.push(opts.system);
  parts.push(
    'Respond with ONLY a single valid JSON value. No prose, no explanations, no markdown code fences.',
  );
  if (opts.schema !== undefined) {
    const label = opts.schemaName === undefined ? '' : ` "${opts.schemaName}"`;
    parts.push(
      `The JSON must conform to this JSON Schema${label}:\n${JSON.stringify(opts.schema, null, 2)}`,
    );
  }
  return parts.join('\n\n');
}

/** Strips one wrapping markdown code fence (```json ... ```), if present. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const truncate = (text: string, max = 300): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;

/**
 * Model-agnostic structured output: instructs `model` to reply with strict
 * JSON (embedding `opts.schema` as JSON Schema text when given), strips
 * markdown code fences from the reply, and `JSON.parse`s it. On a parse
 * failure it retries once — appending the malformed reply and the parse error
 * as context — and throws a descriptive error if the retry also fails.
 *
 * `T` is a caller **assertion, not validation**: the parsed value is returned
 * as `T` unchecked. Validate with a schema library where correctness matters.
 *
 * Works with any core `Model` — the adapters, `scriptedModel`, or a resource
 * read inside a system via `ctx.resource<Model>('model:main')`.
 *
 * @example
 * ```ts
 * const person = await extractJson<{ name: string; age: number }>(model, {
 *   prompt: 'Extract the person from: "Ada Lovelace, 36, mathematician."',
 *   schema: {
 *     type: 'object',
 *     properties: { name: { type: 'string' }, age: { type: 'number' } },
 *     required: ['name', 'age'],
 *   },
 *   schemaName: 'Person',
 * });
 * ```
 */
export async function extractJson<T = unknown>(model: Model, opts: ExtractJsonOptions): Promise<T> {
  const messages: Msg[] = [...(opts.messages ?? [])];
  if (opts.prompt !== undefined) messages.push({ role: 'user', content: opts.prompt });
  if (messages.length === 0) {
    throw new Error(
      'extractJson: nothing to send — provide `prompt` (a user message) and/or `messages`.',
    );
  }
  const system = buildSystem(opts);

  const first = await model.generate({ messages, system });
  const firstText = stripFences(first.message.content);
  let firstError: unknown;
  try {
    return JSON.parse(firstText) as T;
  } catch (err) {
    firstError = err;
  }

  // Retry once: the malformed reply and its parse error become context.
  const second = await model.generate({
    messages: [
      ...messages,
      first.message,
      {
        role: 'user',
        content:
          `Your reply was not valid JSON. JSON.parse failed with: ${errorMessage(firstError)}\n` +
          'Reply again with ONLY the corrected JSON value — no prose, no markdown code fences.',
      },
    ],
    system,
  });
  const secondText = stripFences(second.message.content);
  try {
    return JSON.parse(secondText) as T;
  } catch (err) {
    throw new Error(
      'extractJson: the model failed to produce valid JSON in 2 attempts. ' +
        `First parse error: ${errorMessage(firstError)}. ` +
        `Second parse error: ${errorMessage(err)}. ` +
        `Last output (fences stripped): ${truncate(secondText)}. ` +
        'Consider a stronger model, a simpler schema, or a more explicit prompt.',
    );
  }
}
