# @langecs/otel

OpenTelemetry instrumentation for [LangECS](../../README.md): run/step/system spans from the
engine's observer surface (SPEC §14), GenAI semantic-convention spans for models and tools, and
engine metrics.

## Layering: API-only

This is an OpenTelemetry **instrumentation library**. Its only runtime dependency is
`@opentelemetry/api` (a peer dependency) — it never bundles or configures an SDK. The host
application owns providers, exporters, sampling, and the context manager. With no SDK configured,
every call in this package is a cheap no-op against the API's noop implementations.

Two consequences worth knowing:

- **Context propagation needs a context manager.** System spans are made *active* around each
  system's `run` (via `wrapSystemRun`, R46), so spans created by user code inside a system —
  model calls, `fetch` instrumentations — nest under the system span. That nesting only works
  when the host registered a context manager (`NodeSDK` and `NodeTracerProvider.register()` do;
  manually: `context.setGlobalContextManager(new AsyncLocalStorageContextManager())`). Without
  one you still get a correct `run → step → system` tree, just no nesting of user-code spans.
- **The caller's active span parents the run span.** The `run:start` tap fires synchronously
  inside `world.run()`, so calling `world.run()` under an active span (an HTTP handler span,
  say) links the whole run into that trace.

## Quickstart with NodeSDK

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { instrumentWorld } from '@langecs/otel';
import { createWorld } from '@langecs/core';

const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
sdk.start(); // registers global providers + an AsyncLocalStorage context manager

const world = createWorld({ id: 'support-desk' });
const detach = instrumentWorld(world); // uses the global providers

// Models/tools registered from here on are auto-wrapped (wrapResources):
world.register('model:main', myModel);   // → `chat model:main` spans
world.register('tool:search', myTool);   // → `execute_tool search` spans

await world.run();
detach(); // unhook observer, restore world.register, end leftover spans
```

## Quickstart with `@langecs/devtools`

The devtools server accepts standard OTLP/HTTP JSON traces at `POST /v1/traces`, so any
spec-compliant exporter feeds its trace view:

```ts
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { instrumentWorld } from '@langecs/otel';

const provider = new BasicTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: 'http://localhost:4571/v1/traces' }),
    ),
  ],
});
const detach = instrumentWorld(world, { tracerProvider: provider });
```

## API

### `instrumentWorld(world, options?) => detach`

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `tracerProvider` | `TracerProvider` | `trace.getTracerProvider()` | Where spans go. |
| `meterProvider` | `MeterProvider` | `metrics.getMeterProvider()` | Where metrics go. |
| `captureChanges` | `boolean` | `false` | Adds a `langecs.change` event per committed change to each step span (`entity`, `component`, `kind`, JSON `value` capped at 2048 chars). Off by default — change values can carry conversation content. |
| `wrapResources` | `boolean` | `true` | Patches `world.register`: values with a `generate` function are wrapped with `instrumentModel({ model: <resource name> })`; `tool:*` resources with an `execute` function with `instrumentTool`. All other properties of the registered object are preserved. Restored on detach. |

The returned detach function is idempotent: it detaches the observer, restores
`world.register`, removes the entity-gauge callback, and defensively ends any open spans.

### `instrumentModel(model, options?) => Model`

Wraps `generate` (and `stream`, only when the model has one — a missing `stream` is never
added) in a `chat {model}` CLIENT span.

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `provider` | `string` | — | `gen_ai.provider.name`, e.g. `'openai'`. |
| `model` | `string` | `'unknown'` (span name) | `gen_ai.request.model` and the span name. |
| `tracerProvider` | `TracerProvider` | API global | |
| `captureMessageContent` | `boolean` | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true'` | See privacy note below. |

### `instrumentTool(tool, options?) => tool`

Wraps `execute` in an `execute_tool {name}` INTERNAL span. Async results are awaited inside
the span; the wrapped `execute` always returns a `Promise`, even for sync tools. Every other
property of the tool object is preserved.

## Semantic conventions

The GenAI conventions are **Development (incubating)** maturity — attribute names below match
the semconv registry as of v1.36 and are inlined in `src/semconv.ts` (this package deliberately
does not depend on `@opentelemetry/semantic-conventions`, whose incubating entrypoint has no
semver guarantee). Expect possible renames upstream before the conventions stabilize.

**Privacy:** message content (`gen_ai.input.messages` / `gen_ai.output.messages`) is **opt-in**,
following the standard `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` env var or the
`captureMessageContent` option. Captured content is JSON, truncated to 16384 chars. The same
caution applies to `captureChanges` on world spans.

## Span reference

| Span | Kind | Parent | Attributes |
| --- | --- | --- | --- |
| `langecs.run` | INTERNAL | caller's active span | `langecs.world.id`, `langecs.run.id`; on end: `langecs.run.status`, `langecs.run.steps`; status `OK`, or `ERROR` when the run ends `'error'` or rejects at the barrier (rejection also records the exception). |
| `langecs.step` | INTERNAL | run span | `langecs.step.number`, `langecs.scheduled.count`; on apply: `langecs.changes.count`, `langecs.spawned.count`, `langecs.despawned.count`; optional `langecs.change` events. |
| `langecs.system {key}` | INTERNAL | step span | `langecs.system.key`, `langecs.system.name`, `langecs.entity.id`, `langecs.step.number`; on throw: exception event, `error.type`, ERROR status. Guard (`when`) throws produce the same span, synthesized from events (guards are never wrapped, R46). `ctx.emit` data lands as `langecs.emit` events (JSON, 8192-char cap). |
| `chat {model}` | CLIENT | active span | `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`; opt-in `gen_ai.input.messages`/`gen_ai.output.messages`. |
| `execute_tool {name}` | INTERNAL | active span | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`. |

System span names embed the system key (`langecs.system researcher:callLLM`): like HTTP route
names, system keys are a bounded, low-cardinality set.

## Metric reference

| Metric | Instrument | Unit | Attributes |
| --- | --- | --- | --- |
| `langecs.run.duration` | histogram | `s` | `langecs.world.id`, `langecs.run.status` (`error` for barrier rejections) |
| `langecs.step.duration` | histogram | `s` | `langecs.world.id` |
| `langecs.system.duration` | histogram | `s` | `langecs.system.key`, `error` (boolean) |
| `langecs.system.errors` | counter | — | `langecs.system.key` (guard throws included) |
| `langecs.entities` | observable gauge | — | `langecs.world.id` — live `world.query().length` |

Durations are measured with `performance.now()` in the instrumentation callbacks.
