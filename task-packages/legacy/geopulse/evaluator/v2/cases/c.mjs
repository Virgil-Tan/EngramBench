import { projectTimeline } from "../oracles/index.mjs";
import {
  acceptBatch,
  acceptEvent,
  assertEvents,
  assertNoSnapshotChange,
  canonicalJson,
  createBundle,
  finalEvidence,
  guardedCase,
  killLeasedWork,
  publishBundle,
  recursiveField,
  resource,
  scaleRegionSeed,
  startPreparedApi,
  transitionProjection,
  waitForDrain,
} from "./helpers.mjs";

const correctness = ["CORRECTNESS_INVARIANT"];

function eventFor(ctx, seed, label, sequence, observedAt, point = { longitude: 0.005, latitude: 0.005 }, deviceIndex = 0) {
  return {
    eventId: ctx.uuid(label),
    tenantId: seed.tenants[0].tenantId,
    deviceId: seed.devices[deviceIndex].deviceId,
    deviceSequence: sequence,
    observedAt,
    ...point,
    accuracyMeters: 2,
  };
}

function transitionsFor(snapshot, event, regionId) {
  return resource(snapshot, "transitions")
    .filter(({ deviceId, regionId: value }) => deviceId === event.deviceId && value === regionId)
    .sort((left, right) => left.sequence - right.sequence);
}

const c01 = guardedCase({
  id: "C-01",
  fixtureFamily: "GP-F-RECOVERY-EVALUATION",
  action: "Create LOCATION_EVALUATION Work over 100 active Regions, poll the public snapshot until LEASED, SIGKILL that Worker, wait for lease expiry and start a replacement.",
  oracle: "A same-timeline uninterrupted control Device plus independent geometry projection proves the replacement commits one Membership, Transition, Work and Event effect under the frozen version.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 100, 2);
    const version = seed.regionVersions[0];
    const api = await startPreparedApi(ctx, { seed });
    const failed = eventFor(ctx, seed, "recovery-evaluation", 1, ctx.at({ seconds: 1 }));
    await acceptEvent(ctx, api.baseUrl, failed);
    const leased = await killLeasedWork(ctx, api.baseUrl, { kind: "LOCATION_EVALUATION", aggregateId: failed.eventId });
    const replacement = await ctx.startWorker();
    let snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [replacement] });
    const recoveredMembership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === failed.deviceId && regionId === version.regionId);
    const recoveredTransitions = transitionsFor(snapshot, failed, version.regionId);
    const expected = projectTimeline([failed], version);
    ctx.equal({ state: recoveredMembership?.state, regionVersionId: recoveredMembership?.regionVersionId }, {
      state: expected.membership.state, regionVersionId: version.regionVersionId,
    }, "recovered Membership equals independent projection", { hardCapIds: correctness });
    ctx.equal(recoveredTransitions.map(transitionProjection), expected.transitions, "recovered Transition equals independent projection", { hardCapIds: correctness });

    const control = eventFor(ctx, seed, "control-evaluation", 1, failed.observedAt, { longitude: failed.longitude, latitude: failed.latitude }, 1);
    await acceptEvent(ctx, api.baseUrl, control);
    snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [replacement] });
    const controlTransitions = transitionsFor(snapshot, control, version.regionId);
    ctx.equal(controlTransitions.map(({ type, observedAt, sequence }) => ({ type, observedAt, sequence })), recoveredTransitions.map(({ type, observedAt, sequence }) => ({ type, observedAt, sequence })), "recovered and uninterrupted timelines have identical transition semantics");
    ctx.equal((snapshot.work ?? []).filter(({ aggregateId }) => aggregateId === failed.eventId).length, 1, "recovery retains one durable Work identity", { hardCapIds: correctness });
    ctx.equal((snapshot.work ?? []).find(({ workId }) => workId === leased.work.workId)?.state, "SUCCEEDED", "reclaimed Work reaches SUCCEEDED");
    ctx.equal(recoveredTransitions.length, 1, "recovery creates no duplicate Transition effect", { hardCapIds: correctness });
    assertEvents(ctx, snapshot.events ?? []);
    return ctx.pass({
      diagnostics: [ctx.diagnostic("evaluation-effect-complete-before-commit", "GP-GAP-03")],
      evidence: [{ kind: "geopulse-case-summary", killedWorkers: 1, reclaimedWorkId: leased.work.workId, replacementCommitted: true }],
    });
  },
}, correctness);

