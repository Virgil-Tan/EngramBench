import {
  assertAggregateSequences,
  assertBalancedPosting,
  assertNoSensitiveData,
  assertRetryIdentity,
  chunkOracle,
  royaltyPeriodDigest,
} from "../oracles/index.mjs";
import {
  assertAllPostings,
  assertCommercialAuthority,
  assertNoTemporaryMedia,
  caseResult,
  completeUpload,
  createPurchase,
  defineCase,
  findDeep,
  listManaged,
  mutate,
  openApi,
  prepare,
  providerEvent,
  putChunk,
  requireStatus,
  requireV1Workspace,
  resourceFrom,
  snapshot,
  stableResponse,
  stableSnapshot,
  uploadAll,
  waitSnapshot,
} from "./helpers.mjs";
import { assertMeasuredWindow, closedLoop, monitorRss } from "./perf.mjs";
import { expectedMediaAsset, mediaAssetsReady, mediaClaimBarrier } from './media-work.mjs';

const e01 = defineCase(
  "E-01",
  "CRE-F-MIGRATION populated V1 media and commerce checkpoint",
  "Create the checkpoint with the real V1 workspace, cold stop it, preserve DB and managed root, then migrate FINAL twice and boot",
  "Every V1 byte, identity, value, lease attempt, sequence, CLOSED digest and saved state survives while Manager resources begin empty",
  [
    "frozen V1 workspace",
    "shared PostgreSQL/root",
    "FINAL migration",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.migration();
    const v1 = requireV1Workspace(ctx);
    await v1.migrate();
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    await openApi(ctx, v1Api.baseUrl, { final: false });
    const before = await ctx.snapshot(v1Api.baseUrl);
    const rootBefore = await listManaged(ctx);
    await ctx.stop(v1Api);
    await ctx.migrate();
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const after = await snapshot(ctx, finalApi.baseUrl);
    for (const [key, rows] of Object.entries(before.resources))
      ctx.equal(after.resources[key], rows, `V1 ${key} preserved`, {
        hardCapIds: ["MIGRATION_COMPATIBILITY"],
      });
    ctx.equal(after.work, before.work, "V1 Work preserved");
    ctx.equal(after.events, before.events, "V1 Events preserved");
    ctx.equal(await listManaged(ctx), rootBefore, "V1 managed bytes preserved");
    for (const key of ["rightsDisputes", "licenseHolds", "royaltyAdjustments"])
      ctx.equal(after.resources[key], [], `${key} initially empty`);
    return caseResult(ctx, {
      preservedResources: Object.keys(before.resources).length,
      closedDigest: family.royaltyPeriod.snapshotDigest,
    });
  },
);

const e02 = defineCase(
  "E-02",
  "CRE-F-MIGRATION saved replay and unacked Event",
  "Commit V1 upload/chunk/completion behind a response shield, preserve its success and domain-conflict bodies plus unacked Events, upgrade and replay across FINAL APIs",
  "Status, response bytes and identities are exact; old Event body and sequence are unchanged and no Manager field is injected into saved V1 responses",
  ["frozen V1 workspace", "response shield", "FINAL APIs", "Dispatcher"],
  async (ctx) => {
    const family = ctx.fixtures.migration();
    const v1 = requireV1Workspace(ctx);
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const uploadFamily = ctx.fixtures.upload("e02", {
      profileIds: [family.profiles[0].profileId],
    });
    const body = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: uploadFamily.uploadSession.fileName,
      mediaType: uploadFamily.uploadSession.mediaType,
      totalBytes: uploadFamily.media.length,
      chunkSize: uploadFamily.chunkSize,
      contentSha256: uploadFamily.uploadSession.contentSha256,
      requiredProfileIds: uploadFamily.uploadSession.requiredProfileIds,
    };
    const key = family.savedReplayKey;
    const shield = await ctx.responseShield(v1Api.baseUrl);
    shield.dropNextMutation();
    await ctx
      .mutate(shield.baseUrl, "/api/v1/uploads", key, body)
      .catch(() => undefined);
    const saved = shield.captures.find(({ dropped }) => dropped);
    const replayV1 = await ctx.mutate(
      v1Api.baseUrl,
      "/api/v1/uploads",
      key,
      body,
    );
    ctx.equal(replayV1.text, saved.response.body, "V1 replay bytes");
    const uploadId = replayV1.json.uploadSession.uploadId;
    const chunkPlan = chunkOracle(uploadFamily.media, uploadFamily.chunkSize);
    for (const chunk of chunkPlan.chunks)
      requireStatus(
        ctx,
        await putChunk(
          ctx,
          v1Api.baseUrl,
          uploadId,
          chunk,
          `e02-chunk-${chunk.chunkNumber}`,
        ),
        200,
        "V1 chunk",
      );
    const completion = await completeUpload(
      ctx,
      v1Api.baseUrl,
      uploadId,
      chunkPlan,
      "e02-complete",
    );
    const conflictKey = ctx.key("e02-conflict");
    const conflict = await ctx.mutate(
      v1Api.baseUrl,
      `/api/v1/uploads/${uploadId}/complete`,
      conflictKey,
      { contentSha256: chunkPlan.sha256, chunks: [] },
    );
    const before = await ctx.snapshot(v1Api.baseUrl);
    await ctx.stop(v1Api);
    await ctx.migrate();
    await ctx.migrate();
    const finalA = await ctx.startApi();
    const finalB = await ctx.startApi();
    const replayFinal = await ctx.mutate(
      finalB.baseUrl,
      "/api/v1/uploads",
      key,
      body,
    );
    ctx.equal(replayFinal.status, replayV1.status, "FINAL replay status");
    ctx.equal(replayFinal.text, replayV1.text, "FINAL replay bytes", {
      hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_REPLAY"],
    });
    ctx.ok(
      !/(?:rightsDispute|licenseHold|royaltyAdjustment)/u.test(
        replayFinal.text,
      ),
      "Manager fields do not backfill V1 replay",
    );
    const conflictFinal = await ctx.mutate(
      finalA.baseUrl,
      `/api/v1/uploads/${uploadId}/complete`,
      conflictKey,
      { contentSha256: chunkPlan.sha256, chunks: [] },
    );
    stableResponse(
      ctx,
      [conflict, conflictFinal],
      "domain conflict migration replay",
    );
    const after = await snapshot(ctx, finalA.baseUrl);
    ctx.equal(
      after.events.filter((event) =>
        before.events.some(({ eventId }) => eventId === event.eventId),
      ),
      before.events,
      "old Events unchanged",
    );
    const receiver = await ctx.receiver();
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const delivered = await waitSnapshot(
      ctx,
      finalA.baseUrl,
      (value) =>
        family.deliveries.every(({ deliveryId }) =>
          value.resources.deliveries.some(
            (item) => item.deliveryId === deliveryId && item.state === "DELIVERED",
          ),
        )
          ? value
          : undefined,
      {
        label: "migrated unacked delivery drain",
        timeoutMs: 180_000,
        processes: [dispatcher],
      },
    );
    ctx.equal(
      delivered.events.filter((event) =>
        before.events.some(({ eventId }) => eventId === event.eventId),
      ),
      before.events,
      "dispatch does not rewrite migrated Events",
    );
    ctx.assert("migrated delivery identity", () =>
      assertRetryIdentity(receiver.ledger),
    );
    return caseResult(ctx, {
      uploadId,
      completedAssetId: findDeep(completion.json, "assetId"),
      replayStatus: replayFinal.status,
    });
  },
);

