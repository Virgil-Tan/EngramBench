import {
  assertAggregateSequences,
  assertRetryIdentity,
  royaltyPeriodDigest,
  assertUtcTimestamp,
} from "../oracles/index.mjs";
import {
  assertAllPostings,
  assertNoTemporaryMedia,
  caseResult,
  completeUpload,
  createApprovedLicense,
  createDisputeFor,
  createHoldFor,
  createPurchase,
  createRefund,
  crashWorkerAt,
  defineCase,
  mutate,
  prepare,
  providerEvent,
  requireStatus,
  resourceFrom,
  snapshot,
  uploadAll,
  waitSnapshot,
} from "./helpers.mjs";
import { crashMediaWorkerAt, expectedMediaAsset, mediaAssetsReady } from './media-work.mjs';

const c01 = defineCase(
  "C-01",
  "CRE-F-WORK observable lease lifecycle",
  "Create VIRUS_SCAN Work, pause a Worker immediately after claim, inspect lease fields, release it and retain the terminal record",
  "Attempt, owner, expiry and terminal state are consistent, lease is bounded and no usable barrier token is exposed by the public snapshot",
  ["public upload", "worker.claimed barrier", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.work();
    const { api } = await prepare(ctx, family);
    const uploaded = await uploadAll(ctx, api.baseUrl, family, {
      label: "c01",
    });
    await completeUpload(
      ctx,
      api.baseUrl,
      uploaded.uploadSession.uploadId,
      uploaded.plan,
      "c01-complete",
    );
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point, kind }) =>
        armed && point === "worker.claimed" && kind === "VIRUS_SCAN",
    });
    const worker = await ctx.startWorker({
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const entry = await barrier.waitFor(
      ({ json }) =>
        json.point === "worker.claimed" && json.kind === "VIRUS_SCAN",
      { timeoutMs: 120_000, processes: [worker] },
    );
    const leasedState = await snapshot(ctx, api.baseUrl);
    const leased = leasedState.work.find(
      ({ workId }) => workId === entry.json.workId,
    );
    ctx.ok(leased, 'claimed Work is durably visible');
    ctx.equal(leased.terminal, false, 'claimed Work is not terminal');
    ctx.equal(leased.kind, entry.json.kind, 'claimed Work kind');
    ctx.equal(leased.aggregateId, entry.json.aggregateId, 'claimed Work aggregate');
    ctx.ok(typeof leased.leaseOwner === 'string' && leased.leaseOwner.length > 0, 'lease owner visible');
    ctx.equal(leased.attempt, entry.json.attempt, "attempt visible");
    // Claim time is not in the public barrier payload. The barrier/snapshot delay
    // must not be mistaken for the lease duration; recovery cases exercise expiry.
    ctx.assert('claim lease expiry', () => assertUtcTimestamp(leased.leaseExpiresAt));
    ctx.ok(
      leased.leaseToken !== entry.json.leaseToken,
      "usable lease token not exposed publicly",
    );
    armed = false;
    barrier.release(entry);
    const terminalState = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.work.find(({ workId }) => workId === entry.json.workId)?.terminal
          ? value
          : undefined,
      { label: "terminal Work", processes: [worker] },
    );
    const terminal = terminalState.work.find(
      ({ workId }) => workId === entry.json.workId,
    );
    ctx.equal(terminal.terminal, true, "terminal retained");
    return caseResult(ctx, {
      workId: terminal.workId,
      attempt: terminal.attempt,
    });
  },
);

