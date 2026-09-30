import authorAssert from "node:assert/strict";
import { candidateAssert as assert } from "../lib/execution.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const publicRoot = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
const authorContract = publicRoot
  ? JSON.parse(readFileSync(join(publicRoot, 'contract.json'), 'utf8'))
  : (await import('../../../../../contracts/transfer/coldchaincontrol.mjs')).default;
const { validator } = await import(publicRoot ? pathToFileURL(join(publicRoot, 'runtime.mjs')) : new URL('../../../../../templates/contract-first/runtime.mjs', import.meta.url));
const compilePublic = validator(authorContract);
const validWork = compilePublic(authorContract.schemas.Work);

export function assertPublishedWork(work) {
  assert(Array.isArray(work), 'published snapshot work is an array');
  for (const item of work) assert(validWork(item), `published Work schema: ${JSON.stringify(validWork.errors)}`);
}

// Compare live responses to the author contract, not only to the submission's own OpenAPI.
export function assertPublishedResponse(method, path, response) {
  const op = authorContract.operations.find(item => item.method === method && item.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}') === path);
  authorAssert(op, `Unpublished response route: ${method} ${path}`);
  const schema = response.status < 400
    ? (assert((op.successStatuses ?? [op.status ?? 200]).includes(response.status), `${method} ${path}: published status`), op.successResponses?.[response.status]?.response ?? op.response)
    : op.errors?.[response.status] ?? authorContract.schemas.Error;
  assert(schema, `${method} ${path}: published status ${response.status}`);
  const valid = compilePublic(schema);
  assert(valid(response.json), `${method} ${path}: published response ${JSON.stringify(valid.errors)}`);
  return response.json;
}

export const PUBLIC_OPERATIONS = Object.freeze([
  ["post", "/api/v1/tenants"], ["post", "/api/v1/sites"], ["post", "/api/v1/carriers"], ["post", "/api/v1/devices"],
  ["post", "/api/v1/config-revisions"], ["post", "/api/v1/config-revisions/{configRevisionId}/publish"],
  ["post", "/api/v1/devices/{deviceId}/config-assignments"], ["get", "/api/v1/devices/{deviceId}/config"], ["post", "/api/v1/devices/{deviceId}/config-acknowledgements"],
  ["post", "/api/v1/devices/{deviceId}/credentials/rotate"], ["post", "/api/v1/devices/{deviceId}/credentials/{keyVersion}/revoke"], ["post", "/api/v1/telemetry-readings"],
  ["post", "/api/v1/shipments"], ["post", "/api/v1/shipments/{shipmentId}/activate"], ["post", "/api/v1/shipments/{shipmentId}/cancel"], ["post", "/api/v1/shipments/{shipmentId}/deliver"], ["get", "/api/v1/shipments/{shipmentId}"], ["get", "/api/v1/shipments/{shipmentId}/timeline"],
  ["post", "/api/v1/excursions/{excursionId}/acknowledge"], ["get", "/api/v1/excursions"], ["post", "/api/v1/notification-policies"], ["get", "/api/v1/verification-snapshot"],
  ["post", "/api/v1/custody-chains"], ["get", "/api/v1/custody-chains/{chainId}"], ["post", "/api/v1/custody-chains/{chainId}/handoffs"], ["post", "/api/v1/custody-handoffs/{handoffId}/accept"],
  ["post", "/api/v1/recalls"], ["get", "/api/v1/recalls/{recallId}"], ["post", "/api/v1/recalls/{recallId}/quarantine"],
]);

