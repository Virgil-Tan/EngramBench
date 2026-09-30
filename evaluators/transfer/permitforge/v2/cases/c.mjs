import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";

import {
  assertAggregateSequences,
  assertRecoveredDelivery,
  assertRetryIdentity,
  assertSingleAggregateWork,
  assertWork,
} from "../oracles/index.mjs";
import {
  applicationFrom,
  assertExternalSecretBoundary,
  blocked,
  boot,
  caseResult,
  claimsFor,
  crashDeadlineAt,
  createRevision,
  defineCase,
  expectError,
  findObject,
  claimResource,
  permitFor,
  snapshot,
  stableSnapshot,
  submitApplication,
  waitSnapshot,
} from "./helpers.mjs";

export function assertDeliveryMatchesEvent(delivery, barrierEntry, event) {
  assert.ok(typeof barrierEntry.json.workId === "string" && barrierEntry.json.workId.length > 0, "dispatcher barrier has an independent Work identity");
  assert.equal(barrierEntry.json.aggregateId, event.aggregateId, "dispatcher barrier aggregate is the persisted Event aggregate");
  assert.equal(delivery.headers["x-permitforge-event-id"], event.eventId, "delivery Event ID");
  assert.equal(delivery.headers["x-permitforge-event-type"], event.type, "delivery Event type");
  assert.deepEqual(delivery.json, event, "delivery body is the exact persisted Event");
  return true;
}

export function assertSuccessfulDeliverySequence(ledger, events) {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const priorByAggregate = new Map();
  let successful = 0;
  for (const delivery of ledger) {
    if (!delivery.acknowledged || delivery.responseStatus < 200 || delivery.responseStatus >= 300) continue;
    const eventId = delivery.headers?.["x-permitforge-event-id"];
    const event = byId.get(eventId);
    assert.ok(event, `successful delivery ${eventId ?? "<missing>"} resolves a persisted Event`);
    const prior = priorByAggregate.get(event.aggregateId) ?? 0;
    assert.ok(event.sequence >= prior, `successful delivery sequence regressed for ${event.aggregateId}`);
    priorByAggregate.set(event.aggregateId, event.sequence);
    successful += 1;
  }
  assert.ok(successful > 0, "at least one successful delivery is observed");
  return { successful, aggregates: priorByAggregate.size };
}

export function assertExactDeadlineRecovery(initial, held, final, barrierEntry) {
  const aggregateId = barrierEntry.json.aggregateId;
  const beforeRows = aggregateAuthority(initial, aggregateId);
  const heldRows = aggregateAuthority(held, aggregateId);
  const afterRows = aggregateAuthority(final, aggregateId);
  assert.equal(barrierEntry.json.workId, beforeRows.work[0]?.workId, "barrier binds the exact target Work identity");
  assert.equal(beforeRows.work.length, 1, "target starts with one Work");
  assert.equal(heldRows.work.length, 1, "held target retains one Work");
  assert.equal(afterRows.work.length, 1, "recovered target retains one Work");
  assert.equal(heldRows.work[0].workId, beforeRows.work[0].workId, "held Work identity is stable");
  assert.equal(heldRows.work[0].attempt, beforeRows.work[0].attempt + 1, "held claim advances attempt exactly once");
  assert.equal(heldRows.work[0].state, "LEASED", "held Work is visibly leased");
  assert.equal(barrierEntry.json.attempt, heldRows.work[0].attempt, "barrier attempt binds the held Work");
  assert.deepEqual(heldRows.application, beforeRows.application, "barrier exposes no partial Application effect");
  assert.deepEqual(heldRows.revisions, beforeRows.revisions, "barrier exposes no partial Revision effect");
  assert.deepEqual(heldRows.claims, beforeRows.claims, "barrier exposes no partial Claim effect");
  assert.deepEqual(heldRows.decisions, beforeRows.decisions, "barrier exposes no partial Decision effect");
  assert.deepEqual(heldRows.permits, beforeRows.permits, "barrier exposes no partial Permit effect");
  assert.deepEqual(heldRows.stages, beforeRows.stages, "barrier exposes no partial Stage effect");
  assert.deepEqual(heldRows.events, beforeRows.events, "barrier exposes no partial Event effect");
  assert.equal(afterRows.work[0].workId, beforeRows.work[0].workId, "replacement preserves Work identity");
  assert.equal(afterRows.work[0].attempt, heldRows.work[0].attempt + 1, "replacement advances attempt exactly once");
  assert.equal(afterRows.work[0].state, "SUCCEEDED", "replacement Work succeeds");
  assert.equal(afterRows.work[0].terminal, true, "replacement Work is terminal");
  assert.equal(afterRows.work[0].leaseOwner, null, "terminal Work clears owner");
  assert.equal(afterRows.work[0].leaseExpiresAt, null, "terminal Work clears lease expiry");
  assert.equal(afterRows.application.length, 1, "target retains one Application");
  assert.equal(afterRows.application[0].state, "EXPIRED", "target expires once");
  assert.equal(afterRows.application[0].sequence, beforeRows.application[0].sequence + 1, "target sequence advances once");
  assert.deepEqual(afterRows.revisions, beforeRows.revisions, "recovery leaves Revision history exact");
  assert.deepEqual(afterRows.claims, beforeRows.claims, "recovery leaves Claim history exact");
  assert.deepEqual(afterRows.decisions, beforeRows.decisions, "recovery leaves Decision history exact");
  assert.deepEqual(afterRows.permits, beforeRows.permits, "recovery invents no Permit");
  assert.deepEqual(afterRows.stages.map(({ stageId }) => stageId), beforeRows.stages.map(({ stageId }) => stageId), "recovery retains Stage identities");
  assert.equal(afterRows.stages.filter(({ state }) => state === "ACTIVE").length, 0, "terminal aggregate has no ACTIVE Stage");
  const newEvents = addedBy(beforeRows.events, afterRows.events, ({ eventId }) => eventId);
  assert.equal(newEvents.length, 1, "recovery emits exactly one Event");
  assert.equal(newEvents[0].type, "application.expired", "recovery emits the published expiry Event");
  return { work: afterRows.work[0], event: newEvents[0] };
}

function closeServer(server, sockets) {
  return new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    if (!server.listening) resolve();
    else server.close(resolve);
  });
}