const c02 = defineCase(
  "C-02",
  "CRE-F-PIPELINE claimed scan crash",
  "Complete one upload, SIGKILL the VIRUS_SCAN Worker after claim, wait lease expiry and let two replacements race",
  "Exactly one ScanResult and verdict commit; stale lease cannot schedule duplicate transcodes or Events and Work converges terminal",
  [
    "worker.claimed barrier",
    "SIGKILL",
    "replacement Workers",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.pipeline("c02");
    const { api } = await prepare(ctx, family);
    const uploaded = await uploadAll(ctx, api.baseUrl, family, {
      label: "c02",
    });
    const completed = await completeUpload(
      ctx,
      api.baseUrl,
      uploaded.uploadSession.uploadId,
      uploaded.plan,
      "c02-complete",
    );
    const expected = expectedMediaAsset(completed, uploaded, family);
    const { assetId } = expected;
    const recovery = await crashMediaWorkerAt(ctx, api.baseUrl, expected, "VIRUS_SCAN", {
      replacements: 2,
    });
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) => mediaAssetsReady(value, [expected]),
      { label: "scan recovery drain", processes: recovery.replacements },
    );
    ctx.equal(
      final.resources.scanResults.filter(({ assetId: id }) => id === assetId)
        .length,
      1,
      "one ScanResult",
      { hardCapIds: ["STALE_WORK_FENCING"] },
    );
    ctx.equal(
      new Set(
        final.resources.transcodeJobs
          .filter(({ assetId: id }) => id === assetId)
          .map(
            ({ profileId, profileRevision }) =>
              `${profileId}:${profileRevision}`,
          ),
      ).size,
      family.uploadSession.requiredProfileIds.length,
      "one transcode per frozen profile",
    );
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      assetId,
      killedAttempt: recovery.entry.json.attempt,
    });
  },
);

const c03 = defineCase(
  "C-03",
  "CRE-F-PIPELINE local transcode crash",
  "Let scan finish, SIGKILL a local COPY/PREFIX claimant after TRANSCODE claim, expire the lease and drain with replacements",
  "One verified Rendition per frozen profile remains, no partial media survives and READY appears only after all frozen renditions complete",
  ["worker.claimed barrier", "SIGKILL", "managed root", "asset metadata"],
  async (ctx) => {
    const family = ctx.fixtures.pipeline("c03");
    const { api } = await prepare(ctx, family);
    const uploaded = await uploadAll(ctx, api.baseUrl, family, {
      label: "c03",
    });
    const completed = await completeUpload(
      ctx,
      api.baseUrl,
      uploaded.uploadSession.uploadId,
      uploaded.plan,
      "c03-complete",
    );
    const expected = expectedMediaAsset(completed, uploaded, family);
    const { assetId } = expected;
    const recovery = await crashMediaWorkerAt(ctx, api.baseUrl, expected, "TRANSCODE", {
      replacements: 2,
      drainTimeoutMs: 240_000,
    });
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) => mediaAssetsReady(value, [expected]),
      { label: "transcode recovery drain", processes: recovery.replacements },
    );
    const renditions = final.resources.renditions.filter(
      ({ assetId: id }) => id === assetId,
    );
    ctx.equal(
      renditions.length,
      family.uploadSession.requiredProfileIds.length,
      "one rendition per profile",
      { hardCapIds: ["STALE_WORK_FENCING"] },
    );
    ctx.equal(
      new Set(
        renditions.map(
          ({ profileId, profileRevision }) => `${profileId}:${profileRevision}`,
        ),
      ).size,
      renditions.length,
      "rendition identities unique",
    );
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      assetId,
      renditions: renditions.map(({ renditionId }) => renditionId),
    });
  },
);

