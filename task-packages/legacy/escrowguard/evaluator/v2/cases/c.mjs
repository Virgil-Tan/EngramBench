import { fundedRequest, makeEmptySeed, makeEscrowFixture } from "../fixtures/index.mjs";
import { assertSnapshot, canonicalJson } from "../oracles/index.mjs";
import {
  acceptMilestone,
  assertNoPrivatePaths,
  createEscrow,
  defineCase,
  finalEvidence,
  getDetail,
  prepare,
  resources,
  semanticError,
  stableSnapshot,
  waitForSnapshot,
  waitForWorkDrain,
} from "./helpers.mjs";

function options(ctx) { return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime }; }
function dueFixture(ctx, label = "due") { return makeEscrowFixture(options(ctx), { amounts: [40, 60], expiresAt: ctx.at({ days: -2 }), label }); }
function eventCount(snapshot, aggregateId, type) { return snapshot.events.filter((event) => event.aggregateId === aggregateId && event.type === type).length; }
function aggregateEvents(snapshot, aggregateId) { return snapshot.events.filter((event) => event.aggregateId === aggregateId); }
function durableBusinessState(snapshot) { return canonicalJson({ resources: snapshot.resources, events: snapshot.events }); }
function aggregateBusinessState(snapshot, aggregateId) {
  const data = resources(snapshot);
  const milestones = data.milestones.filter(({ escrowId }) => escrowId === aggregateId);
  const milestoneIds = new Set(milestones.map(({ milestoneId }) => milestoneId));
  const releases = data.releases.filter(({ escrowId }) => escrowId === aggregateId);
  const releaseIds = new Set(releases.map(({ releaseId }) => releaseId));
  return canonicalJson({
    escrow: data.escrows.find(({ escrowId }) => escrowId === aggregateId),
    milestones,
    disputes: data.disputes.filter(({ escrowId }) => escrowId === aggregateId),
    releases,
    beneficiaryShares: (data.beneficiaryShares ?? []).filter(({ milestoneId }) => milestoneIds.has(milestoneId)),
    beneficiaryPayouts: (data.beneficiaryPayouts ?? []).filter(({ releaseId }) => releaseIds.has(releaseId)),
  });
}

function quotePgIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

async function eventStorageRelations(ctx, target, eventId) {
  assert.match(eventId, /^[0-9a-f-]{36}$/iu, "event storage probe uses a public Event identity");
  const catalog = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", "select coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname) order by n.nspname,c.relname),'[]'::json)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')"], { timeoutMs: 5_000 });
  const relations = JSON.parse(catalog.stdout.trim());
  const matches = [];
  for (const relation of relations) {
    const qualified = `${quotePgIdentifier(relation.schema)}.${quotePgIdentifier(relation.name)}`;
    const probe = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", `select exists(select 1 from ${qualified} as candidate_row where position('${eventId}' in to_jsonb(candidate_row)::text)>0)`], { allowFailure: true, timeoutMs: 5_000 });
    if (probe.exitCode === 0 && probe.stdout.trim() === "t") matches.push(qualified);
  }
  assert.ok(matches.length > 0, "persisted public Event identity has a PostgreSQL storage relation");
  return matches;
}

async function holdEventStorage(ctx, target, eventId) {
  const relations = await eventStorageRelations(ctx, target, eventId);
  const applicationName = `eg_c08_event_lock_${process.pid}`;
  let released = false;
  const command = target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", `begin; lock table ${relations.join(",")} in access exclusive mode; select pg_sleep(60); rollback;`], { allowFailure: true, env: { PGAPPNAME: applicationName }, timeoutMs: 90_000 });
  const findHolder = async () => {
    const result = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", `select pid from pg_stat_activity where datname=current_database() and application_name='${applicationName}' and wait_event='PgSleep'`], { timeoutMs: 5_000 });
    const rows = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    return rows.length === 1 ? Number(rows[0]) : undefined;
  };
  const holderPid = await ctx.waitFor(findHolder, { timeoutMs: 10_000, intervalMs: 25, label: "evaluator Event-storage lock holder" });
  const release = async () => {
    if (released) return;
    released = true;
    await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", `select pg_terminate_backend(${holderPid})`], { allowFailure: true, timeoutMs: 5_000 });
    await command;
  };
  ctx.defer(release);
  return {
    holderPid,
    relations,
    async waitForBlockedCandidate() {
      return ctx.waitFor(async () => {
        const result = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", `select count(*) from pg_stat_activity where ${holderPid}=any(pg_blocking_pids(pid))`], { timeoutMs: 5_000 });
        const count = Number(result.stdout.trim());
        return count > 0 ? count : undefined;
      }, { timeoutMs: 10_000, intervalMs: 25, label: "Candidate Event insert blocked at evaluator-owned storage lock" });
    },
    release,
  };
}

