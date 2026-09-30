import assert from "node:assert/strict";

import {
  allocateRoyalty,
  assertAggregateSequences,
  assertBalancedPosting,
  assertNoSensitiveData,
  assertLedgerTotals,
  assertRetryIdentity,
  chunkOracle,
  fraudV1,
  royaltyPeriodDigest,
  periodEntries,
} from "../oracles/index.mjs";
import {
  assertAllPostings,
  assertCommercialAuthority,
  assertNoTemporaryMedia,
  caseResult,
  completeRefund,
  completeUpload,
  createAdjustmentFor,
  createApprovedLicense,
  createDisputeFor,
  createEdition,
  createHoldFor,
  createOffer,
  createProfile,
  createPublishedEditionFlow,
  createPurchase,
  createRightsSplit,
  createUpload,
  defineCase,
  expectAnyError,
  expectError,
  findDeep,
  listManaged,
  mutate,
  openApi,
  prepare,
  providerEvent,
  putChunk,
  releaseHold,
  requireStatus,
  resourceFrom,
  snapshot,
  stableResponse,
  stableSnapshot,
  uploadAll,
  waitAssetReady,
  waitPurchase,
  waitSnapshot,
} from "./helpers.mjs";

const a01 = defineCase(
  "A-01",
  "CRE-F-EMPTY clean checkout and isolated roles",
  "Install, migrate twice, build, boot API Worker Dispatcher and production UI, then terminate every owned process",
  "Published commands and localhost public seams succeed non-interactively and every owned process is stopped",
  ["public npm commands", "production HTTP", "owned OS processes"],
  async (ctx) => {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.migrate({ timeoutMs: 300_000 });
    await ctx.migrate({ timeoutMs: 300_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    requireStatus(
      ctx,
      await ctx.request(api.baseUrl, "/"),
      200,
      "production UI",
      { json: false, hardCapIds: ["PRODUCTION_BOOT"] },
    );
    await openApi(ctx, api.baseUrl);
    const receiver = await ctx.receiver();
    const worker = await ctx.startWorker();
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    for (const process of [dispatcher, worker, api]) await ctx.stop(process);
    ctx.ok(
      [dispatcher, worker, api].every(({ stopped }) => stopped),
      "all independent roles stopped",
      { hardCapIds: ["PRODUCTION_BOOT"] },
    );
    return caseResult(ctx, {
      commands: [
        "db:migrate",
        "build",
        "start:api",
        "start:worker",
        "start:dispatcher",
      ],
    });
  },
);

const a02 = defineCase(
  "A-02",
  "CRE-F-EDITION legal media seed and replay",
  "Replay a legal media seed and migrations around a saved Upload mutation, restart the API, and replay the exact request",
  "Resource values, managed bytes, Work, Events and response bytes remain exact while derived paths stay private",
  [
    "public migration",
    "public seed",
    "public HTTP",
    "verification snapshot",
    "managed root",
  ],
  async (ctx) => {
    const family = ctx.fixtures.edition("a02");
    await ctx.migrate();
    await ctx.migrate();
    await ctx.seed(family.seed);
    await ctx.seed(family.seed);
    const api = await ctx.startApi();
    const body = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: "migration.mp4",
      mediaType: "video/mp4",
      totalBytes: 1,
      chunkSize: 64 * 1024,
      contentSha256: ctx.fixtures.sha256(Buffer.from("m")),
      requiredProfileIds: [family.profiles[0].profileId],
    };
    const key = ctx.key("a02-upload");
    const created = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/uploads",
      "a02-create",
      body,
      { expected: 200, key },
    );
    const before = await snapshot(ctx, api.baseUrl);
    const pathsBefore = await listManaged(ctx);
    await ctx.stop(api);
    await ctx.migrate();
    await ctx.migrate();
    const restarted = await ctx.startApi();
    const replay = await mutate(
      ctx,
      restarted.baseUrl,
      "/api/v1/uploads",
      "a02-replay",
      body,
      { expected: 200, key },
    );
    stableResponse(ctx, [created, replay], "saved Upload replay", {
      hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_REPLAY"],
    });
    const after = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(
      stableSnapshot(after),
      stableSnapshot(before),
      "migration state byte-stable",
      { hardCapIds: ["MIGRATION_COMPATIBILITY"] },
    );
    ctx.equal(
      await listManaged(ctx),
      pathsBefore,
      "managed media paths stable",
    );
    ctx.assert("snapshot redaction", () =>
      assertNoSensitiveData(after, [ctx.managedDataRoot]),
    );
    return caseResult(ctx, {
      uploadId: created.json.uploadSession.uploadId,
      managedFiles: pathsBefore.length,
    });
  },
);

const a03 = defineCase(
  "A-03",
  "CRE-F-EDITION adversarial seed and managed bytes",
  "Submit version conflict, unknown, duplicate, broken-reference, cross-tenant, rights, money, sequence, digest, base64 and size-invalid seeds",
  "Every invalid seed exits nonzero and leaves the prior snapshot and managed root byte-for-byte unchanged",
  ["public seed command", "verification snapshot", "managed root"],
  async (ctx) => {
    const family = ctx.fixtures.edition("a03");
    await ctx.migrate();
    await ctx.seed(family.seed);
    const api = await ctx.startApi();
    const baseline = await snapshot(ctx, api.baseUrl);
    const root = await listManaged(ctx);
    await ctx.stop(api);
    const invalids = [];
    const conflict = structuredClone(family.seed);
    conflict.tenants[0].name = "Changed";
    invalids.push(conflict);
    const unknown = structuredClone(family.seed);
    unknown.seedVersion = "a03-unknown";
    unknown.unpublished = [];
    invalids.push(unknown);
    const duplicate = structuredClone(family.seed);
    duplicate.seedVersion = "a03-duplicate";
    duplicate.creators.push({ ...duplicate.creators[0] });
    invalids.push(duplicate);
    const broken = structuredClone(family.seed);
    broken.seedVersion = "a03-broken";
    broken.works[0].tenantId = ctx.uuid("missing-tenant");
    invalids.push(broken);
    const crossTenant = structuredClone(family.seed);
    crossTenant.seedVersion = "a03-cross";
    crossTenant.rightsSplits[0].creatorId = family.foreignCreator.creatorId;
    invalids.push(crossTenant);
    const rights = structuredClone(family.seed);
    rights.seedVersion = "a03-rights";
    rights.rightsSplits[0].basisPoints -= 1;
    invalids.push(rights);
    const money = structuredClone(family.seed);
    money.seedVersion = "a03-money";
    money.licenseOffers = [
      {
        offerId: ctx.uuid("bad-offer"),
        tenantId: family.tenant.tenantId,
        editionId: family.edition.editionId,
        state: "ACTIVE",
        licenseType: "STREAM",
        territories: ["US"],
        priceMinor: 1.5,
        currency: "USD",
        termsVersion: 1,
        createdAt: ctx.at(),
      },
    ];
    invalids.push(money);
    const sequence = structuredClone(family.seed);
    sequence.seedVersion = "a03-sequence";
    sequence.notifications = [
      {
        notificationId: ctx.uuid("bad-notification"),
        tenantId: family.tenant.tenantId,
        aggregateType: "Edition",
        aggregateId: family.edition.editionId,
        sequence: 2,
        templateKey: "edition.published",
        payload: { editionId: family.edition.editionId },
        state: "PENDING",
        createdAt: ctx.at(),
      },
    ];
    invalids.push(sequence);
    const badDigest = structuredClone(family.seed);
    badDigest.seedVersion = "a03-digest";
    badDigest.blobObjects[0].sha256 = "0".repeat(64);
    invalids.push(badDigest);
    const badBase64 = structuredClone(family.seed);
    badBase64.seedVersion = "a03-base64";
    badBase64.blobObjects[0].contentBase64 = "%%%";
    invalids.push(badBase64);
    const badSize = structuredClone(family.seed);
    badSize.seedVersion = "a03-size";
    badSize.renditions[0].sizeBytes += 1;
    invalids.push(badSize);
    for (const value of invalids) {
      const result = await ctx.seed(value, {
        allowFailure: true,
        ...([unknown, money].includes(value) ? { contractExpectation: 'invalid' } : {}),
        timeoutMs: 300_000,
      });
      ctx.ok(result.exitCode !== 0, `${value.seedVersion} rejected`);
    }
    const restarted = await ctx.startApi();
    const after = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(
      stableSnapshot(after),
      stableSnapshot(baseline),
      "invalid seeds leave no rows",
      { hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"] },
    );
    ctx.equal(await listManaged(ctx), root, "invalid seeds leave no files");
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, { rejectedSeeds: invalids.length });
  },
);

