# @langecs/devtools

A visual inspector for LangECS worlds. One call attaches a local web GUI to a
running world:

```ts
import { startDevtools } from '@langecs/devtools';

const server = await startDevtools(world);
console.log(server.url); // http://127.0.0.1:4477
```

Everything the engine knows is on screen, live:

| Panel | Shows | Lets you |
|---|---|---|
| **World** | the live world as a top-down scene: tokens per entity, zone or free/drag or coordinate layouts, speech bubbles and system pulses as runs execute | pan/zoom, drag tokens (Free), select a token to edit it in a side panel, spawn |
| **Inspector** | every entity's components as JSON trees; `Messages` rendered as a chat transcript | edit component values, add/remove components, despawn, send chat messages |
| **Systems** | registered systems, effective queries (agent auto-tags included), matched entities, pending (dirty) pairs and *why* they're dirty | jump to matched entities |
| **Timeline** | the flight recorder (R42): per step — scheduled/vetoed pairs, run durations, buffered writes, applied changes, spawns/despawns, dropped writes | inspect any step, jump to changed entities |
| **Traces** | an OpenTelemetry span waterfall (runs → steps → systems → GenAI model/tool calls with token counts) | inspect attributes, events, errors per span |
| **Events** | the live `RunEvent` stream of every run, including `ctx.emit` custom events (streaming tokens) | filter by type/text |
| **Interrupts** | entities parked on `AwaitingHuman` (R33) | answer them — `world.resume` from a form |
| **Time travel** | the persistence adapter's step history | restore any step boundary (forks the timeline) |

Mutations go through the engine's public external-mutation API and are
**idle-only** (R16): while a run is in flight the server returns a clear error
instead of corrupting a step. Nothing in the devtools bypasses engine
invariants.

## Options

```ts
const server = await startDevtools(world, {
  port: 4477,          // default; occupied ports fall forward (4478, ...)
  host: '127.0.0.1',   // bind address — keep it loopback unless you know better
  history: adapter,    // PersistenceAdapter with history()/loadStep() → enables time travel
  open: false,         // open the browser automatically
});
// ...
await server.close();
```

Pass the same adapter the world persists to (e.g. `MemoryAdapter` from core or
`fsAdapter` from `@langecs/persist-fs`) as `history` to light up time travel.

## Traces: standards in, no lock-in

The server embeds a tiny **OTLP/HTTP JSON receiver** at `POST /v1/traces`. Any
standards-compliant OpenTelemetry exporter can feed the trace view — typically
`@langecs/otel` instrumentation exported through the standard OTel SDK:

```ts
import { instrumentWorld } from '@langecs/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const provider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${server.url}/v1/traces` })),
    // add a second processor to also export to Jaeger/Grafana/Honeycomb — same spans
  ],
});
provider.register();
instrumentWorld(world);
```

The receiver speaks OTLP/HTTP **JSON** (`@opentelemetry/exporter-trace-otlp-http`).
Protobuf exporters get a 415 with a pointer to the JSON one.

## How it connects

`startDevtools` uses the engine's observability surface (SPEC §14) — a passive
event tap, external-change notifications, and read-only introspection. The UI
talks JSON over a WebSocket (`/ws`); the protocol lives in
[`src/protocol.ts`](src/protocol.ts). Observer callbacks are isolated by the
engine (R45): a devtools bug can never change a run's outcome.

## Development

The UI is a React + Vite app in [`ui/`](ui/), built into `dist/ui` by
`pnpm build` and served statically. To hack on the UI against a live world:

```sh
pnpm -C examples devtools-demo        # terminal 1: a demo world on :4477
pnpm -C packages/devtools dev:ui      # terminal 2: Vite dev server, proxied to :4477
```

## Try it

```sh
pnpm build                       # builds the UI once
pnpm -C examples devtools-demo   # scripted world, no API key needed
```