export function assertRefundStateEventBoundary(ctx, before, observed, aggregateId, committed, label) {
  const beforeEvents = new Set(aggregateEvents(before, aggregateId).map(({ eventId }) => eventId));
  const addedEvents = aggregateEvents(observed, aggregateId).filter(({ eventId }) => !beforeEvents.has(eventId));
  if (!committed) {
    ctx.equal(aggregateBusinessState(observed, aggregateId), aggregateBusinessState(before, aggregateId), `${label} business state absent`);
    ctx.equal(addedEvents, [], `${label} Event absent`);
    return { stateCommitted: false, eventCommitted: false };
  }
  const data = resources(observed);
  const escrow = data.escrows.find(({ escrowId }) => escrowId === aggregateId);
  const milestones = data.milestones.filter(({ escrowId }) => escrowId === aggregateId);
  ctx.equal({ state: escrow?.state, availableMinor: escrow?.availableMinor, releasedMinor: escrow?.releasedMinor, refundedMinor: escrow?.refundedMinor }, { state: "REFUNDED", availableMinor: 0, releasedMinor: 0, refundedMinor: escrow?.totalMinor }, `${label} complete refund state`);
  ctx.equal(milestones.map(({ state }) => state), milestones.map(() => "REFUNDED"), `${label} complete Milestone state`);
  ctx.equal(addedEvents.map(({ type }) => type), ["escrow.refunded"], `${label} exact refund Event`);
  return { stateCommitted: true, eventCommitted: true };
}

export function assertAtomicRefundObservationTrace(ctx, before, observations, aggregateId, label = "atomic refund observation") {
  ctx.ok(Array.isArray(observations) && observations.length > 0, `${label} has nonempty point-in-time observations`);
  const beforeBusiness = aggregateBusinessState(before, aggregateId);
  const beforeEvents = new Set(aggregateEvents(before, aggregateId).map(({ eventId }) => eventId));
  let committedSeen = false;
  for (const [index, observed] of observations.entries()) {
    const stateCommitted = aggregateBusinessState(observed, aggregateId) !== beforeBusiness;
    const eventCommitted = aggregateEvents(observed, aggregateId).some(({ eventId }) => !beforeEvents.has(eventId));
    ctx.equal(stateCommitted, eventCommitted, `${label} observation ${index + 1} never exposes state and Event in different commits`);
    assertRefundStateEventBoundary(ctx, before, observed, aggregateId, stateCommitted, `${label} observation ${index + 1}`);
    committedSeen ||= stateCommitted;
  }
  ctx.ok(committedSeen, `${label} observes the committed boundary`);
  return { observations: observations.length, committedSeen };
}

export function assertDeliveryBindings(ctx, entries, expectedEvents, label = "dispatcher delivery") {
  ctx.ok(Array.isArray(entries) && entries.length > 0, `${label} has nonempty receiver evidence`);
  ctx.ok(Array.isArray(expectedEvents) && expectedEvents.length > 0, `${label} has nonempty persisted Events`);
  const expectedById = new Map(expectedEvents.map((event) => [event.eventId, event]));
  ctx.equal(expectedById.size, expectedEvents.length, `${label} persisted Event identities unique`);
  for (const [index, entry] of entries.entries()) {
    const eventId = entry.headers?.["x-escrowguard-event-id"];
    const expected = expectedById.get(eventId);
    ctx.ok(expected, `${label} attempt ${index + 1} binds to a persisted eventId`);
    ctx.equal(entry.headers?.["x-escrowguard-event-type"], expected.type, `${label} attempt ${index + 1} type binds to persisted Event`);
    ctx.equal(canonicalJson(entry.json), canonicalJson(expected), `${label} attempt ${index + 1} body binds to persisted Event`);
  }
  return expectedById;
}
function combineFixtures(fixtures, seedVersion) {
  const seed = makeEmptySeed(fixtures[0].fixtures, seedVersion ?? fixtures[0].fixtures.seedVersion("combined"));
  for (const fixture of fixtures) {
    for (const party of fixture.parties) if (!seed.parties.some(({ partyId }) => partyId === party.partyId)) seed.parties.push(party);
    seed.escrows.push(fixture.escrow);
    seed.milestones.push(...fixture.milestones);
    seed.disputes.push(...fixture.seed.disputes);
    seed.releases.push(...fixture.releases);
  }
  return seed;
}

