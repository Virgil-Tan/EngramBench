import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import { auditDigest, canonical, sha256 } from "./fixtures.mjs";

export { canonical, sha256 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function assertExactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys`);
}

function uuid(value, label = "uuid") { assert.match(value, UUID, label); }
function timestamp(value, label = "timestamp") { assert.match(value, TIMESTAMP, label); }
function hash(value, label = "sha256") { assert.match(value, HASH, label); }
function integer(value, minimum = 0, label = "integer") { assert.ok(Number.isSafeInteger(value) && value >= minimum, label); }

export function assertLoginAttempt(value) {
  assertExactKeys(value, ["loginAttemptId", "tenantId", "deviceId", "providerRequestId", "state", "userId", "sessionId", "createdAt", "resolvedAt", "sequence"], "LoginAttempt");
  ["loginAttemptId", "tenantId", "deviceId"].forEach((key) => uuid(value[key], key));
  assert.ok(typeof value.providerRequestId === "string" && value.providerRequestId.length > 0);
  assert.ok(["STARTED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.state));
  if (value.userId !== null) uuid(value.userId, "userId");
  if (value.sessionId !== null) uuid(value.sessionId, "sessionId");
  timestamp(value.createdAt, "createdAt");
  if (value.resolvedAt !== null) timestamp(value.resolvedAt, "resolvedAt");
  integer(value.sequence, 0, "sequence");
}

export function assertSession(value) {
  assertExactKeys(value, ["sessionId", "tenantId", "userId", "deviceId", "tokenFamilyId", "state", "refreshGeneration", "requiredRevocationVersion", "createdAt", "expiresAt", "revokedAt", "sequence"], "Session");
  ["sessionId", "tenantId", "userId", "deviceId", "tokenFamilyId"].forEach((key) => uuid(value[key], key));
  assert.ok(["ACTIVE", "ROTATING", "REVOKED", "EXPIRED"].includes(value.state));
  integer(value.refreshGeneration, 0, "refreshGeneration");
  integer(value.requiredRevocationVersion, 0, "requiredRevocationVersion");
  timestamp(value.createdAt, "createdAt"); timestamp(value.expiresAt, "expiresAt");
  if (value.revokedAt !== null) timestamp(value.revokedAt, "revokedAt");
  integer(value.sequence, 0, "sequence");
}

export function assertDevice(value) {
  assertExactKeys(value, ["deviceId", "tenantId", "userId", "publicKeyFingerprint", "state", "trustRevision", "createdAt", "terminalAt"], "Device");
  ["deviceId", "tenantId", "userId"].forEach((key) => uuid(value[key], key));
  hash(value.publicKeyFingerprint, "publicKeyFingerprint");
  assert.ok(["PENDING", "TRUSTED", "SUSPENDED", "REVOKED"].includes(value.state));
  integer(value.trustRevision, 0, "trustRevision"); timestamp(value.createdAt, "createdAt");
  if (value.terminalAt !== null) timestamp(value.terminalAt, "terminalAt");
}

export function assertDeviceChallenge(value) {
  assertExactKeys(value, ["challengeId", "deviceId", "userId", "nonceDigest", "state", "expiresAt", "usedAt"], "DeviceChallenge");
  ["challengeId", "deviceId", "userId"].forEach((key) => uuid(value[key], key));
  hash(value.nonceDigest, "nonceDigest");
  assert.ok(["PENDING", "USED", "EXPIRED"].includes(value.state));
  timestamp(value.expiresAt, "expiresAt");
  if (value.usedAt !== null) timestamp(value.usedAt, "usedAt");
}

export function assertSigningKey(value) {
  assertExactKeys(value, ["keyId", "tenantId", "publicJwk", "publicKeyFingerprint", "state", "activatedAt", "retireAt", "retiredAt", "sequence"], "SigningKey");
  uuid(value.keyId, "keyId"); uuid(value.tenantId, "tenantId");
  assert.ok(value.publicJwk && typeof value.publicJwk === "object" && !Array.isArray(value.publicJwk), "publicJwk");
  hash(value.publicKeyFingerprint, "publicKeyFingerprint");
  assert.ok(["GENERATED", "ACTIVE", "RETIRING", "RETIRED"].includes(value.state));
  for (const key of ["activatedAt", "retireAt", "retiredAt"]) if (value[key] !== null) timestamp(value[key], key);
  integer(value.sequence, 0, "sequence");
}

export function assertRevocation(value) {
  assertExactKeys(value, ["revocationId", "tenantId", "subjectType", "subjectId", "version", "state", "createdAt", "propagatedAt"], "Revocation");
  uuid(value.revocationId, "revocationId"); uuid(value.tenantId, "tenantId"); uuid(value.subjectId, "subjectId");
  assert.ok(["SESSION", "DEVICE", "USER", "TENANT"].includes(value.subjectType));
  integer(value.version, 1, "version");
  assert.ok(["REQUESTED", "PROPAGATING", "PROPAGATED"].includes(value.state));
  timestamp(value.createdAt, "createdAt"); if (value.propagatedAt !== null) timestamp(value.propagatedAt, "propagatedAt");
}

export function assertAuditEntry(value) {
  assertExactKeys(value, ["entryId", "tenantId", "sequence", "eventType", "actorRef", "subjectRef", "occurredAt", "payloadDigest", "priorDigest", "digest"], "AuditEntry");
  uuid(value.entryId, "entryId"); uuid(value.tenantId, "tenantId"); integer(value.sequence, 1, "sequence");
  for (const key of ["eventType", "actorRef", "subjectRef"]) assert.ok(typeof value[key] === "string", key);
  timestamp(value.occurredAt, "occurredAt"); hash(value.payloadDigest, "payloadDigest");
  if (value.priorDigest !== null) hash(value.priorDigest, "priorDigest"); hash(value.digest, "digest");
}

export function assertWork(value, final = true) {
  assertExactKeys(value, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work");
  uuid(value.workId, "workId"); uuid(value.aggregateId, "aggregateId");
  const kinds = ["LOGIN_RECONCILIATION", "REVOCATION_PROPAGATION", "KEY_RETIREMENT", "AUDIT_DELIVERY", ...(final ? ["TENANT_QUARANTINE", "TENANT_RECOVERY"] : [])];
  assert.ok(kinds.includes(value.kind), `Work kind ${value.kind}`);
  assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state));
  assert.equal(value.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state), "Work terminal consistency");
  integer(value.attempt, 0, "attempt");
  if (value.state === "LEASED") { assert.ok(typeof value.leaseOwner === "string" && value.leaseOwner.length > 0); timestamp(value.leaseExpiresAt, "leaseExpiresAt"); }
  else { assert.equal(value.leaseOwner, null); assert.equal(value.leaseExpiresAt, null); }
}

function scalarCompare(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

export function assertSorted(items, select, label) {
  const actual = items.map((item) => ({ item, tuple: select(item) }));
  const expected = [...actual].sort((left, right) => {
    for (let index = 0; index < left.tuple.length; index += 1) {
      const order = scalarCompare(left.tuple[index], right.tuple[index]);
      if (order) return order;
    }
    return Buffer.compare(Buffer.from(canonical(left.item)), Buffer.from(canonical(right.item)));
  });
  assert.deepEqual(actual.map(({ item }) => item), expected.map(({ item }) => item), `${label} order`);
}

export function assertAuditChain(entries, { recompute = true } = {}) {
  const groups = Map.groupBy(entries, ({ tenantId }) => tenantId);
  for (const [tenantId, group] of groups) {
    const ordered = [...group].sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index]; assertAuditEntry(entry);
      assert.equal(entry.sequence, index + 1, `${tenantId} sequence`);
      assert.equal(entry.priorDigest, index === 0 ? null : ordered[index - 1].digest, `${tenantId} priorDigest`);
      if (recompute) assert.equal(entry.digest, auditDigest(entry), `${tenantId} digest ${entry.sequence}`);
    }
  }
  return true;
}

export function assertSnapshot(snapshot, { final = true } = {}) {
  assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), "snapshot object");
  timestamp(snapshot.asOf, "snapshot.asOf");
  assert.ok(snapshot.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources), "snapshot.resources");
  const v1Keys = ["tenants", "users", "loginAttempts", "sessions", "devices", "deviceChallenges", "signingKeys", "revocations", "auditEntries", "auditCheckpoints"];
  for (const key of v1Keys) assert.ok(Array.isArray(snapshot.resources[key]), `resources.${key}`);
  const permitted = new Set([...v1Keys, ...(final ? ["compromiseIncidents", "recoveryApprovals"] : [])]);
  assert.ok(Object.keys(snapshot.resources).every((key) => permitted.has(key)), "snapshot resource keys");
  snapshot.resources.loginAttempts.forEach(assertLoginAttempt);
  snapshot.resources.sessions.forEach(assertSession);
  snapshot.resources.devices.forEach(assertDevice);
  snapshot.resources.deviceChallenges.forEach(assertDeviceChallenge);
  snapshot.resources.signingKeys.forEach(assertSigningKey);
  snapshot.resources.revocations.forEach(assertRevocation);
  snapshot.resources.auditEntries.forEach(assertAuditEntry);
  assertSorted(snapshot.resources.tenants, (item) => [item.tenantId], "tenants");
  assertSorted(snapshot.resources.users, (item) => [item.userId], "users");
  assertSorted(snapshot.resources.loginAttempts, (item) => [item.loginAttemptId], "loginAttempts");
  assertSorted(snapshot.resources.sessions, (item) => [item.sessionId], "sessions");
  assertSorted(snapshot.resources.devices, (item) => [item.deviceId], "devices");
  assertSorted(snapshot.resources.deviceChallenges, (item) => [item.challengeId], "deviceChallenges");
  assertSorted(snapshot.resources.signingKeys, (item) => [item.tenantId, item.keyId], "signingKeys");
  assertSorted(snapshot.resources.revocations, (item) => [item.tenantId, item.version], "revocations");
  assertSorted(snapshot.resources.auditEntries, (item) => [item.tenantId, item.sequence], "auditEntries");
  assert.ok(Array.isArray(snapshot.work), "snapshot.work"); snapshot.work.forEach((item) => assertWork(item, final));
  return true;
}

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status);
  assertExactKeys(response.json, ["error"], "error response");
  assertExactKeys(response.json.error, ["code", "message", "details"], "error");
  assert.equal(response.json.error.code, code);
}

export function assertNoSecrets(value, sentinels = {}, label = "public surface") {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(sentinels)) {
    if (sentinel) assert.ok(!encoded.includes(sentinel), `${label} leaked ${name}`);
  }
  assert.doesNotMatch(encoded, /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----|(?:^|["{,])(?:privateKey|privatePath|databaseUrl)["\s]*:/iu, `${label} contains private material or a private path`);
  return true;
}

function decodeBase64Url(value) { return Buffer.from(value, "base64url"); }

export function verifyAccessToken(token, jwks, options = {}) {
  assert.equal(typeof token, "string", "access token");
  const segments = token.split("."); assert.equal(segments.length, 3, "compact JWS");
  const header = JSON.parse(decodeBase64Url(segments[0]));
  const payload = JSON.parse(decodeBase64Url(segments[1]));
  assert.ok(typeof header.kid === "string" && header.kid.length > 0, "JWT kid");
  const keys = Array.isArray(jwks) ? jwks : jwks?.keys;
  assert.ok(Array.isArray(keys), "JWKS keys");
  const jwk = keys.find((item) => item.kid === header.kid || item.keyId === header.kid);
  assert.ok(jwk, `JWKS contains ${header.kid}`);
  const publicKey = createPublicKey({ key: { ...jwk, kid: undefined, keyId: undefined }, format: "jwk" });
  const algorithm = header.alg === "EdDSA" ? null : header.alg === "RS256" ? "RSA-SHA256" : "sha256";
  assert.ok(verifySignature(algorithm, Buffer.from(`${segments[0]}.${segments[1]}`), publicKey, decodeBase64Url(segments[2])), "access-token signature");
  integer(payload.iat, 0, "iat");
  if (payload.exp !== undefined) assert.ok(Number.isSafeInteger(payload.exp) && payload.exp > payload.iat, "exp after iat");
  if (options.issuedBefore !== undefined) assert.ok(payload.iat * 1_000 < Date.parse(options.issuedBefore), "token issued before retirement boundary");
  return { header, payload, jwk };
}

export function openApiOperation(document, method, path) {
  assert.ok(document?.paths?.[path]?.[method.toLowerCase()], `OpenAPI ${method} ${path}`);
  return document.paths[path][method.toLowerCase()];
}

export function assertOpenApiV1(document) {
  const operations = [
    ["POST", "/api/v1/tenants"], ["POST", "/api/v1/users"], ["POST", "/api/v1/login-attempts"],
    ["POST", "/api/v1/provider/callbacks"], ["POST", "/api/v1/login-attempts/{attemptId}/reconcile"],
    ["POST", "/api/v1/sessions/{sessionId}/refresh"], ["POST", "/api/v1/sessions/{sessionId}/revoke"], ["GET", "/api/v1/sessions"],
    ["POST", "/api/v1/devices/register"], ["POST", "/api/v1/devices/{deviceId}/challenges"],
    ["POST", "/api/v1/device-challenges/{challengeId}/approve"], ["POST", "/api/v1/devices/{deviceId}/revoke"],
    ["POST", "/api/v1/signing-keys/rotate"], ["GET", "/api/v1/signing-keys/jwks"], ["POST", "/api/v1/revocations"],
    ["GET", "/api/v1/audit/verify"], ["GET", "/api/v1/audit"], ["GET", "/api/v1/verification-snapshot"],
  ];
  for (const [method, path] of operations) openApiOperation(document, method, path);
  return true;
}

export function bodyDigest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
