# @langecs/stdlib

Standard components, systems, and helpers for building chat agents on
[@langecs/core](../core/README.md) — plus `reactAgent`, a preset that wires them into a
spawnable tool-calling agent. Everything here is ordinary ECS: plain components, plain
systems, no privileged engine hooks. If the stdlib conventions don't fit, write your own
systems against the same components.

```ts
import { createWorld, defineResource, type Model, scriptedModel } from '@langecs/core';
import { defineTool, lastAssistant, reactAgent, registerTools, sendMessage } from '@langecs/stdlib';

const add = defineTool({
  name: 'add',
  description: 'Adds two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute: (args) => {
    const { a, b } = args as { a: number; b: number };
    return String(a + b);
  },
});

const Gpt = defineResource<Model>('model:main');   // a typed resource name

const world = createWorld();
world.register(Gpt, scriptedModel([   // any core `Model`; see the adapters for real ones
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'add', args: { a: 2, b: 3 } }] },
  { role: 'assistant', content: 'The answer is 5.' },
]));
registerTools(world, [add]);
const agent = world.spawn(
  reactAgent({ name: 'mathbot', model: Gpt, tools: [add], systemPrompt: 'Be terse.' }),
);

const result = await sendMessage(world, agent, 'What is 2 + 3?');
result.status;                            // 'done', in 3 steps: LLM -> tools -> LLM
lastAssistant(world, agent)?.content;     // 'The answer is 5.'
```

Swap `scriptedModel` for a real model with one registry line
(`world.register(Gpt, fromAiSdk(openai('gpt-4o-mini')))` — see
[@langecs/ai-sdk](../ai-sdk/README.md)); the agent definition does not change. That
split is the point: **components hold data, world resources hold behavior**, and
components reference behavior by name — a `ResourceRef` like `Gpt` is just that
name with the resource's type attached, interchangeable with the plain string.

---

## Components

All values are plain JSON data (core R3).

| Component | Type | Notes |
|---|---|---|
| `Messages` | `Msg[]` | Conversation history. **Append reducer** — concurrent writers merge. |
| `SystemPrompt` | `string` | Sent as `ModelRequest.system`. |
| `ModelRef` | `string` | Name of the world resource holding the `Model`, e.g. `'model:main'`. |
| `Tools` | `string[]` | Tool **names** available to the agent; implementations live in resources under `tool:<name>`. |
| `MessageWaiting` | tag | Present while the agent owes the user an answer; `callLLM` removes it on a no-tool-call reply. |
| `PendingToolCalls` | `ToolCall[]` | Tool calls awaiting execution. Plain component — single writer per step. |
| `Inbox` | `InboxItem[]` | Actor-style mailbox. **Append reducer** — `world.send(e, Inbox([...]))` wakes the recipient. |
| `RetryPolicy` | `{ max: number; baseMs: number }` | Enables the `retry` system on an entity. |

```ts
type ToolCall  = { id: string; name: string; args: unknown };
type InboxItem = { from: string | number; content: string; meta?: Record<string, unknown> };
```

The `Inbox` pattern is the multi-agent communication primitive — appending is foreign
dirt that wakes the recipient's systems next step (adapted from this package's tests):

```ts
const onMail = defineSystem({
  name: 'onMail',
  query: [Inbox, Listener],
  run: (e) => console.log(e.get(Inbox).map((item) => item.content)),
});

await world.send(e, Inbox([{ from: 42, content: 'wake up', meta: { urgent: true } }]));
// reducer merges the item in; the value change re-fires onMail even though it already matched
```

From inside a system, report to another entity with
`ctx.write(task.from, Inbox, [{ from: 'researcher', content: reply.content }], 'add')` —
concurrent workers fan in deterministically through the reducer (see the
[supervisor example](../../examples/supervisor/agents.ts)).

---

## Systems

Four systems implement the chat loop. Spawned via `reactAgent` they are scoped to that
agent's entities by the auto-tag; you can also register any of them globally with
`world.use(...)`.

### The choreography