/** Hold a complete upstream mutation response so the API can be SIGKILLed after commit but before client acknowledgement. */
export async function createMutationCommitBarrier(ctx, upstreamBaseUrl) {
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  const sockets = new Set();
  let action = "pending";
  let used = false;
  const server = createServer(async (incoming, outgoing) => {
    if (used) { outgoing.writeHead(409).end(); return; }
    used = true;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const requestBody = Buffer.concat(chunks);
    const target = new URL(incoming.url ?? "/", upstreamBaseUrl);
    const capture = await new Promise((resolve, reject) => {
      const headers = { ...incoming.headers, host: target.host };
      const upstream = httpRequest(target, { method: incoming.method, headers }, (response) => {
        const responseChunks = [];
        response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          request: { method: incoming.method, path: `${target.pathname}${target.search}`, body: requestBody.toString("utf8") },
          response: { status: response.statusCode ?? 502, headers: { ...response.headers }, body: Buffer.concat(responseChunks) },
        }));
      });
      upstream.on("error", reject);
      upstream.end(requestBody);
    });
    committed.resolve(capture);
    await release.promise;
    if (action === "drop") outgoing.destroy();
    else if (!outgoing.destroyed) {
      outgoing.writeHead(capture.response.status, capture.response.headers);
      outgoing.end(capture.response.body);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (action === "pending") { action = "drop"; release.resolve(); }
    await closeServer(server, sockets);
  };
  ctx.defer(close);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    waitForCommit: () => committed.promise,
    drop() { if (action === "pending") { action = "drop"; release.resolve(); } },
    acknowledge() { if (action === "pending") { action = "acknowledge"; release.resolve(); } },
    close,
  };
}