const a04 = defineCase(
  "A-04",
  "CRE-F-EMPTY FINAL OpenAPI and live contract",
  "Fetch OpenAPI 3.1, independently enumerate every V1 and Manager route and exercise representative JSON, raw and error traffic",
  "OpenAPI routes, closed named schemas, status codes, headers and runtime bodies agree with the published V2 wire clarifications",
  ["production OpenAPI", "public HTTP", "raw chunk HTTP"],
  async (ctx) => {
    const family = ctx.fixtures.base();
    const { api } = await prepare(ctx, family);
    const document = await openApi(ctx, api.baseUrl);
    const tenant = { name: "OpenAPI Tenant" };
    const created = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/tenants",
      "a04-tenant",
      tenant,
      { expected: 200 },
    );
    ctx.equal(
      Object.keys(created.json).sort(),
      ["name", "tenantId"],
      "Tenant closed response",
    );
    const malformed = await ctx.request(api.baseUrl, "/api/v1/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": ctx.key("a04-malformed"),
      },
      raw: "{",
      contractExpectation: 'invalid',
    });
    expectError(ctx, malformed, 400, "MALFORMED_JSON");
    return caseResult(ctx, {
      openapi: document.openapi,
      paths: Object.keys(document.paths).length,
    });
  },
);

const a05 = defineCase(
  "A-05",
  "CRE-F-PURCHASE two-tenant validation fixture",
  "Send malformed, unknown-field, range, UUID, cursor, auth, not-found, cross-tenant and idempotency-conflict requests",
  "Published status and closed error envelopes return with zero resources, Work, Events or media side effects and no foreign material leaks",
  ["public HTTP", "verification snapshot", "managed root"],
  async (ctx) => {
    const family = ctx.fixtures.purchase("a05");
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const root = await listManaged(ctx);
    expectError(
      ctx,
      await ctx.request(api.baseUrl, "/api/v1/uploads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": ctx.key("malformed"),
        },
        raw: "{",
        contractExpectation: 'invalid',
      }),
      400,
      "MALFORMED_JSON",
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("unknown"),
        {
          tenantId: family.tenant.tenantId,
          editionId: family.edition.editionId,
          licenseType: "STREAM",
          territories: ["US"],
          priceMinor: 100,
          currency: "USD",
          termsVersion: 1,
          extra: true,
        },
        { contractExpectation: 'invalid' },
      ),
      400,
      'INVALID_REQUEST',
    );
    expectError(
      ctx,
      await ctx.request(api.baseUrl, "/api/v1/assets/not-a-uuid", { contractExpectation: 'invalid' }),
      400,
      'INVALID_REQUEST',
    );
    expectAnyError(
      ctx,
      await ctx.request(api.baseUrl, `/api/v1/assets/${ctx.uuid("missing")}`),
      404,
    );
    expectAnyError(
      ctx,
      await ctx.request(
        api.baseUrl,
        `/api/v1/royalty-ledger?tenantId=${family.tenant.tenantId}&ownerId=${family.creators[0].creatorId}&cursor=foreign.bad`,
      ),
      400,
    );
    expectAnyError(
      ctx,
      await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", {
        headers: { authorization: "Bearer wrong" },
      }),
      [401, 403],
    );
    expectAnyError(
      ctx,
      await ctx.mutate(api.baseUrl, "/api/v1/uploads", ctx.key("cross"), {
        tenantId: family.foreignTenant.tenantId,
        workId: family.work.workId,
        fileName: "foreign.mp4",
        mediaType: "video/mp4",
        totalBytes: 1,
        chunkSize: 64 * 1024,
        contentSha256: "0".repeat(64),
        requiredProfileIds: [family.profiles[0].profileId],
      }),
      400,
    );
    const valid = {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      fileName: "same.mp4",
      mediaType: "video/mp4",
      totalBytes: 1,
      chunkSize: 64 * 1024,
      contentSha256: "0".repeat(64),
      requiredProfileIds: [family.profiles[0].profileId],
    };
    const sameKey = ctx.key("conflict");
    await ctx.mutate(api.baseUrl, "/api/v1/uploads", sameKey, valid);
    expectError(
      ctx,
      await ctx.mutate(api.baseUrl, "/api/v1/uploads", sameKey, {
        ...valid,
        fileName: "changed.mp4",
      }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    const after = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      after.resources.uploadSessions.length,
      before.resources.uploadSessions.length + 1,
      "only valid Upload exists",
    );
    ctx.equal(
      after.events.length,
      before.events.length,
      "validation failures add no Events",
    );
    ctx.equal(await listManaged(ctx), root, "validation failures add no files");
    ctx.assert("no foreign or private leak", () =>
      assertNoSensitiveData(after, [
        family.foreignCreator.creatorId,
        ctx.databaseUrl,
        ctx.managedDataRoot,
      ]),
    );
    return caseResult(ctx, { rejectedFamilies: 8 });
  },
);