The canonical cycle, exactly as asserted step-by-step in
[`test/chat.test.ts`](test/chat.test.ts) and
[`test/approval.test.ts`](test/approval.test.ts):

```
sendMessage(world, agent, text)
  = external add: Messages += user msg, MessageWaiting raised, then run()

step 1  callLLM  [Messages, ModelRef, MessageWaiting]
        model replies WITH tool calls:
          Messages += assistant msg
          PendingToolCalls = calls          (MessageWaiting stays — answer still owed)

step 2  PendingToolCalls newly matches BOTH toolApproval and executeTools:
        ├─ no pending call needs approval
        │    toolApproval vetoes (when-guard, dirt consumed)
        │    executeTools runs: Messages += tool results, PendingToolCalls removed
        │
        └─ some call's ToolDef has needsApproval: true
             executeTools vetoes (its guard defers to the approval flow)
             toolApproval runs: AwaitingHuman += interrupt('tool-approval', { calls })
               -> executeTools UNMATCHES (Not(AwaitingHuman) term)
               -> world quiesces, run status 'pending'        ...possibly across
                  a snapshot/load or a process restart...
             world.resume(entity, decision)
               -> AwaitingHuman removed, HumanResponse set
               -> executeTools matches again, guard passes (has HumanResponse)
               -> approved: tools execute; denied: "denied" tool-result messages
               -> HumanResponse consumed, PendingToolCalls removed

step 3  executeTools' Messages append is FOREIGN dirt -> callLLM re-fires
        (its own step-1 append did not: self-write exclusion)
        model replies with plain text:
          Messages += answer, MessageWaiting removed -> nothing dirty -> 'done'
```

### `callLLM`

Query `[Messages, ModelRef, MessageWaiting]`, guard `Messages.length > 0`. Resolves the
`Model` from `ctx.resource(e.get(ModelRef))`, sends `SystemPrompt` and `Tools` specs
when present. When the model implements `stream`, tokens are piped live into the run's
event stream as `ctx.emit({ kind: 'token', text })` — the final message still lands in
`Messages` at the barrier:

```ts
for await (const event of run) {
  if (event.type === 'custom') {
    const data = event.data as { kind?: string; text?: string };
    if (data.kind === 'token' && data.text) process.stdout.write(data.text);
  }
}
```

A reply with tool calls sets `PendingToolCalls` and keeps `MessageWaiting`; a plain
reply removes `MessageWaiting` (quiescence — answer delivered).

### `executeTools`

Query `[PendingToolCalls, Tools, Not(AwaitingHuman)]`. Executes each pending call's
`ToolDef` and appends the results to `Messages` as `tool` messages (`toolCallId`/`name`
preserved). Tool errors become `Error: ...` tool messages so the model can react — a
throwing tool does not crash the run. Denied calls (see below) produce a
`"...was denied by the human reviewer"` tool message with `meta: { denied: true }`;
calls that never needed approval still execute. Consumes `HumanResponse` and removes
`PendingToolCalls`.

### `toolApproval`

Query `[PendingToolCalls, Tools]`. Fires only when some pending call's registered
`ToolDef` has `needsApproval: true` and no decision exists yet; appends a
`tool-approval` interrupt carrying `{ calls }` (only the calls that need approval).
The resume value is interpreted as:

```ts
world.resume(entity, true);                                  // approve
world.resume(entity, { approved: false, reason: 'nope' });   // deny with reason
world.resume(entity, false);                                 // deny
```

### `retry`

Query `[SystemError, RetryPolicy]`. Failure handling built on two engine guarantees:
the engine appends `SystemError` records when a pair throws (R31) and auto-clears them
when the pair later succeeds (R32). `retry` counts records per failing system; while
`attempts <= max` it waits `baseMs * 2^(attempts-1)` and re-arms the failed pair with
`ctx.invalidate(e, system)`. Once a system exceeds `max`, its records stay and the run
quiesces with status `'error'` for a supervisor (or your caller) to inspect.

```ts
const agent = world.spawn(reactAgent({
  name: 'flaky', model: 'model:main',
  retry: { max: 2, baseMs: 100 },   // adds RetryPolicy; the preset already bundles `retry`
}));
```

