/**
 * Tests for the OTLP/JSON → OTLP/Protobuf encoder.
 *
 * Verifies the encoded bytes round-trip through the same proto schema and
 * preserve the fields receivers care about (traceId / spanId hex bytes,
 * timestamps, attributes, status, events).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import { encodeTracesProto } from '../proto.js'

function envelope(spanName: string, traceIdHex = 'a'.repeat(32), spanIdHex = 'b'.repeat(16)): unknown {
  return {
    schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
    resource: {
      attributes: [{ key: 'service.name', value: { stringValue: 'research-copilot' } }]
    },
    scopeSpans: [
      {
        scope: { name: 'pipilot', version: '0.0.0' },
        schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
        spans: [
          {
            traceId: traceIdHex,
            spanId: spanIdHex,
            name: spanName,
            kind: 3,
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '2000000000',
            attributes: [
              { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
              { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
              { key: 'gen_ai.usage.output_tokens', value: { intValue: '50' } }
            ],
            events: [
              { timeUnixNano: '1500000000', name: 'gen_ai.client.inference.operation.details', attributes: [] }
            ],
            status: { code: 1 }
          }
        ]
      }
    ]
  }
}

// Embedded version of the schema for round-trip decode in this test.
const SCHEMA = `
syntax = "proto3";
package opentelemetry.proto.trace.v1;
message TracesData { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; uint32 flags = 16;
  string name = 5;
  enum SpanKind { SPAN_KIND_UNSPECIFIED = 0; SPAN_KIND_INTERNAL = 1; SPAN_KIND_SERVER = 2; SPAN_KIND_CLIENT = 3; SPAN_KIND_PRODUCER = 4; SPAN_KIND_CONSUMER = 5; }
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10;
  repeated Event events = 11; uint32 dropped_events_count = 12;
  repeated Link links = 13; uint32 dropped_links_count = 14;
  Status status = 15;
}
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; uint32 flags = 6; }
message Status { string message = 2; enum StatusCode { STATUS_CODE_UNSET = 0; STATUS_CODE_OK = 1; STATUS_CODE_ERROR = 2; } StatusCode code = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`
const decoder = protobuf.parse(SCHEMA).root.lookupType('opentelemetry.proto.trace.v1.TracesData')

test('encodeTracesProto produces non-empty bytes', () => {
  const bytes = encodeTracesProto([envelope('chat foo')] as any)
  assert.ok(bytes instanceof Uint8Array)
  assert.ok(bytes.length > 0)
})

test('encoded message round-trips with traceId/spanId as raw bytes', () => {
  const traceHex = '0123456789abcdef0123456789abcdef'
  const spanHex = 'fedcba9876543210'
  const bytes = encodeTracesProto([envelope('chat round-trip', traceHex, spanHex)] as any)
  const decoded = decoder.decode(bytes) as any
  const span = decoded.resourceSpans[0].scopeSpans[0].spans[0]
  // Convert decoded bytes back to hex.
  const traceBytes = span.traceId as Uint8Array
  const spanBytes = span.spanId as Uint8Array
  const toHex = (b: Uint8Array): string =>
    Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
  assert.equal(toHex(traceBytes), traceHex)
  assert.equal(toHex(spanBytes), spanHex)
  assert.equal(span.name, 'chat round-trip')
  assert.equal(span.kind, 3)
})

test('attributes preserve types (string / int / bool / double)', () => {
  const env: any = envelope('attr-types')
  env.scopeSpans[0].spans[0].attributes = [
    { key: 's', value: { stringValue: 'hello' } },
    { key: 'i', value: { intValue: '42' } },
    { key: 'b', value: { boolValue: true } },
    { key: 'd', value: { doubleValue: 3.14 } }
  ]
  const bytes = encodeTracesProto([env])
  const decoded = decoder.decode(bytes) as any
  const attrs = decoded.resourceSpans[0].scopeSpans[0].spans[0].attributes as Array<any>
  const find = (k: string) => attrs.find((a) => a.key === k)
  assert.equal(find('s').value.stringValue, 'hello')
  // protobufjs decodes int64 as a Long object by default; toString() works.
  assert.equal(find('i').value.intValue.toString(), '42')
  assert.equal(find('b').value.boolValue, true)
  assert.ok(Math.abs(find('d').value.doubleValue - 3.14) < 1e-9)
})

test('events array round-trips with time and name', () => {
  const bytes = encodeTracesProto([envelope('with-events')] as any)
  const decoded = decoder.decode(bytes) as any
  const events = decoded.resourceSpans[0].scopeSpans[0].spans[0].events as Array<any>
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'gen_ai.client.inference.operation.details')
  assert.equal(events[0].timeUnixNano.toString(), '1500000000')
})

test('status code is preserved (OK)', () => {
  const bytes = encodeTracesProto([envelope('with-status')] as any)
  const decoded = decoder.decode(bytes) as any
  const status = decoded.resourceSpans[0].scopeSpans[0].spans[0].status
  assert.equal(status.code, 1) // OK
})

test('multiple envelopes encode into a single TracesData', () => {
  const bytes = encodeTracesProto([
    envelope('a', '1'.repeat(32)),
    envelope('b', '2'.repeat(32)),
    envelope('c', '3'.repeat(32))
  ] as any)
  const decoded = decoder.decode(bytes) as any
  assert.equal(decoded.resourceSpans.length, 3)
})

test('parentSpanId hex is converted to bytes when present', () => {
  const env: any = envelope('with-parent')
  env.scopeSpans[0].spans[0].parentSpanId = 'aabbccddeeff0011'
  const bytes = encodeTracesProto([env])
  const decoded = decoder.decode(bytes) as any
  const parent = decoded.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId as Uint8Array
  assert.ok(parent && parent.length === 8)
  const toHex = Array.from(parent).map((x) => x.toString(16).padStart(2, '0')).join('')
  assert.equal(toHex, 'aabbccddeeff0011')
})
