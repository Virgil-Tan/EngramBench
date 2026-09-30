import assert from "node:assert/strict";

export function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; throw new TypeError("value is not JSON"); }
function scalar(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const result = scalar(left[path], right[path]); if (result) return result; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) { assert.deepEqual(values, [...values].sort(compareBy(paths)), `${paths.join(",")} canonical order`); return true; }
export function overlaps(left, right) { return Date.parse(left.startAt) < Date.parse(right.endAt) && Date.parse(right.startAt) < Date.parse(left.endAt); }
function covers(availability, interval) { return availability.some((value) => Date.parse(value.startAt) <= Date.parse(interval.startAt) && Date.parse(value.endAt) >= Date.parse(interval.endAt)); }

export function activeReservations(snapshot) {
  const movementsByCall = new Map(); for (const movement of snapshot.resources.portMovements ?? []) { const values = movementsByCall.get(movement.portCallId) ?? []; values.push(movement); movementsByCall.set(movement.portCallId, values); }
  const values = [];
  for (const call of snapshot.resources.portCalls ?? []) {
    const movements = movementsByCall.get(call.portCallId) ?? call.movements ?? [];
    if (movements.length) { for (const movement of movements) if (["HELD", "CLEARED", "IN_SERVICE"].includes(movement.state)) values.push({ ownerId: movement.movementId, ...movement }); continue; }
    if (["HELD", "CLEARED", "IN_SERVICE"].includes(call.state)) values.push({ ownerId: call.portCallId, startAt: call.arrivalAt, endAt: call.departureAt, requiredTugs: call.requiredTugs, containerUnits: call.containerUnits, berthId: call.berthId, tugPoolId: call.tugPoolId, yardWindowId: call.yardWindowId });
  }
  return values;
}

export function assertCapacityConservation(snapshot) {
  const active = activeReservations(snapshot); const berthById = new Map(snapshot.resources.berths.map((item) => [item.berthId, item])); const tugById = new Map(snapshot.resources.tugPools.map((item) => [item.tugPoolId, item])); const yardById = new Map(snapshot.resources.yardWindows.map((item) => [item.yardWindowId, item]));
  for (const reservation of active) { assert.ok(berthById.has(reservation.berthId), `${reservation.ownerId} Berth exists`); assert.ok(tugById.has(reservation.tugPoolId), `${reservation.ownerId} Tug Pool exists`); assert.ok(yardById.has(reservation.yardWindowId), `${reservation.ownerId} Yard Window exists`); assert.ok(Number.isSafeInteger(reservation.requiredTugs) && reservation.requiredTugs > 0, `${reservation.ownerId} Tug quantity`); assert.ok(Number.isSafeInteger(reservation.containerUnits) && reservation.containerUnits > 0, `${reservation.ownerId} Yard quantity`); }
  for (let left = 0; left < active.length; left += 1) for (let right = left + 1; right < active.length; right += 1) if (active[left].berthId === active[right].berthId) assert.ok(!overlaps(active[left], active[right]), `${active[left].berthId} is double-booked`);
  for (const [kind, idKey, quantityKey, resources, capacityKey] of [["Tug", "tugPoolId", "requiredTugs", tugById, "capacity"], ["Yard", "yardWindowId", "containerUnits", yardById, "capacityUnits"]]) {
    for (const [resourceId, resource] of resources) { const reservations = active.filter((item) => item[idKey] === resourceId); const instants = [...new Set(reservations.flatMap((item) => [Date.parse(item.startAt), Date.parse(item.endAt)]))].sort((a, b) => a - b); for (let index = 0; index < instants.length - 1; index += 1) { const instant = instants[index]; const used = reservations.filter((item) => Date.parse(item.startAt) <= instant && Date.parse(item.endAt) > instant).reduce((sum, item) => sum + item[quantityKey], 0); assert.ok(used >= 0 && used <= resource[capacityKey], `${kind} ${resourceId} capacity ${used}/${resource[capacityKey]}`); } }
  }
  return true;
}