const c04 = defineCase(
  "C-04",
  "CRE-F-PURCHASE UNKNOWN payment reconcile crash",
  "Complete deterministic fraud, post UNKNOWN, pause reconciliation after external effect, SIGKILL it, post concurrent success and drain by replacements",
  "Fraud result and payment authority remain monotonic, exactly one License path commits and every reconcile Work terminalizes without predicting success",
  [
    "worker.effect-complete barrier",
    "provider event HTTP",
    "SIGKILL",
    "replacement Workers",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("c04");
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const purchase = await createPurchase(
      ctx,
      api.baseUrl,
      family.purchaseBody,
      "c04-purchase",
    );
    const fraudWorker = await ctx.startWorker();
    await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.fraudAssessments.find(
          ({ purchaseOrderId, state }) =>
            purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId &&
            state === "COMPLETED",
        )
          ? value
          : undefined,
      { label: "fraud complete", processes: [fraudWorker] },
    );
    await ctx.stop(fraudWorker);
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "c04-unknown",
        providerRequestId: family.purchaseBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "UNKNOWN",
        occurredAt: ctx.at(),
      },
      "c04-unknown",
    );
    const pending = await snapshot(ctx, api.baseUrl);
    const reconcileWork = pending.work.find(
      ({ aggregateId, terminal }) =>
        aggregateId === purchase.json.paymentIntent.paymentIntentId &&
        !terminal,
    );
    ctx.ok(reconcileWork, "UNKNOWN schedules reconcile Work");
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point, workId }) =>
        armed &&
        point === "worker.effect-complete" &&
        workId === reconcileWork.workId,
    });
    const first = await ctx.startWorker({
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const entry = await barrier.waitFor(
      ({ json }) =>
        json.point === "worker.effect-complete" &&
        json.workId === reconcileWork.workId,
      { timeoutMs: 120_000, processes: [first] },
    );
    await providerEvent(
      ctx,
      apis[1].baseUrl,
      {
        providerEventId: "c04-success",
        providerRequestId: family.purchaseBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "c04-success",
    );
    await ctx.kill(first);
    armed = false;
    await ctx.sleep(3_300);
    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.licenses.some(
          ({ purchaseOrderId }) =>
            purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
        ) &&
        value.work.find(({ workId }) => workId === entry.json.workId)?.terminal
          ? value
          : undefined,
      { label: "payment recovery", processes: replacements },
    );
    ctx.equal(
      final.resources.paymentIntents.find(
        ({ paymentIntentId }) =>
          paymentIntentId === purchase.json.paymentIntent.paymentIntentId,
      ).state,
      "SUCCEEDED",
      "payment authority monotonic",
    );
    ctx.equal(
      final.resources.licenses.filter(
        ({ purchaseOrderId }) =>
          purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
      ).length,
      1,
      "one License path",
      { hardCapIds: ["STALE_WORK_FENCING", "LICENSE_AUTHORITY_ATOMICITY"] },
    );
    return caseResult(ctx, {
      paymentIntentId: purchase.json.paymentIntent.paymentIntentId,
      killedWorkId: entry.json.workId,
    });
  },
);

const c05 = defineCase(
  "C-05",
  "CRE-F-ROYALTY close claim fencing",
  "Advance a populated period, SIGKILL the first close claimant after claim, expire it and let a replacement close",
  "One CLOSED transition and digest commit, entry values remain immutable, and stale attempt cannot create a second Notification or Event",
  [
    "RoyaltyPeriod HTTP",
    "worker.claimed barrier",
    "SIGKILL",
    "replacement Worker",
  ],
  async (ctx) => {
    const family = ctx.fixtures.royalty({ label: "c05", closed: false });
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const response = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/royalty-periods",
      "c05-close",
      {
        tenantId: family.tenant.tenantId,
        currency: family.royaltyPeriod.currency,
        periodStart: family.royaltyPeriod.periodStart,
        periodEnd: family.royaltyPeriod.periodEnd,
      },
      { expected: 200 },
    );
    const period = resourceFrom(
      response.json,
      "royaltyPeriodId",
      "royaltyPeriod",
    );
    const pending = await snapshot(ctx, api.baseUrl);
    const closeWork = pending.work.find(
      ({ aggregateId, terminal }) =>
        aggregateId === period.royaltyPeriodId && !terminal,
    );
    const recovery = await crashWorkerAt(ctx, api.baseUrl, "worker.claimed", {
      kind: closeWork.kind,
      aggregateId: period.royaltyPeriodId,
      replacements: 1,
    });
    const final = recovery.after;
    const closed = final.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) => royaltyPeriodId === period.royaltyPeriodId,
    );
    ctx.equal(closed.state, "CLOSED", "one close winner");
    ctx.equal(
      closed.snapshotDigest,
      royaltyPeriodDigest(final.resources.royaltyEntries, closed),
      "close digest oracle",
      { hardCapIds: ["STALE_WORK_FENCING", "ROYALTY_IMMUTABILITY"] },
    );
    ctx.equal(
      final.resources.royaltyEntries.filter((row) =>
        before.resources.royaltyEntries.some(
          ({ royaltyEntryId }) => royaltyEntryId === row.royaltyEntryId,
        ),
      ),
      before.resources.royaltyEntries,
      "entries immutable",
    );
    ctx.equal(
      final.resources.notifications.filter(
        ({ aggregateId }) => aggregateId === period.royaltyPeriodId,
      ).length,
      1,
      "one close Notification",
    );
    ctx.equal(
      final.events.filter(
        ({ aggregateId }) => aggregateId === period.royaltyPeriodId,
      ).length,
      1,
      "one close Event",
    );
    return caseResult(ctx, {
      royaltyPeriodId: period.royaltyPeriodId,
      killedAttempt: recovery.entry.json.attempt,
    });
  },
);

