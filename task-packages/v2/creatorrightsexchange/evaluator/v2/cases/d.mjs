const { observeBrowserWait } = await import(new URL("browser.mjs", process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url)));
import {
  assertAggregateSequences,
  assertBalancedPosting,
  assertNoSensitiveData,
  assertRetryIdentity,
  editionManifestDigest,
  renditionOracle,
} from "../oracles/index.mjs";
import {
  assertAllPostings,
  caseResult,
  captureJsonResponse,
  clickVisible,
  completeRefund,
  createAdjustmentFor,
  createApprovedLicense,
  createDisputeFor,
  createHoldFor,
  defineCase,
  expectAnyError,
  expectVisibleIdentity,
  fillVisible,
  findDeep,
  keyboardActivate,
  keyboardChooseFile,
  keyboardFillVisible,
  launchBrowser,
  mutate,
  openApi,
  prepare,
  providerEvent,
  publishedGate,
  releaseHold,
  requireStatus,
  snapshot,
  waitSnapshot,
} from "./helpers.mjs";

const d01 = defineCase(
  "D-01",
  "CRE-F-EMPTY independent OpenAPI traffic matrix",
  "Validate FINAL OpenAPI with the task-local schema model and drive every documented method through representative success or published error traffic",
  "Every live response validates against the independent contract and the published V2 wire clarifications with constrained schemas",
  ["production OpenAPI", "public HTTP", "independent schema oracle"],
  async (ctx) => {
    const family = ctx.fixtures.dispute();
    const { api } = await prepare(ctx, family);
    const document = await openApi(ctx, api.baseUrl);
    const requests = [
      ["GET", `/api/v1/editions/${family.edition.editionId}`],
      ["GET", `/api/v1/license-offers/${family.offer.offerId}`],
      ["GET", `/api/v1/licenses/${family.license.licenseId}`],
      [
        "GET",
        `/api/v1/royalty-periods/${family.royaltyPeriod.royaltyPeriodId}`,
      ],
      [
        "GET",
        `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
      ],
    ];
    for (const [method, path] of requests)
      requireStatus(
        ctx,
        await ctx.request(api.baseUrl, path, { method }),
        200,
        `${method} ${path}`,
      );
    const dispute = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.license.licenseId,
      label: "d01-dispute",
    });
    const detail = await ctx.request(
      api.baseUrl,
      `/api/v1/rights-disputes/${dispute.dispute.rightsDisputeId}`,
    );
    requireStatus(ctx, detail, 200, "RightsDispute detail");
    ctx.equal(
      Object.keys(detail.json).sort(),
      ["holds", "rightsDispute"],
      "Manager detail exact response",
    );
    return caseResult(ctx, {
      openapiVersion: document.openapi,
      liveRoutes: requests.length + 2,
    });
  },
);

async function profileInputValue(page, profileId) {
  const displayed = await page.getByLabel(/profile/i).first().inputValue();
  let arrayEditor = false;
  try { arrayEditor = Array.isArray(JSON.parse(displayed)); } catch {}
  return arrayEditor ? JSON.stringify([profileId]) : profileId;
}

// Repeated labels belong to the visible action's form, not the whole page.
async function actionForm(ctx, page, patterns) {
  for (const name of patterns) {
    const buttons = [];
    for (const button of await page.getByRole("button", { name }).all())
      if (await button.isVisible()) buttons.push(button);
    ctx.ok(buttons.length <= 1, `ambiguous action ${name}`);
    if (!buttons.length) continue;
    const button = buttons[0];
    const form = button.locator('xpath=ancestor::*[self::form or @role="form"][1]');
    if (await form.count()) return form;
    const container = button.locator('xpath=ancestor::*[.//input or .//textarea or .//select][1]');
    ctx.ok(await container.count(), `visible action container ${name}`);
    ctx.ok(await container.locator('form, [role="form"]').count() === 0 &&
      await container.getByRole("button").count() === 1, `ambiguous action container ${name}`);
    return container;
  }
  ctx.ok(false, `visible action not found: ${patterns.join(", ")}`);
}

async function readCommittedView(ctx, page, identity, resource = "purchase") {
  const reads = [new RegExp(`^(?:load|refresh)\\s+${resource}$`, "i")];
  if (identity && await page.getByRole("button", { name: reads[0] }).and(page.locator(":visible")).count()) {
    const form = await actionForm(ctx, page, reads);
    await fillVisible(form, [new RegExp(`${resource}.*id`, "i")], identity);
    const response = await captureJsonResponse(page,
      (url, value) => url.pathname === `/api/v1/${resource}s/${identity}` && value.request().method() === "GET",
      () => clickVisible(form, reads));
    ctx.equal(response.status, 200, `browser ${resource} read accepted`);
    return;
  }
  const refresh = page.getByRole("button", { name: /^(?:(?:refresh|load)\b.*\bsnapshot|refresh)$/i }).and(page.locator(":visible"));
  if (await refresh.count()) {
    ctx.equal(await refresh.count(), 1, "unambiguous snapshot read");
    const token = page.getByLabel(/admin[_ -]*token/i).and(page.locator(":visible"));
    if (await token.count()) await token.first().fill(ctx.adminToken);
    const response = await captureJsonResponse(page,
      (url, value) => url.pathname === "/api/v1/verification-snapshot" && value.request().method() === "GET",
      () => refresh.click());
    ctx.equal(response.status, 200, "browser snapshot read accepted");
  }
  // Automatically loaded views continue through the same visible assertions.
}

async function expectVisibleEmptyEditions(page) {
  const resource = page.getByRole("combobox", { name: /^resource view$/i }).and(page.locator("select:visible"));
  if (await resource.count() && await resource.first().locator('option[value="editions"]').count())
    await resource.first().selectOption("editions");
  await page.waitForFunction(() => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
    for (const element of document.querySelectorAll('pre, output, [role="status"]')) {
      if (!visible(element)) continue;
      try {
        const value = JSON.parse(element.innerText);
        if (value?.counts?.editions === 0 || value?.editions === 0 ||
          Array.isArray(value?.editions) && value.editions.length === 0 ||
          Array.isArray(value?.resources?.editions) && value.resources.editions.length === 0 ||
          value?.resource === "editions" && value.total === 0 && Array.isArray(value.items) && value.items.length === 0) return true;
      } catch {}
    }
    for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      if (!visible(heading) || !/^editions$/i.test(heading.innerText.trim())) continue;
      const result = heading.nextElementSibling;
      if (result && visible(result) && /^(?:no (?:records|editions)(?: yet)?|empty|nothing(?: yet)?)[.!]?$/i.test(result.innerText.trim())) return true;
    }
    return false;
  });
}

const d02 = defineCase(
  "D-02",
  "CRE-F-BROWSER production upload and Edition flow",
  "Use visible production controls to select real bytes, create/resume/complete the upload, observe scan/transcode, create and publish an Edition, then refresh",
  "Concrete upload, asset, rendition and Edition identities remain visible and match snapshot digests and frozen manifest after refresh",
  [
    "production Chromium",
    "visible controls",
    "real API/Workers",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.upload("d02", {
      profileIds: [ctx.fixtures.base().profiles[0].profileId],
    });
    const { api } = await prepare(ctx, family);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const { page } = await launchBrowser(ctx, api);
    const file = page.locator('input[type="file"]:visible').first();
    ctx.ok(await file.count(), "visible media file control");
    await file.setInputFiles({
      name: family.uploadSession.fileName,
      mimeType: family.uploadSession.mediaType,
      buffer: family.media,
    });
    await fillVisible(page, [/tenant/i], family.tenant.tenantId);
    await fillVisible(page, [/work/i], family.work.workId);
    await fillVisible(page, [/chunk.*size/i], family.chunkSize);
    await fillVisible(page, [/profile/i], await profileInputValue(page, family.profiles[0].profileId));
    const uploadPromise = observeBrowserWait(page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/uploads" &&
        response.request().method() === "POST",
    ));
    const completionPromise = observeBrowserWait(page.waitForResponse(
      (response) =>
        /\/api\/v1\/uploads\/[^/]+\/complete$/u.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "POST",
      { timeout: 180_000 },
    ));
    await clickVisible(page, [
      /create.*upload/i,
      /start.*upload/i,
      /^upload\b/i,
    ]);
    const uploadNetwork = await uploadPromise;
    ctx.equal(uploadNetwork.status(), 200, "browser Upload accepted");
    const uploadJson = await uploadNetwork.json();
    const uploadId = findDeep(uploadJson, "uploadId");
    await expectVisibleIdentity(page, uploadId);
    const completion = await completionPromise;
    ctx.equal(completion.status(), 200, "browser Upload completed");
    const completedJson = await completion.json();
    const initial = await snapshot(ctx, api.baseUrl);
    const assetId =
      findDeep(completedJson, "assetId") ??
      initial.resources.scanJobs.find(
        ({ scanJobId }) =>
          !family.seed.scanJobs.some((item) => item.scanJobId === scanJobId),
      )?.assetId;
    ctx.ok(assetId, "browser completion exposes discoverable asset identity");
    const ready = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.blobObjects.find(({ blobId }) => blobId === assetId)
          ?.state === "READY"
          ? value
          : undefined,
      { label: "browser asset READY", processes: workers },
    );
    const rendition = ready.resources.renditions.find(
      ({ assetId: id }) => id === assetId,
    );
    await page.reload({ waitUntil: "networkidle" });
    await expectVisibleIdentity(page, assetId);
    await expectVisibleIdentity(page, rendition.renditionId);
    await fillVisible(
      page,
      [/edition.*title/i, /^title$/i],
      "D02 Published Edition",
    );
    await fillVisible(page, [/asset.*id/i], assetId);
    await fillVisible(page, [/rendition.*id/i], rendition.renditionId);
    const editionResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/editions" &&
        response.request().method() === "POST",
      () => clickVisible(page, [/create.*edition/i]),
    );
    const editionId = findDeep(editionResponse.json, "editionId");
    await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === `/api/v1/editions/${editionId}/publish` &&
        response.request().method() === "POST",
      () => clickVisible(page, [/publish/i]),
    );
    await page.reload({ waitUntil: "networkidle" });
    await expectVisibleIdentity(page, editionId);
    const final = await snapshot(ctx, api.baseUrl);
    const edition = final.resources.editions.find(
      ({ editionId: id }) => id === editionId,
    );
    ctx.equal(edition.state, "PUBLISHED", "browser Edition published");
    const editionAssets = final.resources.editionAssets.filter(
      ({ editionId: id }) => id === editionId,
    );
    ctx.equal(editionAssets.length, 1, "browser Edition freezes one asset");
    ctx.equal(
      editionAssets[0].assetSha256,
      family.uploadSession.contentSha256,
      "browser bytes lineage",
    );
    const expectedRendition = renditionOracle(
      family.media,
      family.profiles[0],
    );
    ctx.equal(
      {
        sha256: rendition.sha256,
        sizeBytes: rendition.sizeBytes,
      },
      {
        sha256: expectedRendition.sha256,
        sizeBytes: expectedRendition.sizeBytes,
      },
      "browser rendition bytes oracle",
    );
    ctx.equal(
      edition.manifestDigest,
      editionManifestDigest({
        rightsRevision: edition.rightsRevision,
        assets: editionAssets,
      }),
      "browser frozen manifest oracle",
    );
    return caseResult(ctx, {
      uploadId,
      assetId,
      renditionId: rendition.renditionId,
      editionId,
    });
  },
);

const d03 = defineCase(
  "D-03",
  "CRE-F-BROWSER checkout and refund flow",
  "Use visible controls to checkout, observe fraud/payment UNKNOWN, grant a License, then request partial and full refunds and refresh in a second browser",
  "Async identities and states are concrete, retry creates no duplicate fact, full fence denies access and both browsers render committed server state",
  [
    "production Chromium",
    "public provider boundary",
    "Workers",
    "two browser contexts",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.purchase("d03");
    const { api } = await prepare(ctx, family);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const first = await launchBrowser(ctx, api);
    const purchaseActions = [/checkout/i, /create.*purchase/i, /^purchase$/i];
    const purchaseForm = await actionForm(ctx, first.page, purchaseActions);
    await fillVisible(purchaseForm, [/tenant/i], family.tenant.tenantId);
    await fillVisible(purchaseForm, [/offer/i], family.offer.offerId);
    await fillVisible(purchaseForm, [/buyer/i], "d03-buyer");
    await fillVisible(purchaseForm, [/provider.*request/i], "d03-provider");
    if (await purchaseForm.getByLabel(/risk.*context/i).count()) {
      await fillVisible(purchaseForm, [/risk.*context/i], JSON.stringify({ velocity: 1, country: "US", deviceTrust: "KNOWN" }));
    } else {
      await fillVisible(purchaseForm, [/velocity/i], 1);
      await fillVisible(purchaseForm, [/country/i], "US");
      await fillVisible(purchaseForm, [/device.*trust/i], "KNOWN");
    }
    if (await purchaseForm.getByLabel(/idempotency.*key/i).count())
      await fillVisible(purchaseForm, [/idempotency.*key/i], ctx.key("d03-checkout"));
    const purchaseResponse = await captureJsonResponse(
      first.page,
      (url, response) =>
        url.pathname === "/api/v1/purchases" &&
        response.request().method() === "POST",
      () => clickVisible(purchaseForm, purchaseActions),
    );
    ctx.equal(purchaseResponse.status, 200, "browser checkout accepted");
    const purchaseOrderId = findDeep(purchaseResponse.json, "purchaseOrderId");
    await expectVisibleIdentity(first.page, purchaseOrderId);
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "d03-unknown",
        providerRequestId: "d03-provider",
        kind: "PAYMENT",
        outcome: "UNKNOWN",
        occurredAt: ctx.at(),
      },
      "d03-unknown",
    );
    await first.page.reload({ waitUntil: "networkidle" });
    await readCommittedView(ctx, first.page, purchaseOrderId);
    await first.page
      .getByText(/unknown|pending/i)
      .first()
      .waitFor({ state: "visible" });
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "d03-success",
        providerRequestId: "d03-provider",
        kind: "PAYMENT",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "d03-success",
    );
    const granted = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.licenses.find(
          ({ purchaseOrderId: id }) => id === purchaseOrderId,
        )
          ? value
          : undefined,
      { label: "browser checkout grant", processes: workers },
    );
    const license = granted.resources.licenses.find(
      ({ purchaseOrderId: id }) => id === purchaseOrderId,
    );
    await first.page.reload({ waitUntil: "networkidle" });
    await readCommittedView(ctx, first.page, license.licenseId, "license");
    await expectVisibleIdentity(first.page, license.licenseId);
    const submitRefund = async ({ amountMinor, providerRequestId, label }) => {
      const refundActions = [/request.*refund/i, /create.*refund/i, /^refund$/i];
      const refundForm = await actionForm(ctx, first.page, refundActions);
      await fillVisible(refundForm, [/license.*id/i], license.licenseId);
      await fillVisible(
        refundForm,
        [/refund.*amount/i, /^amount/i],
        amountMinor,
      );
      await fillVisible(
        refundForm,
        [/refund.*reason/i, /^reason/i],
        label.toUpperCase(),
      );
      await fillVisible(
        refundForm,
        [/refund.*provider/i, /provider.*request/i],
        providerRequestId,
      );
      if (await refundForm.getByLabel(/idempotency.*key/i).count())
        await fillVisible(refundForm, [/idempotency.*key/i], ctx.key(label));
      const response = await captureJsonResponse(
        first.page,
        (url, candidate) =>
          url.pathname === `/api/v1/licenses/${license.licenseId}/refunds` &&
          candidate.request().method() === "POST",
        () => clickVisible(refundForm, refundActions),
      );
      ctx.equal(response.status, 200, `${label} refund accepted`);
      const refundId = findDeep(response.json, "refundId");
      await providerEvent(
        ctx,
        api.baseUrl,
        {
          providerEventId: `${label}-success`,
          providerRequestId,
          kind: "REFUND",
          outcome: "SUCCEEDED",
          occurredAt: ctx.at({ seconds: label === "d03-partial" ? 2 : 3 }),
        },
        `${label}-success`,
      );
      return refundId;
    };
    const partialRefundId = await submitRefund({
      amountMinor: 4_000,
      providerRequestId: "d03-partial-provider",
      label: "d03-partial",
    });
    await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.refunds.find(
          ({ refundId, state }) =>
            refundId === partialRefundId && state === "SUCCEEDED",
        )
          ? value
          : undefined,
      { label: "partial refund", processes: workers },
    );
    const partialEntitlement = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=d03-buyer&editionId=${family.edition.editionId}`,
    );
    ctx.equal(
      partialEntitlement.json.allowed,
      true,
      "partial refund preserves entitlement",
    );
    const fullRefundId = await submitRefund({
      amountMinor: 6_001,
      providerRequestId: "d03-full-provider",
      label: "d03-full",
    });
    await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.entitlementGrants.find(
          ({ licenseId }) => licenseId === license.licenseId,
        )?.state === "REVOKED"
          ? value
          : undefined,
      { label: "browser refund fence", processes: workers },
    );
    const second = await launchBrowser(ctx, api);
    for (const page of [first.page, second.page]) {
      await page.reload({ waitUntil: "networkidle" });
      await readCommittedView(ctx, page);
      for (const identity of [partialRefundId, fullRefundId])
        await expectVisibleIdentity(page, identity);
      await page
        .getByText(/revoked|denied|false/i)
        .first()
        .waitFor({ state: "visible" });
    }
    return caseResult(ctx, {
      purchaseOrderId,
      licenseId: license.licenseId,
      refundIds: [partialRefundId, fullRefundId],
    });
  },
);

