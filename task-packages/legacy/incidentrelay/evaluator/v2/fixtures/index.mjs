import { createHash } from "node:crypto";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `incidentrelay\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `ir-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ milliseconds = 0, seconds = 0, minutes = 0, hours = 0 } = {}) => new Date(Date.parse(baseTime) + (((hours * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds).toISOString();

  function contract(deliveryUrls = []) {
    const responders = Array.from({ length: 3 }, (_, index) => ({ responderId: uuid(`responder:${index}`), name: `Responder ${index + 1}`, deliveryUrl: deliveryUrls[index] ?? `http://127.0.0.1:${45_000 + index}/notifications` }));
    const policyV1 = { policyId: uuid("policy:v1"), version: 1, steps: responders.map(({ responderId }, stepIndex) => ({ stepIndex, delaySeconds: stepIndex * 10, responderId })), expireAfterSeconds: 120 };
    const service = { serviceId: uuid("service"), name: "Payments API", currentPolicyId: policyV1.policyId, currentPolicyVersion: 1 };
    const policyGroup = { policyId: uuid("policy:group"), version: 2, steps: [{ stepIndex: 0, delaySeconds: 0, responderIds: responders.map(({ responderId }) => responderId), quorumRequired: 2 }, { stepIndex: 1, delaySeconds: 20, responderIds: responders.slice(1).map(({ responderId }) => responderId), quorumRequired: 1 }], expireAfterSeconds: 180 };
    const seed = { schemaVersion: 1, seedVersion: `${caseId.toLowerCase()}-seed`, services: [service], responders, escalationPolicies: [policyV1], incidents: [], escalationSteps: [], notificationDeliveries: [] };
    return { fixtureFamily: "IR-F-POLICY", service, responders, policyV1, policyGroup, seed };
  }

  function incidentBody(label, overrides = {}) { return { serviceId: overrides.serviceId ?? contract().service.serviceId, dedupKey: overrides.dedupKey ?? `dedup-${label}`, severity: overrides.severity ?? "HIGH", title: overrides.title ?? `Incident ${label}`, details: overrides.details ?? "A deterministic production incident", ...Object.fromEntries(Object.entries(overrides).filter(([name]) => !["serviceId", "dedupKey", "severity", "title", "details"].includes(name))) }; }
  function family(name, deliveryUrls = []) { const value = contract(deliveryUrls); return { ...value, fixtureFamily: `IR-F-${name}`, incidentBody: (label, overrides = {}) => incidentBody(label, { serviceId: value.service.serviceId, ...overrides }) }; }
  function empty() { const fixture = family("EMPTY"); fixture.seed = { ...fixture.seed, services: [], responders: [], escalationPolicies: [] }; return fixture; }
  function policy(deliveryUrls = []) { return family("POLICY", deliveryUrls); }
  function incident(deliveryUrls = []) { return family("INCIDENT", deliveryUrls); }
  function notification(deliveryUrls = []) { return { ...family("NOTIFICATION", deliveryUrls), outcomes: [204, 500, "disconnect", "timeout"] }; }
  function idempotency(deliveryUrls = []) { return family("IDEMPOTENCY", deliveryUrls); }
  function contention(deliveryUrls = []) { return { ...family("CONTENTION", deliveryUrls), interleavings: ["create-create", "ack-resolve-expire", "quorum-quorum"] }; }
  function quorum(deliveryUrls = []) { const value = family("QUORUM", deliveryUrls); return { ...value, groupPolicyBody: { expectedCurrentVersion: 1, steps: value.policyGroup.steps, expireAfterSeconds: value.policyGroup.expireAfterSeconds } }; }
  function work(deliveryUrls = []) { return { ...quorum(deliveryUrls), fixtureFamily: "IR-F-WORK", barriers: ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"] }; }
  function event(deliveryUrls = []) { return { ...family("EVENT", deliveryUrls), webhookOutcomes: [500, "disconnect", 204] }; }
  function migration(deliveryUrls = []) { return { ...family("MIGRATION", deliveryUrls), savedReplayKey: key("v1-replay") }; }
  function browser(deliveryUrls = []) { return { ...quorum(deliveryUrls), fixtureFamily: "IR-F-BROWSER" }; }
  function performance() { return { fixtureFamily: "IR-F-PERF-V1", serviceCount: 1_000, responderCount: 10_000, policyCount: 1_000, incidentCount: 100_000, escalationStepCount: 300_000, recoveryDueCount: 3_000, scenarios: ["deduplicated-incident-ingest", "incident-timeline-read", "escalation-recovery"] }; }
  return Object.freeze({ uuid, key, at, incidentBody, empty, policy, incident, notification, idempotency, contention, quorum, work, event, migration, browser, performance });
}