const c02 = guardedCase({
  id: "C-02",
  fixtureFamily: "GP-F-LATE-RECOVERY",
  action: "Fully process a later inside event, submit an earlier outside event inside the reorder window, observe LATE_REPLAY as LEASED, SIGKILL and reclaim it.",
  oracle: "Full canonical-order reconstruction independently requires one ENTER from the later source, one Membership watermark and no duplicate published identity or sequence gap.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 1, 1);
    const version = seed.regionVersions[0];
    const api = await startPreparedApi(ctx, { seed });
    const later = eventFor(ctx, seed, "late-recovery-later", 2, ctx.at({ seconds: 20 }));
    const initialWorker = await ctx.startWorker();
    await acceptEvent(ctx, api.baseUrl, later);
    await waitForDrain(ctx, api.baseUrl, { processes: [initialWorker] });
    await ctx.stop(initialWorker);
    const earlier = eventFor(ctx, seed, "late-recovery-earlier", 1, ctx.at({ seconds: 10 }), { longitude: 0.02, latitude: 0.005 });
    await acceptEvent(ctx, api.baseUrl, earlier);
    const leased = await killLeasedWork(ctx, api.baseUrl, { kind: "LATE_REPLAY", aggregateId: earlier.eventId });
    const replacement = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [replacement] });
    const expected = projectTimeline([earlier, later], version);
    const membership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === later.deviceId && regionId === version.regionId);
    const transitions = transitionsFor(snapshot, later, version.regionId);
    ctx.equal({
      state: membership?.state,
      enteredAt: membership?.enteredAt,
      lastObservedAt: membership?.lastObservedAt,
      lastDeviceSequence: membership?.lastDeviceSequence,
      watermark: membership?.watermark,
    }, {
      state: expected.membership.state,
      enteredAt: expected.membership.enteredAt,
      lastObservedAt: expected.membership.lastObservedAt,
      lastDeviceSequence: expected.membership.lastDeviceSequence,
      watermark: expected.membership.watermark,
    }, "recovered late replay Membership", { hardCapIds: correctness });
    ctx.equal(transitions.map(transitionProjection), expected.transitions, "recovered late replay Transitions", { hardCapIds: correctness });
    ctx.equal(new Set(transitions.map(({ transitionId }) => transitionId)).size, transitions.length, "published Transition identities stay unique", { hardCapIds: correctness });
    ctx.equal((snapshot.work ?? []).find(({ workId }) => workId === leased.work.workId)?.state, "SUCCEEDED", "LATE_REPLAY is reclaimed once");
    return ctx.pass({
      diagnostics: [ctx.diagnostic("replay-effect-complete-before-commit", "GP-GAP-03")],
      evidence: [{ kind: "geopulse-case-summary", killedWorkers: 1, lateReplayRecovered: true, transitions: transitions.length }],
    });
  },
}, correctness);

const c03 = guardedCase({
  id: "C-03",
  fixtureFamily: "GP-F-BUNDLE-REEVALUATION-RECOVERY",
  action: "Create projected Memberships, publish a 50-member revision, observe BUNDLE_REEVALUATION as LEASED and SIGKILL it, publish a 75-member successor, then drain both with replacement Workers.",
  oracle: "Immutable revision membership sets, one bundleRevisionId per Membership, terminal captured Work and source/type uniqueness prove revision-consistent fenced recovery.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 100, 1);
    const tenantId = seed.tenants[0].tenantId;
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, tenantId);
    const members = seed.regionVersions.map(({ regionVersionId }) => regionVersionId).sort();
    await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0, effectiveFrom: ctx.at({ hours: -1 }), regionVersionIds: members,
    });
    const worker = await ctx.startWorker();
    await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const event = eventFor(ctx, seed, "reevaluation-source", 1, ctx.at({ seconds: 1 }));
    await acceptEvent(ctx, api.baseUrl, event);
    await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    await ctx.stop(worker);
    const second = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 1, effectiveFrom: ctx.at({ hours: 1 }), regionVersionIds: members.slice(0, 50),
    });
    const leased = await killLeasedWork(ctx, api.baseUrl, { kind: "BUNDLE_REEVALUATION" });
    const third = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 2, effectiveFrom: ctx.at({ hours: 2 }), regionVersionIds: members.slice(0, 75),
    });
    const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: replacements });
    const reevaluations = (snapshot.work ?? []).filter(({ kind }) => kind === "BUNDLE_REEVALUATION");
    ctx.ok(reevaluations.length >= 3 && reevaluations.every(({ terminal }) => terminal), "all captured Bundle reevaluations reach terminal state");
    ctx.equal((snapshot.work ?? []).find(({ workId }) => workId === leased.work.workId)?.state, "SUCCEEDED", "killed reevaluation Work is reclaimed");
    const allowed = new Set([second.revision.bundleRevisionId, third.revision.bundleRevisionId]);
    const memberships = resource(snapshot, "memberships").filter(({ deviceId }) => deviceId === event.deviceId);
    ctx.ok(memberships.length > 0 && memberships.every(({ bundleRevisionId }) => allowed.has(bundleRevisionId)), "each Membership exposes one complete captured revision", { hardCapIds: correctness });
    const transitions = resource(snapshot, "transitions").filter(({ deviceId }) => deviceId === event.deviceId);
    ctx.equal(new Set(transitions.map(({ sourceEventId, type }) => `${sourceEventId}:${type}`)).size, transitions.length, "successive reevaluations do not duplicate Transitions", { hardCapIds: correctness });
    ctx.equal(resource(snapshot, "regionBundleRevisions").find(({ revision }) => revision === 2)?.regionVersionIds, members.slice(0, 50), "revision two member set is immutable");
    ctx.equal(resource(snapshot, "regionBundleRevisions").find(({ revision }) => revision === 3)?.regionVersionIds, members.slice(0, 75), "revision three member set is immutable");
    return ctx.pass({
      diagnostics: [ctx.diagnostic("reevaluation-expired-owner-forced-commit", "GP-GAP-03")],
      evidence: [{ kind: "geopulse-case-summary", killedWorkers: 1, replacements: 2, terminalReevaluations: reevaluations.length }],
    });
  },
}, correctness);

