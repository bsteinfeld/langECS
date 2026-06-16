# Structured output and routing

LLMs return text, but agents need *data*: a parsed object, a chosen branch, a
classification. LangECS keeps the engine model-agnostic (it never parses model
output), and puts the structured-output tools in `@langecs/stdlib` where they
belong. All of them are plain `Model` helpers — they work with any adapter, with
`scriptedModel`, or with a resource read inside a system
(`ctx.resource<Model>('model:main')`), and they're fully deterministic to test.

## `extractJson` — text in, typed value out

`extractJson(model, opts, validate?)` instructs the model to reply with strict
JSON, strips markdown code fences, `JSON.parse`s it, and — crucially — **retries
once** on failure, feeding the error back as context so a fumbled first answer
self-corrects:

```ts
import { extractJson } from '@langecs/stdlib';

const person = await extractJson<{ name: string; age: number }>(model, {
  prompt: 'Extract the person from: "Ada Lovelace, 36, mathematician."',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name', 'age'],
  },
  schemaName: 'Person',
});
// person: { name: 'Ada', age: 36 }
```

The `schema` is embedded in the instruction as JSON Schema text to guide the
model; it is **not** validated against by default. Without a `validate` hook the
type parameter is an *assertion* — `extractJson<Person>` trusts the parse.

### Enforcing the shape: the `validate` hook

Pass a third argument to actually check the result. The hook receives the parsed
value and returns the typed result, or **throws** to reject it — and a throw
triggers the same single retry (the validation error becomes the model's
correction context). This is the integration point for schema libraries:

```ts
import { z } from 'zod';
const Person = z.object({ name: z.string(), age: z.number().int().min(0) });

// Zod's .parse throws on mismatch — exactly the contract the hook wants.
const person = await extractJson(model, { prompt }, Person.parse);
// person is typed and validated; an invalid first reply is retried with the error.
```

Any library works (`(v) => valibotParse(Schema, v)`), or a hand-written guard:

```ts
const validate = (raw: unknown): Routing => {
  if (typeof raw !== 'object' || raw === null) throw new Error('expected an object');
  // ...narrow and return, or throw with a message the model can act on
};
```

If both attempts fail, `extractJson` throws a descriptive error naming both
failures and showing the last output — so the failure mode is loud, not silent.

## `routeJson` — type-safe dispatch

Routing (supervisor, triage, classifier) is structured output with one job:
pick exactly one of N named destinations. `routeJson` makes that a first-class,
*validated* primitive — the returned `route` is typed as your union, and an
out-of-set or missing choice triggers the retry instead of slipping through:

```ts
import { routeJson } from '@langecs/stdlib';

const { route, reason } = await routeJson<'billing' | 'tech' | 'sales'>(model, {
  routes: [
    { name: 'billing', description: 'invoices, refunds, payment' },
    { name: 'tech', description: 'bugs, errors, how-to' },
    { name: 'sales', description: 'pricing, plans, upgrades' },
  ],
  prompt: ticket.text,
});
// route: 'billing' | 'tech' | 'sales' — dispatch with confidence, no hand-parsing.
```

Inside a system this is the whole dispatcher:

```ts
const triage = defineSystem({
  name: 'triage',
  query: [Ticket, Not(Queue)],
  run: async (e, ctx) => {
    const { route } = await routeJson<'billing' | 'tech' | 'sales'>(
      ctx.resource(MainModel),
      { routes: ROUTES, prompt: e.get(Ticket).text },
    );
    e.set(Queue, route);   // a component write; the matching worker wakes next step
  },
});
```

Routes can be bare strings (`routes: ['a', 'b']`) or objects with descriptions
(better model guidance). For the literal-union type, set the generic explicitly
(`routeJson<'a' | 'b'>`) or pass the array `as const`.

### Decomposition vs. single-choice

`routeJson` is for picking *one* destination. When a supervisor needs to
*decompose* a request into a task per worker (a record, not a choice), reach for
`extractJson` with a schema and a validator instead — that's exactly what the
[supervisor example](../../examples/supervisor/) does:

```ts
const tasks = await extractJson(
  model,
  { system: ROUTING_PROMPT, schema: ROUTING_SCHEMA, schemaName: 'Routing', messages },
  validateRouting,   // ensures at least one worker is assigned, retries otherwise
);
```

## Reasoning content (`Msg.thinking`)

Reasoning models (o1/o3, Claude extended thinking, DeepSeek-R1) emit a thinking
trace alongside their answer. The adapters capture it into `Msg.thinking`, while
`Msg.content` stays the durable answer:

```ts
const { message } = await model.generate({ messages });
message.content;   // the answer
message.thinking;  // the reasoning trace, if the model produced one (else undefined)
```

It is **output-only** — never sent back to the model on the next turn — but it
*is* plain JSON, so it survives snapshots. If the reasoning is sensitive, strip
it before persisting. Both `@langecs/ai-sdk` (from AI SDK reasoning parts) and
`@langecs/langchain` (from `reasoning_content` / thinking content blocks)
populate it.

## Native vs. universal

Some providers support native structured output (constrained decoding). These
helpers are the **universal** path: they work with every model and adapter,
retry on failure, and stay deterministic under `scriptedModel` — which is why
the examples and stdlib build on them. If you need provider-native constrained
decoding, call the provider SDK directly inside a system and wrap the result;
the engine doesn't care how a system produces its component writes.

## Testing

Because these are plain `Model` helpers, test them with `scriptedModel` — no
network, no keys:

```ts
const model = scriptedModel([{ role: 'assistant', content: '{"route":"billing"}' }]);
expect((await routeJson<'billing' | 'tech'>(model, { routes: ['billing', 'tech'], prompt: 'x' })).route)
  .toBe('billing');
```

See `packages/stdlib/test/extract-json.test.ts` and `route-json.test.ts` for the
full behavior, including the retry paths.