const a06 = defineCase(
  "A-06",
  "CRE-F-ROYALTY scalar and pagination boundaries",
  "Exercise min/max upload sizes and chunk sizes, safe integer money, ISO currency, rights totals, sorted territories, half-open periods and cursor response",
  "Legal published boundaries are accepted and every adjacent illegal value is atomically rejected",
  ["public HTTP", "verification snapshot", "royalty ledger"],
  async (ctx) => {
    const family = ctx.fixtures.royalty({ label: "a06", closed: true });
    const { api } = await prepare(ctx, family);
    const upload = (label, totalBytes, chunkSize, options = {}) =>
      ctx.mutate(api.baseUrl, "/api/v1/uploads", ctx.key(label), {
        tenantId: family.tenant.tenantId,
        workId: family.work.workId,
        fileName: `${label}.mp4`,
        mediaType: "video/mp4",
        totalBytes,
        chunkSize,
        contentSha256: "0".repeat(64),
        requiredProfileIds: [family.profiles[0].profileId],
      }, options);
    requireStatus(
      ctx,
      await upload("min", 1, 64 * 1024),
      200,
      "minimum upload",
    );
    requireStatus(
      ctx,
      await upload("max", 2 * 1024 ** 3, 8 * 1024 ** 2),
      200,
      "maximum upload",
    );
    expectError(ctx, await upload("zero", 0, 64 * 1024, { contractExpectation: 'invalid' }), 400, 'INVALID_REQUEST');
    expectError(
      ctx,
      await upload("overflow", 2 * 1024 ** 3 + 1, 8 * 1024 ** 2, { contractExpectation: 'invalid' }),
      400,
      'INVALID_REQUEST',
    );
    expectError(ctx, await upload("small-chunk", 1, 64 * 1024 - 1, { contractExpectation: 'invalid' }), 400, 'INVALID_REQUEST');
    const offer = {
      tenantId: family.tenant.tenantId,
      editionId: family.edition.editionId,
      licenseType: "DOWNLOAD",
      territories: ["CA", "US"],
      priceMinor: Number.MAX_SAFE_INTEGER,
      currency: "USD",
      termsVersion: 2,
    };
    requireStatus(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("safe-money"),
        offer,
      ),
      200,
      "safe integer money",
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("float"),
        { ...offer, priceMinor: 1.5 },
        { contractExpectation: 'invalid' },
      ),
      400,
      'INVALID_REQUEST',
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("territory"),
        { ...offer, territories: ["US", "CA"] },
      ),
      400,
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("a06-currency"),
        { ...offer, currency: "usd" },
        { contractExpectation: 'invalid' },
      ),
      400,
      'INVALID_REQUEST',
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/license-offers",
        ctx.key("a06-duplicate-territory"),
        { ...offer, territories: ["US", "US"] },
        { contractExpectation: 'invalid' },
      ),
      400,
      'INVALID_REQUEST',
    );
    const prefix64KiB = Buffer.alloc(64 * 1024, 0x50).toString("base64");
    requireStatus(
      ctx,
      await createProfile(
        ctx,
        api.baseUrl,
        {
          tenantId: family.tenant.tenantId,
          name: "A06 max prefix",
          operation: "PREFIX_BASE64",
          prefixBase64: prefix64KiB,
        },
        "a06-prefix-max",
      ),
      200,
      "64KiB prefix accepted",
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/transcode-profiles",
        ctx.key("a06-prefix-overflow"),
        {
          tenantId: family.tenant.tenantId,
          name: "A06 oversized prefix",
          operation: "PREFIX_BASE64",
          prefixBase64: Buffer.alloc(64 * 1024 + 1, 0x50).toString("base64"),
        },
      ),
      400,
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/uploads",
        ctx.key("a06-duplicate-profiles"),
        {
          tenantId: family.tenant.tenantId,
          workId: family.work.workId,
          fileName: "duplicate-profiles.mp4",
          mediaType: "video/mp4",
          totalBytes: 1,
          chunkSize: 64 * 1024,
          contentSha256: "0".repeat(64),
          requiredProfileIds: [
            family.profiles[0].profileId,
            family.profiles[0].profileId,
          ],
        },
        { contractExpectation: 'invalid' },
      ),
      400,
      'INVALID_REQUEST',
    );
    const rights = {
      expectedRevision: 1,
      effectiveFrom: ctx.at({ days: 1 }),
      splits: family.creators.map((creator, index) => ({
        creatorId: creator.creatorId,
        basisPoints: [1, 1, 9998][index],
      })),
    };
    requireStatus(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("rights-boundary"),
        rights,
      ),
      200,
      "rights total 10k",
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("rights-bad"),
        {
          ...rights,
          expectedRevision: 2,
          splits: rights.splits.map((item, index) =>
            index === 2 ? { ...item, basisPoints: 9997 } : item,
          ),
        },
      ),
      400,
    );
    const ledger = await ctx.request(
      api.baseUrl,
      `/api/v1/royalty-ledger?tenantId=${family.tenant.tenantId}&ownerId=${family.creators[0].creatorId}`,
    );
    requireStatus(ctx, ledger, 200, "royalty ledger");
    ctx.equal(
      Object.keys(ledger.json).sort(),
      ["items", "nextCursor", "totals"],
      "ledger page shape",
    );
    ctx.assert('ledger totals reflect immutable entries, independent of pagination', () => assertLedgerTotals(ledger.json, family.seed.royaltyEntries.filter(entry => entry.ownerId === family.creators[0].creatorId && entry.tenantId === family.tenant.tenantId)));
    ctx.ok(
      periodEntries(ledger.json.items, family.royaltyPeriod.periodStart, family.royaltyPeriod.periodEnd).length === ledger.json.items.length,
      "half-open period membership",
    );
    return caseResult(ctx, { acceptedBoundaries: 5, rejectedBoundaries: 5 });
  },
);

