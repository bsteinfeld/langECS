// OTLP/HTTP JSON decoder for `POST /v1/traces` — turns an
// ExportTraceServiceRequest into flat `SpanRecord`s for the UI's waterfall.
//
// Defensive by design: exporters disagree on enum encoding (numbers vs
// `SPAN_KIND_*` strings), int64 encoding (string vs number), and old SDKs
// still send `instrumentationLibrarySpans`. Weird input never throws —
// malformed spans are skipped, missing fields get sensible defaults.

import type { SpanRecord } from './protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** int64s arrive as string or number; keep precision by preferring strings. */
function decodeUnixNano(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '0';
}

function decodeInt(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    // Out-of-range int64s stay strings rather than losing precision.
    return Number.isSafeInteger(n) ? n : value;
  }
  return null;
}

/** OTLP AnyValue → plain JSON, recursively. */
function decodeAnyValue(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('intValue' in value) return decodeInt(value.intValue);
  if ('doubleValue' in value) {
    const n = Number(value.doubleValue);
    return Number.isFinite(n) ? n : null;
  }
  if (isRecord(value.arrayValue)) {
    return asArray(value.arrayValue.values).map(decodeAnyValue);
  }
  if (isRecord(value.kvlistValue)) {
    return decodeKeyValues(value.kvlistValue.values);
  }
  if ('bytesValue' in value) return value.bytesValue ?? null;
  return null;
}

/** OTLP KeyValue[] → flat record (later duplicate keys win). */
function decodeKeyValues(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of asArray(list)) {
    if (!isRecord(item) || typeof item.key !== 'string') continue;
    out[item.key] = decodeAnyValue(item.value);
  }
  return out;
}

const SPAN_KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

const STATUS_CODES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function decodeEnum(value: unknown, names: Record<string, number>): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return names[value] ?? 0;
  return 0;
}

function decodeEvents(list: unknown): SpanRecord['events'] {
  const out: SpanRecord['events'] = [];
  for (const item of asArray(list)) {
    if (!isRecord(item)) continue;
    out.push({
      timeUnixNano: decodeUnixNano(item.timeUnixNano),
      name: typeof item.name === 'string' ? item.name : '',
      attributes: decodeKeyValues(item.attributes),
    });
  }
  return out;
}

function decodeSpan(
  raw: unknown,
  resource: Record<string, unknown>,
  scope: SpanRecord['scope'],
): SpanRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const traceId = raw.traceId;
  const spanId = raw.spanId;
  // Ids are opaque strings on the wire (hex per the OTLP/JSON spec); a span
  // without both is unrenderable — skip it.
  if (typeof traceId !== 'string' || traceId === '') return undefined;
  if (typeof spanId !== 'string' || spanId === '') return undefined;

  const record: SpanRecord = {
    traceId,
    spanId,
    name: typeof raw.name === 'string' ? raw.name : '',
    kind: decodeEnum(raw.kind, SPAN_KINDS),
    startTimeUnixNano: decodeUnixNano(raw.startTimeUnixNano),
    endTimeUnixNano: decodeUnixNano(raw.endTimeUnixNano),
    attributes: decodeKeyValues(raw.attributes),
    statusCode: isRecord(raw.status) ? decodeEnum(raw.status.code, STATUS_CODES) : 0,
    events: decodeEvents(raw.events),
    resource,
  };
  if (typeof raw.parentSpanId === 'string' && raw.parentSpanId !== '') {
    record.parentSpanId = raw.parentSpanId;
  }
  if (isRecord(raw.status) && typeof raw.status.message === 'string' && raw.status.message !== '') {
    record.statusMessage = raw.status.message;
  }
  if (scope) record.scope = scope;
  return record;
}

function decodeScope(raw: unknown): SpanRecord['scope'] {
  if (!isRecord(raw) || typeof raw.name !== 'string') return undefined;
  const scope: SpanRecord['scope'] = { name: raw.name };
  if (typeof raw.version === 'string') scope.version = raw.version;
  return scope;
}

/**
 * Decodes an OTLP/HTTP JSON `ExportTraceServiceRequest` body into flat
 * `SpanRecord`s. Never throws; malformed pieces are skipped.
 */
export function decodeOtlpTraces(body: unknown): SpanRecord[] {
  if (!isRecord(body)) return [];
  const out: SpanRecord[] = [];
  for (const rs of asArray(body.resourceSpans)) {
    if (!isRecord(rs)) continue;
    const resource = isRecord(rs.resource) ? decodeKeyValues(rs.resource.attributes) : {};
    // Old SDKs send `instrumentationLibrarySpans`; same shape, older name.
    const scopeSpans = rs.scopeSpans !== undefined ? rs.scopeSpans : rs.instrumentationLibrarySpans;
    for (const ss of asArray(scopeSpans)) {
      if (!isRecord(ss)) continue;
      const scope = decodeScope(ss.scope !== undefined ? ss.scope : ss.instrumentationLibrary);
      for (const raw of asArray(ss.spans)) {
        const span = decodeSpan(raw, resource, scope);
        if (span) out.push(span);
      }
    }
  }
  return out;
}
