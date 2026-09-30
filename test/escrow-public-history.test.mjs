import assert from "node:assert/strict";
import { makeEscrowFixture } from "../evaluators/transfer/escrowguard/v2/fixtures/index.mjs";
import { ESCROWGUARD_PUBLIC_HISTORY_CASES, prepareEscrowGuardPublicHistory, registerEscrowGuardHistoryFixture } from "../evaluators/transfer/escrowguard/v2/fixtures/public-history.mjs";

const baseTime = new Date(Date.now() + 86_400_000).toISOString();
const options = { evaluationSeed: "a".repeat(64), caseId: "A-08", baseTime };
const make = (overrides = {}) => registerEscrowGuardHistoryFixture(makeEscrowFixture(options, { amounts: [30, 70], states: ["SUBMITTED", "PENDING"], ...overrides }));
const actualEscrowId = "11111111-1111-4111-8111-111111111111";
const actualMilestoneIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const createdAt = new Date().toISOString();
const serializable = (fixture) => JSON.parse(JSON.stringify(fixture));

function appContext(fixture, { caseId = "A-08", corruptFinal = false, rejectSubmit = false, escrowIdentity = actualEscrowId, milestoneIdentities = actualMilestoneIds } = {}) {
  const calls = [];
  const observed = serializable(fixture);
  const escrow = { ...observed.escrow, escrowId: escrowIdentity, state: "FUNDED", sequence: 1, createdAt };
  const milestones = observed.milestones.map((milestone, index) => ({ ...milestone, milestoneId: milestoneIdentities[index], escrowId: escrowIdentity, state: "PENDING", submittedAt: null }));
  return {
    caseId, calls, key: (label) => label,
    async mutate(baseUrl, path, key, body) {
      calls.push({ baseUrl, path, key, body });
      if (path === "/api/v1/escrows") return { status: 201, json: structuredClone(escrow) };
      assert.equal(path, `/api/v1/escrows/${escrowIdentity}/milestones/${milestoneIdentities[0]}/submit`);
      if (rejectSubmit) return { status: 400, json: { error: "INVALID_REQUEST" }, text: "submission rejects setup evidence" };
      assert.deepEqual(body, { evidence: {} });
      escrow.state = "ACTIVE"; escrow.sequence = 2;
      if (corruptFinal) escrow.availableMinor -= 1;
      milestones[0].state = "SUBMITTED"; milestones[0].submittedAt = createdAt;
      return { status: 200, json: { escrow, milestone: milestones[0] } };
    },
    async request(baseUrl, path) {
      calls.push({ baseUrl, path });
      assert.equal(path, `/api/v1/escrows/${escrowIdentity}`);
      return { status: 200, json: structuredClone({ ...escrow, milestones }) };
    },
  };
}

const fixture = make();
const before = serializable(fixture);
const ctx = appContext(fixture);
const setup = prepareEscrowGuardPublicHistory(ctx, fixture.seed);
assert.deepEqual(setup.seed, { ...fixture.seed, escrows: [], milestones: [], disputes: [], releases: [] });
assert.equal(setup.seed.parties, fixture.seed.parties);
assert.equal(fixture.escrowId, before.escrowId, "fixture not rebound before actual API execution");
await setup.replay({ baseUrl: "http://actual-api" });
assert.equal(fixture.escrowId, actualEscrowId);
assert.equal(fixture.seed.escrows[0].escrowId, actualEscrowId, "same fixture seed references rebound");
assert.deepEqual(fixture.milestones.map(({ milestoneId }) => milestoneId), actualMilestoneIds);
assert.equal(fixture.escrow.availableMinor, before.escrow.availableMinor);
assert.equal(fixture.escrow.sequence, before.escrow.sequence);
assert.equal(fixture.escrow.state, before.escrow.state);
assert.equal(fixture.escrow.createdAt, createdAt);
assert.equal(fixture.milestones[0].submittedAt, createdAt);
assert.equal(ctx.calls.filter(({ body }) => body).length, 2, "only actual create and submit mutations");
assert.ok(ctx.calls.every(({ path }) => path.startsWith("/api/v1/escrows")), "no internal SQL or Work/Event endpoint");
assert.deepEqual(ESCROWGUARD_PUBLIC_HISTORY_CASES, ["A-08", "A-09", "B-01", "B-02", "B-04", "B-06", "C-07", "D-03"]);

