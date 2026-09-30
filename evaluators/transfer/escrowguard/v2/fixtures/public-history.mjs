import assert from "node:assert/strict";

// Test-side preconditions only. The application must create all Work and Events.
// Seed/migration/performance cases deliberately retain their original setup.
export const ESCROWGUARD_PUBLIC_HISTORY_CASES = Object.freeze(["A-08", "A-09", "B-01", "B-02", "B-04", "B-06", "C-07", "D-03"]);
const registered = new WeakMap();
const escrowBusiness = ["buyerId", "sellerId", "currency", "totalMinor", "availableMinor", "releasedMinor", "refundedMinor", "state", "expiresAt", "sequence"];
const milestoneBusiness = ["ordinal", "title", "amountMinor", "state"];
const values = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

export function registerEscrowGuardHistoryFixture(fixture) {
  registered.set(fixture.escrow, fixture);
  return fixture;
}

function responseJson(response, status, step) {
  assert.equal(response.status, status, `public-history setup ${step}: ${response.text ?? ""}`);
  assert.ok(response.json && typeof response.json === "object", `public-history setup ${step}: JSON object`);
  return response.json;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)), `public-history setup ${label}: timestamp`);
  return value;
}

function identity(value, label) {
  assert.match(value ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, `public-history setup ${label}: UUID`);
  return value;
}

export function prepareEscrowGuardPublicHistory(ctx, seed) {
  if (!ESCROWGUARD_PUBLIC_HISTORY_CASES.includes(ctx.caseId) || !seed?.escrows?.length) {
    return { seed, async replay() {} };
  }
  // Fail closed before importing anything: this fixture supports only FUNDED
  // and first-Milestone SUBMITTED histories, without release/dispute synthesis.
  assert.deepEqual(seed.disputes, [], "public-history setup does not reconstruct Disputes");
  assert.deepEqual(seed.releases, [], "public-history setup does not reconstruct Releases");
  const plans = seed.escrows.map((escrow) => {
    const fixture = registered.get(escrow);
    assert.ok(fixture && fixture.escrowId === escrow.escrowId, "public-history setup requires registered fixture identity");
    assert.ok(["FUNDED", "ACTIVE"].includes(escrow.state), "public-history setup unsupported Escrow state");
    assert.ok(Date.parse(escrow.expiresAt) > Date.now(), "public-history setup does not rewrite expiry deadlines");
    const states = fixture.milestones.map(({ state }) => state);
    assert.ok(states.length > 0 && states.slice(1).every((state) => state === "PENDING") && ["PENDING", "SUBMITTED"].includes(states[0]), "public-history setup unsupported Milestone history");
    const selected = seed.milestones.filter(({ escrowId }) => escrowId === escrow.escrowId);
    assert.deepEqual(selected, fixture.milestones, "public-history setup seed/fixture Milestone identity mismatch");
    return { fixture, expectedEscrow: structuredClone(escrow), expectedMilestones: structuredClone(fixture.milestones) };
  });
  return {
    seed: { ...seed, escrows: [], milestones: [], disputes: [], releases: [] },
    async replay(api) {
      const createdEscrowIds = new Set();
      for (const { fixture, expectedEscrow, expectedMilestones } of plans) {
        const body = {
          ...values(expectedEscrow, ["buyerId", "sellerId", "currency", "totalMinor", "expiresAt"]),
          milestones: expectedMilestones.map((milestone) => values(milestone, ["title", "amountMinor"])),
        };
        const created = responseJson(await ctx.mutate(api.baseUrl, "/api/v1/escrows", ctx.key(`history-setup-create:${expectedEscrow.escrowId}`), body), 201, "create");
        const createdEscrow = created;
        const escrowId = identity(createdEscrow.escrowId, "created Escrow");
        assert.ok(!createdEscrowIds.has(escrowId), "public-history setup unique Escrow identities");
        createdEscrowIds.add(escrowId);
        assert.deepEqual(values(createdEscrow, escrowBusiness), {
          ...values(expectedEscrow, escrowBusiness), availableMinor: expectedEscrow.totalMinor,
          releasedMinor: 0, refundedMinor: 0, state: "FUNDED", sequence: 1,
        }, "public-history setup creation business state");
        const readDetail = async () => responseJson(await ctx.request(api.baseUrl, `/api/v1/escrows/${escrowId}`), 200, "detail");
        let detail = await readDetail();
        assert.ok(Array.isArray(detail.milestones), "public-history setup detail Milestones");
        assert.equal(detail.milestones.length, expectedMilestones.length, "public-history setup created Milestone count");
        for (const [index, expected] of expectedMilestones.entries()) {
          assert.deepEqual(values(detail.milestones[index], milestoneBusiness), { ...values(expected, milestoneBusiness), state: "PENDING" }, "public-history setup created Milestone body/order");
        }
        if (expectedMilestones[0].state === "SUBMITTED") {
          const milestoneId = identity(detail.milestones[0].milestoneId, "created Milestone");
          // The public route publishes {evidence}; one fixed object is used for
          // every submission, with no candidate-specific schema guessing/retry.
          responseJson(await ctx.mutate(api.baseUrl, `/api/v1/escrows/${escrowId}/milestones/${milestoneId}/submit`, ctx.key(`history-setup-submit:${expectedEscrow.escrowId}`), { evidence: {} }), 200, "submit");
          detail = await readDetail();
        }
        const observedEscrow = detail;
        assert.deepEqual(values(observedEscrow, escrowBusiness), values(expectedEscrow, escrowBusiness), "public-history setup intended Escrow state and sequence");
        assert.equal(detail.milestones.length, expectedMilestones.length, "public-history setup final Milestone count");
        const observedIdentities = new Set();
        const milestoneUpdates = expectedMilestones.map((expected, index) => {
          const observed = detail.milestones[index];
          assert.deepEqual(values(observed, milestoneBusiness), values(expected, milestoneBusiness), "public-history setup intended Milestone state/order/amount");
          assert.equal(observed.escrowId, escrowId, "public-history setup Milestone parent identity");
          const milestoneId = identity(observed.milestoneId, "observed Milestone");
          assert.ok(!observedIdentities.has(milestoneId), "public-history setup unique Milestone identities");
          observedIdentities.add(milestoneId);
          assert.equal(observed.submittedAt === null, expected.submittedAt === null, "public-history setup submitted timestamp presence");
          assert.equal(observed.decidedAt, null, "public-history setup has no decision");
          assert.equal(observed.releasedAt, null, "public-history setup has no release");
          return { milestoneId, escrowId, submittedAt: timestamp(observed.submittedAt, "submittedAt", { nullable: true }), decidedAt: null, releasedAt: null };
        });
        assert.equal(observedEscrow.terminalAt, null, "public-history setup nonterminal Escrow");
        const createdAt = timestamp(observedEscrow.createdAt, "createdAt");
        // Only identities and application-produced timestamps are rebound.
        // Never copy observed business expectations, Work, Events or counters.
        fixture.escrowId = escrowId;
        Object.assign(fixture.escrow, { escrowId, createdAt });
        fixture.milestones.forEach((milestone, index) => Object.assign(milestone, milestoneUpdates[index]));
        ctx.mark?.("escrowguard.public-history-setup", { fixture: "public-history", sourceFixtureEscrowId: expectedEscrow.escrowId, actualEscrowId: escrowId, publicMutations: expectedMilestones[0].state === "SUBMITTED" ? 2 : 1, workOrEventsSynthesized: false });
      }
    },
  };
}
