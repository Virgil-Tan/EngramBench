import assert from "node:assert/strict";

export const REQUIRED_PATHS = Object.freeze([
  "/api/v1/tenants",
  "/api/v1/products",
  "/api/v1/offer-versions",
  "/api/v1/inventory-pools/{inventoryPoolId}/adjustments",
  "/api/v1/orders/quotes",
  "/api/v1/orders",
  "/api/v1/orders/{orderId}",
  "/api/v1/orders/{orderId}/checkout",
  "/api/v1/orders/{orderId}/cancel",
  "/api/v1/orders/{orderId}/refunds",
  "/api/v1/payment-provider/callbacks",
  "/api/v1/payment-attempts/{paymentAttemptId}/reconcile",
  "/api/v1/fulfillment-plans/{fulfillmentPlanId}/complete",
  "/api/v1/entitlement-grants/{entitlementGrantId}/revoke",
  "/api/v1/ledger",
  "/api/v1/events",
  "/api/v1/work",
  "/api/v1/notifications",
  "/api/v1/verification-snapshot",
  "/api/v1/orders/{orderId}/seller-allocations",
  "/api/v1/seller-settlements",
  "/api/v1/seller-settlements/{sellerSettlementId}/close",
  "/api/v1/commerce-disputes",
  "/api/v1/commerce-disputes/{commerceDisputeId}/resolve",
  "/api/v1/settlement-adjustments",
]);

const REQUESTS = Object.freeze({
  "/api/v1/orders/quotes": ["tenantId", "buyerId", "channel", "lines", "holdTtlSeconds"],
  "/api/v1/orders/{orderId}/checkout": ["provider", "providerRequestId"],
  "/api/v1/payment-provider/callbacks": ["providerEventId", "providerRequestId", "outcome", "capturedMinor"],
  "/api/v1/payment-attempts/{paymentAttemptId}/reconcile": ["providerQueryId", "outcome", "capturedMinor"],
  "/api/v1/orders/{orderId}/refunds": ["amountMinor", "reason"],
});

function resolveRef(document, value) {
  if (!value?.$ref) return value;
  assert.match(value.$ref, /^#\//u, "OpenAPI uses local references");
  return value.$ref.slice(2).split("/").reduce((current, part) => current?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], document);
}

function requestSchema(document, path) {
  const operation = document.paths?.[path]?.post;
  assert.ok(operation, `${path} POST operation`);
  const requestBody = resolveRef(document, operation.requestBody);
  assert.equal(requestBody?.required, true, `${path} request body required`);
  return resolveRef(document, requestBody?.content?.["application/json"]?.schema);
}

export function assertPublishedOpenApi(document, { includeManager = true, exactBodies = true } = {}) {
  assert.ok(document && typeof document === "object", "OpenAPI object");
  assert.match(document.openapi ?? "", /^3\.1(?:\.|$)/u, "OpenAPI 3.1");
  const paths = includeManager ? REQUIRED_PATHS : REQUIRED_PATHS.slice(0, 19);
  for (const path of paths) assert.ok(document.paths?.[path], `OpenAPI path ${path}`);
  if (exactBodies) {
    for (const [path, required] of Object.entries(REQUESTS)) {
      const schema = requestSchema(document, path);
      assert.equal(schema?.type, "object", `${path} object request`);
      assert.equal(schema?.additionalProperties, false, `${path} closed request`);
      assert.deepEqual(new Set(schema?.required ?? []), new Set(required), `${path} required fields`);
      for (const field of required) assert.ok(schema?.properties?.[field], `${path} property ${field}`);
    }
  }
  return true;
}

export function assertLiveSchema(document, path, method, status, body) {
  const operation = document.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `${method} ${path} operation`);
  const response = resolveRef(document, operation.responses?.[String(status)] ?? operation.responses?.default);
  assert.ok(response, `${method} ${path} response ${status}`);
  const schema = resolveRef(document, response.content?.["application/json"]?.schema);
  if (!schema) return true;
  if (schema.type === "object") {
    assert.ok(body && typeof body === "object" && !Array.isArray(body), `${path} live object`);
    for (const field of schema.required ?? []) assert.ok(Object.hasOwn(body, field), `${path} live required ${field}`);
    if (schema.additionalProperties === false) assert.deepEqual(Object.keys(body).sort(), Object.keys(schema.properties ?? {}).sort(), `${path} live closed response`);
  }
  return true;
}
