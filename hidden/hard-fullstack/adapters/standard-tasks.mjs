import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { standardAdapter } from "../standard-adapter.mjs";
import { measuredLoad, percentile, performanceScale } from "../performance-runtime.mjs";

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const timestamp = "2026-08-10T00:00:00.000Z";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value[key] === "string") return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const result = find(child, key);
    if (result) return result;
  }
  return undefined;
}

function base(seedVersion, members) {
  return { schemaVersion: 1, seedVersion, ...members };
}

async function streamWrite(stream, value) {
  if (!stream.write(value)) await once(stream, "drain");
}

function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

const schemaIds = { first: id(101), second: id(102) };
const schemaharbor = {
  label: "SchemaHarbor draft validation",
  performanceScenarioIds: ["latest-schema-read", "schema-validation", "gapless-publish"],
  seed: async () => base("hidden-schema", {
    subjects: [
      { subjectId: schemaIds.first, name: "orders", compatibilityMode: "FULL", modeRevision: 1 },
      { subjectId: schemaIds.second, name: "customers", compatibilityMode: "FULL", modeRevision: 1 },
    ],
    publishedVersions: [],
  }),
  path: `/api/v1/subjects/${schemaIds.first}/schema-drafts`,
  payload: (index) => ({
    schema: { name: `Order${index}`, fields: { orderId: { type: "STRING", required: true } } },
    dependencies: [],
    expectedHeadVersion: null,
  }),
  conflictPayload: () => ({ schema: { name: "Conflict", fields: {} }, dependencies: [], expectedHeadVersion: null }),
  resource: "schemaDrafts",
  identity: (json) => find(json, "draftId"),
  resourceIdentity: ({ draftId }) => draftId,
  minimumThroughput: 50,
  maximumP95Ms: 500,
  async verify(ctx, baseUrl, response) {
    const draftId = find(response.json, "draftId");
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrl);
      return snapshot.resources.schemaDrafts.some((draft) => draft.draftId === draftId && draft.state === "VALID");
    }, { label: "V1 draft VALID", children: [worker] });
    const published = await ctx.mutate(baseUrl, `/api/v1/schema-drafts/${draftId}/publish`, "h03-publish", {});
    if (published.status !== 201) throw new Error(published.text);
    const latest = await ctx.request(baseUrl, `/api/v1/subjects/${schemaIds.first}/versions/latest`);
    if (latest.status !== 200 || latest.json?.subject?.headVersion !== 1 || latest.json?.version?.version !== 1) throw new Error(latest.text);
  },
  async atomic(ctx, baseUrl, before) {
    const staleMode = await ctx.mutate(baseUrl, `/api/v1/subjects/${schemaIds.first}/compatibility-mode`, "h04-stale-mode", {
      mode: "BACKWARD",
      expectedRevision: 0,
    });
    if (staleMode.status !== 409 || staleMode.json?.error?.code !== "SUBJECT_MODE_REVISION_CHANGED") throw new Error(staleMode.text);
    const invalid = await ctx.mutate(baseUrl, `/api/v1/subjects/${schemaIds.first}/schema-drafts`, "h04-invalid-schema", {
      schema: { name: "Invalid", fields: { Bad: { type: "NESTED", required: true } } },
      dependencies: [],
      expectedHeadVersion: null,
    });
    if (invalid.status !== 400 || invalid.json?.error?.code !== "INVALID_RECORD_SCHEMA") throw new Error(invalid.text);
    if (ctx.canonical(stableSnapshot(await ctx.snapshot(baseUrl))) !== ctx.canonical(stableSnapshot(before))) throw new Error("SchemaHarbor atomic rejection changed durable state");
  },
  async contention(ctx, baseUrls) {
    const workerA = await ctx.startWorker();
    const workerB = await ctx.startWorker();
    const draft = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrls[0]);
      return snapshot.resources.schemaDrafts.find(({ state }) => state === "VALID");
    }, { label: "contended draft VALID", children: [workerA, workerB] });
    const publishes = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
      baseUrls[index % 2],
      `/api/v1/schema-drafts/${draft.draftId}/publish`,
      `h06-publish-${index}`,
      {},
    ));
    if (publishes.filter(({ status }) => status === 201).length !== 1) throw new Error("SchemaHarbor publish race did not have one winner");
    const snapshot = await ctx.snapshot(baseUrls[1]);
    const versions = snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === schemaIds.first);
    if (versions.length !== 1 || versions[0].version !== 1) throw new Error("SchemaHarbor publish race created a gap or duplicate");
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const draftId = find(created.json, "draftId");
    if (!snapshot.resources.schemaDrafts.some((draft) => draft.draftId === draftId && draft.subjectId === schemaIds.first)) {
      throw new Error("V1 Schema Draft did not survive FINAL migration");
    }
    if (snapshot.resources.releaseBundles.length !== 0) throw new Error("FINAL migration invented a Release Bundle");
  },
  performance: schemaPerformance,
  manager: {
    path: "/api/v1/release-bundles",
    payload: (index) => ({
      members: [schemaIds.first, schemaIds.second].map((subjectId, member) => ({
        subjectId,
        expectedHeadVersion: null,
        schema: { name: `Bundle${index}_${member}`, fields: { value: { type: "STRING", required: false } } },
        dependencies: [],
      })),
    }),
    async verify(ctx, baseUrl, response) {
      const releaseBundleId = find(response.json, "releaseBundleId");
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        return snapshot.resources.releaseBundles.some((bundle) => bundle.releaseBundleId === releaseBundleId && bundle.state === "READY");
      }, { label: "release bundle READY", children: [worker] });
      const published = await ctx.mutate(baseUrl, `/api/v1/release-bundles/${releaseBundleId}/publish`, "h10-bundle-publish", {});
      if (published.status < 200 || published.status >= 300) throw new Error(published.text);
      const snapshot = await ctx.snapshot(baseUrl);
      const versions = snapshot.resources.schemaVersions.filter(({ releaseBundleId: owner }) => owner === releaseBundleId);
      if (versions.length !== 2 || versions.some(({ version }) => version !== 1) || new Set(versions.map(({ subjectId }) => subjectId)).size !== 2) {
        throw new Error("release bundle was not atomically published");
      }
      const bundle = snapshot.resources.releaseBundles.find(({ releaseBundleId: candidate }) => candidate === releaseBundleId);
      const memberDraftIds = new Set(bundle?.members?.map(({ draftId }) => draftId));
      const memberDrafts = snapshot.resources.schemaDrafts.filter(({ draftId }) => memberDraftIds.has(draftId));
      if (bundle?.state !== "PUBLISHED" || memberDrafts.length !== 2 || memberDrafts.some(({ state }) => state !== "PUBLISHED")
        || versions.some(({ releaseBundleId: owner }) => owner !== releaseBundleId)) {
        throw new Error("bundle publication did not publish every captured member atomically");
      }

      const staleBundle = await ctx.mutate(baseUrl, "/api/v1/release-bundles", "h10-stale-bundle", {
        members: [schemaIds.first, schemaIds.second].map((subjectId, member) => ({
          subjectId,
          expectedHeadVersion: 1,
          schema: { name: `Bundle0_${member}`, fields: { value: { type: "STRING", required: false }, bundleOnly: { type: "BOOLEAN", required: false } } },
          dependencies: [],
        })),
      });
      if (staleBundle.status !== 202) throw new Error(staleBundle.text);
      const staleBundleId = find(staleBundle.json, "releaseBundleId");
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.releaseBundles.some((bundle) => bundle.releaseBundleId === staleBundleId && bundle.state === "READY");
      }, { label: "stale candidate bundle READY", children: [worker] });

      const standalone = await ctx.mutate(baseUrl, `/api/v1/subjects/${schemaIds.first}/schema-drafts`, "h10-standalone-draft", {
        schema: { name: "Bundle0_0", fields: { value: { type: "STRING", required: false }, standaloneOnly: { type: "BOOLEAN", required: false } } },
        dependencies: [],
        expectedHeadVersion: 1,
      });
      if (standalone.status !== 202) throw new Error(standalone.text);
      const standaloneId = find(standalone.json, "draftId");
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.schemaDrafts.some((draft) => draft.draftId === standaloneId && draft.state === "VALID");
      }, { label: "standalone draft VALID", children: [worker] });
      const advanced = await ctx.mutate(baseUrl, `/api/v1/schema-drafts/${standaloneId}/publish`, "h10-standalone-publish", {});
      if (advanced.status !== 201) throw new Error(advanced.text);

      const stale = await ctx.mutate(baseUrl, `/api/v1/release-bundles/${staleBundleId}/publish`, "h10-stale-bundle-publish", {});
      if (stale.status !== 409 || stale.json?.error?.code !== "RELEASE_BUNDLE_STALE") throw new Error(stale.text);
      const afterStale = await ctx.snapshot(baseUrl);
      const storedBundle = afterStale.resources.releaseBundles.find((bundle) => bundle.releaseBundleId === staleBundleId);
      const staleMemberDraftIds = new Set((staleBundle.json?.members ?? staleBundle.json?.releaseBundle?.members ?? []).map(({ draftId }) => draftId));
      if (storedBundle?.state !== "STALE" || afterStale.resources.schemaVersions.some(({ releaseBundleId: owner }) => owner === staleBundleId)) {
        throw new Error("stale bundle published a partial Schema Version set");
      }
      if (afterStale.resources.schemaDrafts.some((draft) => staleMemberDraftIds.has(draft.draftId) && draft.state === "PUBLISHED")) {
        throw new Error("stale bundle published a member Draft");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const releaseBundleId = find(response.json, "releaseBundleId");
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrls[0]);
        return snapshot.resources.releaseBundles.some((bundle) => bundle.releaseBundleId === releaseBundleId && bundle.state === "READY");
      }, { label: "contended release bundle READY", children: [worker] });
      const standalone = await ctx.mutate(baseUrls[0], `/api/v1/subjects/${schemaIds.first}/schema-drafts`, "h11-standalone-draft", {
        schema: { name: "H11Standalone", fields: { value: { type: "STRING", required: false }, standalone: { type: "BOOLEAN", required: false } } },
        dependencies: [],
        expectedHeadVersion: null,
      });
      if (standalone.status !== 202) throw new Error(standalone.text);
      const standaloneDraftId = find(standalone.json, "draftId");
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrls[0]);
        return snapshot.resources.schemaDrafts.some(({ draftId, state }) => draftId === standaloneDraftId && state === "VALID");
      }, { label: "contended standalone draft VALID", children: [worker] });
      const attempts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        index === 0 ? `/api/v1/schema-drafts/${standaloneDraftId}/publish` : `/api/v1/release-bundles/${releaseBundleId}/publish`,
        `h11-bundle-publish-${index}`,
        {},
      ));
      if (!attempts.some(({ status }) => status >= 200 && status < 300) || attempts.some(({ status }) => status >= 500)) throw new Error("bundle/standalone publication race returned no valid winner");
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const versions = snapshot.resources.schemaVersions.filter(({ releaseBundleId: owner }) => owner === releaseBundleId);
      const bundle = snapshot.resources.releaseBundles.find(({ releaseBundleId: candidate }) => candidate === releaseBundleId);
      const standaloneVersions = snapshot.resources.schemaVersions.filter(({ subjectId, releaseBundleId: owner }) => subjectId === schemaIds.first && owner === null);
      const subjectVersions = snapshot.resources.schemaVersions.filter(({ subjectId }) => subjectId === schemaIds.first);
      if (!bundle || !["PUBLISHED", "STALE"].includes(bundle.state) || versions.some(({ version }) => version !== 1)
        || standaloneVersions.some(({ version }) => version !== 1) || subjectVersions.some(({ version }) => version !== 1)
        || subjectVersions.length > 1 || (bundle.state === "PUBLISHED" && (versions.length !== 2 || standaloneVersions.length !== 0))
        || (bundle.state === "STALE" && versions.length !== 0 && standaloneVersions.length !== 1)) {
        throw new Error("bundle/standalone publication race produced a partial or gapped version set");
      }
    },
  },
  uiPattern: /schema|subject|draft/iu,
};

function schemaSubjectId(index) {
  return `21000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function schemaVersionId(subjectIndex, version) {
  return `22000000-${String(subjectIndex).padStart(4, "0")}-4000-8000-${String(version).padStart(12, "0")}`;
}

function schemaFields(extra = {}) {
  return Object.fromEntries([
    ...Array.from({ length: 10 }, (_, index) => [`base${index}`, { type: index % 2 ? "STRING" : "INTEGER", required: index < 2 }]),
    ...Object.entries(extra),
  ]);
}

function schemaPerfSeed() {
  const subjects = [];
  const publishedVersions = [];
  for (let subjectIndex = 0; subjectIndex < 2_000; subjectIndex += 1) {
    const subjectId = schemaSubjectId(subjectIndex);
    subjects.push({ subjectId, name: `subject-${String(subjectIndex).padStart(4, "0")}`, compatibilityMode: "FULL", modeRevision: 1 });
    for (let version = 1; version <= 10; version += 1) {
      const extras = Object.fromEntries(Array.from({ length: version - 1 }, (_, index) => [`v${index + 1}`, { type: "STRING", required: false }]));
      const schema = { name: `Record${subjectIndex}`, fields: schemaFields(extras) };
      const dependencies = [];
      publishedVersions.push({
        schemaVersionId: schemaVersionId(subjectIndex, version),
        subjectId,
        version,
        compatibilityMode: "FULL",
        modeRevision: 1,
        schema,
        canonicalDigest: digest(canonicalJson({ schema, dependencies })),
        dependencies,
        publishedAt: `2026-01-${String(Math.min(version, 28)).padStart(2, "0")}T00:00:00.000Z`,
        sequence: version,
      });
    }
  }
  return base("perf-v1", { subjects, publishedVersions });
}

async function prepareSchemaPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(schemaPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  return { apiA, apiB };
}

function validationPayload(ordinal, headVersion = 10) {
  const subjectIndex = ordinal % 2_000;
  const extras = Object.fromEntries([
    ...Array.from({ length: 9 }, (_, index) => [`v${index + 1}`, { type: "STRING", required: false }]),
    [`request${ordinal}`, { type: "BOOLEAN", required: false }],
  ]);
  return {
    subjectId: schemaSubjectId(subjectIndex),
    body: {
      schema: { name: `Record${subjectIndex}`, fields: schemaFields(extras) },
      dependencies: [
        { subjectId: schemaSubjectId((subjectIndex + 1) % 2_000), version: 10 },
        { subjectId: schemaSubjectId((subjectIndex + 2) % 2_000), version: 10 },
      ],
      expectedHeadVersion: headVersion,
    },
  };
}

async function schemaPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareSchemaPerf(ctx);
  let readOrdinal = 0;
  const reads = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = readOrdinal++;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/subjects/${schemaSubjectId(ordinal % 2_000)}/versions/latest`);
      if (response.status !== 200 || response.json?.subject?.headVersion !== 10 || response.json?.version?.version !== 10) throw new Error(response.text);
      return response;
    },
  });
  if (reads.throughput < 500 || reads.p95 > 80) throw new Error(`latest-schema-read failed: ${reads.throughput}/s p95=${reads.p95}`);
  assertions.push(`latest-schema-read: ${reads.throughput.toFixed(1)}/s, p95 ${reads.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "latest-schema-read", ...reads });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareSchemaPerf(ctx));
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  let validationOrdinal = 0;
  const measuredDrafts = new Map();
  const validations = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const ordinal = validationOrdinal++;
      const input = validationPayload(ordinal);
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/subjects/${input.subjectId}/schema-drafts`, `perf-validation-${ordinal}`, input.body);
      if (response.status !== 202) throw new Error(response.text);
      if (measured) measuredDrafts.set(find(response.json, "draftId"), performance.now());
      return response;
    },
  });
  const terminalAt = new Map();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const now = performance.now();
    for (const draft of snapshot.resources.schemaDrafts) {
      if (measuredDrafts.has(draft.draftId) && draft.state === "VALID" && !terminalAt.has(draft.draftId)) terminalAt.set(draft.draftId, now);
    }
    return terminalAt.size === measuredDrafts.size;
  }, { timeoutMs: 30_000, label: "measured schema validations", children: workers });
  const queueLatencies = [...terminalAt].map(([draftId, endedAt]) => endedAt - measuredDrafts.get(draftId)).sort((left, right) => left - right);
  const validRate = terminalAt.size / (60 * scale);
  const queueP95 = percentile(queueLatencies, 0.95);
  if (validRate < 50 || queueP95 > 2_000) throw new Error(`schema-validation failed: ${validRate}/s queue p95=${queueP95}`);
  assertions.push(`schema-validation: ${validRate.toFixed(1)} VALID/s, queue p95 ${queueP95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "schema-validation", ...validations, valid: terminalAt.size, validRate, queueP95 });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareSchemaPerf(ctx));
  const publishWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const prepareDraft = async (subjectIndex, suffix, expectedHeadVersion) => {
    const input = validationPayload(subjectIndex + suffix * 2_000, expectedHeadVersion);
    input.subjectId = schemaSubjectId(subjectIndex);
    input.body.dependencies = [];
    if (suffix === 2 && subjectIndex < 100) {
      input.body.schema.fields[`request${subjectIndex + 2_000}`] = { type: "BOOLEAN", required: false };
    }
    const response = await ctx.mutate(subjectIndex % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/subjects/${input.subjectId}/schema-drafts`, `perf-publish-draft-${suffix}-${subjectIndex}`, input.body);
    if (response.status !== 202) throw new Error(response.text);
    return find(response.json, "draftId");
  };
  const warmupDrafts = await ctx.concurrent(Array.from({ length: 100 }, (_, index) => index), 64, (subjectIndex) => prepareDraft(subjectIndex, 1, 10));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const ready = new Set(snapshot.resources.schemaDrafts.filter(({ state }) => state === "VALID").map(({ draftId }) => draftId));
    return warmupDrafts.every((draftId) => ready.has(draftId));
  }, { timeoutMs: 30_000, label: "warm-up drafts", children: publishWorkers });
  const warmupPublishes = await ctx.concurrent(warmupDrafts, 64, (draftId, index) => ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/schema-drafts/${draftId}/publish`, `perf-warmup-publish-${index}`, {}));
  if (warmupPublishes.some(({ status }) => status !== 201)) throw new Error("warm-up publication failed");
  const measuredDraftIds = await ctx.concurrent(Array.from({ length: 2_000 }, (_, index) => index), 64, (subjectIndex) => prepareDraft(subjectIndex, 2, subjectIndex < 100 ? 11 : 10));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const ready = new Set(snapshot.resources.schemaDrafts.filter(({ state }) => state === "VALID").map(({ draftId }) => draftId));
    return measuredDraftIds.every((draftId) => ready.has(draftId));
  }, { timeoutMs: 30_000, label: "2,000 measured publish drafts", children: publishWorkers });
  const publishStartedAt = Date.now();
  const publishes = await ctx.concurrent(measuredDraftIds, 64, (draftId, index) => ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/schema-drafts/${draftId}/publish`, `perf-measured-publish-${index}`, {}));
  const publishMs = Date.now() - publishStartedAt;
  if (publishes.some(({ status }) => status !== 201) || publishMs > 60_000) throw new Error(`gapless-publish failed in ${publishMs}ms`);
  const final = await ctx.snapshot(apiA.baseUrl);
  for (let subjectIndex = 0; subjectIndex < 2_000; subjectIndex += 1) {
    const versions = final.resources.schemaVersions.filter(({ subjectId }) => subjectId === schemaSubjectId(subjectIndex)).map(({ version }) => version);
    const expected = Array.from({ length: subjectIndex < 100 ? 12 : 11 }, (_, index) => index + 1);
    if (ctx.canonical(versions) !== ctx.canonical(expected)) throw new Error(`version gap for subject ${subjectIndex}`);
  }
  assertions.push(`gapless-publish: 2,000 versions in ${publishMs}ms with no gaps`);
  metrics.push({ scenarioId: "gapless-publish", completed: publishes.length, durationMs: publishMs });
  return { metrics, fixtureSummary: { subjects: 2_000, publishedVersions: 20_000 } };
}

const flagIds = { project: id(201), flag: id(202) };

function flagRolloutBucket(subjectKey) {
  const hash = createHash("sha256")
    .update("checkout")
    .update(Buffer.from([0]))
    .update("production")
    .update(Buffer.from([0]))
    .update(subjectKey)
    .digest();
  return Number(hash.readBigUInt64BE(0) % 10_000n);
}

const flagfoundry = {
  label: "FlagFoundry revision compilation",
  performanceScenarioIds: ["flag-evaluation", "revision-compilation", "disjoint-activation"],
  seed: async () => base("hidden-flag", {
    projects: [{ projectId: flagIds.project, name: "Hidden project" }],
    environments: [{ projectId: flagIds.project, name: "production", contextAttributes: ["country"], schemaRevision: 1 }],
    flags: [{ flagId: flagIds.flag, projectId: flagIds.project, key: "checkout", flagType: "BOOLEAN" }],
    activeRevisions: [],
  }),
  path: `/api/v1/flags/${flagIds.flag}/revisions`,
  payload: (index) => ({
    environment: "production",
    flagType: "BOOLEAN",
    defaultVariant: "off",
    variants: [
      { key: "off", value: false, allocationBasisPoints: 5000 },
      { key: "on", value: true, allocationBasisPoints: 5000 },
    ],
    rules: [],
    expectedActiveRevision: null,
    hiddenOrdinal: undefined,
  }),
  conflictPayload: () => ({
    environment: "production",
    flagType: "BOOLEAN",
    defaultVariant: "on",
    variants: [
      { key: "off", value: false, allocationBasisPoints: 5000 },
      { key: "on", value: true, allocationBasisPoints: 5000 },
    ],
    rules: [],
    expectedActiveRevision: null,
  }),
  resource: "flagRevisions",
  identity: (json) => find(json, "revisionId"),
  resourceIdentity: ({ revisionId }) => revisionId,
  performance: flagPerformance,
  async verify(ctx, baseUrl, response) {
    const firstRevisionId = find(response.json, "revisionId");
    const worker = await ctx.startWorker();
    const first = await waitForFlagRevision(ctx, baseUrl, firstRevisionId, "READY", [worker]);
    const activated = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${firstRevisionId}/activate`, "h03-activate-1", { expectedActiveRevision: null });
    if (activated.status !== 200) throw new Error(activated.text);
    const evaluationBody = {
      projectId: flagIds.project,
      flagKey: "checkout",
      environment: "production",
      context: { subjectKey: "h03-subject", country: "US" },
    };
    const evaluation = await ctx.mutate(baseUrl, "/api/v1/evaluations", "h03-evaluate-1", evaluationBody);
    if (evaluation.status !== 200 || find(evaluation.json, "snapshotDigest") !== first.snapshotDigest) throw new Error(evaluation.text);
    const replay = await ctx.mutate(baseUrl, "/api/v1/evaluations", "h03-evaluate-2", evaluationBody);
    if (ctx.canonical(replay.json) !== ctx.canonical(evaluation.json)) throw new Error("evaluation is not deterministic");

    const secondCreated = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "h03-revision-2", {
      ...flagfoundry.payload(2),
      expectedActiveRevision: 1,
    });
    const secondRevisionId = find(secondCreated.json, "revisionId");
    await waitForFlagRevision(ctx, baseUrl, secondRevisionId, "READY", [worker]);
    const diff = await ctx.request(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions/2/diff?against=1`);
    if (diff.status !== 200 || diff.json?.fromRevision !== 1 || diff.json?.toRevision !== 2) throw new Error(diff.text);
    const secondActivation = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${secondRevisionId}/activate`, "h03-activate-2", { expectedActiveRevision: 1 });
    if (secondActivation.status !== 200) throw new Error(secondActivation.text);
  },
  async atomic(ctx, baseUrl) {
    const invalidBefore = await ctx.snapshot(baseUrl);
    const invalid = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "h04-invalid-allocation", {
      ...flagfoundry.payload(4),
      variants: [
        { key: "off", value: false, allocationBasisPoints: 5000 },
        { key: "on", value: true, allocationBasisPoints: 4999 },
      ],
    });
    if (invalid.status !== 400 || invalid.json?.error?.code !== "INVALID_FLAG_RULE") throw new Error(invalid.text);
    if (ctx.canonical(stableSnapshot(await ctx.snapshot(baseUrl))) !== ctx.canonical(stableSnapshot(invalidBefore))) throw new Error("invalid Flag revision changed durable state");

    const worker = await ctx.startWorker();
    const candidate = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrl);
      return snapshot.resources.flagRevisions.find(({ state }) => state === "READY");
    }, { label: "atomic candidate READY", children: [worker] });
    const beforeActivation = await ctx.snapshot(baseUrl);
    const stale = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${candidate.revisionId}/activate`, "h04-stale-activate", { expectedActiveRevision: 999 });
    if (stale.status !== 409 || stale.json?.error?.code !== "ACTIVE_REVISION_CHANGED") throw new Error(stale.text);
    if (ctx.canonical(stableSnapshot(await ctx.snapshot(baseUrl))) !== ctx.canonical(stableSnapshot(beforeActivation))) throw new Error("stale activation changed durable state");
  },
  async contention(ctx, baseUrls) {
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const candidate = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrls[0]);
      return snapshot.resources.flagRevisions.find(({ state }) => state === "READY");
    }, { label: "contended candidate READY", children: workers });
    const activations = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
      baseUrls[index % 2],
      `/api/v1/flag-revisions/${candidate.revisionId}/activate`,
      `h06-activate-${index}`,
      { expectedActiveRevision: null },
    ));
    if (activations.filter(({ status }) => status === 200).length !== 1) throw new Error("activation CAS did not have exactly one winner");
    if (activations.some(({ status }) => ![200, 409].includes(status))) throw new Error("activation race returned an unexpected status");
    const snapshot = await ctx.snapshot(baseUrls[1]);
    const active = snapshot.resources.flagRevisions.filter(({ flagId, environment, state }) => flagId === flagIds.flag && environment === "production" && state === "ACTIVE");
    if (active.length !== 1 || active[0].revisionId !== candidate.revisionId) throw new Error("activation race violated the single active pointer");
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const revisionId = find(created.json, "revisionId");
    if (!snapshot.resources.flagRevisions.some((revision) => revision.revisionId === revisionId)) {
      throw new Error("V1 Flag revision did not survive FINAL migration");
    }
    if (snapshot.resources.progressiveRollouts.length !== 0 || snapshot.resources.evaluationOutcomes.length !== 0) {
      throw new Error("FINAL migration invented progressive rollout state");
    }
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const worker = await ctx.startWorker();
      const priorCreated = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "manager-prior-revision", flagfoundry.payload(900));
      const priorRevisionId = find(priorCreated.json, "revisionId");
      const prior = await waitForFlagRevision(ctx, baseUrl, priorRevisionId, "READY", [worker]);
      const priorActivation = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${priorRevisionId}/activate`, "manager-prior-activate", { expectedActiveRevision: null });
      if (priorActivation.status !== 200) throw new Error(priorActivation.text);
      const candidateCreated = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "manager-candidate-revision", {
        ...flagfoundry.payload(901),
        expectedActiveRevision: 1,
      });
      const revisionId = find(candidateCreated.json, "revisionId");
      const candidate = await waitForFlagRevision(ctx, baseUrl, revisionId, "READY", [worker]);
      const state = {
        priorRevisionId,
        priorDigest: prior.snapshotDigest,
        candidateRevisionId: revisionId,
        candidateDigest: candidate.snapshotDigest,
      };
      return {
        state,
        path: `/api/v1/flag-revisions/${revisionId}/progressive-activate`,
        payload: () => ({
          expectedActiveRevision: 1,
          steps: [
            { candidateExposureBasisPoints: 5000, minimumEvaluationCount: 2, maximumFailureBasisPoints: 1000, observationSeconds: 60 },
            { candidateExposureBasisPoints: 10000, minimumEvaluationCount: 2, maximumFailureBasisPoints: 1000, observationSeconds: 60 },
          ],
        }),
      };
    },
    async verify(ctx, baseUrl, response, operation) {
      const rolloutId = find(response.json, "rolloutId");
      const bucketSubjects = {};
      for (let index = 0; !bucketSubjects.candidate || !bucketSubjects.prior; index += 1) {
        const subjectKey = `manager-bucket-${index}`;
        bucketSubjects[flagRolloutBucket(subjectKey) < 5000 ? "candidate" : "prior"] ??= subjectKey;
      }
      const firstStepOutcomes = [];
      for (const [selection, subjectKey] of Object.entries(bucketSubjects)) {
        const evaluation = await ctx.mutate(baseUrl, "/api/v1/evaluations", `manager-bucket-evaluation-${selection}`, {
          projectId: flagIds.project,
          flagKey: "checkout",
          environment: "production",
          context: { subjectKey, country: "US" },
        });
        const evaluated = evaluation.json?.evaluation ?? evaluation.json;
        const expectedDigest = selection === "candidate" ? operation.state.candidateDigest : operation.state.priorDigest;
        if (evaluation.status !== 200 || evaluated?.rolloutId !== rolloutId || evaluated?.stepIndex !== 0 || evaluated?.snapshotDigest !== expectedDigest) {
          throw new Error(`rollout bucket ${selection} selected the wrong snapshot`);
        }
        firstStepOutcomes.push({
          outcomeId: `manager-bucket-outcome-${selection}`,
          stepIndex: 0,
          subjectKey,
          snapshotDigest: expectedDigest,
          outcome: "SUCCESS",
        });
      }
      const firstAccepted = await ctx.mutate(baseUrl, `/api/v1/progressive-rollouts/${rolloutId}/outcome-batches`, "manager-outcome-batch-0", { outcomes: firstStepOutcomes });
      if (firstAccepted.status < 200 || firstAccepted.status >= 300) throw new Error(firstAccepted.text);

      const secondStepOutcomes = [];
      for (let index = 0; index < 2; index += 1) {
        const subjectKey = `manager-step-1-subject-${index}`;
        const evaluation = await ctx.mutate(baseUrl, "/api/v1/evaluations", `manager-step-1-evaluation-${index}`, {
          projectId: flagIds.project,
          flagKey: "checkout",
          environment: "production",
          context: { subjectKey, country: "US" },
        });
        const evaluated = evaluation.json?.evaluation ?? evaluation.json;
        if (evaluation.status !== 200 || evaluated?.stepIndex !== 1 || evaluated?.snapshotDigest !== operation.state.candidateDigest) {
          throw new Error("10000-basis-point step did not select the candidate snapshot");
        }
        secondStepOutcomes.push({ outcomeId: `manager-step-1-outcome-${index}`, stepIndex: 1, subjectKey, snapshotDigest: operation.state.candidateDigest, outcome: "SUCCESS" });
      }
      const secondAccepted = await ctx.mutate(baseUrl, `/api/v1/progressive-rollouts/${rolloutId}/outcome-batches`, "manager-outcome-batch-1", { outcomes: secondStepOutcomes });
      if (secondAccepted.status < 200 || secondAccepted.status >= 300) throw new Error(secondAccepted.text);
      const completed = await ctx.request(baseUrl, `/api/v1/progressive-rollouts/${rolloutId}`);
      if (completed.status !== 200 || find(completed.json, "state") !== "COMPLETED") throw new Error(completed.text);

      const worker = await ctx.startWorker();
      const rollbackCreated = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "manager-rollback-candidate", {
        ...flagfoundry.payload(902),
        expectedActiveRevision: 2,
      });
      const rollbackRevisionId = find(rollbackCreated.json, "revisionId");
      const rollbackCandidate = await waitForFlagRevision(ctx, baseUrl, rollbackRevisionId, "READY", [worker]);
      const rollbackStarted = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${rollbackRevisionId}/progressive-activate`, "manager-rollback-start", {
        expectedActiveRevision: 2,
        steps: [{ candidateExposureBasisPoints: 10000, minimumEvaluationCount: 2, maximumFailureBasisPoints: 0, observationSeconds: 60 }],
      });
      if (rollbackStarted.status !== 202) throw new Error(rollbackStarted.text);
      const rollbackId = find(rollbackStarted.json, "rolloutId");
      const rollbackOutcomes = [];
      for (let index = 0; index < 2; index += 1) {
        const subjectKey = `manager-rollback-subject-${index}`;
        const evaluation = await ctx.mutate(baseUrl, "/api/v1/evaluations", `manager-rollback-evaluation-${index}`, {
          projectId: flagIds.project,
          flagKey: "checkout",
          environment: "production",
          context: { subjectKey, country: "US" },
        });
        if (find(evaluation.json, "snapshotDigest") !== rollbackCandidate.snapshotDigest) throw new Error("rollback rollout did not evaluate its candidate");
        rollbackOutcomes.push({
          outcomeId: `manager-rollback-outcome-${index}`,
          stepIndex: 0,
          subjectKey,
          snapshotDigest: rollbackCandidate.snapshotDigest,
          outcome: index === 0 ? "SUCCESS" : "FAILURE",
        });
      }
      const rolledBack = await ctx.mutate(baseUrl, `/api/v1/progressive-rollouts/${rollbackId}/outcome-batches`, "manager-rollback-outcomes", { outcomes: rollbackOutcomes });
      if (rolledBack.status < 200 || rolledBack.status >= 300) throw new Error(rolledBack.text);
      const rollbackSnapshot = await ctx.snapshot(baseUrl);
      const storedRollback = rollbackSnapshot.resources.progressiveRollouts.find((rollout) => rollout.rolloutId === rollbackId);
      const active = rollbackSnapshot.resources.flagRevisions.find(({ flagId, environment, state }) => flagId === flagIds.flag && environment === "production" && state === "ACTIVE");
      if (storedRollback?.state !== "ROLLED_BACK" || storedRollback.steps[0]?.state !== "FAILED" || storedRollback.steps[0]?.failureCount !== 1 || active?.revisionId !== operation.state.candidateRevisionId) {
        throw new Error("failure threshold did not atomically roll traffic back");
      }

      const deadlineCreated = await ctx.mutate(baseUrl, `/api/v1/flags/${flagIds.flag}/revisions`, "manager-deadline-revision", {
        ...flagfoundry.payload(904),
        expectedActiveRevision: 2,
      });
      const deadlineRevisionId = find(deadlineCreated.json, "revisionId");
      const deadlineCandidate = await waitForFlagRevision(ctx, baseUrl, deadlineRevisionId, "READY", [worker]);
      const deadlineStarted = await ctx.mutate(baseUrl, `/api/v1/flag-revisions/${deadlineRevisionId}/progressive-activate`, "manager-deadline-start", {
        expectedActiveRevision: 2,
        steps: [{ candidateExposureBasisPoints: 10000, minimumEvaluationCount: 2, maximumFailureBasisPoints: 0, observationSeconds: 1 }],
      });
      if (deadlineStarted.status < 200 || deadlineStarted.status >= 300) throw new Error(deadlineStarted.text);
      const deadlineRolloutId = find(deadlineStarted.json, "rolloutId");
      let releaseDeadline;
      const heldDeadline = new Promise((resolve) => { releaseDeadline = resolve; });
      const deadlineBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? heldDeadline : { status: 204 });
      const deadlineWorker = await ctx.startWorker({ TEST_BARRIER_URL: deadlineBarrier.url, TEST_BARRIER_TOKEN: "h10-flag-deadline" });
      await ctx.waitFor(() => deadlineBarrier.ledger.some((entry) => entry.json?.point === "worker.claimed"), { label: "rollout deadline claimed", children: [deadlineWorker] });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const deadlineOutcome = await ctx.mutate(baseUrl, `/api/v1/progressive-rollouts/${deadlineRolloutId}/outcome-batches`, "manager-deadline-outcome", {
        outcomes: [{ outcomeId: "manager-deadline-outcome", stepIndex: 0, subjectKey: "manager-deadline-subject", snapshotDigest: deadlineCandidate.snapshotDigest, outcome: "SUCCESS" }],
      });
      if (deadlineOutcome.status !== 409 || deadlineOutcome.json?.error?.code !== "OUTCOME_WINDOW_CLOSED") throw new Error(deadlineOutcome.text);
      const beforeDeadlineRelease = await ctx.snapshot(baseUrl);
      if (beforeDeadlineRelease.resources.evaluationOutcomes.some(({ outcomeId }) => outcomeId === "manager-deadline-outcome")) throw new Error("closed rollout accepted an outcome");
      await ctx.stop(deadlineWorker, "SIGKILL");
      releaseDeadline({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const deadlineReplacement = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const rollout = value.resources.progressiveRollouts.find(({ rolloutId }) => rolloutId === deadlineRolloutId);
        const pending = value.work.some(({ aggregateId, terminal }) => aggregateId === deadlineRolloutId && !terminal);
        return rollout?.state === "ROLLED_BACK" && !pending ? value : undefined;
      }, { label: "rollout deadline rollback", children: [deadlineReplacement] });
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const rolloutId = find(response.json, "rolloutId");
      const subjectKey = "manager-concurrent-subject";
      const evaluation = await ctx.mutate(baseUrls[0], "/api/v1/evaluations", "manager-concurrent-evaluation", {
        projectId: flagIds.project,
        flagKey: "checkout",
        environment: "production",
        context: { subjectKey, country: "US" },
      });
      const outcome = {
        outcomeId: "manager-concurrent-outcome",
        stepIndex: 0,
        subjectKey,
        snapshotDigest: find(evaluation.json, "snapshotDigest"),
        outcome: "SUCCESS",
      };
      const attempts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        `/api/v1/progressive-rollouts/${rolloutId}/outcome-batches`,
        `manager-concurrent-outcome-batch-${index}`,
        { outcomes: [outcome] },
      ));
      if (attempts.some(({ status }) => status < 200 || status >= 300)) throw new Error("concurrent outcome replay failed");
      let snapshot = await ctx.snapshot(baseUrls[0]);
      if (snapshot.resources.evaluationOutcomes.filter(({ outcomeId }) => outcomeId === outcome.outcomeId).length !== 1) throw new Error("concurrent outcome replay created duplicates");

      const worker = await ctx.startWorker();
      const superseding = await ctx.mutate(baseUrls[0], `/api/v1/flags/${flagIds.flag}/revisions`, "manager-superseding-revision", {
        ...flagfoundry.payload(903),
        expectedActiveRevision: 1,
      });
      const supersedingId = find(superseding.json, "revisionId");
      await waitForFlagRevision(ctx, baseUrls[0], supersedingId, "READY", [worker]);
      const activated = await ctx.mutate(baseUrls[1], `/api/v1/flag-revisions/${supersedingId}/activate`, "manager-superseding-activate", { expectedActiveRevision: 1 });
      if (activated.status !== 200) throw new Error(activated.text);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.progressiveRollouts.some((rollout) => rollout.rolloutId === rolloutId && rollout.state === "STALE") ? value : undefined;
      }, { label: "progressive rollout STALE after immediate activation" });
      const late = await ctx.mutate(baseUrls[0], `/api/v1/progressive-rollouts/${rolloutId}/outcome-batches`, "manager-stale-outcome", {
        outcomes: [{ ...outcome, outcomeId: "manager-stale-outcome" }],
      });
      const active = snapshot.resources.flagRevisions.find(({ flagId, environment, state }) => flagId === flagIds.flag && environment === "production" && state === "ACTIVE");
      if (late.status !== 409 || late.json?.error?.code !== "ROLLOUT_STALE" || active?.revisionId !== supersedingId) {
        throw new Error("immediate activation did not fence the stale rollout");
      }
    },
  },
  uiPattern: /flag|revision|environment/iu,
};

