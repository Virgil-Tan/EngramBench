import { createHash } from "node:crypto";

function digest(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest();
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function uuidFrom(buffer) {
  const bytes = Buffer.from(buffer.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `creatorrightsexchange\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) =>
    `cre-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({
    milliseconds = 0,
    seconds = 0,
    minutes = 0,
    hours = 0,
    days = 0,
  } = {}) =>
    new Date(
      Date.parse(baseTime) +
        (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000 +
        milliseconds,
    ).toISOString();
  const bytes = (label, size = 192 * 1024 + 17) => {
    const blocks = [];
    for (let ordinal = 0, remaining = size; remaining > 0; ordinal += 1) {
      const block = digest(namespace, "bytes", label, String(ordinal));
      const taken = Math.min(block.length, remaining);
      blocks.push(block.subarray(0, taken));
      remaining -= taken;
    }
    return Buffer.concat(blocks);
  };

  function base() {
    const tenant = {
      tenantId: uuid("tenant:primary"),
      name: "Creator Rights Cooperative",
    };
    const foreignTenant = {
      tenantId: uuid("tenant:foreign"),
      name: "Foreign Rights Cooperative",
    };
    const creators = [
      {
        creatorId: uuid("creator:a"),
        tenantId: tenant.tenantId,
        displayName: "Creator A",
        payoutCurrency: "USD",
      },
      {
        creatorId: uuid("creator:b"),
        tenantId: tenant.tenantId,
        displayName: "Creator B",
        payoutCurrency: "USD",
      },
      {
        creatorId: uuid("creator:c"),
        tenantId: tenant.tenantId,
        displayName: "Creator C",
        payoutCurrency: "USD",
      },
    ].sort((left, right) =>
      Buffer.from(left.creatorId).compare(Buffer.from(right.creatorId)),
    );
    const foreignCreator = {
      creatorId: uuid("creator:foreign"),
      tenantId: foreignTenant.tenantId,
      displayName: "Foreign Creator",
      payoutCurrency: "USD",
    };
    const work = {
      workId: uuid("work:primary"),
      tenantId: tenant.tenantId,
      externalRef: "CRE-WORK-PRIMARY",
      title: "Deterministic Master",
      currentRightsRevision: 1,
    };
    const rightsSplits = creators.map((creator, index) => ({
      workId: work.workId,
      revision: 1,
      creatorId: creator.creatorId,
      basisPoints: [3333, 3333, 3334][index],
      effectiveFrom: at({ days: -30 }),
    }));
    const profiles = [
      {
        profileId: uuid("profile:copy"),
        tenantId: tenant.tenantId,
        revision: 1,
        name: "Archival Copy",
        operation: "COPY",
        prefixBase64: null,
        active: true,
      },
      {
        profileId: uuid("profile:prefix"),
        tenantId: tenant.tenantId,
        revision: 1,
        name: "Watermarked Preview",
        operation: "PREFIX_BASE64",
        prefixBase64: Buffer.from("CRE-PREVIEW\n").toString("base64"),
        active: true,
      },
    ];
    const seed = {
      schemaVersion: 1,
      seedVersion: `${caseId.toLowerCase()}-base-v1`,
      importedAt: at(),
      tenants: [tenant, foreignTenant],
      creators: [...creators, foreignCreator],
      works: [work],
      rightsSplits,
      uploadSessions: [],
      uploadChunks: [],
      blobObjects: [],
      scanJobs: [],
      scanResults: [],
      transcodeProfiles: profiles,
      transcodeJobs: [],
      renditions: [],
      editions: [],
      editionAssets: [],
      licenseOffers: [],
      purchaseOrders: [],
      paymentIntents: [],
      fraudAssessments: [],
      reviewCases: [],
      licenses: [],
      entitlementGrants: [],
      refunds: [],
      royaltyAccounts: [],
      royaltyEntries: [],
      royaltyPeriods: [],
      notifications: [],
      deliveries: [],
    };
    return {
      fixtureFamily: "CRE-F-BASE",
      tenant,
      foreignTenant,
      creators,
      foreignCreator,
      work,
      rightsSplits,
      profiles,
      seed,
    };
  }

  function withSeed(value, arrays, suffix) {
    return {
      ...value.seed,
      seedVersion: `${caseId.toLowerCase()}-${suffix}-v1`,
      ...arrays,
    };
  }

  function upload(label = "primary", options = {}) {
    const value = base();
    const media = options.infected
      ? Buffer.concat([
          bytes(label, 96 * 1024),
          Buffer.from("EICAR"),
          bytes(`${label}:tail`, 96 * 1024 + 17),
        ])
      : bytes(label, options.size ?? 192 * 1024 + 17);
    const chunkSize = options.chunkSize ?? 64 * 1024;
    const uploadSession = {
      uploadId: uuid(`upload:${label}`),
      tenantId: value.tenant.tenantId,
      workId: value.work.workId,
      fileName: `${label}.mp4`,
      mediaType: "video/mp4",
      totalBytes: media.length,
      chunkSize,
      contentSha256: sha256(media),
      requiredProfileIds:
        options.profileIds ?? value.profiles.map(({ profileId }) => profileId),
      state: "OPEN",
      createdAt: at({ minutes: -5 }),
      expiresAt: at({ hours: 1 }),
      completedAt: null,
    };
    return {
      ...value,
      fixtureFamily: "CRE-F-UPLOAD",
      media,
      uploadId: uploadSession.uploadId,
      uploadSession,
      chunkSize,
    };
  }

  function edition(label = "primary") {
    const value = upload(label, { profileIds: [base().profiles[0].profileId] });
    const assetId = uuid(`asset:${label}`);
    const scanJobId = uuid(`scan-job:${label}`);
    const renditionId = uuid(`rendition:${label}`);
    const editionId = uuid(`edition:${label}`);
    const mediaDigest = sha256(value.media);
    const blob = {
      blobId: assetId,
      tenantId: value.tenant.tenantId,
      sha256: mediaDigest,
      sizeBytes: value.media.length,
      state: "READY",
      contentBase64: value.media.toString("base64"),
      createdAt: at({ minutes: -4 }),
    };
    const scanJob = {
      scanJobId,
      assetId,
      state: "CLEAN",
      attempt: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const scanResult = {
      scanResultId: uuid(`scan-result:${label}`),
      scanJobId,
      assetId,
      verdict: "CLEAN",
      engineVersion: "creator-rights-scanner-v1",
      contentSha256: mediaDigest,
      createdAt: at({ minutes: -3 }),
    };
    const transcodeJob = {
      transcodeJobId: uuid(`transcode-job:${label}`),
      assetId,
      profileId: value.profiles[0].profileId,
      profileRevision: 1,
      state: "READY",
      attempt: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const rendition = {
      renditionId,
      assetId,
      profileId: value.profiles[0].profileId,
      profileRevision: 1,
      sha256: mediaDigest,
      sizeBytes: value.media.length,
      state: "READY",
      contentBase64: value.media.toString("base64"),
      createdAt: at({ minutes: -2 }),
    };
    const editionAsset = {
      editionId,
      ordinal: 1,
      assetId,
      renditionId,
      assetSha256: mediaDigest,
      renditionSha256: mediaDigest,
    };
    const manifestDigest = sha256(
      canonical({ rightsRevision: 1, assets: [editionAsset] }),
    );
    const editionRecord = {
      editionId,
      tenantId: value.tenant.tenantId,
      workId: value.work.workId,
      title: `Edition ${label}`,
      revision: 1,
      state: "PUBLISHED",
      rightsRevision: 1,
      manifestDigest,
      publishedAt: at({ minutes: -1 }),
      createdAt: at({ minutes: -2 }),
    };
    const seed = withSeed(
      value,
      {
        blobObjects: [blob],
        scanJobs: [scanJob],
        scanResults: [scanResult],
        transcodeJobs: [transcodeJob],
        renditions: [rendition],
        editions: [editionRecord],
        editionAssets: [editionAsset],
      },
      `edition-${label}`,
    );
    return {
      ...value,
      fixtureFamily: "CRE-F-EDITION",
      seed,
      blob,
      assetId,
      scanJob,
      scanResult,
      transcodeJob,
      rendition,
      edition: editionRecord,
      editionAsset,
    };
  }

  function purchase(
    label = "primary",
    riskContext = { velocity: 1, country: "US", deviceTrust: "KNOWN" },
  ) {
    const value = edition(label);
    const offer = {
      offerId: uuid(`offer:${label}`),
      tenantId: value.tenant.tenantId,
      editionId: value.edition.editionId,
      state: "ACTIVE",
      licenseType: "STREAM",
      territories: ["CA", "US"],
      priceMinor: 10_001,
      currency: "USD",
      termsVersion: 1,
      createdAt: at(),
    };
    const seed = withSeed(
      value,
      { licenseOffers: [offer] },
      `purchase-${label}`,
    );
    const purchaseBody = {
      tenantId: value.tenant.tenantId,
      buyerRef: `buyer-${label}`,
      offerId: offer.offerId,
      providerRequestId: `provider-${key(label)}`,
      riskContext,
    };
    return {
      ...value,
      fixtureFamily: "CRE-F-PURCHASE",
      seed,
      offer,
      purchaseBody,
    };
  }

  function licensed(label = "primary", options = {}) {
    const value = purchase(label);
    const purchaseOrderId = uuid(`purchase:${label}`);
    const paymentIntentId = uuid(`payment:${label}`);
    const licenseId = uuid(`license:${label}`);
    const grantId = uuid(`grant:${label}`);
    const period = {
      royaltyPeriodId: uuid(`period:${label}`),
      tenantId: value.tenant.tenantId,
      currency: "USD",
      periodStart: at({ days: -1 }),
      periodEnd: at({ days: 1 }),
      state: options.closed ? "CLOSED" : "OPEN",
      closedAt: options.closed ? at({ days: 1 }) : null,
      snapshotDigest: null,
    };
    const accounts = [
      {
        royaltyAccountId: uuid(`account:${label}:platform`),
        tenantId: value.tenant.tenantId,
        ownerType: "PLATFORM",
        ownerId: value.tenant.tenantId,
        currency: "USD",
      },
      ...value.creators.map((creator) => ({
        royaltyAccountId: uuid(`account:${label}:${creator.creatorId}`),
        tenantId: value.tenant.tenantId,
        ownerType: "CREATOR",
        ownerId: creator.creatorId,
        currency: "USD",
      })),
    ];
    const purchaseOrder = {
      purchaseOrderId,
      tenantId: value.tenant.tenantId,
      buyerRef: `buyer-${label}`,
      offerId: value.offer.offerId,
      editionId: value.edition.editionId,
      priceMinor: 10_001,
      currency: "USD",
      termsVersion: 1,
      rightsRevision: 1,
      state: "LICENSED",
      providerRequestId: `provider-${key(label)}`,
      sequence: 3,
      createdAt: at({ minutes: -1 }),
      terminalAt: at(),
    };
    const paymentIntent = {
      paymentIntentId,
      purchaseOrderId,
      providerRequestId: purchaseOrder.providerRequestId,
      amountMinor: 10_001,
      currency: "USD",
      state: "SUCCEEDED",
      sequence: 2,
      createdAt: at({ minutes: -1 }),
      resolvedAt: at(),
    };
    const fraudAssessment = {
      assessmentId: uuid(`assessment:${label}`),
      purchaseOrderId,
      rulesVersion: 1,
      score: 0,
      recommendation: "APPROVE",
      state: "COMPLETED",
      createdAt: at({ minutes: -1 }),
      completedAt: at(),
    };
    const license = {
      licenseId,
      tenantId: value.tenant.tenantId,
      purchaseOrderId,
      editionId: value.edition.editionId,
      buyerRef: purchaseOrder.buyerRef,
      licenseType: value.offer.licenseType,
      territories: value.offer.territories,
      rightsRevision: 1,
      state: "ACTIVE",
      grantedAt: at(),
      revokedAt: null,
    };
    const grant = {
      grantId,
      tenantId: value.tenant.tenantId,
      licenseId,
      buyerRef: purchaseOrder.buyerRef,
      editionId: value.edition.editionId,
      state: "ACTIVE",
      revision: 1,
      grantedAt: at(),
      revokedAt: null,
    };
    const postingId = uuid(`posting:${label}`);
    const amounts = [3_333, 3_333, 3_335];
    const entries = [
      {
        royaltyEntryId: uuid(`entry:${label}:debit`),
        postingId,
        tenantId: value.tenant.tenantId,
        royaltyPeriodId: period.royaltyPeriodId,
        royaltyAccountId: accounts[0].royaltyAccountId,
        ownerId: value.tenant.tenantId,
        accountRole: "PLATFORM_CLEARING",
        direction: "DEBIT",
        amountMinor: 10_001,
        currency: "USD",
        sourceType: "LICENSE",
        sourceId: licenseId,
        createdAt: at(),
      },
      ...value.creators.map((creator, index) => ({
        royaltyEntryId: uuid(`entry:${label}:credit:${index}`),
        postingId,
        tenantId: value.tenant.tenantId,
        royaltyPeriodId: period.royaltyPeriodId,
        royaltyAccountId: accounts[index + 1].royaltyAccountId,
        ownerId: creator.creatorId,
        accountRole: "CREATOR_PAYABLE",
        direction: "CREDIT",
        amountMinor: amounts[index],
        currency: "USD",
        sourceType: "LICENSE",
        sourceId: licenseId,
        createdAt: at(),
      })),
    ];
    if (options.closed)
      period.snapshotDigest = sha256(
        canonical(
          [...entries].sort((left, right) =>
            Buffer.from(`${left.createdAt}\0${left.royaltyEntryId}`).compare(
              Buffer.from(`${right.createdAt}\0${right.royaltyEntryId}`),
            ),
          ),
        ),
      );
    const seed = withSeed(
      value,
      {
        purchaseOrders: [purchaseOrder],
        paymentIntents: [paymentIntent],
        fraudAssessments: [fraudAssessment],
        licenses: [license],
        entitlementGrants: [grant],
        royaltyAccounts: accounts,
        royaltyEntries: entries,
        royaltyPeriods: [period],
      },
      `licensed-${label}`,
    );
    return {
      ...value,
      fixtureFamily: options.closed ? "CRE-F-ROYALTY" : "CRE-F-REFUND",
      seed,
      purchaseOrder,
      paymentIntent,
      fraudAssessment,
      license,
      grant,
      royaltyPeriod: period,
      royaltyAccounts: accounts,
      royaltyEntries: entries,
      postingId,
    };
  }

  function notification(label = "primary", count = 3, options = {}) {
    const value = licensed(label, { closed: options.closed ?? false });
    const aggregateId = value.license.licenseId;
    const notifications = Array.from({ length: count }, (_, index) => ({
      notificationId: uuid(`notification:${label}:${index}`),
      tenantId: value.tenant.tenantId,
      aggregateType: "License",
      aggregateId,
      sequence: index + 1,
      templateKey: index === 0 ? "license.granted" : "license.updated",
      payload: { licenseId: aggregateId, sequence: index + 1 },
      state: "PENDING",
      createdAt: at({ milliseconds: index }),
    }));
    const deliveries = notifications.map((notification, index) => ({
      deliveryId: uuid(`delivery:${label}:${index}`),
      notificationId: notification.notificationId,
      eventId: uuid(`delivery-event:${label}:${index}`),
      attempt: 0,
      state: "PENDING",
      nextAttemptAt: at(),
      providerReceiptId: null,
    }));
    const seed = withSeed(
      value,
      { notifications, deliveries },
      `notification-${label}`,
    );
    return {
      ...value,
      fixtureFamily: "CRE-F-NOTIFICATION",
      seed,
      notifications,
      deliveries,
    };
  }

  function commercialSeed(total, options = {}) {
    const value = edition(options.label ?? "perf-commercial");
    const period = {
      royaltyPeriodId: uuid("perf:period"),
      tenantId: value.tenant.tenantId,
      currency: "USD",
      periodStart: at({ days: -1 }),
      periodEnd: at({ days: 1 }),
      state: "OPEN",
      closedAt: null,
      snapshotDigest: null,
    };
    const accounts = [
      {
        royaltyAccountId: uuid("perf:account:platform"),
        tenantId: value.tenant.tenantId,
        ownerType: "PLATFORM",
        ownerId: value.tenant.tenantId,
        currency: "USD",
      },
      ...value.creators.map((creator) => ({
        royaltyAccountId: uuid(`perf:account:${creator.creatorId}`),
        tenantId: value.tenant.tenantId,
        ownerType: "CREATOR",
        ownerId: creator.creatorId,
        currency: "USD",
      })),
    ];
    const offers = [
      {
        offerId: uuid("perf:offer"),
        tenantId: value.tenant.tenantId,
        editionId: value.edition.editionId,
        state: "ACTIVE",
        licenseType: "STREAM",
        territories: ["US"],
        priceMinor: 10_001,
        currency: "USD",
        termsVersion: 1,
        createdAt: at(),
      },
    ];
    const purchaseOrders = [];
    const paymentIntents = [];
    const fraudAssessments = [];
    const licenses = [];
    const entitlementGrants = [];
    const royaltyEntries = [];
    for (let index = 0; index < total; index += 1) {
      const purchaseOrderId = uuid(`perf:purchase:${index}`);
      const licenseId = uuid(`perf:license:${index}`);
      const buyerRef = `perf-buyer-${index}`;
      purchaseOrders.push({
        purchaseOrderId,
        tenantId: value.tenant.tenantId,
        buyerRef,
        offerId: offers[0].offerId,
        editionId: value.edition.editionId,
        priceMinor: 10_001,
        currency: "USD",
        termsVersion: 1,
        rightsRevision: 1,
        state: "LICENSED",
        providerRequestId: `perf-provider-${index}-${key("provider")}`,
        sequence: 3,
        createdAt: at(),
        terminalAt: at(),
      });
      paymentIntents.push({
        paymentIntentId: uuid(`perf:payment:${index}`),
        purchaseOrderId,
        providerRequestId: purchaseOrders.at(-1).providerRequestId,
        amountMinor: 10_001,
        currency: "USD",
        state: "SUCCEEDED",
        sequence: 2,
        createdAt: at(),
        resolvedAt: at(),
      });
      fraudAssessments.push({
        assessmentId: uuid(`perf:assessment:${index}`),
        purchaseOrderId,
        rulesVersion: 1,
        score: 0,
        recommendation: "APPROVE",
        state: "COMPLETED",
        createdAt: at(),
        completedAt: at(),
      });
      licenses.push({
        licenseId,
        tenantId: value.tenant.tenantId,
        purchaseOrderId,
        editionId: value.edition.editionId,
        buyerRef,
        licenseType: "STREAM",
        territories: ["US"],
        rightsRevision: 1,
        state: "ACTIVE",
        grantedAt: at(),
        revokedAt: null,
      });
      entitlementGrants.push({
        grantId: uuid(`perf:grant:${index}`),
        tenantId: value.tenant.tenantId,
        licenseId,
        buyerRef,
        editionId: value.edition.editionId,
        state: "ACTIVE",
        revision: 1,
        grantedAt: at(),
        revokedAt: null,
      });
      if (options.withRoyalty !== false) {
        const postingId = uuid(`perf:posting:${index}`);
        royaltyEntries.push(
          {
            royaltyEntryId: uuid(`perf:entry:${index}:0`),
            postingId,
            tenantId: value.tenant.tenantId,
            royaltyPeriodId: period.royaltyPeriodId,
            royaltyAccountId: accounts[0].royaltyAccountId,
            ownerId: value.tenant.tenantId,
            accountRole: "PLATFORM_CLEARING",
            direction: "DEBIT",
            amountMinor: 10_001,
            currency: "USD",
            sourceType: "LICENSE",
            sourceId: licenseId,
            createdAt: at(),
          },
          ...value.creators.map((creator, offset) => ({
            royaltyEntryId: uuid(`perf:entry:${index}:${offset + 1}`),
            postingId,
            tenantId: value.tenant.tenantId,
            royaltyPeriodId: period.royaltyPeriodId,
            royaltyAccountId: accounts[offset + 1].royaltyAccountId,
            ownerId: creator.creatorId,
            accountRole: "CREATOR_PAYABLE",
            direction: "CREDIT",
            amountMinor: [3_333, 3_333, 3_335][offset],
            currency: "USD",
            sourceType: "LICENSE",
            sourceId: licenseId,
            createdAt: at(),
          })),
        );
      }
    }
    const seed = withSeed(
      value,
      {
        licenseOffers: offers,
        purchaseOrders,
        paymentIntents,
        fraudAssessments,
        licenses,
        entitlementGrants,
        royaltyAccounts: accounts,
        royaltyEntries,
        royaltyPeriods: [period],
      },
      `commercial-${total}`,
    );
    return {
      ...value,
      fixtureFamily: "CRE-F-PERF",
      seed,
      offer: offers[0],
      purchaseOrders,
      paymentIntents,
      fraudAssessments,
      licenses,
      entitlementGrants,
      royaltyAccounts: accounts,
      royaltyEntries,
      royaltyPeriod: period,
    };
  }

  function notificationSeed(total) {
    const value = edition("perf-notifications");
    const notifications = Array.from({ length: total }, (_, index) => ({
      notificationId: uuid(`perf:notification:${index}`),
      tenantId: value.tenant.tenantId,
      aggregateType: "Edition",
      aggregateId: value.edition.editionId,
      sequence: index + 1,
      templateKey: "edition.published",
      payload: { editionId: value.edition.editionId, ordinal: index + 1 },
      state: "PENDING",
      createdAt: at({ milliseconds: index }),
    }));
    const deliveries = notifications.map((notification, index) => ({
      deliveryId: uuid(`perf:delivery:${index}`),
      notificationId: notification.notificationId,
      eventId: uuid(`perf:event:${index}`),
      attempt: 0,
      state: "PENDING",
      nextAttemptAt: at(),
      providerReceiptId: null,
    }));
    return {
      ...value,
      fixtureFamily: "CRE-F-PERF",
      notifications,
      deliveries,
      seed: withSeed(
        value,
        { notifications, deliveries },
        `notifications-${total}`,
      ),
    };
  }

  return Object.freeze({
    uuid,
    key,
    at,
    bytes,
    sha256,
    base,
    empty: () => {
      const value = base();
      return {
        ...value,
        fixtureFamily: "CRE-F-EMPTY",
        seed: {
          ...value.seed,
          seedVersion: `${caseId.toLowerCase()}-empty-v1`,
          tenants: [],
          creators: [],
          works: [],
          rightsSplits: [],
          transcodeProfiles: [],
        },
      };
    },
    upload,
    pipeline: (label = "pipeline") => ({
      ...upload(label),
      fixtureFamily: "CRE-F-PIPELINE",
    }),
    edition,
    purchase,
    review: () => ({
      ...purchase("review", {
        velocity: 50,
        country: "US",
        deviceTrust: "KNOWN",
      }),
      fixtureFamily: "CRE-F-REVIEW",
    }),
    refund: () => licensed("refund"),
    royalty: (options = {}) =>
      licensed(options.label ?? "royalty", { closed: options.closed ?? true }),
    notification: (count = 3) => notification("notification", count),
    dispute: () => ({
      ...licensed("dispute", { closed: true }),
      fixtureFamily: "CRE-F-DISPUTE",
      evidenceRefs: ["evidence:ledger:1", "evidence:media:1"],
    }),
    idempotency: () => ({
      ...purchase("idempotency"),
      fixtureFamily: "CRE-F-IDEMPOTENCY",
    }),
    work: () => ({ ...upload("work"), fixtureFamily: "CRE-F-WORK" }),
    migration: () => ({
      ...notification("migration", 2, { closed: true }),
      fixtureFamily: "CRE-F-MIGRATION",
      savedReplayKey: key("migration:replay"),
    }),
    browser: () => ({
      ...licensed("browser", { closed: true }),
      fixtureFamily: "CRE-F-BROWSER",
    }),
    commercialSeed,
    notificationSeed,
    performance: () => ({
      fixtureFamily: "CRE-F-PERF",
      commercialSeed,
      notificationSeed,
      scenarios: {
        multipartEditionPipeline: {
          assets: 240,
          chunksPerAsset: 2,
          clients: 32,
          workers: 4,
          minimumPerMinute: 20,
          maximumRssBytes: 768 * 1024 * 1024,
        },
        licenseCheckoutUncertainty: {
          clients: 64,
          warmupMs: 10_000,
          measureMs: 60_000,
          unknownRatio: 0.1,
          minimumThroughput: 150,
          maximumP95Ms: 500,
        },
        fraudReviewRelease: {
          purchases: 1_000,
          reviewers: 64,
          workers: 4,
          minimumThroughput: 20,
        },
        entitlementReadStorm: {
          grants: 20_000,
          clients: 128,
          apiProcesses: 2,
          warmupMs: 10_000,
          measureMs: 60_000,
          minimumThroughput: 2_000,
          maximumP95Ms: 80,
        },
        royaltyLedgerClose: {
          entries: 100_000,
          workers: 4,
          killedClaimants: 1,
          deadlineMs: 60_000,
        },
        notificationRecovery: {
          notifications: 10_000,
          dispatchers: 2,
          deadlineMs: 45_000,
        },
      },
    }),
  });
}
