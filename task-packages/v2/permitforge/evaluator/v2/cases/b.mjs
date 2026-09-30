import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";

import {
  assertProjection,
  assertRevisionHistory,
  assertSingleAggregateWork,
  assertStageSet,
  canonicalJson,
  sha256,
} from "../oracles/index.mjs";
import {
  applicationFrom,
  blocked,
  boot,
  caseResult,
  claimsFor,
  createRevision,
  decisionsFor,
  defineCase,
  expectError,
  findObject,
  claimResource,
  permitFor,
  requireStatus,
  revisionsFor,
  snapshot,
  stableResponse,
  stableSnapshot,
  stagesDetail,
  submitApplication,
  waitSnapshot,
} from "./helpers.mjs";

function emptySeed(family) {
  return {
    ...family.seed,
    permitApplications: [],
    applicationRevisions: [],
    reviewClaims: [],
    reviewDecisions: [],
    approvedPermits: [],
  };
}

function resultJson(capture) {
  return JSON.parse(capture.response.body);
}

async function waitPast(ctx, timestamp, label) {
  await ctx.waitFor(() => Date.now() > Date.parse(timestamp) + 75, { label, timeoutMs: 10_000, intervalMs: 20 });
}

async function observeStableSnapshot(ctx, baseUrl, expected, label, durationMs = 3_300) {
  const deadline = Date.now() + durationMs;
  let value = expected;
  while (Date.now() < deadline) {
    await ctx.sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    value = await snapshot(ctx, baseUrl);
    ctx.equal(stableSnapshot(value), stableSnapshot(expected), label, { hardCapIds: ["WORK_FENCING", "EVENT_ATOMICITY"] });
  }
  return value;
}

const SNAPSHOT_COLLECTIONS = Object.freeze([
  ["resources.applicants", (value) => value.applicantId],
  ["resources.reviewers", (value) => value.reviewerId],
  ["resources.permitApplications", (value) => value.applicationId],
  ["resources.applicationRevisions", (value) => `${value.applicationId}:${value.revision}`],
  ["resources.reviewClaims", (value) => value.claimId],
  ["resources.reviewDecisions", (value) => value.decisionId],
  ["resources.approvedPermits", (value) => value.permitId],
  ["resources.reviewStages", (value) => value.stageId],
  ["work", (value) => value.workId],
  ["events", (value) => value.eventId],
]);

function collectionAt(snapshotValue, path) {
  return path.split(".").reduce((value, key) => value[key], snapshotValue);
}

export function snapshotChangeRefs(before, after) {
  const change = { added: [], changed: [], removed: [] };
  for (const [path, identity] of SNAPSHOT_COLLECTIONS) {
    const beforeRows = new Map(collectionAt(before, path).map((value) => [identity(value), value]));
    const afterRows = new Map(collectionAt(after, path).map((value) => [identity(value), value]));
    for (const [id, value] of afterRows) {
      if (!beforeRows.has(id)) change.added.push(`${path}:${id}`);
      else if (canonicalJson(beforeRows.get(id)) !== canonicalJson(value)) change.changed.push(`${path}:${id}`);
    }
    for (const id of beforeRows.keys()) if (!afterRows.has(id)) change.removed.push(`${path}:${id}`);
  }
  for (const values of Object.values(change)) values.sort();
  return change;
}

function closeServer(server, sockets) {
  return new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    if (!server.listening) resolve();
    else server.close(resolve);
  });
}

/** Hold complete HTTP requests at an evaluator-owned proxy until every peer has arrived. */
export async function createHeldRequestProxy(ctx, targetBaseUrls) {
  if (!Array.isArray(targetBaseUrls) || targetBaseUrls.length < 2) throw new TypeError("request hold proxy requires at least two targets");
  const gate = Promise.withResolvers();
  const ledger = [];
  const arrivals = new Set();
  const sockets = new Set();
  let releasedAt;
  let closed = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const requested = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const match = requested.pathname.match(/^\/__permitforge_hold\/(\d+)(\/.*)$/u);
      if (!match) { outgoing.writeHead(404).end(); return; }
      const targetIndex = Number(match[1]);
      if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= targetBaseUrls.length || arrivals.has(targetIndex)) {
        outgoing.writeHead(409).end();
        return;
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const targetPath = `${match[2]}${requested.search}`;
      const entry = { targetIndex, targetPath, raw: raw.toString("utf8"), arrivedAt: Date.now(), forwardedAt: undefined };
      arrivals.add(targetIndex);
      ledger.push(entry);
      if (arrivals.size === targetBaseUrls.length) {
        releasedAt = Date.now();
        gate.resolve();
      }
      await gate.promise;
      entry.forwardedAt = Date.now();
      const headers = { ...incoming.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      const target = new URL(targetPath, targetBaseUrls[targetIndex]);
      await new Promise((resolve, reject) => {
        const upstream = httpRequest(target, { method: incoming.method, headers }, (response) => {
          const responseChunks = [];
          response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            if (!outgoing.destroyed) {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              outgoing.end(Buffer.concat(responseChunks));
            }
            resolve();
          });
        });
        upstream.on("error", reject);
        upstream.end(raw);
      });
    } catch {
      if (!outgoing.destroyed) outgoing.writeHead(502).end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeServer(server, sockets);
  };
  ctx.defer(close);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close,
    ledger,
    pathFor: (index, path) => `/__permitforge_hold/${index}${path.startsWith("/") ? path : `/${path}`}`,
    get releasedAt() { return releasedAt; },
  };
}

async function frozenClientBarrier(ctx, requests, label) {
  const proxy = await createHeldRequestProxy(ctx, requests.map(({ baseUrl }) => baseUrl));
  try {
    const responses = await Promise.all(requests.map((request, index) => ctx.mutate(
      proxy.baseUrl,
      proxy.pathFor(index, request.path),
      request.key,
      request.body,
      request.options ?? {},
    )));
    ctx.equal(proxy.ledger.length, requests.length, `${label} complete requests reached evaluator hold proxy`);
    ctx.ok(proxy.ledger.every(({ arrivedAt, forwardedAt }) => arrivedAt <= proxy.releasedAt && forwardedAt >= proxy.releasedAt), `${label} releases only after every request arrived`);
    return responses;
  } finally {
    await proxy.close();
  }
}

function addedRows(before, after, identity) {
  const existing = new Set(before.map(identity));
  return after.filter((item) => !existing.has(identity(item)));
}

function sorted(values) {
  return [...values].sort();
}

function assertExactChanges(ctx, before, after, expected, label, options = {}) {
  ctx.equal(snapshotChangeRefs(before, after), {
    added: sorted(expected.added ?? []),
    changed: sorted(expected.changed ?? []),
    removed: sorted(expected.removed ?? []),
  }, `${label} exact all-state change set`, options);
}

function aggregateRows(state, applicationId) {
  return {
    application: state.resources.permitApplications.filter((item) => item.applicationId === applicationId),
    revisions: state.resources.applicationRevisions.filter((item) => item.applicationId === applicationId),
    claims: state.resources.reviewClaims.filter((item) => item.applicationId === applicationId),
    decisions: state.resources.reviewDecisions.filter((item) => item.applicationId === applicationId),
    permits: state.resources.approvedPermits.filter((item) => item.applicationId === applicationId),
    stages: state.resources.reviewStages.filter((item) => item.applicationId === applicationId),
    work: state.work.filter((item) => item.aggregateId === applicationId),
    events: state.events.filter((item) => item.aggregateId === applicationId),
  };
}

function addedEvents(before, after, applicationId) {
  return addedRows(before.events, after.events, ({ eventId }) => eventId).filter(({ aggregateId }) => aggregateId === applicationId);
}

function exactClaimTuple(ctx, claim, expected, label) {
  ctx.equal(
    {
      applicationId: claim.applicationId,
      revision: claim.revision,
      reviewerId: claim.reviewerId,
      role: claim.role,
      state: claim.state,
    },
    expected,
    `${label} exact Claim tuple`,
  );
}

export function assertExactClaimTupleHistory(claims, expected, authorityClaimId) {
  const matching = claims.filter((claim) => claim.applicationId === expected.applicationId
    && claim.revision === expected.revision
    && claim.reviewerId === expected.reviewerId
    && claim.role === expected.role);
  if (matching.length !== 1) throw new Error(`expected one complete Claim tuple history, got ${matching.length}`);
  const [claim] = matching;
  if (claim.claimId !== authorityClaimId) throw new Error("Claim tuple history does not name the response authority");
  if (claim.state !== "LEASED") throw new Error(`Claim tuple history contains non-current state ${claim.state}`);
  return claim;
}

