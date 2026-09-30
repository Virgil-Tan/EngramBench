import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptCompatibilityResponse,
  CAPACITYLEASE_CREATE_ENVELOPE_V1,
} from "../lib/compatibility.mjs";

const adapt = (status, json) => adaptCompatibilityResponse(CAPACITYLEASE_CREATE_ENVELOPE_V1, {
  method: "POST",
  path: "/api/v1/capacity-leases",
  status,
  json,
});

test("flattens all archived create envelopes without inventing fields", () => {
  const lease = { leaseId: "lease-1", revision: 1 };
  const admissionEntry = { admissionEntryId: "entry-1", state: "WAITING" };
  assert.deepEqual(adapt(201, { lease: { ...lease, holdToken: "token" } }), { ...lease, holdToken: "token" });
  assert.deepEqual(adapt(201, { lease, holdToken: "token" }), { ...lease, holdToken: "token" });
  assert.deepEqual(adapt(201, { capacityLease: lease, holdToken: "token" }), { ...lease, holdToken: "token" });
  assert.deepEqual(adapt(202, { admissionEntry }), admissionEntry);
});

test("rewrites only the create response schemas in OpenAPI", () => {
  const document = {
    components: { schemas: {
      CapacityLease: { type: "object", additionalProperties: false, required: ["leaseId"], properties: { leaseId: { type: "string" } } },
      AdmissionEntry: { type: "object", required: ["admissionEntryId"], properties: { admissionEntryId: { type: "string" } } },
    } },
    paths: { "/api/v1/capacity-leases": { post: { responses: {
      "201": { content: { "application/json": { schema: { type: "object" } } } },
      "202": { content: { "application/json": { schema: { type: "object" } } } },
    } } } },
  };
  const adapted = adaptCompatibilityResponse(CAPACITYLEASE_CREATE_ENVELOPE_V1, {
    method: "GET", path: "/openapi.json", status: 200, json: document,
  });
  assert.deepEqual(adapted.paths["/api/v1/capacity-leases"].post.responses["201"].content["application/json"].schema.required, ["leaseId", "holdToken"]);
  assert.deepEqual(adapted.paths["/api/v1/capacity-leases"].post.responses["202"].content["application/json"].schema, { $ref: "#/components/schemas/AdmissionEntry" });
  assert.notEqual(adapted, document);
});
