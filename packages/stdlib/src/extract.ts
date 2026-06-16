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
 * A validation/parse hook: receives the `JSON.parse`d value and returns the
 * typed result, or **throws** to reject it. Throwing triggers `extractJson`'s
 * single retry (the error message becomes context for the model), so this is
 * the integration point for schema libraries — pass `schema.parse` (Zod),
 * `(v) => v.parse(schema)` (Valibot), or any guard that throws on bad input.
 */
export type Validator<T> = (parsed: unknown) => T;

/**
 * Model-agnostic structured output: instructs `model` to reply with strict
 * JSON (embedding `opts.schema` as JSON Schema text when given), strips
 * markdown code fences from the reply, and `JSON.parse`s it. On a parse (or
 * validation) failure it retries once — appending the malformed reply and the
 * error as context — and throws a descriptive error if the retry also fails.
 *
 * Without a `validate` hook, `T` is a caller **assertion, not validation**: the
 * parsed value is returned as `T` unchecked. Pass `validate` (e.g. a Zod/Valibot
 * parse function) to actually enforce the shape and feed validation errors back
 * into the retry — `extractJson(model, opts, MySchema.parse)`.
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
 *
 * // With runtime validation (Zod): invalid shapes trigger the retry.
 * const person = await extractJson(model, { prompt }, PersonSchema.parse);
 * ```
 */
export async function extractJson<T = unknown>(
  model: Model,
  opts: ExtractJsonOptions,
  validate?: Validator<T>,
): Promise<T> {
  const messages: Msg[] = [...(opts.messages ?? [])];
  if (opts.prompt !== undefined) messages.push({ role: 'user', content: opts.prompt });
  if (messages.length === 0) {
    throw new Error(
      'extractJson: nothing to send — provide `prompt` (a user message) and/or `messages`.',
    );
  }
  const system = buildSystem(opts);

  // Parse + (optionally) validate; throws on either failure so the caller can
  // fold both into one retry path.
  const parse = (text: string): T => {
    const value = JSON.parse(text) as unknown;
    return validate ? validate(value) : (value as T);
  };

  const first = await model.generate({ messages, system });
  const firstText = stripFences(first.message.content);
  let firstError: unknown;
  try {
    return parse(firstText);
  } catch (err) {
    firstError = err;
  }

  // Retry once: the malformed reply and its error become context.
  const second = await model.generate({
    messages: [
      ...messages,
      first.message,
      {
        role: 'user',
        content:
          `Your reply could not be used. It failed with: ${errorMessage(firstError)}\n` +
          'Reply again with ONLY a corrected JSON value that fixes this — no prose, no markdown code fences.',
      },
    ],
    system,
  });
  const secondText = stripFences(second.message.content);
  try {
    return parse(secondText);
  } catch (err) {
    throw new Error(
      'extractJson: the model failed to produce a valid JSON value in 2 attempts. ' +
        `First error: ${errorMessage(firstError)}. ` +
        `Second error: ${errorMessage(err)}. ` +
        `Last output (fences stripped): ${truncate(secondText)}. ` +
        'Consider a stronger model, a simpler schema, or a more explicit prompt.',
    );
  }
}

/** One route a model can choose, with an optional description to guide it. */
export type RouteSpec<K extends string> = K | { name: K; description?: string };

export interface RouteJsonOptions<K extends string> {
  /**
   * The allowed destinations. Strings (`['research', 'write']`) or objects with
   * descriptions (`[{ name: 'research', description: 'find facts' }]`). For
   * inference of the literal `K` union, pass them `as const` or set the generic
   * explicitly: `routeJson<'research' | 'write'>(...)`.
   */
  routes: readonly RouteSpec<K>[];
  /** Conversation context to route on. */
  messages?: Msg[];
  /** One-shot text to route on; appended after `messages` when both are given. */
  prompt?: string;
  /** Extra routing instructions, prepended before the format directive. */
  system?: string;
}

/** A validated routing decision: `route` is guaranteed to be one of the options. */
export interface RouteDecision<K extends string> {
  route: K;
  /** The model's short justification, when it supplied one. */
  reason?: string;
}

const routeName = <K extends string>(route: RouteSpec<K>): K =>
  typeof route === 'string' ? route : route.name;

/**
 * Type-safe LLM routing — the dispatcher primitive for supervisor / triage /
 * classifier patterns. Asks `model` to choose exactly one of `opts.routes` and
 * return `{ route, reason? }`, then **validates** the choice is one of the
 * allowed names (an invalid or missing route triggers `extractJson`'s retry, so
 * a fumbled first answer self-corrects). The returned `route` is typed as the
 * `K` union — no stringly-typed hand-parsing, no silent fallthrough.
 *
 * Built on {@link extractJson}; works with any core `Model`.
 *
 * @example
 * ```ts
 * const { route } = await routeJson<'billing' | 'tech' | 'sales'>(model, {
 *   routes: [
 *     { name: 'billing', description: 'invoices, refunds, payment' },
 *     { name: 'tech', description: 'bugs, errors, how-to' },
 *     { name: 'sales', description: 'pricing, plans, upgrades' },
 *   ],
 *   prompt: ticket.text,
 * });
 * // route: 'billing' | 'tech' | 'sales' — dispatch with confidence.
 * ```
 */
export async function routeJson<K extends string>(
  model: Model,
  opts: RouteJsonOptions<K>,
): Promise<RouteDecision<K>> {
  const names = opts.routes.map(routeName);
  if (names.length === 0) throw new Error('routeJson: `routes` must list at least one route.');
  const allowed = new Set<string>(names);

  const optionLines = opts.routes
    .map((route) => {
      if (typeof route === 'string') return `- ${route}`;
      return route.description ? `- ${route.name}: ${route.description}` : `- ${route.name}`;
    })
    .join('\n');
  const systemParts: string[] = [];
  if (opts.system !== undefined) systemParts.push(opts.system);
  systemParts.push(`Choose exactly one route for the request from these options:\n${optionLines}`);

  const schema = {
    type: 'object',
    properties: {
      route: { type: 'string', enum: names },
      reason: { type: 'string' },
    },
    required: ['route'],
  };

  const validate: Validator<RouteDecision<K>> = (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('expected an object like {"route": "<one of the options>"}');
    }
    const { route, reason } = parsed as { route?: unknown; reason?: unknown };
    if (typeof route !== 'string' || !allowed.has(route)) {
      throw new Error(
        `"route" must be exactly one of: ${names.join(', ')} (got ${JSON.stringify(route)}).`,
      );
    }
    const decision: RouteDecision<K> = { route: route as K };
    if (typeof reason === 'string' && reason.length > 0) decision.reason = reason;
    return decision;
  };

  const extractOpts: ExtractJsonOptions = {
    system: systemParts.join('\n\n'),
    schema,
    schemaName: 'RouteDecision',
  };
  if (opts.messages !== undefined) extractOpts.messages = opts.messages;
  if (opts.prompt !== undefined) extractOpts.prompt = opts.prompt;

  return extractJson<RouteDecision<K>>(model, extractOpts, validate);
}
