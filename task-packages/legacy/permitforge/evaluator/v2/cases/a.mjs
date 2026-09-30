import assert from "node:assert/strict";

import {
  assertAggregateSequences,
  assertApplicationRevision,
  assertPermitApplication,
  assertProjection,
  assertReviewClaim,
  assertRevisionHistory,
  assertStageSet,
  canonicalJson,
  sha256,
} from "../oracles/index.mjs";
import {
  applicationCurrent,
  applicationDetail,
  applicationFrom,
  assertAggregateDetailAuthority,
  assertClaimTuple,
  assertExternalSecretBoundary,
  assertSavedHttpReplay,
  blocked,
  boot,
  caseResult,
  claimReview,
  createRevision,
  decisionsFor,
  defineCase,
  domainEvents,
  expectError,
  findObject,
  openApi,
  permitFor,
  requireStatus,
  requireV1Workspace,
  revisionsFor,
  revisionDetail,
  snapshot,
  stableSnapshot,
  stagesDetail,
  submitApplication,
  waitSnapshot,
} from "./helpers.mjs";
import { assertExactV1MigrationClosure } from "./e.mjs";

export function assertFailedV1MigrationRollback(before, after) {
  assert.deepEqual(stableSnapshot(after), stableSnapshot(before), "failed migration leaves public V1 state unchanged without partial FINAL behavior");
  return true;
}

function sqlIdentifier(value, label) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`unsafe evaluator ${label}`);
  return value;
}

export function migrationPauseTriggerSql({ functionName, triggerName }) {
  const functionId = sqlIdentifier(functionName, "function name");
  const triggerId = sqlIdentifier(triggerName, "trigger name");
  return [
    `CREATE FUNCTION public.${functionId}() RETURNS event_trigger LANGUAGE plpgsql AS $pf$`,
    "BEGIN",
    "  PERFORM pg_sleep(60);",
    "END $pf$;",
    `CREATE EVENT TRIGGER ${triggerId} ON ddl_command_end EXECUTE FUNCTION public.${functionId}();`,
  ].join("\n");
}