function dueFamily(ctx, label) {
  const due = ctx.fixtures.history(label, "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
  const base = ctx.fixtures.main(`${label}-base`);
  return { ...base, application: due.application, revision: due.revision, seed: ctx.fixtures.seedFromHistories(label, [due]) };
}

function exactAggregateWork(ctx, work, aggregateId, options, label) {
  let selected;
  ctx.assert(label, () => { selected = assertSingleAggregateWork(work, aggregateId, options); });
  return selected;
}

async function observeStableAuthority(ctx, baseUrl, expected, label, durationMs = 3_300) {
  const deadline = Date.now() + durationMs;
  let observed = expected;
  while (Date.now() < deadline) {
    await ctx.sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    observed = await snapshot(ctx, baseUrl);
    ctx.equal(stableSnapshot(observed), stableSnapshot(expected), label, { hardCapIds: ["WORK_FENCING"] });
  }
  return observed;
}

function aggregateAuthority(state, applicationId) {
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

function authorityWithoutAggregate(state, applicationId) {
  return {
    resources: {
      applicants: state.resources.applicants,
      reviewers: state.resources.reviewers,
      permitApplications: state.resources.permitApplications.filter((item) => item.applicationId !== applicationId),
      applicationRevisions: state.resources.applicationRevisions.filter((item) => item.applicationId !== applicationId),
      reviewClaims: state.resources.reviewClaims.filter((item) => item.applicationId !== applicationId),
      reviewDecisions: state.resources.reviewDecisions.filter((item) => item.applicationId !== applicationId),
      approvedPermits: state.resources.approvedPermits.filter((item) => item.applicationId !== applicationId),
      reviewStages: state.resources.reviewStages.filter((item) => item.applicationId !== applicationId),
    },
    work: state.work.filter((item) => item.aggregateId !== applicationId),
    events: state.events.filter((item) => item.aggregateId !== applicationId),
  };
}

function addedBy(before, after, identity) {
  const existing = new Set(before.map(identity));
  return after.filter((item) => !existing.has(identity(item)));
}

const c01 = defineCase(
  "C-01",
  "PF-F-WORK-EVENT mixed Deadline Work",
  "Seed future, due and terminal Applications, hold a real Worker through lease expiry, reclaim the same due Work with a second Worker, then release the stale owner",
  "PENDING, LEASED, SUCCEEDED and CANCELLED are exercised through published seams; every Work has the exact shape, attempts never regress, terminal rows remain retained and drain excludes only future Work; FAILED is shape-valid but not induced because no public failure seam is published",
  ["public seed", "two Worker processes", "worker.claimed barrier", "verification snapshot"],
  async (ctx) => {
    const future = ctx.fixtures.history("c01-future", "SUBMITTED", { deadlineAt: ctx.at({ days: 3 }) });
    const due = ctx.fixtures.history("c01-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const terminal = ctx.fixtures.history("c01-terminal", "APPROVED", { deadlineAt: ctx.at({ days: -2 }) });
    const base = ctx.fixtures.main("c01-base");
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("c01", [future, due, terminal]) };
    const { api } = await boot(ctx, { family });
    const initial = await snapshot(ctx, api.baseUrl);
    const initialDue = aggregateAuthority(initial, due.application.applicationId);
    const initialUnrelated = authorityWithoutAggregate(initial, due.application.applicationId);
    const futureWork = exactAggregateWork(ctx, initial.work, future.application.applicationId, { terminal: false }, "future Application has one retained nonterminal Work");
    const dueWork = exactAggregateWork(ctx, initial.work, due.application.applicationId, { terminal: false }, "due Application has one claimable Work");
    const terminalWork = exactAggregateWork(ctx, initial.work, terminal.application.applicationId, { terminal: true }, "terminal Application has one retained terminal Work");
    ctx.equal(futureWork.state, "PENDING", "future Work starts PENDING");
    ctx.equal(dueWork.state, "PENDING", "due Work starts PENDING before a Worker claims it");
    ctx.equal(terminalWork.state, "CANCELLED", "already-approved Application retains CANCELLED deadline Work");
    let held = false;
    const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => {
      if (!held && point === "worker.claimed" && aggregateId === due.application.applicationId) { held = true; return true; }
      return false;
    } });
    const first = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const entry = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.aggregateId === due.application.applicationId, { timeoutMs: 120_000, processes: [first] });
    const leased = await snapshot(ctx, api.baseUrl);
    const claimed = leased.work.find(({ workId }) => workId === entry.json.workId);
    ctx.assert("claimed Work exact", () => assertWork(claimed));
    ctx.equal(claimed.workId, dueWork.workId, "Worker claims the due Work identity");
    ctx.equal(entry.json.attempt, claimed.attempt, "worker.claimed barrier attempt binds the visible lease");
    ctx.equal(claimed.state, "LEASED", "due Work visibly leased");
    ctx.equal(claimed.attempt, dueWork.attempt + 1, "first claim advances due Work attempt once");
    ctx.ok(typeof claimed.leaseOwner === "string" && claimed.leaseOwner.length > 0, "LEASED Work exposes a nonempty owner");
    ctx.ok(Date.parse(claimed.leaseExpiresAt) > Date.now(), "LEASED Work exposes a future expiry");
    const leasedDue = aggregateAuthority(leased, due.application.applicationId);
    ctx.equal({ ...leasedDue, work: undefined }, { ...initialDue, work: undefined }, "claim changes only due Work lease authority");
    ctx.equal(authorityWithoutAggregate(leased, due.application.applicationId), initialUnrelated, "claim leaves every unrelated aggregate exact");
    await ctx.sleep(3_300);
    const second = await ctx.startWorker();
    const replacement = await waitSnapshot(ctx, api.baseUrl, (value) => value.work.find(({ workId }) => workId === claimed.workId)?.terminal ? value : undefined, { label: "Deadline Work reclaim and drain", processes: [second] });
    const recoveredWork = exactAggregateWork(ctx, replacement.work, due.application.applicationId, { terminal: true }, "reclaimed due Work is retained terminal");
    ctx.equal(recoveredWork.workId, claimed.workId, "reclaim preserves Work identity");
    ctx.equal(recoveredWork.attempt, claimed.attempt + 1, "reclaim advances Work attempt exactly once", { hardCapIds: ["WORK_FENCING"] });
    barrier.release(entry);
    const final = await observeStableAuthority(ctx, api.baseUrl, replacement, "stale first Worker cannot alter replacement authority");
    await ctx.stop(first);
    final.work.forEach(assertWork);
    const finalFutureWork = exactAggregateWork(ctx, final.work, future.application.applicationId, { terminal: false }, "future Work remains present and nonterminal");
    const finalTerminalWork = exactAggregateWork(ctx, final.work, terminal.application.applicationId, { terminal: true }, "terminal Work remains retained");
    ctx.equal(finalFutureWork, futureWork, "future PENDING Work is byte-for-byte retained by drain");
    ctx.equal(finalTerminalWork, terminalWork, "terminal CANCELLED Work is byte-for-byte retained by drain");
    ctx.equal(authorityWithoutAggregate(final, due.application.applicationId), initialUnrelated, "drain changes no future, terminal or unrelated authority");
    ctx.equal(applicationFrom(final, due.application.applicationId).state, "EXPIRED", "due Application expires after reclaim");
    ctx.equal(applicationFrom(final, terminal.application.applicationId).state, "APPROVED", "terminal authority unchanged");
    ctx.equal(recoveredWork.state, "SUCCEEDED", "reclaimed due Work reaches SUCCEEDED");
    ctx.equal(recoveredWork.leaseOwner, null, "terminal Work clears lease owner");
    ctx.equal(recoveredWork.leaseExpiresAt, null, "terminal Work clears lease expiry");
    const finalDue = aggregateAuthority(final, due.application.applicationId);
    ctx.equal(finalDue.revisions, initialDue.revisions, "deadline drain leaves Revision authority exact");
    ctx.equal(finalDue.claims, initialDue.claims, "deadline drain leaves Claim authority exact");
    ctx.equal(finalDue.decisions, initialDue.decisions, "deadline drain leaves Decision authority exact");
    ctx.equal(finalDue.permits, initialDue.permits, "deadline drain invents no Permit");
    ctx.equal(finalDue.stages.map(({ stageId }) => stageId), initialDue.stages.map(({ stageId }) => stageId), "deadline drain retains exact Stage identities");
    ctx.equal(finalDue.stages.filter(({ state }) => state === "ACTIVE").length, 0, "expired Application retains no ACTIVE Stage");
    const newEvents = addedBy(initialDue.events, finalDue.events, ({ eventId }) => eventId);
    ctx.equal(newEvents.length, 1, "due Work emits exactly one new Event", { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.equal(newEvents[0].type, "application.expired", "due Work Event is application.expired", { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.equal(finalDue.application[0].sequence, initialDue.application[0].sequence + 1, "expiry advances aggregate sequence exactly once");
    ctx.equal(final.work.filter(({ state }) => state === "FAILED").length, 0, "no FAILED Work is invented without a published failure injection seam");
    return caseResult(ctx, {
      claimedWorkId: claimed.workId,
      initialAttempt: dueWork.attempt,
      reclaimedAttempt: recoveredWork.attempt,
      observedLifecycleStates: ["PENDING", "LEASED", "SUCCEEDED", "CANCELLED"],
      failedStateCoverage: "shape-only-no-published-failure-injection-seam",
    });
  },
);

function recoveryCase(id, point, description) {
  return defineCase(
    id,
    "PF-F-WORK-EVENT due Deadline recovery",
    `Hold a real Worker at ${point}, SIGKILL its process group, wait for the three-second persisted lease to expire and start a replacement Worker`,
    description,
    ["published recovery barrier", "SIGKILL process boundary", "replacement Worker", "verification snapshot"],
    async (ctx) => {
      const family = dueFamily(ctx, id.toLowerCase());
      const { api } = await boot(ctx, { family });
      const initial = await snapshot(ctx, api.baseUrl);
      const initialUnrelated = authorityWithoutAggregate(initial, family.application.applicationId);
      const recovered = await crashDeadlineAt(ctx, api.baseUrl, point, { applicationId: family.application.applicationId });
      const stable = await observeStableAuthority(ctx, api.baseUrl, recovered.after, `${point} replacement authority remains stable across a lease window`);
      const closure = ctx.assert(`${point} exact target Work/Application/Event recovery closure`, () => assertExactDeadlineRecovery(initial, recovered.before, stable, recovered.entry), { hardCapIds: ["WORK_FENCING", "EVENT_ATOMICITY"] });
      ctx.assert("recovered Work exact", () => assertWork(closure.work));
      ctx.equal(authorityWithoutAggregate(stable, family.application.applicationId), initialUnrelated, `${point} recovery changes no unrelated aggregate`);
      ctx.equal(stable.work.filter(({ aggregateId, terminal }) => aggregateId === family.application.applicationId && !terminal).length, 0, `${point} leaves no extra pending target Work`);
      ctx.equal(permitFor(stable, family.application.applicationId), undefined, "recovery invents no Permit");
      return caseResult(ctx, { workId: closure.work.workId, heldAttempt: recovered.entry.json.attempt, afterAttempt: closure.work.attempt, eventId: closure.event.eventId, point });
    },
  );
}

const c02 = recoveryCase("C-02", "worker.claimed", "The replacement reclaims the same Work at attempt+1, expires the Application exactly once and the killed owner cannot commit or duplicate Work/Event identity");
const c03 = recoveryCase("C-03", "worker.effect-complete", "Repeatable computation converges on one complete expiry, terminal Work and one Event without an immortal pending row or second business effect");
const c04 = recoveryCase("C-04", "worker.before-commit", "The transaction is observed only as all-or-nothing Application, Work and Event authority after replacement, with no partial combination");

const c05 = defineCase(
  "C-05",
  "PF-F-WORK-EVENT expired lease fencing",
  "Pause Worker A after its claim until the lease expires, let Worker B reclaim and commit, then release A's stale attempt and observe the final authority",
  "Worker A cannot commit or overwrite B; the final Work owner, attempt and result reflect only the replacement and no terminal Application or Event changes twice",
  ["worker.claimed barrier", "two Worker processes", "lease expiry", "verification snapshot"],
  async (ctx) => {
    const due = ctx.fixtures.history("c05-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const replacementWitness = ctx.fixtures.history("c05-replacement-witness", "CHANGES_REQUIRED");
    const terminalWitness = ctx.fixtures.history("c05-terminal-witness", "APPROVED");
    const base = ctx.fixtures.main("c05-base");
    const family = {
      ...base,
      application: due.application,
      revision: due.revision,
      seed: ctx.fixtures.seedFromHistories("c05", [due, replacementWitness, terminalWitness]),
    };
    const { api } = await boot(ctx, { family });
    const initial = await snapshot(ctx, api.baseUrl);
    const initialTarget = aggregateAuthority(initial, due.application.applicationId);
    const initialWork = exactAggregateWork(ctx, initial.work, due.application.applicationId, { terminal: false }, "due target starts with one nonterminal Work");
    let held = false;
    const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => {
      if (!held && point === "worker.claimed" && aggregateId === due.application.applicationId) { held = true; return true; }
      return false;
    } });
    const first = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const entry = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.aggregateId === due.application.applicationId, { timeoutMs: 120_000, processes: [first] });
    const heldState = await snapshot(ctx, api.baseUrl);
    const heldWork = exactAggregateWork(ctx, heldState.work, due.application.applicationId, { terminal: false }, "stale owner visibly holds due Work");
    ctx.equal(heldWork.workId, initialWork.workId, "first claim retains Work identity");
    ctx.equal(entry.json.workId, heldWork.workId, "worker.claimed barrier binds the target Work identity");
    ctx.equal(entry.json.attempt, heldWork.attempt, "worker.claimed barrier binds the held attempt");
    ctx.equal(heldWork.state, "LEASED", "first owner is visibly LEASED");
    ctx.equal(heldWork.attempt, initialWork.attempt + 1, "first claim advances attempt once");
    const replacementRevision = await createRevision(ctx, api.baseUrl, replacementWitness.application.applicationId, {
      expectedRevision: 1,
      fields: { fencingWitness: "revision-2" },
      deadlineAt: ctx.at({ days: 4 }),
      reviewPolicy: family.policy,
    }, "c05-replacement-witness-revision");
    ctx.equal(replacementRevision.revision.revision, 2, "independent replacement Revision commits while stale Worker is paused");
    const authorityBeforeReclaim = await snapshot(ctx, api.baseUrl);
    const replacementAuthority = aggregateAuthority(authorityBeforeReclaim, replacementWitness.application.applicationId);
    const terminalAuthority = aggregateAuthority(authorityBeforeReclaim, terminalWitness.application.applicationId);
    await ctx.sleep(3_300);
    const second = await ctx.startWorker();
    const winningState = await waitSnapshot(ctx, api.baseUrl, (value) => value.work.find(({ workId }) => workId === entry.json.workId)?.terminal ? value : undefined, { label: "replacement terminal Work", processes: [second] });
    barrier.release(entry);
    const final = await observeStableAuthority(ctx, api.baseUrl, winningState, "stale Worker cannot overwrite replacement across a full lease window");
    await ctx.stop(first);
    const work = exactAggregateWork(ctx, final.work, due.application.applicationId, { terminal: true }, "replacement terminal Work retained");
    ctx.equal(work.workId, entry.json.workId, "replacement keeps original Work identity");
    ctx.equal(work.attempt, entry.json.attempt + 1, "replacement attempt retained exactly once");
    ctx.equal(work.state, "SUCCEEDED", "only replacement owner records terminal success");
    ctx.equal(work.leaseOwner, null, "winning terminal Work clears lease owner");
    ctx.equal(work.leaseExpiresAt, null, "winning terminal Work clears lease expiry");
    const finalTarget = aggregateAuthority(final, due.application.applicationId);
    ctx.equal(finalTarget.application[0].state, "EXPIRED", "replacement expires the due Application once");
    ctx.equal(finalTarget.application[0].sequence, initialTarget.application[0].sequence + 1, "replacement advances target sequence exactly once");
    ctx.equal(finalTarget.revisions, initialTarget.revisions, "stale owner cannot overwrite target Revision history");
    ctx.equal(finalTarget.claims, initialTarget.claims, "deadline fencing leaves target Claims exact");
    ctx.equal(finalTarget.decisions, initialTarget.decisions, "deadline fencing leaves target Decisions exact");
    ctx.equal(finalTarget.permits, initialTarget.permits, "deadline fencing invents no Permit");
    ctx.equal(finalTarget.stages.map(({ stageId }) => stageId), initialTarget.stages.map(({ stageId }) => stageId), "deadline fencing retains Stage identities");
    const expiryEvents = addedBy(initialTarget.events, finalTarget.events, ({ eventId }) => eventId);
    ctx.equal(expiryEvents.length, 1, "replacement emits exactly one Event");
    ctx.equal(expiryEvents[0].type, "application.expired", "replacement Event has the published expiry type");
    ctx.equal(aggregateAuthority(final, replacementWitness.application.applicationId), replacementAuthority, "stale Work cannot overwrite committed replacement Revision authority");
    ctx.equal(aggregateAuthority(final, terminalWitness.application.applicationId), terminalAuthority, "stale Work cannot overwrite an existing terminal aggregate");
    ctx.equal(authorityWithoutAggregate(final, due.application.applicationId), authorityWithoutAggregate(authorityBeforeReclaim, due.application.applicationId), "stale Work changes no non-target authority");
    return caseResult(ctx, { workId: work.workId, winningAttempt: work.attempt, retainedReplacementRevision: replacementRevision.revision.revision });
  },
);

const c06 = defineCase(
  "C-06",
  "PF-F-CLAIMS expired public Claim",
  "Hide one committed Claim response, fill current security capacity, wait for both leases to expire, reclaim through the public endpoint, then replay the exact old request context",
  "Expired ownership does not consume a slot, the new Claim is the only current lease, and replay of the stale old request returns its saved response with zero authority change without assuming an unpublished token envelope",
  ["Review Claim HTTP", "response shield", "persisted lease expiry", "durable idempotency replay", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.main("c06");
    const { api } = await boot(ctx, { family });
    const path = `/api/v1/permit-applications/${family.application.applicationId}/review-claims`;
    const initial = await snapshot(ctx, api.baseUrl);
    const initialTarget = aggregateAuthority(initial, family.application.applicationId);
    const initialUnrelated = authorityWithoutAggregate(initial, family.application.applicationId);
    const shield = await ctx.responseShield(api.baseUrl);
    const firstKey = ctx.key("c06-fill-0");
    const firstBody = { reviewerId: family.securityReviewers[0].reviewerId, role: "security" };
    const captureOffset = shield.captures.length;
    shield.dropNextMutation();
    await ctx.mutate(shield.baseUrl, path, firstKey, firstBody).catch(() => undefined);
    const firstCapture = shield.captures.slice(captureOffset).find(({ dropped }) => dropped);
    ctx.ok(firstCapture, "first old request commits while its complete response is hidden");
    ctx.equal(firstCapture.response.status, 200, "hidden old Claim request succeeded at the API");
    const firstResponse = JSON.parse(firstCapture.response.body);
    const firstClaim = claimResource(firstResponse);
    const secondBody = { reviewerId: family.securityReviewers[1].reviewerId, role: "security" };
    const secondResponse = await ctx.mutate(api.baseUrl, path, ctx.key("c06-fill-1"), secondBody);
    ctx.equal(secondResponse.status, 200, "second role slot leased");
    const secondClaim = claimResource(secondResponse.json);
    const originals = [firstClaim, secondClaim];
    for (const [index, claim] of originals.entries()) {
      const reviewer = family.securityReviewers[index];
      ctx.equal({ applicationId: claim.applicationId, revision: claim.revision, reviewerId: claim.reviewerId, role: claim.role, state: claim.state }, {
        applicationId: family.application.applicationId,
        revision: 1,
        reviewerId: reviewer.reviewerId,
        role: "security",
        state: "LEASED",
      }, `slot ${index + 1} exact Claim tuple`);
    }
    const filled = await snapshot(ctx, api.baseUrl);
    const filledTarget = aggregateAuthority(filled, family.application.applicationId);
    ctx.equal(filledTarget.claims.length, 2, "capacity fill persists exactly two Claims");
    ctx.equal(filledTarget.claims.filter(({ state }) => state === "LEASED").length, 2, "both role slots are visibly leased before expiry");
    const fillEvents = addedBy(initialTarget.events, filledTarget.events, ({ eventId }) => eventId);
    ctx.equal(fillEvents.length, 2, "capacity fill emits exactly two Claim Events");
    ctx.ok(fillEvents.every(({ type }) => type === "review.claimed"), "capacity fill emits only review.claimed Events");
    ctx.equal(filledTarget.application[0].sequence, initialTarget.application[0].sequence + 2, "capacity fill advances sequence twice");
    ctx.equal(filledTarget.revisions, initialTarget.revisions, "capacity fill leaves Revision authority exact");
    ctx.equal(filledTarget.decisions, initialTarget.decisions, "capacity fill leaves Decision authority exact");
    ctx.equal(filledTarget.permits, initialTarget.permits, "capacity fill leaves Permit authority exact");
    ctx.equal(filledTarget.stages, initialTarget.stages, "capacity fill leaves Stage authority exact");
    ctx.equal(filledTarget.work, initialTarget.work, "capacity fill leaves Deadline Work exact");
    ctx.equal(authorityWithoutAggregate(filled, family.application.applicationId), initialUnrelated, "capacity fill changes no unrelated authority");
    await ctx.sleep(3_300);
    const reclaim = await ctx.mutate(api.baseUrl, path, ctx.key("c06-reclaim"), { reviewerId: family.securityReviewers[2].reviewerId, role: "security" });
    ctx.equal(reclaim.status, 200, "expired slot reclaimed");
    const reclaimed = claimResource(reclaim.json);
    const reclaimedState = await snapshot(ctx, api.baseUrl);
    const reclaimedTarget = aggregateAuthority(reclaimedState, family.application.applicationId);
    const claims = claimsFor(reclaimedState, family.application.applicationId);
    const leased = claims.filter(({ state: claimState }) => claimState === "LEASED");
    ctx.equal(claims.length, 3, "reclaim retains two expired Claims and creates exactly one new Claim");
    ctx.equal(leased.length, 1, "one reclaimed slot is current");
    ctx.equal(leased[0].claimId, reclaimed.claimId, "response Claim ID names the unique leased authority");
    ctx.equal(leased[0], reclaimed, "response and persisted reclaimed Claim are identical");
    ctx.equal({ applicationId: reclaimed.applicationId, revision: reclaimed.revision, reviewerId: reclaimed.reviewerId, role: reclaimed.role, state: reclaimed.state }, {
      applicationId: family.application.applicationId,
      revision: 1,
      reviewerId: family.securityReviewers[2].reviewerId,
      role: "security",
      state: "LEASED",
    }, "reclaimed Claim exact current tuple");
    ctx.ok(originals.every(({ claimId }) => claimId !== reclaimed.claimId), "new reviewer receives a unique Claim identity");
    for (const original of originals) {
      const retained = claims.find(({ claimId }) => claimId === original.claimId);
      ctx.ok(retained, `${original.claimId} old Claim retained`);
      ctx.equal(retained.state, "EXPIRED", `${original.claimId} old Claim remains EXPIRED`);
      ctx.equal(retained.attempt, original.attempt, `${original.claimId} old attempt immutable`);
    }
    ctx.ok(reclaimed.attempt >= 1, "reclaimed Claim has a positive persisted attempt");
    const reclaimEvents = addedBy(filledTarget.events, reclaimedTarget.events, ({ eventId }) => eventId);
    ctx.equal(reclaimEvents.length, 1, "reclaim emits exactly one new Event");
    ctx.equal(reclaimEvents[0].type, "review.claimed", "reclaim Event has published type");
    ctx.equal(reclaimedTarget.application[0].sequence, filledTarget.application[0].sequence + 1, "reclaim advances sequence exactly once");
    ctx.equal(reclaimedTarget.revisions, filledTarget.revisions, "reclaim leaves Revision authority exact");
    ctx.equal(reclaimedTarget.decisions, filledTarget.decisions, "reclaim leaves Decision authority exact");
    ctx.equal(reclaimedTarget.permits, filledTarget.permits, "reclaim leaves Permit authority exact");
    ctx.equal(reclaimedTarget.stages, filledTarget.stages, "reclaim leaves Stage authority exact");
    ctx.equal(reclaimedTarget.work, filledTarget.work, "reclaim leaves Deadline Work exact");
    ctx.equal(authorityWithoutAggregate(reclaimedState, family.application.applicationId), initialUnrelated, "reclaim changes no unrelated authority");
    const staleReplay = await ctx.mutate(api.baseUrl, path, firstKey, firstBody);
    ctx.equal(staleReplay.status, firstCapture.response.status, "stale old request replay preserves original status");
    ctx.equal(staleReplay.json, firstResponse, "stale old request replay preserves original semantic body");
    const afterStaleReplay = await snapshot(ctx, api.baseUrl);
    ctx.equal(stableSnapshot(afterStaleReplay), stableSnapshot(reclaimedState), "stale old request replay changes no authority", { hardCapIds: ["DURABLE_IDEMPOTENCY", "REVIEW_AUTHORITY"] });
    return caseResult(ctx, {
      reclaimedClaimId: reclaimed.claimId,
      reclaimedAttempt: reclaimed.attempt,
      expiredClaimIds: originals.map(({ claimId }) => claimId),
      staleContextSeam: "committed-response-hidden-then-exact-durable-replay",
    });
  },
  [blocked("PF-C06-STALE-CLAIM-DECISION", "PF-GAP-01")],
);

const c07 = defineCase(
  "C-07",
  "PF-F-WORK-EVENT unknown webhook ACK",
  "Persist a full webhook request, hold Dispatcher A after a successful receiver response and SIGKILL it, then return 500 once before Dispatcher B retries to ACK",
  "Every retry keeps eventId, type and raw body byte-identical, remains bounded, loses no logical Event and creates no duplicate Event identity",
  ["webhook receiver", "dispatcher.response-received barrier", "SIGKILL", "replacement Dispatcher"],
  async (ctx) => {
    const family = dueFamily(ctx, "c07");
    const attemptTimes = [];
    const attemptsByEvent = new Map();
    let targetEventId;
    const receiver = await ctx.receiver({ behavior: (delivery) => {
      const eventId = delivery.headers["x-permitforge-event-id"];
      targetEventId ??= eventId;
      const attempt = (attemptsByEvent.get(eventId) ?? 0) + 1;
      attemptsByEvent.set(eventId, attempt);
      attemptTimes.push({ eventId, attempt, at: Date.now() });
      if (eventId !== targetEventId) return { status: 204 };
      if (attempt === 1) return { status: 204 };
      if (attempt === 2) return { disconnect: true };
      if (attempt === 3) return { status: 500 };
      return { status: 204 };
    } });
    const { api } = await boot(ctx, { family });
    const worker = await ctx.startWorker();
    const committed = await waitSnapshot(ctx, api.baseUrl, (value) => applicationFrom(value, family.application.applicationId)?.state === "EXPIRED" ? value : undefined, { label: "expiry event ready", processes: [worker] });
    const aggregateEvents = committed.events.filter(({ aggregateId }) => aggregateId === family.application.applicationId).sort((left, right) => left.sequence - right.sequence);
    ctx.equal(aggregateEvents.length, 2, "submitted then expired aggregate has exactly two logical Events");
    ctx.equal(aggregateEvents.map(({ sequence }) => sequence), [1, 2], "committed aggregate Event sequence is exact and gapless");
    ctx.equal(aggregateEvents.map(({ type }) => type), ["application.submitted", "application.expired"], "committed aggregate Event types match the two business transitions");
    let heldOnce = false;
    const barrier = await ctx.barrier({ hold: ({ point }) => {
      if (!heldOnce && point === "dispatcher.response-received") { heldOnce = true; return true; }
      return false;
    } });
    const first = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const entry = await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 120_000, processes: [first] });
    const heldDelivery = receiver.ledger.at(-1);
    ctx.ok(heldDelivery, "receiver persisted the delivery immediately preceding the held response barrier");
    ctx.equal(heldDelivery.json?.aggregateId, entry.json.aggregateId, "causal receiver delivery binds the barrier aggregate");
    const heldEventId = heldDelivery.headers["x-permitforge-event-id"];
    ctx.equal(heldEventId, targetEventId, "held delivery is the receiver-targeted Event identity");
    const heldEvent = committed.events.find(({ eventId }) => eventId === heldEventId);
    ctx.ok(heldEvent, "delivery header resolves one persisted Event independently of dispatcher Work identity");
    ctx.assert("independent dispatcher Work, aggregate, delivery and Event identities are bound", () => assertDeliveryMatchesEvent(heldDelivery, entry, heldEvent), { hardCapIds: ["EVENT_ATOMICITY"] });
    await ctx.kill(first);
    await ctx.sleep(3_300);
    const second = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => {
      const heldAttempts = receiver.ledger.filter(({ headers }) => headers["x-permitforge-event-id"] === heldEventId);
      const everyEventAcked = aggregateEvents.every(({ eventId }) => receiver.ledger.some(({ acknowledged, responseStatus, headers }) => acknowledged && responseStatus >= 200 && responseStatus < 300 && headers["x-permitforge-event-id"] === eventId));
      return heldAttempts.length >= 4 && heldAttempts.some(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300) && everyEventAcked ? heldAttempts : undefined;
    }, { label: "disconnect, 500 and successful webhook retry", timeoutMs: 180_000, processes: [second] });
    const heldAttempts = receiver.ledger.filter(({ headers }) => headers["x-permitforge-event-id"] === heldEventId);
    ctx.assert("held Event retry identity disconnect and final ACK", () => assertRecoveredDelivery(heldAttempts, heldEventId, { minAttempts: 4, requireDisconnect: true }), { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.ok(heldAttempts.some(({ responseStatus }) => responseStatus === 500), "held Event observes a non-2xx retry");
    const heldTimes = attemptTimes.filter(({ eventId }) => eventId === heldEventId).map(({ at }) => at);
    ctx.ok(heldTimes.slice(1).every((at, index) => at - heldTimes[index] <= 10_000), "held Event retry intervals remain bounded");
    const final = await snapshot(ctx, api.baseUrl);
    ctx.equal(stableSnapshot(final), stableSnapshot(committed), "final snapshot equals pre-dispatch authority", { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.equal(final.events.filter(({ eventId }) => eventId === heldEventId).length, 1, "retry does not invent a second logical Event", { hardCapIds: ["EVENT_ATOMICITY"] });
    for (const [index, delivery] of receiver.ledger.entries()) {
      const eventId = delivery.headers["x-permitforge-event-id"];
      const event = final.events.find((item) => item.eventId === eventId);
      ctx.ok(event, `delivery ${index + 1} names one persisted Event`);
      ctx.assert(`delivery ${index + 1} preserves exact Event type and semantic body`, () => {
        assert.equal(delivery.headers["x-permitforge-event-type"], event.type);
        assert.deepEqual(delivery.json, event);
      }, { hardCapIds: ["EVENT_ATOMICITY"] });
    }
    for (const { eventId } of aggregateEvents) ctx.ok(receiver.ledger.some(({ acknowledged, responseStatus, headers }) => acknowledged && responseStatus >= 200 && responseStatus < 300 && headers["x-permitforge-event-id"] === eventId), `${eventId} is eventually acknowledged`);
    ctx.assert("every successful delivery preserves per-aggregate sequence order, including duplicates", () => assertSuccessfulDeliverySequence(receiver.ledger, final.events));
    ctx.assert("all receiver retry identities stable", () => assertRetryIdentity(receiver.ledger), { hardCapIds: ["EVENT_ATOMICITY"] });
    assertExternalSecretBoundary(receiver.ledger, ctx);
    return caseResult(ctx, { heldEventId, heldAttempts: heldAttempts.length, receiverAttempts: receiver.ledger.length, killedWorkId: entry.json.workId });
  },
);

const c08 = defineCase(
  "C-08",
  "PF-F-WORK-EVENT transactional multi-aggregate dispatch",
  "Submit two Applications concurrently, prove one rejected mutation creates no state or Event, then run two Dispatchers and SIGKILL one at response-received before replacement drain",
  "Successful facts and Events are atomically visible, rollback emits none, aggregate sequences stay gapless and retry delivery leaks no token, authorization or private path",
  ["two API mutations", "two Dispatcher processes", "response barrier SIGKILL", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.main("c08");
    const { apis } = await boot(ctx, { family, seed: { ...family.seed, permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [] }, apiCount: 2 });
    const initial = await snapshot(ctx, apis[0].baseUrl);
    const leftBody = ctx.fixtures.submissionBody("c08-left");
    const rightBody = ctx.fixtures.submissionBody("c08-right");
    const leftKey = ctx.key("c08-left");
    const commitBarrier = await createMutationCommitBarrier(ctx, apis[0].baseUrl);
    let leftTransportError;
    const leftPending = submitApplication(ctx, commitBarrier.baseUrl, leftBody, "c08-left", { key: leftKey }).catch((error) => {
      leftTransportError = error;
      return undefined;
    });
    const rightPending = submitApplication(ctx, apis[1].baseUrl, rightBody, "c08-right");
    const committedCapture = await commitBarrier.waitForCommit();
    const right = await rightPending;
    ctx.equal(committedCapture.response.status, 201, "held API mutation completed one successful upstream response");
    const leftJson = JSON.parse(committedCapture.response.body.toString("utf8"));
    const left = {
      application: findObject(leftJson, "applicationId"),

      response: { status: committedCapture.response.status, json: leftJson },
    };
    ctx.ok(left.application, "held committed response exposes Application authority");
    const commitVisible = await snapshot(ctx, apis[1].baseUrl);
    left.revision = commitVisible.resources.applicationRevisions.find(item => item.applicationId === left.application.applicationId && item.revision === left.application.currentRevision);
    ctx.ok(left.revision, "held response boundary exposes committed Revision");
    ctx.equal(left.revision.fields, leftBody.fields, "held response captures original fields");
    const leftAtCommit = aggregateAuthority(commitVisible, left.application.applicationId);
    ctx.equal(leftAtCommit.application, [left.application], "business Application is durable at the held response-commit boundary");
    ctx.equal(leftAtCommit.revisions, [left.revision], "business Revision is durable at the held response-commit boundary");
    ctx.equal(leftAtCommit.events.length, 1, "the matching Event is durable at the same held response-commit boundary");
    ctx.equal(leftAtCommit.events[0].type, "application.submitted", "held response commit exposes the exact submitted Event");
    await ctx.kill(apis[0]);
    commitBarrier.drop();
    await leftPending;
    ctx.ok(leftTransportError, "client acknowledgement is lost only after the upstream commit is fully captured");
    const restarted = await ctx.startApi();
    const beforeReplay = await snapshot(ctx, restarted.baseUrl);
    const leftReplay = await ctx.mutate(restarted.baseUrl, "/api/v1/permit-applications", leftKey, leftBody);
    ctx.equal({ status: leftReplay.status, json: leftReplay.json }, left.response, "post-SIGKILL replay returns the saved committed response");
    const committed = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(stableSnapshot(committed), stableSnapshot(beforeReplay), "post-SIGKILL replay adds no second business state or Event", { hardCapIds: ["DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY"] });
    const created = [left, right];
    const wanted = new Set(created.map(({ application }) => application.applicationId));
    const committedEvents = addedBy(initial.events, committed.events, ({ eventId }) => eventId);
    ctx.equal(committedEvents.length, 2, "two successful submits commit exactly two Events");
    ctx.ok(committedEvents.every(({ aggregateId, type }) => wanted.has(aggregateId) && type === "application.submitted"), "each new Event is the exact submitted fact for one created aggregate");
    ctx.equal(committed.resources.permitApplications.length, initial.resources.permitApplications.length + 2, "two successful submits add exactly two Applications");
    ctx.equal(committed.resources.applicationRevisions.length, initial.resources.applicationRevisions.length + 2, "two successful submits add exactly two Revisions");
    ctx.equal(committed.resources.reviewStages.length, initial.resources.reviewStages.length + 2, "two legacy submits add exactly one Stage each");
    ctx.equal(committed.work.length, initial.work.length + 2, "two successful submits add exactly two Deadline Work rows");
    ctx.equal(committed.resources.reviewClaims, initial.resources.reviewClaims, "submit creates no Claim");
    ctx.equal(committed.resources.reviewDecisions, initial.resources.reviewDecisions, "submit creates no Decision");
    ctx.equal(committed.resources.approvedPermits, initial.resources.approvedPermits, "submit creates no Permit");
    for (const item of created) {
      const rows = aggregateAuthority(committed, item.application.applicationId);
      ctx.equal(rows.application, [item.application], `${item.application.applicationId} response Application is persisted exactly`);
      ctx.equal(rows.revisions, [item.revision], `${item.application.applicationId} response Revision is persisted exactly`);
      ctx.equal(rows.claims.length, 0, `${item.application.applicationId} has no Claim`);
      ctx.equal(rows.decisions.length, 0, `${item.application.applicationId} has no Decision`);
      ctx.equal(rows.permits.length, 0, `${item.application.applicationId} has no Permit`);
      ctx.equal(rows.stages.length, 1, `${item.application.applicationId} has one legacy current Stage`);
      ctx.equal(rows.stages[0].ordinal, 1, `${item.application.applicationId} Stage ordinal`);
      ctx.equal(rows.stages[0].state, "ACTIVE", `${item.application.applicationId} current Stage is ACTIVE`);
      ctx.equal(rows.work.length, 1, `${item.application.applicationId} has one Deadline Work`);
      ctx.equal(rows.work[0].state, "PENDING", `${item.application.applicationId} Deadline Work is pending`);
      ctx.equal(rows.events.length, 1, `${item.application.applicationId} has one logical Event`);
      ctx.equal(rows.events[0].eventId, committedEvents.find(({ aggregateId }) => aggregateId === item.application.applicationId).eventId, `${item.application.applicationId} Event identity is unique`);
      ctx.equal(rows.application[0].sequence, rows.events[0].sequence, `${item.application.applicationId} Application sequence closes to Event history`);
    }
    expectError(ctx, await ctx.mutate(apis[1].baseUrl, "/api/v1/permit-applications", ctx.key("c08-invalid"), { ...ctx.fixtures.submissionBody("c08-invalid"), unknown: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD");
    ctx.equal(stableSnapshot(await snapshot(ctx, restarted.baseUrl)), stableSnapshot(committed), "rollback creates neither fact nor Event", { hardCapIds: ["EVENT_ATOMICITY"] });
    const receiver = await ctx.receiver();
    let heldOnce = false;
    const barrier = await ctx.barrier({ hold: ({ point }) => {
      if (!heldOnce && point === "dispatcher.response-received") { heldOnce = true; return true; }
      return false;
    } });
    const first = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 120_000, processes: [first] });
    const heldDelivery = receiver.ledger.at(-1);
    ctx.ok(heldDelivery, "held Dispatcher response follows one receiver-persisted delivery");
    ctx.equal(heldDelivery.json?.aggregateId, held.json.aggregateId, "causal receiver delivery binds the held aggregate");
    const heldEventId = heldDelivery.headers["x-permitforge-event-id"];
    const heldEvent = committedEvents.find(({ eventId }) => eventId === heldEventId);
    ctx.ok(heldEvent, "delivery header independently resolves one exact committed success Event");
    ctx.assert("independent dispatcher Work, aggregate, delivery and Event identities are bound", () => assertDeliveryMatchesEvent(heldDelivery, held, heldEvent), { hardCapIds: ["EVENT_ATOMICITY"] });
    await ctx.kill(first);
    await ctx.sleep(3_300);
    const replacements = [await ctx.startDispatcher({ webhookUrl: receiver.url }), await ctx.startDispatcher({ webhookUrl: receiver.url })];
    await ctx.waitFor(() => {
      const acknowledgedIds = new Set(receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300).map(({ headers }) => headers["x-permitforge-event-id"]));
      const heldAttempts = receiver.ledger.filter(({ headers }) => headers["x-permitforge-event-id"] === heldEventId);
      return committedEvents.every(({ eventId }) => acknowledgedIds.has(eventId)) && heldAttempts.length >= 2 ? heldAttempts : undefined;
    }, { label: "held Event redelivery and multi-aggregate drain", timeoutMs: 180_000, processes: replacements });
    const final = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(stableSnapshot(final), stableSnapshot(committed), "final snapshot equals pre-dispatch authority", { hardCapIds: ["EVENT_ATOMICITY"] });
    for (const [index, delivery] of receiver.ledger.entries()) {
      const eventId = delivery.headers["x-permitforge-event-id"];
      const event = committedEvents.find((item) => item.eventId === eventId);
      ctx.ok(event, `receiver delivery ${index + 1} belongs to one of the two committed Events`);
      ctx.assert(`receiver delivery ${index + 1} preserves exact Event type and semantic body`, () => {
        assert.equal(delivery.headers["x-permitforge-event-type"], event.type);
        assert.deepEqual(delivery.json, event);
      }, { hardCapIds: ["EVENT_ATOMICITY"] });
    }
    for (const event of committedEvents) {
      ctx.ok(receiver.ledger.some(({ acknowledged, responseStatus, headers }) => acknowledged && responseStatus >= 200 && responseStatus < 300 && headers["x-permitforge-event-id"] === event.eventId), `${event.aggregateId} exact success Event eventually acknowledged`);
      ctx.equal(final.events.filter(({ eventId }) => eventId === event.eventId).length, 1, `${event.aggregateId} retains one logical Event identity`);
    }
    ctx.assert("all aggregate sequences gapless", () => assertAggregateSequences(final.events), { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.assert("all successful multi-aggregate deliveries preserve each aggregate's complete sequence order", () => assertSuccessfulDeliverySequence(receiver.ledger, final.events), { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.assert("killed held Event is redelivered", () => assertRecoveredDelivery(receiver.ledger, heldEventId, { minAttempts: 2 }), { hardCapIds: ["EVENT_ATOMICITY"] });
    ctx.assert("all webhook retries stable", () => assertRetryIdentity(receiver.ledger));
    assertExternalSecretBoundary({ snapshot: final, receiver: receiver.ledger }, ctx);
    return caseResult(ctx, { applicationIds: [...wanted], heldEventId, heldAttempts: receiver.ledger.filter(({ headers }) => headers["x-permitforge-event-id"] === heldEventId).length, deliveredRequests: receiver.ledger.length });
  },
);

export const C_CASES = Object.freeze([c01, c02, c03, c04, c05, c06, c07, c08]);
