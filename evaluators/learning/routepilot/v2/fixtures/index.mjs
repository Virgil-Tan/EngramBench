import { createHash } from "node:crypto";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `routepilot\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `rp-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ seconds = 0, minutes = 0, hours = 0 } = {}) => new Date(Date.parse(baseTime) + ((hours * 60 + minutes) * 60 + seconds) * 1_000).toISOString();
  const tenant = { tenantId: uuid("tenant"), name: "RoutePilot Tenant" };
  const otherTenant = { tenantId: uuid("other-tenant"), name: "Other Gateway Tenant" };
  const backend = (label, version, origin) => ({ backendId: uuid(`backend:${label}`), tenantId: tenant.tenantId, name: `orders-${version}`, origin, state: "ACTIVE" });
  const rate = { rateLimitPolicyId: uuid("rate"), tenantId: tenant.tenantId, revision: 1, windowSeconds: 60, limit: 10 };
  const circuit = { circuitPolicyId: uuid("circuit"), tenantId: tenant.tenantId, revision: 1, sampleSize: 4, failureThresholdPercent: 50, openSeconds: 3, halfOpenMax: 2 };
  const route = (label, priority, pathPattern, methods, backends) => ({ routeId: uuid(`route:${label}`), tenantId: tenant.tenantId, name: label, priority, revision: { routeRevisionId: uuid(`revision:${label}`), revision: 1, pathPattern, methods, headerMatches: {}, backends, rateLimitPolicyId: rate.rateLimitPolicyId, circuitPolicyId: circuit.circuitPolicyId, createdAt: at() } });
  const emptySeed = (seedVersion, origins = ["http://127.0.0.1:9", "http://127.0.0.1:9"]) => {
    const backends = [backend("v1", "v1", origins[0]), backend("v2", "v2", origins[1])];
    const weighted = backends.map(({ backendId }, index) => ({ backendId, version: `v${index + 1}`, weight: index === 0 ? 8000 : 2000 }));
    const definition = route("orders-param", 100, "/orders/:orderId", ["POST"], weighted);
    const release = { configReleaseId: uuid("release:v1"), tenantId: tenant.tenantId, version: 1, state: "ACTIVE", routeRevisionIds: [definition.revision.routeRevisionId], priorReleaseId: null, createdAt: at(), activatedAt: at() };
    return { seed: { schemaVersion: 1, seedVersion, importedAt: at(), tenants: [tenant, otherTenant], backends, routeDefinitions: [{ routeId: definition.routeId, tenantId: tenant.tenantId, name: definition.name, priority: definition.priority }], routeRevisions: [{ routeRevisionId: definition.revision.routeRevisionId, routeId: definition.routeId, ...definition.revision }], rateLimitPolicies: [rate], circuitPolicies: [circuit], configReleases: [release], gatewayRequests: [], upstreamAttempts: [], rateWindows: [], circuitWindows: [] }, backends, definition, release };
  };
  function contract(origins) { const base = emptySeed(`${caseId.toLowerCase()}-contract`, origins); return { fixtureFamily: "RP-F-CONTRACT", tenant, otherTenant, rate, circuit, ...base }; }
  function routing(origins) {
    const base = emptySeed(`${caseId.toLowerCase()}-routing`, origins); const weights = base.backends.map(({ backendId }, index) => ({ backendId, version: `v${index + 1}`, weight: index === 0 ? 8000 : 2000 }));
    const definitions = [route("orders-literal", 100, "/orders/special", ["POST"], weights), route("orders-param", 100, "/orders/:orderId", ["POST"], weights), route("orders-wild", 100, "/orders/*", ["POST"], weights), route("priority-wild", 200, "/orders/*", ["GET"], weights)];
    base.seed.routeDefinitions = definitions.map(({ revision, ...definition }) => definition); base.seed.routeRevisions = definitions.map(({ routeId, revision }) => ({ routeRevisionId: revision.routeRevisionId, routeId, ...revision })); base.seed.configReleases[0].routeRevisionIds = base.seed.routeRevisions.map(({ routeRevisionId }) => routeRevisionId);
    return { fixtureFamily: "RP-F-ROUTING", tenant, otherTenant, rate, circuit, definitions, ...base };
  }
  function rollout(origins) { const base = emptySeed(`${caseId.toLowerCase()}-rollout`, origins); const target = { ...base.release, configReleaseId: uuid("release:target"), version: 2, state: "PENDING", priorReleaseId: base.release.configReleaseId, createdAt: at({ seconds: 1 }), activatedAt: null }; base.seed.configReleases.push(target); const stages = [{ region: "us-east", minimumObservationSeconds: 10, failureThresholdPercent: 5 }, { region: "eu-west", minimumObservationSeconds: 20, failureThresholdPercent: 10 }, { region: "us-east", minimumObservationSeconds: 99, failureThresholdPercent: 99 }, { region: "ap-south", minimumObservationSeconds: 30, failureThresholdPercent: 15 }]; return { fixtureFamily: "RP-F-ROLLOUT", tenant, otherTenant, rate, circuit, ...base, target, stages, requestRef: `rollout-${caseId.toLowerCase()}` }; }
  function recovery(origins) { return { ...rollout(origins), fixtureFamily: "RP-F-RECOVERY", barriers: ["worker.claimed", "dispatcher.response-received"] }; }
  function layer(origins) { return { ...routing(origins), fixtureFamily: "RP-F-LAYER" }; }
  function operate(origins) { return { ...routing(origins), fixtureFamily: "RP-F-OPERATE", scenarios: ["route-match-steady", "hot-tenant-limit", "breaker-reload-recovery"] }; }
  function v1Final(origins) { const value = emptySeed(`${caseId.toLowerCase()}-v1-final`, origins); return { fixtureFamily: "RP-F-V1-FINAL", tenant, savedReplayKey: key("v1-replay"), ...value }; }
  return Object.freeze({ uuid, key, at, contract, routing, rollout, recovery, layer, operate, v1Final });
}