const e03 = defineCase(
  "E-03",
  "CRE-F-MIGRATION pending and leased Work plus bytes",
  "Create V1 pending scan, unknown payment, close and delivery work, kill one leased claimant, upgrade in place, expire its lease and drain with FINAL replacements",
  "Safe paths, digests and attempts remain, stale token cannot commit, every flow has one final effect and no media, Work or delivery is lost or orphaned",
  [
    "frozen V1 workspace",
    "worker.claimed barrier",
    "SIGKILL",
    "FINAL replacements",
    "managed root",
  ],
  async (ctx) => {
    const family = ctx.fixtures.migration();
    const v1 = requireV1Workspace(ctx);
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const waitingBody = {
      tenantId: family.tenant.tenantId,
      buyerRef: "e03-unknown-buyer",
      offerId: family.offer.offerId,
      providerRequestId: "e03-unknown-provider",
      riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
    };
    const waitingPurchase = await createPurchase(
      ctx,
      v1Api.baseUrl,
      waitingBody,
      "e03-purchase",
    );
    const fraudWorker = await v1.startWorker();
    await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(v1Api.baseUrl);
        return value.resources.fraudAssessments.find(
          ({ purchaseOrderId, state }) =>
            purchaseOrderId ===
              waitingPurchase.json.purchaseOrder.purchaseOrderId &&
            state === "COMPLETED",
        );
      },
      {
        label: "V1 fraud assessment before migration",
        timeoutMs: 180_000,
        processes: [fraudWorker],
      },
    );
    await ctx.stop(fraudWorker);
    const uploadFamily = ctx.fixtures.upload("e03", {
      profileIds: [family.profiles[0].profileId],
    });
    const uploaded = await uploadAll(ctx, v1Api.baseUrl, uploadFamily, {
      label: "e03",
    });
    const completed = await completeUpload(
      ctx,
      v1Api.baseUrl,
      uploaded.uploadSession.uploadId,
      uploaded.plan,
      "e03-complete",
    );
    const expected = expectedMediaAsset(completed, uploaded, uploadFamily);
    const { assetId } = expected;
    const control = await mediaClaimBarrier(ctx, v1Api.baseUrl, assetId, 'TRANSCODE', { final: false });
    const { barrier } = control;
    const claimant = await v1.startWorker({
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const claimed = await control.waitForClaim([claimant], 120_000);
    await providerEvent(
      ctx,
      v1Api.baseUrl,
      {
        providerEventId: "e03-payment-unknown",
        providerRequestId: waitingBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "UNKNOWN",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "e03-payment-unknown",
    );
    const closeResponse = await mutate(
      ctx,
      v1Api.baseUrl,
      "/api/v1/royalty-periods",
      "e03-period-close",
      {
        tenantId: family.tenant.tenantId,
        currency: "USD",
        periodStart: ctx.at({ days: 2 }),
        periodEnd: ctx.at({ days: 3 }),
      },
      { expected: 200 },
    );
    const closePeriod = resourceFrom(
      closeResponse.json,
      "royaltyPeriodId",
      "royaltyPeriod",
    );
    const leased = await ctx.snapshot(v1Api.baseUrl);
    const pendingPayment = leased.resources.paymentIntents.find(
      ({ purchaseOrderId }) =>
        purchaseOrderId === waitingPurchase.json.purchaseOrder.purchaseOrderId,
    );
    ctx.equal(pendingPayment.state, "UNKNOWN", "V1 unknown payment preserved");
    ctx.ok(
      leased.work.some(
        ({ aggregateId, terminal }) =>
          aggregateId === pendingPayment.paymentIntentId && !terminal,
      ),
      "V1 payment reconcile Work pending",
    );
    ctx.ok(
      leased.work.some(
        ({ aggregateId, terminal }) =>
          aggregateId === closePeriod.royaltyPeriodId && !terminal,
      ),
      "V1 close Work pending",
    );
    const rootBefore = await listManaged(ctx);
    await ctx.kill(claimant);
    await ctx.stop(v1Api);
    control.disarm();
    await ctx.migrate();
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    await ctx.sleep(3_300);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const receiver = await ctx.receiver();
    const dispatchers = [
      await ctx.startDispatcher({ webhookUrl: receiver.url }),
      await ctx.startDispatcher({ webhookUrl: receiver.url }),
    ];
    const final = await waitSnapshot(
      ctx,
      finalApi.baseUrl,
      (value) => {
        return mediaAssetsReady(value, [expected]) &&
          value.work.find(({ workId }) => workId === claimed.json.workId)
            ?.terminal &&
          value.resources.royaltyPeriods.find(
            ({ royaltyPeriodId, state }) =>
              royaltyPeriodId === closePeriod.royaltyPeriodId &&
              state === "CLOSED",
          ) &&
          family.deliveries.every(({ deliveryId }) =>
            value.resources.deliveries.some(
              (delivery) =>
                delivery.deliveryId === deliveryId &&
                delivery.state === "DELIVERED",
            ),
          )
          ? value
          : undefined;
      },
      {
        label: "post-upgrade drain",
        timeoutMs: 300_000,
        processes: [...workers, ...dispatchers],
      },
    );
    ctx.ok(
      final.work.find(({ workId }) => workId === claimed.json.workId).attempt >
        leased.work.find(({ workId }) => workId === claimed.json.workId)
          .attempt,
      "replacement advances attempt",
    );
    ctx.equal(
      final.resources.scanResults.filter(({ assetId: id }) => id === assetId)
        .length,
      1,
      "one scan effect",
      { hardCapIds: ["MIGRATION_COMPATIBILITY", "STALE_WORK_FENCING"] },
    );
    ctx.equal(
      final.resources.renditions.filter(({ assetId: id }) => id === assetId)
        .length,
      uploadFamily.uploadSession.requiredProfileIds.length,
      "one migrated rendition per frozen profile",
    );
    const migratedPayment = final.resources.paymentIntents.find(
      ({ paymentIntentId }) =>
        paymentIntentId === pendingPayment.paymentIntentId,
    );
    ctx.equal(
      migratedPayment.state,
      "UNKNOWN",
      "replacement cannot predict payment success",
    );
    for (const item of leased.work) {
      const migrated = final.work.find(({ workId }) => workId === item.workId);
      ctx.ok(migrated, `migrated Work ${item.workId} retained`);
      ctx.ok(
        migrated.attempt >= item.attempt,
        `migrated Work ${item.workId} attempt monotonic`,
      );
    }
    const rootAfter = await listManaged(ctx);
    for (const path of rootBefore)
      ctx.ok(rootAfter.includes(path), `preserve managed path ${path}`);
    ctx.equal(
      final.resources.blobObjects.find(({ blobId }) => blobId === assetId)
        .sha256,
      uploaded.plan.sha256,
      "migrated media digest",
    );
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      assetId,
      migratedAttempt: final.work.find(
        ({ workId }) => workId === claimed.json.workId,
      ).attempt,
      paymentIntentId: pendingPayment.paymentIntentId,
      royaltyPeriodId: closePeriod.royaltyPeriodId,
    });
  },
);

