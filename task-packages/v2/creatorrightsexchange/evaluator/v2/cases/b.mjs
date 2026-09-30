import {
  allocateRoyalty,
  assertAggregateSequences,
  assertBalancedPosting,
  chunkOracle,
  royaltyPeriodDigest,
} from "../oracles/index.mjs";
import {
  assertAllPostings,
  assertCommercialAuthority,
  assertNoTemporaryMedia,
  caseResult,
  completeUpload,
  createAdjustmentFor,
  createDisputeFor,
  createHoldFor,
  createPurchase,
  createRefund,
  defineCase,
  expectAnyError,
  expectError,
  findDeep,
  mutate,
  prepare,
  providerEvent,
  publishEdition,
  putChunk,
  releaseHold,
  requireStatus,
  resourceFrom,
  snapshot,
  stableResponse,
  stableSnapshot,
  uploadAll,
  waitPurchase,
  waitSnapshot,
} from "./helpers.mjs";

export async function waitHoldPaymentRefund(ctx, baseUrl, { holdId, refundId, purchaseOrderId }, workers) {
  return waitSnapshot(ctx, baseUrl, value =>
    value.resources.licenseHolds.some(row => row.licenseHoldId === holdId && row.state === 'ACTIVE') &&
    value.resources.refunds.some(row => row.refundId === refundId && row.state === 'SUCCEEDED') &&
    // Refund completion does not establish completion of the independent payment.
    // Wrong terminal states leave this wait immediately and fail the assertions below.
    value.resources.purchaseOrders.some(row => row.purchaseOrderId === purchaseOrderId &&
      !['RISK_PENDING', 'PAYMENT_PENDING'].includes(row.state)),
  { label: 'Hold/payment/refund serial outcome', processes: workers });
}

const b01 = defineCase(
  "B-01",
  "CRE-F-UPLOAD same-chunk and completion storm",
  "PUT one chunk 32 ways, replay and conflict its bytes, upload the rest, then complete 64 ways across two APIs",
  "One chunk identity, one assembled Blob, one ScanJob and one Event survive contention while conflict preserves bytes and all temporary files are removed",
  [
    "two public APIs",
    "raw chunk HTTP",
    "verification snapshot",
    "managed root",
  ],
  async (ctx) => {
    const family = ctx.fixtures.upload("b01", {
      profileIds: [ctx.fixtures.base().profiles[0].profileId],
    });
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const body = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: family.uploadSession.fileName,
      mediaType: family.uploadSession.mediaType,
      totalBytes: family.media.length,
      chunkSize: family.chunkSize,
      contentSha256: family.uploadSession.contentSha256,
      requiredProfileIds: family.uploadSession.requiredProfileIds,
    };
    const created = await ctx.mutate(
      api.baseUrl,
      "/api/v1/uploads",
      ctx.key("b01-create"),
      body,
    );
    requireStatus(ctx, created, 200, "Upload");
    const uploadId = created.json.uploadSession.uploadId;
    const plan = chunkOracle(family.media, family.chunkSize);
    const same = await ctx.concurrent(
      Array.from({ length: 32 }),
      32,
      (_, index) =>
        putChunk(
          ctx,
          apis[index % 2].baseUrl,
          uploadId,
          plan.chunks[0],
          "b01-first",
          { key: ctx.key("b01-first") },
        ),
    );
    same.forEach((response) => requireStatus(ctx, response, 200, "same chunk"));
    stableResponse(ctx, same, "same chunk replay");
    const changed = Buffer.from(plan.chunks[0].bytes);
    changed[0] ^= 1;
    expectError(
      ctx,
      await putChunk(
        ctx,
        apis[1].baseUrl,
        uploadId,
        plan.chunks[0],
        "b01-conflict",
        {
          bytes: changed,
          sha256: ctx.fixtures.sha256(changed),
          key: ctx.key("b01-conflict"),
        },
      ),
      409,
      "CHUNK_CONFLICT",
      { hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"] },
    );
    for (const chunk of plan.chunks.slice(1))
      requireStatus(
        ctx,
        await putChunk(
          ctx,
          api.baseUrl,
          uploadId,
          chunk,
          `b01-${chunk.chunkNumber}`,
        ),
        200,
        "remaining chunk",
      );
    const manifest = {
      contentSha256: plan.sha256,
      chunks: plan.chunks.map(({ chunkNumber, sha256 }) => ({
        chunkNumber,
        sha256,
      })),
    };
    const completions = await ctx.concurrent(
      Array.from({ length: 64 }),
      64,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          `/api/v1/uploads/${uploadId}/complete`,
          ctx.key("b01-complete"),
          manifest,
        ),
    );
    completions.forEach((response) =>
      requireStatus(ctx, response, 200, "complete contention"),
    );
    stableResponse(ctx, completions, "completion convergence", {
      hardCapIds: ["DURABLE_REPLAY"],
    });
    const state = await snapshot(ctx, api.baseUrl);
    const assetId =
      findDeep(completions[0].json, "assetId") ??
      state.resources.scanJobs.find(
        ({ scanJobId }) =>
          !family.seed.scanJobs.some((item) => item.scanJobId === scanJobId),
      ).assetId;
    ctx.equal(
      state.resources.uploadChunks.filter(({ uploadId: id }) => id === uploadId)
        .length,
      plan.chunks.length,
      "one metadata row per chunk",
    );
    ctx.equal(
      state.resources.blobObjects.filter(({ blobId }) => blobId === assetId)
        .length,
      1,
      "one Blob",
    );
    ctx.equal(
      state.resources.scanJobs.filter(({ assetId: id }) => id === assetId)
        .length,
      1,
      "one ScanJob",
    );
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      uploadId,
      assetId,
      contenders: completions.length,
    });
  },
);