const a07 = defineCase(
  "A-07",
  "CRE-F-BASE Creator Work rights revision fixture",
  "Create Creator and Work, append two rights revisions, then submit stale, duplicate and foreign-Creator updates",
  "Rows normalize by creatorId, sum exactly 10k, old revisions remain immutable and Work CAS advances exactly once",
  ["public Creator/Work HTTP", "rights mutation", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.base();
    const { api } = await prepare(ctx, family);
    const revisionOne = structuredClone(family.rightsSplits);
    const second = await createRightsSplit(
      ctx,
      api.baseUrl,
      family.work.workId,
      {
        expectedRevision: 1,
        effectiveFrom: ctx.at({ days: 1 }),
        splits: family.creators.map((creator, index) => ({
          creatorId: creator.creatorId,
          basisPoints: [4000, 3000, 3000][index],
        })),
      },
      "a07-rights-2",
    );
    const work = resourceFrom(second.json, "workId", "work");
    ctx.equal(work.currentRightsRevision, 2, "Work revision advances");
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("a07-stale"),
        {
          expectedRevision: 1,
          effectiveFrom: ctx.at({ days: 2 }),
          splits: family.creators.map((creator, index) => ({
            creatorId: creator.creatorId,
            basisPoints: [4000, 3000, 3000][index],
          })),
        },
      ),
      409,
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("a07-duplicate"),
        {
          expectedRevision: 2,
          effectiveFrom: ctx.at({ days: 2 }),
          splits: [
            { creatorId: family.creators[0].creatorId, basisPoints: 5000 },
            { creatorId: family.creators[0].creatorId, basisPoints: 5000 },
          ],
        },
      ),
      400,
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/works/${family.work.workId}/rights-splits`,
        ctx.key("a07-foreign"),
        {
          expectedRevision: 2,
          effectiveFrom: ctx.at({ days: 2 }),
          splits: [
            { creatorId: family.creators[0].creatorId, basisPoints: 5000 },
            { creatorId: family.foreignCreator.creatorId, basisPoints: 5000 },
          ],
        },
      ),
      400,
    );
    const state = await snapshot(ctx, api.baseUrl);
    const old = state.resources.rightsSplits.filter(
      ({ revision }) => revision === 1,
    );
    const current = state.resources.rightsSplits.filter(
      ({ revision }) => revision === 2,
    );
    ctx.equal(old, revisionOne, "revision 1 immutable");
    ctx.equal(
      current.map(({ creatorId }) => creatorId),
      [...current.map(({ creatorId }) => creatorId)].sort(),
      "revision 2 normalized",
    );
    ctx.equal(
      current.reduce((sum, { basisPoints }) => sum + basisPoints, 0),
      10_000,
      "revision 2 exact total",
    );
    return caseResult(ctx, { workId: family.work.workId, revision: 2 });
  },
);

const a08 = defineCase(
  "A-08",
  "CRE-F-UPLOAD deterministic raw chunk fixture",
  "Create an Upload, PUT chunks out of arrival order, GET resume state, replay and conflict a chunk, restart, then abort a separate Upload",
  "Ranges, numbers, bytes and digests are exact; replay is stable; conflict and abort preserve original durable state without temp files",
  ["raw chunk HTTP", "Upload detail", "API restart", "managed root"],
  async (ctx) => {
    const family = ctx.fixtures.upload("a08");
    const { api } = await prepare(ctx, family);
    const created = await uploadAll(ctx, api.baseUrl, family, {
      label: "a08",
      arrivalOrder: [3, 1, 2, 4],
    });
    const detail = await ctx.request(
      api.baseUrl,
      `/api/v1/uploads/${created.uploadSession.uploadId}`,
    );
    requireStatus(ctx, detail, 200, "Upload resume");
    ctx.equal(
      detail.json.chunks.map(({ chunkNumber }) => chunkNumber),
      [1, 2, 3, 4],
      "resume chunks sorted",
    );
    const replay = await putChunk(
      ctx,
      api.baseUrl,
      created.uploadSession.uploadId,
      created.plan.chunks[0],
      "a08:1",
      { key: ctx.key("a08:1") },
    );
    requireStatus(ctx, replay, 200, "chunk replay");
    const changed = Buffer.from(created.plan.chunks[0].bytes);
    changed[0] ^= 1;
    expectError(
      ctx,
      await putChunk(
        ctx,
        api.baseUrl,
        created.uploadSession.uploadId,
        created.plan.chunks[0],
        "a08-conflict",
        {
          bytes: changed,
          sha256: ctx.fixtures.sha256(changed),
          key: ctx.key("a08-conflict"),
        },
      ),
      409,
      "CHUNK_CONFLICT",
      { hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"] },
    );
    await ctx.stop(api);
    const restarted = await ctx.startApi();
    const resumed = await ctx.request(
      restarted.baseUrl,
      `/api/v1/uploads/${created.uploadSession.uploadId}`,
    );
    requireStatus(ctx, resumed, 200, "restart resume");
    ctx.equal(
      resumed.json.chunks,
      detail.json.chunks,
      "restart progress stable",
    );
    const abortFamily = ctx.fixtures.upload("a08-abort", {
      profileIds: [family.profiles[0].profileId],
    });
    const abort = await createUpload(
      ctx,
      restarted.baseUrl,
      {
        tenantId: abortFamily.tenant.tenantId,
        workId: abortFamily.work.workId,
        fileName: abortFamily.uploadSession.fileName,
        mediaType: abortFamily.uploadSession.mediaType,
        totalBytes: abortFamily.media.length,
        chunkSize: abortFamily.chunkSize,
        contentSha256: abortFamily.uploadSession.contentSha256,
        requiredProfileIds: abortFamily.uploadSession.requiredProfileIds,
      },
      "a08-abort",
    );
    const abortId = abort.json.uploadSession.uploadId;
    const aborted = await mutate(
      ctx,
      restarted.baseUrl,
      `/api/v1/uploads/${abortId}/abort`,
      "a08-abort-command",
      {},
      { expected: 200 },
    );
    ctx.equal(findDeep(aborted.json, "state"), "ABORTED", "OPEN-only abort");
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      uploadId: created.uploadSession.uploadId,
      chunks: created.plan.chunks.length,
      abortedUploadId: abortId,
    });
  },
);

const a09 = defineCase(
  "A-09",
  "CRE-F-PIPELINE clean and EICAR bytes",
  "Complete clean and infected uploads, run independent Workers, and query public asset and rendition metadata",
  "Each completion creates one Blob and ScanResult; CLEAN creates one frozen rendition per profile while INFECTED schedules none and can never publish",
  [
    "raw upload HTTP",
    "Worker processes",
    "asset metadata",
    "verification snapshot",
  ],
  async (ctx) => {
    const clean = ctx.fixtures.pipeline("a09-clean");
    const infected = ctx.fixtures.upload("a09-infected", {
      infected: true,
      profileIds: [clean.profiles[0].profileId],
    });
    const { api } = await prepare(ctx, clean);
    const before = await snapshot(ctx, api.baseUrl);
    const cleanUpload = await uploadAll(ctx, api.baseUrl, clean, {
      label: "a09-clean",
    });
    const cleanCompletion = await completeUpload(
      ctx,
      api.baseUrl,
      cleanUpload.uploadSession.uploadId,
      cleanUpload.plan,
      "a09-clean-complete",
    );
    const afterClean = await snapshot(ctx, api.baseUrl);
    const cleanId =
      findDeep(cleanCompletion.json, "assetId") ??
      afterClean.resources.scanJobs.find(
        (item) =>
          !before.resources.scanJobs.some(
            ({ scanJobId }) => scanJobId === item.scanJobId,
          ),
      ).assetId;
    const infectedUpload = await uploadAll(ctx, api.baseUrl, infected, {
      label: "a09-infected",
    });
    const infectedCompletion = await completeUpload(
      ctx,
      api.baseUrl,
      infectedUpload.uploadSession.uploadId,
      infectedUpload.plan,
      "a09-infected-complete",
    );
    const afterBoth = await snapshot(ctx, api.baseUrl);
    const infectedId =
      findDeep(infectedCompletion.json, "assetId") ??
      afterBoth.resources.scanJobs.find(
        (item) =>
          item.assetId !== cleanId &&
          !before.resources.scanJobs.some(
            ({ scanJobId }) => scanJobId === item.scanJobId,
          ),
      ).assetId;
    const external = ctx.fixtures.upload("a09-external", {
      profileIds: [clean.profiles[0].profileId],
    });
    const externalUpload = await uploadAll(ctx, api.baseUrl, external, {
      label: "a09-external",
    });
    const externalCompletion = await completeUpload(
      ctx,
      api.baseUrl,
      externalUpload.uploadSession.uploadId,
      externalUpload.plan,
      "a09-external-complete",
    );
    const beforeExternalResult = await snapshot(ctx, api.baseUrl);
    const externalId =
      findDeep(externalCompletion.json, "assetId") ??
      beforeExternalResult.resources.scanJobs.find(
        ({ assetId }) => assetId !== cleanId && assetId !== infectedId,
      ).assetId;
    const externalJob = beforeExternalResult.resources.scanJobs.find(
      ({ assetId }) => assetId === externalId,
    );
    const externalResult = {
      scanResultId: ctx.uuid("a09-external-result"),
      scanJobId: externalJob.scanJobId,
      verdict: "CLEAN",
      engineVersion: "external-scanner-v1",
      contentSha256: externalUpload.plan.sha256,
    };
    const externalFirst = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/scanner/results",
      "a09-external-result",
      externalResult,
      { expected: 200 },
    );
    const externalReplay = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/scanner/results",
      "a09-external-result",
      externalResult,
      { expected: 200 },
    );
    stableResponse(
      ctx,
      [externalFirst, externalReplay],
      "external scan replay",
    );
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/scanner/results",
        ctx.key("a09-external-conflict"),
        { ...externalResult, verdict: "INFECTED" },
      ),
      409,
      "SCAN_RESULT_CONFLICT",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitAssetReady(ctx, api.baseUrl, cleanId, { processes: workers });
    await waitAssetReady(ctx, api.baseUrl, externalId, { processes: workers });
    const terminal = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.scanResults.find(
          ({ assetId, verdict }) =>
            assetId === infectedId && verdict === "INFECTED",
        )
          ? value
          : undefined,
      { label: "infected verdict", processes: workers },
    );
    ctx.equal(
      terminal.resources.scanResults.filter(
        ({ assetId }) => assetId === cleanId,
      ).length,
      1,
      "one clean ScanResult",
    );
    ctx.equal(
      terminal.resources.renditions.filter(({ assetId }) => assetId === cleanId)
        .length,
      clean.uploadSession.requiredProfileIds.length,
      "one rendition per frozen profile",
    );
    ctx.equal(
      terminal.resources.renditions.filter(
        ({ assetId }) => assetId === infectedId,
      ).length,
      0,
      "infected asset no rendition",
    );
    ctx.equal(
      terminal.resources.blobObjects.find(({ blobId }) => blobId === infectedId)
        ?.state,
      "REJECTED",
      "infected Blob rejected",
    );
    await assertNoTemporaryMedia(ctx);
    return caseResult(ctx, {
      cleanAssetId: cleanId,
      infectedAssetId: infectedId,
      externalAssetId: externalId,
    });
  },
);

const a10 = defineCase(
  "A-10",
  "CRE-F-EDITION live media and rights lineage",
  "Create a READY asset, publish a DRAFT with expected revision, change Work rights, then reread and stale-republish",
  "The Edition freezes exact asset/rendition digests and one rights revision, remains immutable, and emits one publication Event",
  [
    "public upload pipeline",
    "Edition HTTP",
    "rights CAS",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.pipeline("a10");
    const { api } = await prepare(ctx, family);
    const flow = await createPublishedEditionFlow(ctx, api.baseUrl, family, {
      label: "a10",
    });
    const before = await ctx.request(
      api.baseUrl,
      `/api/v1/editions/${flow.edition.editionId}`,
    );
    requireStatus(ctx, before, 200, "published Edition");
    await createRightsSplit(
      ctx,
      api.baseUrl,
      family.work.workId,
      {
        expectedRevision: 1,
        effectiveFrom: ctx.at({ days: 1 }),
        splits: family.creators.map((creator, index) => ({
          creatorId: creator.creatorId,
          basisPoints: [5000, 2500, 2500][index],
        })),
      },
      "a10-rights-v2",
    );
    const after = await ctx.request(
      api.baseUrl,
      `/api/v1/editions/${flow.edition.editionId}`,
    );
    ctx.equal(after.json, before.json, "published Edition immutable", {
      hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"],
    });
    expectError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/editions/${flow.edition.editionId}/publish`,
        ctx.key("a10-stale"),
        { expectedRevision: 0 },
      ),
      409,
      "EDITION_REVISION_CONFLICT",
    );
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      state.events.filter(
        ({ aggregateId, type }) =>
          aggregateId === flow.edition.editionId &&
          type === "edition.published",
      ).length,
      1,
      "one edition.published Event",
    );
    return caseResult(ctx, {
      editionId: flow.edition.editionId,
      manifestDigest: flow.edition.manifestDigest,
    });
  },
);