export const RESOURCE_SHAPES = Object.freeze({
  Tenant: ["tenantId", "name"], Site: ["siteId", "tenantId", "code", "name", "latitudeE6", "longitudeE6", "radiusMeters", "timeZone"], Carrier: ["carrierId", "tenantId", "code", "name", "state"],
  DeviceCredential: ["deviceCredentialId", "tenantId", "deviceId", "keyVersion", "state", "validFrom", "revokedAt"], SensorDevice: ["deviceId", "tenantId", "carrierId", "serialNumber", "state", "currentKeyVersion", "currentConfigVersion", "lastSequence", "lastSeenAt"],
  ConfigRevision: ["configRevisionId", "tenantId", "version", "state", "minTemperatureMilliC", "maxTemperatureMilliC", "sampleIntervalSeconds", "offlineAfterSeconds", "createdAt", "publishedAt"], ConfigAssignment: ["configAssignmentId", "tenantId", "deviceId", "configRevisionId", "state", "expiresAt", "confirmedAt", "createdAt"],
  ColdShipment: ["shipmentId", "tenantId", "externalRef", "productLotCode", "carrierId", "originSiteId", "destinationSiteId", "deviceId", "state", "minimumTemperatureMilliC", "maximumTemperatureMilliC", "expectedStartAt", "expectedEndAt", "activatedAt", "terminalAt"], ShipmentLeg: ["shipmentLegId", "shipmentId", "ordinal", "fromSiteId", "toSiteId", "plannedDepartureAt", "plannedArrivalAt"],
  TelemetryReading: ["telemetryReadingId", "tenantId", "deviceId", "readingId", "sequence", "observedAt", "receivedAt", "latitudeE6", "longitudeE6", "temperatureMilliC", "configVersion", "keyVersion", "signature"], ShipmentProjection: ["shipmentId", "tenantId", "lastSequence", "lastObservedAt", "lastLatitudeE6", "lastLongitudeE6", "lastTemperatureMilliC", "currentSiteId", "currentLegOrdinal", "state", "updatedAt"],
  Excursion: ["excursionId", "tenantId", "shipmentId", "kind", "state", "openedAt", "acknowledgedAt", "resolvedAt", "firstSequence", "lastSequence", "minimumObservedMilliC", "maximumObservedMilliC"], NotificationPolicy: ["notificationPolicyId", "tenantId", "eventKinds", "destination", "rateLimitPerMinute", "state"], NotificationDelivery: ["notificationDeliveryId", "tenantId", "notificationPolicyId", "eventId", "state", "attempts", "nextAttemptAt", "deliveredAt"], AuditEntry: ["auditEntryId", "tenantId", "actorType", "actorRef", "action", "resourceType", "resourceId", "occurredAt", "details"],
  CustodyChain: ["custodyChainId", "tenantId", "shipmentId", "revision", "state", "currentOrdinal", "createdAt", "terminalAt"], CustodyHandoff: ["custodyHandoffId", "custodyChainId", "ordinal", "fromCarrierId", "toCarrierId", "siteId", "windowStart", "windowEnd", "state", "offeredAt", "acceptedAt", "terminalAt"], RecallOrder: ["recallId", "tenantId", "productLotCode", "reason", "state", "revision", "issuedAt", "terminalAt"], QuarantineAction: ["quarantineActionId", "recallId", "shipmentId", "state", "expectedShipmentState", "createdAt", "appliedAt", "releasedAt"],
  Error: ["code", "message", "details"], ErrorEnvelope: ["error"],
});

const MANAGER_STATUS = Object.freeze({
  "POST /api/v1/custody-chains": "201", "GET /api/v1/custody-chains/{chainId}": "200", "POST /api/v1/custody-chains/{chainId}/handoffs": "200", "POST /api/v1/custody-handoffs/{handoffId}/accept": "200", "POST /api/v1/recalls": "201", "GET /api/v1/recalls/{recallId}": "200", "POST /api/v1/recalls/{recallId}/quarantine": "202",
});
const MANAGER_REQUESTS = Object.freeze({
  "POST /api/v1/custody-chains": ["tenantId", "shipmentId", "expectedShipmentState", "steps"], "POST /api/v1/custody-chains/{chainId}/handoffs": ["expectedChainRevision"], "POST /api/v1/custody-handoffs/{handoffId}/accept": ["carrierId", "deviceId", "keyVersion", "attestation", "acceptedAt", "expectedChainRevision"], "POST /api/v1/recalls": ["tenantId", "productLotCode", "reason", "issuedAt"], "POST /api/v1/recalls/{recallId}/quarantine": ["expectedRevision"],
});
const MANAGER_ERROR_STATUSES = Object.freeze({
  "POST /api/v1/custody-chains": ["400", "404", "409"], "GET /api/v1/custody-chains/{chainId}": ["404"], "POST /api/v1/custody-chains/{chainId}/handoffs": ["404", "409"], "POST /api/v1/custody-handoffs/{handoffId}/accept": ["401", "404", "409"], "POST /api/v1/recalls": ["400", "404", "409"], "GET /api/v1/recalls/{recallId}": ["404"], "POST /api/v1/recalls/{recallId}/quarantine": ["404", "409"],
});
const ERRORS = ["INVALID_REQUEST", "NOT_FOUND", "TENANT_SCOPE_MISMATCH", "STATE_CONFLICT", "CONFIG_VERSION_CONFLICT", "CONFIG_ASSIGNMENT_STALE", "DEVICE_TERMINAL", "DEVICE_CREDENTIAL_CONFLICT", "INVALID_DEVICE_SIGNATURE", "TELEMETRY_CONFLICT", "SHIPMENT_ROUTE_INVALID", "SHIPMENT_DEVICE_BUSY", "SHIPMENT_TERMINAL", "EXCURSION_TERMINAL", "RATE_LIMITED", "CUSTODY_CHAIN_INVALID", "RECALL_INVALID", "INVALID_HANDOFF_ATTESTATION", "CUSTODY_CHAIN_CONFLICT", "CUSTODY_HANDOFF_NOT_CURRENT", "CUSTODY_HANDOFF_EXPIRED", "CUSTODY_REVISION_CONFLICT", "RECALL_ALREADY_ACTIVE", "RECALL_REVISION_CONFLICT", "SHIPMENT_QUARANTINED", "RECALL_TERMINAL"];
const INTEGER_FIELDS = new Set(["temperatureMilliC", "latitudeE6", "longitudeE6", "radiusMeters", "keyVersion", "currentKeyVersion", "currentConfigVersion", "lastSequence", "version", "minTemperatureMilliC", "maxTemperatureMilliC", "sampleIntervalSeconds", "offlineAfterSeconds", "minimumTemperatureMilliC", "maximumTemperatureMilliC", "ordinal", "sequence", "configVersion", "lastLatitudeE6", "lastLongitudeE6", "lastTemperatureMilliC", "currentLegOrdinal", "firstSequence", "minimumObservedMilliC", "maximumObservedMilliC", "rateLimitPerMinute", "attempts", "revision", "currentOrdinal"]);
const ARRAY_FIELDS = new Set(["eventKinds"]), OBJECT_FIELDS = new Set(["details", "error"]);
const NULLABLE_FIELDS = new Set(["minimumObservedMilliC", "maximumObservedMilliC", "revokedAt", "currentConfigVersion", "lastSeenAt", "publishedAt", "confirmedAt", "activatedAt", "terminalAt", "lastObservedAt", "lastLatitudeE6", "lastLongitudeE6", "lastTemperatureMilliC", "currentSiteId", "acknowledgedAt", "resolvedAt", "nextAttemptAt", "deliveredAt", "offeredAt", "acceptedAt", "appliedAt", "releasedAt"]);

