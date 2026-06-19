// LangECS "Easy Mode" tour — a single offline world plus the DevTools inspector,
// landing on the guided 📖 Learn tab.
//
// Run with: pnpm -C examples tour        (no API key needed)
//
// Seeds four exhibits the Learn tab walks through: a greeter chat agent (ECS
// basics), a support agent with a resolved prompt (prompt registry), a scored
// eval case (eval), and a model-comparison bench report (benchmarking). OTel
// forwards run/step/system spans to the inspector so the Traces tab is populated.

import { startDevtools } from '@langecs/devtools';
import { instrumentWorld } from '@langecs/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { buildTourWorld, seedTour } from './world';

const { world, refs } = buildTourWorld();

// 1. Inspector first, so the OTLP exporter can target its /v1/traces receiver.
//    `welcome: true` lands the UI on the guided Learn tab.
const server = await startDevtools(world, { welcome: true });

// 2. Standard OpenTelemetry SDK, exporting to the devtools server.
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'tour' }),
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${server.url}/v1/traces` }), {
      scheduledDelayMillis: 500,
    }),
  ],
});
provider.register();

// 3. Bridge run/step/system events to spans (no model wrapping needed — the
//    greeter model is a constant; the run/step/system waterfall is the point).
const detach = instrumentWorld(world);

// 4. Drive the world so every tab has content (prompt resolved, eval scored,
//    greeter replied).
await seedTour(world, refs);

console.log(`
  LangECS — Easy Mode tour ➜  ${server.url}

  The inspector opens on the 📖 Learn tab — follow the steps with "Show me ▶".
  Exhibits: greeter #${refs.greeter.id} · support #${refs.support.id} · eval #${refs.evalCase.id}.

  No API key needed. Ctrl+C to exit.
`);

const shutdown = async (): Promise<void> => {
  detach();
  await provider.shutdown().catch(() => {});
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