const e04 = defineCase(
  "E-04",
  "CRE-F-PERF 240 two-chunk media assets",
  "Drive 240 distinct two-chunk uploads with 32 closed-loop clients and four Workers through CLEAN scan and one frozen rendition",
  "At least 20 assets/minute finish with RSS below 768 MiB, exact digests, unique Blob/Scan/Rendition and no stale lease or temporary media",
  [
    "raw public HTTP",
    "32 clients",
    "four Workers",
    "managed root",
    "verification snapshot",
  ],
  async (ctx) => {
    const spec = ctx.fixtures.performance().scenarios.multipartEditionPipeline;
    const base = ctx.fixtures.base();
    const { api } = await prepare(ctx, base);
    const workers = await Promise.all(
      Array.from({ length: spec.workers }, () => ctx.startWorker()),
    );
    const monitor = monitorRss([api, ...workers]);
    ctx.defer(() => monitor.stop());
    const startedAt = performance.now();
    const results = await ctx.concurrent(
      Array.from({ length: spec.assets }),
      spec.clients,
      async (_, index) => {
        const family = ctx.fixtures.upload(`e04-${index}`, {
          size: 128 * 1024,
          chunkSize: 64 * 1024,
          profileIds: [base.profiles[0].profileId],
        });
        const uploaded = await uploadAll(ctx, api.baseUrl, family, {
          label: `e04-${index}`,
        });
        const completion = await completeUpload(
          ctx,
          api.baseUrl,
          uploaded.uploadSession.uploadId,
          uploaded.plan,
          `e04-complete-${index}`,
        );
        return { family, uploaded, completion };
      },
    );
    const expected = results.map(({ completion, uploaded, family }) => expectedMediaAsset(completion, uploaded, family));
    const assetIds = new Set(expected.map(row => row.assetId));
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) => mediaAssetsReady(value, expected),
      { label: "240 assets READY", timeoutMs: 1_800_000, processes: workers },
    );
    const durationMs = performance.now() - startedAt;
    const maximumRss = await monitor.stop();
    const blobs = final.resources.blobObjects.filter(({ blobId }) =>
      assetIds.has(blobId),
    );
    ctx.equal(
      new Set(blobs.map(({ blobId }) => blobId)).size,
      spec.assets,
      "240 unique Blobs",
    );
    ctx.equal(
      new Set(
        final.resources.scanResults
          .filter(({ assetId }) => assetIds.has(assetId))
          .map(({ assetId }) => assetId),
      ).size,
      spec.assets,
      "240 unique ScanResults",
    );
    ctx.equal(
      new Set(
        final.resources.renditions
          .filter(({ assetId }) => assetIds.has(assetId))
          .map(
            ({ assetId, profileId, profileRevision }) =>
              `${assetId}:${profileId}:${profileRevision}`,
          ),
      ).size,
      spec.assets,
      "240 unique Renditions",
    );
    ctx.ok(
      (spec.assets * 60_000) / durationMs >= spec.minimumPerMinute,
      "asset throughput >=20/min",
    );
    ctx.ok(maximumRss < spec.maximumRssBytes, "RSS <768MiB");
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      scenario: "multipart-edition-pipeline",
      assets: spec.assets,
      durationMs,
      assetsPerMinute: (spec.assets * 60_000) / durationMs,
      maximumRss,
    });
  },
);