function resourceFree(resourceId, idKey, quantityKey, capacity, interval, quantity, reservations) { const points = [...new Set(reservations.filter((item) => item[idKey] === resourceId && overlaps(item, interval)).flatMap((item) => [Date.parse(item.startAt), Date.parse(item.endAt), Date.parse(interval.startAt), Date.parse(interval.endAt)]))].sort((a, b) => a - b); if (!points.length) return quantity <= capacity; for (let index = 0; index < points.length - 1; index += 1) { const instant = points[index]; if (instant < Date.parse(interval.startAt) || instant >= Date.parse(interval.endAt)) continue; const used = reservations.filter((item) => item[idKey] === resourceId && Date.parse(item.startAt) <= instant && Date.parse(item.endAt) > instant).reduce((sum, item) => sum + item[quantityKey], 0); if (used + quantity > capacity) return false; } return true; }
export function selectBundle({ berths, tugPools, yardWindows, vessels, reservations = [] }, request) {
  const vessel = vessels.find(({ vesselId }) => vesselId === request.vesselId); if (!vessel) return null; const interval = { startAt: request.startAt ?? request.arrivalAt, endAt: request.endAt ?? request.departureAt };
  const berth = [...berths].sort(compareBy(["priority", "berthId"])).find((item) => vessel.lengthMeters <= item.maxLengthMeters && covers(item.availability, interval) && !reservations.some((value) => value.berthId === item.berthId && overlaps(value, interval)));
  const tug = [...tugPools].sort(compareBy(["priority", "tugPoolId"])).find((item) => covers(item.availability, interval) && resourceFree(item.tugPoolId, "tugPoolId", "requiredTugs", item.capacity, interval, request.requiredTugs, reservations));
  const yard = [...yardWindows].sort(compareBy(["priority", "yardWindowId"])).find((item) => Date.parse(item.startAt) <= Date.parse(interval.startAt) && Date.parse(item.endAt) >= Date.parse(interval.endAt) && resourceFree(item.yardWindowId, "yardWindowId", "containerUnits", item.capacityUnits, interval, request.containerUnits, reservations));
  return berth && tug && yard ? { berthId: berth.berthId, tugPoolId: tug.tugPoolId, yardWindowId: yard.yardWindowId } : null;
}

export function assertAggregateProjection(call) {
  if (!Array.isArray(call.movements) || call.movements.length !== 2) return true; const arrival = call.movements.find(({ type }) => type === "ARRIVAL"); const departure = call.movements.find(({ type }) => type === "DEPARTURE"); assert.ok(arrival && departure, "linked Call has ARRIVAL and DEPARTURE"); let expected = "HELD"; if (arrival.state === "CANCELLED") expected = "CANCELLED"; else if (arrival.state === "COMPLETED" && departure.state === "COMPLETED") expected = "COMPLETED"; else if (arrival.state === "COMPLETED") expected = "ARRIVED"; else if (arrival.state === "EXPIRED" || departure.state === "EXPIRED") expected = "EXPIRED"; assert.equal(call.state, expected, "published linked aggregate projection"); return true;
}

export function assertEventSequence(events) { const expected = new Map(); for (const event of events) { const next = (expected.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, next, `${event.aggregateId} event sequence`); expected.set(event.aggregateId, next); } return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }

