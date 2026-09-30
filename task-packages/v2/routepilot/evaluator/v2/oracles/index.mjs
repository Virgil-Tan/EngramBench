import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("value is not canonical JSON");
}

export function normalizePath(path) {
  assert.equal(typeof path, "string", "path must be a string");
  assert.ok(path.startsWith("/"), "path must be absolute");
  const rawPath = path.split(/[?#]/u, 1)[0];
  assert.ok(!rawPath.includes("//"), "repeated slash is invalid");
  assert.ok(!/%2f/iu.test(rawPath), "encoded slash is invalid");
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { assert.fail("invalid percent encoding"); }
  assert.ok(!decoded.split("/").some((part) => part === "." || part === ".."), "dot traversal is invalid");
  return decoded;
}

export function parsePattern(pattern) {
  const normalized = normalizePath(pattern);
  const segments = normalized.split("/").slice(1);
  let wildcard = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    assert.ok(segment.length > 0, "empty route segment");
    if (segment === "*") { assert.equal(index, segments.length - 1, "wildcard must be terminal"); wildcard = true; continue; }
    assert.ok(!segment.includes("*"), "wildcard occupies a complete segment");
    if (segment.startsWith(":")) assert.match(segment, /^:[A-Za-z][A-Za-z0-9_]*$/u, "invalid parameter name");
  }
  return { normalized, segments, wildcard };
}

export function routeSpecificity(pattern) {
  return parsePattern(pattern).segments.map((segment) => segment === "*" ? 1 : segment.startsWith(":") ? 2 : 3);
}

export function compareSpecificity(leftPattern, rightPattern) {
  const left = routeSpecificity(leftPattern), right = routeSpecificity(rightPattern);
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function matchPattern(pattern, path) {
  const route = parsePattern(pattern).segments;
  const actual = normalizePath(path).split("/").slice(1);
  const parameters = {};
  for (let index = 0; index < route.length; index += 1) {
    const segment = route[index];
    if (segment === "*") { parameters.wildcard = actual.slice(index).join("/"); return { matched: true, parameters }; }
    if (actual[index] === undefined) return { matched: false, parameters: {} };
    if (segment.startsWith(":")) parameters[segment.slice(1)] = actual[index];
    else if (segment !== actual[index]) return { matched: false, parameters: {} };
  }
  return { matched: route.length === actual.length, parameters: route.length === actual.length ? parameters : {} };
}

export function chooseRoute(routes, request) {
  const method = request.method.toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const matches = routes.filter((route) => route.methods.includes(method) && matchPattern(route.pathPattern, request.path).matched && Object.entries(route.headerMatches).every(([name, value]) => headers[name.toLowerCase()] === value));
  matches.sort((left, right) => right.priority - left.priority || compareSpecificity(right.pathPattern, left.pathPattern) || left.routeId.localeCompare(right.routeId));
  return matches[0] ?? null;
}

export function canaryBucket(tenantId, routeRevisionId, affinityKey) {
  const hex = createHash("sha256").update(`${tenantId}\n${routeRevisionId}\n${affinityKey}`).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) % 10_000;
}

export function chooseBackend(backends, bucket) {
  assert.equal(backends.reduce((sum, backend) => sum + backend.weight, 0), 10_000, "weights must sum to 10000");
  let upper = 0;
  for (const backend of backends) { upper += backend.weight; if (bucket < upper) return backend; }
  assert.fail("bucket did not select a backend");
}

export function rateWindowStart(epochMs, windowSeconds) { const size = windowSeconds * 1_000; return new Date(Math.floor(epochMs / size) * size).toISOString(); }
export function expectedRateDecisions({ eligible, limit, alreadyConsumed = 0 }) { const allowed = Math.max(0, Math.min(eligible, limit - alreadyConsumed)); return { allowed, throttled: eligible - allowed, consumed: alreadyConsumed + allowed }; }

export function circuitTransition(window, outcome, nowMs, policy) {
  const current = structuredClone(window);
  if (current.state === "OPEN" && nowMs < Date.parse(current.openUntil)) return { ...current, admit: false };
  if (current.state === "OPEN") Object.assign(current, { state: "HALF_OPEN", sampleCount: 0, failureCount: 0 });
  if (current.state === "HALF_OPEN" && current.sampleCount >= policy.halfOpenMax) return { ...current, admit: false };
  current.sampleCount += 1;
  if (["FAILED", "TIMEOUT"].includes(outcome)) current.failureCount += 1;
  if (current.state === "HALF_OPEN") {
    if (outcome !== "SUCCEEDED") Object.assign(current, { state: "OPEN", openUntil: new Date(nowMs + policy.openSeconds * 1_000).toISOString() });
    else if (current.sampleCount === policy.halfOpenMax) Object.assign(current, { state: "CLOSED", sampleCount: 0, failureCount: 0, epoch: current.epoch + 1, openUntil: null });
  } else if (current.sampleCount >= policy.sampleSize && current.failureCount * 100 >= policy.failureThresholdPercent * current.sampleCount) {
    Object.assign(current, { state: "OPEN", openUntil: new Date(nowMs + policy.openSeconds * 1_000).toISOString() });
  }
  return { ...current, admit: true };
}

export function freezeStages(stages, priorConfigReleaseId, targetConfigReleaseId) {
  const seen = new Set(); const result = [];
  for (const stage of stages) if (!seen.has(stage.region)) { seen.add(stage.region); result.push({ ordinal: result.length, region: stage.region, minimumObservationSeconds: stage.minimumObservationSeconds, failureThresholdPercent: stage.failureThresholdPercent, priorConfigReleaseId, targetConfigReleaseId }); }
  return result;
}

export function assertEventSequence(events) {
  const last = new Map();
  for (const event of events) { const expected = (last.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, expected, `${event.aggregateId} Event sequence`); last.set(event.aggregateId, event.sequence); }
  return true;
}

export function assertReleaseAuthority(releases) { const byTenant = new Map(); for (const release of releases.filter(({ state }) => state === "ACTIVE")) { assert.ok(!byTenant.has(release.tenantId), `${release.tenantId} has multiple ACTIVE releases`); byTenant.set(release.tenantId, release.configReleaseId); } return true; }
export function assertRequestIdentity(requests, attempts) { assert.equal(new Set(requests.map(({ requestKey, tenantId }) => `${tenantId}\0${requestKey}`)).size, requests.length, "duplicate request key identity"); assert.equal(new Set(attempts.map(({ gatewayRequestId, attempt }) => `${gatewayRequestId}\0${attempt}`)).size, attempts.length, "duplicate upstream attempt identity"); return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }

export function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must use the closed public shape`);
}

export function assertNoSecrets(value, secrets = []) {
  const serialized = canonicalJson(value).toLowerCase();
  for (const secret of secrets.filter(Boolean)) assert.equal(serialized.includes(String(secret).toLowerCase()), false, "public output contains a secret");
  assert.equal(/database_url|admin_token|authorization|cookie|\/submission|\/private/iu.test(serialized), false, "public output exposes a private name or path");
}