const e05 = defineCase(
  "E-05",
  "CRE-F-PERF 64-client checkout uncertainty",
  "Run a disjoint 10-second warm-up and 60-second 64-client measured checkout loop with fresh keys and 10% UNKNOWN/duplicate/out-of-order provider events",
  "At least 150 accepted purchases/s and p95<=500ms complete without 5xx; each measured Purchase has one intent and at most one License/Grant/posting authority",
  [
    "64 closed-loop clients",
    "two APIs",
    "provider event HTTP",
    "four Workers",
    "verification snapshot",
  ],
  async (ctx) => {
    const spec =
      ctx.fixtures.performance().scenarios.licenseCheckoutUncertainty;
    const family = ctx.fixtures.purchase("e05");
    const { apis } = await prepare(ctx, family, { apiCount: 2 });
    const workers = await Promise.all(
      Array.from({ length: 4 }, () => ctx.startWorker()),
    );
    const runWindow = (prefix, durationMs, ordinalStart) =>
      closedLoop({
        clients: spec.clients,
        durationMs,
        ordinalStart,
        operation: async ({ client, ordinal }) => {
          const baseUrl = apis[client % apis.length].baseUrl;
          const providerRequestId = `${prefix}-provider-${ordinal}`;
          const response = await ctx.mutate(
            baseUrl,
            "/api/v1/purchases",
            ctx.key(`${prefix}-purchase-${ordinal}`),
            {
              tenantId: family.tenant.tenantId,
              buyerRef: `${prefix}-buyer-${ordinal}`,
              offerId: family.offer.offerId,
              providerRequestId,
              riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
            },
          );
          if (response.status === 200) {
            const success = {
              providerEventId: `${prefix}-success-${ordinal}`,
              providerRequestId,
              kind: "PAYMENT",
              outcome: "SUCCEEDED",
              occurredAt: ctx.at({ milliseconds: ordinal }),
            };
            if (ordinal % 10 === 0) {
              const unknown = {
                ...success,
                providerEventId: `${prefix}-unknown-${ordinal}`,
                outcome: "UNKNOWN",
              };
              requireStatus(
                ctx,
                await ctx.mutate(
                  baseUrl,
                  "/api/v1/provider/events",
                  ctx.key(`${prefix}-unknown-${ordinal}`),
                  unknown,
                ),
                200,
                "measured UNKNOWN provider event",
              );
              requireStatus(
                ctx,
                await ctx.mutate(
                  baseUrl,
                  "/api/v1/provider/events",
                  ctx.key(`${prefix}-unknown-replay-${ordinal}`),
                  unknown,
                ),
                200,
                "measured UNKNOWN replay",
              );
            }
            requireStatus(
              ctx,
              await ctx.mutate(
                baseUrl,
                "/api/v1/provider/events",
                ctx.key(`${prefix}-success-${ordinal}`),
                success,
              ),
              200,
              "measured SUCCEEDED provider event",
            );
            if (ordinal % 10 === 0)
              requireStatus(
                ctx,
                await ctx.mutate(
                  baseUrl,
                  "/api/v1/provider/events",
                  ctx.key(`${prefix}-late-${ordinal}`),
                  {
                    ...success,
                    providerEventId: `${prefix}-late-${ordinal}`,
                    outcome: "FAILED",
                    occurredAt: ctx.at({
                      milliseconds: Math.max(0, ordinal - 1),
                    }),
                  },
                ),
                200,
                "measured late provider event",
              );
          }
          return response;
        },
        accept: (response) =>
          response?.status === 200 &&
          response.json?.purchaseOrder &&
          response.json?.paymentIntent,
      });
    const warm = await runWindow("e05-warm", spec.warmupMs, 0);
    assertMeasuredWindow(ctx, warm, spec.warmupMs, "checkout warm-up");
    const measured = await runWindow(
      "e05-measured",
      spec.measureMs,
      warm.nextOrdinal,
    );
    assertMeasuredWindow(ctx, measured, spec.measureMs, "checkout measurement");
    ctx.ok(
      measured.throughput >= spec.minimumThroughput,
      "accepted purchases >=150/s",
    );
    ctx.ok(measured.latency.p95 <= spec.maximumP95Ms, "purchase p95 <=500ms");
    const ids = measured.accepted.map(
      ({ value }) => value.json.purchaseOrder.purchaseOrderId,
    );
    const final = await waitSnapshot(
      ctx,
      apis[0].baseUrl,
      (value) =>
        ids.every((id) =>
          value.resources.fraudAssessments.some(
            ({ purchaseOrderId, state }) =>
              purchaseOrderId === id && state === "COMPLETED",
          ),
        )
          ? value
          : undefined,
      {
        label: "measured checkout convergence",
        timeoutMs: 900_000,
        processes: workers,
      },
    );
    assertCommercialAuthority(ctx, final, ids, {
      hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"],
    });
    return caseResult(ctx, {
      scenario: "license-checkout-uncertainty",
      accepted: measured.accepted.length,
      throughput: measured.throughput,
      p95Ms: measured.latency.p95,
      statusCounts: measured.statusCounts,
    });
  },
);