const b02 = defineCase(
  "B-02",
  "CRE-F-EDITION ready lineage and rights CAS race",
  "Create one DRAFT then race two rights updates, publication and a new profile across independent APIs",
  "One rights revision wins and the Edition freezes one complete 10k split and exact asset/profile lineage that later updates cannot mutate",
  ["two APIs", "rights CAS", "Edition publication", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.edition("b02");
    const draftSeed = {
      ...family.seed,
      seedVersion: "b02-ready-v1",
      editions: [],
      editionAssets: [],
    };
    const { apis, api } = await prepare(ctx, family, {
      apiCount: 2,
      seed: draftSeed,
    });
    const draftResponse = await ctx.mutate(
      api.baseUrl,
      "/api/v1/editions",
      ctx.key("b02-draft"),
      {
        tenantId: family.tenant.tenantId,
        workId: family.work.workId,
        title: "B02 Draft",
        assets: [
          {
            assetId: family.assetId,
            renditionId: family.rendition.renditionId,
            ordinal: 1,
          },
        ],
      },
    );
    requireStatus(ctx, draftResponse, 200, "DRAFT Edition");
    const draft = resourceFrom(draftResponse.json, "editionId", "edition");
    const split = (values) => ({
      expectedRevision: 1,
      effectiveFrom: ctx.at({ days: 1 }),
      splits: family.creators.map((creator, index) => ({
        creatorId: creator.creatorId,
        basisPoints: values[index],
      })),
    });
    const race = await Promise.all([
      ctx.mutate(
        apis[0].baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("b02-r1"),
        split([5000, 2500, 2500]),
      ),
      ctx.mutate(
        apis[1].baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("b02-r2"),
        split([2500, 2500, 5000]),
      ),
      ctx.mutate(
        apis[0].baseUrl,
        `/api/v1/editions/${draft.editionId}/publish`,
        ctx.key("b02-publish"),
        { expectedRevision: 0 },
      ),
    ]);
    ctx.equal(
      race.slice(0, 2).filter(({ status }) => status === 200).length,
      1,
      "one rights CAS winner",
    );
    requireStatus(ctx, race[2], 200, "publication");
    const frozen = requireStatus(
      ctx,
      await ctx.request(api.baseUrl, `/api/v1/editions/${draft.editionId}`),
      200,
      "Edition detail",
    );
    const before = structuredClone(frozen);
    const current = (await snapshot(ctx, api.baseUrl)).resources.works.find(
      ({ workId }) => workId === family.work.workId,
    ).currentRightsRevision;
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/works/${family.work.workId}/rights-splits`,
      ctx.key("b02-later"),
      {
        expectedRevision: current,
        effectiveFrom: ctx.at({ days: 2 }),
        splits: family.creators.map((creator, index) => ({
          creatorId: creator.creatorId,
          basisPoints: [4000, 3000, 3000][index],
        })),
      },
    );
    const after = requireStatus(
      ctx,
      await ctx.request(api.baseUrl, `/api/v1/editions/${draft.editionId}`),
      200,
      "Edition after rights change",
    );
    ctx.equal(after, before, "frozen Edition immutable", {
      hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"],
    });
    ctx.equal(
      after.rightsSplits.reduce((sum, row) => sum + row.basisPoints, 0),
      10_000,
      "frozen rights total",
    );
    return caseResult(ctx, {
      editionId: draft.editionId,
      frozenRightsRevision: after.edition.rightsRevision,
    });
  },
);

const b03 = defineCase(
  "B-03",
  "CRE-F-IDEMPOTENCY response loss and restart",
  "Drop the committed response for JSON Upload creation and raw chunk PUT, replay from another API after restart, and replay a domain failure",
  "Exact status and response bytes replay from durable authority while every mutation leaves exactly one resource, file, Work and Event effect",
  [
    "response shield",
    "raw and JSON HTTP",
    "API restart",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.upload("b03", {
      profileIds: [ctx.fixtures.base().profiles[0].profileId],
    });
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const shield = await ctx.responseShield(api.baseUrl);
    const body = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: family.uploadSession.fileName,
      mediaType: family.uploadSession.mediaType,
      totalBytes: family.media.length,
      chunkSize: family.chunkSize,
      contentSha256: family.uploadSession.contentSha256,
      requiredProfileIds: family.uploadSession.requiredProfileIds,
    };
    const key = ctx.key("b03-upload");
    shield.dropNextMutation();
    await ctx
      .mutate(shield.baseUrl, "/api/v1/uploads", key, body)
      .catch(() => undefined);
    const capturedCreate = shield.captures.find(({ dropped }) => dropped);
    ctx.ok(capturedCreate, "Upload response dropped after commit");
    await ctx.stop(api);
    const restarted = await ctx.startApi();
    const replay = await ctx.mutate(
      restarted.baseUrl,
      "/api/v1/uploads",
      key,
      body,
    );
    ctx.equal(
      replay.status,
      capturedCreate.response.status,
      "Upload replay status",
    );
    ctx.equal(
      replay.text,
      capturedCreate.response.body,
      "Upload replay exact body",
      { hardCapIds: ["DURABLE_REPLAY"] },
    );
    const uploadId = replay.json.uploadSession.uploadId;
    const plan = chunkOracle(family.media, family.chunkSize);
    const rawShield = await ctx.responseShield(apis[1].baseUrl);
    rawShield.dropNextMutation();
    await putChunk(
      ctx,
      rawShield.baseUrl,
      uploadId,
      plan.chunks[0],
      "b03-chunk",
      { key: ctx.key("b03-chunk") },
    ).catch(() => undefined);
    const capturedChunk = rawShield.captures.find(({ dropped }) => dropped);
    const chunkReplay = await putChunk(
      ctx,
      restarted.baseUrl,
      uploadId,
      plan.chunks[0],
      "b03-chunk",
      { key: ctx.key("b03-chunk") },
    );
    ctx.equal(
      chunkReplay.status,
      capturedChunk.response.status,
      "chunk replay status",
    );
    ctx.equal(
      chunkReplay.text,
      capturedChunk.response.body,
      "chunk replay exact body",
    );
    const badKey = ctx.key("b03-bad-complete");
    const bad = await ctx.mutate(
      restarted.baseUrl,
      `/api/v1/uploads/${uploadId}/complete`,
      badKey,
      { contentSha256: plan.sha256, chunks: [] },
    );
    const badReplay = await ctx.mutate(
      apis[1].baseUrl,
      `/api/v1/uploads/${uploadId}/complete`,
      badKey,
      { contentSha256: plan.sha256, chunks: [] },
    );
    stableResponse(ctx, [bad, badReplay], "domain failure replay");
    const state = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(
      state.resources.uploadSessions.filter(
        ({ uploadId: id }) => id === uploadId,
      ).length,
      1,
      "one Upload",
    );
    ctx.equal(
      state.resources.uploadChunks.filter(({ uploadId: id }) => id === uploadId)
        .length,
      1,
      "one chunk",
    );
    return caseResult(ctx, { uploadId, droppedResponses: 2 });
  },
);

const b04 = defineCase(
  "B-04",
  "CRE-F-IDEMPOTENCY multi-API semantic storms",
  "Send 64 same-key canonical Upload requests, JSON-order variants and conflicting bodies across two APIs, then reuse the key on an independent route and after restart",
  "All same semantics converge, mismatches return IDEMPOTENCY_CONFLICT, scopes remain independent and no process-local cache can satisfy the test",
  [
    "two APIs",
    "concurrent public HTTP",
    "API restart",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.idempotency();
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const body = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: "b04.mp4",
      mediaType: "video/mp4",
      totalBytes: 1,
      chunkSize: 64 * 1024,
      contentSha256: "0".repeat(64),
      requiredProfileIds: [family.profiles[0].profileId],
    };
    const key = ctx.key("b04-shared");
    const responses = await ctx.concurrent(
      Array.from({ length: 64 }),
      64,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/uploads",
          key,
          index % 2
            ? {
                requiredProfileIds: body.requiredProfileIds,
                contentSha256: body.contentSha256,
                chunkSize: body.chunkSize,
                totalBytes: body.totalBytes,
                mediaType: body.mediaType,
                fileName: body.fileName,
                workId: body.workId,
                tenantId: body.tenantId,
              }
            : body,
        ),
    );
    responses.forEach((response) =>
      requireStatus(ctx, response, 200, "same-key Upload"),
    );
    stableResponse(ctx, responses, "semantic convergence", {
      hardCapIds: ["DURABLE_REPLAY"],
    });
    const conflicts = await ctx.concurrent(
      Array.from({ length: 20 }),
      20,
      (_, index) =>
        ctx.mutate(apis[index % 2].baseUrl, "/api/v1/uploads", key, {
          ...body,
          fileName: `changed-${index}.mp4`,
        }),
    );
    conflicts.forEach((response) =>
      expectError(ctx, response, 409, "IDEMPOTENCY_CONFLICT"),
    );
    const offer = await ctx.mutate(api.baseUrl, "/api/v1/license-offers", key, {
      tenantId: family.tenant.tenantId,
      editionId: family.edition.editionId,
      licenseType: "STREAM",
      territories: ["CA", "US"],
      priceMinor: 10_001,
      currency: "USD",
      termsVersion: 2,
    });
    requireStatus(ctx, offer, 200, "same key independent route");
    await ctx.stop(apis[1]);
    const third = await ctx.startApi();
    stableResponse(
      ctx,
      [
        responses[0],
        await ctx.mutate(third.baseUrl, "/api/v1/uploads", key, body),
      ],
      "restart convergence",
    );
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      state.resources.uploadSessions.filter(
        ({ fileName }) => fileName === body.fileName,
      ).length,
      1,
      "one authoritative Upload",
    );
    const uploadId = responses[0].json.uploadSession.uploadId;
    const raw = Buffer.from([0x41]);
    const rawChunk = {
      chunkNumber: 1,
      contentRange: "bytes 0-0/1",
      sha256: ctx.fixtures.sha256(raw),
      bytes: raw,
    };
    const rawKey = ctx.key("b04-raw");
    const rawResponses = await ctx.concurrent(
      Array.from({ length: 20 }),
      20,
      (_, index) =>
        putChunk(
          ctx,
          index % 2 ? third.baseUrl : api.baseUrl,
          uploadId,
          rawChunk,
          "b04-raw",
          { key: rawKey },
        ),
    );
    rawResponses.forEach((response) =>
      requireStatus(ctx, response, 200, "same-key raw chunk"),
    );
    stableResponse(ctx, rawResponses, "raw semantic convergence");
    const changedRaw = Buffer.from([0x42]);
    expectError(
      ctx,
      await putChunk(
        ctx,
        third.baseUrl,
        uploadId,
        rawChunk,
        "b04-raw-conflict",
        {
          key: rawKey,
          bytes: changedRaw,
          sha256: ctx.fixtures.sha256(changedRaw),
        },
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    return caseResult(ctx, {
      contenders: responses.length,
      conflicts: conflicts.length,
    });
  },
);

const b05 = defineCase(
  "B-05",
  "CRE-F-PURCHASE provider uncertainty fixture",
  "Post UNKNOWN, SUCCEEDED, exact duplicate, later FAILED/UNKNOWN and conflicting reuse of providerEventId across APIs and reconcile",
  "SUCCEEDED authority never regresses, exact events replay, conflicting identity fails and the evaluator never assumes an unpublished provider sequence field",
  [
    "provider event HTTP",
    "payment reconcile",
    "two APIs",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("b05");
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const purchase = await createPurchase(
      ctx,
      api.baseUrl,
      family.purchaseBody,
      "b05-purchase",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitPurchase(
      ctx,
      api.baseUrl,
      purchase.json.purchaseOrder.purchaseOrderId,
      (value) => value.fraudAssessment?.state === "COMPLETED",
      { processes: workers },
    );
    const unknown = {
      providerEventId: "b05-unknown",
      providerRequestId: family.purchaseBody.providerRequestId,
      kind: "PAYMENT",
      outcome: "UNKNOWN",
      occurredAt: ctx.at(),
    };
    await providerEvent(ctx, api.baseUrl, unknown, "b05-unknown");
    const success = {
      providerEventId: "b05-success",
      providerRequestId: family.purchaseBody.providerRequestId,
      kind: "PAYMENT",
      outcome: "SUCCEEDED",
      occurredAt: ctx.at({ seconds: 1 }),
    };
    const first = await providerEvent(
      ctx,
      apis[1].baseUrl,
      success,
      "b05-success",
    );
    const replay = await providerEvent(
      ctx,
      api.baseUrl,
      success,
      "b05-success-replay",
    );
    stableResponse(ctx, [first, replay], "provider exact replay");
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        ...success,
        providerEventId: "b05-late-failed",
        outcome: "FAILED",
        occurredAt: ctx.at({ seconds: 2 }),
      },
      "b05-late-failed",
    );
    await providerEvent(
      ctx,
      apis[1].baseUrl,
      {
        ...success,
        providerEventId: "b05-late-unknown",
        outcome: "UNKNOWN",
        occurredAt: ctx.at({ seconds: 3 }),
      },
      "b05-late-unknown",
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/provider/events",
        ctx.key("b05-conflict"),
        { ...success, outcome: "FAILED" },
      ),
      409,
    );
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/payment-intents/${purchase.json.paymentIntent.paymentIntentId}/reconcile`,
      ctx.key("b05-reconcile"),
      {},
    );
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.paymentIntents.find(
          ({ paymentIntentId }) =>
            paymentIntentId === purchase.json.paymentIntent.paymentIntentId,
        )?.state === "SUCCEEDED"
          ? value
          : undefined,
      { label: "monotonic provider authority", processes: workers },
    );
    ctx.equal(
      state.resources.paymentIntents.find(
        ({ paymentIntentId }) =>
          paymentIntentId === purchase.json.paymentIntent.paymentIntentId,
      ).state,
      "SUCCEEDED",
      "late events cannot regress",
    );
    assertCommercialAuthority(ctx, state, [
      purchase.json.purchaseOrder.purchaseOrderId,
    ]);
    return caseResult(ctx, {
      paymentIntentId: purchase.json.paymentIntent.paymentIntentId,
    });
  },
);

