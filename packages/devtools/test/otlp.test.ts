// decodeOtlpTraces — OTLP/HTTP JSON ExportTraceServiceRequest fixtures.
import { expect, test } from 'vitest';
import { decodeOtlpTraces } from '../src/otlp';

test('decodes a full span: numeric enums, resource/scope, events, nested attrs', () => {
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'demo' } },
            { key: 'process.pid', value: { intValue: 1234 } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: '@langecs/otel', version: '0.1.0' },
            spans: [
              {
                traceId: 'aaaabbbbccccdddd0000111122223333',
                spanId: '0011223344556677',
                parentSpanId: '8899aabbccddeeff',
                name: 'langecs.step',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000500000000',
                attributes: [
                  { key: 'langecs.step', value: { intValue: '7' } },
                  { key: 'ok', value: { boolValue: true } },
                  { key: 'ratio', value: { doubleValue: 0.5 } },
                  {
                    key: 'tags',
                    value: {
                      arrayValue: {
                        values: [{ stringValue: 'a' }, { intValue: 2 }],
                      },
                    },
                  },
                  {
                    key: 'meta',
                    value: {
                      kvlistValue: {
                        values: [{ key: 'inner', value: { stringValue: 'x' } }],
                      },
                    },
                  },
                ],
                status: { code: 2, message: 'boom' },
                events: [
                  {
                    timeUnixNano: '1700000000100000000',
                    name: 'emit',
                    attributes: [{ key: 'data', value: { stringValue: 'tick' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const spans = decodeOtlpTraces(body);
  expect(spans).toHaveLength(1);
  const span = spans[0]!;
  expect(span.traceId).toBe('aaaabbbbccccdddd0000111122223333');
  expect(span.spanId).toBe('0011223344556677');
  expect(span.parentSpanId).toBe('8899aabbccddeeff');
  expect(span.name).toBe('langecs.step');
  expect(span.kind).toBe(1);
  expect(span.startTimeUnixNano).toBe('1700000000000000000');
  expect(span.endTimeUnixNano).toBe('1700000000500000000');
  expect(span.attributes).toEqual({
    'langecs.step': 7, // intValue arrives as string here — decoded to number
    ok: true,
    ratio: 0.5,
    tags: ['a', 2],
    meta: { inner: 'x' },
  });
  expect(span.statusCode).toBe(2);
  expect(span.statusMessage).toBe('boom');
  expect(span.events).toEqual([
    { timeUnixNano: '1700000000100000000', name: 'emit', attributes: { data: 'tick' } },
  ]);
  expect(span.resource).toEqual({ 'service.name': 'demo', 'process.pid': 1234 });
  expect(span.scope).toEqual({ name: '@langecs/otel', version: '0.1.0' });
});

test('decodes string enums and numeric times', () => {
  const spans = decodeOtlpTraces({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't1',
                spanId: 's1',
                name: 'client-span',
                kind: 'SPAN_KIND_CLIENT',
                startTimeUnixNano: 1700000000000000,
                endTimeUnixNano: 1700000000100000,
                status: { code: 'STATUS_CODE_OK' },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({
    kind: 3,
    statusCode: 1,
    startTimeUnixNano: '1700000000000000',
    endTimeUnixNano: '1700000000100000',
  });
  // No parent / no message / no scope → fields omitted, not empty strings.
  expect(spans[0]?.parentSpanId).toBeUndefined();
  expect(spans[0]?.statusMessage).toBeUndefined();
  expect(spans[0]?.scope).toBeUndefined();
});

test('int64 attribute values beyond Number range stay strings', () => {
  const spans = decodeOtlpTraces({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't1',
                spanId: 's1',
                attributes: [{ key: 'big', value: { intValue: '9223372036854775807' } }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(spans[0]?.attributes).toEqual({ big: '9223372036854775807' });
});

test('tolerates legacy instrumentationLibrarySpans', () => {
  const spans = decodeOtlpTraces({
    resourceSpans: [
      {
        instrumentationLibrarySpans: [
          {
            instrumentationLibrary: { name: 'legacy-lib' },
            spans: [{ traceId: 't2', spanId: 's2', name: 'old' }],
          },
        ],
      },
    ],
  });
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({
    traceId: 't2',
    spanId: 's2',
    name: 'old',
    kind: 0,
    statusCode: 0,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
  });
  expect(spans[0]?.scope).toEqual({ name: 'legacy-lib' });
});

test('skips malformed spans, keeps well-formed siblings, never throws', () => {
  const spans = decodeOtlpTraces({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              null,
              42,
              { name: 'no ids at all' },
              { traceId: 't3', name: 'missing spanId' },
              { traceId: '', spanId: 's', name: 'empty traceId' },
              { traceId: 't3', spanId: 's3', name: 'good' },
            ],
          },
          'not an object',
        ],
      },
      null,
    ],
  });
  expect(spans).toHaveLength(1);
  expect(spans[0]?.name).toBe('good');
});

test('garbage top-level input decodes to []', () => {
  expect(decodeOtlpTraces(null)).toEqual([]);
  expect(decodeOtlpTraces(undefined)).toEqual([]);
  expect(decodeOtlpTraces('resourceSpans')).toEqual([]);
  expect(decodeOtlpTraces(123)).toEqual([]);
  expect(decodeOtlpTraces([])).toEqual([]);
  expect(decodeOtlpTraces({})).toEqual([]);
  expect(decodeOtlpTraces({ resourceSpans: 'nope' })).toEqual([]);
  expect(decodeOtlpTraces({ resourceSpans: [{ scopeSpans: [{ spans: {} }] }] })).toEqual([]);
});