async function assertNoOpenTransaction(ctx, target, label) {
  const activity = await target.command("psql", [ctx.databaseUrl, "-Atc", "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null"], { timeoutMs: 10_000 });
  ctx.equal(activity.stdout.trim(), "0", `${label} has no open database transaction`);
}

async function recoverAt(ctx, point) {
  const fixture = dueFixture(ctx, point.replaceAll(".", "-"));
  const { target, api } = await prepare(ctx, { seed: fixture.seed });
  const initial = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const work = initial.work.find(({ aggregateId, terminal }) => aggregateId === fixture.escrowId && !terminal);
  ctx.ok(work, `${point} pending Work`);
  const barrier = await ctx.barrier({ hold: (payload) => payload.point === point && payload.workId === work.workId });
  const original = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.point === point && entry.json.workId === work.workId, { timeoutMs: 60_000, processes: [original] });
  const firstAttempt = held.json.attempt;
  await assertNoOpenTransaction(ctx, target, `held ${point}`);
  const heldSnapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const heldWork = heldSnapshot.work.find(({ workId }) => workId === work.workId);
  ctx.equal(heldWork.state, "LEASED", `${point} held Work is visibly LEASED`);
  ctx.equal(heldWork.attempt, firstAttempt, `${point} barrier attempt matches retained Work`);
  ctx.equal(durableBusinessState(heldSnapshot), durableBusinessState(initial), `${point} has no durable business/Event effect before commit`);
  await ctx.kill(original);
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await target.startWorker();
  const snapshot = assertSnapshot(await waitForWorkDrain(ctx, api.baseUrl, ({ workId }) => workId === work.workId, [replacement]));
  const data = resources(snapshot);
  const finalWork = snapshot.work.find(({ workId }) => workId === work.workId);
  const escrow = data.escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
  const milestones = data.milestones.filter(({ escrowId }) => escrowId === fixture.escrowId);
  ctx.ok(finalWork?.terminal, `${point} Work terminal`);
  ctx.equal(finalWork.attempt, firstAttempt + 1, `${point} exact reclaimed attempt`);
  ctx.equal(finalWork.workId, work.workId, `${point} Work identity retained`);
  ctx.equal(escrow.refundedMinor, escrow.totalMinor, `${point} one complete refund`);
  ctx.equal(milestones.map(({ state }) => state), milestones.map(() => "REFUNDED"), `${point} no partial Milestone state`);
  ctx.equal(data.releases.filter(({ escrowId }) => escrowId === fixture.escrowId).length, 0, `${point} no Release`);
  ctx.equal(eventCount(snapshot, fixture.escrowId, "escrow.refunded"), eventCount(initial, fixture.escrowId, "escrow.refunded") + 1, `${point} one refund Event`);
  return { point, workId: work.workId, firstAttempt, finalAttempt: finalWork.attempt, workState: finalWork.state };
}

async function assertStableAfterStaleOwnerResumes(ctx, baseUrl, expected) {
  const stableStartedAt = Date.now();
  return ctx.waitFor(async () => {
    const current = stableSnapshot(assertSnapshot(await ctx.snapshot(baseUrl)));
    ctx.equal(current, expected, "stale owner cannot change winner");
    return Date.now() - stableStartedAt >= 4_000 ? current : undefined;
  }, { timeoutMs: 8_000, intervalMs: 100, label: "stale owner four-second stability window" });
}