function assertOperationEffects(ctx, before, after, operation, authorityJson) {
  const newApplications = addedRows(before.resources.permitApplications, after.resources.permitApplications, ({ applicationId }) => applicationId);
  const newRevisions = addedRows(before.resources.applicationRevisions, after.resources.applicationRevisions, ({ applicationId, revision }) => `${applicationId}:${revision}`);
  const newClaims = addedRows(before.resources.reviewClaims, after.resources.reviewClaims, ({ claimId }) => claimId);
  const newStages = addedRows(before.resources.reviewStages, after.resources.reviewStages, ({ stageId }) => stageId);
  const newWork = addedRows(before.work, after.work, ({ workId }) => workId);
  const newEvents = addedRows(before.events, after.events, ({ eventId }) => eventId);

  if (operation.label === "submit" || operation.label === "staged") {
    const application = findObject(authorityJson, "applicationId");
    const applicationId = application.applicationId;
    const revision = newRevisions.find(item => item.applicationId === applicationId && item.revision === application.currentRevision);
    ctx.ok(revision, "submitted Revision exists in authoritative snapshot");
    ctx.assert("submitted Revision exact", () => assertApplicationRevision(revision));
    ctx.equal(revision.fields, operation.body.fields, "submitted fields captured");
    const stageCount = operation.label === "staged" ? 5 : 1;
    const work = newWork.filter(({ aggregateId }) => aggregateId === applicationId);
    const stages = newStages.filter(({ applicationId: id }) => id === applicationId);
    const events = newEvents.filter(({ aggregateId }) => aggregateId === applicationId);
    ctx.equal(newApplications, [application], `${operation.label} one exact Application effect`);
    ctx.equal(newRevisions, [revision], `${operation.label} one exact Revision effect`);
    ctx.equal(newClaims.length, 0, `${operation.label} no Claim effect`);
    ctx.equal(after.resources.reviewDecisions.length, before.resources.reviewDecisions.length, `${operation.label} no Decision effect`);
    ctx.equal(after.resources.approvedPermits.length, before.resources.approvedPermits.length, `${operation.label} no Permit effect`);
    ctx.equal(work.length, 1, `${operation.label} one Deadline Work effect`);
    ctx.equal(stages.length, stageCount, `${operation.label} exact Stage effect`);
    ctx.equal(events.length, 1, `${operation.label} one non-vacuous Event effect`, { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.equal(events[0].type, "application.submitted", `${operation.label} submitted Event type`);
    assertExactChanges(ctx, before, after, {
      added: [
        `resources.permitApplications:${applicationId}`,
        `resources.applicationRevisions:${applicationId}:1`,
        ...stages.map(({ stageId }) => `resources.reviewStages:${stageId}`),
        `work:${work[0].workId}`,
        `events:${events[0].eventId}`,
      ],
    }, `${operation.label} first use`, { hardCapIds: ["DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY"] });
    return { applicationId };
  }

  if (operation.label === "claim") {
    const claim = claimResource(authorityJson);
    const applicationId = claim.applicationId;
    const beforeRows = aggregateRows(before, applicationId);
    const afterRows = aggregateRows(after, applicationId);
    const events = addedEvents(before, after, applicationId);
    ctx.equal(newApplications.length, 0, "claim no Application effect");
    ctx.equal(newRevisions.length, 0, "claim no Revision effect");
    ctx.equal(newClaims.map(({ claimId }) => claimId), [claim.claimId], "claim one Claim effect");
    ctx.equal(events.length, 1, "claim one non-vacuous Event effect", { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.equal(events[0].type, "review.claimed", "claim Event type", { hardCapIds: ["EVENT_ATOMICITY"] });
    exactClaimTuple(ctx, newClaims[0], {
      applicationId,
      revision: claim.revision,
      reviewerId: claim.reviewerId,
      role: claim.role,
      state: "LEASED",
    }, "claim authority");
    ctx.equal(newClaims[0], claim, "claim response is persisted authority");
    ctx.equal(afterRows.revisions, beforeRows.revisions, "claim leaves Revisions exact");
    ctx.equal(afterRows.decisions, beforeRows.decisions, "claim leaves Decisions exact");
    ctx.equal(afterRows.permits, beforeRows.permits, "claim leaves Permits exact");
    ctx.equal(afterRows.stages, beforeRows.stages, "claim leaves Stages exact");
    ctx.equal(afterRows.work, beforeRows.work, "claim leaves Work exact");
    ctx.equal(afterRows.application[0].state, "UNDER_REVIEW", "claim moves authority to UNDER_REVIEW");
    ctx.equal(afterRows.application[0].sequence, beforeRows.application[0].sequence + 1, "claim advances aggregate sequence once");
    assertExactChanges(ctx, before, after, {
      added: [`resources.reviewClaims:${claim.claimId}`, `events:${events[0].eventId}`],
      changed: [`resources.permitApplications:${applicationId}`],
    }, "claim first use", { hardCapIds: ["DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY"] });
    return { claimId: claim.claimId, applicationId };
  }

  const revision = findObject(authorityJson, "canonicalDigest");
  const applicationId = revision.applicationId;
  const beforeRows = aggregateRows(before, applicationId);
  const afterRows = aggregateRows(after, applicationId);
  const stages = newStages.filter(({ applicationId: id }) => id === applicationId);
  const work = newWork.filter(({ aggregateId }) => aggregateId === applicationId);
  const events = addedEvents(before, after, applicationId);
  ctx.equal(newApplications.length, 0, "revision does not create Application");
  ctx.equal(newClaims.length, 0, "revision does not create Claim");
  ctx.equal(newRevisions.map(({ applicationId: id, revision: number }) => `${id}:${number}`), [`${applicationId}:${revision.revision}`], "revision one Revision effect");
  ctx.equal(newRevisions[0], revision, "revision response is persisted authority");
  ctx.equal(applicationFrom(after, applicationId).currentRevision, revision.revision, "replacement Revision is current");
  ctx.equal(afterRows.revisions.length, beforeRows.revisions.length + 1, "revision history grows exactly once");
  ctx.equal(afterRows.revisions.slice(0, beforeRows.revisions.length), beforeRows.revisions, "old Revision history immutable");
  ctx.equal(afterRows.claims, beforeRows.claims, "replacement leaves Claim history exact");
  ctx.equal(afterRows.decisions, beforeRows.decisions, "replacement leaves Decision history exact");
  ctx.equal(afterRows.permits, beforeRows.permits, "replacement leaves Permit history exact");
  ctx.equal(work.length, 1, "revision one new Deadline Work effect");
  ctx.equal(afterRows.work.length, beforeRows.work.length + 1, "revision retains old Work identities and adds one replacement deadline");
  const changedPriorWork = [];
  for (const prior of beforeRows.work) {
    const retained = afterRows.work.find(({ workId }) => workId === prior.workId);
    ctx.ok(retained, `revision retains prior Work ${prior.workId}`);
    ctx.equal({ workId: retained.workId, aggregateId: retained.aggregateId, kind: retained.kind, attempt: retained.attempt }, {
      workId: prior.workId,
      aggregateId: prior.aggregateId,
      kind: prior.kind,
      attempt: prior.attempt,
    }, `revision preserves prior Work ${prior.workId} identity and attempt`);
    ctx.equal(retained.state, "CANCELLED", `revision cancels prior Work ${prior.workId}`);
    ctx.equal(retained.terminal, true, `revision makes prior Work ${prior.workId} terminal`);
    ctx.equal(retained.leaseOwner, null, `revision clears prior Work ${prior.workId} owner`);
    ctx.equal(retained.leaseExpiresAt, null, `revision clears prior Work ${prior.workId} lease`);
    if (canonicalJson(retained) !== canonicalJson(prior)) changedPriorWork.push(retained.workId);
  }
  ctx.equal(stages.length, 1, "legacy replacement creates one current Stage effect");
  ctx.equal(stages[0].revision, revision.revision, "replacement Stage binds new Revision");
  const changedPriorStages = [];
  for (const prior of beforeRows.stages) {
    const retained = afterRows.stages.find(({ stageId }) => stageId === prior.stageId);
    ctx.ok(retained, `revision retains prior Stage ${prior.stageId}`);
    ctx.equal({ stageId: retained.stageId, applicationId: retained.applicationId, revision: retained.revision, ordinal: retained.ordinal, name: retained.name, policy: retained.policy }, {
      stageId: prior.stageId,
      applicationId: prior.applicationId,
      revision: prior.revision,
      ordinal: prior.ordinal,
      name: prior.name,
      policy: prior.policy,
    }, `revision preserves prior Stage ${prior.stageId} identity and captured policy`);
    ctx.ok(retained.state !== "ACTIVE", `revision leaves prior Stage ${prior.stageId} non-current`);
    if (canonicalJson(retained) !== canonicalJson(prior)) changedPriorStages.push(retained.stageId);
  }
  ctx.equal(events.length, 1, "revision has one non-vacuous Domain Event", { hardCapIds: ["EVENT_ATOMICITY"] });
  ctx.equal(events[0].type, "application.submitted", "replacement returns aggregate to SUBMITTED");
  assertExactChanges(ctx, before, after, {
    added: [
      `resources.applicationRevisions:${applicationId}:${revision.revision}`,
      `resources.reviewStages:${stages[0].stageId}`,
      `work:${work[0].workId}`,
      `events:${events[0].eventId}`,
    ],
    changed: [
      `resources.permitApplications:${applicationId}`,
      ...changedPriorWork.map((workId) => `work:${workId}`),
      ...changedPriorStages.map((stageId) => `resources.reviewStages:${stageId}`),
    ],
  }, "replacement Revision first use", { hardCapIds: ["DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY"] });
  return { applicationId, revision: revision.revision };
}

export const B_INTERLEAVINGS = Object.freeze({
  B04: Object.freeze(["concurrent-after-expiry", "new-reviewer-first", "old-reviewer-first"]),
  B05: Object.freeze(["replacement-first", "claim-first", "concurrent"]),
  B06: Object.freeze(["replacement-before-worker-commit", "expiry-before-replacement"]),
  B10: Object.freeze(["claim-before-deadline", "claim-while-worker-held", "claim-after-expiry"]),
});

const b01 = defineCase(
  "B-01",
  "PF-F-V1-POLICY canonical Revision histories",
  "Create key-order-equivalent Applications, replace an exact seeded CHANGES_REQUIRED Revision and reread every historical Revision after policy changes",
  "RFC8785 digests agree for semantic JSON, revisions remain contiguous, and all old fields, captured policy, digest and timestamps stay immutable",
  ["public Application HTTP", "Revision HTTP", "independent canonical oracle", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.changes("b01-history");
    const { api } = await boot(ctx, { family });
    const fields = { a: 1, nested: { left: true, right: false }, z: "value" };
    const left = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("b01-left", { fields }), "b01-left");
    const rightFields = { z: "value", nested: { right: false, left: true }, a: 1 };
    const right = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("b01-right", { fields: rightFields }), "b01-right");
    ctx.equal(left.revision.canonicalDigest, right.revision.canonicalDigest, "key order independent digest");
    ctx.equal(left.revision.canonicalDigest, sha256(canonicalJson(fields)), "independent canonical digest");
    const applicationId = family.application.applicationId;
    const original = structuredClone(revisionsFor(await snapshot(ctx, api.baseUrl), applicationId)[0]);
    await createRevision(ctx, api.baseUrl, applicationId, {
      expectedRevision: 1,
      fields: { amendment: 2 },
      deadlineAt: ctx.at({ days: 4 }),
      reviewPolicy: family.strictLegalPolicy,
    }, "b01-revision-2");
    const final = await snapshot(ctx, api.baseUrl);
    const history = revisionsFor(final, applicationId);
    ctx.assert("contiguous immutable Revision history", () => assertRevisionHistory(history), { hardCapIds: ["REVIEW_AUTHORITY"] });
    ctx.equal(history[0], original, "Revision 1 is semantically immutable", { hardCapIds: ["REVIEW_AUTHORITY"] });
    ctx.equal(history[1].policy, family.strictLegalPolicy, "Revision 2 captured replacement policy");
    return caseResult(ctx, { applicationId, revisions: history.length, canonicalDigest: left.revision.canonicalDigest });
  },
);

const b02 = defineCase(
  "B-02",
  "PF-F-DECISIONS independent quota histories",
  "Enumerate exact seeded histories for satisfied quotas, total-only, roles-only, veto and quorum-impossible states through public detail and snapshot reads",
  "An evaluator-owned quorum oracle exactly matches every Application and Permit projection, including veto precedence and both directions of quota insufficiency",
  ["public seed", "Application detail HTTP", "verification snapshot", "independent quorum oracle"],
  async (ctx) => {
    const family = ctx.fixtures.projections();
    const { api } = await boot(ctx, { family });
    const state = await snapshot(ctx, api.baseUrl);
    for (const item of family.histories) {
      const application = applicationFrom(state, item.application.applicationId);
      const revision = revisionsFor(state, application.applicationId)[0];
      ctx.assert(`${application.applicationId} exact independent projection`, () => assertProjection(application, revision, decisionsFor(state, application.applicationId), permitFor(state, application.applicationId)), { hardCapIds: ["REVIEW_AUTHORITY"] });
    }
    return caseResult(ctx, { histories: family.histories.map(({ application }) => application.applicationId) });
  },
  [blocked("PF-B02-LIVE-DECISION", "PF-GAP-01")],
);

const b03 = defineCase(
  "B-03",
  "PF-F-CLAIMS 64-way contention",
  "Send 64 distinct-key Claim attempts for one Reviewer, Revision and role across two independent API processes sharing PostgreSQL",
  "At most one current leased Claim exists for the reviewer tuple, every other response is a stable slot conflict or the same authority, and no Work or Event duplicates appear",
  ["two API processes", "64 concurrent public Claim requests", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.main("b03");
    const { apis } = await boot(ctx, { family, apiCount: 2 });
    const applicationId = family.application.applicationId;
    const reviewerId = family.securityReviewers[0].reviewerId;
    const before = await snapshot(ctx, apis[0].baseUrl);
    const responses = await frozenClientBarrier(ctx, Array.from({ length: 64 }, (_, index) => ({
      baseUrl: apis[index % 2].baseUrl,
      path: `/api/v1/permit-applications/${applicationId}/review-claims`,
      key: ctx.key(`b03-${index}`),
      body: { reviewerId, role: "security" },
    })), "64-way distinct-key Claim contention");
    ctx.ok(responses.every(({ status }) => status === 200 || status === 409), "contention has only success or slot conflict");
    responses.filter(({ status }) => status === 409).forEach((response) => expectError(ctx, response, 409, "REVIEW_SLOT_UNAVAILABLE"));
    const successes = responses.filter(({ status }) => status === 200).map(({ json }) => claimResource(json));
    ctx.ok(successes.length >= 1, "one Claim authority observed");
    ctx.equal(new Set(successes.map(({ claimId }) => claimId)).size, 1, "all successful responses name one Claim");
    const state = await snapshot(ctx, apis[0].baseUrl);
    const authority = successes[0];
    const exactClaim = ctx.assert("complete reviewer/revision/role Claim history is one current authority", () => assertExactClaimTupleHistory(
      claimsFor(state, applicationId),
      { applicationId, revision: 1, reviewerId, role: "security" },
      authority.claimId,
    ), { hardCapIds: ["REVIEW_AUTHORITY"] });
    ctx.equal(exactClaim, authority, "successful Claim response equals the sole persisted tuple authority");
    const effect = assertOperationEffects(ctx, before, state, { label: "claim" }, authority);
    ctx.equal(effect.claimId, exactClaim.claimId, "contention closes to the exact Claim effect");
    const claimEvents = state.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "review.claimed");
    ctx.equal(claimEvents.length, 1, "one Claim Event and no duplicate Event history", { hardCapIds: ["EVENT_ATOMICITY"] });
    return caseResult(ctx, { claimId: exactClaim.claimId, attempts: responses.length, conflicts: responses.filter(({ status }) => status === 409).length });
  },
  [blocked("PF-B03-DECISION-FENCE", "PF-GAP-01")],
);

const b04 = defineCase(
  "B-04",
  "PF-F-CLAIMS expiry and competing reclaim",
  "Fill the security role slots, wait for their published leases to expire, then race two reviewers through two APIs to reclaim the same capacity",
  "No more than the captured role capacity is leased, attempts advance monotonically, expired ownership never returns and reclaimed slots remain unique",
  ["two API processes", "Review Claim lease expiry", "concurrent public HTTP", "verification snapshot"],
  async (ctx) => {
    const schedules = [];
    for (const [ordinal, mode] of B_INTERLEAVINGS.B04.entries()) {
      if (ordinal > 0) await ctx.resetDatabase();
      const base = ctx.fixtures.main(`b04-${mode}`);
      const oneSlotPolicy = { roles: [{ role: "security", eligibleReviewerIds: base.securityReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 1, veto: true }], requiredTotalApprovals: 1 };
      const item = ctx.fixtures.history(`b04-${mode}`, "SUBMITTED", { policy: oneSlotPolicy });
      const family = { ...base, application: item.application, revision: item.revision, seed: ctx.fixtures.seedFromHistories(`b04-${mode}`, [item]) };
      const { apis } = await boot(ctx, { family, apiCount: 2 });
      const applicationId = item.application.applicationId;
      const path = `/api/v1/permit-applications/${applicationId}/review-claims`;
      const original = await ctx.mutate(apis[0].baseUrl, path, ctx.key(`b04-${mode}-original`), { reviewerId: family.securityReviewers[0].reviewerId, role: "security" });
      requireStatus(ctx, original, 200, `${mode} original Claim`);
      const originalClaim = claimResource(original.json);
      const beforeExpiry = await ctx.mutate(apis[1].baseUrl, path, ctx.key(`b04-${mode}-before`), { reviewerId: family.securityReviewers[1].reviewerId, role: "security" });
      expectError(ctx, beforeExpiry, 409, "REVIEW_SLOT_UNAVAILABLE");
      await waitPast(ctx, originalClaim.leaseExpiresAt, `${mode} observed Claim expiry`);
      const beforeRace = await snapshot(ctx, apis[0].baseUrl);
      let outcomes;
      if (mode === "concurrent-after-expiry") {
        outcomes = await frozenClientBarrier(ctx, [
          { baseUrl: apis[0].baseUrl, path, key: ctx.key(`b04-${mode}-old`), body: { reviewerId: family.securityReviewers[0].reviewerId, role: "security" } },
          { baseUrl: apis[1].baseUrl, path, key: ctx.key(`b04-${mode}-new`), body: { reviewerId: family.securityReviewers[1].reviewerId, role: "security" } },
        ], `${mode} reclaim race`);
      } else {
        const order = mode === "new-reviewer-first" ? [1, 0] : [0, 1];
        outcomes = [];
        for (const reviewerIndex of order) outcomes.push(await ctx.mutate(apis[reviewerIndex].baseUrl, path, ctx.key(`b04-${mode}-${reviewerIndex}`), { reviewerId: family.securityReviewers[reviewerIndex].reviewerId, role: "security" }));
      }
      ctx.ok(outcomes.every(({ status }) => status === 200 || status === 409), `${mode} all Claim race responses are published outcomes`);
      ctx.equal(outcomes.filter(({ status }) => status === 200).length, 1, `${mode} exactly one reclaim winner`);
      outcomes.filter(({ status }) => status === 409).forEach((response) => expectError(ctx, response, 409, "REVIEW_SLOT_UNAVAILABLE"));
      const winningResponse = outcomes.find(({ status }) => status === 200);
      const winningClaim = claimResource(winningResponse.json);
      const state = await snapshot(ctx, apis[0].baseUrl);
      const claims = claimsFor(state, applicationId).filter(({ role }) => role === "security");
      const leased = claims.filter(({ state: claimState }) => claimState === "LEASED");
      const persistedOriginal = claims.find(({ claimId }) => claimId === originalClaim.claimId);
      const persistedWinner = claims.find(({ claimId }) => claimId === winningClaim.claimId);
      ctx.equal(leased.length, 1, `${mode} one current leased Claim`, { hardCapIds: ["REVIEW_AUTHORITY"] });
      ctx.equal(leased[0], persistedWinner, `${mode} response names sole leased authority`);
      ctx.equal(winningResponse.json, persistedWinner, `${mode} top-level response equals persisted winner`);
      ctx.ok(persistedOriginal, `${mode} original Claim history retained`);
      if (winningClaim.reviewerId === originalClaim.reviewerId) {
        ctx.equal(winningClaim.claimId, originalClaim.claimId, `${mode} same reviewer reclaims original Claim identity`);
        ctx.equal(persistedOriginal.state, "LEASED", `${mode} same reviewer owns reclaimed lease`);
        ctx.equal(persistedOriginal.attempt, originalClaim.attempt + 1, `${mode} same reviewer reclaim attempt increments exactly once`);
      } else {
        ctx.ok(winningClaim.claimId !== originalClaim.claimId, `${mode} different reviewer receives a new Claim identity`);
        ctx.equal(persistedOriginal.state, "EXPIRED", `${mode} displaced owner stays EXPIRED`);
        ctx.equal(persistedWinner.reviewerId, family.securityReviewers[1].reviewerId, `${mode} new reviewer owns reclaimed slot`);
        ctx.ok(persistedWinner.attempt >= 1, `${mode} new Claim attempt is positive`);
      }
      const beforeRows = aggregateRows(beforeRace, applicationId);
      const afterRows = aggregateRows(state, applicationId);
      const events = addedEvents(beforeRace, state, applicationId);
      ctx.equal(events.length, 1, `${mode} reclaim emits one non-vacuous Event`);
      ctx.equal(events[0].type, "review.claimed", `${mode} reclaim Event type`);
      ctx.equal(afterRows.revisions, beforeRows.revisions, `${mode} Revisions unchanged`);
      ctx.equal(afterRows.decisions, beforeRows.decisions, `${mode} Decisions unchanged`);
      ctx.equal(afterRows.permits, beforeRows.permits, `${mode} Permits unchanged`);
      ctx.equal(afterRows.stages, beforeRows.stages, `${mode} Stages unchanged`);
      ctx.equal(afterRows.work, beforeRows.work, `${mode} Work unchanged`);
      ctx.equal(afterRows.application[0].sequence, beforeRows.application[0].sequence + 1, `${mode} aggregate sequence advances once`);
      assertExactChanges(ctx, beforeRace, state, {
        added: [
          ...(winningClaim.claimId === originalClaim.claimId ? [] : [`resources.reviewClaims:${winningClaim.claimId}`]),
          `events:${events[0].eventId}`,
        ],
        changed: [`resources.permitApplications:${applicationId}`, `resources.reviewClaims:${originalClaim.claimId}`],
      }, `${mode} reclaim race`, { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
      schedules.push({ mode, applicationId, winningClaimId: persistedWinner.claimId, winningAttempt: persistedWinner.attempt, winningReviewerId: persistedWinner.reviewerId });
    }
    return caseResult(ctx, { schedules });
  },
  [blocked("PF-B04-DECISION-FENCE", "PF-GAP-01")],
);

const b05 = defineCase(
  "B-05",
  "PF-F-DECISIONS replacement and Claim race",
  "Race replacement of an exact seeded CHANGES_REQUIRED Revision against a Claim for that old Revision through two APIs",
  "Exactly one contiguous replacement wins, old Revision data remains immutable and no leased Claim on the losing Revision becomes current authority",
  ["two API processes", "Revision HTTP", "Claim HTTP", "verification snapshot"],
  async (ctx) => {
    const schedules = [];
    for (const [ordinal, mode] of B_INTERLEAVINGS.B05.entries()) {
      if (ordinal > 0) await ctx.resetDatabase();
      const family = ctx.fixtures.changes(`b05-${mode}`);
      const { apis } = await boot(ctx, { family, apiCount: 2 });
      const applicationId = family.application.applicationId;
      const before = await snapshot(ctx, apis[0].baseUrl);
      const originalRevision = structuredClone(revisionsFor(before, applicationId)[0]);
      const originalClaims = structuredClone(claimsFor(before, applicationId));
      const revisionRequest = () => ctx.mutate(apis[0].baseUrl, `/api/v1/permit-applications/${applicationId}/revisions`, ctx.key(`b05-${mode}-revision`), { expectedRevision: 1, fields: { replacement: mode }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy });
      const claimRequest = () => ctx.mutate(apis[1].baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key(`b05-${mode}-claim`), { reviewerId: family.securityReviewers[1].reviewerId, role: "security" });
      let replacement;
      let claim;
      if (mode === "replacement-first") { replacement = await revisionRequest(); claim = await claimRequest(); }
      else if (mode === "claim-first") { claim = await claimRequest(); replacement = await revisionRequest(); }
      else [replacement, claim] = await frozenClientBarrier(ctx, [
        { baseUrl: apis[0].baseUrl, path: `/api/v1/permit-applications/${applicationId}/revisions`, key: ctx.key(`b05-${mode}-revision`), body: { expectedRevision: 1, fields: { replacement: mode }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy } },
        { baseUrl: apis[1].baseUrl, path: `/api/v1/permit-applications/${applicationId}/review-claims`, key: ctx.key(`b05-${mode}-claim`), body: { reviewerId: family.securityReviewers[1].reviewerId, role: "security" } },
      ], `${mode} replacement/Claim race`);
      requireStatus(ctx, replacement, 200, `${mode} replacement winner`);
      if (mode === "replacement-first") requireStatus(ctx, claim, 200, `${mode} Claim binds current Revision 2`);
      else if (mode === "claim-first") requireStatus(ctx, claim, 200, `${mode} Claim commits on Revision 1 before replacement`);
      else if (claim.status === 409) expectError(ctx, claim, 409, "APPLICATION_REVISION_CHANGED");
      else requireStatus(ctx, claim, 200, `${mode} concurrent Claim authority`);
      const racedClaim = claim.status === 200 ? claimResource(claim.json) : undefined;
      const final = await snapshot(ctx, apis[0].baseUrl);
      const revisions = revisionsFor(final, applicationId);
      const finalClaims = claimsFor(final, applicationId);
      ctx.assert(`${mode} replacement Revision contiguous`, () => assertRevisionHistory(revisions), { hardCapIds: ["REVIEW_AUTHORITY"] });
      ctx.equal(revisions.length, 2, `${mode} exactly one replacement Revision`);
      ctx.equal(revisions[0], originalRevision, `${mode} old Revision immutable`);
      ctx.equal(replacement.json, revisions[1], `${mode} replacement response is exact persisted Revision 2`);
      ctx.equal(finalClaims.filter(({ claimId }) => originalClaims.some((old) => old.claimId === claimId)), originalClaims, `${mode} retained seeded Claim history immutable`);
      if (racedClaim) {
        const retained = finalClaims.find(({ claimId }) => claimId === racedClaim.claimId);
        ctx.ok(retained, `${mode} raced Claim history retained`);
        ctx.equal({
          applicationId: retained.applicationId,
          revision: retained.revision,
          reviewerId: retained.reviewerId,
          role: retained.role,
        }, {
          applicationId: racedClaim.applicationId,
          revision: racedClaim.revision,
          reviewerId: racedClaim.reviewerId,
          role: racedClaim.role,
        }, `${mode} raced Claim tuple immutable`);
        if (racedClaim.revision === 1) ctx.equal(retained.state, "EXPIRED", `${mode} losing old-Revision Claim is retained terminal`);
        else {
          ctx.equal(racedClaim.revision, 2, `${mode} post-replacement Claim binds Revision 2`);
          ctx.equal(retained.state, "LEASED", `${mode} current Revision Claim remains leased`);
          ctx.equal(retained, racedClaim, `${mode} current Claim response equals persisted authority`);
        }
      }
      if (mode === "replacement-first") ctx.equal(racedClaim.revision, 2, "replacement-first Claim must bind Revision 2");
      if (mode === "claim-first") ctx.equal(racedClaim.revision, 1, "claim-first Claim must bind Revision 1");
      ctx.equal(applicationFrom(final, applicationId).currentRevision, 2, `${mode} one replacement current`);
      ctx.ok(finalClaims.filter(({ state }) => state === "LEASED").every(({ revision }) => revision === 2), `${mode} only current Revision retains lease`);
      ctx.equal(finalClaims.length, originalClaims.length + (racedClaim ? 1 : 0), `${mode} exact Claim history cardinality`);
      const beforeRows = aggregateRows(before, applicationId);
      const afterRows = aggregateRows(final, applicationId);
      const newStages = addedRows(beforeRows.stages, afterRows.stages, ({ stageId }) => stageId);
      const newWork = addedRows(beforeRows.work, afterRows.work, ({ workId }) => workId);
      const events = addedEvents(before, final, applicationId);
      ctx.equal(newStages.length, 1, `${mode} replacement creates one current Stage`);
      ctx.equal(newStages[0].revision, 2, `${mode} new Stage binds Revision 2`);
      ctx.equal(newWork.length, 1, `${mode} replacement creates one Deadline Work`);
      ctx.equal(afterRows.work.length, beforeRows.work.length + 1, `${mode} retains prior Work and adds exactly one replacement Work`);
      const changedPriorWork = [];
      for (const prior of beforeRows.work) {
        const retained = afterRows.work.find(({ workId }) => workId === prior.workId);
        ctx.ok(retained, `${mode} prior Work ${prior.workId} retained`);
        ctx.equal({ workId: retained.workId, aggregateId: retained.aggregateId, kind: retained.kind, attempt: retained.attempt }, {
          workId: prior.workId,
          aggregateId: prior.aggregateId,
          kind: prior.kind,
          attempt: prior.attempt,
        }, `${mode} prior Work ${prior.workId} identity and attempt immutable`);
        ctx.equal(retained.state, "CANCELLED", `${mode} prior Revision Work is cancelled`);
        ctx.equal(retained.terminal, true, `${mode} cancelled prior Work is terminal`);
        ctx.equal(retained.leaseOwner, null, `${mode} cancelled prior Work has no owner`);
        ctx.equal(retained.leaseExpiresAt, null, `${mode} cancelled prior Work has no lease`);
        if (canonicalJson(retained) !== canonicalJson(prior)) changedPriorWork.push(retained.workId);
      }
      ctx.equal(newWork[0].state, "PENDING", `${mode} replacement Deadline Work is pending`);
      ctx.equal(newWork[0].terminal, false, `${mode} replacement Deadline Work is nonterminal`);
      const changedPriorStages = beforeRows.stages.filter((stage) => {
        const retained = afterRows.stages.find(({ stageId }) => stageId === stage.stageId);
        ctx.ok(retained, `${mode} prior Stage ${stage.stageId} retained`);
        ctx.equal({ stageId: retained.stageId, applicationId: retained.applicationId, revision: retained.revision, ordinal: retained.ordinal, name: retained.name, policy: retained.policy }, {
          stageId: stage.stageId,
          applicationId: stage.applicationId,
          revision: stage.revision,
          ordinal: stage.ordinal,
          name: stage.name,
          policy: stage.policy,
        }, `${mode} prior Stage ${stage.stageId} identity and policy immutable`);
        ctx.ok(retained.state !== "ACTIVE", `${mode} prior Stage ${stage.stageId} is not current`);
        return canonicalJson(retained) !== canonicalJson(stage);
      });
      ctx.equal(events.length, 1 + (racedClaim ? 1 : 0), `${mode} exact non-vacuous transition Event count`);
      ctx.equal(events.filter(({ type }) => type === "application.submitted").length, 1, `${mode} one replacement submitted Event`);
      ctx.equal(events.filter(({ type }) => type === "review.claimed").length, racedClaim ? 1 : 0, `${mode} Claim Event matches outcome`);
      ctx.equal(afterRows.decisions, beforeRows.decisions, `${mode} Decisions unchanged`);
      ctx.equal(afterRows.permits, beforeRows.permits, `${mode} Permits unchanged`);
      ctx.equal(afterRows.application[0].sequence, beforeRows.application[0].sequence + events.length, `${mode} aggregate sequence advances by exact Event count`);
      ctx.equal(afterRows.application[0].state, racedClaim?.revision === 2 ? "UNDER_REVIEW" : "SUBMITTED", `${mode} final state follows current-Revision Claim authority`);
      assertExactChanges(ctx, before, final, {
        added: [
          `resources.applicationRevisions:${applicationId}:2`,
          ...(racedClaim ? [`resources.reviewClaims:${racedClaim.claimId}`] : []),
          `resources.reviewStages:${newStages[0].stageId}`,
          `work:${newWork[0].workId}`,
          ...events.map(({ eventId }) => `events:${eventId}`),
        ],
        changed: [
          `resources.permitApplications:${applicationId}`,
          ...changedPriorWork.map((workId) => `work:${workId}`),
          ...changedPriorStages.map(({ stageId }) => `resources.reviewStages:${stageId}`),
        ],
      }, `${mode} replacement/Claim race`, { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
      schedules.push({ mode, applicationId, replacementStatus: replacement.status, claimStatus: claim.status, racedClaimId: racedClaim?.claimId });
    }
    return caseResult(ctx, { schedules });
  },
  [blocked("PF-B05-OLD-CLAIM-DECISION", "PF-GAP-01")],
);

const b06 = defineCase(
  "B-06",
  "PF-F-WORK-EVENT deadline and replacement race",
  "Race a Deadline Worker against replacement of an already CHANGES_REQUIRED current Revision whose deadline is due",
  "Only expiry or replacement is authoritative, rolled-back work emits no event and neither path can later resurrect a terminal Application",
  ["Revision HTTP", "independent Worker process", "PostgreSQL serialization", "verification snapshot"],
  async (ctx) => {
    const schedules = [];
    for (const [ordinal, mode] of B_INTERLEAVINGS.B06.entries()) {
      if (ordinal > 0) await ctx.resetDatabase();
      const item = ctx.fixtures.history(`b06-${mode}`, "CHANGES_REQUIRED", { deadlineAt: ctx.at({ days: -2 }) });
      const base = ctx.fixtures.main(`b06-${mode}-base`);
      const family = { ...base, application: item.application, revision: item.revision, seed: ctx.fixtures.seedFromHistories(`b06-${mode}`, [item]) };
      const { apis } = await boot(ctx, { family, apiCount: 2 });
      const applicationId = item.application.applicationId;
      const initial = await snapshot(ctx, apis[0].baseUrl);
      const initialRows = aggregateRows(initial, applicationId);
      let worker;
      let replacement;
      let final;
      if (mode === "replacement-before-worker-commit") {
        let held = false;
        const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => {
          if (!held && point === "worker.before-commit" && aggregateId === applicationId) { held = true; return true; }
          return false;
        } });
        worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
        const entry = await barrier.waitFor(({ json }) => json.point === "worker.before-commit" && json.aggregateId === applicationId, { timeoutMs: 120_000, processes: [worker] });
        const heldState = await snapshot(ctx, apis[0].baseUrl);
        const heldWork = heldState.work.find(({ workId }) => workId === entry.json.workId);
        ctx.equal(heldWork.state, "LEASED", "held Deadline Work is visibly leased before replacement");
        ctx.equal(heldWork.attempt, entry.json.attempt, "barrier attempt equals persisted Work attempt");
        replacement = await ctx.mutate(apis[1].baseUrl, `/api/v1/permit-applications/${applicationId}/revisions`, ctx.key(`b06-${mode}-revision`), { expectedRevision: 1, fields: { winner: "replacement" }, deadlineAt: ctx.at({ days: 3 }), reviewPolicy: family.policy });
        requireStatus(ctx, replacement, 200, "replacement commits while old Work held");
        barrier.release(entry);
        final = await waitSnapshot(ctx, apis[0].baseUrl, (value) => value.work.find(({ workId }) => workId === entry.json.workId)?.terminal && applicationFrom(value, applicationId)?.currentRevision === 2 ? value : undefined, { label: "stale Deadline Work cancellation", processes: [worker] });
        final = await observeStableSnapshot(ctx, apis[0].baseUrl, final, "released stale Deadline Worker cannot later change replacement authority");
        const finalRows = aggregateRows(final, applicationId);
        const revision2 = finalRows.revisions.find(({ revision }) => revision === 2);
        const newStages = addedRows(initialRows.stages, finalRows.stages, ({ stageId }) => stageId);
        const newWork = addedRows(initialRows.work, finalRows.work, ({ workId }) => workId);
        const events = addedEvents(initial, final, applicationId);
        ctx.equal(replacement.json, revision2, "replacement response equals exact Revision 2 authority");
        ctx.equal(finalRows.revisions, [...initialRows.revisions, revision2], "replacement adds exactly one immutable Revision");
        ctx.equal(newStages.length, 1, "replacement adds one current Stage");
        ctx.equal(newStages[0].revision, 2, "replacement Stage binds Revision 2");
        ctx.equal(newWork.length, 1, "replacement adds one future Deadline Work");
        ctx.equal(newWork[0].terminal, false, "replacement Deadline Work remains future and nonterminal");
        const oldWork = finalRows.work.find(({ workId }) => workId === entry.json.workId);
        ctx.equal(oldWork.state, "CANCELLED", "stale prior-Revision Work is cancelled, never falsely succeeded");
        ctx.equal(oldWork.attempt, entry.json.attempt, "stale Work retains the held attempt without another commit");
        ctx.equal(events.length, 1, "replacement emits one non-vacuous Event");
        ctx.equal(events[0].type, "application.submitted", "replacement Event returns aggregate to SUBMITTED");
        ctx.equal(finalRows.claims, initialRows.claims, "replacement race leaves Claims exact");
        ctx.equal(finalRows.decisions, initialRows.decisions, "replacement race leaves Decisions exact");
        ctx.equal(finalRows.permits, initialRows.permits, "replacement race leaves Permits exact");
        ctx.equal(applicationFrom(final, applicationId).state, "SUBMITTED", "replacement remains nonterminal winner");
        ctx.equal(final.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.expired").length, 0, "stale expiry emits no Event");
        assertExactChanges(ctx, initial, final, {
          added: [
            `resources.applicationRevisions:${applicationId}:2`,
            `resources.reviewStages:${newStages[0].stageId}`,
            `work:${newWork[0].workId}`,
            `events:${events[0].eventId}`,
          ],
          changed: [`resources.permitApplications:${applicationId}`, `work:${oldWork.workId}`],
        }, "replacement wins deadline race", { hardCapIds: ["REVIEW_AUTHORITY", "WORK_FENCING", "EVENT_ATOMICITY"] });
      } else {
        worker = await ctx.startWorker();
        final = await waitSnapshot(ctx, apis[0].baseUrl, (value) => applicationFrom(value, applicationId)?.state === "EXPIRED" ? value : undefined, { label: "expiry commits before replacement", processes: [worker] });
        replacement = await ctx.mutate(apis[1].baseUrl, `/api/v1/permit-applications/${applicationId}/revisions`, ctx.key(`b06-${mode}-revision`), { expectedRevision: 1, fields: { loser: "replacement" }, deadlineAt: ctx.at({ days: 3 }), reviewPolicy: family.policy });
        expectError(ctx, replacement, 409, "APPLICATION_TERMINAL");
        const afterRejectedReplacement = await snapshot(ctx, apis[0].baseUrl);
        ctx.equal(stableSnapshot(afterRejectedReplacement), stableSnapshot(final), "rejected replacement changes no Revision, Event or Work authority", { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
        final = await observeStableSnapshot(ctx, apis[0].baseUrl, afterRejectedReplacement, "terminal expiry authority cannot later resurrect");
        const finalRows = aggregateRows(final, applicationId);
        const terminalWork = finalRows.work.find(({ workId }) => workId === initialRows.work[0].workId);
        const events = addedEvents(initial, final, applicationId);
        ctx.equal(finalRows.revisions, initialRows.revisions, "expiry winner adds no Revision");
        ctx.equal(finalRows.claims, initialRows.claims, "expiry winner leaves Claims exact");
        ctx.equal(finalRows.decisions, initialRows.decisions, "expiry winner leaves Decisions exact");
        ctx.equal(finalRows.permits, initialRows.permits, "expiry winner leaves Permits exact");
        ctx.equal(finalRows.stages, initialRows.stages, "expiry winner activates no Stage");
        ctx.equal(finalRows.work.length, 1, "expiry retains exactly one Deadline Work");
        ctx.equal(terminalWork.state, "SUCCEEDED", "expiry Work succeeds exactly once");
        ctx.equal(terminalWork.attempt, initialRows.work[0].attempt + 1, "expiry Work attempt increments once");
        ctx.equal(events.length, 1, "expiry winner emits one non-vacuous Event");
        ctx.equal(events[0].type, "application.expired", "expiry Event type");
        ctx.equal(final.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.expired").length, 1, "expiry winner emits once");
        assertExactChanges(ctx, initial, final, {
          added: [`events:${events[0].eventId}`],
          changed: [`resources.permitApplications:${applicationId}`, `work:${terminalWork.workId}`],
        }, "expiry wins replacement race", { hardCapIds: ["REVIEW_AUTHORITY", "WORK_FENCING", "EVENT_ATOMICITY"] });
      }
      const authoritative = await snapshot(ctx, apis[0].baseUrl);
      ctx.equal(permitFor(authoritative, applicationId), undefined, `${mode} invents no Permit`, { hardCapIds: ["REVIEW_AUTHORITY"] });
      schedules.push({ mode, applicationId, state: applicationFrom(authoritative, applicationId).state, currentRevision: applicationFrom(authoritative, applicationId).currentRevision, replacementStatus: replacement.status });
    }
    return caseResult(ctx, { schedules });
  },
  [blocked("PF-B06-DECISION-RACE", "PF-GAP-01")],
);

const b07 = defineCase(
  "B-07",
  "PF-F-IDEMPOTENCY unknown response matrix",
  "Drop complete upstream responses for submit, Claim, replacement Revision and FINAL staged submit, restart the API and retry every exact key and body",
  "Each retry preserves original status and semantic JSON while every Application, Revision, Claim, Stage, Work and Event effect exists exactly once",
  ["response shield", "API restart", "public mutation HTTP", "verification snapshot"],
  async (ctx) => {
    const changes = ctx.fixtures.history("b07-changes", "CHANGES_REQUIRED");
    const claimable = ctx.fixtures.history("b07-claimable", "SUBMITTED");
    const base = ctx.fixtures.finalStages("b07");
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("b07", [changes, claimable]) };
    const { api } = await boot(ctx, { family });
    const shield = await ctx.responseShield(api.baseUrl);
    const attempts = [
      { label: "submit", path: "/api/v1/permit-applications", body: ctx.fixtures.submissionBody("b07-submit") },
      { label: "claim", path: `/api/v1/permit-applications/${claimable.application.applicationId}/review-claims`, body: { reviewerId: family.securityReviewers[1].reviewerId, role: "security" } },
      { label: "revision", path: `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, body: { expectedRevision: 1, fields: { b07: true }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy } },
      { label: "staged", path: "/api/v1/permit-applications", body: ctx.fixtures.stagedBody(5, "b07-staged") },
    ];
    const saved = [];
    for (const item of attempts) {
      const before = await snapshot(ctx, api.baseUrl);
      const captureCount = shield.captures.length;
      shield.dropNextMutation();
      await ctx.mutate(shield.baseUrl, item.path, ctx.key(`b07-${item.label}`), item.body).catch(() => undefined);
      const capture = shield.captures.slice(captureCount).find(({ dropped }) => dropped);
      ctx.ok(capture, `${item.label} response committed then dropped`);
      ctx.equal(capture.response.status, item.label === "submit" || item.label === "staged" ? 201 : 200, `${item.label} first use succeeds before response loss`);
      const after = await snapshot(ctx, api.baseUrl);
      const authority = assertOperationEffects(ctx, before, after, item, resultJson(capture));
      saved.push({ ...item, capture, authority, after });
    }
    await ctx.stop(api);
    const restarted = await ctx.startApi();
    for (const item of saved) {
      const beforeReplay = await snapshot(ctx, restarted.baseUrl);
      const replay = await ctx.mutate(restarted.baseUrl, item.path, ctx.key(`b07-${item.label}`), item.body);
      ctx.equal(replay.status, item.capture.response.status, `${item.label} replay status`);
      ctx.equal(replay.json, resultJson(item.capture), `${item.label} replay semantic body`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
      const afterReplay = await snapshot(ctx, restarted.baseUrl);
      ctx.equal(stableSnapshot(afterReplay), stableSnapshot(beforeReplay), `${item.label} replay creates no second effect`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    }
    const state = await snapshot(ctx, restarted.baseUrl);
    const submittedIds = saved.filter(({ label }) => label === "submit" || label === "staged").map(({ authority }) => authority.applicationId);
    for (const applicationId of submittedIds) {
      ctx.equal(state.resources.permitApplications.filter((item) => item.applicationId === applicationId).length, 1, `${applicationId} one Application`);
      ctx.equal(state.work.filter(({ aggregateId }) => aggregateId === applicationId).length, 1, `${applicationId} one Deadline Work`);
      ctx.equal(state.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.submitted").length, 1, `${applicationId} one submit Event`);
    }
    const stagedId = submittedIds[1];
    ctx.equal(state.resources.reviewStages.filter(({ applicationId }) => applicationId === stagedId).length, 5, "staged replay has exactly five Stages");
    return caseResult(ctx, { droppedResponses: saved.length, applicationIds: submittedIds, claimId: saved.find(({ label }) => label === "claim").authority.claimId, replacementRevision: saved.find(({ label }) => label === "revision").authority.revision });
  },
  [blocked("PF-B07-DECISION-REPLAY", "PF-GAP-01")],
);

const b08 = defineCase(
  "B-08",
  "PF-F-IDEMPOTENCY two-API authority storms",
  "Run 64-way same-key first use, same-key different-body conflict and third-API restart replay for submit, Claim, replacement Revision and staged submit",
  "Every storm converges on one durable response and effect, conflicts are exact IDEMPOTENCY_CONFLICT with zero effect and replay does not rely on process memory",
  ["two API processes", "64-way concurrent HTTP", "third API restart", "verification snapshot"],
  async (ctx) => {
    const changes = ctx.fixtures.history("b08-changes", "CHANGES_REQUIRED");
    const claimable = ctx.fixtures.history("b08-claimable", "SUBMITTED");
    const base = ctx.fixtures.finalStages("b08");
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("b08", [changes, claimable]) };
    const { apis } = await boot(ctx, { family, apiCount: 2 });
    const operations = [
      { label: "submit", path: "/api/v1/permit-applications", body: ctx.fixtures.submissionBody("b08-submit"), conflict: ctx.fixtures.submissionBody("b08-submit-conflict") },
      { label: "claim", path: `/api/v1/permit-applications/${claimable.application.applicationId}/review-claims`, body: { reviewerId: family.securityReviewers[1].reviewerId, role: "security" }, conflict: { reviewerId: family.securityReviewers[0].reviewerId, role: "security" } },
      { label: "revision", path: `/api/v1/permit-applications/${changes.application.applicationId}/revisions`, body: { expectedRevision: 1, fields: { b08: true }, deadlineAt: ctx.at({ days: 5 }), reviewPolicy: family.policy }, conflict: { expectedRevision: 1, fields: { b08: "conflict" }, deadlineAt: ctx.at({ days: 5 }), reviewPolicy: family.policy } },
      { label: "staged", path: "/api/v1/permit-applications", body: ctx.fixtures.stagedBody(5, "b08-staged"), conflict: ctx.fixtures.stagedBody(2, "b08-conflict") },
    ];
    const authorities = [];
    for (const operation of operations) {
      const key = ctx.key(`b08-${operation.label}`);
      const before = await snapshot(ctx, apis[0].baseUrl);
      const responses = await frozenClientBarrier(ctx, Array.from({ length: 64 }, (_, index) => ({
        baseUrl: apis[index % 2].baseUrl,
        path: operation.path,
        key,
        body: operation.body,
      })), `${operation.label} 64-way same-key first use`);
      const authority = stableResponse(ctx, responses, `${operation.label} same-key storm`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
      requireStatus(ctx, authority, operation.label === "submit" || operation.label === "staged" ? 201 : 200, `${operation.label} first-use authority`);
      const afterFirstUse = await snapshot(ctx, apis[0].baseUrl);
      const effect = assertOperationEffects(ctx, before, afterFirstUse, operation, authority.json);
      const conflict = await ctx.mutate(apis[1].baseUrl, operation.path, key, operation.conflict);
      expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
      const afterConflict = await snapshot(ctx, apis[0].baseUrl);
      ctx.equal(stableSnapshot(afterConflict), stableSnapshot(afterFirstUse), `${operation.label} conflict has zero business effect`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
      authorities.push({ operation, key, authority, effect });
    }
    await ctx.stop(apis[0]);
    await ctx.stop(apis[1]);
    const third = await ctx.startApi();
    for (const { operation, key, authority } of authorities) {
      const beforeReplay = await snapshot(ctx, third.baseUrl);
      const replay = await ctx.mutate(third.baseUrl, operation.path, key, operation.body);
      ctx.equal(replay.status, authority.status, `${operation.label} restart status`);
      ctx.equal(replay.json, authority.json, `${operation.label} restart body`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
      const afterReplay = await snapshot(ctx, third.baseUrl);
      ctx.equal(stableSnapshot(afterReplay), stableSnapshot(beforeReplay), `${operation.label} third-process replay has zero effect`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    }
    const state = await snapshot(ctx, third.baseUrl);
    for (const { operation, effect } of authorities) {
      if (effect.applicationId) ctx.equal(state.resources.permitApplications.filter(({ applicationId }) => applicationId === effect.applicationId).length, 1, `${operation.label} authority Application remains unique`);
      if (effect.claimId) ctx.equal(state.resources.reviewClaims.filter(({ claimId }) => claimId === effect.claimId).length, 1, `${operation.label} authority Claim remains unique`);
      if (effect.revision) ctx.equal(revisionsFor(state, effect.applicationId).filter(({ revision }) => revision === effect.revision).length, 1, `${operation.label} authority Revision remains unique`);
    }
    return caseResult(ctx, { operations: authorities.map(({ operation, effect }) => ({ label: operation.label, ...effect })), storms: 256 });
  },
  [blocked("PF-B08-DECISION-AUTHORITY", "PF-GAP-01")],
);

const b09 = defineCase(
  "B-09",
  "PF-F-FINAL-STAGES five-Stage atomicity",
  "Submit one legal five-Stage body 64 ways through two APIs with the same key, then reuse that key with an invalid nested policy and a different legal body",
  "Exactly one Application and immutable Revision exist with an all-or-nothing five-Stage set, only Stage 1 is ACTIVE, replay is stable and conflicts have zero side effect",
  ["two API processes", "staged Application HTTP", "concurrent PostgreSQL commit", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.finalStages("b09");
    const { apis } = await boot(ctx, { family, seed: emptySeed(family), apiCount: 2 });
    const body = ctx.fixtures.stagedBody(5, "b09");
    const key = ctx.key("b09-staged");
    const before = await snapshot(ctx, apis[0].baseUrl);
    const responses = await frozenClientBarrier(ctx, Array.from({ length: 64 }, (_, index) => ({
      baseUrl: apis[index % 2].baseUrl,
      path: "/api/v1/permit-applications",
      key,
      body,
    })), "five Stage 64-way same-key first use");
    const authority = stableResponse(ctx, responses, "five Stage same-key responses", { hardCapIds: ["DURABLE_IDEMPOTENCY", "REVIEW_AUTHORITY"] });
    requireStatus(ctx, authority, 201, "five Stage first-use authority");
    const committed = await snapshot(ctx, apis[0].baseUrl);
    const effect = assertOperationEffects(ctx, before, committed, { label: "staged", body }, authority.json);
    const applicationId = effect.applicationId;
    const invalidBody = { ...body, stages: [{ name: "bad", reviewPolicy: { roles: [], requiredTotalApprovals: 1 } }] };
    expectError(ctx, await ctx.mutate(apis[0].baseUrl, "/api/v1/permit-applications", ctx.key("b09-invalid-fresh"), invalidBody), 400, "INVALID_REVIEW_STAGES");
    ctx.equal(stableSnapshot(await snapshot(ctx, apis[0].baseUrl)), stableSnapshot(committed), "fresh-key invalid nested policy has zero aggregate effect");
    expectError(ctx, await ctx.mutate(apis[1].baseUrl, "/api/v1/permit-applications", key, ctx.fixtures.stagedBody(2, "b09-different-legal")), 409, "IDEMPOTENCY_CONFLICT");
    const state = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal(stableSnapshot(state), stableSnapshot(committed), "same-key different legal body has zero effect", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    ctx.equal(state.resources.permitApplications.filter((item) => item.applicationId === applicationId).length, 1, "one staged Application");
    ctx.equal(revisionsFor(state, applicationId).length, 1, "one staged Revision");
    const stages = state.resources.reviewStages.filter((item) => item.applicationId === applicationId);
    ctx.assert("complete atomic five Stage set", () => assertStageSet(stages, 5), { hardCapIds: ["REVIEW_AUTHORITY"] });
    let work;
    ctx.assert("staged creation retains exact nonterminal Deadline Work", () => { work = assertSingleAggregateWork(state.work, applicationId, { terminal: false }); });
    ctx.equal(state.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.submitted").length, 1, "staged creation has one submitted Event", { hardCapIds: ["EVENT_ATOMICITY"] });
    return caseResult(ctx, { applicationId, stageIds: stages.map(({ stageId }) => stageId), workId: work.workId });
  },
);

const b10 = defineCase(
  "B-10",
  "PF-F-FINAL-STAGES current Stage deadline race",
  "Create a due three-Stage Application, race three current-Stage Claim requests through two APIs against two Deadline Workers and repeat the interleaving under one seed",
  "After expiry no new leased Claim appears, the terminal Application activates no later Stage, issues no Permit and retains a gapless event history",
  ["staged Application HTTP", "two API processes", "two Worker processes", "verification snapshot"],
  async (ctx) => {
    const schedules = [];
    for (const [ordinal, mode] of B_INTERLEAVINGS.B10.entries()) {
      if (ordinal > 0) await ctx.resetDatabase();
      const family = ctx.fixtures.finalStages(`b10-${mode}`);
      const { apis } = await boot(ctx, { family, seed: emptySeed(family), apiCount: 2 });
      const body = ctx.fixtures.stagedBody(3, `b10-${mode}`, { deadlineAt: new Date(Date.now() + 3_000).toISOString() });
      const created = await submitApplication(ctx, apis[0].baseUrl, body, `b10-${mode}-create`);
      const applicationId = created.application.applicationId;
      const path = `/api/v1/permit-applications/${applicationId}/review-claims`;
      const createdState = await snapshot(ctx, apis[0].baseUrl);
      const createdRows = aggregateRows(createdState, applicationId);
      ctx.assert(`${mode} initial three-Stage set`, () => assertStageSet(createdRows.stages, 3));
      const claimRequests = () => frozenClientBarrier(ctx, family.securityReviewers.map((reviewer, index) => ({
        baseUrl: apis[index % 2].baseUrl,
        path,
        key: ctx.key(`b10-${mode}-claim-${index}`),
        body: { reviewerId: reviewer.reviewerId, role: "security" },
      })), `${mode} three-way Claim dispatch`);
      let claims;
      let beforeClaims;
      let claimedState;
      let successfulClaims = [];
      let final;
      if (mode === "claim-before-deadline") {
        beforeClaims = createdState;
        claims = await claimRequests();
        ctx.ok(claims.every(({ status }) => status === 200 || status === 409), `${mode} all Claim race responses are published outcomes`);
        ctx.equal(claims.filter(({ status }) => status === 200).length, 2, "two current-Stage role slots claimed before deadline");
        claims.filter(({ status }) => status === 409).forEach((response) => expectError(ctx, response, 409, "REVIEW_SLOT_UNAVAILABLE"));
        claimedState = await snapshot(ctx, apis[0].baseUrl);
        const workers = [await ctx.startWorker(), await ctx.startWorker()];
        final = await waitSnapshot(ctx, apis[0].baseUrl, (value) => applicationFrom(value, applicationId)?.state === "EXPIRED" ? value : undefined, { label: `${mode} expiry`, timeoutMs: 30_000, processes: workers });
      } else if (mode === "claim-while-worker-held") {
        const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.before-commit" && aggregateId === applicationId });
        const firstWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
        const entry = await barrier.waitFor(({ json }) => json.point === "worker.before-commit" && json.aggregateId === applicationId, { timeoutMs: 30_000, processes: [firstWorker] });
        beforeClaims = await snapshot(ctx, apis[0].baseUrl);
        claims = await claimRequests();
        ctx.ok(claims.every(({ status }) => status === 200 || status === 409), `${mode} all Claim race responses are published outcomes`);
        ctx.equal(claims.filter(({ status }) => status === 200).length, 2, "two claims commit while expiry transaction is not open");
        claims.filter(({ status }) => status === 409).forEach((response) => expectError(ctx, response, 409, "REVIEW_SLOT_UNAVAILABLE"));
        claimedState = await snapshot(ctx, apis[0].baseUrl);
        barrier.release(entry);
        const workers = [firstWorker, await ctx.startWorker()];
        final = await waitSnapshot(ctx, apis[0].baseUrl, (value) => applicationFrom(value, applicationId)?.state === "EXPIRED" ? value : undefined, { label: `${mode} expiry`, timeoutMs: 30_000, processes: workers });
      } else {
        const workers = [await ctx.startWorker(), await ctx.startWorker()];
        final = await waitSnapshot(ctx, apis[0].baseUrl, (value) => applicationFrom(value, applicationId)?.state === "EXPIRED" ? value : undefined, { label: `${mode} terminal authority`, timeoutMs: 30_000, processes: workers });
        beforeClaims = final;
        claims = await claimRequests();
        claims.forEach((response) => expectError(ctx, response, 409, "APPLICATION_TERMINAL"));
        ctx.equal(stableSnapshot(await snapshot(ctx, apis[0].baseUrl)), stableSnapshot(beforeClaims), `${mode} post-expiry Claims have exact zero effect`);
      }
      final = await observeStableSnapshot(ctx, apis[0].baseUrl, final, `${mode} terminal authority and Stage activation history remain stable`);
      if (claimedState) {
        successfulClaims = claims.filter(({ status }) => status === 200).map(({ json }) => claimResource(json));
        const beforeClaimRows = aggregateRows(beforeClaims, applicationId);
        const afterClaimRows = aggregateRows(claimedState, applicationId);
        const claimEvents = addedEvents(beforeClaims, claimedState, applicationId);
        ctx.equal(successfulClaims.length, 2, `${mode} two non-vacuous Claim authorities`);
        for (const claim of successfulClaims) {
          ctx.equal(claimedState.resources.reviewClaims.find(({ claimId }) => claimId === claim.claimId), claim, `${mode} Claim response ${claim.claimId} equals persisted authority`);
          ctx.equal(claim.revision, 1, `${mode} Claim binds current Revision`);
          ctx.equal(claim.state, "LEASED", `${mode} Claim visibly leased before expiry`);
        }
        ctx.equal(afterClaimRows.claims.length, 2, `${mode} exact persisted Claim cardinality before expiry`);
        ctx.equal(claimEvents.length, 2, `${mode} exact Claim Event count before expiry`);
        ctx.ok(claimEvents.every(({ type }) => type === "review.claimed"), `${mode} every Claim Event has published type`);
        ctx.equal(afterClaimRows.revisions, beforeClaimRows.revisions, `${mode} Claim race leaves Revisions exact`);
        ctx.equal(afterClaimRows.decisions, beforeClaimRows.decisions, `${mode} Claim race leaves Decisions exact`);
        ctx.equal(afterClaimRows.permits, beforeClaimRows.permits, `${mode} Claim race leaves Permits exact`);
        ctx.equal(afterClaimRows.stages, beforeClaimRows.stages, `${mode} Claim race leaves Stages exact`);
        ctx.equal(afterClaimRows.work, beforeClaimRows.work, `${mode} held Work is unchanged while Claims commit`);
        ctx.equal(afterClaimRows.application[0].state, "UNDER_REVIEW", `${mode} Claims move aggregate to UNDER_REVIEW`);
        ctx.equal(afterClaimRows.application[0].sequence, beforeClaimRows.application[0].sequence + 2, `${mode} two Claim Events advance sequence twice`);
        assertExactChanges(ctx, beforeClaims, claimedState, {
          added: [
            ...successfulClaims.map(({ claimId }) => `resources.reviewClaims:${claimId}`),
            ...claimEvents.map(({ eventId }) => `events:${eventId}`),
          ],
          changed: [`resources.permitApplications:${applicationId}`],
        }, `${mode} pre-expiry Claim race`, { hardCapIds: ["REVIEW_AUTHORITY", "EVENT_ATOMICITY"] });
      }
      const application = applicationFrom(final, applicationId);
      ctx.equal(application.state, "EXPIRED", `${mode} staged Application terminal expiry`);
      const finalRows = aggregateRows(final, applicationId);
      ctx.equal(finalRows.claims.length, successfulClaims.length, `${mode} terminal retains exact Claim history`);
      ctx.equal(finalRows.claims.filter(({ state }) => state === "LEASED").length, 0, `${mode} terminal has no live Claim`);
      for (const claim of successfulClaims) {
        const retained = finalRows.claims.find(({ claimId }) => claimId === claim.claimId);
        ctx.ok(retained, `${mode} successful Claim ${claim.claimId} retained`);
        ctx.equal(retained.state, "EXPIRED", `${mode} successful Claim becomes EXPIRED at deadline`);
        ctx.equal({ applicationId: retained.applicationId, revision: retained.revision, reviewerId: retained.reviewerId, role: retained.role, attempt: retained.attempt }, { applicationId: claim.applicationId, revision: claim.revision, reviewerId: claim.reviewerId, role: claim.role, attempt: claim.attempt }, `${mode} expired Claim tuple immutable`);
      }
      ctx.equal(finalRows.stages.map(({ stageId }) => stageId), createdRows.stages.map(({ stageId }) => stageId), `${mode} Stage identities retained exactly`);
      ctx.equal(finalRows.stages.filter(({ state }) => state === "ACTIVE").length, 0, `${mode} terminal has no ACTIVE Stage`);
      for (const initialStage of createdRows.stages.filter(({ ordinal }) => ordinal > 1)) {
        const retained = finalRows.stages.find(({ stageId }) => stageId === initialStage.stageId);
        ctx.equal(retained.activatedAt, null, `${mode} later Stage was never activated`);
        ctx.equal(retained.completedAt, null, `${mode} never-activated Stage was not completed`);
        ctx.ok(retained.state === "PENDING" || retained.state === "TERMINAL", `${mode} later Stage never reaches COMPLETED`);
      }
      ctx.equal(permitFor(final, applicationId), undefined, `${mode} has no Permit`);
      let work;
      ctx.assert(`${mode} exact retained terminal Deadline Work`, () => { work = assertSingleAggregateWork(final.work, applicationId, { terminal: true }); });
      ctx.equal(work.workId, createdRows.work[0].workId, `${mode} Deadline Work identity retained`);
      ctx.equal(work.state, "SUCCEEDED", `${mode} Deadline Work succeeds once`);
      ctx.equal(work.attempt, createdRows.work[0].attempt + 1, `${mode} Deadline Work attempt increments once`);
      ctx.equal(final.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.expired").length, 1, `${mode} one expiry Event`, { hardCapIds: ["EVENT_ATOMICITY"] });
      const transitionEvents = addedEvents(createdState, final, applicationId);
      ctx.equal(transitionEvents.length, successfulClaims.length + 1, `${mode} exact Claim plus expiry Event count`);
      ctx.equal(transitionEvents.filter(({ type }) => type === "review.claimed").length, successfulClaims.length, `${mode} Claim Event count`);
      ctx.equal(transitionEvents.filter(({ type }) => type === "application.expired").length, 1, `${mode} expiry Event count`);
      ctx.equal(finalRows.revisions, createdRows.revisions, `${mode} Revision authority unchanged`);
      ctx.equal(finalRows.decisions, createdRows.decisions, `${mode} no Decision invented`);
      ctx.equal(finalRows.permits, createdRows.permits, `${mode} no Permit invented`);
      ctx.equal(application.sequence, createdRows.application[0].sequence + transitionEvents.length, `${mode} exact aggregate sequence advance`);
      const sequences = final.events.filter(({ aggregateId }) => aggregateId === applicationId).map(({ sequence }) => sequence);
      ctx.equal(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1), `${mode} Event sequence gapless`, { hardCapIds: ["EVENT_ATOMICITY"] });
      const changedStages = finalRows.stages.filter((stage) => canonicalJson(stage) !== canonicalJson(createdRows.stages.find(({ stageId }) => stageId === stage.stageId)));
      assertExactChanges(ctx, createdState, final, {
        added: [
          ...successfulClaims.map(({ claimId }) => `resources.reviewClaims:${claimId}`),
          ...transitionEvents.map(({ eventId }) => `events:${eventId}`),
        ],
        changed: [
          `resources.permitApplications:${applicationId}`,
          `work:${work.workId}`,
          ...changedStages.map(({ stageId }) => `resources.reviewStages:${stageId}`),
        ],
      }, `${mode} complete deadline race`, { hardCapIds: ["REVIEW_AUTHORITY", "WORK_FENCING", "EVENT_ATOMICITY"] });
      schedules.push({ mode, applicationId, claimStatuses: claims.map(({ status }) => status), workId: work.workId, eventCount: sequences.length });
    }
    return caseResult(ctx, { schedules });
  },
  [blocked("PF-B10-STALE-STAGE-DECISION", "PF-GAP-01"), blocked("PF-B10-CLAIM-STAGE-ASSOCIATION", "PF-GAP-04")],
);

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05, b06, b07, b08, b09, b10]);