async function waitForFlagRevision(ctx, baseUrl, revisionId, state, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.resources.flagRevisions.find((revision) => revision.revisionId === revisionId && revision.state === state);
  }, { timeoutMs: 30_000, label: `Flag revision ${revisionId} ${state}`, children });
}

function flagPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function flagPerfPair(index) {
  const projectIndex = Math.floor(index / 50);
  return {
    projectId: flagPerfUuid("23000000", projectIndex),
    flagId: flagPerfUuid("24000000", index),
    revisionId: flagPerfUuid("25000000", index),
    flagKey: `flag-${String(index).padStart(4, "0")}`,
    environment: `environment-${index % 3}`,
  };
}

function flagVariants() {
  return [
    { key: "off", value: false, allocationBasisPoints: 5000 },
    { key: "on", value: true, allocationBasisPoints: 5000 },
  ];
}

function flagSnapshot(pair, revisionId, revision, rules = []) {
  return {
    snapshotVersion: 1,
    projectId: pair.projectId,
    flagId: pair.flagId,
    flagKey: pair.flagKey,
    environment: pair.environment,
    revisionId,
    revision,
    flagType: "BOOLEAN",
    defaultVariant: "off",
    variants: flagVariants(),
    rules,
    contextAttributes: ["region", "subjectKey", "tier"],
    contextSchemaRevision: 1,
  };
}

function flagPerfSeed() {
  const projects = Array.from({ length: 100 }, (_, index) => ({
    projectId: flagPerfUuid("23000000", index),
    name: `Project ${String(index).padStart(3, "0")}`,
  }));
  const environments = projects.flatMap(({ projectId }) => Array.from({ length: 3 }, (_, index) => ({
    projectId,
    name: `environment-${index}`,
    contextAttributes: ["region", "subjectKey", "tier"],
    schemaRevision: 1,
  })));
  const flags = [];
  const activeRevisions = [];
  for (let index = 0; index < 5_000; index += 1) {
    const pair = flagPerfPair(index);
    flags.push({ flagId: pair.flagId, projectId: pair.projectId, key: pair.flagKey, flagType: "BOOLEAN" });
    const snapshot = flagSnapshot(pair, pair.revisionId, 1);
    activeRevisions.push({
      revisionId: pair.revisionId,
      flagId: pair.flagId,
      environment: pair.environment,
      revision: 1,
      flagType: "BOOLEAN",
      defaultVariant: "off",
      variants: flagVariants(),
      rules: [],
      state: "ACTIVE",
      snapshotDigest: digest(canonicalJson(snapshot)),
      createdAt: timestamp,
      activatedAt: timestamp,
      sequence: 1,
    });
  }
  return base("perf-v1", { projects, environments, flags, activeRevisions });
}

async function prepareFlagPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(flagPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

function flagCompilationPayload(ordinal, expectedActiveRevision = 1) {
  const pair = flagPerfPair(ordinal % 5_000);
  const rules = Array.from({ length: 10 }, (_, ruleIndex) => ({
    ruleId: flagPerfUuid("26000000", ordinal * 10 + ruleIndex),
    clauses: [{ attribute: ruleIndex % 2 ? "region" : "tier", operator: "EQUALS", value: ruleIndex % 2 ? "us" : "pro" }],
    variantKey: ruleIndex % 2 ? "on" : "off",
  }));
  return {
    pair,
    body: {
      environment: pair.environment,
      flagType: "BOOLEAN",
      defaultVariant: "off",
      variants: flagVariants(),
      rules,
      expectedActiveRevision,
    },
  };
}

async function createReadyFlagRevisions(ctx, baseUrls, workers, count, offset, keyPrefix) {
  const created = await ctx.concurrent(Array.from({ length: count }, (_, index) => index + offset), 64, async (ordinal, index) => {
    const input = flagCompilationPayload(ordinal);
    const response = await ctx.mutate(baseUrls[index % baseUrls.length], `/api/v1/flags/${input.pair.flagId}/revisions`, `${keyPrefix}-${ordinal}`, input.body);
    if (response.status !== 202) throw new Error(response.text);
    return { pair: input.pair, revisionId: find(response.json, "revisionId"), createdAt: performance.now() };
  });
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const ready = new Set(snapshot.resources.flagRevisions.filter(({ state }) => state === "READY").map(({ revisionId }) => revisionId));
    return created.every(({ revisionId }) => ready.has(revisionId));
  }, { timeoutMs: 60_000, label: `${count} compiled Flag revisions`, children: workers });
  const snapshot = await ctx.snapshot(baseUrls[0]);
  const byId = new Map(snapshot.resources.flagRevisions.map((revision) => [revision.revisionId, revision]));
  return created.map((entry) => ({ ...entry, snapshotDigest: byId.get(entry.revisionId)?.snapshotDigest }));
}

async function flagPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareFlagPerf(ctx);
  let evaluationOrdinal = 0;
  const firstEvaluation = new Map();
  const evaluations = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = evaluationOrdinal++;
      const pair = flagPerfPair(ordinal % 5_000);
      const subjectKey = `perf-subject-${ordinal % 100_000}`;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/evaluations", {
        method: "POST",
        headers: { "idempotency-key": `perf-evaluation-${ordinal}` },
        json: { projectId: pair.projectId, flagKey: pair.flagKey, environment: pair.environment, context: { subjectKey, region: "us", tier: "pro" } },
      });
      if (response.status !== 200) throw new Error(response.text);
      const identity = `${pair.flagId}:${subjectKey}`;
      const result = `${find(response.json, "snapshotDigest")}:${find(response.json, "variantKey")}:${find(response.json, "reason")}`;
      if (firstEvaluation.has(identity) && firstEvaluation.get(identity) !== result) throw new Error("repeat evaluation changed result");
      firstEvaluation.set(identity, result);
      return response;
    },
  });
  if (evaluations.throughput < 2_000 || evaluations.p95 > 40 || Object.keys(evaluations.statuses).some((status) => Number(status) >= 500)) {
    throw new Error(`flag-evaluation failed: ${evaluations.throughput}/s p95=${evaluations.p95}`);
  }
  assertions.push(`flag-evaluation: ${evaluations.throughput.toFixed(1)}/s, p95 ${evaluations.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "flag-evaluation", ...evaluations });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareFlagPerf(ctx));
  const compilationWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  let compilationOrdinal = 0;
  const measuredRevisions = new Map();
  const compilations = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const ordinal = compilationOrdinal++;
      const input = flagCompilationPayload(ordinal);
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/flags/${input.pair.flagId}/revisions`, `perf-compilation-${ordinal}`, input.body);
      if (response.status !== 202) throw new Error(response.text);
      if (measured) measuredRevisions.set(find(response.json, "revisionId"), performance.now());
      return response;
    },
  });
  const readyAt = new Map();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const observedAt = performance.now();
    for (const revision of snapshot.resources.flagRevisions) {
      if (measuredRevisions.has(revision.revisionId) && revision.state === "READY" && !readyAt.has(revision.revisionId)) readyAt.set(revision.revisionId, observedAt);
      if (measuredRevisions.has(revision.revisionId) && revision.state === "REJECTED") throw new Error(`measured revision ${revision.revisionId} was rejected`);
    }
    return readyAt.size === measuredRevisions.size;
  }, { timeoutMs: 60_000, label: "measured Flag compilations", children: compilationWorkers });
  const queueLatencies = [...readyAt].map(([revisionId, endedAt]) => endedAt - measuredRevisions.get(revisionId)).sort((left, right) => left - right);
  const readyRate = readyAt.size / (60 * scale);
  const queueP95 = percentile(queueLatencies, 0.95);
  if (readyRate < 100 || queueP95 > 2_000) throw new Error(`revision-compilation failed: ${readyRate}/s queue p95=${queueP95}`);
  assertions.push(`revision-compilation: ${readyRate.toFixed(1)} READY/s, queue p95 ${queueP95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "revision-compilation", ...compilations, ready: readyAt.size, readyRate, queueP95 });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareFlagPerf(ctx));
  const activationWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const warmupCandidates = await createReadyFlagRevisions(ctx, [apiA.baseUrl, apiB.baseUrl], activationWorkers, 500, 500, "perf-activation-warmup");
  const measuredCandidates = await createReadyFlagRevisions(ctx, [apiA.baseUrl, apiB.baseUrl], activationWorkers, 500, 0, "perf-activation-measured");
  const warmupStartedAt = Date.now();
  const warmup = await ctx.concurrent(warmupCandidates, 64, (candidate, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/flag-revisions/${candidate.revisionId}/activate`,
    `perf-warmup-activate-${index}`,
    { expectedActiveRevision: 1 },
  ));
  if (warmup.some(({ status }) => status !== 200)) throw new Error("activation warm-up failed");
  const warmupRemainingMs = 10_000 * scale - (Date.now() - warmupStartedAt);
  if (warmupRemainingMs > 0) await new Promise((resolve) => setTimeout(resolve, warmupRemainingMs));
  const allowedDigests = new Map(measuredCandidates.map((candidate, index) => {
    const prior = flagPerfPair(index);
    const priorDigest = digest(canonicalJson(flagSnapshot(prior, prior.revisionId, 1)));
    return [prior.flagId, new Set([priorDigest, candidate.snapshotDigest])];
  }));
  let keepEvaluating = true;
  let evaluationSequence = 0;
  const evaluationProbe = ctx.concurrent(Array.from({ length: 16 }), 16, async () => {
    while (keepEvaluating) {
      const ordinal = evaluationSequence++;
      const pair = flagPerfPair(ordinal % 500);
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/evaluations", {
        method: "POST",
        headers: { "idempotency-key": `perf-activation-evaluation-${ordinal}` },
        json: { projectId: pair.projectId, flagKey: pair.flagKey, environment: pair.environment, context: { subjectKey: `activation-${ordinal}`, region: "us", tier: "pro" } },
      });
      if (response.status !== 200 || !allowedDigests.get(pair.flagId).has(find(response.json, "snapshotDigest"))) throw new Error("evaluation observed a mixed Flag snapshot");
    }
  });
  const activationStartedAt = Date.now();
  let activations;
  try {
    activations = await ctx.concurrent(measuredCandidates, 64, (candidate, index) => ctx.mutate(
      index % 2 ? apiA.baseUrl : apiB.baseUrl,
      `/api/v1/flag-revisions/${candidate.revisionId}/activate`,
      `perf-measured-activate-${index}`,
      { expectedActiveRevision: 1 },
    ));
  } finally {
    keepEvaluating = false;
    await evaluationProbe;
  }
  const activationMs = Date.now() - activationStartedAt;
  if (activationMs > 60_000 || activations.some(({ status }) => status !== 200)) throw new Error(`disjoint-activation failed in ${activationMs}ms`);
  const final = await ctx.snapshot(apiA.baseUrl);
  for (const candidate of measuredCandidates) {
    const active = final.resources.flagRevisions.filter(({ flagId, environment, state }) => flagId === candidate.pair.flagId && environment === candidate.pair.environment && state === "ACTIVE");
    if (active.length !== 1 || active[0].revisionId !== candidate.revisionId) throw new Error(`mixed or missing active snapshot for ${candidate.pair.flagId}`);
  }
  const activationLatencies = activations.map(({ durationMs }) => durationMs).sort((left, right) => left - right);
  const activationMetrics = {
    scenarioId: "disjoint-activation",
    completed: activations.length,
    durationMs: activationMs,
    throughput: activations.length / (activationMs / 1_000),
    p50: percentile(activationLatencies, 0.5),
    p95: percentile(activationLatencies, 0.95),
    p99: percentile(activationLatencies, 0.99),
    statuses: Object.fromEntries([...new Set(activations.map(({ status }) => status))].map((status) => [status, activations.filter((result) => result.status === status).length])),
  };
  assertions.push(`disjoint-activation: 500 revisions in ${activationMs}ms with one active snapshot per pair`);
  metrics.push(activationMetrics);
  return { metrics, fixtureSummary: { projects: 100, environments: 300, flags: 5_000, activeRevisions: 5_000 } };
}

const reconcileIds = { ledger: id(301), ledgerB: id(302), ledgerC: id(303) };
const reconcilehub = {
  label: "ReconcileHub statement import",
  performanceScenarioIds: ["statement-batch-import", "reconciliation-review", "suggestion-generation"],
  seed: async () => base("hidden-reconcile", {
    ledgerEntries: [
      { ledgerEntryId: reconcileIds.ledger, postedAt: "2026-08-01", currency: "USD", amountMinor: 5000, reference: "invoice-1", state: "UNMATCHED", revision: 1 },
      { ledgerEntryId: reconcileIds.ledgerB, postedAt: "2026-08-02", currency: "USD", amountMinor: 7000, reference: "invoice-2", state: "UNMATCHED", revision: 1 },
      { ledgerEntryId: reconcileIds.ledgerC, postedAt: "2026-08-03", currency: "USD", amountMinor: 5000, reference: "invoice-3", state: "UNMATCHED", revision: 1 },
    ],
    statementBatches: [],
    matches: [],
  }),
  path: "/api/v1/statement-batches",
  payload: (index) => ({
    source: "hidden-bank",
    batchKey: `batch-${index}`,
    lines: [{ externalId: `line-${index}`, bookedAt: "2026-08-01", currency: "USD", amountMinor: 5000, reference: "invoice-1" }],
  }),
  conflictPayload: () => ({
    source: "hidden-bank",
    batchKey: "batch-0",
    lines: [{ externalId: "changed", bookedAt: "2026-08-01", currency: "USD", amountMinor: 6000, reference: "changed" }],
  }),
  resource: "statementBatches",
  identity: (json) => find(json, "batchId"),
  resourceIdentity: ({ batchId }) => batchId,
  performance: reconcilePerformance,
  async verify(ctx, baseUrl, response) {
    const batchId = find(response.json, "batchId");
    const snapshot = await ctx.snapshot(baseUrl);
    const line = snapshot.resources.statementLines.find((item) => item.batchId === batchId);
    const proposed = await ctx.mutate(baseUrl, "/api/v1/matches", "h03-propose", {
      statementLineId: line.statementLineId,
      ledgerEntryId: reconcileIds.ledger,
    });
    if (proposed.status !== 201 || find(proposed.json, "state") !== "PROPOSED") throw new Error(proposed.text);
    const matchId = find(proposed.json, "matchId");
    const confirmed = await ctx.mutate(baseUrl, `/api/v1/matches/${matchId}/confirm`, "h03-confirm", {
      expectedLineRevision: 1,
      expectedLedgerRevision: 1,
    });
    if (confirmed.status !== 200 || find(confirmed.json, "state") !== "CONFIRMED") throw new Error(confirmed.text);
    const reversed = await ctx.mutate(baseUrl, `/api/v1/matches/${matchId}/reverse`, "h03-reverse", { reason: "Harness reversal" });
    if (reversed.status !== 200 || find(reversed.json, "state") !== "REVERSED") throw new Error(reversed.text);
    const final = await ctx.snapshot(baseUrl);
    const finalLine = final.resources.statementLines.find(({ statementLineId }) => statementLineId === line.statementLineId);
    const finalLedger = final.resources.ledgerEntries.find(({ ledgerEntryId }) => ledgerEntryId === reconcileIds.ledger);
    if (finalLine.state !== "UNMATCHED" || finalLedger.state !== "UNMATCHED" || finalLine.revision !== 3 || finalLedger.revision !== 3) {
      throw new Error("reversal did not restore both members exactly once");
    }
  },
  async atomic(ctx, baseUrl) {
    const imported = await ctx.mutate(baseUrl, "/api/v1/statement-batches", "h04-mismatch-batch", {
      source: "hidden-bank",
      batchKey: "mismatch-batch",
      lines: [{ externalId: "mismatch-line", bookedAt: "2026-08-01", currency: "USD", amountMinor: 6000, reference: "mismatch" }],
    });
    if (imported.status !== 202) throw new Error(imported.text);
    const seeded = await ctx.snapshot(baseUrl);
    const line = seeded.resources.statementLines.find(({ externalId }) => externalId === "mismatch-line");
    const rejected = await ctx.mutate(baseUrl, "/api/v1/matches", "h04-amount-mismatch", {
      statementLineId: line.statementLineId,
      ledgerEntryId: reconcileIds.ledger,
    });
    if (rejected.status !== 409 || rejected.json?.error?.code !== "MATCH_AMOUNT_MISMATCH") throw new Error(rejected.text);
    if (ctx.canonical(stableSnapshot(await ctx.snapshot(baseUrl))) !== ctx.canonical(stableSnapshot(seeded))) throw new Error("amount mismatch changed durable state");
  },
  async contention(ctx, baseUrls) {
    const imported = await ctx.mutate(baseUrls[0], "/api/v1/statement-batches", "h06-second-line", {
      source: "hidden-bank",
      batchKey: "contention-second",
      lines: [{ externalId: "contention-second", bookedAt: "2026-08-01", currency: "USD", amountMinor: 5000, reference: "invoice-1" }],
    });
    if (imported.status !== 202) throw new Error(imported.text);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const lines = snapshot.resources.statementLines.filter(({ state, amountMinor }) => state === "UNMATCHED" && amountMinor === 5000).slice(0, 2);
    if (lines.length !== 2) throw new Error("contention setup did not produce two lines");
    const proposals = await Promise.all(lines.map((line, index) => ctx.mutate(baseUrls[index], "/api/v1/matches", `h06-proposal-${index}`, {
      statementLineId: line.statementLineId,
      ledgerEntryId: reconcileIds.ledger,
    })));
    if (proposals.some(({ status }) => status !== 201)) throw new Error("contention proposals failed");
    const confirmations = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
      baseUrls[index % 2],
      `/api/v1/matches/${find(proposals[index % 2].json, "matchId")}/confirm`,
      `h06-confirm-${index}`,
      { expectedLineRevision: 1, expectedLedgerRevision: 1 },
    ));
    if (confirmations.filter(({ status }) => status === 200).length !== 1 || confirmations.some(({ status }) => ![200, 409].includes(status))) {
      throw new Error("shared Ledger Entry confirmation race did not have one winner");
    }
    const final = await ctx.snapshot(baseUrls[1]);
    if (final.resources.matches.filter(({ state }) => state === "CONFIRMED").length !== 1) throw new Error("confirmation race created multiple active matches");
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const imported = await ctx.mutate(baseUrl, "/api/v1/statement-batches", "manager-batch", {
        source: "manager-bank",
        batchKey: "manager-batch",
        lines: [
          { externalId: "manager-line-1", bookedAt: "2026-08-01", currency: "USD", amountMinor: 4000, reference: "group-1" },
          { externalId: "manager-line-2", bookedAt: "2026-08-02", currency: "USD", amountMinor: 8000, reference: "group-2" },
          { externalId: "manager-line-3", bookedAt: "2026-08-03", currency: "USD", amountMinor: 6000, reference: "group-3" },
        ],
      });
      if (imported.status !== 202) throw new Error(imported.text);
      const snapshot = await ctx.snapshot(baseUrl);
      const lineIds = ["manager-line-1", "manager-line-2"].map((externalId) => snapshot.resources.statementLines.find((line) => line.externalId === externalId)?.statementLineId);
      if (lineIds.some((lineId) => !lineId)) throw new Error("Manager batch did not create the 2x2 Statement Line set");
      return {
        path: "/api/v1/match-groups",
        payload: () => ({ statementLineIds: lineIds, ledgerEntryIds: [reconcileIds.ledger, reconcileIds.ledgerB] }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const group = response.json?.matchGroup ?? response.json;
      if (group.statementLineIds?.length !== 2 || group.ledgerEntryIds?.length !== 2
        || group.statementTotalMinor !== 12000 || group.ledgerTotalMinor !== 12000
        || group.matchId !== null || group.statementLineId !== null || group.ledgerEntryId !== null) {
        throw new Error("2x2 Match Group did not preserve totals and null legacy fields");
      }
      const confirmed = await ctx.mutate(baseUrl, `/api/v1/match-groups/${group.matchGroupId}/confirm`, "h10-group-confirm", {
        expectedStatementLineRevisions: Object.fromEntries(group.statementLineIds.map((memberId) => [memberId, 1])),
        expectedLedgerEntryRevisions: Object.fromEntries(group.ledgerEntryIds.map((memberId) => [memberId, 1])),
      });
      if (confirmed.status !== 200 || find(confirmed.json, "state") !== "CONFIRMED") throw new Error(confirmed.text);
      let snapshot = await ctx.snapshot(baseUrl);
      const confirmedLines = snapshot.resources.statementLines.filter(({ statementLineId }) => group.statementLineIds.includes(statementLineId));
      const confirmedLedgers = snapshot.resources.ledgerEntries.filter(({ ledgerEntryId }) => group.ledgerEntryIds.includes(ledgerEntryId));
      if ([...confirmedLines, ...confirmedLedgers].some(({ state, revision }) => state !== "MATCHED" || revision !== 2)) {
        throw new Error("2x2 confirmation did not atomically update every member");
      }
      const reversed = await ctx.mutate(baseUrl, `/api/v1/match-groups/${group.matchGroupId}/reverse`, "h10-group-reverse", { reason: "Harness full-group reversal" });
      if (reversed.status !== 200 || find(reversed.json, "state") !== "REVERSED") throw new Error(reversed.text);
      snapshot = await ctx.snapshot(baseUrl);
      const reversedLines = snapshot.resources.statementLines.filter(({ statementLineId }) => group.statementLineIds.includes(statementLineId));
      const reversedLedgers = snapshot.resources.ledgerEntries.filter(({ ledgerEntryId }) => group.ledgerEntryIds.includes(ledgerEntryId));
      if ([...reversedLines, ...reversedLedgers].some(({ state, revision }) => state !== "UNMATCHED" || revision !== 3)) {
        throw new Error("2x2 reversal did not release every member exactly once");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const first = response.json?.matchGroup ?? response.json;
      const snapshot = await ctx.snapshot(baseUrls[0]);
      const competingLineIds = ["manager-line-1", "manager-line-3"].map((externalId) => snapshot.resources.statementLines.find((line) => line.externalId === externalId)?.statementLineId);
      if (competingLineIds.some((lineId) => !lineId)) throw new Error("Competing Match Group is missing a Statement Line");
      const competing = await ctx.mutate(baseUrls[1], "/api/v1/match-groups", "h11-competing-group", {
        statementLineIds: competingLineIds,
        ledgerEntryIds: [reconcileIds.ledger, reconcileIds.ledgerC],
      });
      if (competing.status !== 201) throw new Error(competing.text);
      const second = competing.json?.matchGroup ?? competing.json;
      const attempts = await Promise.all([first, second].map((group, index) => ctx.mutate(
        baseUrls[index],
        `/api/v1/match-groups/${group.matchGroupId}/confirm`,
        `h11-group-confirm-${index}`,
        {
          expectedStatementLineRevisions: Object.fromEntries(group.statementLineIds.map((memberId) => [memberId, 1])),
          expectedLedgerEntryRevisions: Object.fromEntries(group.ledgerEntryIds.map((memberId) => [memberId, 1])),
        },
      )));
      if (attempts.filter(({ status }) => status === 200).length !== 1
        || attempts.filter(({ status, json }) => status === 409 && json?.error?.code === "MATCH_GROUP_MEMBER_CONFLICT").length !== 1) {
        throw new Error("Overlapping Match Group confirmations did not have one atomic winner");
      }
      const final = await ctx.snapshot(baseUrls[1]);
      const winner = final.resources.matchGroups.find(({ matchGroupId, state }) => [first.matchGroupId, second.matchGroupId].includes(matchGroupId) && state === "CONFIRMED");
      if (!winner || final.resources.matchGroups.filter(({ matchGroupId, state }) => [first.matchGroupId, second.matchGroupId].includes(matchGroupId) && state === "CONFIRMED").length !== 1) {
        throw new Error("Match Group race persisted more or fewer than one winner");
      }
      const managedLines = final.resources.statementLines.filter(({ externalId }) => externalId.startsWith("manager-line-"));
      const managedLedgers = final.resources.ledgerEntries.filter(({ ledgerEntryId }) => [reconcileIds.ledger, reconcileIds.ledgerB, reconcileIds.ledgerC].includes(ledgerEntryId));
      if (managedLines.some((line) => (line.state === "MATCHED") !== winner.statementLineIds.includes(line.statementLineId))
        || managedLedgers.some((entry) => (entry.state === "MATCHED") !== winner.ledgerEntryIds.includes(entry.ledgerEntryId))) {
        throw new Error("Losing Match Group confirmation partially changed a member");
      }
    },
  },
  uiPattern: /reconcil|statement|ledger/iu,
};

function reconcilePerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function reconcileLine(index, batchId) {
  return {
    statementLineId: reconcilePerfUuid("31000000", index),
    batchId,
    externalId: `seed-line-${String(index).padStart(5, "0")}`,
    bookedAt: "2026-01-02",
    currency: index % 2 ? "EUR" : "USD",
    amountMinor: index + 1,
    reference: `reference-${index}`,
    state: index < 10_000 ? "MATCHED" : "UNMATCHED",
    revision: index < 10_000 ? 2 : 1,
  };
}

function reconcilePerfSeed() {
  const ledgerEntries = Array.from({ length: 20_000 }, (_, index) => ({
    ledgerEntryId: reconcilePerfUuid("32000000", index),
    postedAt: "2026-01-01",
    currency: index % 2 ? "EUR" : "USD",
    amountMinor: index + 1,
    reference: `reference-${index}`,
    state: index < 10_000 ? "MATCHED" : "UNMATCHED",
    revision: index < 10_000 ? 2 : 1,
  }));
  const statementBatches = Array.from({ length: 200 }, (_, batchIndex) => {
    const batchId = reconcilePerfUuid("33000000", batchIndex);
    const completeLines = Array.from({ length: 100 }, (_, lineIndex) => reconcileLine(batchIndex * 100 + lineIndex, batchId));
    const lines = completeLines.map(({ batchId: _batchId, revision: _revision, ...line }) => line);
    const source = "perf-bank";
    const batchKey = `seed-batch-${String(batchIndex).padStart(3, "0")}`;
    return {
      batchId,
      source,
      batchKey,
      digest: digest(canonicalJson({ source, batchKey, lines: lines.map(({ statementLineId: _id, state: _state, ...line }) => line) })),
      createdAt: timestamp,
      lines,
    };
  });
  const matches = Array.from({ length: 10_000 }, (_, index) => ({
    matchId: reconcilePerfUuid("34000000", index),
    statementLineId: reconcilePerfUuid("31000000", index),
    ledgerEntryId: reconcilePerfUuid("32000000", index),
    state: "CONFIRMED",
    score: 950,
    reasons: ["equal currency and amount", "date distance 1", "exact reference"],
    createdAt: timestamp,
    confirmedAt: timestamp,
    reversedAt: null,
    sequence: 2,
  }));
  return base("perf-v1", { ledgerEntries, statementBatches, matches });
}

async function prepareReconcilePerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(reconcilePerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

function reconcileImportPayload(ordinal) {
  const source = `load-bank-${String(ordinal % 10).padStart(2, "0")}`;
  const batchKey = `load-batch-${String(ordinal).padStart(5, "0")}`;
  return {
    source,
    batchKey,
    lines: Array.from({ length: 100 }, (_, lineIndex) => ({
      externalId: `load-${String(ordinal).padStart(5, "0")}-${String(lineIndex).padStart(3, "0")}`,
      bookedAt: `2026-02-${String((lineIndex % 28) + 1).padStart(2, "0")}`,
      currency: lineIndex % 2 ? "EUR" : "USD",
      amountMinor: ordinal * 100 + lineIndex + 1,
      reference: `load-reference-${ordinal}-${lineIndex}`,
    })).sort((left, right) => left.bookedAt.localeCompare(right.bookedAt) || left.externalId.localeCompare(right.externalId)),
  };
}

function latencyMetrics(scenarioId, responses, durationMs) {
  const latencies = responses.map(({ durationMs: latency }) => latency).sort((left, right) => left - right);
  const statuses = Object.fromEntries([...new Set(responses.map(({ status }) => status))].map((status) => [status, responses.filter((response) => response.status === status).length]));
  return {
    scenarioId,
    completed: responses.length,
    durationMs,
    throughput: responses.length / (durationMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses,
  };
}

async function reconcilePerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareReconcilePerf(ctx);
  const warmupStartedAt = Date.now();
  const warmup = await ctx.concurrent(Array.from({ length: 500 }, (_, index) => index), 64, (ordinal) => ctx.mutate(
    ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/statement-batches",
    `perf-import-warmup-${ordinal}`,
    reconcileImportPayload(ordinal),
  ));
  if (warmup.some(({ status }) => status !== 202)) throw new Error("statement import warm-up failed");
  const warmupRemainingMs = 10_000 * scale - (Date.now() - warmupStartedAt);
  if (warmupRemainingMs > 0) await new Promise((resolve) => setTimeout(resolve, warmupRemainingMs));
  const importStartedAt = Date.now();
  const imports = await ctx.concurrent(Array.from({ length: 3_000 }, (_, index) => index + 500), 64, (ordinal) => ctx.mutate(
    ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/statement-batches",
    `perf-import-measured-${ordinal}`,
    reconcileImportPayload(ordinal),
  ));
  const importMs = Date.now() - importStartedAt;
  const importMetrics = latencyMetrics("statement-batch-import", imports, importMs);
  if (imports.some(({ status }) => status !== 202) || importMetrics.throughput < 50 || importMetrics.p95 > 500 || importMs > 60_000) {
    throw new Error(`statement-batch-import failed: ${importMetrics.throughput}/s p95=${importMetrics.p95}`);
  }
  const importedSnapshot = await ctx.snapshot(apiA.baseUrl);
  if (importedSnapshot.resources.statementLines.length !== 20_000 + 350_000) throw new Error("statement batch import was partial");
  assertions.push(`statement-batch-import: ${importMetrics.throughput.toFixed(1)}/s, p95 ${importMetrics.p95.toFixed(1)}ms`);
  metrics.push(importMetrics);

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareReconcilePerf(ctx));
  let reviewOrdinal = 0;
  const review = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const response = await ctx.request(reviewOrdinal++ % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/reconciliation-work?state=UNMATCHED&limit=100");
      if (response.status !== 200 || !Array.isArray(response.json?.statementLines) || !Array.isArray(response.json?.ledgerEntries) || !Array.isArray(response.json?.suggestions)) throw new Error(response.text);
      return response;
    },
  });
  if (review.throughput < 250 || review.p95 > 180 || Object.keys(review.statuses).some((status) => Number(status) >= 500)) throw new Error(`reconciliation-review failed: ${review.throughput}/s p95=${review.p95}`);
  assertions.push(`reconciliation-review: ${review.throughput.toFixed(1)}/s, p95 ${review.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "reconciliation-review", ...review });

  await ctx.resetDatabase();
  ({ apiA } = await prepareReconcilePerf(ctx));
  const suggestionStartedAt = Date.now();
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const proposed = snapshot.resources.matches.filter(({ state }) => state === "PROPOSED");
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "MATCH_SUGGESTION" && !terminal);
    return proposed.length === 10_000 && pending.length === 0 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "10,000 one-to-one suggestions", children: workers });
  const suggestionMs = Date.now() - suggestionStartedAt;
  const proposed = final.resources.matches.filter(({ state }) => state === "PROPOSED");
  if (new Set(proposed.map(({ statementLineId }) => statementLineId)).size !== 10_000 || new Set(proposed.map(({ ledgerEntryId }) => ledgerEntryId)).size !== 10_000) {
    throw new Error("suggestion generation reused a member");
  }
  if (final.resources.matches.filter(({ state }) => state === "CONFIRMED").length !== 10_000) throw new Error("suggestion generation changed confirmed history");
  assertions.push(`suggestion-generation: 10,000 proposals in ${suggestionMs}ms with no member reuse`);
  metrics.push({ scenarioId: "suggestion-generation", completed: 10_000, durationMs: suggestionMs, workers: 2 });
  return { metrics, fixtureSummary: { ledgerEntries: 20_000, statementBatches: 200, statementLines: 20_000, confirmedMatches: 10_000 } };
}

const evidenceIds = {
  case: id(401), item: id(402), facility: id(403), custodian: id(404), device: id(405), aliquotA: id(406), aliquotB: id(407),
};

function assertCompositeGroup(snapshot, group, splitId) {
  const members = group?.members ?? [];
  const aliquots = snapshot.resources.aliquots.filter(({ parentItemId }) => parentItemId === evidenceIds.item);
  const scans = new Map(snapshot.resources.intakeScans.map((scan) => [scan.intakeScanId, scan]));
  const byId = new Map(aliquots.map((aliquot) => [aliquot.aliquotId, aliquot]));
  const sorted = [...members].sort((left, right) => left.aliquotId < right.aliquotId ? -1 : left.aliquotId > right.aliquotId ? 1 : 0);
  if (!group || group.state !== "CONFIRMED" || group.splitId !== splitId || members.length !== 2
    || members.some(({ collectedItemId, aliquotId, intakeScanId }) => collectedItemId !== null || !aliquotId || !intakeScanId)
    || JSON.stringify(members) !== JSON.stringify(sorted)
    || new Set(members.map(({ aliquotId }) => aliquotId)).size !== 2
    || new Set(members.map(({ intakeScanId }) => intakeScanId)).size !== 2
    || members.some(({ aliquotId, intakeScanId }) => byId.get(aliquotId)?.state !== "VERIFIED"
      || !byId.get(aliquotId)?.currentCustodianId || byId.get(aliquotId)?.intakeScanId !== intakeScanId
      || scans.get(intakeScanId)?.state !== "MATCHED")) {
    throw new Error("Composite Custody Match Group did not preserve every verified aliquot-to-scan pair");
  }
}

async function evidenceAliquotScans(ctx, baseUrl, keyPrefix) {
  const scanIds = [`${keyPrefix}-aliquot-a`, `${keyPrefix}-aliquot-b`];
  const ingested = await ctx.mutate(baseUrl, "/api/v1/intake-batches", `${keyPrefix}-intake`, {
    deviceId: evidenceIds.device,
    batchSequence: 2,
    scans: [
      { scanId: scanIds[0], label: "BAG-1", sealCode: "A-SEAL", scannedAt: timestamp, facilityId: evidenceIds.facility },
      { scanId: scanIds[1], label: "BAG-1", sealCode: "B-SEAL", scannedAt: timestamp, facilityId: evidenceIds.facility },
    ],
  });
  if (ingested.status !== 202) throw new Error(ingested.text);
  const snapshot = await ctx.snapshot(baseUrl);
  const intakeScanIds = scanIds.map((scanId) => snapshot.resources.intakeScans.find((scan) => scan.scanId === scanId)?.intakeScanId);
  if (intakeScanIds.some((intakeScanId) => !intakeScanId)) throw new Error("Aliquot batch did not create both Intake Scans");
  return [
    { aliquotId: evidenceIds.aliquotA, intakeScanId: intakeScanIds[0] },
    { aliquotId: evidenceIds.aliquotB, intakeScanId: intakeScanIds[1] },
  ];
}

const evidencechain = {
  label: "EvidenceChain scanner batch",
  performanceScenarioIds: ["scanner-batch-ingest", "custody-timeline-read", "verification-recovery"],
  seed: async () => base("hidden-evidence", {
    cases: [{ caseId: evidenceIds.case, caseNumber: "CASE-HIDDEN" }],
    caseManifests: [{
      caseId: evidenceIds.case,
      version: 1,
      items: [{ collectedItemId: evidenceIds.item, expectedLabel: "BAG-1", expectedSealCode: "SEAL-1", quantity: 10 }],
    }],
    facilities: [{ facilityId: evidenceIds.facility, name: "Hidden Facility", receivingCustodianId: evidenceIds.custodian }],
    custodians: [{ custodianId: evidenceIds.custodian, name: "Hidden Custodian" }],
    deviceRegistrations: [{ deviceId: evidenceIds.device, facilityId: evidenceIds.facility, lastBatchSequence: 0 }],
    intakeScans: [],
    custodyMatches: [],
    transfers: [],
  }),
  path: "/api/v1/intake-batches",
  payload: (index) => ({
    deviceId: evidenceIds.device,
    batchSequence: 1,
    scans: [{ scanId: `scan-${index}`, label: "BAG-1", sealCode: "SEAL-1", scannedAt: timestamp, facilityId: evidenceIds.facility }],
  }),
  conflictPayload: () => ({
    deviceId: evidenceIds.device,
    batchSequence: 1,
    scans: [{ scanId: "changed", label: "BAG-X", sealCode: "SEAL-X", scannedAt: timestamp, facilityId: evidenceIds.facility }],
  }),
  resource: "intakeScans",
  identity: (json) => find(json, "intakeScanId") ?? find(json, "batchId"),
  workIdentity: () => evidenceIds.item,
  resourceIdentity: ({ intakeScanId }) => intakeScanId,
  performance: evidencePerformance,
  manager: {
    async prepare(ctx, baseUrl) {
      const ingested = await ctx.mutate(baseUrl, evidencechain.path, "manager-intake", evidencechain.payload(0));
      const scanId = find(ingested.json, "intakeScanId");
      const proposed = await ctx.mutate(baseUrl, "/api/v1/custody-matches", "manager-match", { collectedItemId: evidenceIds.item, intakeScanId: scanId });
      const matchId = find(proposed.json, "matchId");
      await ctx.mutate(baseUrl, `/api/v1/custody-matches/${matchId}/confirm`, "manager-confirm", { expectedItemRevision: 1, expectedScanRevision: 1 });
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        return snapshot.resources.collectedItems.some((item) => item.collectedItemId === evidenceIds.item && item.state === "VERIFIED");
      }, { label: "collected item verification", children: [worker] });
      return {
        path: `/api/v1/collected-items/${evidenceIds.item}/splits`,
        payload: () => ({
          expectedRevision: 3,
          aliquots: [
            { aliquotId: evidenceIds.aliquotA, quantity: 4, sealCode: "A-SEAL" },
            { aliquotId: evidenceIds.aliquotB, quantity: 6, sealCode: "B-SEAL" },
          ],
        }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const splitId = find(response.json, "splitId");
      let snapshot = await ctx.snapshot(baseUrl);
      const parent = snapshot.resources.collectedItems.find(({ collectedItemId }) => collectedItemId === evidenceIds.item);
      const aliquots = snapshot.resources.aliquots.filter(({ parentItemId }) => parentItemId === evidenceIds.item);
      if (!splitId || parent?.state !== "CONSUMED_BY_SPLIT" || parent.quantity !== 10
        || parent.currentCustodianId !== null || parent.intakeScanId !== null
        || aliquots.length !== 2 || aliquots.reduce((sum, aliquot) => sum + aliquot.quantity, 0) !== parent.quantity) {
        throw new Error("Item Split did not conserve quantity or clear the consumed parent's singular custody fields");
      }
      const members = await evidenceAliquotScans(ctx, baseUrl, "h10");
      const created = await ctx.mutate(baseUrl, "/api/v1/custody-match-groups", "h10-custody-group", { splitId, members });
      if (created.status !== 201 || find(created.json, "state") !== "CONFIRMED") throw new Error(created.text);
      const custodyMatchGroupId = find(created.json, "custodyMatchGroupId");
      const worker = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const stored = value.resources.aliquots.filter(({ parentItemId }) => parentItemId === evidenceIds.item);
        return stored.length === 2 && stored.every(({ state }) => state === "VERIFIED") ? value : undefined;
      }, { timeoutMs: 60_000, label: "both Aliquots VERIFIED", children: [worker] });
      const group = snapshot.resources.custodyMatchGroups.find((item) => item.custodyMatchGroupId === custodyMatchGroupId);
      if (!group || group.state !== "CONFIRMED" || group.splitId !== splitId || group.members.length !== 2
        || new Set(group.members.map(({ aliquotId }) => aliquotId)).size !== 2
        || new Set(group.members.map(({ intakeScanId }) => intakeScanId)).size !== 2) {
        throw new Error("Composite Custody Match Group is incomplete or duplicated a member");
      }
      assertCompositeGroup(snapshot, group, splitId);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const splitId = find(response.json, "splitId");
      const members = await evidenceAliquotScans(ctx, baseUrls[0], "h11");
      const attempts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        "/api/v1/custody-match-groups",
        `h11-custody-group-${index}`,
        { splitId, members },
      ));
      if (attempts.filter(({ status }) => status === 201).length !== 1
        || attempts.filter(({ status, json }) => status === 409 && json?.error?.code === "CUSTODY_MATCH_GROUP_CONFLICT").length !== 19) {
        throw new Error("Composite Custody Match Group contention did not have one winner");
      }
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const groups = snapshot.resources.custodyMatchGroups.filter((group) => group.splitId === splitId);
      const parent = snapshot.resources.collectedItems.find(({ collectedItemId }) => collectedItemId === evidenceIds.item);
      const aliquots = snapshot.resources.aliquots.filter(({ parentItemId }) => parentItemId === evidenceIds.item);
      if (groups.length !== 1 || groups[0].state !== "CONFIRMED" || groups[0].members.length !== 2
        || new Set(groups[0].members.map(({ aliquotId }) => aliquotId)).size !== 2
        || new Set(groups[0].members.map(({ intakeScanId }) => intakeScanId)).size !== 2
        || aliquots.length !== 2 || aliquots.reduce((sum, aliquot) => sum + aliquot.quantity, 0) !== parent.quantity) {
        throw new Error("Composite group race created a partial group or broke quantity conservation");
      }
      assertCompositeGroup(snapshot, groups[0], splitId);
    },
  },
  uiPattern: /evidence|custody|case/iu,
};

function evidencePerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function evidencePerfSeed() {
  const custodians = Array.from({ length: 10 }, (_, index) => ({ custodianId: evidencePerfUuid("41000000", index), name: `Custodian ${index}` }));
  const facilities = custodians.map(({ custodianId }, index) => ({ facilityId: evidencePerfUuid("42000000", index), name: `Facility ${index}`, receivingCustodianId: custodianId }));
  const cases = [];
  const caseManifests = [];
  for (let caseIndex = 0; caseIndex < 100; caseIndex += 1) {
    const caseId = evidencePerfUuid("43000000", caseIndex);
    cases.push({ caseId, caseNumber: `PERF-${String(caseIndex).padStart(3, "0")}` });
    caseManifests.push({
      caseId,
      version: 1,
      items: Array.from({ length: 100 }, (_, itemIndex) => {
        const index = caseIndex * 100 + itemIndex;
        return { collectedItemId: evidencePerfUuid("44000000", index), expectedLabel: `LABEL-${index}`, expectedSealCode: `SEAL-${index}`, quantity: 1 };
      }),
    });
  }
  const deviceRegistrations = Array.from({ length: 100 }, (_, index) => ({
    deviceId: evidencePerfUuid("45000000", index),
    facilityId: facilities[index % 10].facilityId,
    lastBatchSequence: 100,
  }));
  const intakeScans = [];
  const custodyMatches = [];
  const transfers = [];
  for (let index = 0; index < 10_000; index += 1) {
    const deviceIndex = index % 100;
    const itemId = evidencePerfUuid("44000000", index);
    const scanId = evidencePerfUuid("46000000", index);
    intakeScans.push({
      intakeScanId: scanId,
      scanId: `seed-scan-${index}`,
      deviceId: deviceRegistrations[deviceIndex].deviceId,
      batchSequence: Math.floor(index / 100) + 1,
      label: `LABEL-${index}`,
      sealCode: `SEAL-${index}`,
      scannedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      facilityId: facilities[deviceIndex % 10].facilityId,
      state: "MATCHED",
      revision: 2,
    });
    custodyMatches.push({
      matchId: evidencePerfUuid("47000000", index),
      collectedItemId: itemId,
      intakeScanId: scanId,
      state: "CONFIRMED",
      createdAt: timestamp,
      confirmedAt: timestamp,
      reversedAt: null,
    });
    let fromCustodianId = custodians[deviceIndex % 10].custodianId;
    let priorTransferId = null;
    for (let transferIndex = 0; transferIndex < 5; transferIndex += 1) {
      const transferId = evidencePerfUuid("48000000", index * 5 + transferIndex);
      const toCustodianId = custodians[(deviceIndex + transferIndex + 1) % 10].custodianId;
      const occurredAt = `2026-02-${String(transferIndex + 1).padStart(2, "0")}T00:00:00.000Z`;
      transfers.push({ transferId, collectedItemId: itemId, fromCustodianId, toCustodianId, occurredAt, acceptedAt: occurredAt, priorTransferId });
      fromCustodianId = toCustodianId;
      priorTransferId = transferId;
    }
  }
  return base("perf-v1", { cases, caseManifests, facilities, custodians, deviceRegistrations, intakeScans, custodyMatches, transfers });
}

async function prepareEvidencePerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(evidencePerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function evidencePerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareEvidencePerf(ctx);
  const clients = Array.from({ length: 64 }, (_, client) => ({ client, nextSequence: 101, requestCount: 0, last: null, measured: false }));
  let measuredNewBatches = 0;
  const ingest = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured, client }) => {
      const state = clients[client];
      if (measured && !state.measured) {
        state.measured = true;
        state.requestCount = 0;
        state.last = null;
      }
      state.requestCount += 1;
      const replay = state.requestCount % 10 === 0 && state.last;
      let key;
      let body;
      if (replay) {
        ({ key, body } = state.last);
      } else {
        const sequence = state.nextSequence++;
        key = `perf-intake-${client}-${sequence}`;
        body = {
          deviceId: evidencePerfUuid("45000000", client),
          batchSequence: sequence,
          scans: Array.from({ length: 20 }, (_, scanIndex) => ({
            scanId: `perf-scan-${client}-${sequence}-${scanIndex}`,
            label: `UNMATCHED-${client}-${sequence}-${scanIndex}`,
            sealCode: `SEAL-${client}-${sequence}-${scanIndex}`,
            scannedAt: timestamp,
            facilityId: evidencePerfUuid("42000000", client % 10),
          })),
        };
        state.last = { key, body };
        if (measured) measuredNewBatches += 1;
      }
      const response = await ctx.mutate(client % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/intake-batches", key, body);
      if (response.status !== 202) throw new Error(response.text);
      return response;
    },
  });
  if (ingest.throughput < 100 || ingest.p95 > 350 || Object.keys(ingest.statuses).some((status) => Number(status) >= 500)) throw new Error(`scanner-batch-ingest failed: ${ingest.throughput}/s p95=${ingest.p95}`);
  const ingestSnapshot = await ctx.snapshot(apiA.baseUrl);
  const expectedScans = 10_000 + clients.reduce((sum, state) => sum + (state.nextSequence - 101), 0) * 20;
  if (ingestSnapshot.resources.intakeScans.length !== expectedScans) throw new Error("scanner batch ingest created a partial or duplicate batch");
  assertions.push(`scanner-batch-ingest: ${ingest.throughput.toFixed(1)}/s, p95 ${ingest.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "scanner-batch-ingest", ...ingest, measuredNewBatches });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareEvidencePerf(ctx));
  let timelineOrdinal = 0;
  const timeline = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = timelineOrdinal++;
      const itemId = evidencePerfUuid("44000000", ordinal % 10_000);
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/collected-items/${itemId}/timeline`);
      const items = response.json?.items;
      if (response.status !== 200 || !response.json?.item || !Array.isArray(items) || items.length === 0) throw new Error(response.text);
      if (ctx.canonical(items.map(({ sequence }) => sequence)) !== ctx.canonical(Array.from({ length: items.length }, (_, index) => index + 1))) throw new Error("custody timeline sequence is not contiguous");
      return response;
    },
  });
  if (timeline.throughput < 200 || timeline.p95 > 180 || Object.keys(timeline.statuses).some((status) => Number(status) >= 500)) throw new Error(`custody-timeline-read failed: ${timeline.throughput}/s p95=${timeline.p95}`);
  assertions.push(`custody-timeline-read: ${timeline.throughput.toFixed(1)}/s, p95 ${timeline.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "custody-timeline-read", ...timeline });

  await ctx.resetDatabase();
  ({ apiA } = await prepareEvidencePerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const firstWorkers = [
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-evidence" }),
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-evidence" }),
  ];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed verification tasks", children: firstWorkers });
  await Promise.all(firstWorkers.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "EVIDENCE_VERIFICATION" && !terminal);
    const verified = snapshot.resources.collectedItems.filter(({ state }) => state === "VERIFIED");
    return pending.length === 0 && verified.length === 10_000 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "10,000 recovered verifications", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  if (new Set(final.resources.collectedItems.map(({ collectedItemId }) => collectedItemId)).size !== 10_000) throw new Error("verification recovery duplicated an Item");
  assertions.push(`verification-recovery: 10,000 items verified in ${recoveryMs}ms after two SIGKILLs`);
  metrics.push({ scenarioId: "verification-recovery", completed: 10_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { cases: 100, manifests: 100, collectedItems: 10_000, facilities: 10, custodians: 10, devices: 100, scans: 10_000, matches: 10_000, transfers: 50_000 } };
}

const dispatchIds = { customer: id(501), couriers: [id(502), id(503), id(504)] };
const dispatchboard = {
  label: "DispatchBoard delivery creation",
  performanceScenarioIds: ["delivery-create", "hot-offer-claims", "offer-expiry-recovery"],
  seed: async (_ctx, deliveryUrl) => base("hidden-dispatch", {
    zones: [{ zoneId: "A", name: "Alpha" }, { zoneId: "B", name: "Beta" }],
    zoneDistances: [
      { fromZone: "A", toZone: "A", distanceBucket: 0 },
      { fromZone: "A", toZone: "B", distanceBucket: 1 },
      { fromZone: "B", toZone: "A", distanceBucket: 1 },
      { fromZone: "B", toZone: "B", distanceBucket: 0 },
    ],
    couriers: dispatchIds.couriers.map((courierId) => ({ courierId, homeZone: "A", capacityUnits: 100, activeLoadUnits: 0, eligibleZones: ["A", "B"], deliveryUrl, state: "AVAILABLE" })),
    customers: [{ customerId: dispatchIds.customer, name: "Hidden Customer" }],
    deliveries: [], offers: [], offerNotifications: [], assignments: [],
  }),
  path: "/api/v1/deliveries",
  payload: (index) => ({
    customerId: dispatchIds.customer,
    pickupZone: "A",
    dropoffZone: "B",
    readyAt: "2026-08-10T00:00:00.000Z",
    deliverBy: "2030-08-10T00:00:00.000Z",
    loadUnits: 1,
    ...(index >= 900 ? { roles: ["driver", "helper"] } : {}),
  }),
  conflictPayload: () => ({ ...dispatchboard.payload(0), loadUnits: 2 }),
  resource: "deliveries",
  identity: (json) => find(json, "deliveryId"),
  resourceIdentity: ({ deliveryId }) => deliveryId,
  performance: dispatchPerformance,
  manager: {
    path: "/api/v1/deliveries",
    payload: () => dispatchboard.payload(900),
    async verify(ctx, baseUrl, response) {
      const deliveryId = find(response.json, "deliveryId");
      const worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const offers = snapshot.resources.teamOffers.filter((offer) => offer.deliveryId === deliveryId && offer.state === "OPEN");
        return new Set(offers.map(({ roleIndex }) => roleIndex)).size === 2 ? snapshot : undefined;
      }, { label: "offers for both team roles", children: [worker] });
      const firstOffer = snapshot.resources.teamOffers.find((offer) => offer.deliveryId === deliveryId && offer.roleIndex === 0 && offer.state === "OPEN");
      const firstClaim = await ctx.mutate(baseUrl, `/api/v1/offers/${firstOffer.offerId}/accept`, "h10-team-claim-0", { courierId: firstOffer.courierId });
      if (firstClaim.status < 200 || firstClaim.status >= 300) throw new Error(firstClaim.text);
      snapshot = await ctx.snapshot(baseUrl);
      const secondOffer = snapshot.resources.teamOffers.find((offer) => offer.deliveryId === deliveryId && offer.roleIndex === 1
        && offer.courierId !== firstOffer.courierId && offer.state === "OPEN");
      if (!secondOffer) throw new Error("No distinct Courier remained available for the second role");
      const secondClaim = await ctx.mutate(baseUrl, `/api/v1/offers/${secondOffer.offerId}/accept`, "h10-team-claim-1", { courierId: secondOffer.courierId });
      if (secondClaim.status < 200 || secondClaim.status >= 300) throw new Error(secondClaim.text);
      snapshot = await ctx.snapshot(baseUrl);
      const delivery = snapshot.resources.deliveries.find((item) => item.deliveryId === deliveryId);
      const team = snapshot.resources.teamAssignments.find((item) => item.deliveryId === deliveryId);
      if (!team || team.state !== "ACTIVE" || team.assignments.length !== 2
        || ctx.canonical(team.requiredRoles) !== ctx.canonical(["driver", "helper"])
        || ctx.canonical(team.assignments.map(({ role }) => role)) !== ctx.canonical(team.requiredRoles)
        || new Set(team.assignments.map(({ courierId }) => courierId)).size !== 2
        || delivery.assignmentId !== null || delivery.teamAssignmentId !== team.teamAssignmentId) {
        throw new Error("Distinct role claims did not atomically activate one ordered Team Assignment");
      }
      for (const [index, assignment] of team.assignments.entries()) {
        const ready = await ctx.mutate(baseUrl, `/api/v1/deliveries/${deliveryId}/assignments/${assignment.assignmentId}/ready`, `h10-team-ready-${index}`, { courierId: assignment.courierId });
        if (ready.status < 200 || ready.status >= 300) throw new Error(ready.text);
      }
      snapshot = await ctx.snapshot(baseUrl);
      const readyTeam = snapshot.resources.teamAssignments.find((item) => item.teamAssignmentId === team.teamAssignmentId);
      if (readyTeam.state !== "READY" || readyTeam.assignments.some(({ state }) => state !== "READY")) throw new Error("Team became READY before or after the exact all-ready boundary");
      const pickedUp = await ctx.mutate(baseUrl, `/api/v1/deliveries/${deliveryId}/pickup`, "h10-team-pickup", { courierId: team.assignments[0].courierId });
      if (pickedUp.status < 200 || pickedUp.status >= 300) throw new Error(pickedUp.text);
      const completed = await ctx.mutate(baseUrl, `/api/v1/deliveries/${deliveryId}/complete`, "h10-team-complete", {
        courierId: team.assignments[1].courierId,
        proofCode: "TEAM-HARNESS",
      });
      if (completed.status < 200 || completed.status >= 300) throw new Error(completed.text);
      snapshot = await ctx.snapshot(baseUrl);
      const finalDelivery = snapshot.resources.deliveries.find((item) => item.deliveryId === deliveryId);
      const finalTeam = snapshot.resources.teamAssignments.find((item) => item.teamAssignmentId === team.teamAssignmentId);
      const assignedCourierIds = new Set(team.assignments.map(({ courierId }) => courierId));
      if (finalDelivery.state !== "DELIVERED" || finalTeam.state !== "COMPLETED"
        || finalTeam.assignments.some(({ state }) => state !== "COMPLETED")
        || snapshot.resources.couriers.some(({ courierId, activeLoadUnits }) => assignedCourierIds.has(courierId) && activeLoadUnits !== 0)) {
        throw new Error("Team completion did not complete every role and release every Courier load");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const deliveryId = find(response.json, "deliveryId");
      const worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const offers = value.resources.teamOffers.filter((offer) => offer.deliveryId === deliveryId && offer.state === "OPEN");
        return new Set(offers.map(({ roleIndex }) => roleIndex)).size === 2 ? value : undefined;
      }, { label: "contended team offers", children: [worker] });
      const firstOffer = snapshot.resources.teamOffers.find((offer) => offer.deliveryId === deliveryId && offer.roleIndex === 0 && offer.state === "OPEN");
      const firstClaim = await ctx.mutate(baseUrls[0], `/api/v1/offers/${firstOffer.offerId}/accept`, "h11-team-first-role", { courierId: firstOffer.courierId });
      if (firstClaim.status < 200 || firstClaim.status >= 300) throw new Error(firstClaim.text);
      snapshot = await ctx.snapshot(baseUrls[1]);
      const finalRoleOffers = snapshot.resources.teamOffers.filter((offer) => offer.deliveryId === deliveryId && offer.roleIndex === 1
        && offer.courierId !== firstOffer.courierId && offer.state === "OPEN");
      if (finalRoleOffers.length < 2) throw new Error("Final role did not expose competing distinct Courier claims");
      const claims = await ctx.concurrent(finalRoleOffers, finalRoleOffers.length, (offer, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        `/api/v1/offers/${offer.offerId}/accept`,
        `h11-team-final-role-${index}`,
        { courierId: offer.courierId },
      ));
      if (claims.filter(({ status }) => status >= 200 && status < 300).length !== 1
        || claims.some(({ status }) => !((status >= 200 && status < 300) || status === 409))) {
        throw new Error("Simultaneous final role claims did not have exactly one winner");
      }
      const final = await ctx.snapshot(baseUrls[1]);
      const teams = final.resources.teamAssignments.filter((item) => item.deliveryId === deliveryId);
      const team = teams[0];
      const delivery = final.resources.deliveries.find((item) => item.deliveryId === deliveryId);
      if (teams.length !== 1 || team.state !== "ACTIVE" || team.assignments.length !== 2
        || new Set(team.assignments.map(({ courierId }) => courierId)).size !== 2
        || delivery.teamAssignmentId !== team.teamAssignmentId || delivery.assignmentId !== null
        || final.resources.teamOffers.filter((offer) => offer.deliveryId === deliveryId && offer.state === "ACCEPTED").length !== 2) {
        throw new Error("Final-claim race created duplicate or partial Team Assignment state");
      }
      for (const assignment of team.assignments) {
        const courier = final.resources.couriers.find(({ courierId }) => courierId === assignment.courierId);
        if (courier?.activeLoadUnits !== delivery.loadUnits) throw new Error("Team claim did not reserve each Courier load exactly once");
      }
    },
  },
  uiPattern: /delivery|courier|dispatch/iu,
};

function dispatchPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function dispatchPerfSeed() {
  const zones = Array.from({ length: 100 }, (_, index) => ({ zoneId: `zone-${String(index).padStart(3, "0")}`, name: `Zone ${index}` }));
  const zoneDistances = zones.flatMap((from, fromIndex) => zones.map((to, toIndex) => ({ fromZone: from.zoneId, toZone: to.zoneId, distanceBucket: Math.abs(fromIndex - toIndex) })));
  const couriers = Array.from({ length: 10_000 }, (_, index) => ({
    courierId: dispatchPerfUuid("51000000", index), homeZone: zones[index % 100].zoneId, capacityUnits: 100, activeLoadUnits: 0,
    eligibleZones: zones.map(({ zoneId }) => zoneId), deliveryUrl: `http://127.0.0.1:1/couriers/${index}`, state: "AVAILABLE",
  }));
  const customers = Array.from({ length: 100_000 }, (_, index) => ({ customerId: dispatchPerfUuid("52000000", index), name: `Customer ${index}` }));
  const deliveries = [];
  const offers = [];
  const offerNotifications = [];
  const addOffer = (offerIndex, deliveryIndex, rank, state, expiresAt) => {
    const offerId = dispatchPerfUuid("54000000", offerIndex);
    const notificationId = dispatchPerfUuid("55000000", offerIndex);
    const courier = couriers[offerIndex % couriers.length];
    const round = Math.floor(rank / 5) + 1;
    offers.push({ offerId, deliveryId: dispatchPerfUuid("53000000", deliveryIndex), round, courierId: courier.courierId, rank: (rank % 5) + 1, state, createdAt: timestamp, expiresAt, notificationId });
    const body = { notificationId, offerId, deliveryId: dispatchPerfUuid("53000000", deliveryIndex), round, roleIndex: null, role: null, courierId: courier.courierId, expiresAt };
    offerNotifications.push({ notificationId, offerId, courierId: courier.courierId, deliveryUrl: courier.deliveryUrl, body, state: state === "OPEN" ? "DELIVERED" : "SUPERSEDED", attemptCount: 1, nextAttemptAt: null, successfulDeliveryAt: state === "OPEN" ? timestamp : null });
  };
  for (let index = 0; index < 5_200; index += 1) {
    const hot = index < 200;
    deliveries.push({
      deliveryId: dispatchPerfUuid("53000000", index), customerId: customers[index].customerId,
      pickupZone: zones[index % 100].zoneId, dropoffZone: zones[(index + 1) % 100].zoneId,
      readyAt: timestamp, deliverBy: hot ? "2030-01-01T01:00:00.000Z" : "2026-01-01T01:00:00.000Z",
      loadUnits: 1, state: "OFFERING", assignmentId: null, currentRound: hot ? 25 : 1,
      createdAt: timestamp, terminalAt: null, sequence: hot ? 26 : 2,
    });
  }
  let offerIndex = 0;
  for (let deliveryIndex = 0; deliveryIndex < 200; deliveryIndex += 1) {
    for (let historical = 0; historical < 125; historical += 1) addOffer(offerIndex++, deliveryIndex, historical, historical >= 120 ? "OPEN" : "LOST", historical >= 120 ? "2030-01-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z");
  }
  for (let deliveryIndex = 200; deliveryIndex < 5_200; deliveryIndex += 1) addOffer(offerIndex++, deliveryIndex, 0, "OPEN", "2026-01-01T00:00:00.000Z");
  return base("perf-v1", { zones, zoneDistances, couriers, customers, deliveries, offers, offerNotifications, assignments: [] });
}

async function prepareDispatchPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(dispatchPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function dispatchPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareDispatchPerf(ctx);
  const setupAt = Date.now();
  const readyAt = new Date(setupAt + 600_000).toISOString();
  const deliverBy = new Date(setupAt + 4_200_000).toISOString();
  let deliveryOrdinal = 0;
  const creates = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const ordinal = deliveryOrdinal++;
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/deliveries", `perf-delivery-${ordinal}`, {
        customerId: dispatchPerfUuid("52000000", (measured ? 50_000 : 20_000) + (ordinal % 20_000)),
        pickupZone: `zone-${String(ordinal % 100).padStart(3, "0")}`,
        dropoffZone: `zone-${String((ordinal + 1) % 100).padStart(3, "0")}`,
        readyAt, deliverBy, loadUnits: 1,
      });
      if (response.status !== 202 || find(response.json, "state") !== "REQUESTED") throw new Error(response.text);
      return response;
    },
  });
  if (creates.throughput < 100 || creates.p95 > 300 || Object.keys(creates.statuses).some((status) => Number(status) >= 500)) throw new Error(`delivery-create failed: ${creates.throughput}/s p95=${creates.p95}`);
  assertions.push(`delivery-create: ${creates.throughput.toFixed(1)}/s, p95 ${creates.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "delivery-create", ...creates });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareDispatchPerf(ctx));
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const hotDeliveryIds = new Set(Array.from({ length: 200 }, (_, index) => dispatchPerfUuid("53000000", index)));
  const hotOffers = snapshot.resources.offers.filter(({ deliveryId, state }) => hotDeliveryIds.has(deliveryId) && state === "OPEN").sort((left, right) => left.deliveryId.localeCompare(right.deliveryId) || left.round - right.round || left.rank - right.rank || left.offerId.localeCompare(right.offerId));
  if (hotOffers.length !== 1_000) throw new Error("hot claim fixture does not contain exactly 1,000 OPEN Offers");
  const claimStartedAt = Date.now();
  const claims = await ctx.concurrent(hotOffers, 64, (offer, index) => ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/offers/${offer.offerId}/accept`, `perf-claim-${offer.offerId}`, { courierId: offer.courierId }));
  const claimMs = Date.now() - claimStartedAt;
  const claimMetrics = latencyMetrics("hot-offer-claims", claims, claimMs);
  if (claimMs > 5_000 || claimMetrics.p95 > 350 || claims.filter(({ status }) => status >= 200 && status < 300).length !== 200 || claims.some(({ status }) => ![200, 201, 409].includes(status))) throw new Error("hot-offer-claims threshold failed");
  const claimed = await ctx.snapshot(apiA.baseUrl);
  if (claimed.resources.assignments.length !== 200 || new Set(claimed.resources.assignments.map(({ deliveryId }) => deliveryId)).size !== 200) throw new Error("hot claims created duplicate assignments");
  for (const courier of claimed.resources.couriers) {
    const expected = claimed.resources.assignments.filter(({ courierId }) => courierId === courier.courierId).reduce((sum, { loadUnits }) => sum + loadUnits, 0);
    if (courier.activeLoadUnits !== expected || expected > courier.capacityUnits) throw new Error("Courier load does not reconcile");
  }
  assertions.push(`hot-offer-claims: 1,000 claims in ${claimMs}ms with 200 winners`);
  metrics.push(claimMetrics);

  await ctx.resetDatabase();
  ({ apiA } = await prepareDispatchPerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dispatch" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dispatch" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Offer expiry tasks", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const dueDeliveryIds = new Set(Array.from({ length: 5_000 }, (_, index) => dispatchPerfUuid("53000000", index + 200)));
  const final = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const originalDue = value.resources.offers.filter(({ deliveryId, offerId }) => dueDeliveryIds.has(deliveryId) && Number.parseInt(offerId.slice(-12), 10) > 25_000 && Number.parseInt(offerId.slice(-12), 10) <= 30_000);
    const pending = value.work.filter(({ aggregateId, terminal }) => dueDeliveryIds.has(aggregateId) && !terminal);
    return originalDue.every(({ state }) => state !== "OPEN") && pending.length === 0 ? value : undefined;
  }, { timeoutMs: 60_000, label: "5,000 due Offers", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  if (final.resources.assignments.some((assignment, index, all) => all.findIndex(({ deliveryId }) => deliveryId === assignment.deliveryId) !== index)) throw new Error("expiry recovery duplicated assignments");
  assertions.push(`offer-expiry-recovery: 5,000 due Offers settled in ${recoveryMs}ms`);
  metrics.push({ scenarioId: "offer-expiry-recovery", completed: 5_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { zones: 100, zoneDistances: 10_000, couriers: 10_000, customers: 100_000, deliveries: 5_200, offers: 30_000, hotOffers: 1_000, dueOffers: 5_000 } };
}

const quotaIds = { pool: id(601), tenant: id(602) };
const quotamesh = {
  label: "QuotaMesh reservation",
  performanceScenarioIds: ["quota-pool-read", "hot-pool-reservation-race", "expiry-and-admission-recovery"],
  seed: async () => base("hidden-quota", {
    dimensions: [{ name: "cpu", unit: "cores" }, { name: "memory", unit: "bytes" }],
    quotaPools: [{ poolId: quotaIds.pool, tenantId: quotaIds.tenant, name: "Hidden Pool", capacity: { cpu: 1_000_000, memory: 1_000_000 } }],
    commitments: [], reservations: [], admissionQueue: [],
  }),
  path: `/api/v1/quota-pools/${quotaIds.pool}/reservations`,
  payload: (index) => ({ ownerId: id(610 + index), quantities: { cpu: 1, memory: 1 }, ttlSeconds: 3600 }),
  conflictPayload: () => ({ ownerId: id(610), quantities: { cpu: 2, memory: 1 }, ttlSeconds: 3600 }),
  resource: "reservations",
  identity: (json) => find(json, "reservationId"),
  resourceIdentity: ({ reservationId }) => reservationId,
  performance: quotaPerformance,
  manager: {
    path: "/api/v1/quota-organizations",
    payload: (index) => ({ tenantId: id(700 + index), name: `Organization ${index}`, capacity: { cpu: 1000, memory: 1000 } }),
    async verify(ctx, baseUrl, response) {
      const organizationId = find(response.json, "organizationId");
      const projects = [];
      for (const [index, allocation] of [{ cpu: 600, memory: 600 }, { cpu: 400, memory: 400 }].entries()) {
        const created = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/projects`, `h10-project-${index}`, {
          name: `Project ${index}`,
          allocation,
        });
        if (created.status !== 201) throw new Error(created.text);
        projects.push(find(created.json, "projectId"));
      }
      const held = [];
      for (const [index, quantities] of [{ cpu: 500, memory: 500 }, { cpu: 300, memory: 300 }].entries()) {
        const created = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/projects/${projects[index]}/reservations`, `h10-reservation-${index}`, {
          ownerId: id(720 + index),
          quantities,
          ttlSeconds: 3600,
        });
        if (created.status !== 201) throw new Error(created.text);
        held.push(find(created.json, "reservationId"));
      }
      const organization = await ctx.request(baseUrl, `/api/v1/quota-organizations/${organizationId}`);
      if (organization.status !== 200 || find(organization.json, "held")?.cpu !== 800 || find(organization.json, "held")?.memory !== 800 || find(organization.json, "allocated")?.cpu !== 1000 || find(organization.json, "allocated")?.memory !== 1000) {
        throw new Error("Organization totals do not reconcile child allocations and holds");
      }
      const released = await ctx.mutate(baseUrl, `/api/v1/reservations/${held[0]}/release`, "h10-release", { reason: "Harness conservation check" });
      if (released.status !== 200) throw new Error(released.text);
      const after = await ctx.snapshot(baseUrl);
      const storedOrganization = after.resources.quotaOrganizations.find((item) => item.organizationId === organizationId);
      const firstProject = after.resources.quotaProjects.find((item) => item.projectId === projects[0]);
      const secondProject = after.resources.quotaProjects.find((item) => item.projectId === projects[1]);
      if (storedOrganization.held.cpu !== 300 || storedOrganization.held.memory !== 300 || firstProject.held.cpu !== 0 || firstProject.held.memory !== 0 || secondProject.held.cpu !== 300 || secondProject.held.memory !== 300) {
        throw new Error("Reservation release did not update Organization and Project exactly once");
      }
      const expanded = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/capacity`, "h10-capacity-expand", {
        capacity: { cpu: 1200, memory: 1200 },
        expectedRevision: storedOrganization.revision,
      }, "PUT");
      assert.ok(expanded.status >= 200 && expanded.status < 300, expanded.text);
      const expandedSnapshot = await ctx.snapshot(baseUrl);
      const expandedOrganization = expandedSnapshot.resources.quotaOrganizations.find((item) => item.organizationId === organizationId);
      const expandedProject = expandedSnapshot.resources.quotaProjects.find((item) => item.projectId === projects[0]);
      const reallocated = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/projects/${projects[0]}/allocation`, "h10-project-expand", {
        allocation: { cpu: 700, memory: 700 },
        expectedOrganizationRevision: expandedOrganization.revision,
        expectedProjectRevision: expandedProject.revision,
      }, "PUT");
      assert.ok(reallocated.status >= 200 && reallocated.status < 300, reallocated.text);
      const current = await ctx.snapshot(baseUrl);
      const currentOrganization = current.resources.quotaOrganizations.find((item) => item.organizationId === organizationId);
      const currentFirst = current.resources.quotaProjects.find((item) => item.projectId === projects[0]);
      const currentSecond = current.resources.quotaProjects.find((item) => item.projectId === projects[1]);
      assert.deepEqual(currentOrganization.allocated, { cpu: 1100, memory: 1100 });
      const staleBefore = stableSnapshot(current);
      const stale = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/projects/${projects[0]}/allocation`, "h10-project-stale", {
        allocation: { cpu: 650, memory: 650 },
        expectedOrganizationRevision: expandedOrganization.revision,
        expectedProjectRevision: expandedProject.revision,
      }, "PUT");
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.json?.error?.code, "QUOTA_HIERARCHY_REVISION_CHANGED");
      assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), staleBefore);
      const capacityConflict = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/capacity`, "h10-capacity-conflict", {
        capacity: { cpu: 1000, memory: 1000 },
        expectedRevision: currentOrganization.revision,
      }, "PUT");
      assert.equal(capacityConflict.status, 409, capacityConflict.text);
      assert.equal(capacityConflict.json?.error?.code, "ORGANIZATION_CAPACITY_CONFLICT");
      assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), staleBefore);
      const allocationConflict = await ctx.mutate(baseUrl, `/api/v1/quota-organizations/${organizationId}/projects/${projects[1]}/allocation`, "h10-allocation-conflict", {
        allocation: { cpu: 200, memory: 200 },
        expectedOrganizationRevision: currentOrganization.revision,
        expectedProjectRevision: currentSecond.revision,
      }, "PUT");
      assert.equal(allocationConflict.status, 409, allocationConflict.text);
      assert.equal(allocationConflict.json?.error?.code, "PROJECT_ALLOCATION_CONFLICT");
      assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), staleBefore);
      assert.equal(currentFirst.held.cpu + currentFirst.committed.cpu <= currentFirst.allocation.cpu, true);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const organizationId = find(response.json, "organizationId");
      const project = await ctx.mutate(baseUrls[0], `/api/v1/quota-organizations/${organizationId}/projects`, "h11-project", {
        name: "Hot Project",
        allocation: { cpu: 600, memory: 600 },
      });
      if (project.status !== 201) throw new Error(project.text);
      const projectId = find(project.json, "projectId");
      const reservations = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        `/api/v1/quota-organizations/${organizationId}/projects/${projectId}/reservations`,
        `h11-reservation-${index}`,
        { ownerId: id(740 + index), quantities: { cpu: 100, memory: 100 }, ttlSeconds: 3600 },
      ));
      if (reservations.filter(({ status }) => status === 201).length !== 6) throw new Error("Project admitted more or fewer than its complete vector capacity");
      if (reservations.filter(({ status, json }) => status === 409 && json?.error?.code === "PROJECT_QUOTA_EXCEEDED").length !== 14) {
        throw new Error("Project contention returned unexpected outcomes");
      }
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const organization = snapshot.resources.quotaOrganizations.find((item) => item.organizationId === organizationId);
      const storedProject = snapshot.resources.quotaProjects.find((item) => item.projectId === projectId);
      if (organization.held.cpu !== 600 || storedProject.held.cpu !== 600 || organization.held.memory !== 600 || storedProject.held.memory !== 600) {
        throw new Error("Concurrent reservations broke Organization/Project vector conservation");
      }
      const siblingProjects = [];
      for (const [index, name] of ["High Priority", "Low Priority"].entries()) {
        const created = await ctx.mutate(baseUrls[0], `/api/v1/quota-organizations/${organizationId}/projects`, `h11-sibling-project-${index}`, {
          name,
          allocation: { cpu: 200, memory: 200 },
        });
        assert.equal(created.status, 201, created.text);
        siblingProjects.push(find(created.json, "projectId"));
      }
      const siblingReservations = [];
      for (const [index, projectId] of siblingProjects.entries()) {
        const created = await ctx.mutate(baseUrls[index % 2], `/api/v1/quota-organizations/${organizationId}/projects/${projectId}/reservations`, `h11-sibling-reservation-${index}`, {
          ownerId: id(770 + index),
          quantities: { cpu: 200, memory: 200 },
          ttlSeconds: 3600,
        });
        assert.equal(created.status, 201, created.text);
        siblingReservations.push(find(created.json, "reservationId"));
      }
      const high = await ctx.mutate(baseUrls[0], "/api/v1/admission-queue", "h11-high-admission", {
        organizationId,
        projectId: siblingProjects[0],
        ownerId: id(780),
        quantities: { cpu: 200, memory: 200 },
        priority: 2,
      });
      const low = await ctx.mutate(baseUrls[1], "/api/v1/admission-queue", "h11-low-admission", {
        organizationId,
        projectId: siblingProjects[1],
        ownerId: id(781),
        quantities: { cpu: 200, memory: 200 },
        priority: 1,
      });
      assert.equal(high.status, 201, high.text);
      assert.equal(low.status, 201, low.text);
      const highId = find(high.json, "admissionEntryId");
      const lowId = find(low.json, "admissionEntryId");
      const queued = await ctx.snapshot(baseUrls[0]);
      const queuedEntries = queued.resources.admissionEntries
        .filter(({ admissionEntryId }) => [highId, lowId].includes(admissionEntryId));
      assert.equal(queuedEntries.length, 2);
      assert.ok(queuedEntries.every(({ state }) => state === "WAITING"));
      const initialAttempt = Math.max(0, ...queued.work.filter(({ kind }) => kind === "ADMISSION_PROMOTION").map(({ attempt }) => attempt));
      const releasedLow = await ctx.mutate(baseUrls[0], `/api/v1/reservations/${siblingReservations[1]}/release`, "h11-release-low", { reason: "prove head blocking" });
      assert.equal(releasedLow.status, 200, releasedLow.text);
      const blockedWorkers = [await ctx.startWorker(), await ctx.startWorker()];
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const entries = value.resources.admissionEntries.filter(({ admissionEntryId }) => [highId, lowId].includes(admissionEntryId));
        const attempted = value.work.filter(({ kind }) => kind === "ADMISSION_PROMOTION").some(({ attempt }) => attempt > initialAttempt);
        return attempted && entries.every(({ state }) => state === "WAITING") ? value : undefined;
      }, { timeoutMs: 30_000, label: "blocked admission head prevents sibling bypass", children: blockedWorkers });
      await Promise.all(blockedWorkers.map((worker) => ctx.stop(worker)));
      const releasedHigh = await ctx.mutate(baseUrls[1], `/api/v1/reservations/${siblingReservations[0]}/release`, "h11-release-high", { reason: "unblock hierarchy queue" });
      assert.equal(releasedHigh.status, 200, releasedHigh.text);
      let releaseClaim;
      const heldClaim = new Promise((resolve) => { releaseClaim = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? heldClaim : { status: 204 });
      const crashedWorkers = [
        await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-quota" }),
        await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-quota" }),
      ];
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed"), { label: "hierarchy promotion claimed", children: crashedWorkers });
      await Promise.all(crashedWorkers.map((worker) => ctx.stop(worker, "SIGKILL")));
      releaseClaim({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const promotionWorkers = [await ctx.startWorker(), await ctx.startWorker()];
      const promoted = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[1]);
        const entries = value.resources.admissionEntries.filter(({ admissionEntryId }) => [highId, lowId].includes(admissionEntryId));
        return entries.length === 2 && entries.every(({ state, reservationId }) => state === "PROMOTED" && reservationId) ? value : undefined;
      }, { timeoutMs: 30_000, label: "hierarchy admission promotion", children: promotionWorkers });
      const promotedEntries = promoted.resources.admissionEntries.filter(({ admissionEntryId }) => [highId, lowId].includes(admissionEntryId));
      assert.equal(new Set(promotedEntries.map(({ reservationId }) => reservationId)).size, 2);
      const finalOrganization = promoted.resources.quotaOrganizations.find((item) => item.organizationId === organizationId);
      assert.deepEqual(finalOrganization.held, { cpu: 1000, memory: 1000 });
      for (const projectId of siblingProjects) {
        const item = promoted.resources.quotaProjects.find((project) => project.projectId === projectId);
        assert.deepEqual(item.held, { cpu: 200, memory: 200 });
      }
    },
  },
  uiPattern: /quota|reservation|capacity/iu,
};

function quotaPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function quotaVector(value) {
  return { cpuMillis: value, memoryMiB: value, storageMiB: value, networkMbps: value, gpuUnits: value };
}

function quotaPerfSeed() {
  const dimensions = ["cpuMillis", "memoryMiB", "storageMiB", "networkMbps", "gpuUnits"].map((name) => ({ name, unit: "units" }));
  const quotaPools = [];
  const commitments = [];
  const reservations = [];
  const admissionQueue = [];
  for (let poolIndex = 0; poolIndex < 1_000; poolIndex += 1) {
    const poolId = quotaPerfUuid("q1000000", poolIndex);
    quotaPools.push({ poolId, tenantId: quotaPerfUuid("q2000000", poolIndex), name: `Pool ${poolIndex}`, capacity: quotaVector(21) });
    const committedReservationId = quotaPerfUuid("q3000000", poolIndex * 100);
    const committedOwnerId = quotaPerfUuid("q4000000", poolIndex * 100);
    reservations.push({ reservationId: committedReservationId, poolId, ownerId: committedOwnerId, quantities: quotaVector(1), state: "COMMITTED", expiresAt: "2030-01-01T00:00:00.000Z", createdAt: timestamp, terminalAt: timestamp, sequence: 2 });
    commitments.push({ commitmentId: quotaPerfUuid("q5000000", poolIndex), reservationId: committedReservationId, poolId, ownerId: committedOwnerId, quantities: quotaVector(1), committedAt: timestamp, releasedAt: null });
    for (let local = 1; local <= 20; local += 1) {
      const ordinal = poolIndex * 100 + local;
      reservations.push({ reservationId: quotaPerfUuid("q3000000", ordinal), poolId, ownerId: quotaPerfUuid("q4000000", ordinal), quantities: quotaVector(1), state: "HELD", expiresAt: "2026-01-01T00:00:00.000Z", createdAt: timestamp, terminalAt: null, sequence: 1 });
      admissionQueue.push({ admissionEntryId: quotaPerfUuid("q6000000", poolIndex * 20 + local - 1), poolId, ownerId: quotaPerfUuid("q7000000", poolIndex * 20 + local - 1), quantities: quotaVector(1), priority: 1, state: "WAITING", requestedAt: timestamp, reservationId: null });
    }
    for (let local = 21; local < 100; local += 1) {
      const ordinal = poolIndex * 100 + local;
      reservations.push({ reservationId: quotaPerfUuid("q3000000", ordinal), poolId, ownerId: quotaPerfUuid("q4000000", ordinal), quantities: quotaVector(1), state: "RELEASED", expiresAt: "2026-01-01T00:00:00.000Z", createdAt: timestamp, terminalAt: timestamp, sequence: 2 });
    }
  }
  return base("perf-v1", { dimensions, quotaPools, commitments, reservations, admissionQueue });
}

