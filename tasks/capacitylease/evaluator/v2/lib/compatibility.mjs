export const CAPACITYLEASE_CREATE_ENVELOPE_V1 = "capacitylease-create-envelope-v1";

export function assertCompatibilityAdapter(id) {
  if (id !== undefined && id !== CAPACITYLEASE_CREATE_ENVELOPE_V1) {
    throw new Error(`unknown compatibility adapter: ${id}`);
  }
}

export function adaptCompatibilityResponse(id, { method, path, status, json }) {
  if (id === undefined) return json;
  assertCompatibilityAdapter(id);

  const pathname = new URL(path, "http://capacitylease.invalid").pathname;
  if (method === "GET" && pathname === "/openapi.json" && status === 200) {
    return flattenCreateResponseSchemas(json);
  }
  if (method !== "POST" || pathname !== "/api/v1/capacity-leases") return json;
  if (status === 201) return flattenHeldResponse(json);
  if (status === 202 && isObject(json?.admissionEntry)) return json.admissionEntry;
  return json;
}

function flattenHeldResponse(body) {
  if (!isObject(body)) return body;
  const lease = isObject(body.lease)
    ? body.lease
    : isObject(body.capacityLease)
      ? body.capacityLease
      : undefined;
  if (!lease) return body;
  const holdToken = body.holdToken ?? lease.holdToken;
  return holdToken === undefined ? { ...lease } : { ...lease, holdToken };
}

function flattenCreateResponseSchemas(document) {
  if (!isObject(document)) return document;
  const copy = structuredClone(document);
  const schemas = copy.components?.schemas;
  const post = copy.paths?.["/api/v1/capacity-leases"]?.post;
  if (!isObject(schemas?.CapacityLease) || !isObject(schemas?.AdmissionEntry) || !isObject(post?.responses)) {
    return document;
  }

  const lease = schemas.CapacityLease;
  const held = {
    ...structuredClone(lease),
    additionalProperties: false,
    required: [...new Set([...(lease.required ?? []), "holdToken"])],
    properties: {
      ...(lease.properties ?? {}),
      holdToken: { type: "string" },
    },
  };
  setJsonSchema(post.responses["201"], held);
  setJsonSchema(post.responses["202"], { $ref: "#/components/schemas/AdmissionEntry" });
  return copy;
}

function setJsonSchema(response, schema) {
  const media = response?.content?.["application/json"];
  if (isObject(media)) media.schema = schema;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
