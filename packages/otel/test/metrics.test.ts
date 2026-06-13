// Metrics smoke test: langecs.system.duration is recorded with the system key.

import { createWorld, defineComponent, defineSystem, defineTag, Not } from '@langecs/core';
import {
  AggregationTemporality,
  type HistogramMetricData,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { instrumentWorld } from '../src/index';

const MetricDoc = defineComponent<string>({ name: 'otxMetricDoc' });
const MetricDone = defineTag('otxMetricDone');

test('langecs.system.duration histogram records one execution with the system key', async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000, // never fires in-test; we collect manually
  });
  const meterProvider = new MeterProvider({ readers: [reader] });

  const world = createWorld({ id: 'otx-metrics' });
  world.use(
    defineSystem({
      name: 'otxMetricFinish',
      query: [MetricDoc, Not(MetricDone)],
      run: (e) => {
        e.add(MetricDone);
      },
    }),
  );
  world.spawn(MetricDoc('x'));

  const detach = instrumentWorld(world, { tracerProvider, meterProvider });
  await world.run();

  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toHaveLength(0);
  const scope = resourceMetrics.scopeMetrics.find((s) => s.scope.name === '@langecs/otel');
  expect(scope).toBeDefined();
  const metric = scope?.metrics.find((m) => m.descriptor.name === 'langecs.system.duration') as
    | HistogramMetricData
    | undefined;
  expect(metric).toBeDefined();
  expect(metric?.descriptor.unit).toBe('s');
  const point = metric?.dataPoints.find(
    (p) => p.attributes['langecs.system.key'] === 'otxMetricFinish',
  );
  expect(point).toBeDefined();
  expect(point?.attributes.error).toBe(false);
  expect(point?.value.count).toBe(1);

  // The entity gauge observes the live world.
  const gauge = scope?.metrics.find((m) => m.descriptor.name === 'langecs.entities');
  expect(gauge?.dataPoints[0]?.value).toBe(1);

  detach();
  await meterProvider.shutdown();
});
