import Ajv from "ajv/dist/2020.js";
import assert from "node:assert/strict";

export function validator(contract) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat("date-time", (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) return false;
    const [, year, month, day, hour, minute, second, , offsetHour = "0", offsetMinute = "0"] = match;
    const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days[Number(month) - 1]
      && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60 && Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
  });
  return (schema) => ajv.compile({ ...schema, $defs: contract.schemas });
}

export function matchOperation(operations, method, pathname) {
  // A colon inside a literal segment (access-requests:batch) is NOT a parameter.
  for (const operation of operations) {
    if (operation.method !== method) continue;
    const names = [];
    const expression = operation.path.split("/").map((segment) => {
      if (/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) { names.push(segment.slice(1)); return "([^/]+)"; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    const match = new RegExp(`^${expression}$`).exec(pathname);
    if (match) return { operation, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
  }
  return undefined;
}

export function openApi(contract) {
  const paths = {};
  const fixRefs = (value) => JSON.parse(JSON.stringify(value).replaceAll("#/$defs/", "#/components/schemas/"));
  for (const operation of contract.operations) {
    const path = operation.path.replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, "/{$1}");
    const content = operation.request?.contentMediaType ?? "application/json";
    const responseContent = operation.path === "/" ? "text/html" : "application/json";
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: operation.id,
      "x-public-source": operation.source,
      parameters: [...[...operation.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } })), ...(operation.parameters ?? [])],
      ...(operation.request && { requestBody: { required: true, content: { [content]: { schema: fixRefs(operation.request) } } } }),
      responses: {
        ...Object.fromEntries([400, 401, 403, 404, 409, 500].map((status) => [status, {
          description: "Public error envelope; exact business conditions remain defined by README",
          content: { "application/json": { schema: operation.errors?.[status] ? fixRefs(operation.errors[status]) : { $ref: "#/components/schemas/Error" } } },
        }])),
        [operation.status ?? 200]: {
          description: operation.response ? "Published public success shape" : "Success shape not fully specified in the original public text; see contract notes",
          ...(operation.response && { content: { [responseContent]: { schema: fixRefs(operation.response) } } }),
        },
        default: { description: "Application errors must use the public error envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: contract.title, version: "4.0.0-contract-first" }, paths, components: { schemas: fixRefs(contract.schemas) } };
}

export function contains(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => contains(actual[i], item));
  return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && contains(actual[key], value));
}

// Compare public schema constraints, not component names, field ordering or prose.
// The published baseline can be served directly; no OpenAPI generator is mandated.
function referenceTarget(reference, document) {
  assert(reference.startsWith("#/"), `Unsupported public reference: ${reference}`);
  let target = document;
  for (const segment of reference.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(target && Object.hasOwn(target, key), `Unresolved public reference: ${reference}`);
    target = target[key];
  }
  return target;
}

function openApiObject(value, document, seen = new Set()) {
  if (!value?.$ref) return value;
  assert(!seen.has(value.$ref), `Circular OpenAPI reference: ${value.$ref}`);
  const { $ref, ...siblings } = value;
  return { ...openApiObject(referenceTarget($ref, document), document, new Set([...seen, $ref])), ...siblings };
}

function schemaShape(schema, document, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    assert(schema.$ref.startsWith("#/") && !seen.has(schema.$ref), `Unsupported public schema reference: ${schema.$ref}`);
    const target = referenceTarget(schema.$ref, document);
    const base = schemaShape(target, document, new Set([...seen, schema.$ref]));
    const { $ref, ...siblings } = schema;
    const rest = schemaShape(siblings, document, seen);
    return Object.keys(rest).length ? { allOf: [base, rest] } : base;
  }
  const annotations = new Set(["$id", "$schema", "$comment", "$defs", "definitions", "title", "description", "default", "examples", "example", "deprecated", "externalDocs", "xml"]);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !annotations.has(key) && !key.startsWith("x-")).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (["properties", "patternProperties", "dependentSchemas"].includes(key)) value = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaShape(child, document, seen)]));
    else if (["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"].includes(key)) value = schemaShape(value, document, seen);
    else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) value = value.map((child) => schemaShape(child, document, seen));
    if (["required", "enum", "type"].includes(key) && Array.isArray(value)) value = [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [key, value];
  }));
}

export function assertPublicOpenApi(actual, contract) {
  assert.match(actual.openapi, /^3\.1\./);
  const expected = openApi(contract);
  const sameSchema = (actualSchema, expectedSchema, label) => {
    assert(actualSchema !== undefined, `${label}: missing schema`);
    assert.deepEqual(schemaShape(actualSchema, actual), schemaShape(expectedSchema, expected), `${label}: public schema constraints differ`);
  };
  for (const [path, methods] of Object.entries(expected.paths)) for (const [method, operation] of Object.entries(methods)) {
    const pathItem = openApiObject(actual.paths?.[path], actual);
    const live = pathItem?.[method];
    const label = `OpenAPI ${method.toUpperCase()} ${path}`;
    assert(live, `OpenAPI missing ${method.toUpperCase()} ${path}`);
    const status = String(contract.operations.find((op) => op.id === operation.operationId).status ?? 200);
    const response = openApiObject(live.responses?.[status], actual);
    assert(response, `${label}: missing success status ${status}`);
    for (const [mediaType, content] of Object.entries(operation.responses[status].content ?? {})) sameSchema(response.content?.[mediaType]?.schema, content.schema, `${label} response ${status}`);
    if (operation.requestBody) {
      const requestBody = openApiObject(live.requestBody, actual);
      assert.equal(requestBody?.required, true, `${label}: request body must be required`);
      for (const [mediaType, content] of Object.entries(operation.requestBody.content)) sameSchema(requestBody.content?.[mediaType]?.schema, content.schema, `${label} request`);
    }
    for (const parameter of operation.parameters) {
      const liveParameter = [...(pathItem.parameters ?? []), ...(live.parameters ?? [])].map((p) => openApiObject(p, actual)).find((p) => p.name === parameter.name && p.in === parameter.in);
      assert(liveParameter, `${label}: missing ${parameter.in} parameter ${parameter.name}`);
      assert.equal(Boolean(liveParameter.required), Boolean(parameter.required), `${label}: parameter ${parameter.name} required flag`);
      sameSchema(liveParameter.schema, parameter.schema, `${label} parameter ${parameter.name}`);
    }
  }
}
