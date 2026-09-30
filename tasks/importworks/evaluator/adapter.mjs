import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const schemaId = id(2);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = find(child, key);
    if (found !== undefined) return found;
  }
}

function seed(seedVersion = "hidden-importworks", history = false) {
  const historyBytes = rows(900,1);
  const historicalImportId = id(900);
  return {
    schemaVersion: 1, seedVersion,
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    schemas: [{ schemaId, tenantId, datasetKey: "customers", name: "Customers" }],
    schemaRevisions: [{
      schemaId, revision: 1, externalIdField: "externalId", additionalProperties: false,
      fields: [
        { name: "externalId", type: "string", required: true, maxLength: 64 },
        { name: "email", type: "string", required: true, maxLength: 254 },
        { name: "age", type: "integer", required: false, minimum: 0, maximum: 130 },
      ],
    }],
    imports: history ? [{ importId:historicalImportId,tenantId,datasetKey:"customers",schemaRevision:1,commitMode:"VALID_ROWS",state:"COMMITTED",
      expectedBytes:historyBytes.length,expectedSha256:sha256(historyBytes),receivedBytes:historyBytes.length,totalRows:1,validRows:1,invalidRows:0,
      createdAt:"2026-01-01T00:00:00.000Z",completedAt:"2026-01-01T00:01:00.000Z",sequence:4 }] : [],
    uploadChunks: history ? [{ importId:historicalImportId,chunkNumber:1,start:0,end:historyBytes.length-1,size:historyBytes.length,
      sha256:sha256(historyBytes),receivedAt:"2026-01-01T00:00:10.000Z" }] : [],
    validationFindings: [],
    committedRecords: history ? [{ recordId:id(901),tenantId,datasetKey:"customers",externalRowId:"customer-900-0",sourceImportId:historicalImportId,
      payload:{ externalId:"customer-900-0",email:"customer-900-0@example.test",age:20 },payloadDigest:sha256(JSON.stringify({ externalId:"customer-900-0",email:"customer-900-0@example.test",age:20 })),committedAt:"2026-01-01T00:01:00.000Z" }] : [],
    errorReports: [],
  };
}

function rows(index, count = 8, invalidEvery = 0) {
  return Buffer.from(Array.from({ length: count }, (_, row) => JSON.stringify({
    externalId: `customer-${index}-${row}`,
    email: invalidEvery && row % invalidEvery === 0 ? 42 : `customer-${index}-${row}@example.test`,
    age: 20 + row % 60,
  })).join("\n") + "\n");
}

function importPayload(index, bytes = rows(index), commitMode = "VALID_ROWS") {
  return { tenantId, datasetKey: "customers", schemaId, schemaRevision: 1, commitMode,
    expectedBytes: bytes.length, expectedSha256: sha256(bytes), externalIdField: "externalId" };
}