const c04 = guardedCase({
  id: "C-04",
  fixtureFamily: "GP-F-EVENT-UNKNOWN-ACK",
  action: "Create rejected and committed Location plus Bundle mutations, return 500 then disconnect after receiving a body, SIGKILL the known Dispatcher and restart it against the harness receiver.",
  oracle: "Receiver ledger and verification snapshot require transactional absence on rollback, stable retry eventId/body, contiguous per-aggregate sequence, cross-aggregate progress and coordinate redaction.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 2, 1);
    const api = await startPreparedApi(ctx, { seed });
    const beforeRejected = await ctx.snapshot(api.baseUrl);
    const invalid = eventFor(ctx, seed, "event-invalid", 1, ctx.at({ seconds: 1 }), { longitude: 0.005, latitude: 91 });
    const rejected = await acceptBatch(ctx, api.baseUrl, [invalid], { expectedStatus: 400, key: ctx.key("event-invalid-batch") });
    ctx.ok(rejected.status === 400, "invalid batch is rejected");
    assertNoSnapshotChange(ctx, beforeRejected, await ctx.snapshot(api.baseUrl), "rolled-back event mutation");

    const bundle = await createBundle(ctx, api.baseUrl, seed.tenants[0].tenantId);
    await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: seed.regionVersions.map(({ regionVersionId }) => regionVersionId),
    });
    const accepted = eventFor(ctx, seed, "event-delivery-location", 1, ctx.at({ seconds: 2 }));
    await acceptEvent(ctx, api.baseUrl, accepted);
    const worker = await ctx.startWorker();
    const committed = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    assertEvents(ctx, committed.events ?? []);

    const receiver = await ctx.receiver({
      behavior(entry) {
        if (entry.attempt === 1) return { status: 500 };
        if (entry.attempt === 2) return { disconnect: true };
        return { status: 204 };
      },
    });
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => receiver.ledger.length >= 2, { timeoutMs: 60_000, label: "receiver unknown acknowledgement", processes: [dispatcher] });
    await ctx.kill(dispatcher);
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const eventIds = new Set((committed.events ?? []).map(({ eventId }) => eventId));
    await ctx.waitFor(() => {
      const acknowledged = new Set(receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ json }) => recursiveField(json, "eventId")));
      return [...eventIds].every((eventId) => acknowledged.has(eventId));
    }, { timeoutMs: 120_000, label: "all committed events acknowledged", processes: [replacement] });

    const deliveredBodies = new Map();
    for (const entry of receiver.ledger) {
      const eventId = recursiveField(entry.json, "eventId");
      if (!eventId) continue;
      const body = canonicalJson(entry.json);
      if (deliveredBodies.has(eventId)) ctx.equal(body, deliveredBodies.get(eventId), `retry body remains stable for ${eventId}`, { hardCapIds: correctness });
      else deliveredBodies.set(eventId, body);
    }
    ctx.ok(receiver.ledger.some(({ attempt }) => attempt === 2), "receiver captured the disconnected body before dispatcher death");
    ctx.ok(new Set(receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ json }) => recursiveField(json, "eventId"))).size >= 2, "one failing aggregate does not block other aggregates");
    for (const body of deliveredBodies.values()) ctx.ok(!/(?:longitude|latitude|0\.005)/iu.test(body), "delivered Event body excludes raw coordinates", { hardCapIds: correctness });
    return finalEvidence(ctx, { dispatcherKills: 1, attempts: receiver.ledger.length, uniqueEvents: deliveredBodies.size });
  },
}, correctness);

export const C_CASES = Object.freeze([c01, c02, c03, c04]);