const e06 = defineCase(
  "E-06",
  "CRE-F-PERF 1000 fraud reviews",
  "Create 1000 REVIEW purchases, let four Workers freeze fraud results, then use 64 reviewers to claim and decide every case",
  "At least 20 decisions/s complete with one immutable decision, no premature payment, lease bypass or frozen-rules drift",
  [
    "1000 public Purchases",
    "four Workers",
    "64 reviewers",
    "verification snapshot",
  ],
  async (ctx) => {
    const spec = ctx.fixtures.performance().scenarios.fraudReviewRelease;
    const family = ctx.fixtures.purchase("e06");
    const { api } = await prepare(ctx, family);
    const purchases = await ctx.concurrent(
      Array.from({ length: spec.purchases }),
      64,
      (_, index) =>
        ctx.mutate(
          api.baseUrl,
          "/api/v1/purchases",
          ctx.key(`e06-purchase-${index}`),
          {
            tenantId: family.tenant.tenantId,
            buyerRef: `e06-buyer-${index}`,
            offerId: family.offer.offerId,
            providerRequestId: `e06-provider-${index}`,
            riskContext: { velocity: 50, country: "US", deviceTrust: "KNOWN" },
          },
        ),
    );
    ctx.ok(
      purchases.every(({ status }) => status === 200),
      "1000 REVIEW purchases accepted",
    );
    const purchaseIds = purchases.map(
      ({ json }) => json.purchaseOrder.purchaseOrderId,
    );
    const workers = await Promise.all(
      Array.from({ length: spec.workers }, () => ctx.startWorker()),
    );
    const ready = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.reviewCases.filter(
          ({ purchaseOrderId, state }) =>
            purchaseIds.includes(purchaseOrderId) && state === "OPEN",
        ).length === spec.purchases
          ? value
          : undefined,
      {
        label: "1000 ReviewCases OPEN",
        timeoutMs: 900_000,
        processes: workers,
      },
    );
    const cases = ready.resources.reviewCases.filter(({ purchaseOrderId }) =>
      purchaseIds.includes(purchaseOrderId),
    );
    const startedAt = performance.now();
    const decisions = await ctx.concurrent(
      cases,
      spec.reviewers,
      async (review, index) => {
        const reviewerId = `e06-reviewer-${index % spec.reviewers}`;
        const claim = await ctx.mutate(
          api.baseUrl,
          `/api/v1/review-cases/${review.reviewCaseId}/claim`,
          ctx.key(`e06-claim-${index}`),
          { reviewerId, leaseSeconds: 60 },
        );
        requireStatus(ctx, claim, 200, "review claim");
        const leaseToken = findDeep(claim.json, "leaseToken");
        return ctx.mutate(
          api.baseUrl,
          `/api/v1/review-cases/${review.reviewCaseId}/decisions`,
          ctx.key(`e06-decision-${index}`),
          {
            reviewerId,
            leaseToken,
            outcome: "APPROVE",
            reasonCode: "BULK_VERIFIED",
          },
        );
      },
    );
    const durationMs = performance.now() - startedAt;
    ctx.ok(
      decisions.every(({ status }) => status === 200),
      "all decisions accepted",
    );
    ctx.ok(
      spec.purchases / (durationMs / 1_000) >= spec.minimumThroughput,
      "decisions >=20/s",
    );
    const final = await snapshot(ctx, api.baseUrl);
    const decided = final.resources.reviewCases.filter(({ purchaseOrderId }) =>
      purchaseIds.includes(purchaseOrderId),
    );
    ctx.ok(
      decided.every(
        ({ state, revision }) => state === "DECIDED" && revision === 1,
      ),
      "one immutable decision each",
    );
    ctx.equal(
      final.resources.licenses.filter(({ purchaseOrderId }) =>
        purchaseIds.includes(purchaseOrderId),
      ).length,
      0,
      "no premature License before payment",
    );
    ctx.ok(
      final.resources.fraudAssessments
        .filter(({ purchaseOrderId }) => purchaseIds.includes(purchaseOrderId))
        .every(
          ({ rulesVersion, score, recommendation }) =>
            rulesVersion === 1 && score === 300 && recommendation === "REVIEW",
        ),
      "frozen fraud rules",
    );
    return caseResult(ctx, {
      scenario: "fraud-review-release",
      decisions: decisions.length,
      decisionsPerSecond: spec.purchases / (durationMs / 1_000),
    });
  },
);

