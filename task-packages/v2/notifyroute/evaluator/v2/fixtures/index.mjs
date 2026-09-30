import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMs(offset = {}) {
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value"; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be a timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed), caseId: String(caseId), baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMs(offset)).toISOString(); },
    key(label) { return `nr-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

function digestContent(channel, subject, body) { return createHash("sha256").update(JSON.stringify({ body, channel, subject })).digest("hex"); }

export function routeFixture(fixtures, options = {}) {
  return {
    routePolicyId: fixtures.uuid(options.label ?? "route-policy"),
    tenantId: fixtures.uuid("tenant"),
    name: options.name ?? "Email then SMS then Webhook",
    revision: options.revision ?? 1,
    steps: options.steps ?? [
      { ordinal: 1, channel: "EMAIL", delaySeconds: 0, maxAttempts: 2, baseRetrySeconds: 1 },
      { ordinal: 2, channel: "SMS", delaySeconds: 0, maxAttempts: 2, baseRetrySeconds: 1 },
      { ordinal: 3, channel: "WEBHOOK", delaySeconds: 0, maxAttempts: 2, baseRetrySeconds: 1 },
    ],
    createdAt: fixtures.at({ days: -2 }),
  };
}

export function notificationFixture(fixtures, options = {}) {
  return {
    tenantId: fixtures.uuid("tenant"),
    recipientId: options.recipientId ?? fixtures.uuid("recipient-0"),
    category: options.category ?? "OPERATIONS",
    dedupeKey: options.dedupeKey ?? fixtures.key("dedupe-0"),
    templateVersionId: options.templateVersionId ?? fixtures.uuid("template-version-1"),
    routePolicyId: options.routePolicyId ?? fixtures.uuid("route-policy"),
    data: options.data ?? {},
  };
}

export function baseSeed(fixtures, options = {}) {
  const tenantId = fixtures.uuid("tenant");
  const recipients = Array.from({ length: options.recipients ?? 16 }, (_, index) => ({
    recipientId: fixtures.uuid(`recipient-${index}`), tenantId, externalRef: `recipient-${index}`, locale: "en-US", timeZone: "UTC", preferenceRevision: 1, createdAt: fixtures.at({ days: -2 }),
  }));
  const channels = ["EMAIL", "SMS", "WEBHOOK"];
  const addresses = ["ada@example.test", "+12025550123", options.webhookUrl ?? "http://127.0.0.1:9/events"];
  const channelEndpoints = channels.map((channel, index) => ({
    endpointId: fixtures.uuid(`endpoint-${channel}`), tenantId, recipientId: recipients[0].recipientId, channel,
    address: addresses[index], state: "ACTIVE", revision: 1, createdAt: fixtures.at({ days: -2 }), terminalAt: null,
  }));
  const templateId = fixtures.uuid("template");
  const templateVersions = [1, 2].map((version) => {
    const channel = options.templateChannel ?? "EMAIL";
    const subject = version === 1 ? "Hello Ada" : "Updated Ada";
    const body = version === 1 ? "Code 042" : "New code 042";
    return { templateVersionId: fixtures.uuid(`template-version-${version}`), templateId, version, channel, subject, body, contentDigest: digestContent(channel, subject, body), createdAt: fixtures.at({ days: -2, seconds: version }) };
  });
  const route = routeFixture(fixtures, { steps: options.routeSteps });
  return {
    schemaVersion: 1,
    seedVersion: `nr-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
    importedAt: fixtures.at({ days: -1 }),
    tenants: [{ tenantId, name: "NotifyRoute Test Tenant", createdAt: fixtures.at({ days: -2 }) }],
    recipients,
    channelEndpoints,
    templates: [{ templateId, tenantId, name: "Operations", createdAt: fixtures.at({ days: -2 }) }],
    templateVersions,
    routePolicies: [route],
    rateLimitPolicies: channels.map((channel, index) => ({
      rateLimitPolicyId: fixtures.uuid(`rate-${channel}`), tenantId, channel, revision: 1, windowSeconds: 60,
      tenantLimit: options.tenantLimit ?? 3, recipientLimit: options.recipientLimit ?? 1, effectiveFrom: fixtures.at({ days: -2, seconds: index }),
    })),
    notifications: options.notifications ?? [],
    deliveries: options.deliveries ?? [],
    deliveryAttempts: options.deliveryAttempts ?? [],
    suppressions: options.suppressions ?? [],
    providerReceipts: options.providerReceipts ?? [],
  };
}

export function providerScript(fixtures, options = {}) {
  return Object.freeze({
    signingSecret: options.signingSecret ?? `nr-secret-${hash(fixtures.evaluationSeed, fixtures.caseId, "secret").toString("hex").slice(0, 24)}`,
    firstOutcome: options.firstOutcome ?? "TIMEOUT",
    providerMessageId: options.providerMessageId ?? `msg-${hash(fixtures.caseId, "message").toString("hex").slice(0, 20)}`,
    providerEventId: options.providerEventId ?? `evt-${hash(fixtures.caseId, "receipt").toString("hex").slice(0, 20)}`,
  });
}