async function prepareQuotaPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(quotaPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function quotaPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareQuotaPerf(ctx);
  let readOrdinal = 0;
  const reads = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = readOrdinal++;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/quota-pools/${quotaPerfUuid("q1000000", ordinal % 1_000)}`);
      const pool = response.json?.quotaPool ?? response.json;
      if (response.status !== 200 || ctx.canonical(pool.held) !== ctx.canonical(quotaVector(20)) || ctx.canonical(pool.committed) !== ctx.canonical(quotaVector(1))) throw new Error(response.text);
      return response;
    },
  });
  if (reads.throughput < 500 || reads.p95 > 100) throw new Error(`quota-pool-read failed: ${reads.throughput}/s p95=${reads.p95}`);
  assertions.push(`quota-pool-read: ${reads.throughput.toFixed(1)}/s, p95 ${reads.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "quota-pool-read", ...reads });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareQuotaPerf(ctx));
  const createPools = async (prefix, saturated) => ctx.concurrent(Array.from({ length: 10 }, (_, index) => index), 10, async (index) => {
    const response = await ctx.mutate(apiA.baseUrl, "/api/v1/quota-pools", `${prefix}-pool-${index}`, { tenantId: quotaPerfUuid(prefix === "warmup" ? "q8000000" : "q9000000", index), name: `${prefix}-${index}`, capacity: quotaVector(index >= 8 && saturated ? 0 : 20_000) });
    if (response.status !== 201) throw new Error(response.text);
    return find(response.json, "poolId");
  });
  const warmupPools = await createPools("warmup", true);
  const measuredPools = await createPools("measured", true);
  let warmupRaceOrdinal = 0;
  let measuredRaceOrdinal = 0;
  const races = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const ordinal = measured ? measuredRaceOrdinal++ : warmupRaceOrdinal++;
      const block = ordinal % 100;
      const expectedSuccess = block < 80;
      const poolId = (measured ? measuredPools : warmupPools)[expectedSuccess ? block % 8 : 8 + (block % 2)];
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/quota-pools/${poolId}/reservations`, `perf-race-${measured ? "m" : "w"}-${ordinal}`, { ownerId: quotaPerfUuid("qa000000", ordinal), quantities: quotaVector(1), ttlSeconds: 300 });
      if (expectedSuccess ? response.status !== 201 : response.status !== 409 || (!expectedSuccess && response.json?.error?.code !== "QUOTA_EXCEEDED")) throw new Error(response.text);
      return response;
    },
  });
  const success = races.statuses[201] ?? 0;
  const exceeded = races.statuses[409] ?? 0;
  const expectedSuccesses = Math.floor(races.completed / 100) * 80 + Math.min(races.completed % 100, 80);
  if (races.throughput < 200 || races.p95 > 400 || success !== expectedSuccesses || exceeded !== races.completed - expectedSuccesses) throw new Error("hot-pool-reservation-race result mix failed");
  assertions.push(`hot-pool-reservation-race: ${races.throughput.toFixed(1)}/s, p95 ${races.p95.toFixed(1)}ms, 80/20 outcomes`);
  metrics.push({ scenarioId: "hot-pool-reservation-race", ...races });

  await ctx.resetDatabase();
  ({ apiA } = await prepareQuotaPerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-quota" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-quota" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Quota tasks", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const expired = snapshot.resources.reservations.filter(({ state }) => state === "EXPIRED").length;
    const promoted = snapshot.resources.admissionEntries.filter(({ state }) => state === "PROMOTED").length;
    const pending = snapshot.work.filter(({ kind, terminal }) => ["RESERVATION_EXPIRY", "ADMISSION_PROMOTION"].includes(kind) && !terminal);
    return expired === 20_000 && promoted === 20_000 && pending.length === 0 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "Quota expiry and admission promotion", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  for (const pool of final.resources.quotaPools) for (const name of Object.keys(pool.capacity)) if (pool.held[name] + pool.committed[name] > pool.capacity[name] || pool.held[name] < 0) throw new Error(`capacity violation in ${pool.poolId}`);
  assertions.push(`expiry-and-admission-recovery: 40,000 transitions in ${recoveryMs}ms`);
  metrics.push({ scenarioId: "expiry-and-admission-recovery", expired: 20_000, promoted: 20_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { dimensions: 5, quotaPools: 1_000, commitments: 1_000, reservations: 100_000, heldDue: 20_000, admissionEntries: 20_000 } };
}

const carbonIds = { projectA: id(701), projectB: id(702), beneficiary: id(703), lotA: id(704), lotB: id(705) };

function assertSplitCertificate(ctx, snapshot, retirementId, response) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get("content-type")?.split(";", 1)[0].trim(), "application/json");
  const body = response.body;
  const parsed = JSON.parse(body.toString("utf8"));
  assert.equal(body.toString("utf8"), canonicalJson(parsed));
  const stored = snapshot.resources.retirements.find((item) => item.retirementId === retirementId);
  assert.equal(stored.state, "RETIRED");
  assert.equal(digest(body), stored.certificateDigest);
  assert.equal(response.headers.get("etag")?.replaceAll('"', ""), stored.certificateDigest);
  const split = snapshot.resources.splitCertificates.filter((item) => item.retirementId === retirementId);
  assert.equal(split.length, 1);
  assert.equal(snapshot.resources.certificates.filter((item) => item.retirementId === retirementId).length, 0);
  assert.equal(ctx.canonical(parsed), ctx.canonical(split[0]));
  const allocations = snapshot.resources.lotAllocations.filter((item) => item.retirementId === retirementId).sort((left, right) => left.ordinal - right.ordinal);
  const projected = allocations.map(({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest }) => ({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest }));
  assert.equal(ctx.canonical(parsed.allocations), ctx.canonical(projected));
  assert.equal(parsed.totalQuantityGrams, allocations.reduce((sum, item) => sum + item.quantityGrams, 0));
  const work = snapshot.work.filter(({ aggregateId, kind }) => aggregateId === retirementId && kind === "CERTIFICATE_GENERATION");
  assert.ok(work.length >= 1 && work.every(({ terminal }) => terminal));
  assert.ok(work.some(({ state }) => state === "SUCCEEDED"));
  assert.equal(snapshot.events.filter(({ type }) => type === "certificate.published").length, 1);
  assert.equal(snapshot.events.filter(({ type }) => type === "retirement.completed").length, 1);
  const lotA = snapshot.resources.creditLots.find(({ creditLotId }) => creditLotId === carbonIds.lotA);
  const lotB = snapshot.resources.creditLots.find(({ creditLotId }) => creditLotId === carbonIds.lotB);
  assert.deepEqual({ availableGrams: lotA.availableGrams, reservedGrams: lotA.reservedGrams, retiredGrams: lotA.retiredGrams }, { availableGrams: 0, reservedGrams: 0, retiredGrams: 1_000_000 });
  assert.deepEqual({ availableGrams: lotB.availableGrams, reservedGrams: lotB.reservedGrams, retiredGrams: lotB.retiredGrams }, { availableGrams: 500_000, reservedGrams: 0, retiredGrams: 500_000 });
  return parsed;
}

const carbonledger = {
  label: "CarbonLedger retirement",
  performanceScenarioIds: ["lot-and-provenance-read", "competing-retirement-create", "certificate-recovery"],
  seed: async () => base("hidden-carbon", {
    projects: [{ projectId: carbonIds.projectA, name: "Forest A" }, { projectId: carbonIds.projectB, name: "Forest B" }],
    beneficiaries: [{ beneficiaryId: carbonIds.beneficiary, name: "Hidden Beneficiary" }],
    creditLots: [
      { creditLotId: carbonIds.lotA, projectId: carbonIds.projectA, vintage: 2025, methodology: "FOREST", priority: 2, issuedGrams: 1_000_000, availableGrams: 1_000_000, reservedGrams: 0, retiredGrams: 0, provenanceDigest: "a".repeat(64) },
      { creditLotId: carbonIds.lotB, projectId: carbonIds.projectB, vintage: 2025, methodology: "FOREST", priority: 1, issuedGrams: 1_000_000, availableGrams: 1_000_000, reservedGrams: 0, retiredGrams: 0, provenanceDigest: "b".repeat(64) },
    ],
    retirements: [], certificates: [],
  }),
  path: "/api/v1/retirements",
  payload: (index) => ({ beneficiaryId: carbonIds.beneficiary, quantityGrams: 10 + (index % 100), eligibility: { projectId: carbonIds.projectA } }),
  conflictPayload: () => ({ beneficiaryId: carbonIds.beneficiary, quantityGrams: 999, eligibility: { projectId: carbonIds.projectA } }),
  resource: "retirements",
  identity: (json) => find(json, "retirementId"),
  resourceIdentity: ({ retirementId }) => retirementId,
  performance: carbonPerformance,
  manager: {
    path: "/api/v1/retirements",
    payload: () => ({ beneficiaryId: carbonIds.beneficiary, quantityGrams: 1_500_000, eligibility: { vintageFrom: 2025, vintageTo: 2025, methodology: "FOREST" } }),
    async verify(ctx, baseUrl, response) {
      const retirement = response.json?.retirement ?? response.json;
      if (retirement.state !== "RESERVED" || retirement.allocation !== null || retirement.allocations?.length !== 2) {
        throw new Error("Cross-Lot Retirement did not expose two immutable allocations");
      }
      const compact = retirement.allocations.map(({ ordinal, creditLotId, quantityGrams }) => ({ ordinal, creditLotId, quantityGrams }));
      const expected = [
        { ordinal: 1, creditLotId: carbonIds.lotA, quantityGrams: 1_000_000 },
        { ordinal: 2, creditLotId: carbonIds.lotB, quantityGrams: 500_000 },
      ];
      if (ctx.canonical(compact) !== ctx.canonical(expected)) throw new Error("Cross-Lot allocation did not follow published greedy order");
      const worker = await ctx.startWorker();
      const final = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        return snapshot.resources.retirements.find(({ retirementId, state }) => retirementId === retirement.retirementId && state === "RETIRED")
          ? snapshot
          : undefined;
      }, { timeoutMs: 60_000, label: "split Retirement Certificate", children: [worker] });
      const certificate = await ctx.request(baseUrl, `/api/v1/retirements/${retirement.retirementId}/certificate`, { binary: true });
      const parsed = assertSplitCertificate(ctx, final, retirement.retirementId, certificate);
      if (parsed.certificateVersion !== 2 || parsed.totalQuantityGrams !== 1_500_000 || parsed.allocations.length !== 2) {
        throw new Error("Split Certificate does not match committed allocations");
      }
      const allocations = final.resources.lotAllocations.filter(({ retirementId }) => retirementId === retirement.retirementId).sort((left, right) => left.ordinal - right.ordinal);
      if (ctx.canonical(parsed.allocations) !== ctx.canonical(allocations.map(({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest }) => ({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest })))) {
        throw new Error("Split Certificate did not preserve immutable allocation provenance");
      }
      if (final.resources.creditLots.some((lot) => lot.issuedGrams !== lot.availableGrams + lot.reservedGrams + lot.retiredGrams)) {
        throw new Error("Cross-Lot certification broke Lot conservation");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const retirementId = find(response.json, "retirementId");
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const allocation = snapshot.resources.lotAllocations.filter((item) => item.retirementId === retirementId);
      if (allocation.length !== 2 || allocation.reduce((sum, item) => sum + item.quantityGrams, 0) !== 1_500_000) {
        throw new Error("Concurrent replay created partial or duplicate Lot Allocations");
      }
      if (snapshot.resources.retirements.filter((item) => item.retirementId === retirementId).length !== 1) {
        throw new Error("Concurrent replay created duplicate Retirements");
      }
      if (snapshot.resources.creditLots.some((lot) => lot.issuedGrams !== lot.availableGrams + lot.reservedGrams + lot.retiredGrams)) {
        throw new Error("Concurrent Cross-Lot reservation broke conservation");
      }
      const workers = [await ctx.startWorker(), await ctx.startWorker()];
      const final = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const stored = value.resources.retirements.find((item) => item.retirementId === retirementId);
        const splitCount = value.resources.splitCertificates.filter((item) => item.retirementId === retirementId).length;
        const pending = value.work.filter(({ aggregateId, kind, terminal }) => aggregateId === retirementId && kind === "CERTIFICATE_GENERATION" && !terminal);
        return stored?.state === "RETIRED" && splitCount === 1 && pending.length === 0 ? value : undefined;
      }, { timeoutMs: 60_000, label: "concurrent split Certificate publication", children: workers });
      const certificates = await Promise.all(baseUrls.map((baseUrl) => ctx.request(baseUrl, `/api/v1/retirements/${retirementId}/certificate`, { binary: true })));
      assert.deepEqual(certificates[0].body, certificates[1].body);
      const parsed = assertSplitCertificate(ctx, final, retirementId, certificates[0]);
      assert.equal(certificates[1].status, 200, certificates[1].text);
      assert.equal(certificates[1].headers.get("content-type")?.split(";", 1)[0].trim(), "application/json");
      assert.equal(certificates[1].body.toString("utf8"), canonicalJson(parsed));
      assert.equal(certificates[1].headers.get("etag")?.replaceAll('"', ""), digest(certificates[1].body));
      assert.equal(final.resources.lotAllocations.filter((item) => item.retirementId === retirementId).length, 2);
      assert.equal(final.resources.splitCertificates.filter((item) => item.retirementId === retirementId).length, 1);
      assert.ok(final.resources.creditLots.every((lot) => lot.issuedGrams === lot.availableGrams + lot.reservedGrams + lot.retiredGrams));
    },
  },
  uiPattern: /carbon|credit|retirement/iu,
};

const carbonPerfUuid = (namespace, ordinal) => `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;

function carbonPerfSeed() {
  const projects = Array.from({ length: 1_000 }, (_, i) => ({ projectId: carbonPerfUuid("b1000000", i), name: `Project ${i}` }));
  const beneficiaries = Array.from({ length: 10_000 }, (_, i) => ({ beneficiaryId: carbonPerfUuid("b2000000", i), name: `Beneficiary ${i}` }));
  const creditLots = Array.from({ length: 50_000 }, (_, i) => {
    const hot = i >= 49_980;
    const reserved = i < 5_000 ? 1 : 0;
    const issued = hot ? 20_000 : 100;
    return { creditLotId: carbonPerfUuid("b3000000", i), projectId: hot ? projects[0].projectId : projects[i % 1_000].projectId, vintage: hot ? 2020 : 2000 + i % 25, methodology: i >= 49_990 ? "HOT" : i >= 49_980 ? "WARM" : `METHOD-${i % 10}`, priority: hot ? 100 : i % 10, issuedGrams: issued, availableGrams: issued - 2 - reserved, reservedGrams: reserved, retiredGrams: 2, provenanceDigest: digest(`provenance-${i}`) };
  });
  const certificates = [];
  const retirements = Array.from({ length: 100_000 }, (_, i) => {
    const lot = creditLots[i % 50_000];
    const retirementId = carbonPerfUuid("b4000000", i);
    const beneficiaryId = beneficiaries[i % 10_000].beneficiaryId;
    const certificate = { certificateVersion: 1, retirementId, beneficiaryId, quantityGrams: 1, creditLotId: lot.creditLotId, projectId: lot.projectId, vintage: lot.vintage, methodology: lot.methodology, provenanceDigest: lot.provenanceDigest, retiredAt: timestamp };
    certificates.push(certificate);
    return { retirementId, beneficiaryId, quantityGrams: 1, state: "RETIRED", allocation: { creditLotId: lot.creditLotId, quantityGrams: 1 }, expiresAt: "2030-01-01T00:00:00.000Z", certificateDigest: digest(canonicalJson(certificate)), createdAt: timestamp, terminalAt: timestamp, sequence: 2 };
  });
  for (let i = 0; i < 5_000; i += 1) retirements.push({ retirementId: carbonPerfUuid("b4000000", 100_000 + i), beneficiaryId: beneficiaries[i].beneficiaryId, quantityGrams: 1, state: "RESERVED", allocation: { creditLotId: creditLots[i].creditLotId, quantityGrams: 1 }, expiresAt: "2030-01-01T00:00:00.000Z", certificateDigest: null, createdAt: timestamp, terminalAt: null, sequence: 1 });
  return base("perf-v1", { projects, beneficiaries, creditLots, retirements, certificates });
}

async function prepareCarbonPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(carbonPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function carbonPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareCarbonPerf(ctx);
  let ordinal = 0;
  const reads = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale, request: async () => {
    const i = ordinal++ % 50_000;
    const detail = ordinal % 2 === 0;
    const projectId = carbonPerfUuid("b1000000", i >= 49_980 ? 0 : i % 1_000);
    const vintage = i >= 49_980 ? 2020 : 2000 + i % 25;
    const methodology = i >= 49_990 ? "HOT" : i >= 49_980 ? "WARM" : `METHOD-${i % 10}`;
    const response = await ctx.request(i % 2 ? apiA.baseUrl : apiB.baseUrl, detail ? `/api/v1/credit-lots/${carbonPerfUuid("b3000000", i)}` : `/api/v1/credit-lots?projectId=${projectId}&vintage=${vintage}&methodology=${methodology}&limit=50`);
    if (response.status !== 200) throw new Error(response.text);
    const lots = detail ? [response.json?.creditLot ?? response.json] : response.json?.items;
    if (!Array.isArray(lots) || lots.some((lot) => lot.issuedGrams !== lot.availableGrams + lot.reservedGrams + lot.retiredGrams || !lot.provenanceDigest)) throw new Error("Lot read violated conservation");
    return response;
  } });
  if (reads.throughput < 300 || reads.p95 > 140) throw new Error("lot-and-provenance-read threshold failed");
  assertions.push(`lot-and-provenance-read: ${reads.throughput.toFixed(1)}/s, p95 ${reads.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "lot-and-provenance-read", ...reads });

  await ctx.resetDatabase(); ({ apiA, apiB } = await prepareCarbonPerf(ctx)); ordinal = 0;
  const creates = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale, request: async ({ measured }) => {
    const i = ordinal++;
    const response = await ctx.mutate(i % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/retirements", `perf-retirement-${measured ? "m" : "w"}-${i}`, { beneficiaryId: carbonPerfUuid("b2000000", i % 10_000), quantityGrams: 1, eligibility: { projectId: carbonPerfUuid("b1000000", 0), vintageFrom: 2020, vintageTo: 2020, methodology: measured ? "HOT" : "WARM" } });
    if (response.status !== 202) throw new Error(response.text);
    return response;
  } });
  if (creates.throughput < 80 || creates.p95 > 500) throw new Error("competing-retirement-create threshold failed");
  const conserved = await ctx.snapshot(apiA.baseUrl);
  if (conserved.resources.creditLots.some((lot) => lot.issuedGrams !== lot.availableGrams + lot.reservedGrams + lot.retiredGrams)) throw new Error("Retirement load violated conservation");
  assertions.push(`competing-retirement-create: ${creates.throughput.toFixed(1)}/s, p95 ${creates.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "competing-retirement-create", ...creates });

  await ctx.resetDatabase(); ({ apiA } = await prepareCarbonPerf(ctx));
  let release; const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-carbon" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-carbon" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Certificates", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL"))); release({ status: 204 }); await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now(); const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(apiA.baseUrl); const recovered = snapshot.resources.retirements.filter(({ retirementId, state }) => Number.parseInt(retirementId.slice(-12), 10) > 100_000 && state === "RETIRED"); return recovered.length === 5_000 && snapshot.work.filter(({ kind, terminal }) => kind === "CERTIFICATE_GENERATION" && !terminal).length === 0 ? snapshot : undefined; }, { timeoutMs: 90_000, label: "5,000 Certificates", children: replacements });
  const recoveryMs = Date.now() - startedAt;
  const recovered = final.resources.retirements.filter(({ retirementId }) => Number.parseInt(retirementId.slice(-12), 10) > 100_000);
  const served = await ctx.concurrent(recovered, 64, (retirement) => ctx.request(apiA.baseUrl, `/api/v1/retirements/${retirement.retirementId}/certificate`, { binary: true }));
  if (served.some((response, i) => response.status !== 200 || digest(response.body) !== recovered[i].certificateDigest)) throw new Error("Certificate bytes mismatch");
  assertions.push(`certificate-recovery: 5,000 Certificates in ${recoveryMs}ms`);
  metrics.push({ scenarioId: "certificate-recovery", completed: 5_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { projects: 1_000, beneficiaries: 10_000, creditLots: 50_000, retirements: 105_000, certificates: 100_000 } };
}

const mergeIds = { document: id(801), block: id(802), client: id(803) };
const mergeboard = {
  label: "MergeBoard document change",
  performanceScenarioIds: ["non-overlapping-change-apply", "document-revision-read", "snapshot-compaction-recovery"],
  seed: async () => base("hidden-merge", {
    documents: [{ documentId: mergeIds.document, title: "Hidden Document", initialBlocks: [{ blockId: mergeIds.block, text: "base" }], createdAt: timestamp }],
    changes: [], snapshots: [],
  }),
  path: `/api/v1/documents/${mergeIds.document}/changes`,
  payload: (index) => ({
    clientId: id(810 + index),
    clientSequence: 1,
    baseRevision: 0,
    operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: "base", newText: `changed-${index}` }],
  }),
  conflictPayload: () => ({ ...mergeboard.payload(0), operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: "base", newText: "conflict" }] }),
  resource: "changes",
  identity: (json) => find(json, "changeId"),
  resourceIdentity: ({ changeId }) => changeId,
  performance: mergePerformance,
  noWork: true,
  async prepareWork(ctx, baseUrl) {
    let revision = 0;
    let text = "base";
    let last;
    for (let index = 0; index < 100; index += 1) {
      const nextText = `recovery-${index}`;
      last = await ctx.mutate(baseUrl, mergeboard.path, `h07-change-${index}`, {
        clientId: id(9000 + index),
        clientSequence: 1,
        baseRevision: revision,
        operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: text, newText: nextText }],
      });
      if (last.status !== 201) throw new Error(last.text);
      revision += 1;
      text = nextText;
    }
    return { json: { documentId: mergeIds.document, changeId: find(last.json, "changeId") } };
  },
  workIdentity: () => mergeIds.document,
  manager: {
    async prepare(ctx, baseUrl) {
      const response = await ctx.request(baseUrl, `/api/v1/documents/${mergeIds.document}/branches`);
      const branches = response.json?.items ?? response.json;
      const main = branches.find((branch) => branch.name === "main") ?? branches[0];
      return {
        path: `/api/v1/documents/${mergeIds.document}/branches`,
        payload: (index) => ({ name: `feature-${index}`, sourceBranchId: main.branchId, sourceRevision: main.headRevision ?? 0 }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const branch = response.json?.branch ?? response.json;
      const changed = await ctx.mutate(baseUrl, `/api/v1/documents/${mergeIds.document}/branches/${branch.branchId}/changes`, "h10-feature-change", {
        clientId: id(820),
        clientSequence: 1,
        baseRevision: 0,
        operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: "base", newText: "feature" }],
      });
      if (changed.status !== 201) throw new Error(changed.text);
      const reviewers = [id(821), id(822)];
      const request = await ctx.mutate(baseUrl, `/api/v1/documents/${mergeIds.document}/merge-requests`, "h10-merge-request", {
        sourceBranchId: branch.branchId,
        targetBranchId: branch.sourceBranchId,
        expectedSourceHeadRevision: 1,
        expectedTargetHeadRevision: 0,
        reviewPolicy: { reviewerIds: reviewers, requiredApprovals: 2 },
      });
      if (request.status !== 201 || find(request.json, "state") !== "IN_REVIEW") throw new Error(request.text);
      const mergeRequestId = find(request.json, "mergeRequestId");
      const first = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/approvals`, "h10-approval-1", { reviewerId: reviewers[0] });
      if (first.status < 200 || first.status >= 300 || find(first.json, "state") !== "IN_REVIEW") throw new Error(first.text);
      const duplicate = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/approvals`, "h10-approval-1-replay", { reviewerId: reviewers[0] });
      if (duplicate.status < 200 || duplicate.status >= 300 || find(duplicate.json, "state") !== "IN_REVIEW") throw new Error(duplicate.text);
      const early = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/merge`, "h10-early-merge", {});
      if (early.status !== 409 || early.json?.error?.code !== "MERGE_REQUEST_NOT_APPROVED") throw new Error(early.text);
      const second = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/approvals`, "h10-approval-2", { reviewerId: reviewers[1] });
      if (second.status < 200 || second.status >= 300 || find(second.json, "state") !== "APPROVED") throw new Error(second.text);
      const merged = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/merge`, "h10-merge", {});
      if (merged.status < 200 || merged.status >= 300 || find(merged.json, "state") !== "MERGED") throw new Error(merged.text);
      const snapshot = await ctx.snapshot(baseUrl);
      const target = snapshot.resources.branches.find(({ branchId }) => branchId === branch.sourceBranchId);
      const source = snapshot.resources.branches.find(({ branchId }) => branchId === branch.branchId);
      if (target.headRevision !== 1 || source.headRevision !== 1) throw new Error("Merge did not create exactly one target revision or changed source");
      const stored = snapshot.resources.mergeRequests.find((item) => item.mergeRequestId === mergeRequestId);
      if (stored.approvals.length !== 2 || new Set(stored.approvals.map(({ reviewerId }) => reviewerId)).size !== 2) {
        throw new Error("Review threshold did not retain two distinct approvals");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const branch = response.json?.branch ?? response.json;
      const sourceChange = await ctx.mutate(baseUrls[0], `/api/v1/documents/${mergeIds.document}/branches/${branch.branchId}/changes`, "h11-source-change", {
        clientId: id(830), clientSequence: 1, baseRevision: 0,
        operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: "base", newText: "source" }],
      });
      if (sourceChange.status !== 201) throw new Error(sourceChange.text);
      const reviewers = [id(831), id(833), id(834)];
      const request = await ctx.mutate(baseUrls[0], `/api/v1/documents/${mergeIds.document}/merge-requests`, "h11-merge-request", {
        sourceBranchId: branch.branchId,
        targetBranchId: branch.sourceBranchId,
        expectedSourceHeadRevision: 1,
        expectedTargetHeadRevision: 0,
        reviewPolicy: { reviewerIds: reviewers, requiredApprovals: 2 },
      });
      if (request.status !== 201) throw new Error(request.text);
      const mergeRequestId = find(request.json, "mergeRequestId");
      const firstApproval = await ctx.mutate(baseUrls[0], `/api/v1/merge-requests/${mergeRequestId}/approvals`, "h11-approval-first", { reviewerId: reviewers[2] });
      if (firstApproval.status < 200 || firstApproval.status >= 300 || find(firstApproval.json, "state") !== "IN_REVIEW") throw new Error(firstApproval.text);
      const finalApprovals = await ctx.concurrent(reviewers.slice(0, 2), 2, (reviewerId, index) => ctx.mutate(
        baseUrls[index % 2],
        `/api/v1/merge-requests/${mergeRequestId}/approvals`,
        `h11-approval-final-${index}`,
        { reviewerId },
      ));
      assert.equal(finalApprovals.filter(({ status, json }) => status >= 200 && status < 300 && find(json, "state") === "APPROVED").length, 1);
      assert.equal(finalApprovals.filter(({ status, json }) => status === 409 && json?.error?.code === "REVIEWER_NOT_ELIGIBLE").length, 1);
      const approvedSnapshot = await ctx.snapshot(baseUrls[1]);
      const approvedRequest = approvedSnapshot.resources.mergeRequests.find((item) => item.mergeRequestId === mergeRequestId);
      assert.equal(approvedRequest.state, "APPROVED");
      assert.equal(approvedRequest.approvals.length, 2);
      assert.equal(new Set(approvedRequest.approvals.map(({ reviewerId }) => reviewerId)).size, 2);
      assert.ok(approvedRequest.approvals.some(({ reviewerId }) => reviewerId === reviewers[2]));
      assert.equal(approvedRequest.approvals.filter(({ reviewerId }) => reviewers.slice(0, 2).includes(reviewerId)).length, 1);
      const approvalReviewerIds = approvedRequest.approvals.map(({ reviewerId }) => reviewerId);
      assert.deepEqual(approvalReviewerIds, [...approvalReviewerIds].sort());
      assert.ok(approvedRequest.approvals.every(({ resultDigest }) => resultDigest === approvedRequest.resultDigest));
      const successfulApproval = finalApprovals.find(({ status, json }) => status >= 200 && status < 300 && find(json, "state") === "APPROVED");
      assert.equal(ctx.canonical(successfulApproval.json?.mergeRequest ?? successfulApproval.json), ctx.canonical(approvedRequest));
      assert.equal(approvedSnapshot.events.filter(({ type }) => type === "merge-request.approved").length, 1);
      const targetChange = await ctx.mutate(baseUrls[1], mergeboard.path, "h11-target-change", {
        clientId: id(832), clientSequence: 1, baseRevision: 0,
        operations: [{ op: "REPLACE", blockId: mergeIds.block, expectedText: "base", newText: "target" }],
      });
      if (targetChange.status !== 201) throw new Error(targetChange.text);
      const stale = await ctx.mutate(baseUrls[0], `/api/v1/merge-requests/${mergeRequestId}/merge`, "h11-stale-merge", {});
      if (stale.status !== 409 || stale.json?.error?.code !== "MERGE_REQUEST_STALE") throw new Error(stale.text);
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const stored = snapshot.resources.mergeRequests.find((item) => item.mergeRequestId === mergeRequestId);
      const target = snapshot.resources.branches.find(({ branchId }) => branchId === branch.sourceBranchId);
      if (stored.state !== "STALE" || target.headRevision !== 1 || stored.mergedTargetRevision !== null) {
        throw new Error("Head drift did not make the reviewed Merge Request terminally STALE without another target revision");
      }
      assert.equal(snapshot.events.filter(({ type }) => type === "merge-request.approved").length, 1);
    },
  },
  uiPattern: /document|revision|change/iu,
};

const mergePerfUuid = (namespace, ordinal) => `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
const mergeText = (revision) => `revision-${String(revision).padStart(55, "0")}`;