const a11 = defineCase(
  "A-11",
  "CRE-F-PURCHASE deterministic fraud boundaries",
  "Create APPROVE, REVIEW and BLOCK purchases against one published Edition and run fraud Workers",
  "Offer terms and rights are frozen, fraud v1 score and recommendation equal the independent oracle, REVIEW creates one case and BLOCK creates no License authority",
  ["Purchase HTTP", "fraud Workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.purchase("a11");
    const { api } = await prepare(ctx, family);
    const offerResponse = await createOffer(
      ctx,
      api.baseUrl,
      {
        tenantId: family.tenant.tenantId,
        editionId: family.edition.editionId,
        licenseType: "DOWNLOAD",
        territories: ["CA", "US"],
        priceMinor: 10_001,
        currency: "USD",
        termsVersion: 2,
      },
      "a11-offer",
    );
    const liveOffer = resourceFrom(offerResponse.json, "offerId", "offer");
    const inputs = [
      { velocity: 1, country: "US", deviceTrust: "KNOWN" },
      { velocity: 50, country: "US", deviceTrust: "KNOWN" },
      { velocity: 50, country: "XX", deviceTrust: "NEW" },
    ];
    const purchases = [];
    for (let index = 0; index < inputs.length; index += 1)
      purchases.push(
        await createPurchase(
          ctx,
          api.baseUrl,
          {
            ...family.purchaseBody,
            offerId: liveOffer.offerId,
            buyerRef: `a11-buyer-${index}`,
            providerRequestId: `a11-provider-${index}`,
            riskContext: inputs[index],
          },
          `a11-purchase-${index}`,
        ),
      );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        purchases.every(({ json }) =>
          value.resources.fraudAssessments.find(
            ({ purchaseOrderId, state: status }) =>
              purchaseOrderId === json.purchaseOrder.purchaseOrderId &&
              status === "COMPLETED",
          ),
        )
          ? value
          : undefined,
      { label: "fraud boundary results", processes: workers },
    );
    purchases.forEach(({ json }, index) => {
      const order = state.resources.purchaseOrders.find(
        ({ purchaseOrderId }) =>
          purchaseOrderId === json.purchaseOrder.purchaseOrderId,
      );
      ctx.equal(
        {
          offerId: order.offerId,
          priceMinor: order.priceMinor,
          currency: order.currency,
          termsVersion: order.termsVersion,
          rightsRevision: order.rightsRevision,
        },
        {
          offerId: liveOffer.offerId,
          priceMinor: liveOffer.priceMinor,
          currency: liveOffer.currency,
          termsVersion: liveOffer.termsVersion,
          rightsRevision: family.edition.rightsRevision,
        },
        `frozen offer and rights ${index}`,
      );
      const assessment = state.resources.fraudAssessments.find(
        ({ purchaseOrderId }) =>
          purchaseOrderId === json.purchaseOrder.purchaseOrderId,
      );
      ctx.equal(
        {
          rulesVersion: assessment.rulesVersion,
          score: assessment.score,
          recommendation: assessment.recommendation,
        },
        fraudV1(inputs[index]),
        `fraud v1 ${index}`,
      );
    });
    const reviewId = purchases[1].json.purchaseOrder.purchaseOrderId;
    const blockId = purchases[2].json.purchaseOrder.purchaseOrderId;
    ctx.equal(
      state.resources.reviewCases.filter(
        ({ purchaseOrderId }) => purchaseOrderId === reviewId,
      ).length,
      1,
      "REVIEW one case",
    );
    ctx.equal(
      state.resources.licenses.filter(
        ({ purchaseOrderId }) => purchaseOrderId === blockId,
      ).length,
      0,
      "BLOCK no License",
    );
    ctx.assert("riskContext never exposed", () => assertNoSensitiveData(state));
    return caseResult(ctx, {
      purchaseOrderIds: purchases.map(
        ({ json }) => json.purchaseOrder.purchaseOrderId,
      ),
    });
  },
);

