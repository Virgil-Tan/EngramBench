import { readFileSync } from 'node:fs';

const publicSource = 'docs/frontal-legacy/README.md';
const managerSource = 'docs/frontal-legacy/manager-requirements.md';
const wireSource = 'contract/README.md (V2 wire clarification)';
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const array = (items = {}) => ({ type: 'array', items });
const string = { type: 'string' };
const integer = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const nonnegative = { ...integer, minimum: 0 };
const positive = { ...integer, minimum: 1 };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const enumOf = (...values) => ({ type: 'string', enum: values });
const json = ref('JsonValue');
const id = ref('Uuid');
const date = ref('UtcTimestamp');
const money = ref('MinorUnits');
const currency = ref('Currency');
const outcomes = { type: 'string', enum: ['CAPTURED', 'DECLINED', 'UNKNOWN'] };
const orderProperties = {
  orderId: id, tenantId: id, buyerId: id,
  channel: { type: 'string', enum: ['WEB', 'STORE', 'PARTNER'] }, currency,
  state: { type: 'string', enum: ['QUOTED', 'PAYMENT_PENDING', 'PAID', 'FULFILLING', 'FULFILLED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
  orderTotalMinor: money, capturedMinor: money, refundedMinor: money, quoteExpiresAt: date,
};
const orderLineProperties = {
  orderLineId: id, tenantId: id, orderId: id, productId: id, offerVersionId: id,
  quantity: integer, currency, unitPriceMinor: money, taxMinor: money,
  lineTotalMinor: money, fulfillmentKind: ref('ProductKind'),
};
const resourceNames = [
  'tenants', 'buyers', 'products', 'offerVersions', 'inventoryPools',
  'orders', 'orderLines', 'inventoryHolds', 'paymentAttempts',
  'fulfillmentPlans', 'entitlementGrants', 'ledgerEntries',
  'notificationDeliveries',
];
const resourceSchemas = {
  tenants: ref('Tenant'), buyers: ref('Buyer'), products: ref('Product'),
  offerVersions: ref('OfferVersion'), inventoryPools: ref('InventoryPool'),
  orders: ref('Order'), orderLines: ref('OrderLine'), inventoryHolds: ref('InventoryHold'),
  paymentAttempts: ref('PaymentAttempt'), fulfillmentPlans: ref('FulfillmentPlan'),
  entitlementGrants: ref('EntitlementGrant'), ledgerEntries: ref('LedgerEntry'),
  notificationDeliveries: ref('NotificationDelivery'),
};
const resources = Object.fromEntries(resourceNames.map((name) => [name, array(resourceSchemas[name])]));
const managerResources = Object.fromEntries(Object.entries({ sellers: 'Seller', sellerAllocations: 'SellerAllocation', sellerSettlements: 'SellerSettlement', commerceDisputes: 'CommerceDispute', settlementAdjustments: 'SettlementAdjustment', refunds: 'Refund' }).map(([name, schema]) => [name, array(ref(schema))]));
const seedIds = {
  tenantId: '20000000-0000-4000-8000-000000000001',
  buyerId: '20000000-0000-4000-8000-000000000002',
  productId: '20000000-0000-4000-8000-000000000003',
  offerVersionId: '20000000-0000-4000-8000-000000000004',
  inventoryPoolId: '20000000-0000-4000-8000-000000000005',
  sellerId: '20000000-0000-4000-8000-000000000006',
  orderId: '20000000-0000-4000-8000-000000000007',
  orderLineId: '20000000-0000-4000-8000-000000000008',
  paymentAttemptId: '20000000-0000-4000-8000-000000000009',
  sellerSettlementId: '20000000-0000-4000-8000-000000000010',
  sellerAllocationId: '20000000-0000-4000-8000-000000000011',
};
const seedResources = {
  ...Object.fromEntries(resourceNames.map((name) => [name, []])),
  tenants: [{ tenantId: seedIds.tenantId, name: 'Contract tenant' }],
  buyers: [{ buyerId: seedIds.buyerId, tenantId: seedIds.tenantId, displayName: 'Contract buyer' }],
  products: [{ productId: seedIds.productId, tenantId: seedIds.tenantId, sku: 'PUBLIC-QUOTE-ITEM', name: 'Contract physical item', kind: 'PHYSICAL' }],
  offerVersions: [{
    offerVersionId: seedIds.offerVersionId, tenantId: seedIds.tenantId, productId: seedIds.productId,
    version: 1, currency: 'USD', unitPriceMinor: 400, taxMinor: 40, fulfillmentKind: 'PHYSICAL',
    effectiveFrom: '2020-01-01T00:00:00Z', effectiveUntil: '2099-12-31T23:59:59Z', state: 'ACTIVE',
  }],
  inventoryPools: [{
    inventoryPoolId: seedIds.inventoryPoolId, tenantId: seedIds.tenantId,
    productId: seedIds.productId, priority: 1, onHand: 5, reserved: 0,
  }],
};
const quoteBody = {
  tenantId: seedIds.tenantId, buyerId: seedIds.buyerId, channel: 'WEB',
  lines: [{ productId: seedIds.productId, quantity: 2 }], holdTtlSeconds: 3600,
};
const quotedOrder = {
  orderId: '${orderId}', tenantId: seedIds.tenantId, buyerId: seedIds.buyerId,
  channel: 'WEB', currency: 'USD', state: 'QUOTED', orderTotalMinor: 880,
  capturedMinor: 0, refundedMinor: 0, quoteExpiresAt: '${quoteExpiresAt}',
};
const frozenLine = {
  orderLineId: '${orderLineId}', tenantId: seedIds.tenantId, orderId: '${orderId}',
  productId: seedIds.productId, offerVersionId: seedIds.offerVersionId, quantity: 2,
  currency: 'USD', unitPriceMinor: 400, taxMinor: 40, lineTotalMinor: 880, fulfillmentKind: 'PHYSICAL',
};
const heldInventory = {
  tenantId: seedIds.tenantId, orderLineId: '${orderLineId}',
  inventoryPoolId: seedIds.inventoryPoolId, quantity: 2, state: 'HELD',
};
const operation = (id, method, path, section, contract = {}) => ({
  id, method, path, status: 200, source: `${publicSource}#${section}`, ...contract,
});
const managerOperation = (id, path, request) => ({
  id, method: 'POST', path, request: ref(request), status: 200,
  source: managerSource,
});

const contract = {
  taskId: 'commercecommand',
  transportErrors: Object.fromEntries(['invalidRequest', 'unknownField', 'unknownQuery'].map(kind => [kind, { status: 400, code: 'VALIDATION_ERROR' }]).concat([
    ['unknownRoute', { status: 404, code: 'RESOURCE_NOT_FOUND' }],
    ['invalidJson', { status: 400, code: 'MALFORMED_JSON' }],
    ['auth', { status: 401, code: 'UNAUTHORIZED' }],
    ['unsupportedMediaType', { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }],
  ])),
  title: 'CommerceCommand',
  environmentVariables: [
    'DATABASE_URL', 'PORT', 'ADMIN_TOKEN', 'WEBHOOK_URL',
    'WORK_LEASE_SECONDS', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN',
    'BENCH_PERF_SCALE',
  ],
  commands: [
    'npm install --no-audit --no-fund',
    'npm run build',
    'npm run db:migrate',
    'npm run db:seed -- --file /absolute/path/seed.json',
    'npm run start:api',
    'npm run start:worker',
    'npm run start:dispatcher',
    'npm run test:unit',
    'npm run test:integration',
    'npm run test:e2e',
    'npm run test:concurrency',
    'npm run test:recovery',
    'npm run test:perf',
    'npm run test:all',
  ],
  seed: {
    schema: ref('Seed'),
    example: { schemaVersion: 1, seedVersion: 'public-commercecommand-v2', ...seedResources,
      ...Object.fromEntries(Object.keys(managerResources).map(name => [name, []])),
      sellers: [{ sellerId: seedIds.sellerId, tenantId: seedIds.tenantId, name: 'Public Seller' }],
    },
  },
  schemas: {
    JsonValue: { anyOf: [{ type: 'null' }, { type: 'boolean' }, string, { type: 'number' }, array(json), { type: 'object', additionalProperties: json }] },
    Uuid: { type: 'string', format: 'uuid' },
    UtcTimestamp: { type: 'string', format: 'date-time', pattern: '(?:[Zz]|\\+00:00)$' },
    MinorUnits: nonnegative,
    Currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 currency code.' },
    ProviderEventId: { ...string, $comment: wireSource },
    ProviderQueryId: { ...string, $comment: wireSource },
    ProductKind: { type: 'string', enum: ['PHYSICAL', 'DIGITAL'], $comment: wireSource },
    Tenant: { ...object({ tenantId: id, name: string }), $comment: wireSource },
    Buyer: { ...object({ buyerId: id, tenantId: id, displayName: string }), $comment: wireSource },
    Product: {
      ...object({ productId: id, tenantId: id, sku: string, name: string, kind: ref('ProductKind') }),
      $comment: wireSource,
    },
    InventoryPool: {
      ...object({
        inventoryPoolId: id, tenantId: id, productId: id, priority: integer,
        onHand: { type: 'integer', minimum: 0 }, reserved: { type: 'integer', minimum: 0 },
      }),
      $comment: wireSource,
    },
    Order: { ...object(orderProperties), $comment: wireSource },
    OrderLine: { ...object(orderLineProperties), $comment: wireSource },
    InventoryHold: {
      ...object({
        inventoryHoldId: id, tenantId: id, orderLineId: id, inventoryPoolId: id, quantity: integer,
        state: { type: 'string', enum: ['HELD', 'CONSUMED', 'RELEASED', 'EXPIRED'] },
      }),
      $comment: wireSource,
    },
    QuoteResponse: {
      ...object({
        ...orderProperties,
        lines: array(object({
          ...orderLineProperties,
          allocations: array(object({ inventoryPoolId: id, quantity: integer })),
        })),
      }),
      $comment: wireSource,
    },
    CancelOrderRequest: { ...object({}), $comment: wireSource },
    Error: object({
      error: object({ code: string, message: string, details: { type: 'object', additionalProperties: json } }),
    }),
    OfferVersion: object({
      offerVersionId: id, tenantId: id, productId: id, version: integer,
      currency, unitPriceMinor: money, taxMinor: money,
      fulfillmentKind: ref('ProductKind'), effectiveFrom: date, effectiveUntil: date, state: string,
    }),
    PaymentAttempt: object({ paymentAttemptId: id, tenantId: id, orderId: id, provider: { const: 'SANDBOX' }, providerRequestId: string, state: enumOf('PENDING', 'UNKNOWN', 'CAPTURED', 'DECLINED'), capturedMinor: money }),
    FulfillmentPlan: object({ fulfillmentPlanId: id, tenantId: id, orderId: id, state: enumOf('PENDING', 'COMPLETED'), lines: array(object({ orderLineId: id, quantity: positive, allocations: array(object({ inventoryPoolId: id, quantity: positive })) })), fencingToken: nonnegative, completedAt: nullable(date) }),
    EntitlementGrant: object({ entitlementGrantId: id, tenantId: id, orderId: id, orderLineId: id, grantRevision: positive, state: enumOf('ACTIVE', 'REVOKED') }),
    LedgerEntry: object({ ledgerEntryId: id, tenantId: id, orderId: id, journalId: id, currency, account: string, direction: enumOf('DEBIT', 'CREDIT'), amountMinor: positive }),
    Refund: object({ refundId: id, tenantId: id, orderId: id, currency, amountMinor: positive, reason: string, restockLines: array(ref('RestockLine')), journalId: id, createdAt: date }),
    Seller: object({ sellerId: id, tenantId: id, name: string }),
    SellerAllocation: object({ sellerAllocationId: id, tenantId: id, orderId: id, orderLineId: id, sellerId: id, quantity: positive, amountMinor: money }),
    SellerSettlement: object({ sellerSettlementId: id, tenantId: id, sellerId: id, periodStart: date, periodEnd: date, currency, state: enumOf('OPEN', 'CLOSED'), allocationIds: array(id), grossMinor: money, feeMinor: money, refundReserveMinor: money, disputeReserveMinor: money, netMinor: integer, closedAt: nullable(date) }),
    CommerceDispute: object({ commerceDisputeId: id, tenantId: id, paymentAttemptId: id, providerDisputeId: id, amountMinor: positive, state: enumOf('OPEN', 'WON', 'LOST') }),
    SettlementAdjustment: object({ settlementAdjustmentId: id, tenantId: id, sellerId: id, sourceSettlementId: id, sourceAllocationId: id, amountMinor: integer, reason: string, targetPeriodStart: date }),
    DomainEvent: object({ eventId: id, tenantId: id, aggregateId: id, aggregateSequence: positive, type: string, occurredAt: date, payload: { type: 'object', additionalProperties: json } }),
    Work: object({
      workId: id, tenantId: id,
      kind: {
        type: 'string',
        enum: [
          'QUOTE_EXPIRY', 'PAYMENT_RECONCILIATION', 'FULFILLMENT',
          'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOCATION',
          'SELLER_SETTLEMENT_CLOSE', 'DISPUTE_RECONCILIATION', 'SETTLEMENT_ADJUSTMENT',
        ],
      },
      aggregateId: id, payloadVersion: positive,
      state: { type: 'string', enum: ['PENDING', 'LEASED', 'SUCCEEDED', 'DEAD'] },
      attempts: integer, availableAt: date,
      leaseOwner: nullable(string), leaseExpiresAt: nullable(date), fencingToken: nonnegative, terminal: { type: 'boolean' },
    }),
    NotificationDelivery: object({
      notificationDeliveryId: id, tenantId: id, orderId: id, eventId: id,
      aggregateSequence: integer, state: string, attempts: integer,
      bodyDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' }, createdAt: date, deliveredAt: nullable(date),
    }),
    QuoteLine: object({ productId: id, quantity: { type: 'integer', minimum: 1, maximum: 1000 } }),
    QuoteRequest: object({
      tenantId: id, buyerId: id,
      channel: { type: 'string', enum: ['WEB', 'STORE', 'PARTNER'] },
      lines: {
        ...array(ref('QuoteLine')), minItems: 1, maxItems: 100, uniqueItems: true,
        description: 'Product IDs must be unique across lines.',
      },
      holdTtlSeconds: { type: 'integer', minimum: 30, maximum: 3600 },
    }),
    CheckoutRequest: object({ provider: { const: 'SANDBOX' }, providerRequestId: string }),
    PaymentCallbackRequest: object({
      providerEventId: ref('ProviderEventId'), providerRequestId: string, outcome: outcomes,
      capturedMinor: { type: 'integer', minimum: 0 },
    }),
    PaymentReconcileRequest: object({
      providerQueryId: ref('ProviderQueryId'), outcome: outcomes,
      capturedMinor: { type: 'integer', minimum: 0 },
    }),
    RestockLine: object({ orderLineId: id, quantity: positive }),
    RefundRequest: object({
      amountMinor: positive, reason: string, restockLines: array(ref('RestockLine')),
    }, ['amountMinor', 'reason']),
    SellerAllocationInput: object({ orderLineId: id, sellerId: id, quantity: positive, amountMinor: money }),
    SellerAllocationsRequest: object({ allocations: array(ref('SellerAllocationInput')) }),
    SellerSettlementRequest: object({ tenantId: id, sellerId: id, periodStart: date, periodEnd: date, currency }),
    SellerSettlementCloseRequest: object({}),
    CommerceDisputeRequest: object({ tenantId: id, paymentAttemptId: id, providerDisputeId: id, amountMinor: money }),
    CommerceDisputeResolveRequest: object({
      providerEventId: ref('ProviderEventId'), outcome: { type: 'string', enum: ['WON', 'LOST'] },
    }),
    SettlementAdjustmentRequest: object({
      tenantId: id, sellerId: id, sourceSettlementId: id, sourceAllocationId: id,
      amountMinor: integer, reason: string,
    }),
    Seed: {
      ...object({ schemaVersion: { const: 1 }, seedVersion: string, ...resources, ...managerResources }, ['schemaVersion', 'seedVersion', ...resourceNames]),
      $comment: wireSource,
    },
    VerificationSnapshot: object({
      asOf: date,
      resources: object({ ...resources, ...managerResources }),
      events: array(ref('DomainEvent')), work: array(ref('Work')),
    }),
  },
  operations: [
    { id: 'getUi', method: 'GET', path: '/', status: 200, source: wireSource },
    operation('getOpenApi', 'GET', '/openapi.json', 'required-stack-and-delivery'),
    operation('getHealth', 'GET', '/healthz', 'required-stack-and-delivery'),
    operation('listTenants', 'GET', '/api/v1/tenants', 'http-errors-and-idempotency'),
    operation('listProducts', 'GET', '/api/v1/products', 'http-errors-and-idempotency'),
    operation('createOfferVersion', 'POST', '/api/v1/offer-versions', 'product-and-immutable-offerversion', {
      response: ref('OfferVersion'),
    }),
    operation('adjustInventoryPool', 'POST', '/api/v1/inventory-pools/:inventoryPoolId/adjustments', 'http-errors-and-idempotency'),
    operation('createQuote', 'POST', '/api/v1/orders/quotes', 'order-and-frozen-quote', {
      request: ref('QuoteRequest'), response: ref('QuoteResponse'), status: 201, source: wireSource,
      example: { request: quoteBody },
    }),
    operation('listOrders', 'GET', '/api/v1/orders', 'http-errors-and-idempotency'),
    operation('getOrder', 'GET', '/api/v1/orders/:orderId', 'http-errors-and-idempotency', {
      response: ref('Order'), source: wireSource,
    }),
    operation('checkoutOrder', 'POST', '/api/v1/orders/:orderId/checkout', 'checkout-and-uncertain-payment', {
      request: ref('CheckoutRequest'),
      example: { request: { provider: 'SANDBOX', providerRequestId: 'merchant-unique-string' } },
    }),
    operation('cancelOrder', 'POST', '/api/v1/orders/:orderId/cancel', 'fulfillment-and-digital-entitlement', {
      request: ref('CancelOrderRequest'), response: ref('Order'), source: wireSource,
    }),
    operation('refundOrder', 'POST', '/api/v1/orders/:orderId/refunds', 'fulfillment-and-digital-entitlement', {
      request: ref('RefundRequest'),
    }),
    operation('recordPaymentCallback', 'POST', '/api/v1/payment-provider/callbacks', 'checkout-and-uncertain-payment', {
      request: ref('PaymentCallbackRequest'), source: wireSource,
    }),
    operation('reconcilePaymentAttempt', 'POST', '/api/v1/payment-attempts/:paymentAttemptId/reconcile', 'checkout-and-uncertain-payment', {
      request: ref('PaymentReconcileRequest'), source: wireSource,
    }),
    operation('completeFulfillmentPlan', 'POST', '/api/v1/fulfillment-plans/:fulfillmentPlanId/complete', 'fulfillment-and-digital-entitlement'),
    operation('revokeEntitlementGrant', 'POST', '/api/v1/entitlement-grants/:entitlementGrantId/revoke', 'fulfillment-and-digital-entitlement'),
    operation('listLedger', 'GET', '/api/v1/ledger', 'http-errors-and-idempotency'),
    operation('listEvents', 'GET', '/api/v1/events', 'http-errors-and-idempotency'),
    operation('listWork', 'GET', '/api/v1/work', 'http-errors-and-idempotency'),
    operation('listNotifications', 'GET', '/api/v1/notifications', 'http-errors-and-idempotency'),
    operation('getVerificationSnapshot', 'GET', '/api/v1/verification-snapshot', 'seed-and-verification-snapshot', {
      response: ref('VerificationSnapshot'),
    }),
    managerOperation('setSellerAllocations', '/api/v1/orders/:orderId/seller-allocations', 'SellerAllocationsRequest'),
    managerOperation('createSellerSettlement', '/api/v1/seller-settlements', 'SellerSettlementRequest'),
    managerOperation('closeSellerSettlement', '/api/v1/seller-settlements/:sellerSettlementId/close', 'SellerSettlementCloseRequest'),
    managerOperation('createCommerceDispute', '/api/v1/commerce-disputes', 'CommerceDisputeRequest'),
    { ...managerOperation('resolveCommerceDispute', '/api/v1/commerce-disputes/:commerceDisputeId/resolve', 'CommerceDisputeResolveRequest'), source: wireSource },
    managerOperation('createSettlementAdjustment', '/api/v1/settlement-adjustments', 'SettlementAdjustmentRequest'),
  ],
  smoke: [
    { operationId: 'getHealth', expectStatus: 200 },
    { operationId: 'getOpenApi', expectStatus: 200 },
    {
      operationId: 'getVerificationSnapshot',
      headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' },
      expectStatus: 200,
      expectContains: Object.entries(seedResources).filter(([, rows]) => rows.length).map(([name, rows]) => ({ path: ['resources', name], match: rows[0] })),
    },
    {
      operationId: 'createQuote', body: quoteBody,
      headers: { 'Idempotency-Key': 'public-quote-create-v1' }, expectStatus: 201,
      expectBody: {
        tenantId: seedIds.tenantId, buyerId: seedIds.buyerId, channel: 'WEB',
        currency: 'USD', state: 'QUOTED', orderTotalMinor: 880, capturedMinor: 0, refundedMinor: 0,
        lines: [{
          productId: seedIds.productId, offerVersionId: seedIds.offerVersionId, quantity: 2,
          unitPriceMinor: 400, taxMinor: 40, lineTotalMinor: 880, fulfillmentKind: 'PHYSICAL',
          allocations: [{ inventoryPoolId: seedIds.inventoryPoolId, quantity: 2 }],
        }],
      },
      capture: { orderId: ['orderId'], orderLineId: ['lines', 0, 'orderLineId'], quoteExpiresAt: ['quoteExpiresAt'] },
    },
    {
      operationId: 'getVerificationSnapshot',
      headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200,
      expectBody: { resources: {
        orders: [quotedOrder], orderLines: [frozenLine], inventoryHolds: [heldInventory],
        inventoryPools: [{ ...seedResources.inventoryPools[0], reserved: 2 }],
        paymentAttempts: [], fulfillmentPlans: [], entitlementGrants: [], ledgerEntries: [],
      } },
      capture: { inventoryHoldId: ['resources', 'inventoryHolds', 0, 'inventoryHoldId'] },
    },
    {
      operationId: 'cancelOrder', params: { orderId: '${orderId}' }, body: {},
      headers: { 'Idempotency-Key': 'public-quote-cancel-v1' }, expectStatus: 200,
      expectBody: { ...quotedOrder, state: 'CANCELLED' },
    },
    {
      operationId: 'getOrder', params: { orderId: '${orderId}' }, expectStatus: 200,
      expectBody: { ...quotedOrder, state: 'CANCELLED' },
    },
    {
      operationId: 'getVerificationSnapshot',
      headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200,
      expectBody: { resources: {
        orders: [{ ...quotedOrder, state: 'CANCELLED' }], orderLines: [frozenLine],
        inventoryHolds: [{ ...heldInventory, inventoryHoldId: '${inventoryHoldId}', state: 'RELEASED' }],
        inventoryPools: seedResources.inventoryPools,
        paymentAttempts: [], fulfillmentPlans: [], entitlementGrants: [], ledgerEntries: [],
      } },
    },
  ],
  notes: [
    'The complete unchanged README and Manager requirements are business authority. These V2 schemas author the omitted public representations from those requirements, without using hidden fixtures or prior submissions. Transport clarifications do not supply transactions, provider integration, inventory allocation, leases, or recovery algorithms.',
    'V2 wire clarification: GET /healthz returns 200 {status:"ok"}, GET / returns production HTML, and GET /openapi.json returns OpenAPI 3.1. GET /api/health is not additionally required. Success status is 200 except quote creation (201). Each successful mutation returns its named primary resource; seller-allocations returns the array of frozen SellerAllocation records.',
    'V2 wire clarification: collection GETs return JSON arrays, without an extra envelope. Optional tenantId filters the collection; orders also accept buyerId and state, products accept kind. No pagination keys are defined: these endpoints return all matching records. Unknown query keys are rejected. Resource arrays sort by their public identity field ascending; notifications sort by orderId, aggregateSequence, notificationDeliveryId; events sort by aggregateId, aggregateSequence, eventId; Work sorts by workId.',
    'V2 wire clarification: Authorization uses Bearer credentials. ADMIN_TOKEN identifies an administrator. Tenant credential provisioning is implementation-owned and must be documented; a tenant-authenticated request cannot expand its scope. X-Tenant-Id is an optional explicit scope selector, not a credential, and cannot override authenticated scope. Any provided invalid credential returns 401 UNAUTHORIZED. Snapshot always requires ADMIN_TOKEN. Business requests without credentials must still enforce the documented Tenant ownership of all body/path references; anonymous access must not be treated as an authenticated foreign Tenant.',
    'Every mutation requires Idempotency-Key, scoped by Tenant, method, and canonical route. First success or business rejection persists exact status/body; exact replay survives restart; changed canonical body returns 409 IDEMPOTENCY_CONFLICT. MALFORMED_JSON returns 400 and creates no replay record.',
    'V2 wire clarification: quote returns Order fields plus lines containing frozen OrderLine fields and allocations:[{inventoryPoolId,quantity}]. GET Order and cancellation return Order. Checkout, callback and reconciliation return PaymentAttempt. Refund returns immutable Refund with journalId and observed restockLines. Fulfillment completion returns FulfillmentPlan and takes {fencingToken}; the current token is visible in Work and the claimed plan. Entitlement revocation and cancellation take {}.',
    'V2 wire clarification: offer creation supplies tenantId, productId, currency, unitPriceMinor, taxMinor, fulfillmentKind, effectiveFrom, effectiveUntil and state; the server assigns offerVersionId and next version. Inventory adjustment takes {delta,reason}, where delta is a signed safe integer change to onHand. Reserved inventory cannot be removed. Resource IDs and server-generated states are never accepted as extra create fields.',
    'Operation examples show individual legal wire representations, not an ordered workflow: referenced Orders, lines, attempts, grants and settlements must already exist in the required domain state. Only the ordered smoke list specifies a runnable seed-to-request sequence and captures real generated identities. Examples do not authorize bypassing foreign-key, Tenant or lifecycle validation.',
    'Internal identifiers follow the global UUID rule. providerRequestId is the published merchant-unique-string exception. The v4 wire clarification makes providerEventId and providerQueryId opaque strings as used by the transport callers; this explicitly narrows the legacy blanket UUID statement for external provider references. ISO currency membership, cross-row references, unique quote Product IDs, monetary equations, immutable terms, tenant isolation, fencing, and transactional convergence remain domain checks beyond these structural schemas.',
    'V2 wire clarification: seed schemaVersion remains 1 and seedVersion is a string. The original required arrays remain required. Optional explicitly named sellers, sellerAllocations, sellerSettlements, commerceDisputes, settlementAdjustments and refunds arrays default to empty on import, preserving old V1 seed clients. Snapshot.resources always includes those six arrays as well as the V1 arrays. Unknown members are rejected. Seed replay, full validation, foreign keys and atomicity remain business obligations.',
    'V2 wire clarification: all resource row fields and nullability are enumerated in the schemas. PaymentAttempt state is PENDING, UNKNOWN, CAPTURED or DECLINED; FulfillmentPlan is PENDING or COMPLETED. SellerSettlement is OPEN or CLOSED; CommerceDispute is OPEN, WON or LOST. LedgerEntry uses ledgerEntryId, and DomainEvent uses aggregateSequence and type. Lease owner/expiry, completion times and deliveredAt are null before their applicable transition. payloadVersion is a positive integer, terminal is boolean. Event payload and error details explicitly permit arbitrary JSON objects subject to secret redaction; resource records do not.',
    'The public policy supplement 2026-09-07.1 below explicitly authors previously omitted economic choices. It is part of this new package revision, not a retroactive interpretation of historical experiments. Published conservation, immutable close and reserve bounds remain fully required; no private alternative policy may be scored.',
    'The public chain imports one Tenant, Buyer, physical Product, active OfferVersion and InventoryPool into a clean database. It creates a two-unit quote, captures returned Order/OrderLine IDs and expiry, observes HELD inventory and captures its ID, cancels via that Order ID, reads CANCELLED Order detail and verifies the same durable rows with a RELEASED hold and unchanged onHand. The one-hour hold TTL keeps this bounded chain independent of background expiry timing. Array expectations have exact length; object expectations are partial. No volatile Work, notification, or event scheduling state is asserted.',
    'Required public errors include VALIDATION_ERROR, RESOURCE_NOT_FOUND, IDEMPOTENCY_CONFLICT, MALFORMED_JSON, INSUFFICIENT_INVENTORY, QUOTE_EXPIRED, INVALID_ORDER_STATE, PROVIDER_EVENT_CONFLICT, REFUND_EXCEEDS_CAPTURE, STALE_FENCE and TENANT_MISMATCH. Manager adds 409 ALLOCATION_NOT_CONSERVED, 409 RESERVE_EXCEEDS_CAPTURE and 409 SETTLEMENT_CLOSED. The error details members are not enumerated.',
    'Marketplace invariants remain binding: one immutable conserved allocation set per Order, same Tenant, no reassignment after fulfillment; CLOSED settlements immutable; refund plus dispute reserve bounded by capture; LOST charges back once, WON only releases reserve; adjustments persist targetPeriodStart at or after the source periodEnd in the next open period.',
    'Defaults: PORT=3000; WORK_LEASE_SECONDS is integer 1..300, default 30; WEBHOOK_URL may be absent but dispatcher stays alive and retries; BENCH_PERF_SCALE is test-only (0,1], scored runs use 1. Tokens must not be logged; TEST_BARRIER_TOKEN must not be persisted.',
    'db:migrate is repeatable; all start commands are long-running production roles. test:all includes every non-performance gate. Preserve seven V1 performance scenarios and add seller-settlement-close, refund-dispute-race, full-catastrophe-recovery with the exact published thresholds; this structural contract does not replace those gates.',
    'V2 wire defaults: malformed JSON is 400 MALFORMED_JSON; invalid/unknown body fields and query/path/header values are 400 VALIDATION_ERROR; unknown routes are 404 RESOURCE_NOT_FOUND; unsupported request media is 415 UNSUPPORTED_MEDIA_TYPE; invalid credentials are 401 UNAUTHORIZED. Domain error precedence and statuses explicitly required by README are unchanged. Browser deep links and tenant credential provisioning remain implementation-owned routes.',
  ],
};

// Public choices for previously absent wire shapes. These are schema metadata,
// not implementations of the business transitions.
contract.schemas.CreateOfferVersionRequest = object(Object.fromEntries(['tenantId', 'productId', 'currency', 'unitPriceMinor', 'taxMinor', 'fulfillmentKind', 'effectiveFrom', 'effectiveUntil', 'state'].map(name => [name, contract.schemas.OfferVersion.properties[name]])));
contract.schemas.InventoryAdjustmentRequest = object({ delta: integer, reason: string });
contract.schemas.FulfillmentCompleteRequest = object({ fencingToken: positive });
const samples = {
  createOfferVersion: { ...seedResources.offerVersions[0] },
  adjustInventoryPool: { delta: 1, reason: 'Public stock receipt' },
  createQuote: quoteBody,
  checkoutOrder: { provider: 'SANDBOX', providerRequestId: 'public-provider-request' },
  cancelOrder: {}, refundOrder: { amountMinor: 440, reason: 'Public return', restockLines: [] },
  recordPaymentCallback: { providerEventId: 'public-provider-event', providerRequestId: 'public-provider-request', outcome: 'CAPTURED', capturedMinor: 880 },
  reconcilePaymentAttempt: { providerQueryId: 'public-provider-query', outcome: 'UNKNOWN', capturedMinor: 0 },
  completeFulfillmentPlan: { fencingToken: 1 }, revokeEntitlementGrant: {},
  setSellerAllocations: { allocations: [{ orderLineId: seedIds.orderLineId, sellerId: seedIds.sellerId, quantity: 2, amountMinor: 880 }] },
  createSellerSettlement: { tenantId: seedIds.tenantId, sellerId: seedIds.sellerId, periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-02-01T00:00:00Z', currency: 'USD' },
  closeSellerSettlement: {},
  createCommerceDispute: { tenantId: seedIds.tenantId, paymentAttemptId: seedIds.paymentAttemptId, providerDisputeId: '20000000-0000-4000-8000-000000000012', amountMinor: 100 },
  resolveCommerceDispute: { providerEventId: 'public-dispute-event', outcome: 'WON' },
  createSettlementAdjustment: { tenantId: seedIds.tenantId, sellerId: seedIds.sellerId, sourceSettlementId: seedIds.sellerSettlementId, sourceAllocationId: seedIds.sellerAllocationId, amountMinor: -10, reason: 'Public correction' },
};
delete samples.createOfferVersion.offerVersionId;
delete samples.createOfferVersion.version;
const responseNames = {
  listTenants: array(ref('Tenant')), listProducts: array(ref('Product')), listOrders: array(ref('Order')),
  adjustInventoryPool: ref('InventoryPool'), checkoutOrder: ref('PaymentAttempt'), refundOrder: ref('Refund'), recordPaymentCallback: ref('PaymentAttempt'), reconcilePaymentAttempt: ref('PaymentAttempt'),
  completeFulfillmentPlan: ref('FulfillmentPlan'), revokeEntitlementGrant: ref('EntitlementGrant'),
  listLedger: array(ref('LedgerEntry')), listEvents: array(ref('DomainEvent')), listWork: array(ref('Work')), listNotifications: array(ref('NotificationDelivery')),
  setSellerAllocations: array(ref('SellerAllocation')), createSellerSettlement: ref('SellerSettlement'), closeSellerSettlement: ref('SellerSettlement'), createCommerceDispute: ref('CommerceDispute'), resolveCommerceDispute: ref('CommerceDispute'), createSettlementAdjustment: ref('SettlementAdjustment'),
  getHealth: object({ status: { const: 'ok' } }), getUi: { type: 'string', minLength: 1, contentMediaType: 'text/html' },
  getOpenApi: { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, info: { type: 'object' }, paths: { type: 'object' } }, additionalProperties: true },
};
const requestNames = { createOfferVersion: 'CreateOfferVersionRequest', adjustInventoryPool: 'InventoryAdjustmentRequest', completeFulfillmentPlan: 'FulfillmentCompleteRequest', revokeEntitlementGrant: 'CancelOrderRequest' };
for (const op of contract.operations) {
  op.response ??= responseNames[op.id];
  if (requestNames[op.id]) op.request = ref(requestNames[op.id]);
  const names = [...op.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => name);
  op.parameters = names.map(name => ({ name, in: 'path', required: true, schema: contract.schemas.Uuid }));
  if (op.path.startsWith('/api/')) op.parameters.push(
    { name: 'Authorization', in: 'header', required: op.id === 'getVerificationSnapshot', schema: { type: 'string', pattern: '^Bearer .+$' } },
    { name: 'X-Tenant-Id', in: 'header', required: false, schema: contract.schemas.Uuid },
  );
  if (op.method === 'POST') op.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 } });
  if (op.id.startsWith('list')) {
    op.parameters.push({ name: 'tenantId', in: 'query', required: false, schema: contract.schemas.Uuid });
    if (op.id === 'listOrders') op.parameters.push(...Object.entries({ buyerId: contract.schemas.Uuid, state: orderProperties.state }).map(([name, schema]) => ({ name, in: 'query', required: false, schema })));
    if (op.id === 'listProducts') op.parameters.push({ name: 'kind', in: 'query', required: false, schema: contract.schemas.ProductKind });
  }
  op.example = { params: Object.fromEntries(names.map(name => [name, seedIds[name] ?? '20000000-0000-4000-8000-000000000020'])),
    ...(op.method === 'POST' ? { body: samples[op.id], headers: { 'Idempotency-Key': `public-example-${op.id}` } } : {}),
    ...(op.id === 'getVerificationSnapshot' ? { headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' } } : {}),
  };
}
contract.policyRevision = 'commercecommand-2026-09-08.1';
contract.environmentVariables.push('SANDBOX_PROVIDER_URL');
contract.notes.push(
  readFileSync(new URL('./commercecommand-policy.md', import.meta.url), 'utf8'),
  readFileSync(new URL('./commercecommand-protocol.md', import.meta.url), 'utf8'),
);
// This public chain uses real returned identities; it supplies no business implementation.
contract.smoke.push(
  {
    operationId: 'createQuote', body: quoteBody,
    headers: { 'Idempotency-Key': 'public-marketplace-quote' }, expectStatus: 201,
    expectBody: { orderTotalMinor: 880, state: 'QUOTED' },
    capture: { marketplaceOrderId: ['orderId'], marketplaceLineId: ['lines', 0, 'orderLineId'] },
  },
  {
    operationId: 'setSellerAllocations', params: { orderId: '${marketplaceOrderId}' },
    body: { allocations: [{ orderLineId: '${marketplaceLineId}', sellerId: seedIds.sellerId, quantity: 2, amountMinor: 880 }] },
    headers: { 'Idempotency-Key': 'public-marketplace-allocate' }, expectStatus: 200,
    expectBody: [{ orderId: '${marketplaceOrderId}', orderLineId: '${marketplaceLineId}', sellerId: seedIds.sellerId, quantity: 2, amountMinor: 880 }],
    capture: { marketplaceAllocationId: [0, 'sellerAllocationId'] },
  },
  {
    operationId: 'checkoutOrder', params: { orderId: '${marketplaceOrderId}' },
    body: { provider: 'SANDBOX', providerRequestId: 'public-marketplace-payment' },
    headers: { 'Idempotency-Key': 'public-marketplace-checkout' }, expectStatus: 200,
    expectBody: { orderId: '${marketplaceOrderId}', providerRequestId: 'public-marketplace-payment' },
  },
  {
    operationId: 'recordPaymentCallback',
    body: { providerEventId: 'public-marketplace-capture', providerRequestId: 'public-marketplace-payment', outcome: 'CAPTURED', capturedMinor: 880 },
    headers: { 'Idempotency-Key': 'public-marketplace-capture' }, expectStatus: 200,
    expectBody: { orderId: '${marketplaceOrderId}', state: 'CAPTURED', capturedMinor: 880 },
  },
  {
    operationId: 'createSellerSettlement',
    body: { tenantId: seedIds.tenantId, sellerId: seedIds.sellerId, periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-02-01T00:00:00Z', currency: 'USD' },
    headers: { 'Idempotency-Key': 'public-marketplace-settlement' }, expectStatus: 200,
    expectBody: { state: 'OPEN', sellerId: seedIds.sellerId },
    capture: { marketplaceSettlementId: ['sellerSettlementId'] },
  },
  {
    operationId: 'closeSellerSettlement', params: { sellerSettlementId: '${marketplaceSettlementId}' }, body: {},
    headers: { 'Idempotency-Key': 'public-marketplace-close' }, expectStatus: 200,
    expectBody: { state: 'CLOSED', allocationIds: ['${marketplaceAllocationId}'], grossMinor: 880, feeMinor: 18, refundReserveMinor: 0, disputeReserveMinor: 0, netMinor: 862 },
  },
  {
    operationId: 'getVerificationSnapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200,
    expectContains: [
      { path: ['resources', 'sellerSettlements'], match: { sellerSettlementId: '${marketplaceSettlementId}', state: 'CLOSED', allocationIds: ['${marketplaceAllocationId}'], grossMinor: 880, feeMinor: 18, netMinor: 862 } },
      { path: ['resources', 'paymentAttempts'], match: { orderId: '${marketplaceOrderId}', state: 'CAPTURED', capturedMinor: 880 } },
    ],
  },
);

export default contract;