export function parseUniquePgSleepBackend(stdout) {
  const rows = String(stdout).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  assert.equal(rows.length, 1, `expected exactly one migration backend in PgSleep, observed ${rows.length}`);
  const pid = Number(rows[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "PgSleep backend must have a positive PostgreSQL PID");
  return pid;
}

export async function interruptPopulatedFinalMigration(ctx) {
  const suffix = `${process.pid}_${ctx.caseId.toLowerCase().replaceAll("-", "_")}`;
  const functionName = `pf_a02_pause_${suffix}`;
  const triggerName = `pf_a02_trigger_${suffix}`;
  const installSeam = migrationPauseTriggerSql({ functionName, triggerName });
  const removeSeam = `DROP EVENT TRIGGER IF EXISTS ${triggerName}; DROP FUNCTION IF EXISTS public.${functionName}();`;
  await ctx.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", installSeam], { timeoutMs: 10_000 });

  let settled = false;
  let migrationResult;
  let migrationError;
  const migration = ctx.migrate({
    allowFailure: true,
    timeoutMs: 90_000,
  }).then((result) => {
    settled = true;
    migrationResult = result;
  }, (error) => {
    settled = true;
    migrationError = error;
  });

  try {
    const observeSql = "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='PgSleep' ORDER BY pid";
    let observedPid;
    for (let poll = 0; poll < 200 && observedPid === undefined && !settled; poll += 1) {
      const result = await ctx.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", observeSql], { timeoutMs: 5_000 });
      if (result.stdout.trim()) observedPid = parseUniquePgSleepBackend(result.stdout);
      else await ctx.sleep(25);
    }
    if (observedPid === undefined) throw new Error("expected exactly one migration backend in PgSleep, observed 0");
    const terminateSql = `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid=${observedPid} AND wait_event='PgSleep' AND pg_terminate_backend(pid)`;
    const termination = await ctx.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", terminateSql], { timeoutMs: 5_000 });
    const terminated = Number.parseInt(termination.stdout.trim() || "0", 10);
    await migration;
    if (migrationError) throw migrationError;
    if (terminated !== 1 || (migrationResult.exitCode === 0 && !migrationResult.signal)) {
      throw new Error(`controlled first migration did not fail exactly once: terminated=${terminated}, exit=${migrationResult.exitCode}, signal=${migrationResult.signal}`);
    }
    return { observed: 1, terminated, exitCode: migrationResult.exitCode, signal: migrationResult.signal };
  } finally {
    if (!settled) {
      const terminateSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='PgSleep'";
      await ctx.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", terminateSql], { allowFailure: true, timeoutMs: 5_000 });
      await migration;
    }
    await ctx.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", removeSeam], { allowFailure: true, timeoutMs: 10_000 });
  }
}

const a01 = defineCase(
  "A-01",
  "PF-F-EMPTY clean checkout",
  "Install, migrate twice, build and boot the published API, Worker and Dispatcher as independent production processes",
  "Every command is non-interactive, public health UI and OpenAPI answer, and owned process groups terminate without leakage",
  ["published commands", "production HTTP", "independent OS processes"],
  async (ctx) => {
    await ctx.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
    await ctx.migrate({ timeoutMs: 300_000 });
    await ctx.migrate({ timeoutMs: 300_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    requireStatus(ctx, await ctx.request(api.baseUrl, "/healthz"), 200, "health", { json: false });
    requireStatus(ctx, await ctx.request(api.baseUrl, "/"), 200, "production UI", { json: false, hardCapIds: ["PRODUCTION_BOOT"] });
    await openApi(ctx, api.baseUrl);
    const receiver = await ctx.receiver();
    const worker = await ctx.startWorker();
    const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    ctx.equal(new Set([api.pid, worker.pid, dispatcher.pid]).size, 3, "roles are distinct processes");
    for (const process of [dispatcher, worker, api]) await ctx.stop(process);
    ctx.ok([dispatcher, worker, api].every(({ stopped }) => stopped), "all roles stopped", { hardCapIds: ["PRODUCTION_BOOT"] });
    return caseResult(ctx, { processRoles: ["api", "worker", "dispatcher"] });
  },
);

const a02 = defineCase(
  "A-02",
  "PF-F-MIGRATION populated V1 history",
  "Create populated public V1 Application Claim Decision Permit Work Event and saved-response history, pause after the first real FINAL DDL through an evaluator-owned same-database event trigger, terminate the unique sleeping migration backend, then retry FINAL migration twice",
  "The mid-flight FINAL migration exits nonzero exactly once and leaves the complete V1 public snapshot and saved response unchanged with no partial FINAL behavior; a clean retry converges to the exact complete FINAL closure",
  ["frozen V1 workspace", "same PostgreSQL database", "failed FINAL migration", "public HTTP", "verification snapshot"],
  async (ctx) => {
    const v1 = requireV1Workspace(ctx);
    const family = ctx.fixtures.projections();
    await v1.migrate();
    await v1.seed(family.seed);
    const v1Api = await v1.startApi();
    const replayBody = ctx.fixtures.submissionBody("a02-saved-response");
    const replayKey = ctx.key("a02-saved-response");
    const saved = await v1.mutate(v1Api.baseUrl, "/api/v1/permit-applications", replayKey, replayBody);
    requireStatus(ctx, saved, 201, "saved populated V1 submit");
    const before = await snapshot(ctx, v1Api.baseUrl, { final: false });
    await ctx.stop(v1Api);

    const interrupted = await interruptPopulatedFinalMigration(ctx);
    ctx.ok(interrupted.observed === 1 && interrupted.terminated === 1 && (interrupted.exitCode !== 0 || interrupted.signal), "populated FINAL migration completes one DDL inside its uncommitted transaction and fails nonzero");
    const rollbackApi = await v1.startApi();
    const afterFailure = await snapshot(ctx, rollbackApi.baseUrl, { final: false });
    ctx.assert("failed FINAL migration exposes no partial public behavior", () => assertFailedV1MigrationRollback(before, afterFailure), { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    const failureReplay = await v1.mutate(rollbackApi.baseUrl, "/api/v1/permit-applications", replayKey, replayBody);
    ctx.assert("saved V1 response survives failed FINAL migration", () => assertSavedHttpReplay(saved, failureReplay), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    const afterFailureReplay = await snapshot(ctx, rollbackApi.baseUrl, { final: false });
    ctx.assert("failed migration replay adds no partial effect", () => assertFailedV1MigrationRollback(before, afterFailureReplay), { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    await ctx.stop(rollbackApi);

    await ctx.migrate();
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const after = await snapshot(ctx, finalApi.baseUrl);
    ctx.assert("clean retry produces exact populated FINAL closure", () => assertExactV1MigrationClosure(before, after), { hardCapIds: ["MIGRATION_COMPATIBILITY", "EVENT_ATOMICITY"] });
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/permit-applications", replayKey, replayBody);
    ctx.assert("saved response survives failed and retried migration", () => assertSavedHttpReplay(saved, replay), { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    const afterReplay = await snapshot(ctx, finalApi.baseUrl);
    ctx.assert("FINAL replay keeps exact migration closure", () => assertExactV1MigrationClosure(before, afterReplay), { hardCapIds: ["MIGRATION_COMPATIBILITY", "EVENT_ATOMICITY"] });
    return caseResult(ctx, { applications: before.resources.permitApplications.length, failedCheckpointApplications: afterFailure.resources.permitApplications.length, terminatedDatabaseSessions: interrupted.terminated });
  },
);

const a03 = defineCase(
  "A-03",
  "PF-F-V1-POLICY legal seed and defect matrix",
  "Import a legal seed, replay its exact version and digest, then inject every published unknown duplicate reference revision policy claim decision state time digest and version defect",
  "Legal replay is a no-op while every invalid import exits nonzero and preserves resources, Work, Events and idempotency state",
  ["db:seed", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.main("a03");
    const { api } = await boot(ctx, { family });
    const before = await snapshot(ctx, api.baseUrl);
    await ctx.seed(family.seed);
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(before), "same version and digest no-op");
    const conflict = structuredClone(family.seed);
    conflict.applicants[0].name = "changed digest";
    const versionConflict = await ctx.seed(conflict, { allowFailure: true });
    ctx.ok(versionConflict.exitCode !== 0, "same version different digest fails");
    for (const { label, seed } of ctx.fixtures.invalidSeeds(family.seed)) {
      const result = await ctx.seed(seed, { allowFailure: true });
      ctx.ok(result.exitCode !== 0, `${label} seed fails`);
      ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(before), `${label} atomic rollback`);
    }
    return caseResult(ctx, { invalidVariants: ctx.fixtures.invalidSeeds(family.seed).length });
  },
);

const a04 = defineCase(
  "A-04",
  "PF-F-EMPTY public error matrix",
  "Run the common media, JSON and unknown-field failures through every mutation family, then cover each public read family with bad UUID, enum, range, cursor, authorization and missing-resource traffic",
  "Every route-specific failure uses the published status and exact error envelope, and every rejected mutation is independently proven to leave the full point-in-time state unchanged",
  ["public HTTP", "authorization", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.projections();
    const { api } = await boot(ctx, { family });
    const submitted = family.histories.find(({ application }) => application.state === "SUBMITTED");
    const approved = family.histories.find(({ application }) => application.state === "APPROVED");
    const changes = family.histories.find(({ application }) => application.state === "CHANGES_REQUIRED");
    const missingId = ctx.uuid("a04-missing");
    const rawPost = (path, label, raw, contentType = "application/json") => ctx.request(api.baseUrl, path, {
      method: "POST",
      headers: { "content-type": contentType, "idempotency-key": ctx.key(label) },
      raw,
    });
    const keyedPost = (path, body, idempotencyKey) => ctx.request(api.baseUrl, path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      raw: JSON.stringify(body),
    });
    const rejected = [];
    const rejectMutation = async (label, request, status, code) => {
      const before = stableSnapshot(await snapshot(ctx, api.baseUrl));
      const response = expectError(ctx, await request(), status, code);
      ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), before, `${label} rejected mutation zero side effect`);
      rejected.push({ label, status, code });
      return response;
    };

    const submitPath = "/api/v1/permit-applications";
    const submit = ctx.fixtures.submissionBody("a04-submit");
    for (const [label, key] of [["missing", undefined], ["empty", ""], ["too-long", "x".repeat(129)]]) {
      await rejectMutation(`submit idempotency ${label}`, () => keyedPost(submitPath, submit, key), 400, "INVALID_REQUEST");
    }
    await rejectMutation("submit media", () => rawPost(submitPath, "a04-submit-media", "{}", "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
    await rejectMutation("submit malformed", () => rawPost(submitPath, "a04-submit-json", "{"), 400, "MALFORMED_JSON");
    await rejectMutation("submit unknown", () => ctx.mutate(api.baseUrl, submitPath, ctx.key("a04-submit-unknown"), { ...submit, unknown: true }), 400, "UNKNOWN_FIELD");
    await rejectMutation("submit range", () => ctx.mutate(api.baseUrl, submitPath, ctx.key("a04-submit-range"), { ...submit, deadlineAt: ctx.at({ days: 31 }) }), 400, "INVALID_REQUEST");
    await rejectMutation("submit policy", () => ctx.mutate(api.baseUrl, submitPath, ctx.key("a04-submit-policy"), { ...submit, reviewPolicy: { roles: [], requiredTotalApprovals: 1 } }), 400, "INVALID_REVIEW_POLICY");

    const claimPath = `/api/v1/permit-applications/${submitted.application.applicationId}/review-claims`;
    const claimBody = { reviewerId: family.securityReviewers[0].reviewerId, role: "security" };
    for (const [label, key] of [["missing", undefined], ["empty", ""], ["too-long", "x".repeat(129)]]) {
      await rejectMutation(`claim idempotency ${label}`, () => keyedPost(claimPath, claimBody, key), 400, "INVALID_REQUEST");
    }
    await rejectMutation("claim media", () => rawPost(claimPath, "a04-claim-media", "{}", "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
    await rejectMutation("claim malformed", () => rawPost(claimPath, "a04-claim-json", "{"), 400, "MALFORMED_JSON");
    await rejectMutation("claim unknown", () => ctx.mutate(api.baseUrl, claimPath, ctx.key("a04-claim-unknown"), { ...claimBody, unknown: true }), 400, "UNKNOWN_FIELD");
    await rejectMutation("claim bad UUID", () => ctx.mutate(api.baseUrl, "/api/v1/permit-applications/not-a-uuid/review-claims", ctx.key("a04-claim-uuid"), claimBody), 400, "INVALID_REQUEST");
    await rejectMutation("claim unavailable", () => ctx.mutate(api.baseUrl, claimPath, ctx.key("a04-claim-unavailable"), { reviewerId: ctx.uuid("a04-ineligible"), role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    await rejectMutation("claim missing", () => ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${missingId}/review-claims`, ctx.key("a04-claim-missing"), claimBody), 404, "NOT_FOUND");
    await rejectMutation("claim terminal", () => ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${approved.application.applicationId}/review-claims`, ctx.key("a04-claim-terminal"), { reviewerId: family.securityReviewers[2].reviewerId, role: "security" }), 409, "APPLICATION_TERMINAL");

    const decisionPath = `/api/v1/review-claims/${approved.claims[0].claimId}/decisions`;
    const decisionBody = { claimToken: "syntactically-valid-unpublished-token", decision: "APPROVE", reason: "validation matrix" };
    for (const [label, key] of [["missing", undefined], ["empty", ""], ["too-long", "x".repeat(129)]]) {
      await rejectMutation(`decision idempotency ${label}`, () => keyedPost(decisionPath, decisionBody, key), 400, "INVALID_REQUEST");
    }
    await rejectMutation("decision media", () => rawPost(decisionPath, "a04-decision-media", "{}", "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
    await rejectMutation("decision malformed", () => rawPost(decisionPath, "a04-decision-json", "{"), 400, "MALFORMED_JSON");
    await rejectMutation("decision unknown", () => ctx.mutate(api.baseUrl, decisionPath, ctx.key("a04-decision-unknown"), { ...decisionBody, unknown: true }), 400, "UNKNOWN_FIELD");
    await rejectMutation("decision missing claimToken", () => ctx.mutate(api.baseUrl, decisionPath, ctx.key("a04-decision-token-missing"), { decision: "APPROVE", reason: "validation matrix" }), 400, "INVALID_REQUEST");
    await rejectMutation("decision non-string claimToken", () => ctx.mutate(api.baseUrl, decisionPath, ctx.key("a04-decision-token-shape"), { ...decisionBody, claimToken: 7 }), 400, "INVALID_REQUEST");
    await rejectMutation("decision bad UUID", () => ctx.mutate(api.baseUrl, "/api/v1/review-claims/not-a-uuid/decisions", ctx.key("a04-decision-uuid"), decisionBody), 400, "INVALID_REQUEST");
    await rejectMutation("decision enum", () => ctx.mutate(api.baseUrl, decisionPath, ctx.key("a04-decision-enum"), { ...decisionBody, decision: "MAYBE" }), 400, "INVALID_REQUEST");
    await rejectMutation("decision missing", () => ctx.mutate(api.baseUrl, `/api/v1/review-claims/${missingId}/decisions`, ctx.key("a04-decision-missing"), decisionBody), 404, "NOT_FOUND");

    const revisionPath = `/api/v1/permit-applications/${changes.application.applicationId}/revisions`;
    const revisionBody = { expectedRevision: 1, fields: { corrected: true }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy };
    for (const [label, key] of [["missing", undefined], ["empty", ""], ["too-long", "x".repeat(129)]]) {
      await rejectMutation(`revision idempotency ${label}`, () => keyedPost(revisionPath, revisionBody, key), 400, "INVALID_REQUEST");
    }
    await rejectMutation("revision media", () => rawPost(revisionPath, "a04-revision-media", "{}", "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
    await rejectMutation("revision malformed", () => rawPost(revisionPath, "a04-revision-json", "{"), 400, "MALFORMED_JSON");
    await rejectMutation("revision unknown", () => ctx.mutate(api.baseUrl, revisionPath, ctx.key("a04-revision-unknown"), { ...revisionBody, unknown: true }), 400, "UNKNOWN_FIELD");
    await rejectMutation("revision bad UUID", () => ctx.mutate(api.baseUrl, "/api/v1/permit-applications/not-a-uuid/revisions", ctx.key("a04-revision-uuid"), revisionBody), 400, "INVALID_REQUEST");
    await rejectMutation("revision range", () => ctx.mutate(api.baseUrl, revisionPath, ctx.key("a04-revision-range"), { ...revisionBody, expectedRevision: 0 }), 400, "INVALID_REQUEST");
    await rejectMutation("revision missing", () => ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${missingId}/revisions`, ctx.key("a04-revision-missing"), revisionBody), 404, "NOT_FOUND");
    await rejectMutation("revision terminal", () => ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${approved.application.applicationId}/revisions`, ctx.key("a04-revision-terminal"), revisionBody), 409, "APPLICATION_TERMINAL");

    const reads = [
      ["list range", "/api/v1/permitApplications?limit=0", 400, "INVALID_REQUEST"],
      ["list cursor", "/api/v1/permitApplications?cursor=not-opaque", 400, "INVALID_CURSOR"],
      ["camel detail UUID", "/api/v1/permitApplications/not-a-uuid", 400, "INVALID_REQUEST"],
      ["camel detail missing", `/api/v1/permitApplications/${missingId}`, 404, "NOT_FOUND"],
      ["aggregate detail UUID", "/api/v1/permit-applications/not-a-uuid", 400, "INVALID_REQUEST"],
      ["aggregate detail missing", `/api/v1/permit-applications/${missingId}`, 404, "NOT_FOUND"],
      ["revision read UUID", "/api/v1/permit-applications/not-a-uuid/revisions/1", 400, "INVALID_REQUEST"],
      ["revision read range", `/api/v1/permit-applications/${submitted.application.applicationId}/revisions/0`, 400, "INVALID_REQUEST"],
      ["revision read missing", `/api/v1/permit-applications/${missingId}/revisions/1`, 404, "NOT_FOUND"],
      ["stages UUID", "/api/v1/permit-applications/not-a-uuid/stages", 400, "INVALID_REQUEST"],
      ["stages missing", `/api/v1/permit-applications/${missingId}/stages`, 404, "NOT_FOUND"],
      ["events UUID", "/api/v1/domain-events?aggregateId=not-a-uuid&afterSequence=0&limit=1", 400, "INVALID_REQUEST"],
      ["events sequence", `/api/v1/domain-events?aggregateId=${submitted.application.applicationId}&afterSequence=-1&limit=1`, 400, "INVALID_REQUEST"],
      ["events range", `/api/v1/domain-events?aggregateId=${submitted.application.applicationId}&afterSequence=0&limit=0`, 400, "INVALID_REQUEST"],
      ["snapshot authorization", "/api/v1/verification-snapshot", 401, "ADMIN_AUTH_REQUIRED"],
    ];
    const stateBeforeReads = stableSnapshot(await snapshot(ctx, api.baseUrl));
    for (const [label, path, status, code] of reads) {
      const options = label === "snapshot authorization" ? { headers: { authorization: "Bearer wrong" } } : {};
      expectError(ctx, await ctx.request(api.baseUrl, path, options), status, code);
    }
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stateBeforeReads, "read error matrix changes no state");
    return caseResult(ctx, { rejectedMutations: rejected.length, rejectedReads: reads.length, mutationFamilies: ["submit", "claim", "decision", "revision"] });
  },
);

const a05 = defineCase(
  "A-05",
  "PF-F-V1-POLICY 121 Application page",
  "Read default, one-item and one-hundred-item pages to exhaustion, reject a malformed cursor, and cross-check current detail Revision history and snapshot",
  "Pages are exact stable and gapless with no duplicates, while all public reads share the same current Revision and recursively token-free authority",
  ["collection HTTP", "detail HTTP", "revision HTTP", "verification snapshot"],
  async (ctx) => {
    const paged = ctx.fixtures.pagination(118);
    const approved = ctx.fixtures.history("a05-approved", "APPROVED");
    const changes = ctx.fixtures.history("a05-changes", "CHANGES_REQUIRED");
    const reachable = ctx.fixtures.history("a05-reachable", "REACHABLE");
    const histories = [...paged.histories, approved, changes, reachable];
    const family = { ...paged, histories, seed: ctx.fixtures.seedFromHistories("a05-pagination", histories) };
    const { api } = await boot(ctx, { family });
    await createRevision(ctx, api.baseUrl, changes.application.applicationId, { expectedRevision: 1, fields: { page: "revision-2" }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: ctx.fixtures.policy }, "a05-revision-2");
    const first = await ctx.request(api.baseUrl, "/api/v1/permitApplications");
    requireStatus(ctx, first, 200, "default page");
    ctx.equal(Object.keys(first.json).sort(), ["items", "nextCursor"], "default collection exact envelope");
    ctx.equal(first.json.items.length, 50, "default limit 50");
    const one = await ctx.request(api.baseUrl, "/api/v1/permitApplications?limit=1");
    requireStatus(ctx, one, 200, "limit 1");
    ctx.equal(Object.keys(one.json).sort(), ["items", "nextCursor"], "one-item collection exact envelope");
    ctx.equal(one.json.items.length, 1, "limit 1 honored");
    const all = [];
    let cursor;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await ctx.request(api.baseUrl, `/api/v1/permitApplications?${query}`);
      requireStatus(ctx, page, 200, "Application page");
      ctx.equal(Object.keys(page.json).sort(), ["items", "nextCursor"], "Application page exact envelope");
      all.push(...page.json.items);
      cursor = page.json.nextCursor;
    } while (cursor);
    ctx.equal(all.length, 121, "all Applications paged");
    ctx.equal(new Set(all.map(({ applicationId }) => applicationId)).size, 121, "no duplicate Applications");
    ctx.equal(all.map(({ applicationId }) => applicationId), [...all.map(({ applicationId }) => applicationId)].sort(), "Application order");
    all.forEach((application) => ctx.assert("exact list Application", () => assertPermitApplication(application, { final: true })));
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/permitApplications?cursor=broken"), 400, "INVALID_CURSOR");
    const target = all.find(({ applicationId }) => applicationId === changes.application.applicationId);
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(all, state.resources.permitApplications, "collection is exact snapshot Application population");
    ctx.equal(applicationFrom(state, target.applicationId), target, "snapshot and page authority");
    const current = await applicationCurrent(ctx, api.baseUrl, target.applicationId);
    ctx.assert("camel current Application exact shape", () => assertPermitApplication(current.json, { final: true }));
    ctx.equal(current.json, applicationFrom(state, target.applicationId), "camel current Application equals snapshot");
    const detail = await applicationDetail(ctx, api.baseUrl, target.applicationId);
    ctx.assert("replacement aggregate detail exact authority", () => assertAggregateDetailAuthority(detail.json, state, target.applicationId));
    const firstRevision = await revisionDetail(ctx, api.baseUrl, target.applicationId, 1);
    const secondRevision = await revisionDetail(ctx, api.baseUrl, target.applicationId, 2);
    ctx.equal(firstRevision.revision, revisionsFor(state, target.applicationId)[0], "Revision 1 read equals snapshot");
    ctx.equal(secondRevision.revision, revisionsFor(state, target.applicationId)[1], "Revision 2 read equals snapshot");
    ctx.equal(revisionsFor(state, target.applicationId).length, 2, "multiple immutable Revisions readable");
    const approvedCurrent = await applicationCurrent(ctx, api.baseUrl, approved.application.applicationId);
    ctx.equal(approvedCurrent.json, applicationFrom(state, approved.application.applicationId), "approved current Application equals snapshot");
    const approvedDetail = await applicationDetail(ctx, api.baseUrl, approved.application.applicationId);
    const approvedAuthority = ctx.assert("approved detail closes Revision Claims Decisions and Permit", () => assertAggregateDetailAuthority(approvedDetail.json, state, approved.application.applicationId));
    ctx.equal(approvedAuthority.claims.length, approved.claims.length, "all approved Claims exposed exactly");
    ctx.equal(approvedAuthority.decisions.length, approved.decisions.length, "all approved Decisions exposed exactly");
    ctx.equal(approvedAuthority.permit, approved.permits[0], "approved Permit exposed exactly");
    assertExternalSecretBoundary({ pages: [first.json, one.json, all], details: [detail.json, approvedDetail.json], snapshot: state }, ctx);
    return caseResult(ctx, { applications: all.length, target: target.applicationId, approvedClaims: approvedAuthority.claims.length, approvedDecisions: approvedAuthority.decisions.length, permitId: approvedAuthority.permit.permitId });
  },
);

const a06 = defineCase(
  "A-06",
  "PF-F-V1-POLICY submission boundaries",
  "Submit canonical key-order variants, one-role and ten-role policies and an exact 64 KiB field document, then reject expired, over-30-day and invalid-policy requests",
  "Each accepted mutation atomically creates one SUBMITTED Application, immutable Revision 1, independent digest, Deadline Work and submitted Event; every invalid request has zero effect",
  ["Application HTTP", "verification snapshot", "independent RFC8785 oracle"],
  async (ctx) => {
    const family = ctx.fixtures.main("a06");
    const seed = { ...family.seed, permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [] };
    const { api } = await boot(ctx, { family, seed });
    const fields = { alpha: 1, nested: { a: true, z: false }, omega: "same" };
    const left = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a06-left", { fields }), "a06-left");
    const reordered = { omega: "same", nested: { z: false, a: true }, alpha: 1 };
    const right = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a06-right", { fields: reordered }), "a06-right");
    ctx.equal(left.revision.canonicalDigest, right.revision.canonicalDigest, "semantic key order digest");
    ctx.equal(left.revision.canonicalDigest, sha256(canonicalJson(fields)), "independent RFC8785 digest");
    const roles10 = Array.from({ length: 10 }, (_, index) => ({ role: `role-${String(index).padStart(2, "0")}`, eligibleReviewerIds: [family.reviewers[index % family.reviewers.length].reviewerId], requiredApprovals: 1, veto: false }));
    const one = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a06-one", { reviewPolicy: family.strictLegalPolicy }), "a06-one");
    const ten = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a06-ten", { reviewPolicy: { roles: roles10, requiredTotalApprovals: 10 } }), "a06-ten");
    const shellBytes = Buffer.byteLength(canonicalJson({ payload: "" }));
    const boundaryFields = { payload: "x".repeat(64 * 1024 - shellBytes) };
    ctx.equal(Buffer.byteLength(canonicalJson(boundaryFields)), 64 * 1024, "exact 64KiB fields fixture");
    const boundary = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a06-64k", { fields: boundaryFields }), "a06-64k");
    const before = await snapshot(ctx, api.baseUrl);
    const invalid = [
      ["past", { deadlineAt: "2000-01-01T00:00:00.000Z" }],
      ["future", { deadlineAt: ctx.at({ days: 31 }) }],
      ["policy", { reviewPolicy: { roles: [{ ...family.policy.roles[0], requiredApprovals: 99 }], requiredTotalApprovals: 1 } }],
    ];
    for (const [label, override] of invalid) expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/permit-applications", ctx.key(`a06-${label}`), ctx.fixtures.submissionBody(`a06-${label}`, override)), 400, label === "policy" ? "INVALID_REVIEW_POLICY" : "INVALID_REQUEST");
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(before), "invalid boundaries atomic");
    const createdIds = [left, right, one, ten, boundary].map(({ application }) => application.applicationId);
    for (const applicationId of createdIds) {
      ctx.equal(applicationFrom(before, applicationId).state, "SUBMITTED", `${applicationId} SUBMITTED`);
      ctx.equal(before.work.filter(({ aggregateId }) => aggregateId === applicationId).length, 1, `${applicationId} one Deadline Work`);
      ctx.equal(before.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.submitted").length, 1, `${applicationId} one submitted Event`, { hardCapIds: ["EVENT_ATOMICITY"] });
    }
    return caseResult(ctx, { submitted: createdIds.length, digest: left.revision.canonicalDigest });
  },
);

const a07 = defineCase(
  "A-07",
  "PF-F-CLAIMS eligibility and lease",
  "Claim an eligible current role, reject duplicate reviewer, wrong role, ineligible reviewer and exhausted slots, then reclaim after the published lease expires",
  "The public ReviewClaim tuple is exact, lease duration and attempt advance durably, invalid claims use REVIEW_SLOT_UNAVAILABLE, and no token enters snapshot or logs",
  ["Review Claim HTTP", "database-backed lease", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.main("a07");
    const { api } = await boot(ctx, { family });
    const applicationId = family.application.applicationId;
    const firstReviewer = family.securityReviewers[0];
    const first = await claimReview(ctx, api.baseUrl, applicationId, { reviewerId: firstReviewer.reviewerId, role: "security" }, "a07-first");
    ctx.equal(first.response.json, first.claim, "Claim success is the exact top-level ReviewClaim");
    ctx.assert("first Claim captured tuple", () => assertClaimTuple(first.claim, {
      applicationId,
      revision: 1,
      reviewerId: firstReviewer.reviewerId,
      role: "security",
      state: "LEASED",
      attempt: 1,
    }));
    const leaseRemainingMs = Date.parse(first.claim.leaseExpiresAt) - Date.now();
    ctx.ok(leaseRemainingMs > 0 && leaseRemainingMs <= 3_500, "Claim uses published three-second lease");
    const firstState = await snapshot(ctx, api.baseUrl);
    ctx.equal(firstState.resources.reviewClaims.find(({ claimId }) => claimId === first.claim.claimId), first.claim, "first Claim response tuple equals snapshot");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("a07-duplicate"), { reviewerId: firstReviewer.reviewerId, role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("a07-role"), { reviewerId: family.legalReviewers[0].reviewerId, role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("a07-ineligible"), { reviewerId: ctx.uuid("ineligible"), role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    await claimReview(ctx, api.baseUrl, applicationId, { reviewerId: family.securityReviewers[1].reviewerId, role: "security" }, "a07-second");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("a07-full"), { reviewerId: family.securityReviewers[2].reviewerId, role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    await ctx.sleep(3_300);
    const reclaimed = await claimReview(ctx, api.baseUrl, applicationId, { reviewerId: firstReviewer.reviewerId, role: "security" }, "a07-reclaim");
    ctx.equal(reclaimed.response.json, reclaimed.claim, "reclaim success is the exact top-level ReviewClaim");
    ctx.equal(reclaimed.claim.claimId, first.claim.claimId, "reclaim preserves Claim identity");
    ctx.equal(reclaimed.claim.attempt, first.claim.attempt + 1, "reclaim increments attempt");
    ctx.assert("reclaimed Claim captured tuple", () => assertClaimTuple(reclaimed.claim, {
      claimId: first.claim.claimId,
      applicationId,
      revision: first.claim.revision,
      reviewerId: firstReviewer.reviewerId,
      role: "security",
      state: "LEASED",
      attempt: first.claim.attempt + 1,
    }));
    const state = await snapshot(ctx, api.baseUrl);
    const durable = state.resources.reviewClaims.find(({ claimId }) => claimId === first.claim.claimId);
    ctx.assert("Claim public shape", () => assertReviewClaim(durable));
    ctx.equal(durable, reclaimed.claim, "reclaimed Claim tuple equals snapshot exactly");
    assertExternalSecretBoundary({ response: first.response.json, snapshot: state, logs: api.logs }, ctx);
    return caseResult(ctx, { claimId: first.claim.claimId, attempt: reclaimed.claim.attempt });
  },
  [blocked("PF-A07-CLAIM-TOKEN-WIRE", "PF-GAP-01")],
);

const a08 = defineCase(
  "A-08",
  "PF-F-DECISIONS seeded quorum histories",
  "Read exact seeded approved, under-review and changes histories through detail, Revision and point-in-time snapshot surfaces",
  "The independent role-quota and total-threshold oracle permits exactly one Permit only for a fully satisfied no-veto history",
  ["public seed", "Application detail", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.projections();
    const { api } = await boot(ctx, { family });
    const state = await snapshot(ctx, api.baseUrl);
    for (const { application } of family.histories.filter(({ application: item }) => ["APPROVED", "UNDER_REVIEW", "CHANGES_REQUIRED", "SUBMITTED"].includes(item.state))) {
      await applicationDetail(ctx, api.baseUrl, application.applicationId);
      const current = applicationFrom(state, application.applicationId);
      const revision = revisionsFor(state, application.applicationId)[0];
      ctx.assert(`${application.applicationId} quorum projection`, () => assertProjection(current, revision, decisionsFor(state, application.applicationId), permitFor(state, application.applicationId)), { hardCapIds: ["REVIEW_AUTHORITY"] });
    }
    return caseResult(ctx, { projectedApplications: family.histories.length });
  },
  [blocked("PF-A08-LIVE-DECISION", "PF-GAP-01")],
);

const a09 = defineCase(
  "A-09",
  "PF-F-DECISIONS veto and impossible quorum histories",
  "Read seeded veto REJECT, still-reachable non-veto REJECT and impossible-quorum histories and independently recompute their state",
  "Veto and impossible histories are REJECTED, a still-reachable history remains UNDER_REVIEW, and no rejected history exposes a Permit",
  ["public seed", "Application detail", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.projections();
    const { api } = await boot(ctx, { family });
    const state = await snapshot(ctx, api.baseUrl);
    for (const item of family.histories.filter(({ application }) => ["REJECTED", "UNDER_REVIEW"].includes(application.state))) {
      const application = applicationFrom(state, item.application.applicationId);
      ctx.assert(`${application.applicationId} reject projection`, () => assertProjection(application, revisionsFor(state, application.applicationId)[0], decisionsFor(state, application.applicationId), permitFor(state, application.applicationId)), { hardCapIds: ["REVIEW_AUTHORITY"] });
    }
    ctx.equal(state.resources.approvedPermits.filter(({ applicationId }) => family.histories.filter(({ application }) => application.state === "REJECTED").some((item) => item.application.applicationId === applicationId)).length, 0, "rejected histories have no Permit");
    return caseResult(ctx, { rejectionHistories: 3 });
  },
  [blocked("PF-A09-LIVE-DECISION", "PF-GAP-01")],
);

const a10 = defineCase(
  "A-10",
  "PF-F-DECISIONS CHANGES_REQUIRED history",
  "Create Revision 2 from an immutable CHANGES_REQUIRED Revision 1, then submit stale and skipped expectedRevision requests",
  "Exactly one contiguous replacement captures new fields, policy and deadline while Revision 1 remains immutable and conflicts have zero effect",
  ["Revision HTTP", "verification snapshot", "independent digest oracle"],
  async (ctx) => {
    const family = ctx.fixtures.changes("a10");
    const { api } = await boot(ctx, { family });
    const applicationId = family.application.applicationId;
    const before = await snapshot(ctx, api.baseUrl);
    const original = structuredClone(revisionsFor(before, applicationId)[0]);
    const fields = { revision: 2, changed: true };
    const deadlineAt = ctx.at({ days: 3 });
    const created = await createRevision(ctx, api.baseUrl, applicationId, { expectedRevision: 1, fields, deadlineAt, reviewPolicy: family.strictLegalPolicy }, "a10-revision-2");
    const after = await snapshot(ctx, api.baseUrl);
    ctx.equal(revisionsFor(after, applicationId)[0], original, "Revision 1 immutable", { hardCapIds: ["REVIEW_AUTHORITY"] });
    const history = revisionsFor(after, applicationId);
    ctx.assert("contiguous replacement history", () => assertRevisionHistory(history));
    const revision2 = history[1];
    ctx.equal(created.response.json, created.revision, "replacement success is exact top-level Revision");
    ctx.equal(created.revision, revision2, "replacement response equals snapshot Revision 2");
    ctx.equal(revision2.revision, 2, "Revision 2 is exactly previous +1");
    ctx.equal(revision2.fields, fields, "Revision 2 captures exact fields");
    ctx.equal(revision2.policy, family.strictLegalPolicy, "Revision 2 captures exact policy");
    ctx.equal(revision2.canonicalDigest, sha256(canonicalJson(fields)), "Revision 2 digest");
    const currentApplication = applicationFrom(after, applicationId);
    ctx.equal(currentApplication.currentRevision, 2, "Revision 2 current");
    ctx.equal(currentApplication.deadlineAt, deadlineAt, "replacement captures exact deadline on Application");
    const read = await revisionDetail(ctx, api.baseUrl, applicationId, 2);
    ctx.equal(read.revision, revision2, "Revision 2 immutable read equals snapshot");
    const detail = await applicationDetail(ctx, api.baseUrl, applicationId);
    const authority = ctx.assert("replacement aggregate detail closes exact authority", () => assertAggregateDetailAuthority(detail.json, after, applicationId));
    ctx.equal(authority.revision.fields, fields, "detail current Revision fields exact");
    ctx.equal(authority.revision.policy, family.strictLegalPolicy, "detail current policy exact");
    ctx.equal(authority.application.deadlineAt, deadlineAt, "detail deadline exact");
    for (const [label, expectedRevision] of [["stale", 1], ["skip", 3]]) expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/revisions`, ctx.key(`a10-${label}`), { expectedRevision, fields: { invalid: label }, deadlineAt: ctx.at({ days: 4 }), reviewPolicy: family.policy }), 409, "APPLICATION_REVISION_CHANGED");
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(after), "replacement conflicts zero effect");
    return caseResult(ctx, { applicationId, revisions: history.length });
  },
  [blocked("PF-A10-STALE-CLAIM-DECISION", "PF-GAP-01")],
);

const a11 = defineCase(
  "A-11",
  "PF-F-WORK-EVENT due and terminal Applications",
  "Run two independent Workers across a due undecided Application and an already approved Application",
  "Only the undecided current Revision expires once, no Permit is invented, terminal authority is unchanged and every Deadline Work safely terminalizes",
  ["public seed", "Worker processes", "verification snapshot"],
  async (ctx) => {
    const due = ctx.fixtures.history("a11-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const dueReview = ctx.fixtures.history("a11-review", "REACHABLE", { deadlineAt: ctx.at({ days: -2 }) });
    const approved = ctx.fixtures.history("a11-approved", "APPROVED", { deadlineAt: ctx.at({ days: -2 }) });
    const family = { ...ctx.fixtures.main("a11"), seed: ctx.fixtures.seedFromHistories("a11", [due, dueReview, approved]) };
    const { api } = await boot(ctx, { family });
    const before = await snapshot(ctx, api.baseUrl);
    const byAggregate = (state, applicationId) => state.work.filter(({ aggregateId, kind }) => aggregateId === applicationId && kind === "PERMIT_DEADLINE");
    const dueBefore = byAggregate(before, due.application.applicationId);
    const reviewBefore = byAggregate(before, dueReview.application.applicationId);
    const terminalBefore = byAggregate(before, approved.application.applicationId);
    ctx.equal(dueBefore.length, 1, "due SUBMITTED has one non-vacuous Deadline Work");
    ctx.equal(reviewBefore.length, 1, "due UNDER_REVIEW has one non-vacuous Deadline Work");
    ctx.equal(terminalBefore.length, 1, "terminal Application retains one Deadline Work");
    ctx.ok(!dueBefore[0].terminal && !reviewBefore[0].terminal, "undecided due Work begins nonterminal");
    ctx.ok(terminalBefore[0].terminal, "already terminal Work begins terminal");
    const approvedBefore = {
      application: applicationFrom(before, approved.application.applicationId),
      decisions: decisionsFor(before, approved.application.applicationId),
      permit: permitFor(before, approved.application.applicationId),
      work: terminalBefore[0],
      events: before.events.filter(({ aggregateId }) => aggregateId === approved.application.applicationId),
    };
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const after = await waitSnapshot(ctx, api.baseUrl, (value) => [due, dueReview].every((item) => applicationFrom(value, item.application.applicationId)?.state === "EXPIRED" && byAggregate(value, item.application.applicationId).length === 1 && byAggregate(value, item.application.applicationId)[0].terminal) ? value : undefined, { label: "due Application expiry", processes: workers });
    const approvedAfter = {
      application: applicationFrom(after, approved.application.applicationId),
      decisions: decisionsFor(after, approved.application.applicationId),
      permit: permitFor(after, approved.application.applicationId),
      work: byAggregate(after, approved.application.applicationId)[0],
      events: after.events.filter(({ aggregateId }) => aggregateId === approved.application.applicationId),
    };
    ctx.equal(approvedAfter, approvedBefore, "completed quorum Application, Permit, Work and Event authority unchanged");
    ctx.equal(permitFor(after, due.application.applicationId), undefined, "expired Application no Permit");
    ctx.equal(permitFor(after, dueReview.application.applicationId), undefined, "expired in-review Application no Permit");
    for (const item of [due, dueReview]) {
      const applicationId = item.application.applicationId;
      const work = byAggregate(after, applicationId);
      ctx.equal(work.length, 1, `${applicationId} retains exactly one Deadline Work`);
      ctx.ok(work[0].terminal && work[0].state === "SUCCEEDED", `${applicationId} Deadline Work safely succeeds`);
      ctx.equal(work[0].workId, byAggregate(before, applicationId)[0].workId, `${applicationId} Work identity retained`);
      ctx.equal(after.events.filter(({ aggregateId, type }) => aggregateId === applicationId && type === "application.expired").length, 1, `${applicationId} one expiry Event`, { hardCapIds: ["EVENT_ATOMICITY"] });
      ctx.equal(applicationFrom(after, applicationId).decisionRevision, null, `${applicationId} expiry invents no decision winner`);
    }
    return caseResult(ctx, { expired: [due.application.applicationId, dueReview.application.applicationId], terminalWinner: approved.application.applicationId });
  },
);

export function assertEventDelta(beforeEvents, afterEvents, applicationId, expectedTypes) {
  const before = beforeEvents.filter(({ aggregateId }) => aggregateId === applicationId);
  const after = afterEvents.filter(({ aggregateId }) => aggregateId === applicationId);
  assert.deepEqual(after.slice(0, before.length), before, `${applicationId} prior Event prefix immutable`);
  const added = after.slice(before.length);
  assert.deepEqual(added.map(({ type }) => type), expectedTypes, `${applicationId} transition Event types`);
  assertAggregateSequences(after);
  assert.ok(added.every(({ aggregateId, payload }) => aggregateId === applicationId && canonicalJson(payload) === "{}"), `${applicationId} added Event identity and payload`);
  return true;
}

const a12 = defineCase(
  "A-12",
  "PF-F-WORK-EVENT public mutation histories",
  "Create submit and claim transitions, create a replacement Revision from seeded CHANGES_REQUIRED history, expire a due Application and paginate aggregate Events",
  "Every committed transition has one gapless published empty-payload Event, rollback emits none and afterSequence pagination preserves stable order",
  ["public mutation HTTP", "Domain Event HTTP", "Worker", "verification snapshot"],
  async (ctx) => {
    const changes = ctx.fixtures.history("a12-changes", "CHANGES_REQUIRED");
    const due = ctx.fixtures.history("a12-due", "SUBMITTED", { deadlineAt: ctx.at({ days: -2 }) });
    const base = ctx.fixtures.main("a12");
    const family = { ...base, seed: ctx.fixtures.seedFromHistories("a12", [changes, due]) };
    const { api } = await boot(ctx, { family });
    const initial = await snapshot(ctx, api.baseUrl);
    const submitted = await submitApplication(ctx, api.baseUrl, ctx.fixtures.submissionBody("a12-new"), "a12-submit");
    const afterSubmit = await snapshot(ctx, api.baseUrl);
    ctx.assert("submit commits exactly application.submitted", () => assertEventDelta(initial.events, afterSubmit.events, submitted.application.applicationId, ["application.submitted"]), { hardCapIds: ["EVENT_ATOMICITY"] });
    await claimReview(ctx, api.baseUrl, submitted.application.applicationId, { reviewerId: family.securityReviewers[0].reviewerId, role: "security" }, "a12-claim");
    const afterClaim = await snapshot(ctx, api.baseUrl);
    ctx.assert("claim commits exactly review.claimed", () => assertEventDelta(afterSubmit.events, afterClaim.events, submitted.application.applicationId, ["review.claimed"]), { hardCapIds: ["EVENT_ATOMICITY"] });
    const beforeInvalid = afterClaim;
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${submitted.application.applicationId}/review-claims`, ctx.key("a12-invalid"), { reviewerId: ctx.uuid("invalid"), role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(beforeInvalid), "rollback emits no Event");
    await createRevision(ctx, api.baseUrl, changes.application.applicationId, { expectedRevision: 1, fields: { revised: true }, deadlineAt: ctx.at({ days: 3 }), reviewPolicy: family.policy }, "a12-revision");
    const afterRevision = await snapshot(ctx, api.baseUrl);
    ctx.assert("replacement commits exactly application.submitted", () => assertEventDelta(beforeInvalid.events, afterRevision.events, changes.application.applicationId, ["application.submitted"]), { hardCapIds: ["EVENT_ATOMICITY", "REVIEW_AUTHORITY"] });
    const worker = await ctx.startWorker();
    const final = await waitSnapshot(ctx, api.baseUrl, (value) => applicationFrom(value, due.application.applicationId)?.state === "EXPIRED" ? value : undefined, { label: "event expiry", processes: [worker] });
    ctx.assert("deadline commits exactly application.expired", () => assertEventDelta(afterRevision.events, final.events, due.application.applicationId, ["application.expired"]), { hardCapIds: ["EVENT_ATOMICITY"] });
    for (const applicationId of [submitted.application.applicationId, changes.application.applicationId, due.application.applicationId]) {
      const expected = final.events.filter(({ aggregateId }) => aggregateId === applicationId);
      ctx.ok(expected.length > 0, `${applicationId} has non-vacuous committed Event history`);
      const paged = [];
      let afterSequence = 0;
      while (paged.length < expected.length) {
        const page = await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: String(afterSequence), limit: "1" });
        ctx.equal(page.items.length, 1, `${applicationId} small page honors limit 1`);
        const event = page.items[0];
        ctx.equal(event, expected[paged.length], `${applicationId} page ${paged.length + 1} equals snapshot Event`);
        ctx.equal(event.sequence, afterSequence + 1, `${applicationId} afterSequence advances without gap`);
        if (paged.length + 1 < expected.length) ctx.ok(page.nextCursor !== null, `${applicationId} nonfinal page advertises continuation`);
        else ctx.equal(page.nextCursor, null, `${applicationId} final page exhausts continuation`);
        paged.push(event);
        afterSequence = event.sequence;
      }
      const exhausted = await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: String(afterSequence), limit: "1" });
      ctx.equal(exhausted, { items: [], nextCursor: null }, `${applicationId} exhausted page is exact and empty`);
      const full = await domainEvents(ctx, api.baseUrl, { aggregateId: applicationId, afterSequence: "0", limit: "100" });
      ctx.equal(full.items, expected, `${applicationId} full query equals complete snapshot Event history`);
      ctx.equal(paged, expected, `${applicationId} small-page traversal has no omission or duplicate`);
      ctx.assert(`${applicationId} Event sequence`, () => assertAggregateSequences(paged));
      ctx.ok(paged.every(({ payload }) => canonicalJson(payload) === "{}"), `${applicationId} Event payloads empty`);
    }
    ctx.assert("snapshot Event sequence", () => assertAggregateSequences(final.events));
    ctx.equal(applicationFrom(final, changes.application.applicationId).currentRevision, 2, "replacement state and Event visible together");
    ctx.equal(applicationFrom(final, due.application.applicationId).state, "EXPIRED", "expiry state and Event visible together");
    return caseResult(ctx, { aggregates: 3, pagedEvents: final.events.filter(({ aggregateId }) => [submitted.application.applicationId, changes.application.applicationId, due.application.applicationId].includes(aggregateId)).length });
  },
);

const a13 = defineCase(
  "A-13",
  "PF-F-FINAL-STAGES one two and five Stage bodies",
  "Create one, two and five Stage Applications and reject zero, six, invalid nested policy and mixed legacy-policy-plus-stages requests without sending unpublished ordinal or name-boundary fields",
  "Stage ordinals are contiguous, exactly Stage 1 is ACTIVE, later Stages are PENDING and published INVALID_REVIEW_STAGES failures create no aggregate",
  ["staged Application HTTP", "Stages HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.finalStages("a13");
    const seed = { ...family.seed, permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [] };
    const { api } = await boot(ctx, { family, seed });
    const ids = [];
    for (const [index, body] of family.bodies.entries()) {
      const created = await submitApplication(ctx, api.baseUrl, body, `a13-stage-${index}`);
      ids.push(created.application.applicationId);
      const stages = await stagesDetail(ctx, api.baseUrl, created.application.applicationId);
      ctx.assert(`${body.stages.length} Stage set`, () => assertStageSet(stages, body.stages.length), { hardCapIds: ["REVIEW_AUTHORITY"] });
    }
    const before = await snapshot(ctx, api.baseUrl);
    const invalidBodies = [
      { ...ctx.fixtures.stagedBody(1, "a13-zero"), stages: [] },
      ctx.fixtures.stagedBody(6, "a13-six"),
      { ...ctx.fixtures.stagedBody(1, "a13-nested"), stages: [{ name: "Invalid nested", reviewPolicy: { roles: [], requiredTotalApprovals: 1 } }] },
      { ...ctx.fixtures.stagedBody(1, "a13-both"), reviewPolicy: family.policy },
    ];
    for (const [index, body] of invalidBodies.entries()) expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/permit-applications", ctx.key(`a13-invalid-${index}`), body), 400, "INVALID_REVIEW_STAGES");
    ctx.equal(stableSnapshot(await snapshot(ctx, api.baseUrl)), stableSnapshot(before), "invalid Stage requests atomic");
    return caseResult(ctx, { applicationIds: ids });
  },
  [blocked("PF-A13-INVALID-ORDINAL", "PF-GAP-03"), blocked("PF-A13-INVALID-NAME", "PF-GAP-05")],
);

const a14 = defineCase(
  "A-14",
  "PF-F-FINAL-STAGES current Stage policy",
  "Create a three-Stage Application whose first policy is legal-only, claim its current legal slot and reject a reviewer eligible only in a later security Stage",
  "Eligibility comes only from the single current ACTIVE Stage, pending Stage resources remain immutable and no Stage association or Decision wire is invented",
  ["staged Application HTTP", "Review Claim HTTP", "Stages HTTP"],
  async (ctx) => {
    const family = ctx.fixtures.finalStages("a14");
    const seed = { ...family.seed, permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [] };
    const { api } = await boot(ctx, { family, seed });
    const body = ctx.fixtures.stagedBody(3, "a14", { stages: [
      { name: "Legal", reviewPolicy: family.strictLegalPolicy },
      { name: "Security", reviewPolicy: family.policy },
      { name: "Issue", reviewPolicy: family.strictLegalPolicy },
    ] });
    const created = await submitApplication(ctx, api.baseUrl, body, "a14-create");
    const applicationId = created.application.applicationId;
    const before = await stagesDetail(ctx, api.baseUrl, applicationId);
    await claimReview(ctx, api.baseUrl, applicationId, { reviewerId: family.legalReviewers[0].reviewerId, role: "legal" }, "a14-legal");
    expectError(ctx, await ctx.mutate(api.baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, ctx.key("a14-security"), { reviewerId: family.securityReviewers[0].reviewerId, role: "security" }), 409, "REVIEW_SLOT_UNAVAILABLE");
    const after = await stagesDetail(ctx, api.baseUrl, applicationId);
    ctx.equal(after, before, "Claim does not mutate Stage evidence");
    ctx.equal(after.filter(({ state }) => state === "ACTIVE").length, 1, "one ACTIVE Stage");
    return caseResult(ctx, { applicationId, activeOrdinal: after.find(({ state }) => state === "ACTIVE").ordinal });
  },
  [blocked("PF-A14-STAGE-PROGRESSION", "PF-GAP-01"), blocked("PF-A14-CLAIM-STAGE-ASSOCIATION", "PF-GAP-04")],
);

export function assertLegacyStageBackfill(resources) {
  const applications = resources.permitApplications;
  const revisions = resources.applicationRevisions;
  const stages = resources.reviewStages;
  assert.equal(stages.length, applications.length, "legacy migration creates exactly one Stage per Application");
  assert.equal(new Set(stages.map(({ stageId }) => stageId)).size, stages.length, "legacy Stage identities unique");
  for (const application of applications) {
    const current = revisions.filter(({ applicationId, revision }) => applicationId === application.applicationId && revision === application.currentRevision);
    assert.equal(current.length, 1, `${application.applicationId} exact current Revision`);
    const migrated = stages.filter(({ applicationId }) => applicationId === application.applicationId);
    assert.equal(migrated.length, 1, `${application.applicationId} exact one legacy Stage`);
    assert.equal(migrated[0].revision, application.currentRevision, `${application.applicationId} legacy Stage current Revision`);
    assert.equal(migrated[0].ordinal, 1, `${application.applicationId} legacy Stage ordinal`);
    assert.deepEqual(migrated[0].policy, current[0].policy, `${application.applicationId} legacy Stage captured policy`);
  }
  return true;
}

const a15 = defineCase(
  "A-15",
  "PF-F-MIGRATION legacy and staged coexistence",
  "Save a real V1 public response carrying immutable Decision and Permit history when the V1 checkpoint is available, migrate that same database, then keep old submit claim and read traffic live beside a new multi-stage Application",
  "Saved V1 Decision and Permit evidence remains exact, legacy identities and behavior remain stable, FINAL adds only ordered reviewStages, and no new Decision token envelope, media type or Stage association is invented",
  ["legacy public HTTP", "FINAL staged HTTP", "OpenAPI", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.migration();
    const approved = family.histories.find(({ application }) => application.state === "APPROVED");
    let api;
    let savedDecisionAuthority;
    let savedV1Response;
    if (ctx.v1Workspace) {
      const v1 = ctx.forWorkspace(ctx.v1Workspace);
      await v1.migrate();
      await v1.seed(family.seed);
      const v1Api = await v1.startApi();
      const v1State = await snapshot(ctx, v1Api.baseUrl, { final: false });
      savedV1Response = await v1.request(v1Api.baseUrl, `/api/v1/permit-applications/${approved.application.applicationId}`);
      requireStatus(ctx, savedV1Response, 200, "saved V1 Decision-bearing detail");
      savedDecisionAuthority = ctx.assert("saved V1 detail exposes exact Decision and Permit history", () => assertAggregateDetailAuthority(savedV1Response.json, v1State, approved.application.applicationId, { final: false }));
      ctx.equal(savedDecisionAuthority.decisions, approved.decisions, "saved V1 response carries every seeded Decision");
      ctx.equal(savedDecisionAuthority.permit, approved.permits[0], "saved V1 response carries exact Permit");
      await ctx.stop(v1Api);
      await ctx.migrate();
      await ctx.migrate();
      api = await ctx.startApi();
    } else {
      ({ api } = await boot(ctx, { family }));
    }
    const legacyCheckpoint = await snapshot(ctx, api.baseUrl);
    ctx.assert("every migrated legacy current Revision has exactly one Stage", () => assertLegacyStageBackfill(legacyCheckpoint.resources), { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    const legacy = family.histories.find(({ application }) => application.state === "SUBMITTED" && Date.parse(application.deadlineAt) > Date.now());
    const legacyCurrent = await applicationCurrent(ctx, api.baseUrl, legacy.application.applicationId);
    ctx.equal(legacyCurrent.json.applicationId, legacy.application.applicationId, "legacy camel read remains supported");
    await applicationDetail(ctx, api.baseUrl, legacy.application.applicationId);
    await claimReview(ctx, api.baseUrl, legacy.application.applicationId, { reviewerId: family.reviewers.find(({ roles }) => roles.includes("security")).reviewerId, role: "security" }, "a15-legacy-claim");
    const legacySubmitBody = ctx.fixtures.submissionBody("a15-legacy-submit");
    const legacySubmit = await submitApplication(ctx, api.baseUrl, legacySubmitBody, "a15-legacy-submit");
    const staged = await submitApplication(ctx, api.baseUrl, ctx.fixtures.stagedBody(2, "a15-staged"), "a15-staged");
    const stages = await stagesDetail(ctx, api.baseUrl, staged.application.applicationId);
    ctx.assert("multi-stage exact", () => assertStageSet(stages, 2));
    await openApi(ctx, api.baseUrl);
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(Object.keys(state.resources).sort(), ["applicants", "applicationRevisions", "approvedPermits", "permitApplications", "reviewClaims", "reviewDecisions", "reviewStages", "reviewers"], "FINAL resource union");
    for (const expected of legacyCheckpoint.resources.reviewStages) {
      ctx.equal(state.resources.reviewStages.filter(({ stageId }) => stageId === expected.stageId), [expected], `${expected.stageId} migrated Stage remains exact`, { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    }
    const legacySubmitStages = state.resources.reviewStages.filter(({ applicationId }) => applicationId === legacySubmit.application.applicationId);
    ctx.equal(legacySubmitStages.length, 1, "old client submission creates exactly one Stage");
    ctx.equal(legacySubmitStages[0].ordinal, 1, "old client Stage ordinal 1");
    ctx.equal(legacySubmitStages[0].policy, legacySubmitBody.reviewPolicy, "old client Stage captures legacy policy");
    ctx.ok(state.resources.permitApplications.some(({ applicationId }) => applicationId === legacySubmit.application.applicationId), "old client submit remains supported");
    const finalDecisionResponse = await applicationDetail(ctx, api.baseUrl, approved.application.applicationId);
    const finalDecisionAuthority = ctx.assert("FINAL detail closes migrated Decision and Permit history", () => assertAggregateDetailAuthority(finalDecisionResponse.json, state, approved.application.applicationId));
    ctx.equal(finalDecisionAuthority.decisions, approved.decisions, "FINAL exposes every V1 Decision exactly once");
    ctx.equal(finalDecisionAuthority.permit, approved.permits[0], "FINAL exposes exact V1 Permit");
    if (savedDecisionAuthority) {
      ctx.equal(finalDecisionAuthority.decisions, savedDecisionAuthority.decisions, "saved V1 Decision response evidence preserved across migration", { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
      ctx.equal(finalDecisionAuthority.permit, savedDecisionAuthority.permit, "saved V1 Permit response evidence preserved across migration", { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    }
    return caseResult(ctx, { legacyApplicationId: legacy.application.applicationId, legacySubmittedId: legacySubmit.application.applicationId, stagedApplicationId: staged.application.applicationId, savedV1DecisionEvidence: Boolean(savedV1Response), decisionIds: finalDecisionAuthority.decisions.map(({ decisionId }) => decisionId), permitId: finalDecisionAuthority.permit.permitId });
  },
  [
    blocked("PF-A15-DECISION-REPLAY-WIRE", "PF-GAP-01"),
    blocked("PF-A15-LEGACY-MEDIA-TYPE", "PF-GAP-02"),
    blocked("PF-A15-CLAIM-STAGE-ASSOCIATION", "PF-GAP-04"),
  ],
);

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13, a14, a15]);