---

## Tools

```ts
interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;  // JSON Schema for the arguments
  needsApproval?: boolean;               // gate behind a human interrupt
  execute: (args: unknown) => unknown | Promise<unknown>;
}
```

| Export | What it does |
|---|---|
| `defineTool(def)` | Identity helper for typing/DX symmetry with `defineComponent`/`defineSystem`. |
| `registerTools(world, tools)` | Registers each tool as a world resource under `tool:<name>`. |
| `toolResourceName(name)` | `'calc'` → `'tool:calc'` (idempotent on prefixed input). |
| `bareToolName(name)` | `'tool:calc'` → `'calc'` — the name the model sees. |
| `toToolSpec(tool)` | The model-facing `ToolSpec` (name/description/parameters only). |
| `lookupTool(ctx, name)` | Resolves a tool resource from a system or guard context; `undefined` when unregistered. |

A tool is **data a system reads** (a name in the `Tools` component), not the definition
of a system. The whole approval policy is one flag (from the
[human-in-the-loop example](../../examples/human-in-the-loop/agent.ts)):

```ts
const deleteRecord = defineTool({
  name: 'delete_record',
  description: 'Permanently delete a record by numeric id. This cannot be undone.',
  parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  needsApproval: true,   // toolApproval turns this into an AwaitingHuman interrupt
  execute: (args) => `Record ${(args as { id: number }).id} permanently deleted.`,
});
```

---

## Helpers

```ts
userMessage(text: string): Msg
// { role: 'user', content: text }

sendMessage(world: World, agent: EntityTarget, text: string): Run
// world.send(agent, Messages([userMessage(text)]), MessageWaiting())
// — append the user turn, raise the "answer owed" flag, drive to quiescence

lastAssistant(world: World, agent: EntityTarget): Msg | undefined
// the most recent assistant message on the agent

ask(world: World, agent: EntityTarget, text: string): Promise<string>
// sendMessage + await + lastAssistant().content — the one-liner Q&A path
```

Multi-turn conversation is just repeated `sendMessage` — each call re-raises
`MessageWaiting` and the world quiesces on each answer:

```ts
await sendMessage(world, agent, 'one');
lastAssistant(world, agent)?.content;  // 'first answer'
await sendMessage(world, agent, 'two');
lastAssistant(world, agent)?.content;  // 'second answer'
```

### `ask`

When all you want is the reply text:

```ts
const answer = await ask(world, agent, 'What is 2 + 3?');  // 'The answer is 5.'
```

`ask` resolves only fully-automatic turns that quiesce as `'done'`; any other
outcome throws an `Error` that says what happened and what to do next:

| Run status | The thrown error explains... |
|---|---|
| `'pending'` | which entities await human input and which interrupt kinds — answer with `world.pending()` / `world.resume(entity, value)`, then read `lastAssistant`. |
| `'error'` | each failing system's name and error message (from the `SystemError` records). |
| `'limit'` | the step cap was hit — raise `recursionLimit` (or `world.run({ limit })`), or find the non-quiescing cycle in `world.getTrace()`. |
| `'idle'` / `'done'` without a reply | the agent isn't wired to answer — spawn via `reactAgent` or `world.use(...)` the chat systems. |

Approval flows keep using `sendMessage` + `world.resume` (the `Run` statuses are the
control flow there); `ask` is for the turns that should just answer.

---

## Structured output

```ts
extractJson<T = unknown>(model: Model, opts: {
  prompt?: string;                   // one-shot user message (appended after `messages`)
  messages?: Msg[];                  // conversation context to extract from
  system?: string;                   // your system text; the strict-JSON directive is appended
  schema?: Record<string, unknown>;  // JSON Schema, embedded as text in the instruction
  schemaName?: string;               // display name for the schema, e.g. 'Person'
}, validate?: (parsed: unknown) => T): Promise<T>
```

Model-agnostic structured output over any core `Model` (no provider-specific
JSON mode required): instructs the model to reply with strict JSON — embedding
the schema text when given — strips markdown code fences, and `JSON.parse`s the
reply. On a parse failure it retries **once** with the malformed output and the
parse error appended as context, then throws a descriptive error.