const e07 = defineCase(
  "E-07",
  "CRE-F-PERF 20000 active grants",
  "Seed 20,000 active grants, run 128 closed-loop clients for disjoint 10-second warm-up and 60-second measurement across two APIs while committing revocations",
  "At least 2000 checks/s and p95<=80ms complete; every request started after a committed fence denies access and grant revisions stay gap-free",
  [
    "20k public seed",
    "two APIs",
    "128 clients",
    "refund/provider fences",
    "verification snapshot",
  ],
  async (ctx) => {
    const spec = ctx.fixtures.performance().scenarios.entitlementReadStorm;
    const family = ctx.fixtures.commercialSeed(spec.grants, {
      withRoyalty: true,
      label: "e07",
    });
    const { apis } = await prepare(ctx, family, {
      apiCount: spec.apiProcesses,
    });
    const workers = await Promise.all(
      Array.from({ length: 4 }, () => ctx.startWorker()),
    );
    const checkWindow = (durationMs, start) =>
      closedLoop({
        clients: spec.clients,
        durationMs,
        ordinalStart: start,
        operation: async ({ client, ordinal }) => {
          const license = family.licenses[ordinal % family.licenses.length];
          const response = await ctx.request(
            apis[client % apis.length].baseUrl,
            `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${encodeURIComponent(license.buyerRef)}&editionId=${family.edition.editionId}`,
          );
          return { ...response, checkedBuyerRef: license.buyerRef };
        },
        accept: (response) =>
          response?.status === 200 &&
          typeof response.json?.allowed === "boolean",
      });
    const warm = await checkWindow(spec.warmupMs, 0);
    assertMeasuredWindow(ctx, warm, spec.warmupMs, "entitlement warm-up");
    const revoked = family.licenses.slice(0, 128);
    let fenceAt = Infinity;
    const revocation = (async () => {
      await ctx.sleep(5_000);
      await ctx.concurrent(revoked, 64, async (license, index) => {
        const providerRequestId = `e07-refund-${index}`;
        const refund = await ctx.mutate(
          apis[index % apis.length].baseUrl,
          `/api/v1/licenses/${license.licenseId}/refunds`,
          ctx.key(`e07-refund-${index}`),
          { amountMinor: 10_001, reason: "PERF_FENCE", providerRequestId },
        );
        requireStatus(ctx, refund, 200, "perf refund");
        await ctx.mutate(
          apis[(index + 1) % apis.length].baseUrl,
          "/api/v1/provider/events",
          ctx.key(`e07-event-${index}`),
          {
            providerEventId: `e07-event-${index}`,
            providerRequestId,
            kind: "REFUND",
            outcome: "SUCCEEDED",
            occurredAt: ctx.at({ milliseconds: index }),
          },
        );
      });
      fenceAt = performance.now();
    })();
    const measuredPromise = checkWindow(spec.measureMs, warm.nextOrdinal);
    const [measured] = await Promise.all([measuredPromise, revocation]);
    assertMeasuredWindow(
      ctx,
      measured,
      spec.measureMs,
      "entitlement measurement",
    );
    ctx.ok(measured.throughput >= spec.minimumThroughput, "checks >=2000/s");
    ctx.ok(measured.latency.p95 <= spec.maximumP95Ms, "check p95 <=80ms");
    const revokedBuyers = new Set(revoked.map(({ buyerRef }) => buyerRef));
    const falseAllows = measured.records.filter(
      ({ requestStartedAt, value }) =>
        requestStartedAt >= fenceAt &&
        value?.json?.allowed === true &&
        revokedBuyers.has(value.checkedBuyerRef),
    );
    ctx.equal(falseAllows.length, 0, "no post-fence false allow");
    for (let index = 0; index < revoked.length; index += 1) {
      const license = revoked[index];
      const response = await ctx.request(
        apis[index % apis.length].baseUrl,
        `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${encodeURIComponent(license.buyerRef)}&editionId=${family.edition.editionId}`,
      );
      ctx.equal(response.json.allowed, false, "explicit post-fence deny", {
        hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"],
      });
    }
    const final = await snapshot(ctx, apis[0].baseUrl);
    ctx.ok(
      final.resources.entitlementGrants
        .filter(({ licenseId }) =>
          revoked.some((license) => license.licenseId === licenseId),
        )
        .every(({ state, revision }) => state === "REVOKED" && revision === 2),
      "revoked grants revision 2",
    );
    return caseResult(ctx, {
      scenario: "entitlement-read-storm",
      checks: measured.accepted.length,
      throughput: measured.throughput,
      p95Ms: measured.latency.p95,
      revoked: revoked.length,
    });
  },
);

