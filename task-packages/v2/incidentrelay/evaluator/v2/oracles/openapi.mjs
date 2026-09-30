import assert from "node:assert/strict";

export const OPERATIONS = Object.freeze({
  "GET /api/v1/incidents": ["200", "400"],
  "POST /api/v1/incidents": ["201", "400", "409", "415"],
  "GET /api/v1/incidents/{incidentId}": ["200", "404"],
  "POST /api/v1/incidents/{incidentId}/acknowledge": ["200", "400", "404", "409", "415"],
  "POST /api/v1/incidents/{incidentId}/acknowledgements": ["200", "400", "404", "409", "415"],
  "POST /api/v1/incidents/{incidentId}/resolve": ["200", "400", "404", "409", "415"],
  "GET /api/v1/incidents/{incidentId}/timeline": ["200", "404"],
  "POST /api/v1/services/{serviceId}/escalation-policies": ["200", "400", "404", "409", "415"],
  "GET /api/v1/services/{serviceId}/escalation-policy": ["200", "404"],
  "GET /api/v1/domain-events": ["200", "400"],
  "GET /api/v1/verification-snapshot": ["200", "401"],
});

const CLOSED_SHAPES = Object.freeze({
  Service: ["serviceId", "name", "currentPolicyId", "currentPolicyVersion"],
  Responder: ["responderId", "name", "deliveryUrl"],
  EscalationPolicy: ["policyId", "version", "steps", "expireAfterSeconds"],
  V1PolicyStep: ["stepIndex", "delaySeconds", "responderId"],
  GroupPolicyStep: ["stepIndex", "delaySeconds", "responderIds", "quorumRequired"],
  Incident: ["incidentId", "serviceId", "dedupKey", "severity", "title", "details", "state", "policyId", "policyVersion", "createdAt", "expiresAt", "nextEscalationAt", "acknowledgedBy", "acknowledgedAt", "resolvedAt", "sequence", "acknowledgementStepIndex", "acknowledgements"],
  EscalationStep: ["incidentId", "stepIndex", "responderId", "dueAt", "state", "notificationId", "successfulDeliveryAt"],
  NotificationBody: ["notificationId", "incidentId", "serviceId", "stepIndex", "responderId", "severity", "title", "details"],
  NotificationDelivery: ["notificationId", "incidentId", "stepIndex", "responderId", "deliveryUrl", "body", "state", "attemptCount", "nextAttemptAt", "successfulDeliveryAt"],
  TimelineItem: ["sequence", "type", "occurredAt", "actorId", "data"],
  IncidentAcknowledgement: ["acknowledgementId", "incidentId", "stepIndex", "responderId", "acknowledgedAt"],
  GroupEscalationStep: ["incidentId", "stepIndex", "responderIds", "quorumRequired", "dueAt", "state", "notifications", "successfulDeliveryAt"],
  Work: ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"],
  DomainEvent: ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"],
  Error: ["code", "message", "details"],
  ErrorEnvelope: ["error"],
  AcknowledgementResult: ["incident", "acknowledgement", "replayed"],
  Snapshot: ["asOf", "resources", "work", "events"],
});

const NULLABLE = Object.freeze({
  Incident: ["nextEscalationAt", "acknowledgedBy", "acknowledgedAt", "resolvedAt", "acknowledgementStepIndex"],
  EscalationStep: ["successfulDeliveryAt"], NotificationDelivery: ["nextAttemptAt", "successfulDeliveryAt"],
  TimelineItem: ["actorId"], GroupEscalationStep: ["successfulDeliveryAt"], Work: ["leaseOwner", "leaseExpiresAt"],
});

function dereference(document, schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    assert.match(schema.$ref, /^#\//u, "OpenAPI schemas use local refs");
    if (seen.has(schema.$ref)) return schema;
    const target = schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document);
    assert.ok(target, `resolvable OpenAPI ref ${schema.$ref}`);
    return dereference(document, target, new Set([...seen, schema.$ref]));
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part) => dereference(document, part, seen));
    return { ...schema, properties: Object.assign({}, ...parts.map((part) => part.properties ?? {}), schema.properties ?? {}), required: [...new Set(parts.flatMap((part) => part.required ?? []).concat(schema.required ?? []))], additionalProperties: schema.additionalProperties ?? (parts.every((part) => part.additionalProperties === false) ? false : undefined) };
  }
  return schema;
}