function assertSuccessful(metric, allowed = [200, 201, 202]) {
  const failures = Object.entries(metric.statuses).filter(([status]) => !allowed.includes(Number(status)));
  assert.deepEqual(failures, [], `unexpected load responses: ${JSON.stringify(failures)}`);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

async function prepareCase(ctx, value) {
  await ctx.prepare();
  assert.equal((await ctx.seed(value)).exitCode,0);
  return ctx.startApi();
}

let migrationHistory;

async function upload(ctx, baseUrl, importId, bytes, keyPrefix, chunks = 4) {
  const width = Math.ceil(bytes.length / chunks);
  const pieces = [];
  for (let number = 1, start = 0; start < bytes.length; number += 1, start += width) {
    const body = bytes.subarray(start, Math.min(start + width, bytes.length));
    pieces.push({ number, start, end: start + body.length - 1, body });
  }
  for (const piece of [...pieces].reverse()) {
    const response = await ctx.request(baseUrl, `/api/v1/imports/${importId}/chunks/${piece.number}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-range": `bytes ${piece.start}-${piece.end}/${bytes.length}`,
        "x-chunk-sha256": sha256(piece.body), "idempotency-key": `${keyPrefix}-${piece.number}` },
      raw: piece.body,
    });
    assert.ok(response.status >= 200 && response.status < 300, response.text);
  }
  return pieces;
}

async function createUploaded(ctx, baseUrl, index, options = {}) {
  const bytes = options.bytes ?? rows(index, options.rowCount ?? 8, options.invalidEvery ?? 0);
  const created = await ctx.mutate(baseUrl, "/api/v1/imports", `import-${index}`, importPayload(index, bytes, options.commitMode));
  assert.ok(created.status >= 200 && created.status < 300, created.text);
  const importId = find(created.json, "importId");
  const pieces = await upload(ctx, baseUrl, importId, bytes, `import-${index}`);
  if (options.replay) await upload(ctx, baseUrl, importId, bytes, `import-${index}`, pieces.length);
  const completed = await ctx.mutate(baseUrl, `/api/v1/imports/${importId}/complete`, `import-${index}-complete`, {});
  assert.ok(completed.status >= 200 && completed.status < 300, completed.text);
  return { importId, bytes, created, completed, startedAt: performance.now() };
}

async function fixedLoad(ctx, count, concurrency, operation) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const operationStarted = performance.now();
    const response = await operation(index);
    latencies.push(response.durationMs ?? performance.now() - operationStarted);
    statuses.set(response.status ?? 200, (statuses.get(response.status ?? 200) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const pick = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed: count, durationMs, throughput: count / (durationMs / 1_000), p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), statuses: Object.fromEntries(statuses) };
}

const spec = {
  label: "ImportWorks ImportJob creation",
  performanceScenarioIds: ["resumable-upload", "partial-commit", "validation-recovery"],
  seed: async () => seed("hidden-importworks",true),
  path: "/api/v1/imports",
  payload: (index) => importPayload(index, rows(index, 8, 4)),
  conflictPayload: () => ({ ...importPayload(0, rows(0, 8, 4)), expectedSha256: "f".repeat(64) }),
  resource: "imports",
  identity: (json) => find(json, "importId"),
  resourceIdentity: ({ importId }) => importId,
  workIdentity: (json) => find(json, "importId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace === ctx.workspace) return;
    const uploaded=await createUploaded(ctx,api.baseUrl,700);
    const worker=await ctx.startWorker({},workspace);
    await ctx.waitFor(async () => (await ctx.snapshot(api.baseUrl)).resources.imports.find((entry) => entry.importId===uploaded.importId)?.state==="VALIDATED",{ label:"V1 migration import validation",children:[worker] });
    const committed=await ctx.mutate(api.baseUrl,`/api/v1/imports/${uploaded.importId}/commit`,"h09-history-commit",{});
    assert.ok(committed.status>=200&&committed.status<300,committed.text);
    const snapshot=await ctx.waitFor(async () => {
      const value=await ctx.snapshot(api.baseUrl);
      return value.resources.imports.find((entry) => entry.importId===uploaded.importId)?.state==="COMMITTED" ? value : undefined;
    },{ label:"V1 migration import commit",children:[worker] });
    await ctx.stop(worker);
    migrationHistory={ importId:uploaded.importId,recordIds:snapshot.resources.committedRecords.filter((entry) => entry.sourceImportId===uploaded.importId).map(({ recordId }) => recordId),
      eventIds:snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),workIds:snapshot.work.map(({ workId }) => workId) };
  },
  async verify(ctx, baseUrl, response) {
    const importId = find(response.json, "importId");
    const bytes = rows(0, 8, 4);
    await upload(ctx, baseUrl, importId, bytes, "h03");
    const completed = await ctx.mutate(baseUrl, `/api/v1/imports/${importId}/complete`, "h03-complete", {});
    assert.ok(completed.status >= 200 && completed.status < 300, completed.text);
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrl);
      return snapshot.resources.imports.find((entry) => entry.importId === importId)?.state === "VALIDATED" ? snapshot : undefined;
    }, { label: "Import validation", children: [worker] });
    const committed = await ctx.mutate(baseUrl, `/api/v1/imports/${importId}/commit`, "h03-commit", {});
    assert.ok(committed.status >= 200 && committed.status < 300, committed.text);
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const terminal = ["COMMITTED", "PARTIALLY_COMMITTED"].includes(value.resources.imports.find((entry) => entry.importId === importId)?.state);
      const reportReady = value.resources.errorReports.some((entry) => entry.importId === importId && entry.state === "READY");
      return terminal && reportReady ? value : undefined;
    }, { label: "Import commit", children: [worker] });
    const job = snapshot.resources.imports.find((entry) => entry.importId === importId);
    const records = snapshot.resources.committedRecords.filter((entry) => entry.sourceImportId === importId);
    const findings = snapshot.resources.validationFindings.filter((entry) => entry.importId === importId);
    const reports = snapshot.resources.errorReports.filter((entry) => entry.importId === importId);
    assert.deepEqual([job.totalRows, job.validRows, job.invalidRows], [8, 6, 2]);
    assert.equal(records.length, 6);
    assert.equal(findings.length, 2);
    assertUnique(records.map(({ externalRowId }) => externalRowId), "committed external row IDs");
    assert.deepEqual(findings, [...findings].sort((a, b) => a.rowNumber - b.rowNumber || a.field.localeCompare(b.field) || a.code.localeCompare(b.code) || a.findingId.localeCompare(b.findingId)));
    assert.ok(reports.length === 1 && reports[0].state === "READY" && /^[0-9a-f]{64}$/u.test(reports[0].sha256));
  },
  async atomic(ctx, baseUrl) {
    const bytes = rows(40);
    const created = await ctx.mutate(baseUrl, "/api/v1/imports", "h04-import", importPayload(40, bytes));
    const importId = find(created.json, "importId");
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.request(baseUrl, `/api/v1/imports/${importId}/chunks/1`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "x-chunk-sha256": "0".repeat(64), "idempotency-key": "h04-bad-chunk" }, raw: bytes,
    });
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal((await ctx.snapshot(baseUrl)).resources.uploadChunks.length, before.resources.uploadChunks.length);

    const gap = await ctx.mutate(baseUrl, `/api/v1/imports/${importId}/complete`, "h04-gap", {});
    assert.equal(gap.status, 409, gap.text);
    assert.equal((await ctx.snapshot(baseUrl)).work.length, before.work.length);

    const invalidBytes = Buffer.from('{"externalId":"bad","email":"ok@example.test"}\n{"externalId":"broken"\n');
    const invalid = await createUploaded(ctx, baseUrl, 41, { bytes:invalidBytes, commitMode:"ALL_OR_NOTHING" });
    const worker = await ctx.startWorker();
    let invalidSnapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      return ["VALIDATED","REJECTED"].includes(value.resources.imports.find((entry) => entry.importId === invalid.importId)?.state) ? value : undefined;
    }, { label:"ALL_OR_NOTHING validation rejection", children:[worker] });
    if (invalidSnapshot.resources.imports.find((entry) => entry.importId === invalid.importId)?.state === "VALIDATED") {
      const commit = await ctx.mutate(baseUrl, `/api/v1/imports/${invalid.importId}/commit`, "h04-invalid-commit", {});
      assert.ok(commit.status >= 200 && commit.status < 300, commit.text);
      invalidSnapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.imports.find((entry) => entry.importId === invalid.importId)?.state === "REJECTED" ? value : undefined;
      }, { label:"ALL_OR_NOTHING terminal rejection", children:[worker] });
    }
    assert.equal(invalidSnapshot.resources.committedRecords.filter((entry) => entry.sourceImportId === invalid.importId).length, 0);
    assert.ok(invalidSnapshot.resources.validationFindings.some((entry) => entry.importId === invalid.importId));
  },
  async contention(ctx, baseUrls) {
    const first = await createUploaded(ctx, baseUrls[0], 60);
    const second = await createUploaded(ctx, baseUrls[1], 61, { bytes:rows(60) });
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrls[0]);
      return [first, second].every(({ importId }) => snapshot.resources.imports.find((entry) => entry.importId === importId)?.state === "VALIDATED") ? snapshot : undefined;
    }, { label:"contended imports validated", children:[worker] });
    const results = await Promise.all([first, second].flatMap(({ importId }) => Array.from({ length:16 }, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/imports/${importId}/commit`, `h06-commit-${importId}-${index}`, {},
    ))));
    assert.equal(results.filter(({ status }) => status >= 500).length, 0);
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrls[0]);
      return [first, second].every(({ importId }) => ["COMMITTED","PARTIALLY_COMMITTED","REJECTED"].includes(value.resources.imports.find((entry) => entry.importId === importId)?.state)) ? value : undefined;
    }, { label:"contended commits", children:[worker] });
    const records = snapshot.resources.committedRecords.filter((entry) => [first.importId, second.importId].includes(entry.sourceImportId));
    assert.equal(records.length, 8);
    assertUnique(records.map(({ externalRowId }) => externalRowId), "contended external row IDs");
  },
  async prepareWork(ctx, baseUrl) {
    const uploaded = await createUploaded(ctx, baseUrl, 70);
    return { json:{ importId:uploaded.importId } };
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const importId = find(created.json, "importId");
    assert.ok(snapshot.resources.imports.some((entry) => entry.importId === importId));
    assert.ok(snapshot.resources.imports.some((entry) => entry.importId === id(900) && entry.state === "COMMITTED"));
    assert.ok(snapshot.resources.uploadChunks.some((entry) => entry.importId === id(900) && entry.chunkNumber === 1));
    assert.ok(snapshot.resources.committedRecords.some((entry) => entry.sourceImportId === id(900) && entry.externalRowId === "customer-900-0"));
    assert.equal(snapshot.resources.importBundles.length, 0);
    assert.equal(snapshot.resources.bundleMembers.length, 0);
    assert.ok(migrationHistory);
    assert.ok(snapshot.resources.imports.some((entry) => entry.importId===migrationHistory.importId&&entry.state==="COMMITTED"));
    for (const value of migrationHistory.recordIds) assert.ok(snapshot.resources.committedRecords.some((entry) => entry.recordId===value));
    for (const value of migrationHistory.eventIds) assert.ok(snapshot.events.some((entry) => find(entry,"eventId")===value));
    for (const value of migrationHistory.workIds) assert.ok(snapshot.work.some((entry) => entry.workId===value));
    assert.ok(snapshot.events.some((entry) => find(entry, "aggregateId") === importId));
    assert.ok(snapshot.work.some((entry) => entry.aggregateId === importId));
    assertUnique(snapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "migrated event IDs");
    assertUnique(snapshot.work.map(({ workId }) => workId), "migrated Work IDs");
  },
  manager: {
    path: "/api/v1/import-bundles",
    async prepare(ctx, baseUrl) {
      const imports = await Promise.all([createUploaded(ctx, baseUrl, 800), createUploaded(ctx, baseUrl, 801)]);
      const worker = await ctx.startWorker();
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        return imports.every(({ importId }) => snapshot.resources.imports.find((entry) => entry.importId === importId)?.state === "VALIDATED") ? snapshot : undefined;
      }, { label:"Bundle members validated", children:[worker] });
      await ctx.stop(worker);
      return { importIds:imports.map(({ importId }) => importId) };
    },
    payload: (index) => ({ tenantId, name: `hidden-bundle-${index}` }),
    async verify(ctx, baseUrl, response, operation) {
      const bundleId = find(response.json, "bundleId");
      for (const [index, importId] of operation.importIds.entries()) {
        const member = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/members`, `h10-member-${index}`, { importId });
        assert.ok(member.status >= 200 && member.status < 300, member.text);
      }
      const staged = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/stage`, "h10-stage", {});
      assert.ok(staged.status >= 200 && staged.status < 300, staged.text);
      const frozen = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/members`, "h10-frozen-member", { importId:operation.importIds[0] });
      assert.equal(frozen.status, 409, frozen.text);
      assert.equal(find(frozen.json, "code"), "BUNDLE_FROZEN");
      const published = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${bundleId}/publish`, "h10-publish", {});
      assert.ok(published.status >= 200 && published.status < 300, published.text);
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.importBundles.find((entry) => entry.bundleId === bundleId)?.state === "PUBLISHED" ? value : undefined;
      }, { label:"Bundle published", children:[worker] });
      assert.equal(snapshot.resources.bundleMembers.filter((entry) => entry.bundleId === bundleId).length, 2);
      const records = snapshot.resources.committedRecords.filter((entry) => operation.importIds.includes(entry.sourceImportId));
      assert.equal(records.length, 16);
      assertUnique(records.map(({ recordId }) => recordId), "Bundle record IDs");
      assertUnique(snapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "Bundle event IDs");

      const invalid = await createUploaded(ctx, baseUrl, 802, { rowCount:8, invalidEvery:2, commitMode:"ALL_OR_NOTHING" });
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.imports.find((entry) => entry.importId === invalid.importId)?.state === "VALIDATED" ? value : undefined;
      }, { label:"Bundle rejecting member validated", children:[worker] });
      const rejectedBundle = await ctx.mutate(baseUrl, "/api/v1/import-bundles", "h10-rejected-bundle", { tenantId, name:"hidden-rejected-bundle" });
      assert.ok(rejectedBundle.status >= 200 && rejectedBundle.status < 300, rejectedBundle.text);
      const rejectedBundleId = find(rejectedBundle.json, "bundleId");
      const rejectedMember = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${rejectedBundleId}/members`, "h10-rejected-member", { importId:invalid.importId });
      assert.ok(rejectedMember.status >= 200 && rejectedMember.status < 300, rejectedMember.text);
      const rejectedStage = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${rejectedBundleId}/stage`, "h10-rejected-stage", {});
      assert.ok(rejectedStage.status >= 200 && rejectedStage.status < 300, rejectedStage.text);
      const rejectedPublish = await ctx.mutate(baseUrl, `/api/v1/import-bundles/${rejectedBundleId}/publish`, "h10-rejected-publish", {});
      assert.ok(rejectedPublish.status >= 200 && rejectedPublish.status < 300, rejectedPublish.text);
      const rejectedSnapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.importBundles.find((entry) => entry.bundleId === rejectedBundleId)?.state === "REJECTED" ? value : undefined;
      }, { label:"ALL_OR_NOTHING Bundle rejected", children:[worker] });
      assert.equal(rejectedSnapshot.resources.committedRecords.filter((entry) => entry.sourceImportId === invalid.importId).length, 0);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const bundleId = find(response.json, "bundleId");
      for (const [index, importId] of operation.importIds.entries()) {
        const member = await ctx.mutate(baseUrls[index % 2], `/api/v1/import-bundles/${bundleId}/members`, `h11-member-${index}`, { importId });
        assert.ok(member.status >= 200 && member.status < 300, member.text);
      }
      const staged = await ctx.mutate(baseUrls[0], `/api/v1/import-bundles/${bundleId}/stage`, "h11-stage", {});
      assert.ok(staged.status >= 200 && staged.status < 300, staged.text);
      const shield = await ctx.responseShield(baseUrls[0]);
      shield.dropNextMutation();
      await ctx.mutate(shield.baseUrl, `/api/v1/import-bundles/${bundleId}/publish`, "h11-publish", {}).catch(() => undefined);
      await ctx.waitFor(() => shield.captures.length === 1, { label:"committed Bundle publish response" });
      const publishes = await Promise.all(Array.from({ length:32 }, (_, index) => ctx.mutate(baseUrls[index % 2], `/api/v1/import-bundles/${bundleId}/publish`, "h11-publish", {})));
      assert.equal(new Set(publishes.map(({ status,json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
      assert.equal(ctx.canonical(publishes[0].json), ctx.canonical(JSON.parse(shield.captures[0].body)));
      const conflicts = await Promise.all(Array.from({ length:16 }, (_, index) => ctx.mutate(baseUrls[index % 2], `/api/v1/import-bundles/${bundleId}/publish`, `h11-conflict-${index}`, {})));
      assert.ok(conflicts.every(({ status }) => status === 409));
      let beforeKill = await ctx.snapshot(baseUrls[0]);
      const pending = beforeKill.work.find((entry) => entry.kind === "BUNDLE_PUBLISH" && !entry.terminal);
      assert.ok(pending, "Bundle publish scheduled no recoverable Work");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pending.aggregateId ? held : { status:204 });
      const killed = await ctx.startWorker({ TEST_BARRIER_URL:barrier.url, TEST_BARRIER_TOKEN:"h11-bundle" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === pending.aggregateId), { label:"Bundle publish claimed", children:[killed] });
      await ctx.stop(killed, "SIGKILL");
      release({ status:204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.importBundles.find((entry) => entry.bundleId === bundleId)?.state === "PUBLISHED" ? value : undefined;
      }, { label:"Contended Bundle published", children:[worker] });
      assert.equal(snapshot.resources.bundleMembers.filter((entry) => entry.bundleId === bundleId).length, 2);
      const records = snapshot.resources.committedRecords.filter((entry) => operation.importIds.includes(entry.sourceImportId));
      assert.equal(records.length, 16);
      assertUnique(records.map(({ recordId }) => recordId), "contended Bundle record IDs");
      assertUnique(snapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "contended Bundle event IDs");
      assert.ok(snapshot.work.some((entry) => entry.workId === pending.workId && entry.terminal));
    },
  },
  cases:{ "H-05":importIdempotency, "H-08":importOutboxRecovery },
  performance: importPerformance,
};

async function importIdempotency(ctx, assertions) {
  let api=await prepareCase(ctx,seed("h05-importworks"));
  const uploaded=await createUploaded(ctx,api.baseUrl,90);
  let worker=await ctx.startWorker();
  await ctx.waitFor(async () => (await ctx.snapshot(api.baseUrl)).resources.imports.find((entry) => entry.importId===uploaded.importId)?.state==="VALIDATED",{ label:"idempotent import validation",children:[worker] });
  await ctx.stop(worker);
  const path=`/api/v1/imports/${uploaded.importId}/commit`; const shield=await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl,path,"h05-commit",{}).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length===1,{ label:"committed import response" });
  await ctx.stop(api); api=await ctx.startApi();
  const replay=await ctx.mutate(api.baseUrl,path,"h05-commit",{});
  assert.equal(ctx.canonical(replay.json),ctx.canonical(JSON.parse(shield.captures[0].body)));
  const concurrent=await ctx.concurrent(Array.from({ length:20 }),20,() => ctx.mutate(api.baseUrl,path,"h05-commit",{}));
  assert.equal(new Set(concurrent.map(({ status,json }) => `${status}:${ctx.canonical(json)}`)).size,1);
  const conflict=await ctx.mutate(api.baseUrl,path,"h05-commit",{ changed:true });
  assert.equal(conflict.status,409,conflict.text);
  worker=await ctx.startWorker();
  const snapshot=await ctx.waitFor(async () => {
    const value=await ctx.snapshot(api.baseUrl);
    return value.resources.imports.find((entry) => entry.importId===uploaded.importId)?.state==="COMMITTED" ? value : undefined;
  },{ label:"idempotent import commit",children:[worker] });
  assert.equal(snapshot.resources.committedRecords.filter((entry) => entry.sourceImportId===uploaded.importId).length,8);
  assertUnique(snapshot.resources.committedRecords.map(({ recordId }) => recordId),"idempotent record IDs");
  assertUnique(snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),"idempotent event IDs");
  assertions.push("chunked import commit survives unknown response, replay, concurrency, and restart once");
}

