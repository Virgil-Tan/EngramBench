import { ref, obj, arr, one, nil, str, text, bool, int, count, range, uuid, en, page, id, auth, key, q } from '../learning/helpers-a2.mjs';

const inputTime = { type: 'string', format: 'date-time' };
const outputTime = { ...inputTime, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' };
const warehouseCode = { type: 'string', minLength: 2, maxLength: 32, pattern: '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' };
const skuCode = { type: 'string', minLength: 2, maxLength: 64, pattern: '^[A-Z0-9._-]+$' };
const named = maximum => ({ ...text, description: `Trim before applying the public maximum of ${maximum} characters; reject blank values and never truncate.` });
const orderStatus = en('ALLOCATED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED');
const lineInput = obj({ skuId: uuid, quantity: range(1, 1000000) });
const line = obj({ id: uuid, ...lineInput.properties });
const shipment = obj({ id: uuid, shippedAt: outputTime });
const fulfillment = obj({ id: uuid, warehouseId: uuid, status: en('PENDING', 'SHIPPED', 'CANCELLED'), shipment: nil(ref('Shipment')) });
const order = obj({ id: uuid, customerReference: named(100), status: en('ALLOCATED', 'SHIPPED', 'CANCELLED'), lines: arr(ref('OrderLine'), { minItems: 1, maxItems: 8 }), fulfillment: ref('Fulfillment'), createdAt: outputTime, updatedAt: outputTime });
const finalOrder = obj({ ...order.properties, status: orderStatus, fulfillment: nil(ref('Fulfillment')), fulfillments: arr(ref('FulfillmentGroup'), { minItems: 1 }) });
const stock = obj({ warehouseId: uuid, skuId: uuid, onHand: range(0, 1000000000), reserved: range(0, 1000000000), available: range(0, 1000000000), updatedAt: outputTime });
const schemas = {
  JsonValue: { anyOf: [{ type: 'null' }, bool, { type: 'number' }, str, arr(ref('JsonValue')), { type: 'object', additionalProperties: ref('JsonValue') }] },
  Error: obj({ error: obj({ code: text, message: str, details: arr(ref('JsonValue')) }) }),
  Health: obj({ status: { const: 'ok' } }),
  Warehouse: obj({ id: uuid, code: warehouseCode, name: named(120), priority: range(0, 1000000), createdAt: outputTime }),
  Sku: obj({ id: uuid, code: skuCode, name: named(160), createdAt: outputTime }),
  StockPosition: stock, InventoryItem: obj({ ...stock.properties, warehouseCode, skuCode }),
  OrderLine: line, Shipment: shipment, Fulfillment: fulfillment,
  FulfillmentGroup: obj({ ...fulfillment.properties, allocations: arr(lineInput, { minItems: 1, maxItems: 8 }) }),
  LegacyOrder: order, Order: finalOrder, OrderReply: obj({ order: one(ref('LegacyOrder'), ref('Order')) }),
  DomainEvent: one(...[
    ['order.allocated', obj({ orderId: uuid, fulfillmentId: uuid, warehouseId: uuid, lines: arr(lineInput) })],
    ['order.allocated', obj({ orderId: uuid, fulfillments: arr(obj({ fulfillmentId: uuid, warehouseId: uuid, lines: arr(lineInput) })) })],
    ['fulfillment.shipped', obj({ orderId: uuid, fulfillmentId: uuid, warehouseId: uuid, shipmentId: uuid, shippedAt: outputTime })],
    ['order.shipped', obj({ orderId: uuid, fulfillmentId: uuid, warehouseId: uuid, shipmentId: uuid, shippedAt: outputTime })],
    ['order.shipped', obj({ orderId: uuid, fulfillmentIds: arr(uuid), shippedAt: outputTime })],
    ['order.cancelled', obj({ orderId: uuid, fulfillmentId: uuid, warehouseId: uuid, cancelledAt: outputTime })],
    ['order.cancelled', obj({ orderId: uuid, fulfillmentIds: arr(uuid), cancelledAt: outputTime })],
  ].map(([type, data]) => obj({ eventId: uuid, type: { const: type }, aggregateType: { const: 'order' }, aggregateId: uuid, sequence: { ...int, minimum: 1 }, occurredAt: outputTime, data }))),
};
const paging = [q('limit', { ...range(1, 100), default: 20 }), q('cursor', text)];
const invalidId = { status: 400, code: 'INVALID_ID' };
const idQuery = name => ({ ...q(name, uuid), transportError: invalidId });
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[\\x20-\\x7e]+$' }, transportError: { status: 400, code: 'INVALID_IDEMPOTENCY_KEY' }, missingTransportError: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' } };
const administrator = { name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' }, transportError: { status: 401, code: 'ADMIN_AUTH_INVALID' }, missingTransportError: { status: 401, code: 'ADMIN_AUTH_REQUIRED' } };
function operation(name, method, path, status, response, request, example = {}, parameters = [], admin = false) {
  const mutation = !['GET', 'HEAD'].includes(method);
  return { id: name, method, path, status, source: 'docs/frontal-legacy/README.md#6-http-and-openapi-contract', response, ...(request ? { request } : { requestBody: 'none' }), errors: Object.fromEntries([400, 401, 404, 409, 415, 422, 500, 503].map(status => [status, ref('Error')])), parameters: [...[...path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: uuid, transportError: invalidId })), ...(mutation ? [idempotency] : []), ...(admin ? [administrator] : []), ...parameters], example: { ...example, headers: { ...(mutation ? key(name) : {}), ...(admin ? auth : {}), ...example.headers } } };
}
const warehouse = { id: id(301), code: 'PUBLIC-01', name: 'Public warehouse', priority: 10 };
const sku = { id: id(302), code: 'PUBLIC-SKU', name: 'Public parcel item' };
const history = { id: id(303), customerReference: 'public-history', warehouseId: id(301), fulfillmentId: id(304), shipmentId: id(305), lines: [{ id: id(306), skuId: id(302), quantity: 2 }], createdAt: '2026-01-01T00:00:00Z', shippedAt: '2026-01-01T01:00:00Z' };
const operations = [
  operation('health', 'GET', '/api/health', 200, ref('Health')),
  operation('production-ui', 'GET', '/', 200, { type: 'string', contentMediaType: 'text/html' }),
  operation('openapi', 'GET', '/openapi.json', 200, { type: 'object', properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, paths: { type: 'object' } }, required: ['openapi', 'paths'] }),
  operation('create-warehouse', 'POST', '/api/admin/warehouses', 201, obj({ warehouse: ref('Warehouse') }), obj({ code: warehouseCode, name: named(120), priority: range(0, 1000000) }), { body: { code: 'PUBLIC-02', name: 'Public created warehouse', priority: 20 } }, [], true),
  operation('create-sku', 'POST', '/api/admin/skus', 201, obj({ sku: ref('Sku') }), obj({ code: skuCode, name: named(160) }), { body: { code: 'PUBLIC-CREATED', name: 'Public created item' } }, [], true),
  operation('set-inventory', 'PUT', '/api/admin/inventory/:warehouseId/:skuId', 200, obj({ stockPosition: ref('StockPosition') }), obj({ onHand: range(0, 1000000000) }), { params: { warehouseId: id(301), skuId: id(302) }, body: { onHand: 20 } }, [], true),
  operation('list-warehouses', 'GET', '/api/warehouses', 200, page(ref('Warehouse')), undefined, { query: { limit: 20 } }, [q('q', str), ...paging]),
  operation('list-skus', 'GET', '/api/skus', 200, page(ref('Sku')), undefined, { query: { limit: 20 } }, [q('q', str), ...paging]),
  operation('list-inventory', 'GET', '/api/inventory', 200, page(ref('InventoryItem')), undefined, { query: { warehouseId: id(301), skuId: id(302), limit: 20 } }, [q('q', str), idQuery('warehouseId'), idQuery('skuId'), ...paging]),
  operation('create-order', 'POST', '/api/orders', 201, ref('OrderReply'), obj({ customerReference: named(100), lines: arr(lineInput, { minItems: 1, maxItems: 8 }) }), { body: { customerReference: 'public-created-order', lines: [{ skuId: id(302), quantity: 1 }] } }),
  operation('list-orders', 'GET', '/api/orders', 200, page(ref('Order')), undefined, { query: { customerReference: 'public-history', limit: 20 } }, [q('customerReference', str), q('status', orderStatus), idQuery('warehouseId'), ...paging]),
  operation('get-order', 'GET', '/api/orders/:orderId', 200, obj({ order: ref('Order') }), undefined, { params: { orderId: id(303) } }),
  operation('cancel-order', 'POST', '/api/orders/:orderId/cancel', 200, ref('OrderReply'), undefined, { params: { orderId: id(303) } }),
];