function schemaNodes(document) {
  const result = [], seen = new Set();
  function visit(value) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); const resolved = dereference(document, value); if (resolved?.properties) result.push(resolved); for (const child of Object.values(value)) if (typeof child === "object") visit(child); }
  visit(document.components?.schemas ?? {}); visit(document.paths ?? {}); return result;
}
function exactSet(actual, expected, label) { assert.deepEqual([...actual].sort(), [...expected].sort(), label); }
function allowsNull(document, schema) { const value = dereference(document, schema); if (Array.isArray(value?.type)) return value.type.includes("null"); if (value?.type === "null" || value?.nullable === true) return true; return [...(value?.oneOf ?? []), ...(value?.anyOf ?? [])].some((item) => allowsNull(document, item)); }
function findShape(document, nodes, name, keys) { const shape = nodes.find((candidate) => { const value = dereference(document, candidate); return value?.properties && JSON.stringify(Object.keys(value.properties).sort()) === JSON.stringify([...keys].sort()); }); assert.ok(shape, `OpenAPI publishes closed ${name} schema`); const resolved = dereference(document, shape); exactSet(Object.keys(resolved.properties), keys, `${name} properties`); exactSet(resolved.required ?? [], keys, `${name} required`); assert.equal(resolved.additionalProperties, false, `${name} additionalProperties false`); for (const key of NULLABLE[name] ?? []) assert.equal(allowsNull(document, resolved.properties[key]), true, `${name}.${key} nullable`); return resolved; }
function responseSchema(document, operation, status) { const response = dereference(document, operation.responses?.[status]); const content = response?.content?.["application/json"]; assert.ok(content?.schema, `${operation.operationId ?? "operation"} ${status} JSON response schema`); return dereference(document, content.schema); }
function requestSchema(document, operation) { const schema = operation.requestBody?.content?.["application/json"]?.schema; assert.ok(schema, `${operation.operationId ?? "mutation"} JSON request schema`); return dereference(document, schema); }
function assertInlineClosed(document, schema, keys, label) { const value = dereference(document, schema); exactSet(Object.keys(value.properties ?? {}), keys, `${label} properties`); exactSet(value.required ?? [], keys, `${label} required`); assert.equal(value.additionalProperties, false, `${label} additionalProperties false`); return value; }
function enumValues(document, schema) { const value = dereference(document, schema); if (Array.isArray(value?.enum)) return value.enum; return [...(value?.oneOf ?? []), ...(value?.anyOf ?? [])].flatMap((item) => enumValues(document, item)); }
function objectVariants(document, schema) { const value = dereference(document, schema); const branches = [...(value?.oneOf ?? []), ...(value?.anyOf ?? [])]; return branches.length ? branches.flatMap((item) => objectVariants(document, item)) : value?.properties ? [value] : [] ; }
function publishedLiterals(document) { const values = new Set(), seen = new Set(); function visit(value, key) { if (value === null || typeof value !== "object" || seen.has(value)) return; seen.add(value); if (key === "enum" && Array.isArray(value)) for (const item of value) values.add(item); for (const [childKey, child] of Object.entries(value)) { if (["const", "example"].includes(childKey) && (typeof child === "string" || typeof child === "number")) values.add(child); if (childKey === "examples" && Array.isArray(child)) for (const item of child) if (typeof item === "string") values.add(item); visit(child, childKey); } } visit(document); return values; }