async function importOutboxRecovery(ctx, assertions) {
  const api=await prepareCase(ctx,seed("h08-importworks"));
  const uploaded=await createUploaded(ctx,api.baseUrl,91); const worker=await ctx.startWorker();
  await ctx.waitFor(async () => (await ctx.snapshot(api.baseUrl)).resources.imports.find((entry) => entry.importId===uploaded.importId)?.state==="VALIDATED",{ label:"outbox import validation",children:[worker] });
  const committed=await ctx.mutate(api.baseUrl,`/api/v1/imports/${uploaded.importId}/commit`,"h08-commit",{});
  assert.ok(committed.status>=200&&committed.status<300,committed.text);
  await ctx.waitFor(async () => ["COMMITTED","PARTIALLY_COMMITTED"].includes((await ctx.snapshot(api.baseUrl)).resources.imports.find((entry) => entry.importId===uploaded.importId)?.state),{ label:"outbox import commit",children:[worker] });
  const webhook=await ctx.receiver(); let release; const held=new Promise((resolve) => { release=resolve; });
  const barrier=await ctx.receiver((entry) => entry.json?.point==="dispatcher.response-received" ? held : { status:204 });
  const first=await ctx.startDispatcher(webhook.url,{ TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:"h08-import" });
  await ctx.waitFor(() => barrier.ledger.length>0,{ label:"import event response",children:[first] });
  await ctx.stop(first,"SIGKILL"); release({ status:204 });
  const replacement=await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length>=2,{ timeoutMs:60_000,label:"import event retry",children:[replacement] });
  assert.equal(webhook.ledger[0].raw,webhook.ledger[1].raw);
  const eventHeader=Object.keys(webhook.ledger[0].headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader); assert.equal(webhook.ledger[0].headers[eventHeader],webhook.ledger[1].headers[eventHeader]);
  const snapshot=await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.committedRecords.filter((entry) => entry.sourceImportId===uploaded.importId).length,8);
  assertUnique(snapshot.events.map((entry) => find(entry,"eventId")).filter(Boolean),"outbox event IDs");
  assertions.push("committed import remains singular while dispatcher retries byte-identical event data");
}