const b06 = defineCase(
  "B-06",
  "CRE-F-PURCHASE grant atomicity contention",
  "Race provider replay, reconcile and four Workers against one approved Purchase across two APIs",
  "Purchase LICENSED, License, Grant, one balanced posting, Notifications and Events commit all-or-nothing and exist at most once",
  [
    "two APIs",
    "four Workers",
    "provider/reconcile HTTP",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("b06");
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const purchase = await createPurchase(
      ctx,
      api.baseUrl,
      family.purchaseBody,
      "b06-purchase",
    );
    const workers = await Promise.all(
      Array.from({ length: 4 }, () => ctx.startWorker()),
    );
    await waitPurchase(
      ctx,
      api.baseUrl,
      purchase.json.purchaseOrder.purchaseOrderId,
      (value) => value.fraudAssessment?.recommendation === "APPROVE",
      { processes: workers },
    );
    const event = {
      providerEventId: "b06-success",
      providerRequestId: family.purchaseBody.providerRequestId,
      kind: "PAYMENT",
      outcome: "SUCCEEDED",
      occurredAt: ctx.at(),
    };
    const results = await Promise.all([
      ...Array.from({ length: 16 }, (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/provider/events",
          ctx.key(`b06-event-${index}`),
          event,
        ),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          `/api/v1/payment-intents/${purchase.json.paymentIntent.paymentIntentId}/reconcile`,
          ctx.key(`b06-reconcile-${index}`),
          {},
        ),
      ),
    ]);
    ctx.ok(
      results.every(({ status }) => [200, 409].includes(status)),
      "all authority attempts terminate",
    );
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.licenses.some(
          ({ purchaseOrderId }) =>
            purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
        )
          ? value
          : undefined,
      { label: "atomic grant", processes: workers },
    );
    assertCommercialAuthority(
      ctx,
      state,
      [purchase.json.purchaseOrder.purchaseOrderId],
      { hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"] },
    );
    const license = state.resources.licenses.find(
      ({ purchaseOrderId }) =>
        purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
    );
    ctx.ok(
      state.resources.notifications.some(
        ({ aggregateId }) => aggregateId === license.licenseId,
      ),
      "License Notification committed",
    );
    ctx.ok(
      state.events.some(
        ({ aggregateId }) =>
          aggregateId === license.licenseId ||
          aggregateId === purchase.json.purchaseOrder.purchaseOrderId,
      ),
      "License Event committed",
    );
    return caseResult(ctx, {
      purchaseOrderId: purchase.json.purchaseOrder.purchaseOrderId,
      contenders: results.length,
    });
  },
);