export function assertOpenApiContract(document) {
  assert.equal(document?.openapi, "3.1.0", "canonical OpenAPI version");
  const nodes = schemaNodes(document), shapes = {};
  for (const [name, keys] of Object.entries(CLOSED_SHAPES)) shapes[name] = findShape(document, nodes, name, keys);
  const policySteps = dereference(document, shapes.EscalationPolicy.properties.steps); assert.equal(policySteps.type, "array", "policy steps array");
  const policyVariants = nodes.filter(node => node.properties?.policyId && node.properties?.steps).flatMap(node => objectVariants(document, dereference(document, node.properties.steps).items)).map((item) => Object.keys(item.properties).sort());
  assert.ok(policyVariants.some((keys) => JSON.stringify(keys) === JSON.stringify([...CLOSED_SHAPES.V1PolicyStep].sort())), "policy publishes V1 singular Step variant");
  assert.ok(policyVariants.some((keys) => JSON.stringify(keys) === JSON.stringify([...CLOSED_SHAPES.GroupPolicyStep].sort())), "policy publishes group quorum Step variant");
  exactSet(enumValues(document, shapes.Incident.properties.severity), ["LOW", "MEDIUM", "HIGH", "CRITICAL"], "Incident severity enum");
  exactSet(enumValues(document, shapes.Incident.properties.state), ["OPEN", "ACKNOWLEDGED", "RESOLVED", "EXPIRED"], "Incident state enum");
  exactSet(enumValues(document, shapes.GroupEscalationStep.properties.state), ["PENDING", "SENT", "SUPERSEDED"], "Group Step state enum");
  exactSet(enumValues(document, shapes.NotificationDelivery.properties.state), ["PENDING", "DELIVERED", "SUPERSEDED"], "Notification state enum");
  exactSet(enumValues(document, shapes.Work.properties.kind), ["ESCALATION_STEP", "INCIDENT_EXPIRY"], "Work kind enum");
  exactSet(enumValues(document, shapes.Work.properties.state), ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"], "Work state enum");
  assert.equal(dereference(document, shapes.Incident.properties.acknowledgements).type, "array", "Incident acknowledgements array");
  assert.equal(dereference(document, shapes.GroupEscalationStep.properties.notifications).type, "array", "Group notifications array");
  for (const [identity, expectedStatuses] of Object.entries(OPERATIONS)) {
    const [method, path] = identity.split(" "); const operation = document.paths?.[path]?.[method.toLowerCase()]; assert.ok(operation, `OpenAPI operation ${identity}`);
    for (const status of expectedStatuses) assert.ok(operation.responses?.[status], `${identity} publishes ${status}`);
    responseSchema(document, operation, expectedStatuses[0]);
    for (const status of expectedStatuses.slice(1)) { const schema = responseSchema(document, operation, status); const resolved = dereference(document, schema); const variants = [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? []), resolved].map((item) => dereference(document, item)); assert.ok(variants.some((item) => item?.properties && Object.keys(item.properties).length === 1 && item.properties.error), `${identity} ${status} error envelope`); }
  }
  const requestShapes = [
    ["POST", "/api/v1/incidents", ["serviceId", "dedupKey", "severity", "title", "details"]],
    ["POST", "/api/v1/incidents/{incidentId}/acknowledge", ["responderId"]],
    ["POST", "/api/v1/incidents/{incidentId}/acknowledgements", ["stepIndex", "responderId"]],
    ["POST", "/api/v1/incidents/{incidentId}/resolve", ["responderId", "resolution"]],
    ["POST", "/api/v1/services/{serviceId}/escalation-policies", ["expectedCurrentVersion", "steps", "expireAfterSeconds"]],
  ];
  for (const [method, path, keys] of requestShapes) for (const variant of objectVariants(document, requestSchema(document, document.paths[path][method.toLowerCase()]))) assertInlineClosed(document, variant, keys, `${method} ${path} request`);
  const literals = publishedLiterals(document);
  for (const code of ["UNSUPPORTED_MEDIA_TYPE", "MALFORMED_JSON", "UNKNOWN_FIELD", "INVALID_REQUEST", "INVALID_CURSOR", "NOT_FOUND", "ADMIN_AUTH_REQUIRED", "IDEMPOTENCY_CONFLICT", "INCIDENT_DEDUP_CONFLICT", "INCIDENT_ALREADY_ACKNOWLEDGED", "INCIDENT_NOT_ACKNOWLEDGEABLE", "INCIDENT_NOT_RESOLVABLE", "ESCALATION_POLICY_VERSION_CHANGED", "INVALID_ESCALATION_POLICY", "RESPONDER_NOT_IN_ACTIVE_QUORUM", "INVALID_QUORUM_POLICY"]) assert.ok(literals.has(code), `OpenAPI publishes literal error ${code}`);
  return shapes;
}