const C01 = defineCase({
  id: "C-01",
  fixtureFamily: "EG-F-WORK",
  action: "Import future, due and already terminal expiry Work, observe a real claim and lease loss, then reclaim the due item and retain every terminal row.",
  oracle: "Work has exact public shape, lease fields exist only while LEASED, attempt increases once per claim, future Work remains pending, obsolete terminal Work remains retained, and drain requires a nonempty all-terminal selection.",
  async run(ctx) {
    const due = dueFixture(ctx, "work-due");
    const future = makeEscrowFixture(options(ctx), { expiresAt: ctx.at({ hours: 2 }), label: "work-future" });
    const terminal = makeEscrowFixture(options(ctx), { amounts: [100], states: ["RELEASED"], expiresAt: ctx.at({ days: -2 }), label: "work-terminal" });
    const { target, api } = await prepare(ctx, { seed: combineFixtures([due, future, terminal], due.fixtures.seedVersion("work-lifecycle")) });
    const initial = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const dueWork = initial.work.find(({ aggregateId }) => aggregateId === due.escrowId);
    const futureWork = initial.work.find(({ aggregateId }) => aggregateId === future.escrowId);
    const terminalWork = initial.work.find(({ aggregateId }) => aggregateId === terminal.escrowId);
    ctx.ok(dueWork && !dueWork.terminal && futureWork && !futureWork.terminal && terminalWork?.terminal, "due, future and retained terminal Work observable");
    ctx.ok(["SUCCEEDED", "FAILED", "CANCELLED"].includes(terminalWork.state), "terminal Work uses a published terminal state");
    const retainedBefore = canonicalJson(terminalWork);

    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.workId === dueWork.workId });
    const first = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === dueWork.workId, { timeoutMs: 60_000, processes: [first] });
    await assertNoOpenTransaction(ctx, target, "C-01 held claim");
    const leased = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const leasedWork = leased.work.find(({ workId }) => workId === dueWork.workId);
    ctx.equal(leasedWork.state, "LEASED", "claimed Work publicly LEASED");
    ctx.equal(leasedWork.attempt, dueWork.attempt + 1, "claim increments attempt once");
    ctx.ok(leasedWork.leaseOwner && leasedWork.leaseExpiresAt, "LEASED fields populated");
    ctx.equal(canonicalJson(leased.work.find(({ workId }) => workId === terminalWork.workId)), retainedBefore, "terminal Work retained during another claim");

    await ctx.kill(first);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const replacement = await target.startWorker();
    const drained = assertSnapshot(await waitForWorkDrain(ctx, api.baseUrl, ({ workId }) => workId === dueWork.workId, [replacement]));
    const completed = drained.work.find(({ workId }) => workId === dueWork.workId);
    const pending = drained.work.find(({ workId }) => workId === futureWork.workId);
    const retained = drained.work.find(({ workId }) => workId === terminalWork.workId);
    ctx.ok(completed.terminal, "reclaimed due Work terminal");
    ctx.equal(completed.attempt, leasedWork.attempt + 1, "reclaim increments attempt once");
    ctx.equal(pending.state, "PENDING", "future Work remains pending");
    ctx.equal(pending.attempt, futureWork.attempt, "future Work is not spuriously claimed");
    ctx.equal(canonicalJson(retained), retainedBefore, "pre-existing terminal Work retained exactly");
    return finalEvidence(ctx, { dueState: completed.state, attempts: completed.attempt, futureState: pending.state, retainedState: retained.state });
  },
});

const C02 = defineCase({
  id: "C-02",
  fixtureFamily: "EG-F-WORK-CLAIMED",
  action: "Hold due expiry Work at worker.claimed, prove no database transaction remains open, SIGKILL Worker A, wait for lease expiry and start Worker B.",
  oracle: "Worker B reclaims the same retained Work at attempt plus one, refunds exactly once, creates one refund Event, and the killed owner cannot duplicate any identity or amount.",
  async run(ctx) { return finalEvidence(ctx, await recoverAt(ctx, "worker.claimed")); },
});

const C03 = defineCase({
  id: "C-03",
  fixtureFamily: "EG-F-WORK-EFFECT",
  action: "Hold due expiry Work at worker.effect-complete, SIGKILL its process group, let the lease expire and start an independent replacement Worker.",
  oracle: "Repeatable computation may rerun but one complete business transaction, one retained terminal Work identity and one refund Event commit, with no partial aggregate state.",
  async run(ctx) { return finalEvidence(ctx, await recoverAt(ctx, "worker.effect-complete")); },
});

const C04 = defineCase({
  id: "C-04",
  fixtureFamily: "EG-F-WORK-COMMIT",
  action: "Hold due expiry Work at worker.before-commit, SIGKILL the process group, wait for its persisted lease to expire and let a replacement finish the same Work.",
  oracle: "The interrupted transaction is wholly absent or complete once; Escrow, Milestones, Fund Position, retained Work and refund Event expose no partial combination.",
  async run(ctx) { return finalEvidence(ctx, await recoverAt(ctx, "worker.before-commit")); },
});

