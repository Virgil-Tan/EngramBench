import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const profileId = id(10);
const cleanupPolicyId = id(20);
const createdAt = "2026-01-01T00:00:00.000Z";
const partSize = 8_192;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function mediaBytes(index, { infected = false, size = 262_144 } = {}) {
  const marker = infected ? "EICAR-STANDARD-ANTIVIRUS-TEST-FILE\n" : "";
  const header = Buffer.from(`${marker}mediadock:${index}:`);
  const body = Buffer.alloc(size - header.length, index % 251);
  return Buffer.concat([header, body]);
}

function parts(bytes) {
  const result = [];
  for (let offset = 0, partNumber = 1; offset < bytes.length; offset += partSize, partNumber += 1) {
    const body = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
    result.push({ partNumber, start: offset, end: offset + body.length - 1, total: bytes.length, size: body.length, sha256: sha256(body), body });
  }
  return result;
}

function uploadPayload(index, options = {}) {
  const bytes = mediaBytes(index, options);
  return {
    tenantId, fileName: `hidden-${index}.bin`, contentType: "application/octet-stream",
    expectedSize: bytes.length, expectedSha256: sha256(bytes), partSize,
  };
}

function seed(seedVersion = "hidden-mediadock", retentionSeconds = 3_600) {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    uploadSessions: [], uploadParts: [], blobObjects: [], mediaAssets: [], scanJobs: [], scanResults: [],
    transcodeProfiles: [{
      profileId, tenantId, name: "Hidden Copy", revision: 1, operation: "COPY", prefixBase64: null,
      maxAttempts: 3, createdAt,
    }],
    transcodeJobs: [], renditions: [], accessGrants: [],
    cleanupPolicies: [{
      cleanupPolicyId, tenantId, revision: 1, uploadRetentionSeconds: retentionSeconds,
      quarantineRetentionSeconds: retentionSeconds, stagingRetentionSeconds: retentionSeconds,
      unreferencedRetentionSeconds: retentionSeconds, createdAt,
    }],
    cleanupRuns: [], cleanupEntries: [],
  };
}

async function putPart(ctx, baseUrl, uploadId, part, key) {
  const response = await ctx.request(baseUrl, `/api/v1/uploads/${uploadId}/parts/${part.partNumber}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${part.start}-${part.end}/${part.total}`,
      "x-part-sha256": part.sha256,
      "idempotency-key": key,
    },
    raw: part.body,
  });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

async function uploadAll(ctx, baseUrl, uploadId, bytes, keyPrefix, order = parts(bytes)) {
  const manifest = parts(bytes);
  for (const part of order) await putPart(ctx, baseUrl, uploadId, part, `${keyPrefix}-part-${part.partNumber}`);
  return manifest;
}

async function complete(ctx, baseUrl, uploadId, bytes, key) {
  const manifest = parts(bytes).map(({ partNumber, sha256, size }) => ({ partNumber, sha256, size }));
  const response = await ctx.mutate(baseUrl, `/api/v1/uploads/${uploadId}/complete`, key, {
    parts: manifest, expectedSize: bytes.length, expectedSha256: sha256(bytes),
  });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

async function createAndComplete(ctx, baseUrl, index, options = {}) {
  const startedAt = performance.now();
  const bytes = mediaBytes(index, options);
  const created = await ctx.mutate(baseUrl, "/api/v1/uploads", `upload-${index}`, uploadPayload(index, options));
  assert.ok(created.status >= 200 && created.status < 300, created.text);
  const uploadId = find(created.json, "uploadId");
  await uploadAll(ctx, baseUrl, uploadId, bytes, `upload-${index}`);
  if (options.replayPart) await putPart(ctx, baseUrl, uploadId, parts(bytes)[0], `upload-${index}-part-1`);
  const response = await complete(ctx, baseUrl, uploadId, bytes, `upload-${index}-complete`);
  return { ...response, durationMs: performance.now() - startedAt, uploadId, assetId: find(response.json, "assetId"), bytes };
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const operationStartedAt = performance.now();
    const response = await request(index);
    latencies.push(response.durationMs ?? performance.now() - operationStartedAt);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((left, right) => left - right);
  return {
    completed: count,
    durationMs,
    throughput: count / (durationMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses: Object.fromEntries(statuses),
  };
}

async function readyAsset(ctx, baseUrl, index) {
  const completed = await createAndComplete(ctx, baseUrl, index);
  const worker = await ctx.startWorker();
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrl);
    const asset = value.resources.mediaAssets.find((entry) => entry.assetId === completed.assetId);
    return asset?.state === "READY" ? value : undefined;
  }, { timeoutMs: 60_000, label: `Asset ${index} READY`, children: [worker] });
  await ctx.stop(worker);
  return { ...completed, snapshot };
}