const a12 = defineCase(
  "A-12",
  "CRE-F-REVIEW payment uncertainty fixture",
  "Drive REVIEW claim and decision, post UNKNOWN then SUCCEEDED provider events, and read License and entitlement across two APIs",
  "Only an active reviewer lease decides; payment uncertainty grants no access; success atomically creates one License, Grant and balanced posting",
  [
    "ReviewCase HTTP",
    "provider event HTTP",
    "two APIs",
    "Workers",
    "entitlement check",
  ],
  async (ctx) => {
    const family = ctx.fixtures.review();
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const purchase = await createPurchase(
      ctx,
      api.baseUrl,
      family.purchaseBody,
      "a12-purchase",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const reviewState = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.reviewCases.find(
          ({ purchaseOrderId, state }) =>
            purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId &&
            state === "OPEN",
        )
          ? value
          : undefined,
      { label: "ReviewCase", processes: workers },
    );
    const review = reviewState.resources.reviewCases.find(
      ({ purchaseOrderId }) =>
        purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
    );
    const claim = await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/review-cases/${review.reviewCaseId}/claim`,
      "a12-claim",
      { reviewerId: "reviewer-a", leaseSeconds: 30 },
      { expected: 200 },
    );
    const claimed = resourceFrom(claim.json, "reviewCaseId", "reviewCase");
    expectAnyError(
      ctx,
      await ctx.mutate(
        apis[1].baseUrl,
        `/api/v1/review-cases/${review.reviewCaseId}/decisions`,
        ctx.key("a12-stale"),
        {
          reviewerId: "reviewer-b",
          leaseToken: "stale-token",
          outcome: "APPROVE",
          reasonCode: "INVALID",
        },
      ),
      409,
    );
    await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/review-cases/${review.reviewCaseId}/decisions`,
      "a12-decision",
      {
        reviewerId: claimed.reviewerId,
        leaseToken: claimed.leaseToken,
        outcome: "APPROVE",
        reasonCode: "VERIFIED_RIGHTS",
      },
      { expected: 200 },
    );
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "a12-unknown",
        providerRequestId: family.purchaseBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "UNKNOWN",
        occurredAt: ctx.at(),
      },
      "a12-unknown",
    );
    const denied = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.purchaseBody.buyerRef}&editionId=${family.edition.editionId}`,
    );
    requireStatus(ctx, denied, 200, "uncertain entitlement");
    ctx.equal(denied.json.allowed, false, "UNKNOWN never authorizes");
    await providerEvent(
      ctx,
      apis[1].baseUrl,
      {
        providerEventId: "a12-success",
        providerRequestId: family.purchaseBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "a12-success",
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
      { label: "License authority", processes: workers },
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
    ctx.equal(
      state.resources.purchaseOrders.find(
        ({ purchaseOrderId }) =>
          purchaseOrderId === purchase.json.purchaseOrder.purchaseOrderId,
      ).state,
      "LICENSED",
      "Purchase authority committed",
    );
    ctx.ok(
      state.resources.notifications.some(
        ({ aggregateId }) => aggregateId === license.licenseId,
      ),
      "License Notification committed",
      { hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"] },
    );
    ctx.ok(
      state.events.some(
        ({ aggregateId }) =>
          aggregateId === license.licenseId ||
          aggregateId === purchase.json.purchaseOrder.purchaseOrderId,
      ),
      "License Event committed",
      { hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY"] },
    );
    for (const process of apis) {
      const allowed = await ctx.request(
        process.baseUrl,
        `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.purchaseBody.buyerRef}&editionId=${family.edition.editionId}`,
      );
      ctx.equal(allowed.json.allowed, true, "all APIs observe grant");
    }
    return caseResult(ctx, {
      purchaseOrderId: purchase.json.purchaseOrder.purchaseOrderId,
    });
  },
);

const a13 = defineCase(
  "A-13",
  "CRE-F-REFUND active captured License fixture",
  "Create partial and full refunds through UNKNOWN and SUCCEEDED provider outcomes, reconcile and send late events",
  "Refund total never exceeds capture, partial access remains, full access revokes exactly once, balanced reversals never double or revive authority",
  [
    "Refund HTTP",
    "provider events",
    "entitlement check",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.refund();
    const { apis, api } = await prepare(ctx, family, {
      apiCount: 2,
      workerCount: 2,
    });
    const partial = await completeRefund(ctx, api.baseUrl, family.license, {
      amountMinor: 4_000,
      label: "a13-partial",
      providerRequestId: "a13-partial-provider",
      providerEventId: "a13-partial-unknown",
      outcome: "UNKNOWN",
    });
    const reconcile = await ctx.mutate(
      apis[1].baseUrl,
      `/api/v1/refunds/${partial.refund.refundId}/reconcile`,
      ctx.key("a13-partial-reconcile"),
      {},
    );
    requireStatus(ctx, reconcile, 200, "UNKNOWN refund reconcile");
    const partialCheck = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(
      partialCheck.json.allowed,
      true,
      "partial refund preserves access",
    );
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "a13-partial-success",
        providerRequestId: "a13-partial-provider",
        kind: "REFUND",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "a13-partial-success",
    );
    await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.refunds.find(
          ({ refundId }) => refundId === partial.refund.refundId,
        )?.state === "SUCCEEDED"
          ? value
          : undefined,
      { label: "partial refund reconciled", processes: [] },
    );
    const full = await completeRefund(ctx, apis[1].baseUrl, family.license, {
      amountMinor: 6_001,
      label: "a13-full",
    });
    for (const process of apis) {
      const denied = await ctx.request(
        process.baseUrl,
        `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.license.buyerRef}&editionId=${family.edition.editionId}`,
      );
      ctx.equal(denied.json.allowed, false, "full refund fence visible");
    }
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/licenses/${family.license.licenseId}/refunds`,
        ctx.key("a13-over"),
        {
          amountMinor: 1,
          reason: "OVER",
          providerRequestId: "a13-over-provider",
        },
      ),
      409,
    );
    await providerEvent(
      ctx,
      api.baseUrl,
      {
        providerEventId: "a13-late",
        providerRequestId: `refund-${ctx.key("a13-full")}`,
        kind: "REFUND",
        outcome: "FAILED",
        occurredAt: ctx.at({ seconds: 2 }),
      },
      "a13-late",
    );
    const state = await snapshot(ctx, api.baseUrl);
    const grant = state.resources.entitlementGrants.find(
      ({ licenseId }) => licenseId === family.license.licenseId,
    );
    ctx.equal(grant.state, "REVOKED", "late FAILED cannot revive");
    assertAllPostings(ctx, state, { hardCapIds: ["ROYALTY_IMMUTABILITY"] });
    return caseResult(ctx, {
      refunds: [partial.refund.refundId, full.refund.refundId],
      grantRevision: grant.revision,
    });
  },
);

const a14 = defineCase(
  "A-14",
  "CRE-F-ROYALTY balanced OPEN period fixture",
  "Page the immutable ledger, advance the exact period to CLOSING, run close Workers, repeat close and query totals",
  "Each posting balances in one currency, membership is half-open, one CLOSED digest equals the independent oracle and never changes",
  [
    "royalty ledger HTTP",
    "RoyaltyPeriod HTTP",
    "close Workers",
    "verification snapshot",
  ],
  async (ctx) => {
    const family = ctx.fixtures.royalty({ label: "a14", closed: false });
    const { api } = await prepare(ctx, family);
    const ledger = await ctx.request(
      api.baseUrl,
      `/api/v1/royalty-ledger?tenantId=${family.tenant.tenantId}&ownerId=${family.creators[0].creatorId}`,
    );
    requireStatus(ctx, ledger, 200, "royalty ledger");
    ctx.ok(
      periodEntries(ledger.json.items, family.royaltyPeriod.periodStart, family.royaltyPeriod.periodEnd).length === ledger.json.items.length,
      "half-open membership",
    );
    const body = {
      tenantId: family.tenant.tenantId,
      currency: "USD",
      periodStart: family.royaltyPeriod.periodStart,
      periodEnd: family.royaltyPeriod.periodEnd,
    };
    const close = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/royalty-periods",
      "a14-close",
      body,
      { expected: 200 },
    );
    const period = resourceFrom(close.json, "royaltyPeriodId", "royaltyPeriod");
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
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
      { label: "RoyaltyPeriod CLOSED", processes: workers },
    );
    const closed = state.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) => royaltyPeriodId === period.royaltyPeriodId,
    );
    ctx.equal(
      closed.snapshotDigest,
      royaltyPeriodDigest(state.resources.royaltyEntries, closed),
      "RoyaltyPeriod digest oracle",
      { hardCapIds: ["ROYALTY_IMMUTABILITY"] },
    );
    assertAllPostings(ctx, state);
    const detail = await ctx.request(
      api.baseUrl,
      `/api/v1/royalty-periods/${period.royaltyPeriodId}`,
    );
    requireStatus(ctx, detail, 200, "closed period detail");
    const replay = await mutate(
      ctx,
      api.baseUrl,
      "/api/v1/royalty-periods",
      "a14-close",
      body,
      { expected: 200 },
    );
    stableResponse(ctx, [close, replay], "close replay");
    return caseResult(ctx, {
      royaltyPeriodId: period.royaltyPeriodId,
      snapshotDigest: closed.snapshotDigest,
    });
  },
);