const C05 = defineCase({
  id: "C-05",
  fixtureFamily: "EG-F-WORK-FENCE",
  action: "Hold Worker A after claim beyond its three-second lease, let Worker B reclaim and commit, release all held A requests, then keep A alive through a full post-release stability window.",
  oracle: "Only B's attempt and result remain; stale A cannot change Work, Escrow, Milestones, Fund Position or Event sequence after resuming, and the winner stays stable for longer than one lease.",
  async run(ctx) {
    const fixture = dueFixture(ctx, "fence");
    const { target, api } = await prepare(ctx, { seed: fixture.seed });
    const initial = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const work = initial.work.find(({ aggregateId, terminal }) => aggregateId === fixture.escrowId && !terminal);
    ctx.ok(work, "fencing Work exists");
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.workId === work.workId });
    const a = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === work.workId, { timeoutMs: 60_000, processes: [a] });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const b = await target.startWorker();
    const winner = assertSnapshot(await waitForWorkDrain(ctx, api.baseUrl, ({ workId }) => workId === work.workId, [b]));
    const winningWork = winner.work.find(({ workId }) => workId === work.workId);
    ctx.ok(winningWork.terminal, "replacement owns retained terminal result");
    ctx.equal(winningWork.attempt, held.json.attempt + 1, "exactly one replacement claim wins after lease expiry");
    const stable = stableSnapshot(winner);
    barrier.releaseAll();
    await assertStableAfterStaleOwnerResumes(ctx, api.baseUrl, stable);
    const finalSnapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const finalWork = finalSnapshot.work.find(({ workId }) => workId === work.workId);
    ctx.equal(finalWork, winningWork, "stale owner cannot alter winning Work row");
    ctx.equal(eventCount(finalSnapshot, fixture.escrowId, "escrow.refunded"), eventCount(initial, fixture.escrowId, "escrow.refunded") + 1, "one refund Event after stale resume");
    return finalEvidence(ctx, { staleAttempt: held.json.attempt, winningAttempt: finalWork.attempt, stableMs: 4_000 });
  },
});

const C06 = defineCase({
  id: "C-06",
  fixtureFamily: "EG-F-WORK-OBSOLETE",
  action: "Import a due single-Milestone SUBMITTED Escrow, commit manual acceptance to terminal RELEASED, then run the expiry Worker over its obsolete retained Work.",
  oracle: "The obsolete Work converges to a retained safe terminal state, backlog is not immortal, and the Worker cannot refund or overwrite the already committed Release or Event history.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { amounts: [100], states: ["SUBMITTED"], expiresAt: ctx.at({ days: -2 }), label: "manual-winner" });
    const { target, api } = await prepare(ctx, { seed: fixture.seed });
    const before = assertSnapshot(await ctx.snapshot(api.baseUrl));
    await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId);
    const worker = await target.startWorker();
    const drained = assertSnapshot(await waitForWorkDrain(ctx, api.baseUrl, ({ aggregateId }) => aggregateId === fixture.escrowId, [worker]));
    const data = resources(drained);
    const escrow = data.escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
    const work = drained.work.find(({ aggregateId }) => aggregateId === fixture.escrowId);
    ctx.equal(escrow.state, "RELEASED", "manual terminal winner preserved");
    ctx.equal({ released: escrow.releasedMinor, refunded: escrow.refundedMinor }, { released: 100, refunded: 0 }, "Worker cannot overwrite terminal amount");
    ctx.ok(work?.terminal, "obsolete Work retained terminal");
    ctx.equal(eventCount(drained, fixture.escrowId, "milestone.released"), eventCount(before, fixture.escrowId, "milestone.released") + 1, "manual Release Event once");
    ctx.equal(eventCount(drained, fixture.escrowId, "escrow.refunded"), eventCount(before, fixture.escrowId, "escrow.refunded"), "obsolete Work emits no refund Event");
    return finalEvidence(ctx, { workState: work.state });
  },
});