function dereference(document, schema, seen = new Set()) { if (!schema || typeof schema !== "object") return schema; if (schema.$ref) { assert.match(schema.$ref, /^#\//u); if (seen.has(schema.$ref)) return schema; const target = schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document); assert.ok(target, `OpenAPI ref ${schema.$ref}`); return dereference(document, target, new Set([...seen, schema.$ref])); } if (Array.isArray(schema.allOf)) { const parts = schema.allOf.map((part) => dereference(document, part, seen)); return { ...schema, properties: Object.assign({}, ...parts.map((part) => part.properties ?? {}), schema.properties ?? {}), required: [...new Set(parts.flatMap((part) => part.required ?? []).concat(schema.required ?? []))], additionalProperties: schema.additionalProperties ?? (parts.every((part) => part.additionalProperties === false) ? false : undefined) }; } return schema; }
function schemaNodes(document) { const result = [], seen = new Set(); function visit(value) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); const resolved = dereference(document, value); if (resolved?.properties) result.push(resolved); for (const child of Object.values(value)) if (typeof child === "object") visit(child); } visit(document.components?.schemas ?? {}); visit(document.paths ?? {}); return result; }
function allowedTypes(document,schema){const value=dereference(document,schema);if(Array.isArray(value?.type))return new Set(value.type);if(typeof value?.type==="string")return new Set([value.type]);const alternatives=value?.oneOf??value?.anyOf;if(alternatives)return new Set(alternatives.flatMap((item)=>[...allowedTypes(document,item)]));return new Set();}
function findShape(document, nodes, name, keys) { const shape = nodes.find((candidate) => { const value = dereference(document, candidate); return value?.properties && JSON.stringify(Object.keys(value.properties).sort()) === JSON.stringify([...keys].sort()); }); assert.ok(shape, `OpenAPI closed ${name} schema`); const resolved = dereference(document, shape); assert.deepEqual(resolved.required?.slice().sort(), [...keys].sort(), `${name} required`); assert.equal(resolved.additionalProperties, false, `${name} additionalProperties`); for(const [key,property]of Object.entries(resolved.properties)){const types=allowedTypes(document,property),expected=ARRAY_FIELDS.has(key)?"array":OBJECT_FIELDS.has(key)?"object":INTEGER_FIELDS.has(key)?"integer":"string";assert.ok(types.has(expected),`${name}.${key} ${expected}`);assert.equal(types.has("null"),NULLABLE_FIELDS.has(key),`${name}.${key} nullable contract`);} return resolved; }
function requestSchema(document, operation) { const schema = operation.requestBody?.content?.["application/json"]?.schema; assert.ok(schema, "JSON request schema"); return dereference(document, schema); }
function literals(document) { const result = new Set(), seen = new Set(); function visit(value, key) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); if (["enum", "examples"].includes(key) && Array.isArray(value)) for (const item of value) result.add(item); for (const [childKey, child] of Object.entries(value)) { if (["const", "example"].includes(childKey) && ["string", "number"].includes(typeof child)) result.add(child); visit(child, childKey); } } visit(document); return result; }