for (const caseId of ["A-02", "A-03", "A-07", "A-15", "E-01", "E-02", "E-03", "E-04", "E-05", "E-06", "E-07", "C-01", "C-02"]) {
  const original = make(); const unsupported = prepareEscrowGuardPublicHistory({ caseId }, original.seed);
  assert.equal(unsupported.seed, original.seed, `${caseId} original seed retained`);
  await unsupported.replay();
}
const broken = make(); const brokenBefore = serializable(broken);
await assert.rejects(prepareEscrowGuardPublicHistory(appContext(broken, { corruptFinal: true }), broken.seed).replay({ baseUrl: "http://actual-api" }), /intended Escrow state and sequence/u);
assert.deepEqual(serializable(broken), brokenBefore, "bad business state cannot overwrite expected fixture");
const rejecting = make(); const rejectingCtx = appContext(rejecting, { rejectSubmit: true });
await assert.rejects(prepareEscrowGuardPublicHistory(rejectingCtx, rejecting.seed).replay({ baseUrl: "http://actual-api" }), /submission rejects setup evidence/u);
assert.equal(rejectingCtx.calls.filter(({ body }) => body).length, 2, "no fallback after real submit failure");
const released = make({ states: ["RELEASED", "PENDING"] });
assert.throws(() => prepareEscrowGuardPublicHistory({ caseId: "A-08" }, released.seed), /does not reconstruct Releases/u);
const due = make({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
assert.throws(() => prepareEscrowGuardPublicHistory({ caseId: "A-08" }, due.seed), /does not rewrite expiry deadlines/u);
const untracked = serializable(makeEscrowFixture(options, { amounts: [30, 70], states: ["SUBMITTED", "PENDING"] }));
assert.throws(() => prepareEscrowGuardPublicHistory({ caseId: "A-08" }, untracked.seed), /registered fixture identity/u);
const funded = make({ states: ["PENDING", "PENDING"] }); const fundedCtx = appContext(funded, { caseId: "B-06" });
await prepareEscrowGuardPublicHistory(fundedCtx, funded.seed).replay({ baseUrl: "http://actual-api" });
assert.equal(fundedCtx.calls.filter(({ body }) => body).length, 1, "FUNDED setup does not submit");

const buyer = make({ label: "buyer-dispute-release", amounts: [40, 60] });
const seller = make({ label: "seller-dispute-release", amounts: [25, 75] });
const sellerEscrowId = "44444444-4444-4444-8444-444444444444";
const sellerMilestoneIds = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
const buyerApi = appContext(buyer);
const sellerApi = appContext(seller, { escrowIdentity: sellerEscrowId, milestoneIdentities: sellerMilestoneIds });
let currentApi;
const combined = { ...buyer.seed, escrows: [buyer.escrow, seller.escrow], milestones: [...buyer.milestones, ...seller.milestones] };
const combinedContext = {
  caseId: "A-09", key: (key) => key,
  async mutate(...args) { if (args[1] === "/api/v1/escrows") currentApi = args[3].milestones[0].amountMinor === 40 ? buyerApi : sellerApi; return currentApi.mutate(...args); },
  async request(...args) { return currentApi.request(...args); },
};
const combinedSetup = prepareEscrowGuardPublicHistory(combinedContext, combined);
assert.equal(combinedSetup.seed.escrows.length, 0);
await combinedSetup.replay({ baseUrl: "http://actual-api" });
assert.deepEqual(combined.escrows.map(({ escrowId }) => escrowId), [actualEscrowId, sellerEscrowId]);
assert.deepEqual([buyer.escrowId, seller.escrowId], [actualEscrowId, sellerEscrowId]);
assert.deepEqual(combined.milestones.map(({ escrowId, milestoneId }) => [escrowId, milestoneId]), [[actualEscrowId, actualMilestoneIds[0]], [actualEscrowId, actualMilestoneIds[1]], [sellerEscrowId, sellerMilestoneIds[0]], [sellerEscrowId, sellerMilestoneIds[1]]]);
assert.deepEqual([buyer.milestones[0].amountMinor, seller.milestones[0].amountMinor], [40, 25], "A09 distinct original amounts are never copied from API");
assert.equal(buyerApi.calls.filter(({ body }) => body).length + sellerApi.calls.filter(({ body }) => body).length, 4, "A09 only performs two creates and two submits, never pre-opens tested Disputes");
for (const caseId of ["B-01", "B-04", "D-03"]) {
  const original = make(); const context = appContext(original, { caseId });
  await prepareEscrowGuardPublicHistory(context, original.seed).replay({ baseUrl: "http://actual-api" });
  assert.equal(original.escrow.state, "ACTIVE");
  assert.deepEqual(original.milestones.map(({ state }) => state), ["SUBMITTED", "PENDING"]);
  assert.deepEqual(original.seed.disputes, []);
  assert.deepEqual(original.seed.releases, []);
  assert.equal(context.calls.filter(({ body }) => body).length, 2, `${caseId} only create and first submit before original scored actions`);
}
console.log("EscrowGuard public-history setup checks passed; original assertions and business expectations preserved");

// Exercise the author helper wiring, not only the replay function.
const { prepare } = await import('../evaluators/transfer/escrowguard/v2/cases/helpers.mjs');
const wired = make(); const wireCtx = appContext(wired); let imported; const lifecycle = [];
Object.assign(wireCtx, {
  workspace: '/fixed', mark() {},
  forWorkspace() { return {
    async seed(value) { imported = value; lifecycle.push('seed'); },
    async startApi() { lifecycle.push('api'); return { baseUrl: 'http://actual-api' }; },
    async startWorker() { assert.equal(wired.escrowId, actualEscrowId); lifecycle.push('worker'); return {}; }
  }; }
});
await prepare(wireCtx, { seed: wired.seed, build: false, migrate: false, workerCount: 1 });
assert.deepEqual(imported.escrows, []);
assert.deepEqual(lifecycle, ['seed', 'api', 'worker']);
assert.equal(wireCtx.calls.filter(({ body }) => body).length, 2);