const c06 = defineCase(
  "C-06",
  "CRE-F-DISPUTE obsolete upload and authority Work",
  "Abort an OPEN upload, activate an Edition Hold, then run old and new Workers across lease deadlines",
  "Obsolete Work terminalizes or safely no-ops, no Blob or License publishes after the authority fences and no immortal backlog remains",
  ["Upload abort", "Manager Hold", "Workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dispute();
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const uploadFamily = ctx.fixtures.upload("c06-upload", {
      profileIds: [family.profiles[0].profileId],
    });
    const uploaded = await uploadAll(ctx, api.baseUrl, uploadFamily, {
      label: "c06-upload",
    });
    await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/uploads/${uploaded.uploadSession.uploadId}/abort`,
      "c06-abort",
      {},
      { expected: 200 },
    );
    const refundResponse = await createRefund(
      ctx,
      api.baseUrl,
      family.license.licenseId,
      {
        amountMinor: 1_001,
        reason: "C06_IN_FLIGHT",
        providerRequestId: "c06-refund-provider",
      },
      "c06-refund",
    );
    const refund = resourceFrom(refundResponse.json, "refundId", "refund");
    const dispute = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.license.licenseId,
      label: "c06-dispute",
    });
    const hold = await createHoldFor(ctx, api.baseUrl, dispute.dispute, {
      scope: "EDITION",
      label: "c06-hold",
    });
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "c06-refund-success",
        providerRequestId: "c06-refund-provider",
        kind: "REFUND",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "c06-refund-success",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const relevantAggregates = new Set([
      uploaded.uploadSession.uploadId,
      family.edition.editionId,
      dispute.dispute.rightsDisputeId,
      hold.hold.licenseHoldId,
      refund.refundId,
    ]);
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) => {
        const relevant = value.work.filter(({ aggregateId }) =>
          relevantAggregates.has(aggregateId),
        );
        return relevant.length >= 3 &&
          relevant.every(({ terminal }) => terminal) &&
          value.resources.refunds.find(
            ({ refundId, state }) =>
              refundId === refund.refundId && state === "SUCCEEDED",
          )
          ? value
          : undefined;
      },
      {
        label: "obsolete Work convergence",
        timeoutMs: 180_000,
        processes: workers,
      },
    );
    ctx.equal(
      final.resources.blobObjects.length,
      before.resources.blobObjects.length,
      "aborted Upload creates no Blob",
    );
    ctx.equal(
      final.resources.uploadSessions.find(
        ({ uploadId }) => uploadId === uploaded.uploadSession.uploadId,
      ).state,
      "ABORTED",
      "abort fence preserved",
    );
    const license = final.resources.licenses.find(
      ({ licenseId }) => licenseId === family.license.licenseId,
    );
    ctx.equal(license.state, "HELD", "Edition Hold fences License authority");
    const denied = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(denied.json.allowed, false, "Hold fence prevents stale allow", {
      hardCapIds: ["STALE_WORK_FENCING", "LICENSE_AUTHORITY_ATOMICITY"],
    });
    return caseResult(ctx, {
      uploadId: uploaded.uploadSession.uploadId,
      rightsDisputeId: dispute.dispute.rightsDisputeId,
      refundId: refund.refundId,
    });
  },
);

const c07 = defineCase(
  "C-07",
  "CRE-F-NOTIFICATION unknown webhook acknowledgement",
  "Let the receiver persist a request then disconnect, hold Dispatcher after response, SIGKILL it, return 500 once and let a replacement ACK",
  "Retry preserves stable event identity and byte-identical body, loses no Notification, deduplicates receipts and contains no sensitive payload",
  [
    "webhook receiver",
    "dispatcher.response-received barrier",
    "SIGKILL",
    "replacement Dispatcher",
  ],
  async (ctx) => {
    const family = ctx.fixtures.notification(3);
    let call = 0;
    const receiver = await ctx.receiver({
      behavior: () => {
        call += 1;
        return call === 1
          ? { disconnect: true }
          : call === 2
            ? { status: 500 }
            : { status: 204 };
      },
    });
    const { api } = await prepare(ctx, family);
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point }) => armed && point === "dispatcher.response-received",
    });
    const first = await ctx.startDispatcher({
      webhookUrl: receiver.url,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const entry = await barrier.waitFor(
      ({ json }) => json.point === "dispatcher.response-received",
      { timeoutMs: 120_000, processes: [first] },
    );
    await ctx.kill(first);
    armed = false;
    await ctx.sleep(3_300);
    const second = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.deliveries.filter(({ state }) => state === "DELIVERED")
          .length === family.deliveries.length
          ? value
          : undefined,
      { label: "delivery recovery", timeoutMs: 180_000, processes: [second] },
    );
    ctx.assert(
      "stable retry identity/body",
      () => assertRetryIdentity(receiver.ledger),
      { hardCapIds: ["EVENT_NOTIFICATION_DELIVERY"] },
    );
    ctx.equal(
      new Set(
        final.resources.deliveries.map(({ notificationId }) => notificationId),
      ).size,
      family.notifications.length,
      "no delivery loss",
    );
    ctx.ok(
      receiver.ledger.every(
        ({ raw }) =>
          !raw.includes(ctx.adminToken) && !raw.includes(ctx.managedDataRoot),
      ),
      "no sensitive payload",
    );
    return caseResult(ctx, {
      killedDeliveryWorkId: entry.json.workId,
      receiverAttempts: receiver.ledger.length,
    });
  },
);

const c08 = defineCase(
  "C-08",
  "CRE-F-PURCHASE two aggregate transactional events",
  "Create two Licenses concurrently, dispatch with two processes, SIGKILL one at response barrier and restart while independent aggregates interleave",
  "Business facts, Events and Notifications commit together, each aggregate delivery succeeds in sequence and rollback creates no orphan Event",
  [
    "two APIs",
    "Workers",
    "two Dispatchers",
    "barrier SIGKILL",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("c08");
    const receiver = await ctx.receiver();
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const [left, right] = await Promise.all([
      createApprovedLicense(ctx, api.baseUrl, family, {
        label: "c08-left",
        buyerRef: "c08-left",
        providerRequestId: "c08-left-provider",
        providerEventId: "c08-left-event",
      }),
      createApprovedLicense(ctx, apis[1].baseUrl, family, {
        label: "c08-right",
        buyerRef: "c08-right",
        providerRequestId: "c08-right-provider",
        providerEventId: "c08-right-event",
      }),
    ]);
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point }) => armed && point === "dispatcher.response-received",
    });
    const first = await ctx.startDispatcher({
      webhookUrl: receiver.url,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const second = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const entry = await barrier.waitFor(
      ({ json }) => json.point === "dispatcher.response-received",
      { timeoutMs: 120_000, processes: [first, second] },
    );
    await ctx.kill(first);
    armed = false;
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        [left.license.licenseId, right.license.licenseId].every((licenseId) => {
          const notifications = value.resources.notifications.filter(
            ({ aggregateId }) => aggregateId === licenseId,
          );
          return (
            notifications.length > 0 &&
            notifications.every(
              ({ notificationId }) =>
                value.resources.deliveries.find(
                  (delivery) => delivery.notificationId === notificationId,
                )?.state === "DELIVERED",
            )
          );
        })
          ? value
          : undefined,
      {
        label: "aggregate delivery drain",
        timeoutMs: 180_000,
        processes: [second, replacement],
      },
    );
    ctx.assert("gapless aggregate Events", () =>
      assertAggregateSequences(state.events),
    );
    ctx.assert("stable unknown retry", () =>
      assertRetryIdentity(receiver.ledger),
    );
    for (const license of [left.license, right.license]) {
      ctx.ok(
        state.events.some(
          ({ aggregateId }) =>
            aggregateId === license.licenseId ||
            aggregateId === license.purchaseOrderId,
        ),
        `${license.licenseId} has Event`,
      );
      ctx.ok(
        state.resources.notifications.some(
          ({ aggregateId }) => aggregateId === license.licenseId,
        ),
        `${license.licenseId} has Notification`,
      );
    }
    return caseResult(ctx, {
      killedWorkId: entry.json.workId,
      aggregates: [left.license.licenseId, right.license.licenseId],
    });
  },
);

export const C_CASES = Object.freeze([c01, c02, c03, c04, c05, c06, c07, c08]);
