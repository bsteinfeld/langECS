// LangECS DevTools demo — a live, inspectable world.
//
// Run with: pnpm -C examples devtools-demo     (no API key needed)
//
// What it wires together:
//   - @langecs/devtools: the inspector GUI (entities, systems, timeline,
//     interrupts, time travel) served locally, speaking a WebSocket protocol.
//   - @langecs/otel: standards-based OpenTelemetry instrumentation — run/step/
//     system spans plus GenAI-semconv model & tool spans.
//   - A standard OTel NodeTracerProvider exporting OTLP/HTTP JSON straight to
//     the devtools server's /v1/traces receiver (any other OTLP backend —
//     Jaeger, Grafana, Honeycomb — could be added as a second processor).
//
// The world starts with a refund request parked on a human-approval interrupt:
// open the Interrupts tab and approve it with {"approved": true}.

import { openai } from '@ai-sdk/openai';
import { fromAiSdk } from '@langecs/ai-sdk';
import { startDevtools } from '@langecs/devtools';
import { instrumentModel, instrumentWorld } from '@langecs/otel';
import { registerTools, sendMessage } from '@langecs/stdlib';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { loadEnvLocal } from '../_shared/env';
import { createDemoWorld, demoTools, Jobs, MODEL_RESOURCE, policyModel } from './world';

loadEnvLocal();
const useRealModel = process.env.OPENAI_API_KEY !== undefined;

const { world, adapter, support, worker } = createDemoWorld();

// 1. Inspector first, so the OTLP exporter can target its /v1/traces receiver.
const server = await startDevtools(world, { history: adapter });

// 2. Standard OpenTelemetry SDK setup, exporting to the devtools server.
//    provider.register() installs the global tracer provider AND an async
//    context manager — which is what lets model/tool spans nest under the
//    system span that called them.
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'devtools-demo' }),
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${server.url}/v1/traces` }), {
      scheduledDelayMillis: 500, // snappy trace view
    }),
  ],
});
provider.register();

// 3. Instrument the world. Resources registered AFTER this are auto-wrapped:
//    Model-likes get GenAI `chat` spans, `tool:` resources get `execute_tool`
//    spans. (For explicit control, wrap with instrumentModel/instrumentTool
//    and pass wrapResources: false.)
const detach = instrumentWorld(world);

registerTools(world, demoTools);
world.register(
  MODEL_RESOURCE,
  useRealModel
    ? instrumentModel(fromAiSdk(openai('gpt-4o-mini')), {
        provider: 'openai',
        model: 'gpt-4o-mini',
      })
    : policyModel(),
);

// 4. Seed some history so every panel has something to show.
console.log(`model: ${useRealModel ? 'OpenAI gpt-4o-mini' : 'deterministic policy model'}`);
console.log('seeding: worker job (fails once, retry heals it)...');
const jobRun = await world.send(worker, Jobs(['index-knowledge-base']));
console.log(`  worker run: ${jobRun.status} after ${jobRun.steps} step(s)`);

console.log('seeding: refund request (parks on a human-approval interrupt)...');
const refundRun = await sendMessage(
  world,
  support,
  'Please refund order #1042 — it arrived broken.',
);
console.log(`  support run: ${refundRun.status} after ${refundRun.steps} step(s)`);

console.log(`
  LangECS DevTools ➜  ${server.url}

  Things to try:
    • Interrupts tab — approve the pending refund with {"approved": true}
      (or deny it with {"approved": false, "reason": "warranty expired"}).
    • Inspector — open the support agent (#${support.id}): chat transcript,
      send another message, edit OrderBook on the data entity.
    • Systems — queries, matched entities, pending (dirty) pairs.
    • Timeline — the flight recorder: watch the retry heal processJobs.
    • Traces — OTel spans (OTLP/HTTP JSON): runs → steps → systems → chat/tool.
    • Time travel — restore an earlier step, then re-run from there.

  Ctrl+C to exit.
`);

const shutdown = async (): Promise<void> => {
  detach();
  await provider.shutdown().catch(() => {});
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