async function importPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-importworks-upload"))).exitCode, 0);
  let api = await ctx.startApi();
  const uploadCount = Math.max(20, Math.ceil(2_000 * scale));
  const uploadBytes = Buffer.alloc(Math.max(65_536, Math.ceil(1_048_576 * scale)), 97);
  const ingest = await fixedLoad(ctx, uploadCount, 64, async (index) => {
    const startedAt = performance.now();
    const result = await createUploaded(ctx, api.baseUrl, 1_000 + index, { bytes: uploadBytes, replay: index % 10 === 0 });
    return { status: result.completed.status, durationMs: performance.now() - startedAt };
  });
  assert.ok(ingest.throughput >= 40 && ingest.p95 <= 1_500, `resumable-upload ${ingest.throughput}/s p95=${ingest.p95}`);
  assertSuccessful(ingest);
  const ingestWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const ingestSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, {
    timeoutMs: 120_000, label: "Upload validation drain", children: ingestWorkers,
  });
  assert.equal(ingestSnapshot.resources.imports.length, uploadCount);
  assert.equal(ingestSnapshot.resources.uploadChunks.length, uploadCount * 4);
  assert.ok(ingestSnapshot.resources.imports.every((entry) => entry.receivedBytes === uploadBytes.length && entry.expectedSha256 === sha256(uploadBytes)));
  assertions.push(`resumable-upload ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-importworks-partial"))).exitCode, 0);
  api = await ctx.startApi();
  const partialCount = Math.max(20, Math.ceil(5_000 * scale));
  const imports = await ctx.concurrent(Array.from({ length: partialCount }), 32, (_, index) => createUploaded(ctx, api.baseUrl, 10_000 + index, { rowCount: 100, invalidEvery: 10 }));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.imports.filter(({ state }) => state === "VALIDATED").length === partialCount ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "Partial imports validated", children: workers });
  const partial = await fixedLoad(ctx, partialCount, 32, async (index) => {
    const response = await ctx.mutate(api.baseUrl, `/api/v1/imports/${imports[index].importId}/commit`, `partial-commit-${index}`, {});
    return response;
  });
  const partialSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.imports.filter(({ state }) => state === "PARTIALLY_COMMITTED").length === partialCount ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "Partial imports committed", children: workers });
  assert.ok(partial.throughput >= 20 && partial.p95 <= 2_500, `partial-commit ${partial.throughput}/s p95=${partial.p95}`);
  assertSuccessful(partial);
  assert.equal(partialSnapshot.resources.committedRecords.length, partialCount * 90);
  assert.equal(partialSnapshot.resources.validationFindings.length, partialCount * 10);
  assertUnique(partialSnapshot.resources.committedRecords.map(({ recordId }) => recordId), "partial-commit record IDs");
  assertUnique(partialSnapshot.resources.validationFindings.map(({ findingId }) => findingId), "partial-commit finding IDs");
  assertUnique(partialSnapshot.events.map((entry) => find(entry, "eventId")).filter(Boolean), "partial-commit event IDs");
  assertions.push(`partial-commit ${partial.throughput.toFixed(1)}/s p95 ${partial.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-importworks-recovery"))).exitCode, 0);
  api = await ctx.startApi();
  const recoveryCount = Math.max(20, Math.ceil(10_000 * scale));
  await ctx.concurrent(Array.from({ length: recoveryCount }), 64, (_, index) => createUploaded(ctx, api.baseUrl, 100_000 + index, { rowCount: 1, invalidEvery:2 }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const killed = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "importworks-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label: "Two validation claims", children: killed });
  await Promise.all(killed.map((process) => ctx.stop(process, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const terminal = snapshot.resources.imports.filter(({ state }) => ["VALIDATED", "REJECTED"].includes(state)).length;
    return terminal === recoveryCount && snapshot.work.every(({ terminal: done }) => done) ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "Validation recovery drain", children: replacements });
  const durationMs = Date.now() - startedAt;
  assert.ok(durationMs <= 120_000);
  assertUnique(final.resources.committedRecords.map(({ recordId }) => recordId), "recovery record IDs");
  assertUnique(final.resources.validationFindings.map(({ findingId }) => findingId), "recovery finding IDs");
  assertUnique(final.resources.errorReports.map(({ reportId }) => reportId), "recovery report IDs");
  assertUnique(final.events.map((entry) => find(entry, "eventId")).filter(Boolean), "recovery event IDs");
  assertions.push(`validation-recovery ${recoveryCount} imports in ${durationMs}ms after two SIGKILLs`);
  return { metrics: [
    { scenarioId: "resumable-upload", ...ingest },
    { scenarioId: "partial-commit", ...partial },
    { scenarioId: "validation-recovery", completed: recoveryCount, durationMs, killedWorkers: 2, replacementWorkers: 4 },
  ] };
}

export default standardAdapter(spec);