async function mergePerfSeedFile(ctx) {
  const path = join(ctx.temporary, "merge-perf-seed.json");
  if (mergePerfSeedFile.cached === path) return path;
  const stream = createWriteStream(path);
  await streamWrite(stream, '{"schemaVersion":1,"seedVersion":"perf-v1","documents":[');
  for (let documentIndex = 0; documentIndex < 10_000; documentIndex += 1) {
    if (documentIndex) await streamWrite(stream, ",");
    await streamWrite(stream, JSON.stringify({ documentId: mergePerfUuid("m1000000", documentIndex), title: `Document ${documentIndex}`, initialBlocks: [{ blockId: mergePerfUuid("m2000000", documentIndex), text: mergeText(0) }], createdAt: timestamp }));
  }
  await streamWrite(stream, '],"changes":[');
  for (let documentIndex = 0; documentIndex < 10_000; documentIndex += 1) for (let revision = 1; revision <= 100; revision += 1) {
    if (documentIndex || revision > 1) await streamWrite(stream, ",");
    const ordinal = documentIndex * 100 + revision - 1;
    await streamWrite(stream, JSON.stringify({ changeId: mergePerfUuid("m3000000", ordinal), documentId: mergePerfUuid("m1000000", documentIndex), clientId: mergePerfUuid("m4000000", documentIndex), clientSequence: revision, baseRevision: revision - 1, operations: [{ op: "REPLACE", blockId: mergePerfUuid("m2000000", documentIndex), expectedText: mergeText(revision - 1), newText: mergeText(revision) }], state: "APPLIED", revision, conflicts: [], createdAt: timestamp }));
  }
  await streamWrite(stream, '],"snapshots":[]}'); stream.end(); await once(stream, "finish");
  mergePerfSeedFile.cached = path;
  return path;
}

async function prepareMergePerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seedFile(await mergePerfSeedFile(ctx));
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function mergePerformance(ctx, assertions) {
  const scale = performanceScale(); const metrics = [];
  let { apiA, apiB } = await prepareMergePerf(ctx);
  const states = Array.from({ length: 64 }, (_, client) => ({ client, measured: false, revision: 100, sequence: 0, text: mergeText(100) }));
  const changes = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale, request: async ({ measured, client }) => {
    const state = states[client];
    if (measured && !state.measured) { state.measured = true; state.revision = 100; state.sequence = 0; state.text = mergeText(100); }
    const documentIndex = (measured ? 1_000 : 0) + client;
    const nextText = `${measured ? "m" : "w"}-${String(state.sequence + 1).padStart(62, "0")}`;
    const response = await ctx.mutate(client % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/documents/${mergePerfUuid("m1000000", documentIndex)}/changes`, `perf-change-${measured ? "m" : "w"}-${client}-${state.sequence}`, { clientId: mergePerfUuid(measured ? "m6000000" : "m5000000", client), clientSequence: state.sequence + 1, baseRevision: state.revision, operations: [{ op: "REPLACE", blockId: mergePerfUuid("m2000000", documentIndex), expectedText: state.text, newText: nextText }] });
    if (response.status !== 201 || find(response.json, "state") !== "APPLIED") throw new Error(response.text);
    state.sequence += 1; state.revision += 1; state.text = nextText;
    return response;
  } });
  if (changes.throughput < 300 || changes.p95 > 250) throw new Error("non-overlapping-change-apply threshold failed");
  const afterChanges = await ctx.snapshot(apiA.baseUrl);
  for (const state of states) { const document = afterChanges.resources.documents.find(({ documentId }) => documentId === mergePerfUuid("m1000000", 1_000 + state.client)); if (document.headRevision !== state.revision) throw new Error("Document revision gap"); }
  assertions.push(`non-overlapping-change-apply: ${changes.throughput.toFixed(1)}/s, p95 ${changes.p95.toFixed(1)}ms`); metrics.push({ scenarioId: "non-overlapping-change-apply", ...changes });

  await ctx.resetDatabase(); ({ apiA, apiB } = await prepareMergePerf(ctx)); let readOrdinal = 0;
  const reads = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale, request: async () => {
    const ordinal = readOrdinal++; const documentIndex = Math.floor(ordinal / 101) % 10_000; const revision = ordinal % 101; const documentId = mergePerfUuid("m1000000", documentIndex);
    const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/documents/${documentId}/revisions/${revision}`);
    const value = response.json?.documentRevision ?? response.json;
    if (response.status !== 200 || value.canonicalDigest !== digest(canonicalJson({ documentId, revision, blocks: value.blocks }))) throw new Error("DocumentRevision digest mismatch");
    return response;
  } });
  if (reads.throughput < 400 || reads.p95 > 120) throw new Error("document-revision-read threshold failed");
  assertions.push(`document-revision-read: ${reads.throughput.toFixed(1)}/s, p95 ${reads.p95.toFixed(1)}ms`); metrics.push({ scenarioId: "document-revision-read", ...reads });

  await ctx.resetDatabase(); ({ apiA } = await prepareMergePerf(ctx));
  let release; const held = new Promise((resolve) => { release = resolve; }); const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-merge" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-merge" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed compactions", children: first }); await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL"))); release({ status: 204 }); await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now(); const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(apiA.baseUrl); return snapshot.resources.documentSnapshots.length === 10_000 && snapshot.work.filter(({ kind, terminal }) => kind === "SNAPSHOT_COMPACTION" && !terminal).length === 0 ? snapshot : undefined; }, { timeoutMs: 120_000, label: "10,000 Snapshot compactions", children: replacements });
  const recoveryMs = Date.now() - startedAt;
  for (let i = 0; i < 10_000; i += 1) { const documentId = mergePerfUuid("m1000000", i); const expected = digest(canonicalJson({ documentId, revision: 100, blocks: [{ blockId: mergePerfUuid("m2000000", i), text: mergeText(100) }] })); const snapshot = final.resources.documentSnapshots.find((item) => item.documentId === documentId); if (snapshot?.revision !== 100 || snapshot.canonicalDigest !== expected) throw new Error(`Snapshot replay mismatch ${documentId}`); }
  if (final.resources.changes.length !== 1_000_000) throw new Error("compaction deleted operation history");
  assertions.push(`snapshot-compaction-recovery: 1,000,000 operations compacted in ${recoveryMs}ms`); metrics.push({ scenarioId: "snapshot-compaction-recovery", documents: 10_000, operations: 1_000_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { documents: 10_000, changes: 1_000_000, operations: 1_000_000, snapshots: 0 } };
}

const auctionIds = { auction: id(901), lot: id(902), bidders: [id(903), id(904), id(905)] };

async function submitMultiUnitBids(ctx, baseUrl, auctionId, keyPrefix) {
  const opened = await ctx.mutate(baseUrl, `/api/v1/admin/auctions/${auctionId}/open`, `${keyPrefix}-open`, {});
  if (opened.status < 200 || opened.status >= 300) throw new Error(opened.text);
  for (const [index, bid] of [
    { bidderId: auctionIds.bidders[0], amountMinor: 200, quantity: 2 },
    { bidderId: auctionIds.bidders[1], amountMinor: 190, quantity: 2 },
    { bidderId: auctionIds.bidders[2], amountMinor: 180, quantity: 3 },
  ].entries()) {
    const response = await ctx.mutate(baseUrl, `/api/v1/auctions/${auctionId}/bids`, `${keyPrefix}-bid-${index}`, bid);
    if (response.status !== 201) throw new Error(response.text);
  }
}

async function waitForMultiUnitOutcome(ctx, baseUrl, auctionId, workers) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const auction = snapshot.resources.auctions.find((item) => item.auctionId === auctionId);
    const awards = snapshot.resources.awards.filter((award) => award.auctionId === auctionId);
    return auction?.state === "CLOSED" && awards.length === 3 ? snapshot : undefined;
  }, { timeoutMs: 150_000, label: "multi-unit Auction outcome", children: workers });
}

function assertMultiUnitOutcome(ctx, snapshot, auctionId) {
  const auction = snapshot.resources.auctions.find((item) => item.auctionId === auctionId);
  const awards = snapshot.resources.awards.filter((award) => award.auctionId === auctionId).sort((left, right) => left.allocationRank - right.allocationRank);
  const outcomes = snapshot.resources.auctionOutcomes.filter((outcome) => outcome.auctionId === auctionId);
  const outcome = outcomes[0];
  const allocation = awards.map(({ allocatedQuantity, clearingUnitPriceMinor, totalAmountMinor }) => ({ allocatedQuantity, clearingUnitPriceMinor, totalAmountMinor }));
  const expected = [
    { allocatedQuantity: 2, clearingUnitPriceMinor: 180, totalAmountMinor: 360 },
    { allocatedQuantity: 2, clearingUnitPriceMinor: 180, totalAmountMinor: 360 },
    { allocatedQuantity: 1, clearingUnitPriceMinor: 180, totalAmountMinor: 180 },
  ];
  if (ctx.canonical(allocation) !== ctx.canonical(expected)
    || awards.reduce((sum, award) => sum + award.allocatedQuantity, 0) !== 5
    || new Set(awards.map(({ bidId }) => bidId)).size !== 3
    || outcomes.length !== 1 || outcome.result !== "WINNER" || outcome.unitCount !== 5
    || outcome.allocatedUnitCount !== 5 || outcome.unallocatedUnitCount !== 0 || outcome.clearingUnitPriceMinor !== 180
    || auction.state !== "CLOSED" || auction.unitCount !== 5 || auction.winnerId !== null || auction.winningAmountMinor !== null) {
    throw new Error("Multi-unit close did not produce one conserved partial allocation at the uniform clearing price");
  }
}

const auctionguard = {
  label: "AuctionGuard bid commit",
  performanceScenarioIds: ["hot-auction-bids", "live-auction-read", "auction-close-recovery"],
  seed: async (ctx) => {
    const now = Date.now();
    const endAt = new Date(now + (ctx.case === "H-07" ? 2_000 : 300_000)).toISOString();
    return base("hidden-auction", {
      bidders: auctionIds.bidders.map((bidderId, index) => ({ bidderId, displayName: `Bidder ${index + 1}` })),
      lots: [{ lotId: auctionIds.lot, title: "Hidden Lot", description: "Harness lot" }],
      auctions: [{
        auctionId: auctionIds.auction,
        lotId: auctionIds.lot,
        currency: "USD",
        reservePriceMinor: 100,
        minimumIncrementMinor: 10,
        startAt: new Date(now - 60_000).toISOString(),
        effectiveEndAt: endAt,
        state: "OPEN",
        leadingBidId: null,
        winnerId: null,
        winningAmountMinor: null,
        sequence: 1,
        antiSnipingWindowSeconds: 120,
      }],
      bids: [],
    });
  },
  path: `/api/v1/auctions/${auctionIds.auction}/bids`,
  payload: (index) => ({ bidderId: auctionIds.bidders[index % auctionIds.bidders.length], amountMinor: 100 + index * 10 }),
  conflictPayload: () => ({ bidderId: auctionIds.bidders[1], amountMinor: 500 }),
  resource: "bids",
  identity: (json) => find(json, "bidId"),
  workIdentity: () => auctionIds.auction,
  resourceIdentity: ({ bidId }) => bidId,
  performance: auctionPerformance,
  noWork: true,
  prepareWork: async () => ({ json: { bidId: "no-bid", auctionId: auctionIds.auction } }),
  manager: {
    path: "/api/v1/admin/auctions",
    payload: (index) => ({
      lotId: auctionIds.lot,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: new Date(Date.now() - 1_000).toISOString(),
      endAt: new Date(Date.now() + 4_000 + index).toISOString(),
      unitCount: 5,
    }),
    async verify(ctx, baseUrl, response) {
      const auctionId = find(response.json, "auctionId");
      await submitMultiUnitBids(ctx, baseUrl, auctionId, "h10-manager");
      const worker = await ctx.startWorker();
      const snapshot = await waitForMultiUnitOutcome(ctx, baseUrl, auctionId, [worker]);
      assertMultiUnitOutcome(ctx, snapshot, auctionId);
      const detail = await ctx.request(baseUrl, `/api/v1/auctions/${auctionId}`);
      const value = detail.json?.auction ?? detail.json;
      if (detail.status !== 200 || value.awards?.length !== 3 || value.outcome?.awards?.length !== 3
        || ctx.canonical(value.awards) !== ctx.canonical(value.outcome.awards)) {
        throw new Error("Auction detail and outcome expose different Award sets");
      }
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const auctionId = find(response.json, "auctionId");
      await submitMultiUnitBids(ctx, baseUrls[0], auctionId, "h11-manager");
      const workers = [await ctx.startWorker(), await ctx.startWorker()];
      const snapshot = await waitForMultiUnitOutcome(ctx, baseUrls[1], auctionId, workers);
      assertMultiUnitOutcome(ctx, snapshot, auctionId);
      const awards = snapshot.resources.awards.filter((award) => award.auctionId === auctionId);
      if (new Set(awards.map(({ awardId }) => awardId)).size !== 3
        || new Set(awards.map(({ allocationRank }) => allocationRank)).size !== 3
        || snapshot.work.some(({ aggregateId, terminal }) => aggregateId === auctionId && !terminal)) {
        throw new Error("Competing Close workers duplicated Awards or left the canonical outcome pending");
      }
    },
  },
  uiPattern: /auction|bid|lot/iu,
};

function auctionPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function auctionPerfSeed() {
  const bidders = Array.from({ length: 100_000 }, (_, index) => ({ bidderId: auctionPerfUuid("91000000", index), displayName: `Bidder ${index}` }));
  const lots = Array.from({ length: 2_020 }, (_, index) => ({ lotId: auctionPerfUuid("92000000", index), title: `Lot ${index}`, description: "Performance lot" }));
  const auctions = [];
  const bids = [];
  for (let auctionIndex = 0; auctionIndex < 20; auctionIndex += 1) {
    const auctionId = auctionPerfUuid("93000000", auctionIndex);
    const effectiveEndAt = "2030-01-01T00:00:00.000Z";
    for (let sequence = 1; sequence <= 2_500; sequence += 1) {
      const bidIndex = auctionIndex * 2_500 + sequence - 1;
      bids.push({
        bidId: auctionPerfUuid("94000000", bidIndex),
        auctionId,
        bidderId: auctionPerfUuid("91000000", bidIndex),
        amountMinor: 90 + sequence * 10,
        committedSequence: sequence,
        state: sequence === 2_500 ? "WINNING" : "OUTBID",
        acceptedAt: `2026-01-${String((sequence % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        effectiveEndAtAfter: effectiveEndAt,
      });
    }
    auctions.push({
      auctionId,
      lotId: lots[auctionIndex].lotId,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: "2025-01-01T00:00:00.000Z",
      effectiveEndAt,
      state: "OPEN",
      leadingBidId: auctionPerfUuid("94000000", auctionIndex * 2_500 + 2_499),
      winnerId: null,
      winningAmountMinor: null,
      sequence: 2_501,
      antiSnipingWindowSeconds: 120,
    });
  }
  for (let index = 20; index < 2_020; index += 1) {
    auctions.push({
      auctionId: auctionPerfUuid("93000000", index),
      lotId: lots[index].lotId,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: "2025-01-01T00:00:00.000Z",
      effectiveEndAt: "2026-01-01T00:00:00.000Z",
      state: "CLOSING",
      leadingBidId: null,
      winnerId: null,
      winningAmountMinor: null,
      sequence: 2,
      antiSnipingWindowSeconds: 120,
    });
  }
  return base("perf-v1", { bidders, lots, auctions, bids });
}

async function prepareAuctionPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(auctionPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function auctionPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareAuctionPerf(ctx);
  const producers = Array.from({ length: 20 }, (_, auctionIndex) => ({ auctionIndex, amount: 25_090, warmupCount: 0, measuredCount: 0, measured: false }));
  const hot = await measuredLoad(ctx, {
    concurrency: 20,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured, client }) => {
      const producer = producers[client];
      if (measured && !producer.measured) producer.measured = true;
      const count = producer.measured ? producer.measuredCount++ : producer.warmupCount++;
      const bidderIndex = (producer.measured ? 75_000 : 50_000) + client + ((count * 20) % 25_000);
      producer.amount += 10;
      const response = await ctx.mutate(client % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/auctions/${auctionPerfUuid("93000000", client)}/bids`, `perf-hot-bid-${client}-${producer.amount}`, {
        bidderId: auctionPerfUuid("91000000", bidderIndex),
        amountMinor: producer.amount,
      });
      if (response.status !== 201) throw new Error(response.text);
      return response;
    },
  });
  if (hot.throughput < 250 || hot.p95 > 300 || Object.keys(hot.statuses).some((status) => Number(status) >= 500)) throw new Error(`hot-auction-bids failed: ${hot.throughput}/s p95=${hot.p95}`);
  const hotSnapshot = await ctx.snapshot(apiA.baseUrl);
  for (let auctionIndex = 0; auctionIndex < 20; auctionIndex += 1) {
    const auctionId = auctionPerfUuid("93000000", auctionIndex);
    const auctionBids = hotSnapshot.resources.bids.filter((bid) => bid.auctionId === auctionId);
    const sequences = auctionBids.map(({ committedSequence }) => committedSequence);
    if (ctx.canonical(sequences) !== ctx.canonical(Array.from({ length: sequences.length }, (_, index) => index + 1))) throw new Error(`bid sequence gap for ${auctionId}`);
    const leader = auctionBids.at(-1);
    if (leader.state !== "WINNING" || auctionBids.slice(0, -1).some(({ state }) => state === "WINNING")) throw new Error(`invalid leader for ${auctionId}`);
  }
  assertions.push(`hot-auction-bids: ${hot.throughput.toFixed(1)}/s, p95 ${hot.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "hot-auction-bids", ...hot });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareAuctionPerf(ctx));
  let readOrdinal = 0;
  const reads = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = readOrdinal++;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/auctions/${auctionPerfUuid("93000000", ordinal % 20)}`);
      const auction = response.json?.auction ?? response.json;
      if (response.status !== 200 || auction.state !== "OPEN" || !auction.leadingBidId || auction.effectiveEndAt !== "2030-01-01T00:00:00.000Z") throw new Error(response.text);
      return response;
    },
  });
  if (reads.throughput < 400 || reads.p95 > 100 || Object.keys(reads.statuses).some((status) => Number(status) >= 500)) throw new Error(`live-auction-read failed: ${reads.throughput}/s p95=${reads.p95}`);
  assertions.push(`live-auction-read: ${reads.throughput.toFixed(1)}/s, p95 ${reads.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "live-auction-read", ...reads });

  await ctx.resetDatabase();
  ({ apiA } = await prepareAuctionPerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-auction" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-auction" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Auction closes", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const closeStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const closing = snapshot.resources.auctions.filter(({ state }) => state === "CLOSING");
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "AUCTION_CLOSE" && !terminal);
    return closing.length === 0 && pending.length === 0 && snapshot.resources.auctionOutcomes.length === 2_000 ? snapshot : undefined;
  }, { timeoutMs: 45_000, label: "2,000 Auction closes", children: replacements });
  const closeMs = Date.now() - closeStartedAt;
  if (new Set(final.resources.auctionOutcomes.map(({ auctionId }) => auctionId)).size !== 2_000) throw new Error("Auction close created duplicate outcomes");
  assertions.push(`auction-close-recovery: 2,000 Auctions closed in ${closeMs}ms after two SIGKILLs`);
  metrics.push({ scenarioId: "auction-close-recovery", completed: 2_000, durationMs: closeMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { bidders: 100_000, lots: 2_020, auctions: 2_020, bids: 50_000, openHotAuctions: 20, closingAuctions: 2_000 } };
}

function expectedReleaseMembers(members, bytesByPlatform) {
  return members.map(({ platform }) => ({
    platform,
    sha256: digest(bytesByPlatform.get(platform)),
    size: bytesByPlatform.get(platform).length,
    mediaType: "application/octet-stream",
  })).sort((left, right) => left.platform < right.platform ? -1 : left.platform > right.platform ? 1 : 0);
}

function assertPublishedReleaseSnapshot(ctx, snapshot, release, members, bytesByPlatform) {
  const stored = snapshot.resources.releases.find(({ releaseId }) => releaseId === release.releaseId);
  assert.equal(stored.state, "PUBLISHED");
  assert.ok(stored.artifacts.every(({ state, artifactVersionId }) => state === "COMMITTED" && artifactVersionId));
  const uploads = snapshot.resources.uploadSessions.filter(({ releaseId }) => releaseId === release.releaseId);
  assert.equal(uploads.length, members.length);
  assert.ok(uploads.every(({ state, artifactVersionId }) => state === "COMMITTED" && artifactVersionId));
  const versions = snapshot.resources.artifactVersions.filter(({ packageName, version }) => packageName === release.packageName && version === release.version);
  assert.equal(versions.length, members.length);
  for (const version of versions) {
    const bytes = bytesByPlatform.get(version.platform);
    assert.ok(bytes, `unexpected published platform ${version.platform}`);
    assert.deepEqual(version.blob, { sha256: digest(bytes), size: bytes.length, mediaType: "application/octet-stream" });
  }
  const versionIds = new Set(versions.map(({ artifactVersionId }) => artifactVersionId));
  const references = snapshot.resources.blobReferences.filter(({ artifactVersionId }) => versionIds.has(artifactVersionId));
  assert.equal(references.length, members.length);
  assert.equal(new Set(references.map(({ artifactVersionId }) => artifactVersionId)).size, members.length);
  return expectedReleaseMembers(members, bytesByPlatform);
}

const artifactvault = {
  label: "ArtifactVault upload session",
  performanceScenarioIds: ["concurrent-upload-stream", "artifact-metadata-read", "verification-recovery"],
  seed: async () => base("hidden-artifact", {
    packages: [{ packageName: "hidden-package", displayName: "Hidden Package" }],
    artifactVersions: [],
  }),
  path: "/api/v1/upload-sessions",
  payload: (index) => {
    const bytes = Buffer.from(`artifact-${index}`);
    return { packageName: "hidden-package", version: `1.0.${index}`, mediaType: "application/octet-stream", expectedSize: bytes.length, expectedSha256: digest(bytes) };
  },
  conflictPayload: () => ({ ...artifactvault.payload(0), expectedSha256: "f".repeat(64) }),
  resource: "uploadSessions",
  identity: (json) => find(json, "uploadId"),
  resourceIdentity: ({ uploadId }) => uploadId,
  performance: artifactPerformance,
  noWork: true,
  async prepareWork(ctx, baseUrl) {
    const payload = artifactvault.payload(3);
    const created = await ctx.mutate(baseUrl, artifactvault.path, "h07-upload", payload);
    const uploadId = find(created.json, "uploadId");
    const bytes = Buffer.from("artifact-3");
    const chunk = await ctx.request(baseUrl, `/api/v1/upload-sessions/${uploadId}/chunks`, {
      method: "PUT",
      headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`, "idempotency-key": "h07-chunk" },
      raw: bytes,
    });
    if (![200, 201].includes(chunk.status)) throw new Error(chunk.text);
    const completed = await ctx.mutate(baseUrl, `/api/v1/upload-sessions/${uploadId}/complete`, "h07-complete", {});
    if (completed.status !== 202) throw new Error(completed.text);
    return { json: { uploadId } };
  },
  manager: {
    path: "/api/v1/releases",
    payload: (index) => ({
      packageName: "hidden-package",
      version: `2.0.${index}`,
      artifacts: [
        { platform: "linux-arm64", expectedSize: 3, expectedSha256: digest("abc"), mediaType: "application/octet-stream" },
        { platform: "darwin-arm64", expectedSize: 3, expectedSha256: digest("xyz"), mediaType: "application/octet-stream" },
      ],
    }),
    async verify(ctx, baseUrl, response) {
      const release = response.json?.release ?? response.json;
      const releaseId = find(release, "releaseId");
      const members = release.artifacts ?? [];
      assert.equal(members.length, 2);
      const bytesByPlatform = new Map([["linux-arm64", Buffer.from("abc")], ["darwin-arm64", Buffer.from("xyz")]]);
      const upload = async (member, prefix) => {
        const bytes = bytesByPlatform.get(member.platform);
        assert.ok(bytes, `unexpected release platform ${member.platform}`);
        const chunk = await ctx.request(baseUrl, `/api/v1/upload-sessions/${member.uploadId}/chunks`, {
          method: "PUT",
          headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`, "idempotency-key": `${prefix}-${member.platform}-chunk` },
          raw: bytes,
        });
        assert.ok([200, 201].includes(chunk.status), chunk.text);
        const complete = await ctx.mutate(baseUrl, `/api/v1/upload-sessions/${member.uploadId}/complete`, `${prefix}-${member.platform}-complete`, {});
        assert.equal(complete.status, 202, complete.text);
      };
      await upload(members[0], "h10");
      const worker = await ctx.startWorker();
      const partial = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const stored = snapshot.resources.releases.find((item) => item.releaseId === releaseId);
        return stored?.artifacts?.some(({ state }) => state === "VERIFIED") ? snapshot : undefined;
      }, { timeoutMs: 30_000, label: "one release member VERIFIED", children: [worker] });
      const partialRelease = partial.resources.releases.find((item) => item.releaseId === releaseId);
      assert.equal(partialRelease.state, "DRAFT");
      assert.equal(partialRelease.artifacts.filter(({ state }) => state === "VERIFIED").length, 1);
      assert.ok(partialRelease.artifacts.every(({ artifactVersionId }) => artifactVersionId === null));
      assert.equal(partial.resources.artifactVersions.filter(({ packageName, version }) => packageName === release.packageName && version === release.version).length, 0);
      const beforePrematurePublish = stableSnapshot(partial);
      const premature = await ctx.mutate(baseUrl, `/api/v1/releases/${releaseId}/publish`, "h10-premature-publish", {});
      assert.equal(premature.status, 409, premature.text);
      assert.equal(premature.json?.error?.code, "RELEASE_NOT_READY");
      assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), beforePrematurePublish);
      await upload(members[1], "h10");
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const stored = snapshot.resources.releases.find((item) => item.releaseId === releaseId);
        return stored?.artifacts?.every(({ state }) => state === "VERIFIED") ? snapshot : undefined;
      }, { timeoutMs: 30_000, label: "release members VERIFIED", children: [worker] });
      const published = await ctx.mutate(baseUrl, `/api/v1/releases/${releaseId}/publish`, "h10-publish", {});
      assert.ok(published.status >= 200 && published.status < 300, published.text);
      const detail = await ctx.request(baseUrl, `/api/v1/packages/${release.packageName}/releases/${release.version}`);
      assert.equal(detail.status, 200, detail.text);
      const releaseDetail = detail.json?.releaseDetail ?? detail.json;
      const expectedMembers = expectedReleaseMembers(members, bytesByPlatform);
      const expectedDigest = digest(JSON.stringify(expectedMembers));
      assert.deepEqual(releaseDetail.manifest, {
        packageName: release.packageName,
        version: release.version,
        artifacts: expectedMembers,
        manifestSha256: expectedDigest,
      });
      const after = await ctx.snapshot(baseUrl);
      assert.deepEqual(assertPublishedReleaseSnapshot(ctx, after, { ...release, releaseId }, members, bytesByPlatform), expectedMembers);
      for (const { platform } of expectedMembers) {
        const content = await ctx.request(baseUrl, `/api/v1/packages/${release.packageName}/releases/${release.version}/artifacts/${platform}/content`, { binary: true });
        assert.equal(content.status, 200, content.text);
        assert.equal(digest(content.body), digest(bytesByPlatform.get(platform)));
      }
      const singular = await ctx.request(baseUrl, `/api/v1/packages/${release.packageName}/versions/${release.version}/content`);
      assert.equal(singular.status, 409, singular.text);
      assert.equal(singular.json?.error?.code, "PLATFORM_REQUIRED");
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const release = response.json?.release ?? response.json;
      const releaseId = find(release, "releaseId");
      const members = release.artifacts ?? [];
      const bytesByPlatform = new Map([["linux-arm64", Buffer.from("abc")], ["darwin-arm64", Buffer.from("xyz")]]);
      for (const member of members) {
        const bytes = bytesByPlatform.get(member.platform);
        const chunk = await ctx.request(baseUrls[0], `/api/v1/upload-sessions/${member.uploadId}/chunks`, { method: "PUT", headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`, "idempotency-key": `h11-${member.platform}-chunk` }, raw: bytes });
        assert.ok([200, 201].includes(chunk.status), chunk.text);
        assert.equal((await ctx.mutate(baseUrls[0], `/api/v1/upload-sessions/${member.uploadId}/complete`, `h11-${member.platform}-complete`, {})).status, 202);
      }
      const workers = [await ctx.startWorker(), await ctx.startWorker()];
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrls[0]);
        return snapshot.resources.releases.find((item) => item.releaseId === releaseId)?.artifacts?.every(({ state }) => state === "VERIFIED") ? snapshot : undefined;
      }, { timeoutMs: 30_000, label: "contended release members VERIFIED", children: workers });
      const attempts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(baseUrls[index % 2], `/api/v1/releases/${releaseId}/publish`, `h11-publish-${index}`, {}));
      assert.ok(attempts.some(({ status }) => status >= 200 && status < 300));
      assert.ok(attempts.every(({ status }) => status < 500));
      const snapshot = await ctx.snapshot(baseUrls[1]);
      assertPublishedReleaseSnapshot(ctx, snapshot, { ...release, releaseId }, members, bytesByPlatform);
    },
  },
  uiPattern: /artifact|upload|package/iu,
};

function artifactPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

async function artifactPerfSeed(ctx) {
  const assets = join(ctx.temporary, "assets");
  await mkdir(assets, { recursive: true });
  const bytes = Buffer.from("a");
  await writeFile(join(assets, "shared.bin"), bytes);
  const expectedSha256 = digest(bytes);
  return base("perf-v1", {
    packages: Array.from({ length: 100_000 }, (_, index) => ({ packageName: `perf-package-${String(index).padStart(6, "0")}`, displayName: `Package ${index}` })),
    artifactVersions: Array.from({ length: 100_000 }, (_, index) => ({
      artifactVersionId: artifactPerfUuid("a1000000", index), packageName: `perf-package-${String(index).padStart(6, "0")}`,
      version: "1.0.0", mediaType: "application/octet-stream", assetPath: "shared.bin", expectedSize: 1, expectedSha256, committedAt: timestamp,
    })),
  });
}