export default {
  taskId: 'parcelflow', title: 'ParcelFlow', schemas, operations,
  webhooks: { orderEvent: { post: { summary: 'Outbound event delivery to WEBHOOK_URL', parameters: [{ name: 'Content-Type', in: 'header', required: true, schema: { type: 'string', const: 'application/json' } }, { name: 'X-ParcelFlow-Event-Id', in: 'header', required: true, schema: uuid }, { name: 'X-ParcelFlow-Event-Type', in: 'header', required: true, schema: en('order.allocated', 'fulfillment.shipped', 'order.shipped', 'order.cancelled') }], requestBody: { required: true, content: { 'application/json': { schema: ref('DomainEvent') } } }, responses: { '2XX': { description: 'Acknowledged; every non-2xx response or connection failure is retried according to the original outbox rules.' } } } } },
  commands: ['npm run db:migrate', 'npm run seed -- --file <path>', 'npm run dev', 'npm run build', 'npm start', 'npm run worker', 'npm run dispatcher', 'npm test', ...['unit', 'integration', 'e2e', 'concurrency', 'recovery', 'all', 'perf'].map(name => `npm run test:${name}`)],
  environmentVariables: ['DATABASE_URL', 'TEST_DATABASE_URL', 'PORT', 'ADMIN_TOKEN', 'WEBHOOK_URL', 'WORKER_POLL_INTERVAL_MS', 'DISPATCH_TASK_TIMEOUT_SECONDS', 'OUTBOX_POLL_INTERVAL_MS', 'WEBHOOK_TIMEOUT_MS'],
  transportErrors: { invalidJson: { status: 400, code: 'INVALID_JSON' }, invalidRequest: { status: 422, code: 'VALIDATION_ERROR' }, unknownField: { status: 422, code: 'VALIDATION_ERROR' }, unknownQuery: { status: 422, code: 'VALIDATION_ERROR' }, auth: { status: 401, code: 'ADMIN_AUTH_REQUIRED' } },
  seed: { command: ['npm', 'run', 'seed', '--', '--file', '${SEED_PATH}'], replay: false, schema: obj({ schemaVersion: { const: 1 }, warehouses: arr(obj({ id: uuid, code: warehouseCode, name: named(120), priority: range(0, 1000000) })), skus: arr(obj({ id: uuid, code: skuCode, name: named(160) })), stockPositions: arr(obj({ warehouseId: uuid, skuId: uuid, onHand: range(0, 1000000000) })), orders: arr(obj({ id: uuid, customerReference: named(100), warehouseId: uuid, fulfillmentId: uuid, shipmentId: uuid, lines: arr(line, { minItems: 1, maxItems: 8 }), createdAt: inputTime, shippedAt: inputTime })) }), example: { schemaVersion: 1, warehouses: [warehouse], skus: [sku], stockPositions: [{ warehouseId: id(301), skuId: id(302), onHand: 20 }], orders: [history] } },
  smoke: [
    { operationId: 'health', expectStatus: 200, expectBody: { status: 'ok' } },
    { operationId: 'openapi', expectStatus: 200 },
    { operationId: 'list-inventory', query: { warehouseId: id(301), skuId: id(302) }, expectStatus: 200, expectContains: [{ path: ['items'], match: { warehouseId: id(301), skuId: id(302), onHand: 20, reserved: 0, available: 20 } }] },
    { operationId: 'get-order', params: { orderId: id(303) }, expectStatus: 200, expectBody: { order: { id: id(303), customerReference: 'public-history', status: 'SHIPPED' } } },
    { operationId: 'create-order', body: { customerReference: 'public-new-order', lines: [{ skuId: id(302), quantity: 1 }] }, headers: key('new-order'), expectStatus: 201, capture: { orderId: ['order', 'id'] } },
    { operationId: 'cancel-order', params: { orderId: '${orderId}' }, headers: key('cancel-order'), expectStatus: 200, expectBody: { order: { id: '${orderId}', status: 'CANCELLED' } } },
    { operationId: 'get-order', params: { orderId: '${orderId}' }, expectStatus: 200, expectBody: { order: { id: '${orderId}', customerReference: 'public-new-order', status: 'CANCELLED' } } },
    { operationId: 'list-orders', query: { customerReference: 'public-new-order' }, expectStatus: 200, expectContains: [{ path: ['items'], match: { id: '${orderId}', status: 'CANCELLED' } }] },
  ],
  notes: [
    'Authority is the complete original README plus the preserved Manager requirement. The original commands, public query surfaces, domain errors, seed import scale, conservation, race, outbox, UI and performance requirements remain unchanged. No synthetic verification snapshot or seed-only business API is introduced.',
    'V2 public wire clarification: canonical /openapi.json is generated from this contract; the originally required openapi.yaml uses the same canonical document serialized as JSON-compatible YAML 1.2 (JSON text is valid YAML 1.2), including outbound webhook body and header schemas. Both representations preserve the author operation schemas, parameters and statuses. Error details is a JSON array; input timestamps accept explicit RFC 3339 offsets, output timestamps are UTC Z. Names and customer references are trimmed, then checked against their documented length limits.',
    'V2 Manager wire clarification: new Order reads include fulfillments, each {id,warehouseId,status,shipment,allocations:[{skuId,quantity}]}. Allocations expose the per-group quantities needed by the Manager UI and sort by skuId; groups sort by warehouse priority then warehouseId. The singular fulfillment remains exactly the V1 shape for one group and null for split orders. Saved V1 mutation replies remain valid without the added field.',
    'V2 Manager event clarification: previously committed V1 events and replay bodies stay unchanged. New single-warehouse orders keep their V1 order.allocated and order.cancelled payloads. Split order.allocated data is {orderId,fulfillments:[{fulfillmentId,warehouseId,lines:[{skuId,quantity}]}]}; split order.cancelled data is {orderId,fulfillmentIds,cancelledAt}. Every newly completed group emits fulfillment.shipped with the V1 shipment data shape; the final split order.shipped data is {orderId,fulfillmentIds,shippedAt}, while a single-warehouse terminal order.shipped keeps its V1 data. Group ID arrays preserve the published group order; all new event sequences are contiguous per order. Immutable prior events are not rewritten.',
    'Idempotency-Key and administrator Authorization distinguish absent from malformed parameters through missingTransportError and transportError. Invalid path and exact-ID filter values use INVALID_ID; an invalid or stale opaque cursor remains a business INVALID_CURSOR. Actual Bearer token comparison remains implementation-owned.',
    'The nonempty public seed links warehouse, SKU, current stock and a historical shipped order with its line, fulfillment and shipment. It imports only into an empty database once, emits the exact summary and no historical Work/events, and does not decrement the already-current onHand quantity. No Manager-only seed fields are added.',
    'The public smoke reads imported inventory/history and creates, cancels and rereads a fresh captured order without starting a worker. Full worker shipping, split allocation, concurrent cancellation, webhook delivery and recovery remain mandatory hidden/project-owned verification, not certified by this smoke.',
  ],
};
