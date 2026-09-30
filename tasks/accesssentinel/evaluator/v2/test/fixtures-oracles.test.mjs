import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import {
  breakGlassOracle, canonicalJson, grantAuthorityOracle, locationOracle, policyEffect, riskOracle, sha256Hex,
} from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "fixture-test", caseId: "B-05", baseTime: "2035-06-01T12:00:00.000Z" });

test("task-local fixture families are deterministic and linked", () => {
  const first = fixtures.identity();
  const second = fixtures.identity();
  assert.deepEqual(first.seed, second.seed);
  assert.equal(first.session.principalId, first.requester.principalId);
  assert.equal(first.device.deviceId, first.session.deviceId);
  assert.equal(first.policyBundle.currentPolicyRevisionId, first.policyRevision.policyRevisionId);
  assert.equal(first.fixtureFamily, "AS-F-IDENTITY");
  assert.equal(fixtures.performance().scenarios["access-decision-ingest"].operations, 500_000);
});

test("canonical JSON and policy/risk oracles are independent and deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  assert.equal(sha256Hex(canonicalJson({ a: 1 })), sha256Hex(canonicalJson({ a: 1 })));
  const family = fixtures.policyRisk();
  assert.equal(policyEffect(family.denyRules, { action: "deploy", resource: "production/secrets/key", region: "us-east", assurance: 3 }), "DENY");
  assert.deepEqual(riskOracle({ model: family.riskModelRevision, policy: "ALLOW", sessionAgeSeconds: 100, locationAgeSeconds: 100, requestRegion: "us-east", locationRegion: "us-east" }), { score: 0, level: "LOW", reasons: [], policyEffect: "ALLOW" });
});

test("location replay handles duplicates, late data and an offline projection", () => {
  const family = fixtures.location();
  const arrival = new Map();
  const observations = family.schedule.map((item, index) => {
    if (!arrival.has(item.deviceSequence)) arrival.set(item.deviceSequence, index);
    return { observationId: family.uuid(`test-location:${item.deviceSequence}`), acceptedAt: family.at({ seconds: arrival.get(item.deviceSequence) }), ...item };
  });
  observations.splice(2, 0, structuredClone(observations[1]));
  const result = locationOracle(observations, { maxTravelKph: family.riskModelRevision.maxTravelKph });
  assert.equal(result.ordered.length, 4);
  assert.equal(result.tooLate.length, 1);
  assert.equal(result.projection.lastSequence, 4);
});

test("grant and BreakGlass authority fail closed across frozen fences", () => {
  const family = fixtures.access();
  const request = { policyRevisionId: family.policyRevision.policyRevisionId, sessionId: family.session.sessionId, principalId: family.requester.principalId, deviceId: family.device.deviceId, region: "us-east", tenantRevocationEpoch: 0, principalRevocationEpoch: 0, sessionGeneration: 1, deviceTrustRevisionId: family.trust.deviceTrustRevisionId };
  const grant = { state: "ACTIVE", notBefore: family.at({ minutes: -1 }), expiresAt: family.at({ minutes: 1 }), policyRevisionId: request.policyRevisionId, sessionId: request.sessionId, principalId: request.principalId, deviceId: request.deviceId, region: request.region };
  const current = { tenantEpoch: 0, principalEpoch: 0, sessionGeneration: 1, trustRevisionId: family.trust.deviceTrustRevisionId, regionQuarantined: false };
  assert.equal(grantAuthorityOracle({ grant, request, current, now: family.at() }).active, true);
  assert.equal(grantAuthorityOracle({ grant, request, current: { ...current, tenantEpoch: 1 }, now: family.at() }).active, false);
  const breakGlass = { requiredApprovals: 2, state: "ACTIVE", notBefore: family.at({ minutes: -1 }), expiresAt: family.at({ minutes: 1 }), region: "us-east", actions: ["deploy"], resourcePatterns: ["production/*"] };
  const approvals = [family.reviewerA, family.reviewerB].map(({ principalId: approverId }) => ({ approverId, decision: "APPROVE" }));
  assert.equal(breakGlassOracle({ session: breakGlass, approvals, requesterId: family.requester.principalId, now: family.at(), check: { region: "us-east", action: "deploy", resource: "production/app" }, current: { tenant: true, principal: true, device: true, session: true, trust: true } }).authorized, true);
});
