# devtools-demo — see the whole world

Attaches the [`@langecs/devtools`](../../packages/devtools) inspector and
[`@langecs/otel`](../../packages/otel) OpenTelemetry instrumentation to a small
support-desk world, then leaves it running for you to poke at.

```sh
pnpm build                       # once: builds the devtools UI
pnpm -C examples devtools-demo   # no API key needed
```

No `OPENAI_API_KEY` required: a deterministic *policy model* plays the
assistant (set the key in the repo-root `.env.local` to use `gpt-4o-mini`
instead). The world seeds itself so every panel has something to show:

- a **worker agent** processes a job that fails once and is healed by the
  stdlib `retry` system — `SystemError` appearing and auto-clearing in the
  Timeline (R31/R32);
- a **support agent** receives *"Please refund order #1042"*, looks the order
  up with a tool, then parks on a **human-approval interrupt** before
  `issueRefund` runs (R33) — the run quiesces as `'pending'`;
- an **OrderBook** data entity to edit live in the Inspector.

Telemetry flows the standards route: `instrumentWorld` emits spans through the
OpenTelemetry API → `NodeTracerProvider` → OTLP/HTTP JSON exporter → the
devtools server's `/v1/traces` receiver. Point a second span processor at any
OTLP backend and you get the same traces in Jaeger/Grafana/Honeycomb.

## Things to try in the GUI

1. **Interrupts** → approve the refund with `{"approved": true}` (or deny with
   `{"approved": false, "reason": "warranty expired"}`) and watch the run
   finish in Events/Timeline.
2. **Inspector** → the support agent: chat transcript view of `Messages`; send
   a follow-up message ("refund order #1043, it's broken") from the composer.
3. **Inspector** → the OrderBook entity: edit an order's amount, then ask for
   a refund of that order — the tool reads your edit.
4. **Systems** → see why `executeTools` is dirty-but-vetoed while approval is
   pending (`Not(AwaitingHuman)` + guard).
5. **Time travel** → restore the boundary before the refund request and replay
   it differently. The original timeline is replaced (R36) — that's the fork.
6. **Traces** → expand a `langecs.run` span: steps → systems → `chat`/
   `execute_tool` GenAI spans with token counts.

## Test

The scenario itself (policy model, approval arc, retry healing) is covered
deterministically — zero network — in [`demo.test.ts`](demo.test.ts):

```sh
pnpm -C examples exec vitest run devtools-demo
```