const OPENAPI_ROUTES = Object.freeze({
  "/api/v1/port-calls": Object.freeze({ get: ["200", "400"], post: ["201", "400", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}": Object.freeze({ get: ["200", "404"] }),
  "/api/v1/port-calls/{portCallId}/confirm": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/start-service": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/cancel": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/complete": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/standby-entries": Object.freeze({ post: ["201", "400", "409", "415"] }),
  "/api/v1/port-resources/feasible-windows": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/port-resources/schedule": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/domain-events": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/verification-snapshot": Object.freeze({ get: ["200", "401"] }),
  "/api/v1/port-calls/{portCallId}/movements/{movementId}/confirm": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/movements/{movementId}/start-service": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/movements/{movementId}/complete": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/port-calls/{portCallId}/movements/{movementId}/cancel": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
});
const SCHEMAS = Object.freeze({
  Berth: ["berthId", "name", "priority", "maxLengthMeters", "availability"],
  TugPool: ["tugPoolId", "name", "priority", "capacity", "availability"],
  YardWindow: ["yardWindowId", "priority", "capacityUnits", "startAt", "endAt"],
  Vessel: ["vesselId", "name", "lengthMeters"],
  PortCall: ["portCallId", "vesselId", "arrivalAt", "departureAt", "requiredTugs", "containerUnits", "berthId", "tugPoolId", "yardWindowId", "state", "expiresAt", "startedAt", "completedAt", "sequence", "movements"],
  PortMovement: ["movementId", "portCallId", "type", "berthId", "tugPoolId", "yardWindowId", "startAt", "endAt", "requiredTugs", "containerUnits", "state", "expiresAt", "startedAt", "completedAt", "clearanceTaskId", "sequence"],
  ResourceAllocation: ["resourceType", "resourceId", "startAt", "endAt", "quantity"],
  StandbyEntry: ["standbyEntryId", "vesselId", "arrivalFrom", "arrivalTo", "durationMinutes", "requiredTugs", "containerUnits", "priority", "state", "requestedAt", "portCallId"],
  Clearance: ["portCallId", "taskId", "attempt", "state", "checkedRules", "completedAt"],
  Work: ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"],
  DomainEvent: ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"],
  FeasibleWindowPage: ["items", "nextCursor"],
});
const NULLABLE_PORT_CALL = Object.freeze(["arrivalAt", "departureAt", "requiredTugs", "containerUnits", "berthId", "tugPoolId", "yardWindowId", "expiresAt", "startedAt", "completedAt"]);

function resolveOpenApiSchema(document, schema, seen = new Set()) {
  assert.ok(schema && typeof schema === "object", "OpenAPI schema is required");
  if (!schema.$ref) return schema;
  assert.match(schema.$ref, /^#\/components\/schemas\/[^/]+$/u, "only local component schema refs are allowed");
  assert.ok(!seen.has(schema.$ref), `cyclic OpenAPI ref ${schema.$ref}`);
  const name = schema.$ref.split("/").at(-1);
  const resolved = document.components?.schemas?.[name];
  assert.ok(resolved, `missing referenced OpenAPI schema ${name}`);
  return resolveOpenApiSchema(document, resolved, new Set([...seen, schema.$ref]));
}
function schemaAllowsNull(document, schema) { const value = resolveOpenApiSchema(document, schema); if (Array.isArray(value.type) && value.type.includes("null")) return true; return [...(value.anyOf ?? []), ...(value.oneOf ?? [])].some((item) => resolveOpenApiSchema(document, item).type === "null"); }
function assertClosedSchema(document, schema, fields, label) { const value = resolveOpenApiSchema(document, schema); assert.equal(value.additionalProperties, false, `${label} additionalProperties`); assert.deepEqual([...(value.required ?? [])].sort(), [...fields].sort(), `${label} required fields`); assert.deepEqual(Object.keys(value.properties ?? {}).sort(), [...fields].sort(), `${label} properties`); return value; }
function resolveOpenApiResponse(document, response) { if (!response?.$ref) return response; assert.match(response.$ref, /^#\/components\/responses\/[^/]+$/u, "local response ref"); const name = response.$ref.split("/").at(-1); const value = document.components?.responses?.[name]; assert.ok(value, `missing OpenAPI response ${name}`); return value; }
function mediaSchema(document, response, label) { const content = resolveOpenApiResponse(document, response)?.content?.["application/json"]; assert.ok(content?.schema, `${label} application/json schema`); return resolveOpenApiSchema(document, content.schema); }
function assertErrorSchema(document, response, label) { const root = assertClosedSchema(document, mediaSchema(document, response, label), ["error"], `${label} error envelope`); const error = assertClosedSchema(document, root.properties.error, ["code", "message", "details"], `${label} error`); assert.equal(resolveOpenApiSchema(document, error.properties.code).type, "string", `${label} error code string`); assert.equal(resolveOpenApiSchema(document, error.properties.message).type, "string", `${label} error message string`); assert.equal(resolveOpenApiSchema(document, error.properties.details).type, "object", `${label} error details object`); }
function operationParameters(pathItem, operation) { return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]; }
function assertIdempotencyHeader(document, pathItem, operation, label) { const headers = operationParameters(pathItem, operation).map((item) => item.$ref ? resolveOpenApiParameter(document, item) : item); const header = headers.find(({ in: location, name }) => location === "header" && name.toLowerCase() === "idempotency-key"); assert.ok(header?.required, `${label} requires Idempotency-Key`); const schema = resolveOpenApiSchema(document, header.schema); assert.equal(schema.type, "string", `${label} Idempotency-Key string`); assert.ok((schema.minLength ?? 0) >= 1 && (schema.maxLength ?? Infinity) <= 128, `${label} Idempotency-Key bounds`); }
function resolveOpenApiParameter(document, parameter) { assert.match(parameter.$ref, /^#\/components\/parameters\/[^/]+$/u, "local parameter ref"); const name = parameter.$ref.split("/").at(-1); const value = document.components?.parameters?.[name]; assert.ok(value, `missing OpenAPI parameter ${name}`); return value; }
function requestSchema(document, operation, label) { const request = operation.requestBody?.$ref ? document.components?.requestBodies?.[operation.requestBody.$ref.split("/").at(-1)] : operation.requestBody; assert.ok(request?.required && request.content?.["application/json"]?.schema, `${label} required JSON body`); return resolveOpenApiSchema(document, request.content["application/json"].schema); }
function assertArrayItems(document, schema, fields, label) { const value = resolveOpenApiSchema(document, schema); assert.equal(value.type, "array", `${label} array`); assertClosedSchema(document, value.items, fields, `${label} item`); }
function assertRequestContract(document, path, operation) {
  const label = `POST ${path}`; const schema = requestSchema(document, operation, label);
  if (path === "/api/v1/port-calls") {
    const alternatives = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].map((item) => resolveOpenApiSchema(document, item)); assert.equal(alternatives.length, 2, `${label} V1 and linked alternatives`);
    const v1 = alternatives.find((item) => Object.hasOwn(item.properties ?? {}, "arrivalAt")); const linked = alternatives.find((item) => Object.hasOwn(item.properties ?? {}, "arrival")); assert.ok(v1 && linked, `${label} both request families`);
    assertClosedSchema(document, v1, ["vesselId", "arrivalAt", "departureAt", "requiredTugs", "containerUnits"], `${label} V1 request`);
    const linkedValue = assertClosedSchema(document, linked, ["vesselId", "arrival", "departure"], `${label} linked request`);
    for (const field of ["arrival", "departure"]) assertClosedSchema(document, linkedValue.properties[field], ["startAt", "endAt", "requiredTugs", "containerUnits"], `${label} ${field}`);
    return;
  }
  if (path === "/api/v1/standby-entries") { assertClosedSchema(document, schema, ["vesselId", "arrivalFrom", "arrivalTo", "durationMinutes", "requiredTugs", "containerUnits", "priority"], `${label} request`); return; }
  if (path.endsWith("/cancel")) { assertClosedSchema(document, schema, ["reason"], `${label} request`); return; }
  assertClosedSchema(document, schema, [], `${label} empty request`);
}
function assertSuccessContract(document, path, method, response) {
  const label = `${method.toUpperCase()} ${path} success`; const schema = mediaSchema(document, response, label);
  if (path === "/api/v1/port-calls" && method === "get") { const page = assertClosedSchema(document, schema, ["items", "nextCursor"], `${label} page`); assertArrayItems(document, page.properties.items, SCHEMAS.PortCall, `${label} items`); return; }
  if (path === "/api/v1/port-calls" || path === "/api/v1/port-calls/{portCallId}" || (path.startsWith("/api/v1/port-calls/{portCallId}/") && !path.includes("/movements/"))) { assertClosedSchema(document, schema, SCHEMAS.PortCall, label); return; }
  if (path.includes("/movements/")) { assertClosedSchema(document, schema, SCHEMAS.PortMovement, label); return; }
  if (path === "/api/v1/standby-entries") { assertClosedSchema(document, schema, SCHEMAS.StandbyEntry, label); return; }
  if (path === "/api/v1/port-resources/feasible-windows") { const page = assertClosedSchema(document, schema, SCHEMAS.FeasibleWindowPage, label); assertArrayItems(document, page.properties.items, ["arrivalAt", "departureAt", "berthId", "tugPoolId", "yardWindowId"], `${label} items`); return; }
  if (path === "/api/v1/domain-events") { const page = assertClosedSchema(document, schema, ["items", "nextCursor"], `${label} page`); assertArrayItems(document, page.properties.items, SCHEMAS.DomainEvent, `${label} items`); return; }
  if (path === "/api/v1/verification-snapshot") { const snapshot = assertClosedSchema(document, schema, ["asOf", "resources", "work", "events"], label); const resources = assertClosedSchema(document, snapshot.properties.resources, ["berths", "tugPools", "yardWindows", "vessels", "portCalls", "resourceAllocations", "standbyEntries", "clearances", "portMovements"], `${label} resources`); assertArrayItems(document, resources.properties.berths, SCHEMAS.Berth, `${label} berths`); assertArrayItems(document, resources.properties.tugPools, SCHEMAS.TugPool, `${label} tugPools`); assertArrayItems(document, resources.properties.yardWindows, SCHEMAS.YardWindow, `${label} yardWindows`); assertArrayItems(document, resources.properties.vessels, SCHEMAS.Vessel, `${label} vessels`); assertArrayItems(document, resources.properties.portCalls, SCHEMAS.PortCall, `${label} portCalls`); assertArrayItems(document, resources.properties.resourceAllocations, SCHEMAS.ResourceAllocation, `${label} allocations`); assertArrayItems(document, resources.properties.standbyEntries, SCHEMAS.StandbyEntry, `${label} standbyEntries`); assertArrayItems(document, resources.properties.clearances, SCHEMAS.Clearance, `${label} clearances`); assertArrayItems(document, resources.properties.portMovements, SCHEMAS.PortMovement, `${label} movements`); assertArrayItems(document, snapshot.properties.work, SCHEMAS.Work, `${label} Work`); assertArrayItems(document, snapshot.properties.events, SCHEMAS.DomainEvent, `${label} Events`); return; }
  const value = resolveOpenApiSchema(document, schema); assert.equal(value.type, "object", `${label} object`); assert.equal(value.additionalProperties, false, `${label} closed schema`);
}

export function dockChainOpenApiRoutes() { return structuredClone(OPENAPI_ROUTES); }
export function assertDockChainOpenApi(document) {
  assert.match(document?.openapi ?? "", /^3\.1(?:\.\d+)?$/u, "OpenAPI 3.1");
  assert.ok(document.paths && typeof document.paths === "object", "OpenAPI paths required");
  assert.ok(document.components?.schemas, "OpenAPI component schemas required");
  for (const [name, fields] of Object.entries(SCHEMAS)) {
    const schema = document.components.schemas[name];
    assert.ok(schema, `missing OpenAPI schema ${name}`);
    assertClosedSchema(document, schema, fields, name);
  }
  const portCall = resolveOpenApiSchema(document, document.components.schemas.PortCall);
  for (const field of NULLABLE_PORT_CALL) assert.ok(schemaAllowsNull(document, portCall.properties[field]), `PortCall.${field} must be nullable`);
  assert.deepEqual([...(resolveOpenApiSchema(document, portCall.properties.state).enum ?? [])].sort(), ["HELD", "CLEARED", "IN_SERVICE", "ARRIVED", "COMPLETED", "CANCELLED", "EXPIRED"].sort(), "PortCall state enum");
  const movement = resolveOpenApiSchema(document, document.components.schemas.PortMovement);
  assert.deepEqual([...(resolveOpenApiSchema(document, movement.properties.type).enum ?? [])].sort(), ["ARRIVAL", "DEPARTURE"].sort(), "PortMovement type enum");
  assert.deepEqual([...(resolveOpenApiSchema(document, movement.properties.state).enum ?? [])].sort(), ["HELD", "CLEARED", "IN_SERVICE", "COMPLETED", "CANCELLED", "EXPIRED"].sort(), "PortMovement state enum");
  for (const field of ["startedAt", "completedAt", "clearanceTaskId"]) assert.ok(schemaAllowsNull(document, movement.properties[field]), `PortMovement.${field} must be nullable`);
  assertArrayItems(document, portCall.properties.movements, SCHEMAS.PortMovement, "PortCall.movements");
  const work = resolveOpenApiSchema(document, document.components.schemas.Work); assert.deepEqual([...(resolveOpenApiSchema(document, work.properties.kind).enum ?? [])].sort(), ["PORT_CALL_EXPIRY", "CLEARANCE", "STANDBY_PROMOTION"].sort(), "Work kind enum"); assert.deepEqual([...(resolveOpenApiSchema(document, work.properties.state).enum ?? [])].sort(), ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].sort(), "Work state enum");
  const allocation = resolveOpenApiSchema(document, document.components.schemas.ResourceAllocation);
  assert.ok(!Object.hasOwn(allocation.properties, "portCallId") && !Object.hasOwn(allocation.properties, "movementId"), "ResourceAllocation has no unpublished owner");
  for (const [path, methods] of Object.entries(OPENAPI_ROUTES)) {
    const pathItem = document.paths[path];
    assert.ok(pathItem, `missing OpenAPI path ${path}`);
    for (const [method, expectedStatuses] of Object.entries(methods)) {
      const operation = pathItem[method];
      assert.ok(operation, `missing OpenAPI operation ${method.toUpperCase()} ${path}`);
      assert.deepEqual(Object.keys(operation.responses ?? {}).sort(), [...expectedStatuses].sort(), `${method.toUpperCase()} ${path} statuses`);
      for (const status of expectedStatuses) {
        const response = operation.responses[status];
        assert.ok(response, `${method.toUpperCase()} ${path} ${status} response`);
        if (Number(status) >= 400) assertErrorSchema(document, response, `${method.toUpperCase()} ${path} ${status}`);
        else assertSuccessContract(document, path, method, response);
      }
      if (method === "post") {
        assertIdempotencyHeader(document, pathItem, operation, `${method.toUpperCase()} ${path}`);
        assertRequestContract(document, path, operation);
      }
    }
  }
  const snapshot = document.paths["/api/v1/verification-snapshot"].get;
  assert.ok(Array.isArray(snapshot.security) && snapshot.security.length > 0, "verification snapshot Bearer security");
  const securityNames = snapshot.security.flatMap((requirement) => Object.keys(requirement));
  assert.ok(securityNames.some((name) => { const scheme = document.components?.securitySchemes?.[name]; return scheme?.type === "http" && scheme.scheme?.toLowerCase() === "bearer"; }), "verification snapshot uses declared HTTP Bearer security scheme");
  return true;
}