```ts
const person = await extractJson<{ name: string; age: number }>(model, {
  prompt: 'Extract the person from: "Ada Lovelace, 36, mathematician."',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name', 'age'],
  },
  schemaName: 'Person',
});
```

Without `validate`, `T` is a **caller assertion** — the parsed value is returned
unchecked (the schema is only embedded as instruction text). Pass a `validate`
hook to actually enforce the shape: it returns the typed value or **throws**, and
a throw triggers the same single retry with the error fed back to the model.
Plug in a schema library directly — `extractJson(model, opts, MySchema.parse)`
(Zod) — or a hand-written guard.

### `routeJson` — type-safe routing

For the dispatcher / triage / classifier case (pick one of N named routes),
`routeJson` is the validated primitive: the returned `route` is typed as your
union, and an out-of-set choice triggers the retry.

```ts
const { route, reason } = await routeJson<'billing' | 'tech' | 'sales'>(model, {
  routes: [
    { name: 'billing', description: 'invoices, refunds, payment' },
    { name: 'tech', description: 'bugs, errors, how-to' },
    { name: 'sales', description: 'pricing, plans' },
  ],
  prompt: ticket.text,
});
```

See the [structured-output guide](../../docs/guides/structured-output.md) for the
full story (including reasoning content via `Msg.thinking`).

## Context window

Keep long conversations under a token budget without losing durable history:

```ts
recentMessages(messages, { maxMessages?, maxTokens?, estimate?, keepSystem? }): Msg[]
estimateTokens(stringOrMessages): number      // ~4 chars/token heuristic, overridable
withMessageWindow(model, options): Model       // trims each request's messages before the call
```

`withMessageWindow` wraps a `Model` so every call sees only the most recent
messages (or a token budget), pinning leading system messages and never
orphaning a tool result — while the stored `Messages` history stays intact. It's
a plain wrapper (no scheduler interaction), so it composes safely with the chat
loop and is trivially testable. See the
[context-window example](../../examples/context-window/).

---

## `reactAgent(opts): AgentDef`

The preset that wires all of the above into a spawnable
[`AgentDef`](../core/README.md#agents):

```ts
interface ReactAgentOptions {
  name: string;                  // becomes the auto-tag `agent:<name>` (globally unique)
  model: string | ResourceRef<Model>;  // typed ref from defineResource<Model>(...), or the
                                       // plain resource name; only the name is stored (ModelRef)
  tools?: (string | ToolDef)[];  // names land in the Tools component; ToolDef
                                 // implementations must still be registered via registerTools
  systemPrompt?: string;
  retry?: { max: number; baseMs: number };  // adds RetryPolicy
}
```

Components: `Messages([])`, `ModelRef(model)`, `Tools(names)`, plus `SystemPrompt` and
`RetryPolicy` when given. Systems: `callLLM`, `toolApproval`, `executeTools`, `retry`
(`retry` only matches once a `RetryPolicy` is present; harmless otherwise) — each
registered as `<name>:<system>` and scoped to this agent's entities by the auto-tag.
Two agents sharing these component shapes never crosstalk.

Define the `AgentDef` once at module level (component names are globally unique), then
spawn it into any number of worlds — the
[react-agent example](../../examples/react-agent/agent.ts) shares one definition
between the live demo and its deterministic test.

---

## See also

- [@langecs/core](../core/README.md) — the engine API this package builds on
- [@langecs/ai-sdk](../ai-sdk/README.md) / [@langecs/langchain](../langchain/README.md)
  — real `Model` implementations for `ModelRef`
- [@langecs/persist-fs](../persist-fs/README.md) — persist the world across processes
- [Examples](../../examples/README.md) — ReAct, sql-agent, supervisor, reflection,
  human-in-the-loop, time-travel
- [LangGraph comparison](../../docs/langgraph-comparison.md) ·
  [SPEC.md §13](../../SPEC.md) · [CONTRIBUTING.md](../../CONTRIBUTING.md)