async function prepareArtifactPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(await artifactPerfSeed(ctx));
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function createArtifactUploads(ctx, baseUrls, count, prefix, bytes) {
  const expectedSha256 = digest(bytes);
  return ctx.concurrent(Array.from({ length: count }, (_, index) => index), Math.min(count, 32), async (index) => {
    const response = await ctx.mutate(baseUrls[index % baseUrls.length], "/api/v1/upload-sessions", `${prefix}-create-${index}`, {
      packageName: `perf-package-${String(index).padStart(6, "0")}`, version: `${prefix}-${index}`, mediaType: "application/octet-stream",
      expectedSize: bytes.length, expectedSha256,
    });
    if (response.status !== 201) throw new Error(response.text);
    return { index, uploadId: find(response.json, "uploadId") };
  });
}

async function uploadArtifactBytes(ctx, baseUrls, uploads, bytes, prefix) {
  const chunkSize = 8 * 1024 * 1024;
  return ctx.concurrent(uploads, uploads.length, async ({ index, uploadId }) => {
    const responses = [];
    for (let start = 0; start < bytes.length; start += chunkSize) {
      const end = Math.min(bytes.length, start + chunkSize);
      const response = await ctx.request(baseUrls[index % baseUrls.length], `/api/v1/upload-sessions/${uploadId}/chunks`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${start}-${end - 1}/${bytes.length}`,
          "idempotency-key": `${prefix}-chunk-${index}-${start}`,
        },
        raw: bytes.subarray(start, end),
        timeoutMs: 120_000,
      });
      if (![200, 201].includes(response.status) || response.json?.nextOffset !== end) throw new Error(response.text ?? "invalid ChunkReceipt");
      responses.push(response);
    }
    return responses;
  });
}

async function artifactPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareArtifactPerf(ctx);
  const bytes = Buffer.alloc(64 * 1024 * 1024, 0x61);
  const uploads = await createArtifactUploads(ctx, [apiA.baseUrl, apiB.baseUrl], 20, "stream", bytes);
  const uploadStartedAt = Date.now();
  const chunkGroups = await uploadArtifactBytes(ctx, [apiA.baseUrl, apiB.baseUrl], uploads, bytes, "stream");
  const uploadMs = Date.now() - uploadStartedAt;
  const throughputMiB = (20 * 64) / (uploadMs / 1_000);
  if (throughputMiB < 120 || uploadMs > 60_000) throw new Error(`concurrent-upload-stream failed: ${throughputMiB} MiB/s`);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  await ctx.concurrent(uploads, 20, async ({ index, uploadId }) => {
    const complete = await ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/upload-sessions/${uploadId}/complete`, `stream-complete-${index}`, {});
    if (complete.status !== 202) throw new Error(complete.text);
  });
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    return uploads.every(({ uploadId }) => snapshot.resources.uploadSessions.some((session) => session.uploadId === uploadId && session.state === "COMMITTED"));
  }, { timeoutMs: 90_000, label: "20 streamed uploads committed", children: workers });
  assertions.push(`concurrent-upload-stream: 1,280 MiB at ${throughputMiB.toFixed(1)} MiB/s`);
  metrics.push({ scenarioId: "concurrent-upload-stream", completedChunks: chunkGroups.flat().length, bytes: 20 * bytes.length, durationMs: uploadMs, throughputMiB });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareArtifactPerf(ctx));
  let metadataOrdinal = 0;
  const metadata = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = metadataOrdinal++ % 100_000;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/packages/perf-package-${String(ordinal).padStart(6, "0")}/versions/1.0.0`);
      const value = response.json?.artifactVersion ?? response.json;
      if (response.status !== 200 || value.blob?.sha256 !== digest("a") || value.blob?.size !== 1 || value.blob?.mediaType !== "application/octet-stream") throw new Error(response.text);
      return response;
    },
  });
  if (metadata.throughput < 200 || metadata.p95 > 120) throw new Error(`artifact-metadata-read failed: ${metadata.throughput}/s p95=${metadata.p95}`);
  assertions.push(`artifact-metadata-read: ${metadata.throughput.toFixed(1)}/s, p95 ${metadata.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "artifact-metadata-read", ...metadata });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareArtifactPerf(ctx));
  const recoveryUploads = await createArtifactUploads(ctx, [apiA.baseUrl, apiB.baseUrl], 32, "recovery", bytes);
  await uploadArtifactBytes(ctx, [apiA.baseUrl, apiB.baseUrl], recoveryUploads, bytes, "recovery");
  await ctx.concurrent(recoveryUploads, 32, async ({ index, uploadId }) => {
    const complete = await ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/upload-sessions/${uploadId}/complete`, `recovery-complete-${index}`, {});
    if (complete.status !== 202) throw new Error(complete.text);
  });
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-artifact" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-artifact" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Artifact verifications", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const baselines = await Promise.all(replacements.map((worker) => ctx.rssBytes(worker)));
  const peaks = [...baselines];
  let sample = true;
  const sampler = (async () => {
    while (sample) {
      await Promise.all(replacements.map(async (worker, index) => { if (worker.child.exitCode === null) peaks[index] = Math.max(peaks[index], await ctx.rssBytes(worker)); }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const recoveryStartedAt = Date.now();
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "ARTIFACT_VERIFICATION" && !terminal);
    return pending.length === 0 && recoveryUploads.every(({ uploadId }) => snapshot.resources.uploadSessions.some((session) => session.uploadId === uploadId && session.state === "COMMITTED")) ? snapshot : undefined;
  }, { timeoutMs: 90_000, label: "2 GiB Artifact verification", children: replacements }).finally(async () => { sample = false; await sampler; });
  const recoveryMs = Date.now() - recoveryStartedAt;
  for (let index = 0; index < peaks.length; index += 1) {
    if (peaks[index] > 768 * 1024 * 1024 || peaks[index] - baselines[index] > 64 * 1024 * 1024) throw new Error(`worker ${index} exceeded RSS bound`);
  }
  const recoveryVersionIds = new Set(final.resources.uploadSessions.filter(({ uploadId }) => recoveryUploads.some((upload) => upload.uploadId === uploadId)).map(({ artifactVersionId }) => artifactVersionId));
  if (recoveryVersionIds.size !== 32 || final.resources.blobReferences.filter(({ artifactVersionId }) => recoveryVersionIds.has(artifactVersionId)).length !== 32) throw new Error("verification did not create exactly one Blob reference per session");
  const content = await ctx.request(apiA.baseUrl, "/api/v1/packages/perf-package-000000/versions/recovery-0/content", { binary: true, timeoutMs: 120_000 });
  if (content.status !== 200 || content.body.length !== bytes.length || digest(content.body) !== digest(bytes)) throw new Error("committed recovery Blob bytes do not verify");
  assertions.push(`verification-recovery: 2 GiB in ${recoveryMs}ms; worker peak RSS within bounds`);
  metrics.push({ scenarioId: "verification-recovery", completed: 32, bytes: 32 * bytes.length, durationMs: recoveryMs, baselineRss: baselines, peakRss: peaks });
  return { metrics, fixtureSummary: { packages: 100_000, artifactVersions: 100_000, sharedSeedBlobBytes: 1, streamedSessions: 20, recoverySessions: 32, recoveryBytes: 2 * 1024 * 1024 * 1024 } };
}

const exportIds = { subject: id(1001), managerSubject: id(1002) };

function exportManifestProjection(shards) {
  return shards.map(({ shardId, ordinal, section, range, recordCount, object }) => ({
    shardId,
    ordinal,
    section,
    range,
    recordCount,
    sha256: object.sha256,
    size: object.size,
    mediaType: object.mediaType,
  }));
}

function assertStoredExportManifest(manifest, shards) {
  const projection = exportManifestProjection(shards);
  const bytes = Buffer.from(canonicalJson(projection));
  assert.equal(manifest.canonicalDigest, digest(bytes));
  assert.deepEqual(manifest.shards, projection);
  assert.deepEqual(manifest.object, {
    sha256: digest(bytes),
    size: bytes.length,
    mediaType: "application/json",
  });
  return { bytes, projection };
}

const exportvault = {
  label: "ExportVault export request",
  performanceScenarioIds: ["range-download", "five-million-record-generation", "expired-object-cleanup"],
  seed: async () => base("hidden-export", {
    subjects: [{ subjectId: exportIds.subject, name: "Hidden Subject", currentDatasetRevision: 1 }],
    datasetRevisions: [{
      subjectId: exportIds.subject,
      revision: 1,
      committedAt: timestamp,
      records: [{ recordId: id(1010), scope: "profile", data: { value: 1 } }],
    }],
    exports: [],
  }),
  path: "/api/v1/exports",
  payload: (index) => ({ subjectId: exportIds.subject, scope: ["profile"], format: index % 2 ? "CSV" : "JSONL" }),
  conflictPayload: () => ({ subjectId: exportIds.subject, scope: ["profile"], format: "CSV" }),
  resource: "exports",
  identity: (json) => find(json, "exportId"),
  resourceIdentity: ({ exportId }) => exportId,
  performance: exportPerformance,
  manager: {
    async prepare(ctx) {
      const records = Array.from({ length: 100_001 }, (_, index) => ({
        recordId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        scope: "profile",
        data: { index },
      }));
      const imported = await ctx.seed(base("hidden-export-manager", {
        subjects: [{ subjectId: exportIds.managerSubject, name: "Manager Subject", currentDatasetRevision: 1 }],
        datasetRevisions: [{ subjectId: exportIds.managerSubject, revision: 1, committedAt: timestamp, records }],
        exports: [],
      }));
      if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
      return {
        path: "/api/v1/exports",
        payload: () => ({ subjectId: exportIds.managerSubject, scope: ["profile"], format: "JSONL" }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const exportId = find(response.json, "exportId");
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.exports.find((item) => item.exportId === exportId)?.state === "READY" ? value : undefined;
      }, { timeoutMs: 60_000, label: "sharded Export READY", children: [worker] });
      const item = snapshot.resources.exports.find((entry) => entry.exportId === exportId);
      const shards = snapshot.resources.exportShards.filter((entry) => entry.exportId === exportId);
      assert.equal(item.object, null);
      assert.equal(shards.length, 2);
      assert.ok(shards[0].ordinal < shards[1].ordinal);
      assert.deepEqual(shards.map(({ section, recordCount }) => ({ section, recordCount })), [{ section: "profile", recordCount: 100_000 }, { section: "profile", recordCount: 1 }]);
      assert.equal(shards[0].range.afterRecordId, null);
      assert.equal(shards[0].range.throughRecordId, "10000000-0000-4000-8000-000000099999");
      assert.equal(shards[1].range.afterRecordId, shards[0].range.throughRecordId);
      assert.equal(shards[1].range.throughRecordId, "10000000-0000-4000-8000-000000100000");
      assert.ok(shards.every(({ state, object }) => state === "VERIFIED" && object));
      const manifest = snapshot.resources.exportManifests.find((entry) => entry.exportId === exportId);
      assert.ok(manifest);
      const expectedManifest = assertStoredExportManifest(manifest, shards);
      assert.equal(ctx.canonical(item.manifest), ctx.canonical(manifest));
      const grant = await ctx.mutate(baseUrl, `/api/v1/exports/${exportId}/download-grants`, "h10-manifest-grant", { target: "MANIFEST", expiresInSeconds: 60 });
      assert.ok(grant.status >= 200 && grant.status < 300, grant.text);
      const manifestBytes = await ctx.request(baseUrl, `/api/v1/download-grants/${find(grant.json, "grantId")}/content`, { binary: true });
      assert.equal(manifestBytes.status, 200, manifestBytes.text);
      assert.deepEqual(manifestBytes.body, expectedManifest.bytes);
      assert.deepEqual(JSON.parse(manifestBytes.body.toString("utf8")), expectedManifest.projection);
      const shardGrant = await ctx.mutate(baseUrl, `/api/v1/exports/${exportId}/download-grants`, "h10-shard-grant", { target: "SHARD", shardId: shards[0].shardId, expiresInSeconds: 60 });
      assert.ok(shardGrant.status >= 200 && shardGrant.status < 300, shardGrant.text);
      const shardBytes = await ctx.request(baseUrl, `/api/v1/download-grants/${find(shardGrant.json, "grantId")}/content`, { binary: true });
      assert.equal(shardBytes.status, 200, shardBytes.text);
      assert.equal(shardBytes.body.length, shards[0].object.size);
      assert.equal(digest(shardBytes.body), shards[0].object.sha256);
      const records = shardBytes.body.toString("utf8").trimEnd().split("\n");
      assert.equal(records.length, 100_000);
      assert.equal(JSON.parse(records[0]).recordId, "10000000-0000-4000-8000-000000000000");
      assert.equal(JSON.parse(records.at(-1)).recordId, shards[0].range.throughRecordId);
      const legacy = await ctx.mutate(baseUrl, `/api/v1/exports/${exportId}/download-grants`, "h10-legacy-grant", { expiresInSeconds: 60 });
      assert.equal(legacy.status, 400, legacy.text);
      assert.equal(legacy.json?.error?.code, "INVALID_EXPORT_DOWNLOAD_TARGET");
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const exportId = find(response.json, "exportId");
      const planned = await ctx.snapshot(baseUrls[0]);
      const plannedShards = planned.resources.exportShards.filter((entry) => entry.exportId === exportId);
      assert.equal(plannedShards.length, 2);
      let releaseFirst;
      let firstHeld = false;
      const held = new Promise((resolve) => { releaseFirst = resolve; });
      const barrier = await ctx.receiver((entry) => {
        if (entry.json?.point === "worker.before-commit" && !firstHeld) {
          firstHeld = true;
          return held;
        }
        return { status: 204 };
      });
      const firstWorker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-export" });
      await ctx.waitFor(() => firstHeld, { label: "first Export Shard held before commit", children: [firstWorker] });
      const secondWorker = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const item = value.resources.exports.find((entry) => entry.exportId === exportId);
        const verified = value.resources.exportShards.filter((entry) => entry.exportId === exportId && entry.state === "VERIFIED");
        const manifests = value.resources.exportManifests.filter((entry) => entry.exportId === exportId);
        return verified.length === 1 && item.state !== "READY" && item.manifest === null && manifests.length === 0 ? value : undefined;
      }, { timeoutMs: 30_000, label: "partial Shard completion without Manifest", children: [firstWorker, secondWorker] });
      releaseFirst({ status: 204 });
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.exports.find((item) => item.exportId === exportId)?.state === "READY" ? value : undefined;
      }, { timeoutMs: 60_000, label: "contended sharded Export READY", children: [firstWorker, secondWorker] });
      const shards = snapshot.resources.exportShards.filter((entry) => entry.exportId === exportId);
      assert.deepEqual(shards.map(({ shardId }) => shardId), plannedShards.map(({ shardId }) => shardId));
      assert.ok(shards.every(({ state }) => state === "VERIFIED"));
      const manifests = snapshot.resources.exportManifests.filter((entry) => entry.exportId === exportId);
      assert.equal(manifests.length, 1);
      assertStoredExportManifest(manifests[0], shards);
    },
  },
  uiPattern: /export|download|subject/iu,
};

function exportPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

async function exportPerfSeedFile(ctx) {
  const path = join(ctx.temporary, "export-perf-seed.json");
  if (exportPerfSeedFile.cached?.temporary === ctx.temporary) return path;
  const assets = join(ctx.temporary, "assets");
  await mkdir(assets, { recursive: true });
  const sharedBytes = Buffer.alloc(64 * 1024 * 1024, 0x65);
  await writeFile(join(assets, "shared-export.bin"), sharedBytes);
  const object = { sha256: digest(sharedBytes), size: sharedBytes.length, mediaType: "application/octet-stream" };
  const stream = createWriteStream(path);
  await streamWrite(stream, '{"schemaVersion":1,"seedVersion":"perf-v1","subjects":[');
  for (let index = 0; index < 100; index += 1) {
    if (index) await streamWrite(stream, ",");
    await streamWrite(stream, JSON.stringify({ subjectId: exportPerfUuid("e1000000", index), name: `Subject ${index}`, currentDatasetRevision: 1 }));
  }
  await streamWrite(stream, '],"datasetRevisions":[');
  for (let subjectIndex = 0; subjectIndex < 100; subjectIndex += 1) {
    if (subjectIndex) await streamWrite(stream, ",");
    await streamWrite(stream, JSON.stringify({ subjectId: exportPerfUuid("e1000000", subjectIndex), revision: 1, committedAt: timestamp }).slice(0, -1));
    await streamWrite(stream, ',"records":[');
    if (subjectIndex === 0) {
      for (let recordIndex = 0; recordIndex < 5_000_000; recordIndex += 1) {
        if (recordIndex) await streamWrite(stream, ",");
        const scope = ["profile", "activity", "orders", "files"][Math.floor(recordIndex / 1_250_000)];
        await streamWrite(stream, JSON.stringify({ recordId: exportPerfUuid("e2000000", recordIndex), scope, data: { ordinal: recordIndex, scope } }));
      }
    }
    await streamWrite(stream, "]}");
  }
  await streamWrite(stream, '],"exports":[');
  for (let index = 0; index < 11_000; index += 1) {
    if (index) await streamWrite(stream, ",");
    const live = index >= 10_000;
    await streamWrite(stream, JSON.stringify({
      exportId: exportPerfUuid("e3000000", index), subjectId: exportPerfUuid("e1000000", 1 + (index % 99)), scope: ["profile"], format: "JSONL",
      datasetRevision: 1, state: "READY", object, retentionUntil: live ? "2030-01-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z", readyAt: "2025-01-01T00:01:00.000Z", sequence: 2, assetPath: "shared-export.bin",
    }));
  }
  await streamWrite(stream, "]}");
  stream.end();
  await once(stream, "finish");
  exportPerfSeedFile.cached = { temporary: ctx.temporary };
  return path;
}

async function prepareExportPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seedFile(await exportPerfSeedFile(ctx));
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function exportGrant(ctx, baseUrl, exportId, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/exports/${exportId}/download-grants`, key, { expiresInSeconds: 900 });
  if (response.status !== 201) throw new Error(response.text);
  return find(response.json, "grantId");
}

