/**
 * Local OTLP/JSON envelope → OTLP/Protobuf encoder.
 *
 * Many OTLP HTTP receivers (notably Arize Phoenix) only accept
 * `application/x-protobuf` at `/v1/traces` and reject `application/json` with
 * HTTP 415 — even though the OTLP spec permits both. To stay compatible with
 * those receivers we transform our locally-stored ResourceSpans envelopes
 * (JSON shape) into the OpenTelemetry trace.proto wire format.
 *
 * Schema source: github.com/open-telemetry/opentelemetry-proto, packages
 * `opentelemetry/proto/{common,resource,trace}/v1`. Embedded inline below
 * to avoid pulling the upstream proto files at runtime — this is a stable
 * v1 schema and updates are rare.
 *
 * Conversion notes:
 *   - traceId / spanId / parentSpanId are hex strings in JSON, raw bytes in proto
 *   - *_unix_nano are decimal strings in JSON, fixed64 in proto (protobufjs
 *     accepts string inputs for fixed64)
 *   - kind / status.code are already integers in JSON
 *   - Our JSONL adds `_humanStartTime` / `_humanEndTime` for grep workflows;
 *     protobufjs ignores unknown fields by default
 */

import protobuf from 'protobufjs'

/** OpenTelemetry trace.proto v1 — minimal subset we actually emit. */
const PROTO_SCHEMA = `
syntax = "proto3";
package opentelemetry.proto.trace.v1;

message TracesData {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  uint32 flags = 16;
  string name = 5;
  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
}

message Event {
  fixed64 time_unix_nano = 1;
  string name = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  repeated KeyValue attributes = 4;
  uint32 dropped_attributes_count = 5;
  uint32 flags = 6;
}

message Status {
  string message = 2;
  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
  StatusCode code = 3;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}
`

const root = protobuf.parse(PROTO_SCHEMA).root
const TracesData = root.lookupType('opentelemetry.proto.trace.v1.TracesData')

/**
 * Convert a decimal-string nanosecond timestamp into the form protobufjs's
 * `verify()` accepts for fixed64 fields. Returns a Long instance built from
 * the high/low 32-bit halves of the nanosecond value.
 */
function nanoToLong(nanoStr: string): protobuf.util.Long {
  const big = BigInt(nanoStr)
  const low = Number(big & 0xffffffffn)
  const high = Number((big >> 32n) & 0xffffffffn)
  return protobuf.util.Long.fromBits(low | 0, high | 0, true /* unsigned */)
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array(0)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

interface JsonAttrValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values: JsonAttrValue[] }
  kvlistValue?: { values: JsonAttribute[] }
  bytesValue?: string
}

interface JsonAttribute {
  key: string
  value: JsonAttrValue
}

interface JsonSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  traceState?: string
  flags?: number
  name: string
  kind?: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: JsonAttribute[]
  droppedAttributesCount?: number
  events?: Array<{ timeUnixNano: string; name: string; attributes?: JsonAttribute[]; droppedAttributesCount?: number }>
  droppedEventsCount?: number
  links?: Array<{ traceId: string; spanId: string; traceState?: string; attributes?: JsonAttribute[]; droppedAttributesCount?: number }>
  droppedLinksCount?: number
  status?: { code?: number; message?: string }
}

interface JsonScopeSpans {
  scope?: { name?: string; version?: string; attributes?: JsonAttribute[]; droppedAttributesCount?: number }
  spans?: JsonSpan[]
  schemaUrl?: string
}

interface JsonResourceSpans {
  resource?: { attributes?: JsonAttribute[]; droppedAttributesCount?: number }
  scopeSpans?: JsonScopeSpans[]
  schemaUrl?: string
}