const C07 = defineCase({
  id: "C-07",
  fixtureFamily: "EG-F-EVENT-ACK",
  action: "Create a three-Event aggregate, hide the first successful webhook ACK at dispatcher.response-received, SIGKILL Dispatcher A, then make Dispatcher B observe 500, disconnect and eventual success.",
  oracle: "The unknown Event is retried with the same identity, type and semantic bytes, all aggregate sequences deliver in nondecreasing order within the bounded recovery window, and no second logical Event appears.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "unknown-ack" });
    const attemptTimes = [];
    let requestCount = 0;
    const receiver = await ctx.receiver({ behavior: () => {
      attemptTimes.push(performance.now());
      requestCount += 1;
      if (requestCount === 1) return { status: 204 };
      if (requestCount === 2) return { status: 500 };
      if (requestCount === 3) return { disconnect: true };
      return { status: 204 };
    } });
    const { target, api } = await prepare(ctx, { seed: fixture.seed });
    await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, { key: ctx.key("event-release") });
    const expectedSnapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const expected = aggregateEvents(expectedSnapshot, fixture.escrowId);
    ctx.ok(expected.length >= 3, "aggregate has a non-vacuous Event sequence");
    const firstEvent = expected[0];
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "dispatcher.response-received" && payload.aggregateId === fixture.escrowId });
    const first = await target.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    await barrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received" && entry.json.aggregateId === fixture.escrowId, { timeoutMs: 60_000, processes: [first] });
    await ctx.kill(first);
    const replacementStartedAt = performance.now();
    const replacement = await target.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => {
      const successfulIds = new Set(receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300).map(({ headers }) => headers["x-escrowguard-event-id"]));
      const firstAttempts = receiver.ledger.filter(({ headers }) => headers["x-escrowguard-event-id"] === firstEvent.eventId);
      return expected.every(({ eventId }) => successfulIds.has(eventId)) && firstAttempts.length >= 4;
    }, { timeoutMs: 60_000, label: "ordered unknown-ACK recovery", processes: [replacement] });
    ctx.ok(performance.now() - replacementStartedAt < 60_000, "retry/backoff remains inside bounded recovery window");
    const firstAttempts = receiver.ledger.filter(({ headers }) => headers["x-escrowguard-event-id"] === firstEvent.eventId);
    ctx.ok(firstAttempts.length >= 4, "unknown ACK Event retried through 500 and disconnect");
    ctx.ok(firstAttempts.some(({ responseStatus }) => responseStatus === 500), "same Event observes a retryable 500");
    ctx.ok(firstAttempts.some(({ acknowledged }) => !acknowledged), "same Event observes a disconnected ACK");
    assertDeliveryBindings(ctx, receiver.ledger, expected, "C-07 receiver ledger");
    const successful = receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300).map(({ json }) => json).filter(({ aggregateId }) => aggregateId === fixture.escrowId);
    const sequences = successful.map(({ sequence }) => sequence);
    ctx.equal(sequences, [...sequences].sort((left, right) => left - right), "successful delivery order never reverses");
    ctx.equal([...new Set(sequences)], expected.map(({ sequence }) => sequence), "every aggregate sequence delivered");
    const after = assertSnapshot(await ctx.snapshot(api.baseUrl));
    ctx.equal(aggregateEvents(after, fixture.escrowId).map(({ eventId }) => eventId), expected.map(({ eventId }) => eventId), "delivery retry creates no logical Event");
    return finalEvidence(ctx, { attempts: firstAttempts.length, events: expected.length, recoveryMs: Math.round(performance.now() - replacementStartedAt), observedIntervals: Math.max(0, attemptTimes.length - 1) });
  },
});