const e08 = defineCase(
  "E-08",
  "CRE-F-PERF 100000 balanced royalty entries",
  "Seed exactly 100,000 entries, start four Workers, SIGKILL the first close claimant after worker.claimed and require replacement close within 60 seconds",
  "Every entry and posting remains balanced and linked, exactly one close and reproducible digest commit, and stale claimant cannot overwrite",
  [
    "100k public seed",
    "four Workers",
    "worker.claimed barrier",
    "SIGKILL",
    "verification snapshot",
  ],
  async (ctx) => {
    const spec = ctx.fixtures.performance().scenarios.royaltyLedgerClose;
    const family = ctx.fixtures.commercialSeed(spec.entries / 4, {
      withRoyalty: true,
      label: "e08",
    });
    ctx.equal(
      family.royaltyEntries.length,
      spec.entries,
      "exact 100k entries fixture",
    );
    const { api } = await prepare(ctx, family);
    const close = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/royalty-periods",
      "e08-close",
      {
        tenantId: family.tenant.tenantId,
        currency: "USD",
        periodStart: family.royaltyPeriod.periodStart,
        periodEnd: family.royaltyPeriod.periodEnd,
      },
      { expected: 200 },
    );
    const period = resourceFrom(close.json, "royaltyPeriodId", "royaltyPeriod");
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point, aggregateId }) =>
        armed &&
        point === "worker.claimed" &&
        aggregateId === period.royaltyPeriodId,
    });
    const first = await ctx.startWorker({
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const entry = await barrier.waitFor(
      ({ json }) =>
        json.point === "worker.claimed" &&
        json.aggregateId === period.royaltyPeriodId,
      { timeoutMs: 120_000, processes: [first] },
    );
    const startedAt = performance.now();
    const replacements = await Promise.all(
      Array.from({ length: spec.workers - 1 }, () => ctx.startWorker()),
    );
    await ctx.kill(first);
    armed = false;
    await ctx.sleep(3_300);
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.royaltyPeriods.find(
          ({ royaltyPeriodId, state }) =>
            royaltyPeriodId === period.royaltyPeriodId && state === "CLOSED",
        )
          ? value
          : undefined,
      {
        label: "100k close replacement",
        timeoutMs: spec.deadlineMs,
        processes: replacements,
      },
    );
    const durationMs = performance.now() - startedAt;
    ctx.ok(durationMs <= spec.deadlineMs, "close <=60s");
    const closed = final.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) => royaltyPeriodId === period.royaltyPeriodId,
    );
    const entries = final.resources.royaltyEntries.filter(
      ({ royaltyPeriodId }) => royaltyPeriodId === period.royaltyPeriodId,
    );
    ctx.equal(entries.length, spec.entries, "all 100k entries preserved");
    assertAllPostings(ctx, final, { hardCapIds: ["ROYALTY_IMMUTABILITY"] });
    ctx.equal(
      closed.snapshotDigest,
      royaltyPeriodDigest(final.resources.royaltyEntries, closed),
      "100k digest exact",
    );
    const closeWork = final.work.filter(
      ({ aggregateId }) => aggregateId === period.royaltyPeriodId,
    );
    ctx.equal(closeWork.length, 1, "one close Work authority");
    ctx.equal(closeWork[0].terminal, true, "close Work terminal");
    ctx.assert("period Events remain gapless", () =>
      assertAggregateSequences(
        final.events.filter(
          ({ aggregateId }) => aggregateId === period.royaltyPeriodId,
        ),
      ),
    );
    return caseResult(ctx, {
      scenario: "royalty-ledger-close",
      entries: entries.length,
      durationMs,
      killedAttempt: entry.json.attempt,
    });
  },
);

