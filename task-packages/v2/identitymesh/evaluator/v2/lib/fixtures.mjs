import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

function digest(seed, label) {
  return createHash("sha256").update(`${seed}\0${label}`).digest();
}

function uuidFrom(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function ed25519PrivateKey(seed) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([prefix, seed.subarray(0, 32)]), format: "der", type: "pkcs8" });
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("unsupported JSON value");
  return encoded;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function auditDigest(entry) {
  return sha256(Buffer.from(canonical({
    entryId: entry.entryId,
    tenantId: entry.tenantId,
    sequence: entry.sequence,
    eventType: entry.eventType,
    actorRef: entry.actorRef,
    subjectRef: entry.subjectRef,
    occurredAt: entry.occurredAt,
    payloadDigest: entry.payloadDigest,
    priorDigest: entry.priorDigest,
  })));
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const seed = `${evaluationSeed}\0${caseId}`;
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be ISO-8601");
  return Object.freeze({
    seed,
    uuid: (label) => uuidFrom(digest(seed, `uuid:${label}`)),
    key: (label) => `im-${String(label).replace(/[^a-z0-9-]/giu, "-").slice(0, 70)}-${digest(seed, `key:${label}`).toString("hex").slice(0, 18)}`,
    at: ({ milliseconds = 0, seconds = 0 } = {}) => new Date(epoch + milliseconds + seconds * 1_000).toISOString(),
    secret: (label) => `im-secret-${digest(seed, `secret:${label}`).toString("base64url")}`,
    deviceMaterial(label) {
      const privateKey = ed25519PrivateKey(digest(seed, `device-key:${label}`));
      const publicKey = createPublicKey(privateKey);
      const publicJwk = publicKey.export({ format: "jwk" });
      const spki = publicKey.export({ format: "der", type: "spki" });
      return Object.freeze({ privateKey, publicKey, publicJwk, fingerprint: sha256(spki) });
    },
  });
}

export function identityCatalog(fixtures, label = "base", options = {}) {
  const tenant = { tenantId: fixtures.uuid(`${label}:tenant`), name: `Tenant ${label}` };
  const user = {
    userId: fixtures.uuid(`${label}:user`),
    tenantId: tenant.tenantId,
    username: `user-${label}`,
    displayName: `User ${label}`,
    state: "ACTIVE",
    createdAt: fixtures.at(),
  };
  const material = fixtures.deviceMaterial(`${label}:device`);
  const device = {
    deviceId: fixtures.uuid(`${label}:device`),
    tenantId: tenant.tenantId,
    userId: user.userId,
    publicKeyFingerprint: material.fingerprint,
    state: options.deviceState ?? "TRUSTED",
    trustRevision: options.trustRevision ?? 1,
    createdAt: fixtures.at({ seconds: 1 }),
    terminalAt: null,
  };
  return Object.freeze({ tenant, user, device, material, account: providerAccount(fixtures, user) });
}

export function providerAccount(fixtures, user) {
  return { tenantId: user.tenantId, userId: user.userId, username: user.username,
    password: fixtures.secret(`provider-password:${user.userId}`) };
}

export function v1Seed(fixtures, label = "seed", options = {}) {
  const catalogs = options.catalogs ?? [identityCatalog(fixtures, label, options)];
  return {
    schemaVersion: 1,
    seedVersion: options.seedVersion ?? `${label}-${sha256(Buffer.from(fixtures.seed)).slice(0, 16)}`,
    importedAt: options.importedAt ?? fixtures.at(),
    tenants: [...new Map(catalogs.map(({ tenant }) => [tenant.tenantId, tenant])).values()],
    users: [...new Map(catalogs.map(({ user }) => [user.userId, user])).values()],
    devices: catalogs.map(({ device }) => device),
    sessions: options.sessions ?? [],
    signingKeys: options.signingKeys ?? [],
    revocations: options.revocations ?? [],
    auditEntries: options.auditEntries ?? [],
    auditCheckpoints: options.auditCheckpoints ?? [],
  };
}

export function providerCallback(fixtures, catalog, label, outcome, options = {}) {
  if (!options.providerRequestId) throw new TypeError("callback requires the actual providerRequestId");
  return {
    providerCallbackId: options.providerCallbackId ?? `provider-callback-${label}`,
    providerRequestId: options.providerRequestId,
    outcome,
    userId: outcome === "SUCCEEDED" ? catalog.user.userId : null,
    occurredAt: options.occurredAt ?? fixtures.at(),
  };
}

export function loginAttemptBody(catalog) {
  return {
    tenantId: catalog.tenant.tenantId,
    deviceId: catalog.device.deviceId,
    username: catalog.user.username,
    password: catalog.account.password,
  };
}

export function revocationBody(catalog, subjectType, subjectId, options = {}) {
  return {
    tenantId: catalog.tenant.tenantId,
    subjectType,
    subjectId,
    reason: options.reason ?? "hidden-evaluator-security-check",
  };
}

export function secretSentinels(fixtures, label = "surface") {
  return Object.freeze({
    credential: fixtures.secret(`${label}:credential`),
    refreshToken: fixtures.secret(`${label}:refresh-token`),
    nonce: fixtures.secret(`${label}:challenge-nonce`),
    providerAssertion: fixtures.secret(`${label}:provider-assertion`),
    privateKey: fixtures.deviceMaterial(`${label}:private`).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
}

export function auditSeed(fixtures, catalog, count, label = "audit") {
  let priorDigest = null;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const entry = {
      entryId: fixtures.uuid(`${label}:entry:${index}`),
      tenantId: catalog.tenant.tenantId,
      sequence: index + 1,
      eventType: "fixture.security-event",
      actorRef: "hidden-evaluator",
      subjectRef: `${catalog.user.userId}:${index}`,
      occurredAt: fixtures.at({ seconds: index + 10 }),
      payloadDigest: sha256(Buffer.from(canonical({ index, tenantId: catalog.tenant.tenantId }))),
      priorDigest,
      digest: "",
    };
    entry.digest = auditDigest(entry);
    entries.push(entry);
    priorDigest = entry.digest;
  }
  return entries;
}

export function auditCheckpoint(catalog, entries) {
  const latest = entries.at(-1);
  return {
    tenantId: catalog.tenant.tenantId,
    sequence: latest?.sequence ?? 0,
    digest: latest?.digest ?? null,
    createdAt: latest?.occurredAt ?? catalog.user.createdAt,
  };
}