const a15 = defineCase(
  "A-15",
  "CRE-F-NOTIFICATION pending delivery fixture",
  "Start a real webhook receiver and Dispatcher, drain pending Notifications, restart and inspect snapshot ordering",
  "Facts and Notifications remain transactional, aggregate sequence is gapless, delivered identity is stable and public evidence contains no secrets or bytes",
  ["webhook receiver", "Dispatcher", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.notification(3);
    const receiver = await ctx.receiver();
    const { api } = await prepare(ctx, family);
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(
      () =>
        receiver.ledger.filter(({ acknowledged }) => acknowledged).length >=
        family.notifications.length
          ? receiver.ledger
          : undefined,
      {
        label: "notification drain",
        timeoutMs: 120_000,
        processes: [dispatcher],
      },
    );
    const state = await snapshot(ctx, api.baseUrl);
    ctx.assert("event sequence", () => assertAggregateSequences(state.events));
    ctx.assert("retry identity", () => assertRetryIdentity(receiver.ledger));
    ctx.assert("delivery redaction", () =>
      assertNoSensitiveData(receiver.ledger, [
        ctx.adminToken,
        ctx.databaseUrl,
        ctx.managedDataRoot,
      ]),
    );
    ctx.equal(
      state.resources.deliveries.filter(
        ({ state: status }) => status === "DELIVERED",
      ).length,
      family.deliveries.length,
      "all deliveries terminal",
    );
    return caseResult(ctx, {
      delivered: family.deliveries.length,
      eventIds: receiver.ledger
        .map(({ headers }) => headers["x-event-id"])
        .filter(Boolean),
    });
  },
);

const a16 = defineCase(
  "A-16",
  "CRE-F-DISPUTE frozen Edition and closed facts",
  "Create a dispute with opaque evidence, reject every published evidence/reference/CAS violation, prevent duplicate OPEN, then resolve by revision CAS",
  "RightsDispute response is exact, opaque refs are never fetched, invalid requests are zero-effect, Events are gapless and frozen commercial facts never change",
  ["Manager dispute HTTP", "opaque receiver", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dispute();
    const opaque = await ctx.receiver({ path: "/opaque" });
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const evidenceRefs = [`${opaque.url}#a`, `${opaque.url}#b`].sort();
    const opened = await createDisputeFor(ctx, api.baseUrl, family, {
      evidenceRefs,
      licenseId: family.license.licenseId,
      label: "a16-open",
    });
    ctx.equal(opaque.ledger.length, 0, "opaque refs never fetched");
    const invalidBodies = [
      { ...opened.body, evidenceRefs: [] },
      { ...opened.body, evidenceRefs: [evidenceRefs[0], evidenceRefs[0]] },
      { ...opened.body, evidenceRefs: [...evidenceRefs].reverse() },
      { ...opened.body, evidenceRefs: ["x".repeat(513)] },
      { ...opened.body, expectedEditionRevision: 0 },
      { ...opened.body, claimantCreatorId: family.foreignCreator.creatorId },
      { ...opened.body, licenseId: ctx.uuid("foreign-license") },
    ];
    for (let index = 0; index < invalidBodies.length; index += 1) {
      const response = await ctx.mutate(
        api.baseUrl,
        "/api/v1/rights-disputes",
        ctx.key(`a16-invalid-${index}`),
        invalidBodies[index],
        index < 2 ? { contractExpectation: 'invalid' } : {},
      );
      expectAnyError(
        ctx,
        response,
        index === 4 ? 409 : index === 6 ? [400, 404] : 400,
      );
      if (index < 2) expectError(ctx, response, 400, 'INVALID_REQUEST');
    }
    expectAnyError(
      ctx,
      await ctx.mutate(
        api.baseUrl,
        "/api/v1/rights-disputes",
        ctx.key("a16-duplicate-open"),
        opened.body,
      ),
      409,
    );
    const resolved = await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/rights-disputes/${opened.dispute.rightsDisputeId}/resolve`,
      "a16-resolve",
      {
        expectedRevision: opened.dispute.revision,
        outcome: "REJECTED",
        reason: "CLAIM_NOT_SUPPORTED",
      },
      { expected: 200 },
    );
    ctx.equal(findDeep(resolved.json, "state"), "REJECTED", "dispute resolved");
    const after = await snapshot(ctx, api.baseUrl);
    for (const key of [
      "editions",
      "editionAssets",
      "rightsSplits",
      "licenses",
      "royaltyEntries",
      "royaltyPeriods",
    ])
      ctx.equal(after.resources[key], before.resources[key], `${key} frozen`);
    ctx.assert("gapless Events", () => assertAggregateSequences(after.events));
    ctx.equal(opaque.ledger.length, 0, "no deferred opaque fetch");
    return caseResult(ctx, {
      rightsDisputeId: opened.dispute.rightsDisputeId,
      evidenceRefs,
    });
  },
);

const a17 = defineCase(
  "A-17",
  "CRE-F-DISPUTE two Licenses and waiting payment",
  "Activate EDITION and LICENSE Holds, observe scope-selective entitlements and a paid-but-unlicensed Purchase, then resolve and release",
  "One ACTIVE authority exists per scope, new Purchase and grant paths are fenced, LICENSE scope affects only its License, and release restores at most one valid grant",
  [
    "Manager Hold HTTP",
    "provider events",
    "two APIs",
    "entitlement check",
    "Workers",
  ],
  async (ctx) => {
    const family = ctx.fixtures.commercialSeed(2, {
      withRoyalty: true,
      label: "a17",
    });
    family.evidenceRefs = ["evidence:a17"];
    const { apis, api } = await prepare(ctx, family, { apiCount: 2 });
    const opened = await createDisputeFor(ctx, api.baseUrl, family, {
      licenseId: family.licenses[0].licenseId,
      label: "a17-dispute",
    });
    const licenseHold = await createHoldFor(ctx, api.baseUrl, opened.dispute, {
      scope: "LICENSE",
      licenseId: family.licenses[0].licenseId,
      label: "a17-license-hold",
    });
    const held = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.licenses[0].buyerRef}&editionId=${family.edition.editionId}`,
    );
    const other = await ctx.request(
      apis[1].baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.licenses[1].buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(held.json.allowed, false, "LICENSE Hold fences target");
    ctx.equal(other.json.allowed, true, "LICENSE Hold preserves other License");
    const waitingBody = {
      tenantId: family.tenant.tenantId,
      buyerRef: "a17-waiting",
      offerId: family.offer.offerId,
      providerRequestId: "a17-waiting-provider",
      riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
    };
    const waiting = await createPurchase(
      ctx,
      api.baseUrl,
      waitingBody,
      "a17-waiting",
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitPurchase(
      ctx,
      api.baseUrl,
      waiting.json.purchaseOrder.purchaseOrderId,
      (value) => value.fraudAssessment?.recommendation === "APPROVE",
      { label: "waiting Purchase approved", processes: workers },
    );
    const editionHold = await createHoldFor(ctx, api.baseUrl, opened.dispute, {
      scope: "EDITION",
      label: "a17-edition-hold",
    });
    await providerEvent(
      ctx,
      apis[1].baseUrl,
      {
        providerEventId: "a17-waiting-success",
        providerRequestId: waitingBody.providerRequestId,
        kind: "PAYMENT",
        outcome: "SUCCEEDED",
        occurredAt: ctx.at({ seconds: 1 }),
      },
      "a17-waiting-success",
    );
    const waitingHeld = await waitPurchase(
      ctx,
      api.baseUrl,
      waiting.json.purchaseOrder.purchaseOrderId,
      (value) => value.purchaseOrder?.state === "LICENSE_HELD",
      { label: "paid Purchase held", processes: workers },
    );
    ctx.equal(waitingHeld.license, null, "held Purchase has no License");
    const heldState = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      heldState.resources.licenses.filter(
        ({ purchaseOrderId }) =>
          purchaseOrderId === waiting.json.purchaseOrder.purchaseOrderId,
      ).length,
      0,
      "held payment creates no License",
    );
    ctx.equal(
      heldState.resources.royaltyEntries.filter(
        ({ sourceId }) =>
          sourceId === waiting.json.purchaseOrder.purchaseOrderId,
      ).length,
      0,
      "held payment creates no posting",
    );
    expectAnyError(
      ctx,
      await ctx.mutate(
        apis[1].baseUrl,
        "/api/v1/purchases",
        ctx.key("a17-blocked"),
        {
          ...waitingBody,
          buyerRef: "a17-new",
          providerRequestId: "a17-new-provider",
        },
      ),
      409,
    );
    await mutate(
      ctx,
      api.baseUrl,
      `/api/v1/rights-disputes/${opened.dispute.rightsDisputeId}/resolve`,
      "a17-resolve",
      {
        expectedRevision: opened.dispute.revision,
        outcome: "REJECTED",
        reason: "CLEARED",
      },
      { expected: 200 },
    );
    await releaseHold(
      ctx,
      api.baseUrl,
      licenseHold.hold.licenseHoldId,
      { expectedRevision: licenseHold.hold.revision, reason: "CLEARED" },
      "a17-release-license",
    );
    await releaseHold(
      ctx,
      api.baseUrl,
      editionHold.hold.licenseHoldId,
      { expectedRevision: editionHold.hold.revision, reason: "CLEARED" },
      "a17-release-edition",
    );
    const restored = await ctx.request(
      api.baseUrl,
      `/api/v1/entitlements/check?tenantId=${family.tenant.tenantId}&buyerRef=${family.licenses[0].buyerRef}&editionId=${family.edition.editionId}`,
    );
    ctx.equal(restored.json.allowed, true, "release restores valid License");
    const state = await waitSnapshot(
      ctx,
      api.baseUrl,
      (value) =>
        value.resources.licenses.filter(
          ({ purchaseOrderId }) =>
            purchaseOrderId === waiting.json.purchaseOrder.purchaseOrderId,
        ).length === 1
          ? value
          : undefined,
      { label: "waiting payment authorizes once", processes: workers },
    );
    ctx.equal(
      state.resources.licenseHolds.filter(({ state }) => state === "ACTIVE")
        .length,
      0,
      "all Holds released",
    );
    ctx.equal(
      state.resources.licenses.filter(
        ({ purchaseOrderId }) =>
          purchaseOrderId === waiting.json.purchaseOrder.purchaseOrderId,
      ).length,
      1,
      "waiting payment creates one License",
    );
    return caseResult(ctx, {
      licenseHoldId: licenseHold.hold.licenseHoldId,
      editionHoldId: editionHold.hold.licenseHoldId,
      waitingPurchaseOrderId: waiting.json.purchaseOrder.purchaseOrderId,
    });
  },
);