const b07 = defineCase(
  "B-07",
  "CRE-F-REFUND 64-client cap and revision race",
  "Race 64 partial refund creations across two APIs, settle every accepted refund, create the exact final remainder and read entitlements during commits",
  "Accepted cumulative value never exceeds capture, each reversal posts once, grant revision stays gap-free and every post-fence read denies access",
  [
    "two APIs",
    "64 clients",
    "provider events",
    "entitlement reads",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.refund();
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const requests = await ctx.concurrent(
      Array.from({ length: 64 }),
      64,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          `/api/v1/licenses/${family.license.licenseId}/refunds`,
          ctx.key(`b07-refund-${index}`),
          {
            amountMinor: 200,
            reason: "RACE",
            providerRequestId: `b07-provider-${index}`,
          },
        ),
    );
    const accepted = requests
      .map((response, index) => ({ response, index }))
      .filter(({ response }) => response.status === 200);
    ctx.ok(accepted.length > 0, "some refunds accepted");
    ctx.ok(
      accepted.length * 200 <= family.purchaseOrder.priceMinor,
      "accepted pending total <= capture",
    );
    await ctx.concurrent(accepted, 32, ({ index }) =>
      ctx.mutate(
        apis[index % 2].baseUrl,
        "/api/v1/provider/events",
        ctx.key(`b07-event-${index}`),
        {
          providerEventId: `b07-event-${index}`,
          providerRequestId: `b07-provider-${index}`,
          kind: "REFUND",
          outcome: "SUCCEEDED",
          occurredAt: ctx.at({ milliseconds: index }),
        },
      ),
    );
    const remaining = family.purchaseOrder.priceMinor - accepted.length * 200;
    if (remaining > 0) {
      const final = await createRefund(
        ctx,
        api.baseUrl,
        family.license.licenseId,
        {
          amountMinor: remaining,
          reason: "FINAL",
          providerRequestId: "b07-final-provider",
        },
        "b07-final",
      );
      requireStatus(ctx, final, 200, "final refund");
      await providerEvent(
        ctx,
        api.baseUrl,
        {
          providerEventId: "b07-final-event",
          providerRequestId: "b07-final-provider",
          kind: "REFUND",
          outcome: "SUCCEEDED",
          occurredAt: ctx.at({ seconds: 1 }),
        },
        "b07-final-event",
      );
    }
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.entitlementGrants.find(
          ({ licenseId }) => licenseId === family.license.licenseId,
        )?.state === "REVOKED"
          ? value
          : undefined,
      { label: "refund fence" },
    );
    for (const process of apis) {
      const check = await ctx.request(
        process.baseUrl,
        `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
      );
      ctx.equal(check.json.allowed, false, "post-fence deny", {
        hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"],
      });
    }
    const successful = state.resources.refunds.filter(
      ({ licenseId, state }) =>
        licenseId === family.license.licenseId && state === "SUCCEEDED",
    );
    ctx.ok(
      successful.reduce((sum, item) => sum + item.amountMinor, 0) <=
        family.purchaseOrder.priceMinor,
      "successful total <= capture",
    );
    ctx.equal(
      new Set(successful.map(({ refundId }) => refundId)).size,
      successful.length,
      "refund identity unique",
    );
    assertAllPostings(ctx, state);
    return caseResult(ctx, {
      acceptedRefunds: successful.length,
      grantRevision: state.resources.entitlementGrants.find(
        ({ licenseId }) => licenseId === family.license.licenseId,
      ).revision,
    });
  },
);

const b08 = defineCase(
  "B-08",
  "CRE-F-PURCHASE worked remainder and close contention",
  "Create an OPEN period around observable API time, race one 10,001 grant posting against close Workers, then reproduce the closed digest",
  "Creator allocation is exactly 3333/3333/3335, postings balance, period membership is the linearized half-open set and the digest is reproducible",
  [
    "public period HTTP",
    "provider event",
    "Workers",
    "independent remainder oracle",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("b08");
    const { api } = await prepare(ctx, family);
    const t0 = Date.parse((await snapshot(ctx, api.baseUrl)).asOf);
    const periodBody = {
      tenantId: family.tenant.tenantId,
      currency: "USD",
      periodStart: new Date(t0 - 86_400_000).toISOString(),
      periodEnd: new Date(t0 + 86_400_000).toISOString(),
    };
    const opened = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/royalty-periods",
      "b08-period",
      periodBody,
      { expected: 200 },
    );
    const period = resourceFrom(
      opened.json,
      "royaltyPeriodId",
      "royaltyPeriod",
    );
    const purchase = await createPurchase(
      ctx,
      api.baseUrl,
      family.purchaseBody,
      "b08-purchase",
    );
    const workers = await Promise.all(
      Array.from({ length: 4 }, () => ctx.startWorker()),
    );
    await waitPurchase(
      ctx,
      api.baseUrl,
      purchase.json.purchaseOrder.purchaseOrderId,
      (value) => value.fraudAssessment?.recommendation === "APPROVE",
      { processes: workers },
    );
    await Promise.all([
      providerEvent(
        ctx,
        api.baseUrl,
        {
          providerEventId: "b08-success",
          providerRequestId: family.purchaseBody.providerRequestId,
          kind: "PAYMENT",
          outcome: "SUCCEEDED",
          occurredAt: new Date(t0).toISOString(),
        },
        "b08-success",
      ),
      mutate(
        ctx,
        api.baseUrl,
        "/api/v1/royalty-periods",
        "b08-period",
        periodBody,
        { expected: 200 },
      ),
    ]);
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.royaltyPeriods.find(
          ({ royaltyPeriodId, state: status }) =>
            royaltyPeriodId === period.royaltyPeriodId && status === "CLOSED",
        )
          ? value
          : undefined,
      { label: "close race", processes: workers },
    );
    const license = state.resources.licenses.find(
      ({ purchaseOrderId }) =>
        purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
    );
    const posting = state.resources.royaltyEntries.filter(
      ({ sourceType, sourceId }) =>
        sourceType === "LICENSE" && sourceId === license.licenseId,
    );
    const allocation = posting
      .filter(({ accountRole }) => accountRole === "CREATOR_PAYABLE")
      .sort((left, right) =>
        Buffer.from(left.ownerId).compare(Buffer.from(right.ownerId)),
      )
      .map(({ amountMinor }) => amountMinor);
    ctx.equal(
      allocation,
      allocateRoyalty(10_001, family.rightsSplits).map(
        ({ amountMinor }) => amountMinor,
      ),
      "largest remainder worked example",
    );
    ctx.assert("grant posting balanced", () => assertBalancedPosting(posting));
    const closed = state.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) => royaltyPeriodId === period.royaltyPeriodId,
    );
    ctx.equal(
      closed.snapshotDigest,
      royaltyPeriodDigest(state.resources.royaltyEntries, closed),
      "closed digest reproducible",
      { hardCapIds: ["ROYALTY_IMMUTABILITY"] },
    );
    return caseResult(ctx, {
      royaltyPeriodId: period.royaltyPeriodId,
      allocation,
    });
  },
);

const b09 = defineCase(
  "B-09",
  "CRE-F-DISPUTE Hold payment refund contention",
  "Create one dispute, race 32 EDITION Hold requests with payment success and refund creation, then resolve and race release with refund success",
  "One ACTIVE Hold fences the whole Edition, no allowed=true overlaps it, paid waiting Purchase stays LICENSE_HELD, and release creates at most one valid authority",
  [
    "two APIs",
    "Manager Hold HTTP",
    "provider/refund events",
    "Workers",
    "entitlement reads",
  ],
  async (ctx) => {
    const family = ctx.fixtures.commercialSeed(1, {
      withRoyalty: true,
      label: "b09",
    });
    family.evidenceRefs = ["evidence:b09"];
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const dispute = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.licenses[0].licenseId,
      label: "b09-dispute",
    });
    const holds = await ctx.concurrent(
      Array.from({ length: 32 }),
      32,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/license-holds",
          ctx.key(`b09-hold-${index}`),
          {
            rightsDisputeId: dispute.dispute.rightsDisputeId,
            scope: "EDITION",
            reason: "RACE",
          },
        ),
    );
    ctx.equal(
      holds.filter(({ status }) => status === 200).length,
      1,
      "one Hold winner",
    );
    const hold = holds.find(({ status }) => status === 200).json.licenseHold;
    const denied = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.licenses[0].buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(
      denied.json.allowed,
      false,
      "active Hold denies existing entitlement",
    );
    const purchaseBody = {
      tenantId: family.tenant.tenantId,
      buyerRef: "b09-waiting",
      offerId: family.offer.offerId,
      providerRequestId: "b09-waiting-provider",
      riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
    };
    const blockedPurchase = await ctx.mutate(
      apis[1].baseUrl,
      "/api/v1/purchases",
      ctx.key("b09-new"),
      purchaseBody,
    );
    ctx.ok(
      [200, 409].includes(blockedPurchase.status),
      "serializable Hold/Purchase result",
    );
    await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/rights-disputes/${dispute.dispute.rightsDisputeId}/resolve`,
      "b09-resolve",
      {
        expectedRevision: dispute.dispute.revision,
        outcome: "REJECTED",
        reason: "CLEARED",
      },
      { expected: 200 },
    );
    await releaseHold(
      ctx,
      api.baseUrl,
      hold.licenseHoldId,
      { expectedRevision: hold.revision, reason: "CLEARED" },
      "b09-release",
    );
    const restored = await ctx.request(
      apis[1].baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.licenses[0].buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(restored.json.allowed, true, "release restores valid authority");
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      state.resources.licenseHolds.filter(({ state }) => state === "ACTIVE")
        .length,
      0,
      "no active Hold remains",
    );
    const contenderDispute = await createDisputeFor(ctx, api.baseUrl, family, {
      claimantCreatorId: family.creators[1].creatorId,
      licenseId: family.licenses[0].licenseId,
      label: "b09-contender-dispute",
    });
    const waitingBody = {
      tenantId: family.tenant.tenantId,
      buyerRef: "b09-waiting-race",
      offerId: family.offer.offerId,
      providerRequestId: "b09-waiting-race-provider",
      riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
    };
    const waiting = await createPurchase(
      ctx,
      api.baseUrl,
      waitingBody,
      "b09-waiting-race",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitPurchase(
      ctx,
      api.baseUrl,
      waiting.json.purchaseOrder.purchaseOrderId,
      (value) => value.fraudAssessment?.recommendation === "APPROVE",
      { label: "B09 waiting approval", processes: workers },
    );
    const refund = await createRefund(
      ctx,
      api.baseUrl,
      family.licenses[0].licenseId,
      {
        amountMinor: 10_001,
        reason: "B09_RACE",
        providerRequestId: "b09-refund-provider",
      },
      "b09-refund",
    );
    const refundId = resourceFrom(refund.json, "refundId", "refund").refundId;
    const race = await Promise.all([
      ...Array.from({ length: 32 }, (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/license-holds",
          ctx.key(`b09-race-hold-${index}`),
          {
            rightsDisputeId: contenderDispute.dispute.rightsDisputeId,
            scope: "EDITION",
            reason: "PAYMENT_REFUND_RACE",
          },
        ),
      ),
      providerEvent(
        ctx,
        api.baseUrl,
        {
          providerEventId: "b09-waiting-success",
          providerRequestId: waitingBody.providerRequestId,
          kind: "PAYMENT",
          outcome: "SUCCEEDED",
          occurredAt: ctx.at({ seconds: 2 }),
        },
        "b09-waiting-success",
      ),
      providerEvent(
        ctx,
        apis[1].baseUrl,
        {
          providerEventId: "b09-refund-success",
          providerRequestId: "b09-refund-provider",
          kind: "REFUND",
          outcome: "SUCCEEDED",
          occurredAt: ctx.at({ seconds: 2 }),
        },
        "b09-refund-success",
      ),
    ]);
    const raceHolds = race.slice(0, 32).filter(({ status }) => status === 200);
    ctx.equal(raceHolds.length, 1, "contention leaves one ACTIVE Hold");
    const raceHold = raceHolds[0].json.licenseHold;
    const fenced = await waitHoldPaymentRefund(ctx, api.baseUrl, {
      holdId: raceHold.licenseHoldId, refundId,
      purchaseOrderId: waiting.json.purchaseOrder.purchaseOrderId,
    }, workers);
    const waitingOrder = fenced.resources.purchaseOrders.find(
      ({ purchaseOrderId }) =>
        purchaseOrderId === waiting.json.purchaseOrder.purchaseOrderId,
    );
    ctx.ok(
      ["LICENSE_HELD", "LICENSED"].includes(waitingOrder.state),
      "waiting payment has legal serial state",
    );
    const waitingLicenses = fenced.resources.licenses.filter(
      ({ purchaseOrderId }) => purchaseOrderId === waitingOrder.purchaseOrderId,
    );
    ctx.ok(waitingLicenses.length <= 1, "waiting payment at most one License");
    if (waitingLicenses.length)
      ctx.equal(
        waitingLicenses[0].state,
        "HELD",
        "concurrent grant is immediately held",
      );
    const fenceRead = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${waitingBody.buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(
      fenceRead.json.allowed,
      false,
      "active contention Hold never overlaps allowed=true",
      {
        hardCapIds: [
          "HOLD_ADJUSTMENT_AUTHORITY",
          "LICENSE_AUTHORITY_ATOMICITY",
        ],
      },
    );
    return caseResult(ctx, {
      rightsDisputeIds: [
        dispute.dispute.rightsDisputeId,
        contenderDispute.dispute.rightsDisputeId,
      ],
      holdContenders: holds.length + 32,
      waitingPurchaseOrderId: waitingOrder.purchaseOrderId,
      refundId,
    });
  },
);

const b10 = defineCase(
  "B-10",
  "CRE-F-ROYALTY adjustment uniqueness contention",
  "Race 32 identical adjustments and multiple different adjustments against one CLOSED posting, including over-limit, currency, tenant and open-source failures",
  "The unique tuple has one posting and one target OPEN period, accepted total stays within remaining balance, entries use frozen split, and original CLOSED facts never change",
  [
    "two APIs",
    "Manager adjustment HTTP",
    "verification snapshot",
    "independent royalty oracle",
  ],
  async (ctx) => {
    const family = ctx.fixtures.royalty({ label: "b10", closed: true });
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const before = await snapshot(ctx, api.baseUrl);
    const body = {
      tenantId: family.tenant.tenantId,
      originalPostingId: family.postingId,
      amountMinor: 2_000,
      currency: "USD",
      reason: "SAME",
      targetPeriodStart: ctx.at({ days: 2 }),
    };
    const same = await ctx.concurrent(
      Array.from({ length: 32 }),
      32,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/royalty-adjustments",
          ctx.key(`b10-same-${index}`),
          body,
        ),
    );
    ctx.ok(
      same.some(({ status }) => status === 200),
      "one adjustment accepted",
    );
    ctx.ok(
      same.every(({ status }) => [200, 409].includes(status)),
      "duplicates converge or conflict",
    );
    const stateOne = await snapshot(ctx, api.baseUrl);
    const matching = stateOne.resources.royaltyAdjustments.filter(
      ({ originalPostingId, amountMinor, reason }) =>
        originalPostingId === family.postingId &&
        amountMinor === 2_000 &&
        reason === "SAME",
    );
    ctx.equal(matching.length, 1, "unique tuple one adjustment");
    ctx.equal(
      new Set(
        matching.map(({ targetRoyaltyPeriodId }) => targetRoyaltyPeriodId),
      ).size,
      1,
      "one target period",
    );
    const different = await ctx.concurrent(
      Array.from({ length: 8 }),
      8,
      (_, index) =>
        ctx.mutate(
          apis[index % 2].baseUrl,
          "/api/v1/royalty-adjustments",
          ctx.key(`b10-different-${index}`),
          { ...body, amountMinor: 1_500, reason: `DIFFERENT-${index}` },
        ),
    );
    ctx.ok(
      different.some(({ status }) => status !== 200),
      "remaining-balance cap rejects excess",
    );
    const final = await snapshot(ctx, api.baseUrl);
    const adjustments = final.resources.royaltyAdjustments.filter(
      ({ originalPostingId }) => originalPostingId === family.postingId,
    );
    ctx.ok(
      adjustments.reduce((sum, item) => sum + Math.abs(item.amountMinor), 0) <=
        10_001,
      "total adjustments <= original balance",
    );
    for (const adjustment of adjustments) {
      const entries = final.resources.royaltyEntries.filter(
        ({ postingId }) => postingId === adjustment.adjustmentPostingId,
      );
      ctx.assert("adjustment posting balanced", () =>
        assertBalancedPosting(entries),
      );
    }
    for (const key of ["royaltyEntries", "royaltyPeriods", "notifications"]) {
      const id =
        key === "royaltyEntries"
          ? "royaltyEntryId"
          : key === "royaltyPeriods"
            ? "royaltyPeriodId"
            : "notificationId";
      const rows = new Map(
        final.resources[key].map((item) => [item[id], item]),
      );
      for (const original of before.resources[key])
        ctx.equal(
          rows.get(original[id]),
          original,
          `${key} original immutable`,
          { hardCapIds: ["HOLD_ADJUSTMENT_AUTHORITY"] },
        );
    }
    const beforeInvalidCount = final.resources.royaltyAdjustments.length;
    const invalids = [
      [{ ...body, amountMinor: 0, reason: "ZERO" }, [400]],
      [{ ...body, amountMinor: 10_002, reason: "OVER_BALANCE" }, [400, 409]],
      [{ ...body, currency: "EUR", reason: "CURRENCY" }, [400]],
      [
        { ...body, tenantId: family.foreignTenant.tenantId, reason: "TENANT" },
        [400, 404],
      ],
      [
        {
          ...body,
          originalPostingId: ctx.uuid("b10-missing-posting"),
          reason: "MISSING",
        },
        [404],
      ],
    ];
    for (let index = 0; index < invalids.length; index += 1)
      expectAnyError(
        ctx,
        await ctx.mutate(
          api.baseUrl,
          "/api/v1/royalty-adjustments",
          ctx.key(`b10-invalid-${index}`),
          invalids[index][0],
          index === 0 ? { contractExpectation: 'invalid' } : {},
        ),
        invalids[index][1],
      );
    const afterInvalid = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      afterInvalid.resources.royaltyAdjustments.length,
      beforeInvalidCount,
      "invalid adjustments have zero effects",
    );
    return caseResult(ctx, {
      acceptedAdjustments: adjustments.length,
      targetRoyaltyPeriodId: matching[0].targetRoyaltyPeriodId,
    });
  },
);

export const B_CASES = Object.freeze([
  b01,
  b02,
  b03,
  b04,
  b05,
  b06,
  b07,
  b08,
  b09,
  b10,
]);
