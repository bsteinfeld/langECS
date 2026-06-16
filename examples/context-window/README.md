# context-window

**Teaches:** keeping a long conversation under a token budget without losing
durable history — and why that falls out naturally from the components/resources
split.

A real chat agent runs for many turns, and `Messages` grows every turn. Left
unbounded, each model call sends the entire transcript: rising cost, rising
latency, eventually a context-length error. The fix is to bound what the model
*sees* on each call, while keeping the full history as durable state.

LangECS makes this a one-liner because **data and behavior are separate**: the
transcript is a component (durable, snapshot-able, time-travelable); the model
is a resource (behavior). Wrapping the resource changes what each call sees
without touching the stored data:

```ts
world.register(Chatbot, withMessageWindow(fromAiSdk(openai('gpt-4o-mini')), { maxMessages: 6 }));
```

That's the whole change from an unbounded chatbot. `withMessageWindow`:

- trims each request's `messages` to the most recent N (or to a token budget
  with `{ maxTokens }`) using the pure, deterministic `recentMessages` helper;
- always keeps leading `system` messages;
- never sends a `tool` result orphaned from its assistant tool-call (a common
  provider 400);
- leaves the stored `Messages` history completely untouched — snapshots and
  time-travel still see everything.

Because it is a plain `Model` wrapper, there is **no scheduler interaction**: it
can never race `callLLM`/`executeTools` on the `Messages` component or trigger a
loop. The same reason it is trivially testable with `scriptedModel`.

## Other tools in the box

- `recentMessages(messages, { maxMessages?, maxTokens?, estimate?, keepSystem? })`
  — the pure trimmer; call it yourself inside a system if you want explicit control.
- `estimateTokens(stringOrMessages)` — a cheap ~4-chars/token heuristic; pass your
  own `estimate` to `withMessageWindow`/`recentMessages` for a real tokenizer.

## Run it

```sh
pnpm -C examples context-window   # live demo (needs OPENAI_API_KEY)
```

The demo runs eight turns through a 6-message window, then prints the full
retained history length — and shows the honest trade-off: a fact from an early
turn that scrolled out of the window is no longer recallable. Widen the window,
switch to `maxTokens`, or add summarization to extend memory.

The test (`context-window.test.ts`) proves the invariant deterministically: no
model call exceeds the window, yet the entity retains every message.