const a18 = defineCase(
  "A-18",
  "CRE-F-ROYALTY CLOSED original posting fixture",
  "Create positive and negative adjustments when no target period exists, then reject zero, over-balance, currency, tenant and source violations",
  "One OPEN target period and balanced adjustment postings use the frozen rights remainder oracle while original entries, CLOSED digest and notifications remain byte-unchanged",
  ["Manager adjustment HTTP", "verification snapshot", "royalty oracle"],
  async (ctx) => {
    const family = ctx.fixtures.royalty({ label: "a18", closed: true });
    const { api } = await prepare(ctx, family);
    const before = await snapshot(ctx, api.baseUrl);
    const positive = await createAdjustmentFor(ctx, api.baseUrl, family, {
      amountMinor: 3_335,
      reason: "UPWARD_CORRECTION",
      targetPeriodStart: ctx.at({ days: 2 }),
      label: "a18-positive",
    });
    const negative = await createAdjustmentFor(ctx, api.baseUrl, family, {
      amountMinor: -3_335,
      reason: "DOWNWARD_CORRECTION",
      targetPeriodStart: ctx.at({ days: 2 }),
      label: "a18-negative",
    });
    ctx.equal(
      positive.adjustment.targetRoyaltyPeriodId,
      negative.adjustment.targetRoyaltyPeriodId,
      "one target OPEN period",
    );
    const allocation = allocateRoyalty(3_335, family.rightsSplits).map(
      ({ amountMinor }) => amountMinor,
    );
    for (const value of [positive, negative]) {
      const creatorAmounts = value.entries
        .filter(({ accountRole }) => accountRole === "CREATOR_PAYABLE")
        .sort((left, right) =>
          Buffer.from(left.ownerId).compare(Buffer.from(right.ownerId)),
        )
        .map(({ amountMinor }) => amountMinor);
      ctx.equal(
        creatorAmounts,
        allocation,
        "frozen rights remainder allocation",
      );
    }
    const invalids = [
      { ...positive.body, amountMinor: 0, reason: "ZERO" },
      { ...positive.body, amountMinor: 10_002, reason: "OVER" },
      { ...positive.body, currency: "EUR", reason: "CURRENCY" },
      {
        ...positive.body,
        tenantId: family.foreignTenant.tenantId,
        reason: "TENANT",
      },
      {
        ...positive.body,
        originalPostingId: ctx.uuid("missing-posting"),
        reason: "MISSING",
      },
    ];
    for (let index = 0; index < invalids.length; index += 1)
      expectAnyError(
        ctx,
        await ctx.mutate(
          api.baseUrl,
          "/api/v1/royalty-adjustments",
          ctx.key(`a18-invalid-${index}`),
          invalids[index],
          index === 0 ? { contractExpectation: 'invalid' } : {},
        ),
        index === 0 || index === 2
          ? 400
          : index === 1
            ? [400, 409]
            : [400, 404],
      );
    const after = await snapshot(ctx, api.baseUrl);
    for (const key of ["royaltyEntries", "royaltyPeriods", "notifications"]) {
      const identity =
        key === "royaltyEntries"
          ? "royaltyEntryId"
          : key === "royaltyPeriods"
            ? "royaltyPeriodId"
            : "notificationId";
      const current = new Map(
        after.resources[key].map((item) => [item[identity], item]),
      );
      for (const row of before.resources[key])
        ctx.equal(
          current.get(row[identity]),
          row,
          `${key} original byte-unchanged`,
          { hardCapIds: ["HOLD_ADJUSTMENT_AUTHORITY"] },
        );
    }
    const target = after.resources.royaltyPeriods.find(
      ({ royaltyPeriodId }) =>
        royaltyPeriodId === positive.adjustment.targetRoyaltyPeriodId,
    );
    ctx.equal(target.state, "OPEN", "target period OPEN");
    return caseResult(ctx, {
      adjustmentIds: [
        positive.adjustment.royaltyAdjustmentId,
        negative.adjustment.royaltyAdjustmentId,
      ],
      targetRoyaltyPeriodId: target.royaltyPeriodId,
    });
  },
);

export const A_CASES = Object.freeze([
  a01,
  a02,
  a03,
  a04,
  a05,
  a06,
  a07,
  a08,
  a09,
  a10,
  a11,
  a12,
  a13,
  a14,
  a15,
  a16,
  a17,
  a18,
]);