const d04 = defineCase(
  "D-04",
  "CRE-F-BROWSER FINAL dispute Hold adjustment flow",
  "Use visible controls to create and resolve a dispute, activate/release both Hold scopes, observe entitlement and create an adjustment with no target OPEN period",
  "Concrete dispute, Hold, target period, adjustment and posting identities remain visible while original CLOSED facts stay unchanged and scope effects match the backend",
  ["production Chromium", "Manager public APIs", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.browser();
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const { page } = await launchBrowser(ctx, api);
    const responseIdentity = (response, field, label) => {
      requireStatus(ctx, response, 200, label);
      const identity = findDeep(response.json, field);
      ctx.ok(typeof identity === "string" && identity.length > 0, `${label} returns ${field}`);
      return identity;
    };
    const disputeActions = [/create.*dispute/i, /open.*dispute/i];
    const disputeForm = await actionForm(ctx, page, disputeActions);
    await fillVisible(disputeForm, [/tenant.*id/i], family.tenant.tenantId);
    await fillVisible(disputeForm, [/edition.*id/i], family.edition.editionId);
    await fillVisible(
      disputeForm,
      [/claimant.*creator/i, /creator.*id/i],
      family.creators[0].creatorId,
    );
    await fillVisible(
      disputeForm,
      [/expected.*edition.*revision/i],
      family.edition.revision,
    );
    await fillVisible(disputeForm, [/license.*id/i], family.license.licenseId);
    await fillVisible(
      disputeForm,
      [/dispute.*reason/i, /^reason/i],
      "OWNERSHIP_CONFLICT",
    );
    const evidence = disputeForm.getByLabel(/evidence/i).first();
    const displayedEvidence = await evidence.inputValue();
    let arrayEditor = false;
    try { arrayEditor = Array.isArray(JSON.parse(displayedEvidence)); } catch {}
    await fillVisible(disputeForm, [/evidence/i], arrayEditor ? JSON.stringify(["evidence:d04"]) : "evidence:d04");
    const disputeResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/rights-disputes" &&
        response.request().method() === "POST",
      () => clickVisible(disputeForm, disputeActions),
    );
    const disputeId = responseIdentity(disputeResponse, "rightsDisputeId", "Create dispute");
    await expectVisibleIdentity(page, disputeId);
    const activateHold = async ({ scope, licenseId, label }) => {
      const actions = [/activate.*hold/i, /create.*hold/i];
      const form = await actionForm(ctx, page, actions);
      await fillVisible(form, [/dispute.*id/i], disputeId);
      await fillVisible(form, [/hold.*scope/i, /^scope$/i], scope);
      if (licenseId || await form.getByLabel(/license.*id/i).count())
        await fillVisible(form, [/hold.*license/i, /license.*id/i], licenseId ?? "");
      await fillVisible(form, [/hold.*reason/i, /^reason$/i], label.toUpperCase());
      const response = await captureJsonResponse(
        page,
        (url, candidate) =>
          url.pathname === "/api/v1/license-holds" &&
          candidate.request().method() === "POST",
        () => clickVisible(form, actions),
      );
      return responseIdentity(response, "licenseHoldId", `${scope} Hold accepted`);
    };
    const licenseHoldId = await activateHold({
      scope: "LICENSE",
      licenseId: family.license.licenseId,
      label: "d04-license",
    });
    await expectVisibleIdentity(page, licenseHoldId);
    const licenseDenied = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(licenseDenied.json.allowed, false, "LICENSE Hold backend fence");
    const editionHoldId = await activateHold({
      scope: "EDITION",
      label: "d04-edition",
    });
    await expectVisibleIdentity(page, editionHoldId);
    const resolveForm = await actionForm(ctx, page, [/resolve.*dispute/i, /resolve/i]);
    await fillVisible(resolveForm, [/dispute.*id/i], disputeId);
    await fillVisible(resolveForm, [/expected.*revision/i], 1);
    await fillVisible(resolveForm, [/resolution.*reason/i, /^reason$/i], "CLEARED");
    await fillVisible(resolveForm, [/outcome/i], "REJECTED");
    const resolutionResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === `/api/v1/rights-disputes/${disputeId}/resolve` &&
        response.request().method() === "POST",
      () => clickVisible(resolveForm, [/resolve/i]),
    );
    requireStatus(ctx, resolutionResponse, 200, "Resolve dispute");
    for (const holdId of [licenseHoldId, editionHoldId]) {
      const releaseForm = await actionForm(ctx, page, [/release.*hold/i]);
      await fillVisible(releaseForm, [/hold.*id/i], holdId);
      await fillVisible(
        releaseForm,
        [/hold.*expected.*revision/i, /expected.*hold.*revision/i, /^expected.*revision$/i],
        1,
      );
      await fillVisible(releaseForm, [/release.*reason/i, /^reason$/i], "CLEARED");
      const releaseResponse = await captureJsonResponse(
        page,
        (url, response) =>
          url.pathname === `/api/v1/license-holds/${holdId}/release` &&
          response.request().method() === "POST",
        () => clickVisible(releaseForm, [/release.*hold/i]),
      );
      requireStatus(ctx, releaseResponse, 200, "Release Hold");
    }
    const adjustmentActions = [/create.*adjustment/i, /post.*adjustment/i];
    const adjustmentForm = await actionForm(ctx, page, adjustmentActions);
    await fillVisible(
      adjustmentForm,
      [/adjustment.*tenant/i, /tenant.*id/i],
      family.tenant.tenantId,
    );
    await fillVisible(adjustmentForm, [/original.*posting/i], family.postingId);
    await fillVisible(adjustmentForm, [/adjustment.*amount/i, /^amount/i], 3_335);
    await fillVisible(adjustmentForm, [/currency/i], "USD");
    await fillVisible(adjustmentForm, [/target.*period.*start/i], ctx.at({ days: 2 }));
    await fillVisible(adjustmentForm, [/adjustment.*reason/i, /^reason$/i], "RIGHTS_CORRECTION");
    const adjustmentResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/royalty-adjustments" &&
        response.request().method() === "POST",
      () => clickVisible(adjustmentForm, adjustmentActions),
    );
    const adjustmentId = responseIdentity(adjustmentResponse, "royaltyAdjustmentId", "Create adjustment");
    await page.reload({ waitUntil: "networkidle" });
    for (const identity of [
      disputeId,
      licenseHoldId,
      editionHoldId,
      adjustmentId,
    ])
      await expectVisibleIdentity(page, identity);
    const after = await snapshot(ctx, api.baseUrl);
    for (const entry of before.resources.royaltyEntries)
      ctx.equal(
        after.resources.royaltyEntries.find(
          ({ royaltyEntryId }) => royaltyEntryId === entry.royaltyEntryId,
        ),
        entry,
        "original entry unchanged",
      );
    ctx.equal(
      after.resources.royaltyPeriods.find(
        ({ royaltyPeriodId }) =>
          royaltyPeriodId === family.royaltyPeriod.royaltyPeriodId,
      ),
      family.royaltyPeriod,
      "original CLOSED period unchanged",
    );
    const adjustment = after.resources.royaltyAdjustments.find(
      ({ royaltyAdjustmentId }) => royaltyAdjustmentId === adjustmentId,
    );
    const target = after.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) =>
        royaltyPeriodId === adjustment.targetRoyaltyPeriodId,
    );
    ctx.equal(target.state, "OPEN", "UI adjustment target period OPEN");
    ctx.assert("UI adjustment posting balanced", () =>
      assertBalancedPosting(
        after.resources.royaltyEntries.filter(
          ({ postingId }) => postingId === adjustment.adjustmentPostingId,
        ),
      ),
    );
    return caseResult(ctx, {
      disputeId,
      holdIds: [licenseHoldId, editionHoldId],
      adjustmentId,
      targetRoyaltyPeriodId: target.royaltyPeriodId,
    });
  },
);