const spec = {
  label: "MediaDock UploadSession creation",
  performanceScenarioIds: ["multipart-ingest", "resume-contention", "pipeline-cleanup-recovery"],
  seed: async () => seed(),
  path: "/api/v1/uploads",
  payload: (index) => uploadPayload(index),
  conflictPayload: () => ({ ...uploadPayload(0), expectedSha256: "f".repeat(64) }),
  resource: "uploadSessions",
  identity: (json) => find(json, "uploadId"),
  resourceIdentity: ({ uploadId }) => uploadId,
  workIdentity: (json) => find(json, "assetId") ?? find(json, "uploadId"),
  async verify(ctx, baseUrl, response) {
    const uploadId = find(response.json, "uploadId");
    const bytes = mediaBytes(0);
    await uploadAll(ctx, baseUrl, uploadId, bytes, "h03");
    const completed = await complete(ctx, baseUrl, uploadId, bytes, "h03-complete");
    const assetId = find(completed.json, "assetId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      return value.resources.mediaAssets.some((entry) => entry.assetId === assetId && entry.state === "READY") ? value : undefined;
    }, { timeoutMs: 60_000, label: "Media pipeline READY", children: [worker] });
    const asset = snapshot.resources.mediaAssets.find((entry) => entry.assetId === assetId);
    const renditions = snapshot.resources.renditions.filter((entry) => entry.assetId === assetId);
    assert.equal(asset.sha256, sha256(bytes));
    assert.equal(renditions.length, 1);
    assert.equal(renditions[0].sha256, sha256(bytes));

    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const granted = await ctx.mutate(baseUrl, `/api/v1/assets/${assetId}/access-grants`, "h03-grant", { renditionId: null, expiresAt });
    assert.ok(granted.status >= 200 && granted.status < 300, granted.text);
    const grantId = find(granted.json, "grantId");
    const token = find(granted.json, "token");
    const downloaded = await ctx.request(baseUrl, `/media/${grantId}?token=${encodeURIComponent(token)}`, { binary: true });
    assert.equal(downloaded.status, 200);
    assert.equal(sha256(downloaded.body), sha256(bytes));
    const revoked = await ctx.mutate(baseUrl, `/api/v1/access-grants/${grantId}/revoke`, "h03-revoke", {});
    assert.ok(revoked.status >= 200 && revoked.status < 300, revoked.text);
    const denied = await ctx.request(baseUrl, `/media/${grantId}?token=${encodeURIComponent(token)}`, { binary: true });
    assert.ok([401, 403, 404, 410].includes(denied.status));
  },
  async atomic(ctx, baseUrl) {
    const created = await ctx.mutate(baseUrl, "/api/v1/uploads", "h04-upload", uploadPayload(40));
    const uploadId = find(created.json, "uploadId");
    const part = parts(mediaBytes(40))[0];
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.request(baseUrl, `/api/v1/uploads/${uploadId}/parts/1`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream", "content-range": `bytes 0-${part.end}/${mediaBytes(40).length}`,
        "x-part-sha256": "0".repeat(64), "idempotency-key": "h04-bad-part",
      },
      raw: part.body,
    });
    assert.equal(rejected.status, 400);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.uploadParts.length, before.resources.uploadParts.length);
    assert.equal(after.resources.blobObjects.length, before.resources.blobObjects.length);
  },
  async contention(ctx, baseUrls) {
    const bytes = mediaBytes(60);
    const created = await ctx.mutate(baseUrls[0], "/api/v1/uploads", "h06-upload", uploadPayload(60));
    const uploadId = find(created.json, "uploadId");
    const manifest = parts(bytes);
    for (const part of manifest) {
      const results = await Promise.all(Array.from({ length: 16 }, (_, index) => putPart(
        ctx, baseUrls[index % 2], uploadId, part, `h06-part-${part.partNumber}`,
      )));
      assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
    }
    const completions = await Promise.all(Array.from({ length: 32 }, (_, index) => complete(
      ctx, baseUrls[index % 2], uploadId, bytes, `h06-complete-${index}`,
    )));
    assert.equal(new Set(completions.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.mediaAssets.filter((entry) => entry.sha256 === sha256(bytes)).length, 1);
  },
  async prepareWork(ctx, baseUrl) {
    return createAndComplete(ctx, baseUrl, 70);
  },
  manager: {
    path: "/api/v1/media-aliases",
    payload: (index) => ({ tenantId, name: `hidden-alias-${index}`, requiredProfileIds: [profileId] }),
    async verify(ctx, baseUrl, response) {
      const aliasId = find(response.json, "aliasId");
      const asset = await readyAsset(ctx, baseUrl, 80);
      const published = await ctx.mutate(baseUrl, `/api/v1/media-aliases/${aliasId}/publish`, "h10-publish", {
        assetId: asset.assetId, expectedRevision: 0,
      });
      assert.ok(published.status >= 200 && published.status < 300, published.text);
      const snapshot = await ctx.snapshot(baseUrl);
      assert.equal(snapshot.resources.mediaAliases.find((entry) => entry.aliasId === aliasId)?.currentRevision, 1);
      assert.equal(snapshot.resources.publicationRevisions.filter((entry) => entry.aliasId === aliasId).length, 1);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const aliasId = find(response.json, "aliasId");
      const first = await readyAsset(ctx, baseUrls[0], 90);
      const second = await readyAsset(ctx, baseUrls[0], 91);
      const results = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/media-aliases/${aliasId}/publish`, "h11-publish-a", { assetId: first.assetId, expectedRevision: 0 }),
        ctx.mutate(baseUrls[1], `/api/v1/media-aliases/${aliasId}/publish`, "h11-publish-b", { assetId: second.assetId, expectedRevision: 0 }),
      ]);
      assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.equal(results.filter(({ status }) => status === 409).length, 1);
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.publicationRevisions.filter((entry) => entry.aliasId === aliasId).length, 1);
    },
  },
  performance: mediaDockPerformance,
};

async function mediaDockPerformance(ctx, assertions) {
  const scale = performanceScale();

  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-mediadock-ingest"))).exitCode, 0);
  let api = await ctx.startApi();
  const ingestCount = Math.max(100, Math.ceil(10_000 * scale));
  const ingest = await fixedLoad(ctx, {
    count: ingestCount, concurrency: 64,
    request: (index) => createAndComplete(ctx, api.baseUrl, 1_000 + index, { size: 65_536, replayPart: index % 10 === 0 }),
  });
  assert.ok(ingest.throughput >= 80 && ingest.p95 <= 900, `multipart-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assert.equal(Object.entries(ingest.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0);
  assertions.push(`multipart-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-mediadock-resume"))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const resumeCount = Math.max(50, Math.ceil(2_000 * scale));
  const resume = await fixedLoad(ctx, {
    count: resumeCount, concurrency: 32,
    request: async (client) => {
      const startedAt = performance.now();
      const index = 20_000 + client;
      const options = { size: 262_144 };
      const bytes = mediaBytes(index, options);
      const created = await ctx.mutate(api.baseUrl, "/api/v1/uploads", `resume-${index}`, uploadPayload(index, options));
      const uploadId = find(created.json, "uploadId");
      const manifest = parts(bytes);
      for (const part of manifest.filter(({ partNumber }) => partNumber % 2 === 0)) {
        await putPart(ctx, client % 2 ? api.baseUrl : apiB.baseUrl, uploadId, part, `resume-${index}-${part.partNumber}`);
      }
      const reported = await ctx.request(apiB.baseUrl, `/api/v1/uploads/${uploadId}`);
      assert.equal(reported.status, 200);
      for (const part of manifest.filter(({ partNumber }) => partNumber % 2 === 1)) {
        await putPart(ctx, client % 2 ? apiB.baseUrl : api.baseUrl, uploadId, part, `resume-${index}-${part.partNumber}`);
      }
      const completions = await Promise.all(Array.from({ length: 8 }, (_, attempt) => complete(
        ctx, attempt % 2 ? api.baseUrl : apiB.baseUrl, uploadId, bytes, `resume-${index}-complete-${attempt}`,
      )));
      assert.equal(new Set(completions.map(({ json }) => ctx.canonical(json))).size, 1);
      return { ...completions[0], durationMs: performance.now() - startedAt };
    },
  });
  assert.ok(resume.throughput >= 40 && resume.p95 <= 1_500, `resume-contention ${resume.throughput}/s p95=${resume.p95}`);
  assert.equal(Object.entries(resume.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0);
  assertions.push(`resume-contention ${resume.throughput.toFixed(1)}/s p95 ${resume.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-mediadock-pipeline", 0))).exitCode, 0);
  api = await ctx.startApi();
  const pipelineCount = Math.max(50, Math.ceil(5_000 * scale));
  await ctx.concurrent(Array.from({ length: pipelineCount }), 64, (_, index) => createAndComplete(
    ctx, api.baseUrl, 100_000 + index, { infected: index % 10 === 0, size: 65_536 },
  ));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "mediadock-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label: "Two media pipeline claims", children: first });
  await Promise.all(first.map((process) => ctx.stop(process, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const terminalAssets = snapshot.resources.mediaAssets.filter(({ state }) => ["READY", "INFECTED", "FAILED"].includes(state));
    return terminalAssets.length === pipelineCount ? snapshot : undefined;
  }, { timeoutMs: 90_000, label: "Media pipeline recovery", children: replacements });
  const cleanup = await ctx.mutate(api.baseUrl, "/api/v1/cleanup-runs", "perf-cleanup", { tenantId, cleanupPolicyId, cutoffAt: new Date().toISOString() });
  assert.ok(cleanup.status >= 200 && cleanup.status < 300, cleanup.text);
  const cleanupRunId = find(cleanup.json, "cleanupRunId");
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const run = snapshot.resources.cleanupRuns.find((entry) => entry.cleanupRunId === cleanupRunId);
    const pending = snapshot.work.some(({ terminal }) => !terminal);
    return run?.state === "COMPLETED" && !pending ? snapshot : undefined;
  }, { timeoutMs: 90_000, label: "Pipeline and cleanup drain", children: replacements });
  const durationMs = Date.now() - startedAt;
  const clean = final.resources.mediaAssets.filter(({ state }) => state === "READY");
  const infected = final.resources.mediaAssets.filter(({ state }) => state === "INFECTED");
  assert.equal(clean.length + infected.length, pipelineCount);
  assert.equal(final.resources.renditions.length, clean.length);
  assert.equal(new Set(final.resources.renditions.map(({ transcodeJobId, assetId, profileId }) => transcodeJobId ?? `${assetId}:${profileId}`)).size, clean.length);
  assertions.push(`pipeline-cleanup-recovery ${pipelineCount} assets in ${durationMs}ms after two SIGKILLs`);

  return {
    metrics: [
      { scenarioId: "multipart-ingest", ...ingest },
      { scenarioId: "resume-contention", ...resume },
      { scenarioId: "pipeline-cleanup-recovery", completed: pipelineCount, durationMs, clean: clean.length, infected: infected.length, killedWorkers: 2, replacementWorkers: 4 },
    ],
  };
}

export default standardAdapter(spec);