const e09 = defineCase(
  "E-09",
  "CRE-F-PERF 10000 pending Notifications",
  "Start two Dispatchers, make one ACK unknown, SIGKILL that Dispatcher at response barrier and let the other drain all 10,000 within 45 seconds",
  "All 10,000 logical IDs deliver, aggregate sequence has no gap, retries preserve raw body and event ID, and payloads contain no sensitive data",
  [
    "10k public seed",
    "two Dispatchers",
    "webhook receiver",
    "dispatcher.response-received barrier",
    "SIGKILL",
  ],
  async (ctx) => {
    const spec = ctx.fixtures.performance().scenarios.notificationRecovery;
    const family = ctx.fixtures.notificationSeed(spec.notifications);
    let firstAck = true;
    const receiver = await ctx.receiver({
      behavior: () => {
        if (firstAck) {
          firstAck = false;
          return { disconnect: true };
        }
        return { status: 204 };
      },
    });
    const { api } = await prepare(ctx, family);
    let armed = true;
    const barrier = await ctx.barrier({
      hold: ({ point }) => armed && point === "dispatcher.response-received",
    });
    const startedAt = performance.now();
    const killed = await ctx.startDispatcher({
      webhookUrl: receiver.url,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    const survivor = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const entry = await barrier.waitFor(
      ({ json }) => json.point === "dispatcher.response-received",
      { timeoutMs: 120_000, processes: [killed, survivor] },
    );
    await ctx.kill(killed);
    armed = false;
    const final = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.deliveries.filter(({ state }) => state === "DELIVERED")
          .length === spec.notifications
          ? value
          : undefined,
      {
        label: "10k notification drain",
        timeoutMs: spec.deadlineMs,
        processes: [survivor],
      },
    );
    const durationMs = performance.now() - startedAt;
    ctx.ok(durationMs <= spec.deadlineMs, "notification drain <=45s");
    const ids = receiver.ledger
      .map(({ headers }) => headers["x-event-id"])
      .filter(Boolean);
    ctx.equal(new Set(ids).size, spec.notifications, "10k unique logical IDs");
    ctx.assert(
      "retry raw identity",
      () => assertRetryIdentity(receiver.ledger),
      { hardCapIds: ["EVENT_NOTIFICATION_DELIVERY"] },
    );
    ctx.assert("notification sequence", () =>
      assertAggregateSequences(final.resources.notifications, {
        idField: "notificationId",
      }),
    );
    ctx.assert("notification redaction", () =>
      assertNoSensitiveData(receiver.ledger, [
        ctx.adminToken,
        ctx.databaseUrl,
        ctx.managedDataRoot,
      ]),
    );
    return caseResult(ctx, {
      scenario: "notification-recovery",
      notifications: spec.notifications,
      durationMs,
      killedWorkId: entry.json.workId,
    });
  },
);

const e10 = defineCase(
  "E-10",
  "CRE-F-EDITION deterministic cleanup fixture",
  "Run the same seeded non-performance lifecycle twice in isolated databases, compare evidence, stop roles and audit managed root, logs and failure exit behavior",
  "Evidence is reproducible, failures exit nonzero, no process/file/port/lock residue remains and logs expose no bytes, secrets, provider bodies, buyer, payout or absolute paths",
  [
    "public commands",
    "two isolated databases",
    "owned process cleanup",
    "managed root/log observer",
  ],
  async (ctx) => {
    const family = ctx.fixtures.edition("e10");
    const run = async () => {
      await ctx.migrate();
      await ctx.seed(family.seed);
      const api = await ctx.startApi();
      const worker = await ctx.startWorker();
      const receiver = await ctx.receiver();
      const dispatcher = await ctx.startDispatcher({
        webhookUrl: receiver.url,
      });
      const state = await snapshot(ctx, api.baseUrl);
      const paths = await listManaged(ctx);
      for (const process of [dispatcher, worker, api]) await ctx.stop(process);
      const logs = [dispatcher, worker, api].map(({ logs }) => logs).join("\n");
      return { state: stableSnapshot(state), paths, logs };
    };
    const first = await run();
    await ctx.resetDatabase();
    const second = await run();
    ctx.equal(second.state, first.state, "same seed state reproducible");
    ctx.equal(second.paths, first.paths, "same seed media reproducible");
    ctx.assert("log hygiene", () =>
      assertNoSensitiveData(`${first.logs}\n${second.logs}`, [
        ctx.adminToken,
        ctx.databaseUrl,
        ctx.managedDataRoot,
        family.license?.buyerRef,
      ]),
    );
    const failure = await ctx.seed(
      { ...family.seed, seedVersion: "e10-invalid", unknown: true },
      { allowFailure: true, contractExpectation: 'invalid' },
    );
    ctx.ok(failure.exitCode !== 0, "invalid public command exits nonzero");
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      scenario: "cleanup-reproducibility",
      managedFiles: first.paths.length,
    });
  },
);

export const E_CASES = Object.freeze([
  e01,
  e02,
  e03,
  e04,
  e05,
  e06,
  e07,
  e08,
  e09,
  e10,
]);