export function assertOpenApiContract(document) {
  assert.equal(document?.openapi, "3.1.0"); const nodes = schemaNodes(document), shapes = {}; for (const [name, keys] of Object.entries(RESOURCE_SHAPES)) shapes[name] = findShape(document, nodes, name, keys);
  for (const [method, path] of PUBLIC_OPERATIONS) { const operation = document.paths?.[path]?.[method]; assert.ok(operation, `OpenAPI operation ${method.toUpperCase()} ${path}`); assert.ok(Object.keys(operation.responses ?? {}).length > 0, `${method.toUpperCase()} ${path} responses`); const identity = `${method.toUpperCase()} ${path}`, status = MANAGER_STATUS[identity]; if (status) assert.ok(operation.responses[status], `${identity} publishes ${status}`); for(const errorStatus of MANAGER_ERROR_STATUSES[identity]??[]) { const response=operation.responses[errorStatus];assert.ok(response,`${identity} publishes ${errorStatus}`);const schema=response.content?.["application/json"]?.schema,resolved=dereference(document,schema);assert.ok(resolved?.properties?.error,`${identity} ${errorStatus} ErrorEnvelope`); } if (MANAGER_REQUESTS[identity]) { const schema = requestSchema(document, operation); assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...MANAGER_REQUESTS[identity]].sort(), `${identity} request keys`); assert.deepEqual(schema.required?.slice().sort(), [...MANAGER_REQUESTS[identity]].sort(), `${identity} request required`); assert.equal(schema.additionalProperties, false); } }
  const devicePaths = ["/api/v1/devices/{deviceId}/config", "/api/v1/devices/{deviceId}/config-acknowledgements", "/api/v1/telemetry-readings"];
  for (const path of devicePaths) { const operation = document.paths[path][path.endsWith("config") ? "get" : "post"]; const names = new Set((operation.parameters ?? []).map(({ name }) => String(name).toLowerCase())); for (const name of ["x-device-id", "x-device-key-version", "x-device-timestamp", "x-device-signature"]) assert.ok(names.has(name), `${path} publishes ${name}`); }
  const published = literals(document); for (const code of ERRORS) assert.ok(published.has(code), `OpenAPI publishes ${code}`); for (const kind of ["CUSTODY_HANDOFF_EXPIRY", "RECALL_PROPAGATE", "QUARANTINE_ENFORCE"]) assert.ok(published.has(kind), `OpenAPI publishes Work kind ${kind}`);
  return shapes;
}

export function validateJson(document, schema, value, label = "response") {
  const resolved = dereference(document, schema); if (resolved.oneOf || resolved.anyOf) { const variants = resolved.oneOf ?? resolved.anyOf, matches = variants.filter((item) => { try { validateJson(document, item, value, label); return true; } catch { return false; } }); assert.ok(matches.length >= 1, `${label} matches an OpenAPI variant`); return true; }
  if (Array.isArray(resolved.type)) { if (value === null) { assert.ok(resolved.type.includes("null"),`${label} nullable`);return true; } const selected=resolved.type.find((type)=>type!=="null"&&((type==="integer"&&Number.isSafeInteger(value))||(type==="number"&&typeof value==="number")||(type==="string"&&typeof value==="string")||(type==="boolean"&&typeof value==="boolean")||(type==="array"&&Array.isArray(value))||(type==="object"&&value&&typeof value==="object"&&!Array.isArray(value))));assert.ok(selected,`${label} union type`);return validateJson(document,{...resolved,type:selected},value,label); }
  if (resolved.type === "object" || resolved.properties) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); for (const key of resolved.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key} required`); if (resolved.additionalProperties === false) assert.ok(Object.keys(value).every((key) => Object.hasOwn(resolved.properties ?? {}, key)), `${label} no additional fields`); for (const [key, child] of Object.entries(resolved.properties ?? {})) if (Object.hasOwn(value, key)) validateJson(document, child, value[key], `${label}.${key}`); }
  else if (resolved.type === "array") { assert.ok(Array.isArray(value), `${label} array`); for (const item of value) validateJson(document, resolved.items, item, `${label}[]`); }
  else if (resolved.type === "integer") assert.ok(Number.isSafeInteger(value), `${label} safe integer`); else if (resolved.type === "number") assert.equal(typeof value, "number", `${label} number`); else if (resolved.type === "string") assert.equal(typeof value, "string", `${label} string`); else if (resolved.type === "boolean") assert.equal(typeof value, "boolean", `${label} boolean`); else if (resolved.type === "null") assert.equal(value,null,`${label} null`);
  if (resolved.enum) assert.ok(resolved.enum.includes(value), `${label} enum`); return true;
}