function transformAttribute(a: JsonAttribute): unknown {
  // Our JSON shape uses { stringValue: '...' } etc. The proto AnyValue is a oneof
  // with fields named string_value/int_value/etc. protobufjs accepts camelCase
  // keys mapped to snake_case proto fields automatically.
  const v = a.value ?? {}
  const out: Record<string, unknown> = {}
  if (typeof v.stringValue === 'string') out.stringValue = v.stringValue
  else if (v.intValue !== undefined) {
    // OTLP int_value is int64. protobufjs's verify rejects raw strings/numbers
    // here for some shapes; build a Long for safety.
    const big = BigInt(v.intValue)
    const low = Number(big & 0xffffffffn)
    const high = Number((big >> 32n) & 0xffffffffn)
    out.intValue = protobuf.util.Long.fromBits(low | 0, high | 0, false /* signed int64 */)
  }
  else if (typeof v.doubleValue === 'number') out.doubleValue = v.doubleValue
  else if (typeof v.boolValue === 'boolean') out.boolValue = v.boolValue
  else if (v.arrayValue) {
    out.arrayValue = {
      values: (v.arrayValue.values ?? []).map((vv) => transformAttribute({ key: '', value: vv } as JsonAttribute) as { value: unknown }).map((x) => (x as { value: unknown }).value ?? x)
    }
  } else if (v.bytesValue) {
    out.bytesValue = hexToBytes(v.bytesValue)
  }
  return { key: a.key, value: out }
}

function transformSpan(s: JsonSpan): unknown {
  return {
    traceId: hexToBytes(s.traceId),
    spanId: hexToBytes(s.spanId),
    parentSpanId: s.parentSpanId ? hexToBytes(s.parentSpanId) : undefined,
    traceState: s.traceState,
    flags: s.flags,
    name: s.name,
    kind: s.kind ?? 0,
    startTimeUnixNano: nanoToLong(s.startTimeUnixNano),
    endTimeUnixNano: nanoToLong(s.endTimeUnixNano),
    attributes: (s.attributes ?? []).map(transformAttribute),
    droppedAttributesCount: s.droppedAttributesCount ?? 0,
    events: (s.events ?? []).map((e) => ({
      timeUnixNano: nanoToLong(e.timeUnixNano),
      name: e.name,
      attributes: (e.attributes ?? []).map(transformAttribute),
      droppedAttributesCount: e.droppedAttributesCount ?? 0
    })),
    droppedEventsCount: s.droppedEventsCount ?? 0,
    links: (s.links ?? []).map((l) => ({
      traceId: hexToBytes(l.traceId),
      spanId: hexToBytes(l.spanId),
      traceState: l.traceState,
      attributes: (l.attributes ?? []).map(transformAttribute),
      droppedAttributesCount: l.droppedAttributesCount ?? 0
    })),
    droppedLinksCount: s.droppedLinksCount ?? 0,
    status: s.status ? { code: s.status.code ?? 0, message: s.status.message } : undefined
  }
}

function transformResourceSpans(rs: JsonResourceSpans): unknown {
  return {
    resource: rs.resource
      ? {
          attributes: (rs.resource.attributes ?? []).map(transformAttribute),
          droppedAttributesCount: rs.resource.droppedAttributesCount ?? 0
        }
      : undefined,
    scopeSpans: (rs.scopeSpans ?? []).map((ss) => ({
      scope: ss.scope
        ? {
            name: ss.scope.name ?? '',
            version: ss.scope.version ?? '',
            attributes: (ss.scope.attributes ?? []).map(transformAttribute),
            droppedAttributesCount: ss.scope.droppedAttributesCount ?? 0
          }
        : undefined,
      spans: (ss.spans ?? []).map(transformSpan),
      schemaUrl: ss.schemaUrl ?? ''
    })),
    schemaUrl: rs.schemaUrl ?? ''
  }
}

/**
 * Encode a list of OTLP/JSON ResourceSpans envelopes into a single
 * `TracesData` protobuf message and return the wire bytes. Caller POSTs
 * with `Content-Type: application/x-protobuf`.
 */
export function encodeTracesProto(envelopes: JsonResourceSpans[]): Uint8Array {
  const message = TracesData.create({
    resourceSpans: envelopes.map(transformResourceSpans)
  })
  const err = TracesData.verify(message)
  if (err) throw new Error(`OTLP proto verification failed: ${err}`)
  return TracesData.encode(message).finish()
}