const d05 = defineCase(
  "D-05",
  "CRE-F-BROWSER network and authority state fixture",
  "Expose delayed loading, empty state, validation, stale conflict, offline mutation, restart and permission failures through a transparent browser network boundary",
  "Every state is visible, accessible and recoverable; retry does not duplicate mutation and no media, risk, payout, secret or path appears in DOM or logs",
  [
    "production Chromium",
    "transparent browser proxy",
    "API restart",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.base();
    const { api } = await prepare(ctx, family);
    const { page } = await launchBrowser(ctx, api);
    let injectedStatus = null;
    await page.route("**/api/v1/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        injectedStatus &&
        route.request().method() === "POST" &&
        requestUrl.pathname === "/api/v1/tenants"
      ) {
        const status = injectedStatus;
        injectedStatus = null;
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: status === 409 ? "STALE_REVISION" : "FORBIDDEN",
              message: status === 409 ? "stale revision" : "permission denied",
            },
          }),
        });
        return;
      }
      await ctx.sleep(200);
      await route.continue();
    });
    const readStarted = observeBrowserWait(page.waitForRequest((request) =>
      request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/v1/"),
    ));
    await page.reload({ waitUntil: "domcontentloaded" });
    const refresh = page.getByRole("button", { name: /^(?:(?:refresh|load)\b.*\bsnapshot|refresh)$/i }).first();
    if (await refresh.count()) {
      const token = page.getByLabel(/admin[_ -]*token/i).first();
      if (await token.count()) await token.fill(ctx.adminToken);
      await refresh.click();
    }
    await readStarted;
    await page
      .getByText(/loading|pending/i)
      .first()
      .waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");
    const live = await snapshot(ctx, api.baseUrl);
    ctx.equal(live.resources.editions.length, 0, "empty backend matches UI");
    await expectVisibleEmptyEditions(page);
    const tenantActions = [/create.*tenant/i];
    const tenantForm = await actionForm(ctx, page, tenantActions);
    await fillVisible(tenantForm, [/tenant.*name/i, /^name$/i], "");
    const validation = await tenantForm.evaluateHandle(form => {
      const fields = [];
      const capture = event => { if (event.isTrusted) fields.push(event.target); };
      form.addEventListener("invalid", capture, true);
      return { fields, close: () => form.removeEventListener("invalid", capture, true) };
    });
    let validationPosts = 0;
    const observeValidationPost = request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/tenants") validationPosts += 1;
    };
    page.on("request", observeValidationPost);
    let nativeFeedback;
    try {
      await clickVisible(tenantForm, tenantActions);
      nativeFeedback = await validation.evaluate(({ fields }) => fields.some(field =>
        field === document.activeElement && field.getClientRects().length > 0 &&
        getComputedStyle(field).visibility === "visible" && !field.validity.valid && Boolean(field.validationMessage)));
    } finally {
      page.off("request", observeValidationPost);
      await validation.evaluate(({ close }) => close());
      await validation.dispose();
    }
    if (nativeFeedback) {
      ctx.equal(validationPosts, 0, "native invalid submission makes no POST");
      ctx.equal((await snapshot(ctx, api.baseUrl)).resources.tenants.length, live.resources.tenants.length, "native invalid submission has no effect");
    } else {
      await page.getByText(/required|invalid|error/i).first().waitFor({ state: "visible" });
    }
    const before = await snapshot(ctx, api.baseUrl);
    for (const [status, label] of [
      [409, "stale conflict"],
      [403, "permission"],
    ]) {
      injectedStatus = status;
      await fillVisible(tenantForm, [/tenant.*name/i, /^name$/i], `D05 ${label}`);
      await clickVisible(tenantForm, tenantActions);
      await page
        .getByText(
          status === 409
            ? /stale|conflict|revision/i
            : /forbidden|permission|authori[sz]ation/i,
        )
        .first()
        .waitFor({ state: "visible" });
      ctx.equal(
        (await snapshot(ctx, api.baseUrl)).resources.tenants.length,
        before.resources.tenants.length,
        `${label} zero effect`,
      );
    }
    const offlineError = /offline|network(?:error)?|error|failed to fetch/i;
    const previousOfflineFeedback = await page.getByText(offlineError).allTextContents();
    const failedTenantPost = observeBrowserWait(page.waitForEvent("requestfailed", {
      predicate: request => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/tenants",
    }));
    await page.context().setOffline(true);
    await fillVisible(tenantForm, [/tenant.*name/i, /^name$/i], "D05 Tenant");
    await clickVisible(tenantForm, tenantActions);
    ctx.ok((await failedTenantPost).failure()?.errorText, "browser Tenant POST actually failed offline");
    let offlineFeedback = page.getByText(offlineError);
    for (const previous of previousOfflineFeedback)
      offlineFeedback = offlineFeedback.filter({ hasNotText: new RegExp(`^${previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    // Repeated messages remain valid in the operation's own feedback surface.
    offlineFeedback = offlineFeedback.or(tenantForm.getByText(offlineError))
      .or(page.getByRole("alert").filter({ hasText: offlineError }))
      .or(page.getByRole("status").filter({ hasText: offlineError }));
    await offlineFeedback.first().waitFor({ state: "visible" });
    await page.context().setOffline(false);
    const tenantResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/tenants" &&
        response.request().method() === "POST",
      () => clickVisible(tenantForm, [/retry/i, ...tenantActions]),
    );
    const tenantId = findDeep(tenantResponse.json, "tenantId");
    const after = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      after.resources.tenants.filter(({ tenantId: id }) => id === tenantId)
        .length,
      1,
      "offline retry one mutation",
    );
    ctx.equal(
      after.resources.tenants.length,
      before.resources.tenants.length + 1,
      "only retried Tenant created",
    );
    await ctx.stop(api);
    await page
      .reload({ waitUntil: "domcontentloaded", timeout: 5_000 })
      .catch(() => undefined);
    const restarted = await ctx.startApi({ port: api.port });
    await page.goto(restarted.baseUrl, { waitUntil: "networkidle" });
    await readCommittedView(ctx, page);
    const resourceView = page.getByRole("combobox", { name: /^resource view$/i }).and(page.locator("select:visible"));
    if (await resourceView.count() && await resourceView.first().locator('option[value="tenants"]').count())
      await resourceView.first().selectOption("tenants");
    await expectVisibleIdentity(page, tenantId);
    const dom = await page.locator("body").innerText();
    ctx.assert("DOM and role-log redaction", () =>
      assertNoSensitiveData({ dom, logs: `${api.logs}\n${restarted.logs}` }, [
        ctx.adminToken,
        ctx.databaseUrl,
        ctx.managedDataRoot,
      ]),
    );
    return caseResult(ctx, {
      tenantId,
      recoveredStates: [
        "loading",
        "empty",
        "validation",
        "stale",
        "offline",
        "permission",
        "restart",
      ],
    });
  },
);

const d06 = defineCase(
  "D-06",
  "CRE-F-BROWSER keyboard primary-flow fixture",
  "Use only focus and keyboard activation on visible labeled controls for upload, Edition, checkout, refund and Hold primary actions",
  "Every published primary action is reachable with visible labels, pending/success/error feedback and recoverable focus at the execution viewport",
  ["production Chromium", "keyboard events", "visible labeled controls"],
  async (ctx) => {
    const family = ctx.fixtures.browser();
    const { api } = await prepare(ctx, family);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const { page } = await launchBrowser(ctx, api, {
      viewport: { width: 390, height: 844 },
    });
    const controls = page.locator(
      "button:visible, input:visible, select:visible, textarea:visible, a[href]:visible",
    );
    ctx.ok(
      (await controls.count()) >= 5,
      "primary UI exposes focusable controls",
    );
    for (const input of await page
      .locator(
        'input:visible:not([type="hidden"]), select:visible, textarea:visible',
      )
      .all()) {
      const labelled = await input.and(page.getByLabel(/\S/u)).count();
      ctx.ok(Boolean(labelled), "visible control has accessible label");
    }
    const uploadFamily = ctx.fixtures.upload("d06-keyboard", {
      profileIds: [family.profiles[0].profileId],
    });
    await keyboardChooseFile(page, {
      name: uploadFamily.uploadSession.fileName,
      mimeType: uploadFamily.uploadSession.mediaType,
      buffer: uploadFamily.media,
    });
    await keyboardFillVisible(page, [/tenant.*id/i], family.tenant.tenantId);
    await keyboardFillVisible(page, [/work.*id/i], family.work.workId);
    await keyboardFillVisible(page, [/chunk.*size/i], uploadFamily.chunkSize);
    await keyboardFillVisible(page, [/profile/i], await profileInputValue(page, family.profiles[0].profileId));
    const uploadPromise = observeBrowserWait(page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/uploads" &&
        response.request().method() === "POST",
    ));
    const completePromise = observeBrowserWait(page.waitForResponse(
      (response) =>
        /\/api\/v1\/uploads\/[^/]+\/complete$/u.test(
          new URL(response.url()).pathname,
        ) && response.request().method() === "POST",
      { timeout: 180_000 },
    ));
    await keyboardActivate(page, [
      /create.*upload/i,
      /start.*upload/i,
      /^upload\b/i,
    ]);
    const uploadResponse = await uploadPromise;
    ctx.equal(uploadResponse.status(), 200, "keyboard Upload accepted");
    const uploadId = findDeep(await uploadResponse.json(), "uploadId");
    const completed = await completePromise;
    ctx.equal(completed.status(), 200, "keyboard Upload completed");
    const completedBody = await completed.json();
    const uploadedState = await snapshot(ctx, api.baseUrl);
    const assetId =
      findDeep(completedBody, "assetId") ??
      uploadedState.resources.scanJobs.at(-1).assetId;
    const ready = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.blobObjects.find(({ blobId }) => blobId === assetId)
          ?.state === "READY"
          ? value
          : undefined,
      { label: "keyboard asset READY", processes: workers },
    );
    const rendition = ready.resources.renditions.find(
      ({ assetId: id }) => id === assetId,
    );
    await page.reload({ waitUntil: "networkidle" });
    await keyboardFillVisible(
      page,
      [/edition.*title/i, /^title$/i],
      "D06 Keyboard Edition",
    );
    await keyboardFillVisible(page, [/asset.*id/i], assetId);
    await keyboardFillVisible(page, [/rendition.*id/i], rendition.renditionId);
    const editionResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/editions" &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/create.*edition/i]),
    );
    const editionId = findDeep(editionResponse.json, "editionId");
    await keyboardFillVisible(page, [/edition.*id/i], editionId);
    await keyboardFillVisible(page, [/expected.*revision/i], 0);
    await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === `/api/v1/editions/${editionId}/publish` &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/publish/i]),
    );
    await keyboardFillVisible(page, [/tenant.*id/i], family.tenant.tenantId);
    await keyboardFillVisible(page, [/offer.*id/i], family.offer.offerId);
    await keyboardFillVisible(page, [/buyer/i], "d06-buyer");
    await keyboardFillVisible(page, [/provider.*request/i], "d06-provider");
    await keyboardFillVisible(page, [/velocity/i], 50);
    await keyboardFillVisible(page, [/country/i], "US");
    await keyboardFillVisible(page, [/device.*trust/i], "KNOWN");
    const checkout = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/purchases" &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/checkout/i, /purchase/i]),
    );
    const purchaseOrderId = findDeep(checkout.json, "purchaseOrderId");
    const reviewState = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.reviewCases.find(
          ({ purchaseOrderId: id, state }) =>
            id === purchaseOrderId && state === "OPEN",
        )
          ? value
          : undefined,
      { label: "keyboard review OPEN", processes: workers },
    );
    const review = reviewState.resources.reviewCases.find(
      ({ purchaseOrderId: id }) => id === purchaseOrderId,
    );
    await keyboardFillVisible(page, [/review.*case.*id/i], review.reviewCaseId);
    await keyboardFillVisible(page, [/reviewer.*id/i], "d06-reviewer");
    await keyboardFillVisible(page, [/lease.*seconds/i], 30);
    const claim = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === `/api/v1/review-cases/${review.reviewCaseId}/claim` &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/claim.*review/i, /^claim$/i]),
    );
    const leaseToken = findDeep(claim.json, "leaseToken");
    await keyboardFillVisible(page, [/lease.*token/i], leaseToken);
    await keyboardFillVisible(
      page,
      [/review.*outcome/i, /^outcome$/i],
      "APPROVE",
    );
    await keyboardFillVisible(page, [/reason.*code/i], "KEYBOARD_VERIFIED");
    await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname ===
          `/api/v1/review-cases/${review.reviewCaseId}/decisions` &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/decide/i, /submit.*review/i]),
    );
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "d06-payment-success",
        providerRequestId: "d06-provider",
        kind: "PAYMENT",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "d06-payment-success",
    );
    const licensed = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.licenses.find(
          ({ purchaseOrderId: id }) => id === purchaseOrderId,
        )
          ? value
          : undefined,
      { label: "keyboard License", processes: workers },
    );
    const license = licensed.resources.licenses.find(
      ({ purchaseOrderId: id }) => id === purchaseOrderId,
    );
    const dispute = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.license.licenseId,
      label: "d06-dispute",
    });
    await keyboardFillVisible(
      page,
      [/dispute.*id/i],
      dispute.dispute.rightsDisputeId,
    );
    await keyboardFillVisible(page, [/hold.*scope/i, /^scope$/i], "LICENSE");
    await keyboardFillVisible(
      page,
      [/hold.*license/i, /license.*id/i],
      family.license.licenseId,
    );
    await keyboardFillVisible(page, [/hold.*reason/i], "KEYBOARD_TEST");
    const holdResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === "/api/v1/license-holds" &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/activate.*hold/i, /create.*hold/i]),
    );
    const holdId = findDeep(holdResponse.json, "licenseHoldId");
    await keyboardFillVisible(page, [/license.*id/i], license.licenseId);
    await keyboardFillVisible(page, [/refund.*amount/i, /^amount/i], 10_001);
    await keyboardFillVisible(
      page,
      [/refund.*reason/i, /^reason/i],
      "KEYBOARD_FULL",
    );
    await keyboardFillVisible(
      page,
      [/refund.*provider/i, /provider.*request/i],
      "d06-refund-provider",
    );
    const refundResponse = await captureJsonResponse(
      page,
      (url, response) =>
        url.pathname === `/api/v1/licenses/${license.licenseId}/refunds` &&
        response.request().method() === "POST",
      () => keyboardActivate(page, [/request.*refund/i, /^refund$/i]),
    );
    const refundId = findDeep(refundResponse.json, "refundId");
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "d06-refund-success",
        providerRequestId: "d06-refund-provider",
        kind: "REFUND",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 2 }),
      },
      "d06-refund-success",
    );
    await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.entitlementGrants.find(
          ({ licenseId: id }) => id === license.licenseId,
        )?.state === "REVOKED"
          ? value
          : undefined,
      { label: "keyboard refund fence", processes: workers },
    );
    await page.reload({ waitUntil: "networkidle" });
    for (const identity of [
      uploadId,
      editionId,
      purchaseOrderId,
      review.reviewCaseId,
      license.licenseId,
      holdId,
      refundId,
    ])
      await expectVisibleIdentity(page, identity);
    await page.keyboard.press("Tab");
    ctx.ok(
      await page.locator(":focus").count(),
      "focus remains visible in document",
    );
    return caseResult(ctx, {
      viewport: "390x844",
      focusableControls: await controls.count(),
      uploadId,
      editionId,
      purchaseOrderId,
      holdId,
      refundId,
    });
  },
);

const d07 = defineCase(
  "D-07",
  "CRE-F-EMPTY project test dependency sensitivity",
  "Run every published project gate, observe real recovery barrier and process topology, then break PostgreSQL, Chromium and barrier seams one at a time",
  "Positive gates exercise real dependencies and each corresponding negative seam exits nonzero, preventing skipped and always-zero tests",
  [
    "public npm test commands",
    "PostgreSQL",
    "production Chromium",
    "OS process observer",
    "barrier receiver",
  ],
  async (ctx) => {
    await ctx.migrate();
    await publishedGate(ctx, "test:unit", 600_000);
    await publishedGate(ctx, "test:integration", 1_200_000);
    await publishedGate(ctx, "test:e2e", 1_200_000);
    const concurrency = await ctx.startProcess(
      "candidate-test",
      "test:concurrency",
    );
    const topology = await ctx.waitFor(
      async () => {
        const ps = await ctx.command("ps", ["-eo", "pid=,ppid=,args="], {
          allowFailure: true,
        });
        const text = ps.stdout;
        return (text.match(/start:api/gu)?.length ?? 0) >= 2 &&
          (text.match(/start:worker/gu)?.length ?? 0) >= 2
          ? text
          : undefined;
      },
      {
        label: "two API and two Worker test processes",
        timeoutMs: 120_000,
        processes: [concurrency],
      },
    );
    const [concurrencyExit] = await concurrency.exited;
    ctx.equal(concurrencyExit, 0, "test:concurrency exit");
    ctx.ok(topology.length > 0, "external process topology observed");
    const barrier = await ctx.barrier();
    const recovery = await ctx.npm("test:recovery", [], {
      timeoutMs: 1_200_000,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    });
    ctx.equal(recovery.exitCode, 0, "test:recovery exit");
    ctx.ok(
      barrier.ledger.some(({ json }) => json.point === "worker.claimed"),
      "recovery gate hits worker.claimed",
    );
    ctx.ok(
      barrier.ledger.some(
        ({ json }) => json.point === "dispatcher.response-received",
      ),
      "recovery gate hits dispatcher.response-received",
    );
    await publishedGate(ctx, "test:perf", 7_200_000);
    await publishedGate(ctx, "test:all", 10_800_000);
    const badDb = await ctx.npm("test:integration", [], {
      timeoutMs: 600_000,
      allowFailure: true,
      env: {
        TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:1/unreachable",
      },
    });
    ctx.ok(
      badDb.exitCode !== 0,
      "integration fails with unreachable PostgreSQL",
    );
    const badChromium = await ctx.npm("test:e2e", [], {
      timeoutMs: 600_000,
      allowFailure: true,
      env: { CHROMIUM_PATH: ctx.tempPath("missing-chromium") },
    });
    ctx.ok(badChromium.exitCode !== 0, "e2e fails without production Chromium");
    const badBarrier = await ctx.npm("test:recovery", [], {
      timeoutMs: 600_000,
      allowFailure: true,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "wrong-token" },
    });
    ctx.ok(
      badBarrier.exitCode !== 0,
      "recovery fails when barrier contract is unavailable",
    );
    return caseResult(ctx, {
      gates: [
        "unit",
        "integration",
        "e2e",
        "concurrency",
        "recovery",
        "perf",
        "all",
      ],
      negativeSeams: ["postgresql", "chromium", "barrier"],
    });
  },
);

const d08 = defineCase(
  "D-08",
  "CRE-F-DISPUTE full lifecycle evidence ledger",
  "Execute V1 commerce plus FINAL dispute, Hold and adjustment through HTTP, validate OpenAPI, expose concrete IDs in UI, inspect snapshot/Work/Event and deliver notifications",
  "Every applicable README node has a real identity-consistent HTTP→OpenAPI→UI→snapshot/Work/Event→receiver evidence chain",
  [
    "public HTTP",
    "OpenAPI",
    "production Chromium",
    "verification snapshot",
    "Workers/Dispatcher",
    "receiver",
  ],
  async (ctx) => {
    const family = ctx.fixtures.dispute();
    const receiver = await ctx.receiver();
    const { api } = await prepare(ctx, family);
    const document = await openApi(ctx, api.baseUrl);
    const dispute = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.license.licenseId,
      label: "d08-dispute",
    });
    const hold = await createHoldFor(ctx, api.baseUrl, dispute.dispute, {
      scope: "LICENSE",
      licenseId: family.license.licenseId,
      label: "d08-hold",
    });
    await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/rights-disputes/${dispute.dispute.rightsDisputeId}/resolve`,
      "d08-resolve",
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
      hold.hold.licenseHoldId,
      { expectedRevision: hold.hold.revision, reason: "CLEARED" },
      "d08-release",
    );
    const adjustment = await createAdjustmentFor(ctx, api.baseUrl, family, {
      amountMinor: 3_335,
      label: "d08-adjustment",
    });
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const requiredKinds = [
      "RIGHTS_DISPUTE_REVIEW",
      "LICENSE_HOLD_APPLY",
      "ROYALTY_ADJUSTMENT_POST",
    ];
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        requiredKinds.every((kind) =>
          value.work.some((item) => item.kind === kind && item.terminal),
        )
          ? value
          : undefined,
      { label: "FINAL Work terminal", processes: workers },
    );
    await ctx.waitFor(
      () => (receiver.ledger.length > 0 ? receiver.ledger : undefined),
      {
        label: "FINAL notification delivery",
        timeoutMs: 120_000,
        processes: [dispatcher],
      },
    );
    const { page } = await launchBrowser(ctx, api);
    for (const identity of [
      family.edition.editionId,
      family.license.licenseId,
      dispute.dispute.rightsDisputeId,
      hold.hold.licenseHoldId,
      adjustment.adjustment.royaltyAdjustmentId,
    ])
      await expectVisibleIdentity(page, identity);
    ctx.ok(
      document.paths["/api/v1/royalty-adjustments"],
      "adjustment OpenAPI node",
    );
    for (const identity of [
      dispute.dispute.rightsDisputeId,
      hold.hold.licenseHoldId,
      adjustment.adjustment.royaltyAdjustmentId,
    ])
      ctx.ok(
        JSON.stringify(state).includes(identity),
        `${identity} snapshot node`,
      );
    ctx.assert("FINAL Event sequence", () =>
      assertAggregateSequences(state.events),
    );
    ctx.assert("receiver retry identity", () =>
      assertRetryIdentity(receiver.ledger),
    );
    ctx.assert("evidence redaction", () =>
      assertNoSensitiveData({ state, receiver: receiver.ledger }, [
        ctx.adminToken,
        ctx.databaseUrl,
        ctx.managedDataRoot,
      ]),
    );
    assertAllPostings(ctx, state);
    return caseResult(ctx, {
      editionId: family.edition.editionId,
      licenseId: family.license.licenseId,
      disputeId: dispute.dispute.rightsDisputeId,
      holdId: hold.hold.licenseHoldId,
      adjustmentId: adjustment.adjustment.royaltyAdjustmentId,
    });
  },
);

export const D_CASES = Object.freeze([d01, d02, d03, d04, d05, d06, d07, d08]);