const C08 = defineCase({
  id: "C-08",
  fixtureFamily: "EG-F-EVENT-ORDER",
  action: "Hold due expiry at worker.before-commit, SIGKILL it, hold its replacement at the same public seam while several independent APIs continuously sample point-in-time snapshots across release, then crash and restart one held dispatcher ACK.",
  oracle: "No sampled database point exposes refund state without its Event or its Event without refund state; rollback has neither, replacement has both, aggregate sequences stay ordered, and held delivery retries one identity.",
  async run(ctx) {
    const fixtures = ["left", "right"].map((label) => dueFixture(ctx, `event-${label}`));
    const receiver = await ctx.receiver();
    const { target, apis } = await prepare(ctx, { seed: combineFixtures(fixtures), apiCount: 2 });
    const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const beforeFailure = stableSnapshot(before);
    semanticError(await createEscrow(ctx, apis[0].baseUrl, fundedRequest(fixtures[0], [1], { totalMinor: 2 }), { key: ctx.key("rollback"), allowFailure: true }), 400, "INVALID_ESCROW_TOTAL");
    ctx.equal(stableSnapshot(assertSnapshot(await ctx.snapshot(apis[0].baseUrl))), beforeFailure, "rollback has no business, Work, or Event effect");

    const aggregateIds = new Set(fixtures.map(({ escrowId }) => escrowId));
    let heldCommitOnce = false;
    const commitBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && aggregateIds.has(payload.aggregateId) && !heldCommitOnce && (heldCommitOnce = true) });
    const crashedWorker = await target.startWorker({ env: { TEST_BARRIER_URL: commitBarrier.url, TEST_BARRIER_TOKEN: commitBarrier.token } });
    const heldCommit = await commitBarrier.waitFor((entry) => entry.json?.point === "worker.before-commit" && aggregateIds.has(entry.json.aggregateId), { timeoutMs: 60_000, processes: [crashedWorker] });
    const crashedAggregateId = heldCommit.json.aggregateId;
    await assertNoOpenTransaction(ctx, target, "C-08 public before-commit barrier");
    const heldSnapshot = assertSnapshot(await ctx.snapshot(apis[1].baseUrl));
    assertRefundStateEventBoundary(ctx, before, heldSnapshot, crashedAggregateId, false, "held before-commit");
    await ctx.kill(crashedWorker);
    const killedSnapshot = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    assertRefundStateEventBoundary(ctx, before, killedSnapshot, crashedAggregateId, false, "SIGKILL before commit");

    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const replacementBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.workId === heldCommit.json.workId });
    const replacementEnvironment = { TEST_BARRIER_URL: replacementBarrier.url, TEST_BARRIER_TOKEN: replacementBarrier.token };
    const replacements = await Promise.all([target.startWorker({ env: replacementEnvironment }), target.startWorker({ env: replacementEnvironment })]);
    const replacementHeld = await replacementBarrier.waitFor((entry) => entry.json?.point === "worker.before-commit" && entry.json.workId === heldCommit.json.workId && entry.json.attempt > heldCommit.json.attempt, { timeoutMs: 60_000, processes: replacements });
    await assertNoOpenTransaction(ctx, target, "C-08 replacement before-commit barrier");
    const baselineDetail = await getDetail(ctx, apis[0].baseUrl, crashedAggregateId);
    const persistedEventId = aggregateEvents(before, crashedAggregateId)[0]?.eventId;
    ctx.ok(persistedEventId, "C-08 has a persisted Event identity for the evaluator storage lock");
    const eventStorage = await holdEventStorage(ctx, target, persistedEventId);
    replacementBarrier.release(replacementHeld);
    const blockedEventWriters = await eventStorage.waitForBlockedCandidate();
    const whileEventInsertBlocked = await getDetail(ctx, apis[1].baseUrl, crashedAggregateId);
    ctx.equal(canonicalJson(whileEventInsertBlocked), canonicalJson(baselineDetail), "business state cannot commit before its Domain Event transaction");
    const boundaryObservations = [heldSnapshot, killedSnapshot];
    let sampling = true;
    let samplingFailure;
    const samplers = Array.from({ length: 4 }, (_, sampler) => (async () => {
      while (sampling && boundaryObservations.length < 128) {
        try {
          const observed = assertSnapshot(await ctx.snapshot(apis[sampler % apis.length].baseUrl));
          boundaryObservations.push(observed);
          const beforeBusiness = aggregateBusinessState(before, crashedAggregateId);
          const stateCommitted = aggregateBusinessState(observed, crashedAggregateId) !== beforeBusiness;
          const beforeEventIds = new Set(aggregateEvents(before, crashedAggregateId).map(({ eventId }) => eventId));
          const eventCommitted = aggregateEvents(observed, crashedAggregateId).some(({ eventId }) => !beforeEventIds.has(eventId));
          if (stateCommitted !== eventCommitted) throw new Error("refund state and Domain Event became visible in separate commits");
        } catch (error) {
          samplingFailure ??= error;
          sampling = false;
        }
      }
    })());
    await new Promise((resolve) => setImmediate(resolve));
    await eventStorage.release();
    const afterSuccess = assertSnapshot(await waitForWorkDrain(ctx, apis[0].baseUrl, ({ aggregateId }) => aggregateIds.has(aggregateId), replacements));
    boundaryObservations.push(afterSuccess);
    sampling = false;
    await Promise.all(samplers);
    if (samplingFailure) throw samplingFailure;
    const atomicTrace = assertAtomicRefundObservationTrace(ctx, before, boundaryObservations, crashedAggregateId, "replacement refund/Event commit");
    for (const fixture of fixtures) assertRefundStateEventBoundary(ctx, before, afterSuccess, fixture.escrowId, true, `${fixture.escrowId} replacement commit`);
    const recoveredWork = afterSuccess.work.find(({ workId }) => workId === heldCommit.json.workId);
    ctx.equal(recoveredWork?.attempt, heldCommit.json.attempt + 1, "killed before-commit Work reclaimed exactly once");

    let heldDispatchOnce = false;
    const dispatchBarrier = await ctx.barrier({ hold: (payload) => payload.point === "dispatcher.response-received" && payload.aggregateId === crashedAggregateId && !heldDispatchOnce && (heldDispatchOnce = true) });
    const first = await target.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: dispatchBarrier.url, TEST_BARRIER_TOKEN: dispatchBarrier.token } });
    await dispatchBarrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received" && entry.json.aggregateId === crashedAggregateId, { timeoutMs: 60_000, processes: [first] });
    const heldRequest = receiver.ledger.findLast(({ json }) => json?.aggregateId === crashedAggregateId);
    const heldEventId = heldRequest?.headers["x-escrowguard-event-id"];
    ctx.ok(heldEventId, "held receiver request identity observed");
    await ctx.kill(first);
    const replacement = await target.startDispatcher({ webhookUrl: receiver.url });
    const expected = afterSuccess.events;
    await ctx.waitFor(() => {
      const successful = receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300);
      const deliveredIds = new Set(successful.map(({ headers }) => headers["x-escrowguard-event-id"]));
      const heldAttempts = receiver.ledger.filter(({ headers }) => headers["x-escrowguard-event-id"] === heldEventId).length;
      return expected.every(({ eventId }) => deliveredIds.has(eventId)) && heldAttempts >= 2;
    }, { timeoutMs: 60_000, label: "all ordered Events and held redelivery", processes: [replacement] });
    ctx.ok(receiver.ledger.filter(({ headers }) => headers["x-escrowguard-event-id"] === heldEventId).length >= 2, "held Event redelivered after process loss");
    assertDeliveryBindings(ctx, receiver.ledger, expected, "C-08 receiver ledger");
    const successful = receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300).map(({ json }) => json);
    for (const fixture of fixtures) {
      const delivered = successful.filter(({ aggregateId }) => aggregateId === fixture.escrowId).map(({ sequence }) => sequence);
      const expectedSequences = aggregateEvents(afterSuccess, fixture.escrowId).map(({ sequence }) => sequence);
      ctx.ok(expectedSequences.length >= 2, "non-vacuous expected aggregate history");
      ctx.equal(delivered, [...delivered].sort((left, right) => left - right), "aggregate delivery order including retries");
      ctx.equal([...new Set(delivered)], expectedSequences, "every aggregate sequence delivered exactly as history");
    }
    const serialized = JSON.stringify(receiver.ledger.map(({ headers, raw }) => ({ headers, raw })));
    ctx.ok(![ctx.adminToken, ctx.barrierToken, ctx.databaseUrl].some((secret) => serialized.includes(secret)), "delivery omits evaluator tokens and database authority");
    assertNoPrivatePaths(serialized, "delivery");
    const finalSnapshot = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    ctx.equal(finalSnapshot.events.map(({ eventId }) => eventId), expected.map(({ eventId }) => eventId), "delivery recovery creates no logical Event");
    return finalEvidence(ctx, { commitBarrier: "worker.before-commit", crashedAggregateId, crashedAttempt: heldCommit.json.attempt, recoveredAttempt: recoveredWork.attempt, eventStorageRelations: eventStorage.relations.length, blockedEventWriters, atomicSnapshotObservations: atomicTrace.observations, events: expected.length, heldEventId, heldAttempts: receiver.ledger.filter(({ headers }) => headers["x-escrowguard-event-id"] === heldEventId).length });
  },
});

export const C_CASES = Object.freeze([C01, C02, C03, C04, C05, C06, C07, C08]);
