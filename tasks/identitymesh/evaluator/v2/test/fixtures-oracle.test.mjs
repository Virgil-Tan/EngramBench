import assert from "node:assert/strict";
import { sign } from "node:crypto";
import test from "node:test";

import { auditCheckpoint, auditSeed, canonical, createFixtureFactory, identityCatalog, v1Seed } from "../lib/fixtures.mjs";
import { assertAuditChain, assertNoSecrets, assertSnapshot, verifyAccessToken } from "../lib/oracle.mjs";

const options = { evaluationSeed: "opaque-evaluation-seed", caseId: "A-04", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixtures, device key material, and closed V1 seed are deterministic", () => {
  const left = createFixtureFactory(options); const right = createFixtureFactory(options);
  const leftCatalog = identityCatalog(left, "fixture"); const rightCatalog = identityCatalog(right, "fixture");
  assert.equal(left.uuid("x"), right.uuid("x"));
  assert.equal(left.key("x"), right.key("x"));
  assert.equal(leftCatalog.material.fingerprint, rightCatalog.material.fingerprint);
  assert.equal(leftCatalog.material.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), rightCatalog.material.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  const seed = v1Seed(left, "fixture", { catalogs: [leftCatalog] });
  assert.deepEqual(Object.keys(seed).sort(), ["auditCheckpoints", "auditEntries", "devices", "importedAt", "revocations", "schemaVersion", "seedVersion", "sessions", "signingKeys", "tenants", "users"]);
});

test("task-local audit oracle recomputes a deterministic per-tenant chain", () => {
  const fixtures = createFixtureFactory(options); const catalog = identityCatalog(fixtures, "audit");
  const entries = auditSeed(fixtures, catalog, 12);
  assert.equal(assertAuditChain(entries), true);
  const checkpoint = auditCheckpoint(catalog, entries);
  assert.equal(checkpoint.sequence, 12);
  assert.equal(checkpoint.digest, entries.at(-1).digest);
  const mutated = structuredClone(entries); mutated[3].payloadDigest = "f".repeat(64);
  assert.throws(() => assertAuditChain(mutated), /digest/u);
});

test("task-local JWT oracle verifies EdDSA signatures from public JWKS", () => {
  const fixtures = createFixtureFactory(options); const material = fixtures.deviceMaterial("jwt");
  const header = { alg: "EdDSA", kid: fixtures.uuid("kid"), typ: "JWT" };
  const payload = { sub: fixtures.uuid("subject"), iat: 2_063_524_800, exp: 2_063_525_100 };
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encoded(header)}.${encoded(payload)}`;
  const token = `${signingInput}.${sign(null, Buffer.from(signingInput), material.privateKey).toString("base64url")}`;
  const result = verifyAccessToken(token, { keys: [{ ...material.publicJwk, kid: header.kid }] });
  assert.equal(result.payload.sub, payload.sub);
});

test("empty FINAL snapshot enforces the V1 union while allowing named Manager resource arrays", () => {
  const resources = { tenants: [], users: [], loginAttempts: [], sessions: [], devices: [], deviceChallenges: [], signingKeys: [], revocations: [], auditEntries: [], auditCheckpoints: [], compromiseIncidents: [], recoveryApprovals: [] };
  assert.equal(assertSnapshot({ asOf: "2035-06-01T12:00:00.000Z", resources, work: [] }), true);
  assertNoSecrets({ resources }, { token: "never-present" });
  assert.equal(canonical({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});