async function exportPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareExportPerf(ctx);
  const sharedObjectDigest = digest(Buffer.alloc(64 * 1024 * 1024, 0x65));
  const rangeDigest = digest(Buffer.alloc(1_048_576, 0x65));
  const grants = await ctx.concurrent(Array.from({ length: 100 }, (_, index) => index), 32, (index) => exportGrant(ctx, index % 2 ? apiA.baseUrl : apiB.baseUrl, exportPerfUuid("e3000000", 10_000 + index), `perf-range-grant-${index}`));
  const range = await measuredLoad(ctx, {
    concurrency: 100, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async ({ client }) => {
      const response = await ctx.request(client % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/download-grants/${grants[client]}/content`, { headers: { range: "bytes=0-1048575" }, binary: true });
      if (response.status !== 206 || response.body.length !== 1_048_576 || response.headers.get("content-range") !== "bytes 0-1048575/67108864" || response.headers.get("etag")?.replaceAll('"', "") !== sharedObjectDigest || digest(response.body) !== rangeDigest) throw new Error("invalid range response");
      return response;
    },
  });
  const rangeMiB = range.completed / (60 * scale);
  if (rangeMiB < 150) throw new Error(`range-download failed: ${rangeMiB} MiB/s`);
  assertions.push(`range-download: ${rangeMiB.toFixed(1)} MiB/s with 100 independent Grants`);
  metrics.push({ scenarioId: "range-download", ...range, throughputMiB: rangeMiB });

  await ctx.resetDatabase();
  ({ apiA } = await prepareExportPerf(ctx));
  const requested = await ctx.mutate(apiA.baseUrl, "/api/v1/exports", "perf-five-million-export", { subjectId: exportPerfUuid("e1000000", 0), scope: ["profile", "activity", "orders", "files"], format: "JSONL" });
  if (requested.status !== 202) throw new Error(requested.text);
  const exportId = find(requested.json, "exportId");
  const generationStartedAt = Date.now();
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const generated = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const item = snapshot.resources.exports.find((entry) => entry.exportId === exportId);
    const sections = snapshot.resources.exportSections.filter((entry) => entry.exportId === exportId);
    const pending = snapshot.work.filter(({ aggregateId, kind, terminal }) => aggregateId === exportId && kind === "EXPORT_GENERATION" && !terminal);
    return item?.state === "READY" && sections.length === 4 && sections.every(({ state, recordCount }) => state === "VERIFIED" && recordCount === 1_250_000) && pending.length === 0 ? { snapshot, item, sections } : undefined;
  }, { timeoutMs: 120_000, label: "five-million-record Export", children: workers });
  const generationMs = Date.now() - generationStartedAt;
  const generationGrant = await exportGrant(ctx, apiA.baseUrl, exportId, "perf-generation-grant");
  const download = await fetch(`${apiA.baseUrl}/api/v1/download-grants/${generationGrant}/content`);
  if (download.status !== 200) throw new Error(`generated object returned ${download.status}`);
  const hash = createHash("sha256");
  let lineCount = 0;
  let remainder = "";
  for await (const chunk of download.body) {
    hash.update(chunk);
    const text = remainder + Buffer.from(chunk).toString("utf8");
    const lines = text.split("\n");
    remainder = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.recordId !== exportPerfUuid("e2000000", lineCount)) throw new Error(`record order mismatch at ${lineCount}`);
      lineCount += 1;
    }
  }
  if (remainder) {
    const record = JSON.parse(remainder);
    if (record.recordId !== exportPerfUuid("e2000000", lineCount)) throw new Error(`record order mismatch at ${lineCount}`);
    lineCount += 1;
  }
  if (lineCount !== 5_000_000 || hash.digest("hex") !== generated.item.object.sha256) throw new Error("generated object coverage or digest mismatch");
  assertions.push(`five-million-record-generation: 5,000,000 ordered records in ${generationMs}ms`);
  metrics.push({ scenarioId: "five-million-record-generation", completed: 5_000_000, durationMs: generationMs, objectBytes: generated.item.object.size });

  await ctx.resetDatabase();
  ({ apiA } = await prepareExportPerf(ctx));
  const cleanupStartedAt = Date.now();
  const cleanupWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const cleaned = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "EXPORT_CLEANUP" && !terminal);
    return snapshot.resources.deletionProofs.length === 10_000 && pending.length === 0 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "10,000 expired Export objects", children: cleanupWorkers });
  const cleanupMs = Date.now() - cleanupStartedAt;
  if (new Set(cleaned.resources.deletionProofs.map(({ exportId }) => exportId)).size !== 10_000) throw new Error("cleanup proof coverage mismatch");
  const liveGrants = await ctx.concurrent(Array.from({ length: 1_000 }, (_, index) => index), 32, (index) => exportGrant(ctx, apiA.baseUrl, exportPerfUuid("e3000000", 10_000 + index), `perf-live-control-${index}`));
  const controls = await ctx.concurrent(liveGrants, 64, (grantId) => ctx.request(apiA.baseUrl, `/api/v1/download-grants/${grantId}/content`, { headers: { range: "bytes=0-0" }, binary: true }));
  if (controls.some(({ status, body }) => status !== 206 || body.length !== 1 || body[0] !== 0x65)) throw new Error("cleanup deleted a live control");
  assertions.push(`expired-object-cleanup: 10,000 proofs in ${cleanupMs}ms; 1,000 live controls readable`);
  metrics.push({ scenarioId: "expired-object-cleanup", completed: 10_000, durationMs: cleanupMs, liveControls: 1_000 });
  return { metrics, fixtureSummary: { subjects: 100, datasetRevisions: 100, measuredRecords: 5_000_000, exports: 11_000, expiredExports: 10_000, liveExports: 1_000, sharedObjectBytes: 64 * 1024 * 1024 } };
}

const configIds = { fleet: id(1101), agents: [id(1102), id(1103)] };
const configBaselineContent = { feature: "disabled" };
const configBaselineDigest = digest(canonicalJson(configBaselineContent));
const configContent = { feature: "enabled" };
const configDigest = digest(canonicalJson(configContent));

async function waitForRolloutCommand(ctx, baseUrl, deploymentId, agentId, kind, children) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.resources.rolloutCommands.find((command) => command.deploymentId === deploymentId
      && command.agentId === agentId && command.kind === kind && command.state === "SENT");
  }, { timeoutMs: 30_000, label: `${kind} command for ${agentId}`, children });
}

async function pollRolloutCommand(ctx, baseUrl, agentId, lastCommandSequence, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/agents/${agentId}/poll`, key, { lastCommandSequence });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json?.status, "COMMAND");
  assert.ok(response.json.command);
  return response.json.command;
}

function assertPolledRolloutCommand(expected, actual) {
  const { assignmentToken: _assignmentToken, ...publicFields } = actual;
  assert.deepEqual(publicFields, expected);
}

const configrelay = {
  label: "ConfigRelay deployment",
  performanceScenarioIds: ["agent-poll", "acknowledgement-ingest", "assignment-delivery-recovery"],
  seed: async () => base("hidden-config", {
    fleets: [{ fleetId: configIds.fleet, name: "Hidden Fleet", currentRevision: 2 }],
    agents: configIds.agents.map((agentId, index) => ({ agentId, fleetId: configIds.fleet, labels: { ring: index ? "canary" : "stable" }, appliedRevision: 1, appliedDigest: configBaselineDigest, lastCommandSequence: 0, lastSeenAt: timestamp })),
    configurations: [
      { fleetId: configIds.fleet, revision: 1, content: configBaselineContent, canonicalDigest: configBaselineDigest, createdAt: timestamp },
      { fleetId: configIds.fleet, revision: 2, content: configContent, canonicalDigest: configDigest, createdAt: timestamp },
    ],
    deployments: [], assignments: [],
  }),
  path: "/api/v1/deployments",
  payload: (index) => ({ fleetId: configIds.fleet, configurationRevision: 2, selector: { labels: {} }, expectedFleetRevision: 2, hiddenOrdinal: undefined }),
  conflictPayload: () => ({ fleetId: configIds.fleet, configurationRevision: 2, selector: { labels: { ring: "canary" } }, expectedFleetRevision: 2 }),
  resource: "deployments",
  identity: (json) => find(json, "deploymentId"),
  resourceIdentity: ({ deploymentId }) => deploymentId,
  performance: configPerformance,
  manager: {
    path: "/api/v1/deployments",
    payload: () => ({
      fleetId: configIds.fleet,
      configurationRevision: 2,
      selector: { labels: {} },
      expectedFleetRevision: 2,
      cohorts: [
        { name: "canary", selector: { labels: { ring: "canary" } }, minimumSuccessBasisPoints: 9000, maximumFailureBasisPoints: 1000, observationSeconds: 60 },
        { name: "stable", selector: { labels: { ring: "stable" } }, minimumSuccessBasisPoints: 9000, maximumFailureBasisPoints: 1000, observationSeconds: 60 },
      ],
    }),
    async verify(ctx, baseUrl, response) {
      const deploymentId = find(response.json, "deploymentId");
      const earlyStable = await ctx.mutate(baseUrl, `/api/v1/agents/${configIds.agents[0]}/poll`, "h10-stable-before-canary", { lastCommandSequence: 0 });
      assert.equal(earlyStable.status, 200, earlyStable.text);
      assert.deepEqual(earlyStable.json, { status: "NO_CHANGE", command: null });
      const worker = await ctx.startWorker();
      const acknowledge = async (agentId, command, outcome, key) => {
        const result = await ctx.mutate(baseUrl, `/api/v1/agents/${agentId}/acknowledgements`, `${key}-ack`, {
          deploymentId, commandSequence: command.commandSequence, revision: command.toRevision ?? command.revision,
          digest: command.toDigest ?? command.digest, assignmentToken: command.assignmentToken, outcome,
        });
        assert.equal(result.status, 200, result.text);
        return result;
      };
      const expectedCanary = await waitForRolloutCommand(ctx, baseUrl, deploymentId, configIds.agents[1], "APPLY", [worker]);
      const canaryApply = await pollRolloutCommand(ctx, baseUrl, configIds.agents[1], 0, "h10-canary-poll");
      assertPolledRolloutCommand(expectedCanary, canaryApply);
      await acknowledge(configIds.agents[1], canaryApply, "APPLIED", "h10-canary");
      const expectedStable = await waitForRolloutCommand(ctx, baseUrl, deploymentId, configIds.agents[0], "APPLY", [worker]);
      const stableApply = await pollRolloutCommand(ctx, baseUrl, configIds.agents[0], 0, "h10-stable-poll");
      assertPolledRolloutCommand(expectedStable, stableApply);
      await acknowledge(configIds.agents[0], stableApply, "REJECTED", "h10-stable");
      const snapshot = await ctx.snapshot(baseUrl);
      const cohorts = snapshot.resources.deploymentCohorts.filter((item) => item.deploymentId === deploymentId);
      assert.deepEqual(cohorts.map(({ ordinal, state }) => ({ ordinal, state })), [{ ordinal: 0, state: "SUCCEEDED" }, { ordinal: 1, state: "FAILED" }]);
      const rollback = snapshot.resources.deploymentRollbacks.find((item) => item.deploymentId === deploymentId);
      assert.ok(rollback);
      assert.equal(rollback.failedCohortId, cohorts[1].cohortId);
      assert.ok(["PENDING", "DELIVERING"].includes(rollback.state));
      assert.equal(rollback.commandCount, 1);
      assert.equal(rollback.completedCount, 0);
      const commands = snapshot.resources.rolloutCommands.filter((item) => item.deploymentId === deploymentId);
      const rollbackCommand = commands.find(({ kind }) => kind === "ROLLBACK");
      assert.equal(commands.filter(({ kind }) => kind === "ROLLBACK").length, 1);
      assert.equal(rollbackCommand.agentId, configIds.agents[1]);
      assert.equal(rollbackCommand.cohortId, cohorts[0].cohortId);
      assert.ok(rollbackCommand.commandSequence > canaryApply.commandSequence);
      assert.equal(rollbackCommand.fromRevision, canaryApply.toRevision);
      assert.equal(rollbackCommand.toRevision, canaryApply.fromRevision);
      assert.equal(rollbackCommand.toDigest, configBaselineDigest);
      assert.equal(commands.find(({ commandId }) => commandId === stableApply.commandId).state, "FAILED");
      assert.equal(commands.filter(({ agentId, kind }) => agentId === configIds.agents[0] && kind === "ROLLBACK").length, 0);
      const expectedRollback = await waitForRolloutCommand(ctx, baseUrl, deploymentId, configIds.agents[1], "ROLLBACK", [worker]);
      const delivering = await ctx.snapshot(baseUrl);
      assert.equal(delivering.resources.deploymentRollbacks.find((item) => item.deploymentId === deploymentId).state, "DELIVERING");
      const polledRollback = await pollRolloutCommand(ctx, baseUrl, configIds.agents[1], canaryApply.commandSequence, "h10-rollback-poll");
      assertPolledRolloutCommand(expectedRollback, polledRollback);
      await acknowledge(configIds.agents[1], polledRollback, "APPLIED", "h10-rollback");
      const final = await ctx.snapshot(baseUrl);
      const finalRollback = final.resources.deploymentRollbacks.find((item) => item.deploymentId === deploymentId);
      assert.equal(finalRollback.state, "COMPLETED");
      assert.equal(finalRollback.completedCount, finalRollback.commandCount);
      assert.equal(final.work.filter(({ aggregateId, kind, terminal }) => aggregateId === deploymentId && kind === "ROLLBACK_DELIVERY" && !terminal).length, 0);
      assert.deepEqual(final.resources.deploymentCohorts.filter((item) => item.deploymentId === deploymentId).map(({ ordinal, state }) => ({ ordinal, state })), [{ ordinal: 0, state: "ROLLED_BACK" }, { ordinal: 1, state: "FAILED" }]);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const deploymentId = find(response.json, "deploymentId");
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const cohorts = snapshot.resources.deploymentCohorts.filter((item) => item.deploymentId === deploymentId);
      assert.equal(cohorts.length, 2);
      assert.ok(cohorts.every(({ targetCount, successCount, failureCount, pendingCount }) => targetCount === successCount + failureCount + pendingCount));
      assert.equal(cohorts[0].state, "DELIVERING");
      assert.equal(cohorts[1].state, "WAITING");
      assert.equal(cohorts[1].startedAt, null);
      assert.equal(cohorts[1].observationDeadlineAt, null);
      const commands = snapshot.resources.rolloutCommands.filter((item) => item.deploymentId === deploymentId);
      assert.ok(commands.length > 0 && commands.every(({ cohortId }) => cohortId === cohorts[0].cohortId));
      assert.equal(snapshot.work.filter(({ aggregateId, kind, terminal }) => aggregateId === deploymentId && kind === "COHORT_DEADLINE" && !terminal).length, 1);
    },
  },
  uiPattern: /config|deployment|agent/iu,
};

function configPerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function configPerfSeed() {
  const fleets = [];
  const agents = [];
  const configurations = [];
  const deployments = [];
  const assignments = [];
  for (let fleetIndex = 0; fleetIndex < 100; fleetIndex += 1) {
    const fleetId = configPerfUuid("c1000000", fleetIndex);
    fleets.push({ fleetId, name: `Fleet ${fleetIndex}`, currentRevision: 10 });
    for (let revision = 1; revision <= 10; revision += 1) {
      const content = { fleet: fleetIndex, revision };
      configurations.push({ fleetId, revision, content, canonicalDigest: digest(canonicalJson(content)), createdAt: timestamp });
    }
    for (let localAgent = 0; localAgent < 1_000; localAgent += 1) {
      const index = fleetIndex * 1_000 + localAgent;
      const assigned = localAgent < 500;
      agents.push({
        agentId: configPerfUuid("c2000000", index), fleetId,
        labels: assigned ? { group: String(Math.floor(localAgent / 100)) } : { group: "none" },
        appliedRevision: assigned ? 0 : 10, appliedDigest: assigned ? null : configurations.at(-1).canonicalDigest,
        lastCommandSequence: assigned ? 1 : 0, lastSeenAt: timestamp,
      });
    }
    for (let group = 0; group < 5; group += 1) {
      const deploymentIndex = fleetIndex * 5 + group;
      const deploymentId = configPerfUuid("c3000000", deploymentIndex);
      const targetIds = Array.from({ length: 100 }, (_, offset) => configPerfUuid("c2000000", fleetIndex * 1_000 + group * 100 + offset));
      deployments.push({
        deploymentId, fleetId, configurationRevision: 10, selector: { labels: { group: String(group) } }, targetCount: 100,
        targetDigest: digest(targetIds.join("\n")), state: "DELIVERING", createdAt: timestamp, completedAt: null, sequence: 1,
      });
      for (let offset = 0; offset < 100; offset += 1) {
        const agentIndex = fleetIndex * 1_000 + group * 100 + offset;
        assignments.push({
          assignmentId: configPerfUuid("c4000000", agentIndex), deploymentId, agentId: configPerfUuid("c2000000", agentIndex), commandSequence: 1,
          revision: 10, digest: configurations.at(-1).canonicalDigest, state: "WAITING", deliveryId: configPerfUuid("c5000000", agentIndex),
          assignmentToken: `token-${agentIndex}`, sentAt: null, ackedAt: null,
        });
      }
    }
  }
  return base("perf-v1", { fleets, agents, configurations, deployments, assignments });
}

async function prepareConfigPerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(configPerfSeed());
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function pollConfigAgent(ctx, baseUrl, agentIndex, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/agents/${configPerfUuid("c2000000", agentIndex)}/poll`, key, { appliedRevision: agentIndex < 50_000 ? 0 : 10 });
  if (response.status !== 200) throw new Error(response.text);
  return response;
}

async function configPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareConfigPerf(ctx);
  let pollOrdinal = 0;
  const polls = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = pollOrdinal++;
      const command = ordinal % 2 === 0;
      const agentIndex = command ? (Math.floor(ordinal / 2) % 50_000) : 50_000 + (Math.floor(ordinal / 2) % 50_000);
      const response = await pollConfigAgent(ctx, ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, agentIndex, `perf-poll-${ordinal}`);
      if (response.json?.status !== (command ? "COMMAND" : "NO_CHANGE") || (command ? !response.json?.command : response.json?.command !== null)) throw new Error("Agent poll mix or token is wrong");
      return response;
    },
  });
  if (polls.throughput < 2_000 || polls.p95 > 80) throw new Error(`agent-poll failed: ${polls.throughput}/s p95=${polls.p95}`);
  assertions.push(`agent-poll: ${polls.throughput.toFixed(1)}/s, p95 ${polls.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "agent-poll", ...polls });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareConfigPerf(ctx));
  const polled = await ctx.concurrent(Array.from({ length: 35_000 }, (_, index) => index), 64, async (agentIndex) => {
    const response = await pollConfigAgent(ctx, agentIndex % 2 ? apiA.baseUrl : apiB.baseUrl, agentIndex, `perf-ack-poll-${agentIndex}`);
    return { agentIndex, command: response.json.command };
  });
  const acknowledge = async (entry, prefix) => {
    const outcome = entry.agentIndex % 10 === 9 ? "REJECTED" : "APPLIED";
    const body = {
      deploymentId: entry.command.deploymentId, commandSequence: entry.command.commandSequence, revision: entry.command.revision,
      digest: entry.command.digest, assignmentToken: entry.command.assignmentToken, outcome,
    };
    const key = `${prefix}-${entry.agentIndex}`;
    const path = `/api/v1/agents/${configPerfUuid("c2000000", entry.agentIndex)}/acknowledgements`;
    const first = await ctx.mutate(entry.agentIndex % 2 ? apiA.baseUrl : apiB.baseUrl, path, key, body);
    const replay = await ctx.mutate(entry.agentIndex % 2 ? apiA.baseUrl : apiB.baseUrl, path, key, body);
    if (first.status !== 200 || replay.status !== 200 || ctx.canonical(first.json) !== ctx.canonical(replay.json)) throw new Error("Acknowledgement replay diverged");
    return [first, replay];
  };
  const warmupStartedAt = Date.now();
  await ctx.concurrent(polled.slice(0, 5_000), 64, (entry) => acknowledge(entry, "perf-ack-warmup"));
  const warmupRemaining = 10_000 * scale - (Date.now() - warmupStartedAt);
  if (warmupRemaining > 0) await new Promise((resolve) => setTimeout(resolve, warmupRemaining));
  const ackStartedAt = Date.now();
  const ackPairs = await ctx.concurrent(polled.slice(5_000), 64, (entry) => acknowledge(entry, "perf-ack-measured"));
  const ackMs = Date.now() - ackStartedAt;
  const ackResponses = ackPairs.flat();
  const ackMetrics = latencyMetrics("acknowledgement-ingest", ackResponses, ackMs);
  if (ackMetrics.throughput < 1_000 || ackMetrics.p95 > 180 || ackMs > 60_000) throw new Error(`acknowledgement-ingest failed: ${ackMetrics.throughput}/s p95=${ackMetrics.p95}`);
  assertions.push(`acknowledgement-ingest: ${ackMetrics.throughput.toFixed(1)}/s, p95 ${ackMetrics.p95.toFixed(1)}ms`);
  metrics.push({ ...ackMetrics, appliedResponses: 27_000, rejectedResponses: 3_000, replayResponses: 30_000 });

  await ctx.resetDatabase();
  ({ apiA } = await prepareConfigPerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-config" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-config" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Assignment deliveries", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "ASSIGNMENT_DELIVERY" && !terminal);
    return snapshot.resources.assignments.filter(({ state }) => state === "SENT").length === 50_000 && pending.length === 0 ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "50,000 Assignment deliveries", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  if (new Set(final.resources.assignments.map(({ deliveryId }) => deliveryId)).size !== 50_000) throw new Error("Assignment delivery identity changed or duplicated");
  assertions.push(`assignment-delivery-recovery: 50,000 Assignments SENT in ${recoveryMs}ms`);
  metrics.push({ scenarioId: "assignment-delivery-recovery", completed: 50_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { fleets: 100, agents: 100_000, configurations: 1_000, deployments: 500, waitingAssignments: 50_000 } };
}

const firmwareIds = { model: id(1201), device: id(1202), imageV2: id(1203), imageV3: id(1204) };
const firmwareState = { bytesV2: Buffer.from("firmware-v2"), bytesV3: Buffer.from("firmware-v3") };
const firmwareDigests = { v1: "1".repeat(64), v2: digest(firmwareState.bytesV2), v3: digest(firmwareState.bytesV3) };

function assertFirmwarePath(plan) {
  assert.equal(plan.currentHopIndex, 0);
  assert.deepEqual(plan.hops.map(({ firmwareImageId, fromVersion, toVersion }) => ({ firmwareImageId, fromVersion, toVersion })), [
    { firmwareImageId: firmwareIds.imageV2, fromVersion: "1.0.0", toVersion: "2.0.0" },
    { firmwareImageId: firmwareIds.imageV3, fromVersion: "2.0.0", toVersion: "3.0.0" },
  ]);
  assert.equal(plan.pathDigest, digest(canonicalJson({ deviceId: firmwareIds.device, sourceVersion: "1.0.0", targetVersion: "3.0.0", imageIds: [firmwareIds.imageV2, firmwareIds.imageV3] })));
}

async function nextFirmwareCommand(ctx, baseUrl, deviceUpdateId, lastSequence, key, children) {
  const expected = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const pending = snapshot.work.some(({ aggregateId, kind, terminal }) => aggregateId === deviceUpdateId
      && ["COMMAND_DELIVERY", "ROLLBACK"].includes(kind) && !terminal);
    const command = snapshot.resources.deviceCommands
      .filter((item) => item.deviceUpdateId === deviceUpdateId && item.sequence > lastSequence)
      .sort((left, right) => left.sequence - right.sequence)[0];
    return command && !pending ? command : undefined;
  }, { timeoutMs: 30_000, label: `Firmware command after ${lastSequence}`, children });
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${firmwareIds.device}/commands/poll`, key, { lastCommandSequence: lastSequence });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json?.status, "COMMAND");
  const command = response.json.command;
  assert.ok(command);
  assert.deepEqual(
    { commandId: command.commandId, deviceUpdateId: command.deviceUpdateId, sequence: command.sequence, type: command.type, imageDigest: command.imageDigest },
    { commandId: expected.commandId, deviceUpdateId: expected.deviceUpdateId, sequence: expected.sequence, type: expected.type, imageDigest: expected.imageDigest },
  );
  return command;
}

async function reportFirmwareCommand(ctx, baseUrl, command, outcome, installedDigest, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${firmwareIds.device}/report-batches`, key, {
    firstSequence: command.sequence,
    reports: [{
      sequence: command.sequence,
      commandId: command.commandId,
      commandToken: command.commandToken,
      outcome,
      installedDigest,
    }],
  });
  assert.equal(response.status, 200, response.text);
  return response;
}

async function driveFirmwareToRollback(ctx, baseUrls, response) {
  const campaignId = find(response.json, "campaignId");
  const initial = await ctx.snapshot(baseUrls[0]);
  const update = initial.resources.deviceUpdates.find((item) => item.campaignId === campaignId);
  assert.ok(update);
  const planResponse = await ctx.request(baseUrls[0], `/api/v1/device-updates/${update.deviceUpdateId}/upgrade-plan`);
  assert.equal(planResponse.status, 200, planResponse.text);
  assertFirmwarePath(planResponse.json?.upgradePlan ?? planResponse.json);
  const worker = await ctx.startWorker();
  const commands = [];
  const run = async (type, imageDigest, outcome, installedDigest, suffix) => {
    const prior = commands.at(-1)?.sequence ?? 0;
    const command = await nextFirmwareCommand(ctx, baseUrls[commands.length % baseUrls.length], update.deviceUpdateId, prior, `firmware-${suffix}-poll`, [worker]);
    assert.equal(command.sequence, prior + 1);
    assert.equal(command.type, type);
    assert.equal(command.imageDigest, imageDigest);
    await reportFirmwareCommand(ctx, baseUrls[commands.length % baseUrls.length], command, outcome, installedDigest, `firmware-${suffix}-report`);
    commands.push(command);
    return command;
  };
  await run("DOWNLOAD", firmwareDigests.v2, "SUCCEEDED", null, "hop-0-download");
  await run("INSTALL", firmwareDigests.v2, "SUCCEEDED", null, "hop-0-install");
  await run("VERIFY", firmwareDigests.v2, "SUCCEEDED", firmwareDigests.v2, "hop-0-verify");
  const failedDownload = await run("DOWNLOAD", firmwareDigests.v3, "FAILED", null, "hop-1-download-failed");
  const rollback = await run("ROLLBACK", firmwareDigests.v2, "SUCCEEDED", firmwareDigests.v2, "hop-1-rollback");
  const rolledBack = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const plan = snapshot.resources.upgradePlans.find((item) => item.deviceUpdateId === update.deviceUpdateId);
    const device = snapshot.resources.devices.find((item) => item.deviceId === firmwareIds.device);
    return plan?.currentHopIndex === 1 && plan.hops[0].state === "SUCCEEDED" && plan.hops[1].attempts.at(-1)?.state === "ROLLED_BACK"
      && device?.installedVersion === "2.0.0" ? snapshot : undefined;
  }, { timeoutMs: 30_000, label: "current Firmware hop rolled back", children: [worker] });
  const plan = rolledBack.resources.upgradePlans.find((item) => item.deviceUpdateId === update.deviceUpdateId);
  const device = rolledBack.resources.devices.find((item) => item.deviceId === firmwareIds.device);
  assert.equal(plan.hops[0].attempts.length, 1);
  assert.equal(plan.hops[0].attempts[0].state, "SUCCEEDED");
  assert.equal(plan.hops[1].state, "FAILED");
  assert.equal(plan.hops[1].attempts.length, 1);
  assert.equal(device.installedDigest, firmwareDigests.v2);
  assert.equal(new Set(commands.map(({ commandToken }) => commandToken)).size, commands.length);
  return { campaignId, update, worker, commands, failedDownload, rollback, rolledBack };
}

const firmwarefleet = {
  label: "FirmwareFleet campaign",
  performanceScenarioIds: ["device-command-poll", "device-report-batch", "command-recovery"],
  seed: async (ctx) => {
    const assets = join(ctx.temporary, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "v2.bin"), firmwareState.bytesV2);
    await writeFile(join(assets, "v3.bin"), firmwareState.bytesV3);
    const image = (firmwareImageId, version, bytes, assetPath, compatibleFromVersions) => ({
      firmwareImageId,
      modelId: firmwareIds.model,
      version,
      sha256: digest(bytes),
      size: bytes.length,
      downloadPath: `/firmware/${assetPath}`,
      compatibleFromVersions,
      createdAt: timestamp,
      assetPath,
    });
    return base("hidden-firmware", {
      deviceModels: [{ modelId: firmwareIds.model, name: "Hidden Model" }],
      devices: [{ deviceId: firmwareIds.device, modelId: firmwareIds.model, labels: { ring: "stable" }, installedVersion: "1.0.0", installedDigest: firmwareDigests.v1, lastReportSequence: 0 }],
      firmwareImages: [
        image(firmwareIds.imageV2, "2.0.0", firmwareState.bytesV2, "v2.bin", ["1.0.0"]),
        image(firmwareIds.imageV3, "3.0.0", firmwareState.bytesV3, "v3.bin", ["2.0.0"]),
      ],
      campaigns: [], deviceUpdates: [], commands: [], reports: [],
    });
  },
  path: "/api/v1/firmware-campaigns",
  payload: (index) => ({ firmwareImageId: firmwareIds.imageV2, selector: { labels: { ring: "stable" } }, maxParallel: 1, reportTimeoutSeconds: 60 + (index % 10) }),
  conflictPayload: () => ({ firmwareImageId: firmwareIds.imageV2, selector: { labels: { ring: "stable" } }, maxParallel: 1, reportTimeoutSeconds: 120 }),
  resource: "firmwareCampaigns",
  identity: (json) => find(json, "campaignId"),
  resourceIdentity: ({ campaignId }) => campaignId,
  performance: firmwarePerformance,
  manager: {
    path: "/api/v1/firmware-campaigns",
    payload: () => ({ firmwareImageId: firmwareIds.imageV3, selector: { labels: { ring: "stable" } }, maxParallel: 1, reportTimeoutSeconds: 60 }),
    async verify(ctx, baseUrl, response) {
      const state = await driveFirmwareToRollback(ctx, [baseUrl], response);
      const retry = await ctx.mutate(baseUrl, `/api/v1/device-updates/${state.update.deviceUpdateId}/retry`, "h10-firmware-retry", { expectedCurrentHopIndex: 1, expectedAttempt: 1 });
      assert.ok(retry.status >= 200 && retry.status < 300, retry.text);
      const commands = [...state.commands];
      const run = async (type, outcome, installedDigest, suffix) => {
        const prior = commands.at(-1).sequence;
        const command = await nextFirmwareCommand(ctx, baseUrl, state.update.deviceUpdateId, prior, `h10-${suffix}-poll`, [state.worker]);
        assert.equal(command.sequence, prior + 1);
        assert.equal(command.type, type);
        assert.equal(command.imageDigest, firmwareDigests.v3);
        await reportFirmwareCommand(ctx, baseUrl, command, outcome, installedDigest, `h10-${suffix}-report`);
        commands.push(command);
        return command;
      };
      const retryDownload = await run("DOWNLOAD", "SUCCEEDED", null, "retry-download");
      assert.notEqual(retryDownload.commandToken, state.failedDownload.commandToken);
      await run("INSTALL", "SUCCEEDED", null, "retry-install");
      await run("VERIFY", "SUCCEEDED", firmwareDigests.v3, "retry-verify");
      const final = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const plan = snapshot.resources.upgradePlans.find((item) => item.deviceUpdateId === state.update.deviceUpdateId);
        const update = snapshot.resources.deviceUpdates.find((item) => item.deviceUpdateId === state.update.deviceUpdateId);
        return plan?.hops[1].state === "SUCCEEDED" && update?.state === "SUCCEEDED" ? snapshot : undefined;
      }, { timeoutMs: 30_000, label: "multi-hop Firmware retry succeeds", children: [state.worker] });
      const plan = final.resources.upgradePlans.find((item) => item.deviceUpdateId === state.update.deviceUpdateId);
      const device = final.resources.devices.find((item) => item.deviceId === firmwareIds.device);
      assert.equal(plan.hops[0].attempts.length, 1);
      assert.equal(plan.hops[1].attempts.length, 2);
      assert.deepEqual(plan.hops[1].attempts.map(({ state }) => state), ["ROLLED_BACK", "SUCCEEDED"]);
      assert.equal(device.installedVersion, "3.0.0");
      assert.equal(device.installedDigest, firmwareDigests.v3);
      assert.equal(new Set(commands.map(({ commandToken }) => commandToken)).size, commands.length);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const state = await driveFirmwareToRollback(ctx, baseUrls, response);
      const before = state.rolledBack.resources.deviceCommands.filter((item) => item.deviceUpdateId === state.update.deviceUpdateId).length;
      const retries = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
        baseUrls[index % baseUrls.length],
        `/api/v1/device-updates/${state.update.deviceUpdateId}/retry`,
        `h11-firmware-retry-${index}`,
        { expectedCurrentHopIndex: 1, expectedAttempt: 1 },
      ));
      assert.equal(retries.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.equal(retries.filter(({ status, json }) => status === 409 && json?.error?.code === "DEVICE_UPDATE_NOT_RETRYABLE").length, 19);
      const retryDownload = await nextFirmwareCommand(ctx, baseUrls[0], state.update.deviceUpdateId, state.rollback.sequence, "h11-retry-download-poll", [state.worker]);
      assert.equal(retryDownload.type, "DOWNLOAD");
      assert.equal(retryDownload.imageDigest, firmwareDigests.v3);
      assert.equal(retryDownload.sequence, state.rollback.sequence + 1);
      assert.notEqual(retryDownload.commandToken, state.failedDownload.commandToken);
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const plan = snapshot.resources.upgradePlans.find((item) => item.deviceUpdateId === state.update.deviceUpdateId);
      assert.equal(plan.hops[0].attempts.length, 1);
      assert.equal(plan.hops[1].attempts.length, 2);
      assert.equal(snapshot.resources.deviceCommands.filter((item) => item.deviceUpdateId === state.update.deviceUpdateId).length, before + 1);
    },
  },
  uiPattern: /firmware|campaign|device/iu,
};

function firmwarePerfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

async function firmwarePerfSeed(ctx) {
  const assets = join(ctx.temporary, "assets");
  await mkdir(assets, { recursive: true });
  const imageBytes = Buffer.from("f");
  await writeFile(join(assets, "firmware.bin"), imageBytes);
  const imageDigest = digest(imageBytes);
  const deviceModels = Array.from({ length: 100 }, (_, index) => ({ modelId: firmwarePerfUuid("f1000000", index), name: `Model ${index}` }));
  const firmwareImages = Array.from({ length: 500 }, (_, index) => ({
    firmwareImageId: firmwarePerfUuid("f2000000", index), modelId: deviceModels[Math.floor(index / 5)].modelId,
    version: `2.0.${index % 5}`, sha256: imageDigest, size: 1, downloadPath: `/firmware/image-${index}.bin`,
    compatibleFromVersions: ["1.0.0"], createdAt: timestamp, assetPath: "firmware.bin",
  }));
  const devices = [];
  const campaigns = [];
  const deviceUpdates = [];
  const commands = [];
  for (let campaignIndex = 0; campaignIndex < 100; campaignIndex += 1) {
    const campaignId = firmwarePerfUuid("f3000000", campaignIndex);
    const image = firmwareImages[campaignIndex * 5];
    const targetIds = Array.from({ length: 1_000 }, (_, local) => firmwarePerfUuid("f4000000", campaignIndex * 1_000 + local));
    campaigns.push({ campaignId, firmwareImageId: image.firmwareImageId, targetCount: 1_000, targetDigest: digest(canonicalJson(targetIds)), maxParallel: 1_000, reportTimeoutSeconds: 3600, state: "RUNNING", createdAt: timestamp, completedAt: null, sequence: 2 });
    for (let local = 0; local < 1_000; local += 1) {
      const index = campaignIndex * 1_000 + local;
      const deviceId = targetIds[local];
      const deviceUpdateId = firmwarePerfUuid("f5000000", index);
      const commandId = firmwarePerfUuid("f6000000", index);
      devices.push({ deviceId, modelId: deviceModels[campaignIndex].modelId, labels: { campaign: String(campaignIndex) }, installedVersion: "1.0.0", installedDigest: "1".repeat(64), lastReportSequence: 0 });
      deviceUpdates.push({ deviceUpdateId, campaignId, deviceId, priorVersion: "1.0.0", targetVersion: image.version, state: "DOWNLOADING", currentCommandSequence: 1, installedDigest: null });
      commands.push({ commandId, deviceUpdateId, sequence: 1, type: "DOWNLOAD", imageDigest, commandToken: `token-${index}`, createdAt: timestamp, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
  }
  return base("perf-v1", { deviceModels, devices, firmwareImages, campaigns, deviceUpdates, commands, reports: [] });
}

async function prepareFirmwarePerf(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(await firmwarePerfSeed(ctx));
  if (imported.exitCode !== 0) throw new Error(imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

function firmwareReport(index) {
  return {
    firstSequence: 1,
    reports: [{
      sequence: 1,
      commandId: firmwarePerfUuid("f6000000", index),
      commandToken: `token-${index}`,
      outcome: index % 10 === 9 ? "FAILED" : "SUCCEEDED",
      installedDigest: null,
    }],
  };
}

async function firmwarePerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await prepareFirmwarePerf(ctx);
  let pollOrdinal = 0;
  const polls = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: async () => {
      const ordinal = pollOrdinal++;
      const index = ordinal % 100_000;
      const expectsCommand = ordinal % 2 === 0;
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/devices/${firmwarePerfUuid("f4000000", index)}/commands/poll`, `perf-poll-${ordinal}`, { lastCommandSequence: expectsCommand ? 0 : 1 });
      if (response.status !== 200 || find(response.json, "status") !== (expectsCommand ? "COMMAND" : "NO_CHANGE")) throw new Error(response.text);
      if (expectsCommand && find(response.json, "commandToken") !== `token-${index}`) throw new Error("command token crossed Device identity");
      return response;
    },
  });
  if (polls.throughput < 3_000 || polls.p95 > 80) throw new Error(`device-command-poll failed: ${polls.throughput}/s p95=${polls.p95}`);
  assertions.push(`device-command-poll: ${polls.throughput.toFixed(1)}/s, p95 ${polls.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "device-command-poll", ...polls });

  await ctx.resetDatabase();
  ({ apiA, apiB } = await prepareFirmwarePerf(ctx));
  const runReports = async (start, count, prefix) => {
    const startedAt = Date.now();
    const responses = await ctx.concurrent(Array.from({ length: count * 2 }, (_, ordinal) => ordinal), 64, async (ordinal) => {
      const index = start + Math.floor(ordinal / 2);
      const key = `${prefix}-${index}`;
      return ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/devices/${firmwarePerfUuid("f4000000", index)}/report-batches`, key, firmwareReport(index));
    });
    return { responses, durationMs: Date.now() - startedAt };
  };
  const warmupStartedAt = Date.now();
  const warmup = await runReports(0, 10_000, "perf-report-warmup");
  if (warmup.responses.some(({ status }) => status !== 200)) throw new Error("report warm-up failed");
  const warmupRemaining = 10_000 * scale - (Date.now() - warmupStartedAt);
  if (warmupRemaining > 0) await new Promise((resolve) => setTimeout(resolve, warmupRemaining));
  const measured = await runReports(10_000, 60_000, "perf-report-measured");
  const reportMetrics = latencyMetrics("device-report-batch", measured.responses, measured.durationMs);
  if (reportMetrics.throughput < 2_000 || reportMetrics.p95 > 200 || measured.responses.some(({ status }) => status !== 200)) throw new Error(`device-report-batch failed: ${reportMetrics.throughput}/s p95=${reportMetrics.p95}`);
  assertions.push(`device-report-batch: ${reportMetrics.throughput.toFixed(1)}/s, p95 ${reportMetrics.p95.toFixed(1)}ms, exactly 50% replay`);
  metrics.push({ ...reportMetrics, uniqueReports: 60_000, replayResponses: 60_000 });

  await ctx.resetDatabase();
  ({ apiA } = await prepareFirmwarePerf(ctx));
  let releaseClaims;
  const held = new Promise((resolve) => { releaseClaims = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = [await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-firmware" }), await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-firmware" })];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, { label: "two claimed Command deliveries", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseClaims({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    return snapshot.work.filter(({ kind, terminal }) => kind === "COMMAND_DELIVERY" && !terminal).length === 0 ? snapshot : undefined;
  }, { timeoutMs: 180_000, label: "100,000 Command deliveries", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  if (final.resources.deviceCommands.length !== 100_000 || new Set(final.resources.deviceCommands.map(({ commandId }) => commandId)).size !== 100_000) throw new Error("Command recovery changed command identity");
  const representative = await ctx.mutate(apiA.baseUrl, `/api/v1/devices/${firmwarePerfUuid("f4000000", 99_999)}/commands/poll`, "perf-recovery-poll", { lastCommandSequence: 0 });
  if (representative.status !== 200 || find(representative.json, "status") !== "COMMAND") throw new Error("recovered command is not pollable");
  assertions.push(`command-recovery: 100,000 Commands drained in ${recoveryMs}ms`);
  metrics.push({ scenarioId: "command-recovery", completed: 100_000, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { deviceModels: 100, devices: 100_000, firmwareImages: 500, campaigns: 100, deviceUpdates: 100_000, commands: 100_000, reports: 0 } };
}

export const STANDARD_TASKS = Object.fromEntries(Object.entries({
  schemaharbor,
  flagfoundry,
  reconcilehub,
  evidencechain,
  dispatchboard,
  quotamesh,
  carbonledger,
  mergeboard,
  auctionguard,
  artifactvault,
  exportvault,
  configrelay,
  firmwarefleet,
}).map(([taskId, spec]) => [taskId, standardAdapter(spec)]));
