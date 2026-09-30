import { candidateAssert as assert } from "../lib/execution.mjs";

import { beneficiaryRequest, fundedRequest, makeAllV1StatesFixture, makeEmptySeed, makeEscrowFixture } from "../fixtures/index.mjs";
import { assertDetail, assertDispute, assertEscrowGuardOpenApi, assertEvents, assertReleasePayouts, assertSnapshot, canonicalJson } from "../oracles/index.mjs";
import { acceptMilestone, assertNoPrivatePaths, browserMutation, createEscrow, defineCase, finalEvidence, getDetail, launchBrowser, listEscrows, openDispute, prepare, queryEvents, resolveDispute, resources, semanticError, stableSnapshot, successful, visibleControl, waitForEscrow } from "./helpers.mjs";

function options(ctx) { return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime }; }
function clone(value) { return structuredClone(value); }
function withVersion(seed, suffix) { return { ...seed, seedVersion: `${seed.seedVersion}-${suffix}`.slice(0, 64) }; }
function exactPublicState(snapshot) { return { resources: snapshot.resources, work: snapshot.work, events: snapshot.events }; }
function combine(fixtures, seedVersion) {
  const first = fixtures[0]; const seed = makeEmptySeed(first.fixtures, seedVersion ?? first.fixtures.seedVersion("combined"));
  for (const fixture of fixtures) {
    for (const party of fixture.parties) if (!seed.parties.some(({ partyId }) => partyId === party.partyId)) seed.parties.push(party);
    seed.escrows.push(fixture.escrow); seed.milestones.push(...fixture.milestones); seed.disputes.push(...fixture.seed.disputes); seed.releases.push(...fixture.releases);
  }
  return seed;
}

function sqlIdentifier(value, label) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`unsafe evaluator ${label}`);
  return value;
}

export function migrationPauseTriggerSql({ functionName, triggerName }) {
  const functionId = sqlIdentifier(functionName, "function name");
  const triggerId = sqlIdentifier(triggerName, "trigger name");
  return [
    `create function public.${functionId}() returns event_trigger language plpgsql as $eg$`,
    "begin",
    "  perform pg_sleep(60);",
    "end $eg$;",
    `create event trigger ${triggerId} on ddl_command_end execute function public.${functionId}();`,
  ].join("\n");
}

export function parseUniquePgSleepBackend(stdout) {
  const rows = String(stdout).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  assert.equal(rows.length, 1, `expected exactly one migration backend in PgSleep, observed ${rows.length}`);
  const pid = Number(rows[0]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "PgSleep migration backend has a positive PostgreSQL PID");
  return pid;
}

async function userCatalogFingerprint(ctx, target) {
  const query = `select json_build_object(
    'relations',(select coalesce(json_agg(c.relkind::text||':'||c.relname order by c.relkind::text,c.relname),'[]'::json) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S')),
    'routines',(select coalesce(json_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::json) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
    'types',(select coalesce(json_agg(t.typtype::text||':'||t.typname order by t.typtype::text,t.typname),'[]'::json) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype in ('c','d','e')),
    'extensions',(select coalesce(json_agg(extname order by extname),'[]'::json) from pg_extension where extname<>'plpgsql'),
    'eventTriggers',(select coalesce(json_agg(evtname order by evtname),'[]'::json) from pg_event_trigger))::text`;
  const result = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", query], { timeoutMs: 5_000 });
  return JSON.parse(result.stdout.trim());
}

async function interruptFirstMigration(ctx, target) {
  const suffix = `${process.pid}_${ctx.caseId.toLowerCase().replaceAll("-", "_")}`;
  const functionName = `eg_a02_pause_${suffix}`;
  const triggerName = `eg_a02_trigger_${suffix}`;
  const install = migrationPauseTriggerSql({ functionName, triggerName });
  const remove = `drop event trigger if exists ${triggerName}; drop function if exists public.${functionName}();`;
  await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", install], { timeoutMs: 10_000 });

  let settled = false;
  let result;
  let migrationError;
  const migration = target.migrate({ allowFailure: true, timeoutMs: 90_000 }).then((value) => {
    settled = true;
    result = value;
  }, (error) => {
    settled = true;
    migrationError = error;
  });

  try {
    const observe = "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event='PgSleep' order by pid";
    let migrationPid;
    for (let poll = 0; poll < 200 && migrationPid === undefined && !settled; poll += 1) {
      const activity = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", observe], { timeoutMs: 5_000 });
      if (activity.stdout.trim()) migrationPid = parseUniquePgSleepBackend(activity.stdout);
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (migrationPid === undefined) throw new Error("expected the first real migration DDL to reach the evaluator pause seam");
    const terminate = `select case when exists(select 1 from pg_stat_activity where datname=current_database() and pid=${migrationPid} and wait_event='PgSleep') then case when pg_terminate_backend(${migrationPid}) then 1 else 0 end else 0 end`;
    const termination = await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--tuples-only", "--no-align", "--command", terminate], { timeoutMs: 5_000 });
    const terminated = Number.parseInt(termination.stdout.trim() || "0", 10);
    await migration;
    if (migrationError) throw migrationError;
    if (terminated !== 1 || (result.exitCode === 0 && !result.signal)) throw new Error(`controlled first migration did not fail: terminated=${terminated}, exit=${result.exitCode}, signal=${result.signal}`);
    return { migrationPid, terminated, exitCode: result.exitCode, signal: result.signal };
  } finally {
    if (!settled) {
      await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", "select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event='PgSleep'"], { allowFailure: true, timeoutMs: 5_000 });
      await migration;
    }
    await target.command("psql", ["--no-psqlrc", "--dbname", ctx.databaseUrl, "--command", remove], { allowFailure: true, timeoutMs: 10_000 });
  }
}
async function browserSubmit(ctx, baseUrl, escrowId) {
  const { page } = await launchBrowser(ctx, baseUrl);
  const identity = page.getByText(escrowId, { exact: false }).first();
  assert.ok(await identity.count(), "Escrow identity visible in production UI"); await identity.click();
  const response = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u);
  assert.ok(response.status() >= 200 && response.status() < 300, "visible submit succeeds");
  await page.reload({ waitUntil: "networkidle" });
  return page;
}

const A01 = defineCase({ id: "A-01", fixtureFamily: "EG-F-EMPTY", action: "Install the frozen package, replay migration, build, start API, Expiry Worker and Dispatcher as independent production processes, inspect health, OpenAPI and UI, then terminate every owned role.", oracle: "All published commands are non-interactive, every role is a distinct live process on localhost, public surfaces answer, and normal termination leaves no owned child or bound port.", async run(ctx) { const target = ctx.forWorkspace(ctx.workspace); await target.command("npm", ["install", "--ignore-scripts"], { timeoutMs: 240_000 }); await target.migrate(); await target.migrate(); await target.npm("build", [], { timeoutMs: 240_000 }); const receiver = await ctx.receiver(); const api = await target.startApi({ healthTimeoutMs: 60_000 }); const worker = await target.startWorker(); const dispatcher = await target.startDispatcher({ webhookUrl: receiver.url }); const roles = [api, worker, dispatcher]; ctx.equal(new Set(roles.map(({ pid }) => pid)).size, roles.length, "API, Worker and Dispatcher have distinct process groups"); const health = await ctx.request(api.baseUrl, "/healthz"); const openapi = await ctx.request(api.baseUrl, "/openapi.json"); const ui = await ctx.request(api.baseUrl, "/"); ctx.equal(health.status, 200, "health"); ctx.equal(openapi.status, 200, "OpenAPI"); ctx.ok(ui.status >= 200 && ui.status < 400, "production UI"); for (const role of roles) { ctx.ok(role.pid > 0 && role.child.exitCode === null, `${role.role} live`); await ctx.stop(role); ctx.ok(role.stopped && !role.forcedKill, `${role.role} stopped normally without a leaked descendant`); } await assert.rejects(() => ctx.request(api.baseUrl, "/healthz", { timeoutMs: 500 }), "API port closes after SIGTERM"); return finalEvidence(ctx, { roles: roles.map(({ role }) => role), openapi: openapi.json?.openapi, cleanTermination: true }); } });

const A02 = defineCase({
  id: "A-02",
  fixtureFamily: "EG-F-MIGRATION",
  action: "Interrupt the first real DDL of a clean migration through an evaluator-owned PostgreSQL event-trigger pause, verify a clean retry twice, then import populated public history, save one funded response, rerun migration twice and replay that response.",
  oracle: "The interrupted migration exits nonzero without a usable partial public projection; clean retry converges, and every populated Escrow, Milestone, Dispute, Release, Share, Work, Event, detail and saved response remains semantically identical across repeated migration.",
  async run(ctx) {
    const fixture = makeAllV1StatesFixture(options(ctx));
    const requestFixture = makeEscrowFixture(options(ctx), { label: "migration-saved-response" });
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 240_000 });
    const cleanCatalog = await userCatalogFingerprint(ctx, target);
    const interrupted = await interruptFirstMigration(ctx, target);
    ctx.equal(await userCatalogFingerprint(ctx, target), cleanCatalog, "interrupted first migration rolls back every user relation, routine, type and extension");
    await target.migrate();
    await target.migrate();
    const emptyApi = await target.startApi();
    const empty = assertSnapshot(await ctx.snapshot(emptyApi.baseUrl));
    ctx.equal({ resources: Object.fromEntries(Object.entries(resources(empty)).map(([name, values]) => [name, values.length])), work: empty.work.length, events: empty.events.length }, { resources: { parties: 0, escrows: 0, milestones: 0, disputes: 0, releases: 0, beneficiaryShares: 0, beneficiaryPayouts: 0 }, work: 0, events: 0 }, "retry after interrupted first DDL exposes one complete empty public schema");
    await ctx.stop(emptyApi);
    await target.seed(fixture.seed);
    const api = await target.startApi();
    const key = ctx.key("migration-saved-create");
    const body = fundedRequest(requestFixture, [25, 75]);
    const saved = await ctx.mutate(api.baseUrl, "/api/v1/escrows", key, body);
    ctx.equal(saved.status, 201, "saved funded response status");
    const before = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const beforeState = stableSnapshot(before);
    const details = new Map();
    for (const { escrowId } of resources(before).escrows) details.set(escrowId, canonicalJson(await getDetail(ctx, api.baseUrl, escrowId)));
    await ctx.stop(api);
    await target.migrate();
    await target.migrate();
    const restarted = await target.startApi();
    const replay = await ctx.mutate(restarted.baseUrl, "/api/v1/escrows", key, body);
    ctx.equal({ status: replay.status, body: replay.text }, { status: saved.status, body: saved.text }, "saved response survives repeated migration");
    const after = assertSnapshot(await ctx.snapshot(restarted.baseUrl));
    ctx.equal(stableSnapshot(after), beforeState, "populated repeated migration preserves the complete public projection");
    for (const [escrowId, expected] of details) ctx.equal(canonicalJson(await getDetail(ctx, restarted.baseUrl, escrowId)), expected, "repeated migration preserves every detail field and identity");
    return finalEvidence(ctx, { escrows: resources(after).escrows.length, successfulMigrations: 4, failedMigrations: 1, terminatedMigrationBackend: interrupted.migrationPid, replayEscrowId: saved.json?.escrowId, faultPoint: "ddl_command_end:first-real-ddl" });
  },
});

const A03 = defineCase({
  id: "A-03",
  fixtureFamily: "EG-F-SEED-INVALID",
  action: "Replay one legal seed and then independently import duplicate identities, broken references, bad ordinals, broken sums, invalid state or time, unsafe integers, unknown fields and a same-version different canonical digest.",
  oracle: "Legal same-version same-digest replay is a no-op; every invalid whole-file import fails nonzero, the digest conflict names SEED_VERSION_CONFLICT, and resources, Work, Events and replay state remain unchanged.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const { target, api } = await prepare(ctx, { seed: fixture.seed });
    const replayKey = ctx.key("seed-atomicity-saved-response");
    const replayBody = fundedRequest(fixture, [10]);
    const saved = await ctx.mutate(api.baseUrl, "/api/v1/escrows", replayKey, replayBody);
    ctx.equal(saved.status, 201, "saved idempotency baseline");
    const before = assertSnapshot(await ctx.snapshot(api.baseUrl));
    await target.seed(fixture.seed);
    ctx.equal(stableSnapshot(assertSnapshot(await ctx.snapshot(api.baseUrl))), stableSnapshot(before), "legal seed replay no-op");

    const invalid = [];
    const unknown = clone(fixture.seed); unknown.hidden = true; invalid.push(withVersion(unknown, "unknown"));
    const duplicate = clone(fixture.seed); duplicate.milestones.push(clone(duplicate.milestones[0])); invalid.push(withVersion(duplicate, "duplicate"));
    const reference = clone(fixture.seed); reference.milestones[0].escrowId = fixture.fixtures.uuid("missing-escrow"); invalid.push(withVersion(reference, "reference"));
    const ordinal = clone(fixture.seed); ordinal.milestones[0].ordinal = 2; invalid.push(withVersion(ordinal, "ordinal"));
    const sum = clone(fixture.seed); sum.milestones[0].amountMinor += 1; invalid.push(withVersion(sum, "sum"));
    const state = clone(fixture.seed); state.escrows[0].state = "UNKNOWN"; invalid.push(withVersion(state, "state"));
    const time = clone(fixture.seed); time.escrows[0].expiresAt = "not-a-time"; invalid.push(withVersion(time, "time"));
    const integer = clone(fixture.seed); integer.escrows[0].totalMinor = Number.MAX_SAFE_INTEGER + 1; invalid.push(withVersion(integer, "integer"));

    for (const [index, seed] of invalid.entries()) {
      await assert.rejects(target.seed(seed, { ...([0, 5, 6, 7].includes(index) ? { contractExpectation: "invalid" } : {}) }), (error) => error.origin !== "evaluator");
      ctx.equal(stableSnapshot(assertSnapshot(await ctx.snapshot(api.baseUrl))), stableSnapshot(before), `invalid seed ${index + 1} is an atomic no-op`);
      const replay = await ctx.mutate(api.baseUrl, "/api/v1/escrows", replayKey, replayBody);
      ctx.equal({ status: replay.status, body: replay.text }, { status: saved.status, body: saved.text }, `invalid seed ${index + 1} preserves saved replay authority`);
    }
    const conflict = clone(fixture.seed); conflict.parties[0].displayName = "Changed digest";
    await assert.rejects(target.seed(conflict), (error) => /SEED_VERSION_CONFLICT/u.test(`${error.result?.stdout ?? ""}\n${error.result?.stderr ?? ""}`));
    ctx.equal(stableSnapshot(assertSnapshot(await ctx.snapshot(api.baseUrl))), stableSnapshot(before), "digest conflict is an atomic no-op");
    return finalEvidence(ctx, { rejected: invalid.length + 1, replayChecks: invalid.length });
  },
});

const A04 = defineCase({ id: "A-04", fixtureFamily: "EG-F-HTTP-ERRORS", action: "Send unsupported media, malformed JSON, unknown keys, missing and invalid values, missing or bad admin credentials and absent resource identities through every public mutation family.", oracle: "Every failure returns the published status and closed error envelope, reveals no token or private path, and creates no Escrow, Milestone, Dispute, Release, Payout, Work or Event side effect.", async run(ctx) { const submitted = makeEscrowFixture(options(ctx), { label: "http-submitted", states: ["SUBMITTED", "PENDING"] }); const disputed = makeEscrowFixture(options(ctx), { label: "http-disputed", states: ["DISPUTED", "PENDING"], dispute: { state: "OPEN", milestoneIndex: 0 } }); const { api } = await prepare(ctx, { seed: combine([submitted, disputed]) }); const before = assertSnapshot(await ctx.snapshot(api.baseUrl)); const body = fundedRequest(submitted); const malformedWirePost = (path, label, raw, { type = "application/json", admin = false } = {}) => ctx.request(api.baseUrl, path, { method: "POST", headers: { "content-type": type, "idempotency-key": ctx.key(label), ...(admin ? { authorization: `Bearer ${ctx.adminToken}` } : {}) }, raw, contractExpectation: "invalid" }); const responses = [];
    responses.push(await malformedWirePost("/api/v1/escrows", "media", "{}", { type: "text/plain" })); semanticError(responses.at(-1), 415, "UNSUPPORTED_MEDIA_TYPE");
    responses.push(await malformedWirePost("/api/v1/escrows", "malformed", "{")); semanticError(responses.at(-1), 400, "MALFORMED_JSON");
    responses.push(await createEscrow(ctx, api.baseUrl, { ...body, hidden: true }, { key: ctx.key("unknown"), allowFailure: true, contractExpectation: "invalid" })); semanticError(responses.at(-1), 400, "UNKNOWN_FIELD");
    responses.push(await createEscrow(ctx, api.baseUrl, { ...body, totalMinor: "100" }, { key: ctx.key("shape"), allowFailure: true, contractExpectation: "invalid" })); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    const currentPath = `/api/v1/escrows/${submitted.escrowId}/milestones/${submitted.milestones[0].milestoneId}`;
    responses.push(await malformedWirePost(`${currentPath}/submit`, "submit-media", "{}", { type: "text/plain" })); semanticError(responses.at(-1), 415, "UNSUPPORTED_MEDIA_TYPE");
    responses.push(await malformedWirePost(`${currentPath}/submit`, "submit-malformed", "{")); semanticError(responses.at(-1), 400, "MALFORMED_JSON");
    responses.push(await malformedWirePost(`${currentPath}/submit`, "submit-unknown", JSON.stringify({ evidence: null, hidden: true }))); semanticError(responses.at(-1), 400, "UNKNOWN_FIELD");
    responses.push(await malformedWirePost(`${currentPath}/submit`, "submit-missing", "{}")); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    responses.push(await malformedWirePost(`${currentPath}/accept`, "accept-media", "{}", { type: "text/plain" })); semanticError(responses.at(-1), 415, "UNSUPPORTED_MEDIA_TYPE");
    responses.push(await malformedWirePost(`${currentPath}/accept`, "accept-malformed", "{")); semanticError(responses.at(-1), 400, "MALFORMED_JSON");
    responses.push(await malformedWirePost(`${currentPath}/accept`, "accept-unknown", JSON.stringify({ hidden: true }))); semanticError(responses.at(-1), 400, "UNKNOWN_FIELD");
    responses.push(await malformedWirePost(`${currentPath}/accept`, "accept-shape", "[]")); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    responses.push(await malformedWirePost(`${currentPath}/disputes`, "dispute-media", "{}", { type: "text/plain" })); semanticError(responses.at(-1), 415, "UNSUPPORTED_MEDIA_TYPE");
    responses.push(await malformedWirePost(`${currentPath}/disputes`, "dispute-malformed", "{")); semanticError(responses.at(-1), 400, "MALFORMED_JSON");
    responses.push(await malformedWirePost(`${currentPath}/disputes`, "dispute-unknown", JSON.stringify({ openedBy: "BUYER", reason: "hidden", hidden: true }))); semanticError(responses.at(-1), 400, "UNKNOWN_FIELD");
    responses.push(await malformedWirePost(`${currentPath}/disputes`, "dispute-missing", JSON.stringify({ openedBy: "BUYER" }))); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    responses.push(await malformedWirePost(`${currentPath}/disputes`, "dispute-invalid", JSON.stringify({ openedBy: "ADMIN", reason: "invalid role" }))); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    const resolvePath = `/api/v1/admin/disputes/${disputed.dispute.disputeId}/resolve`;
    responses.push(await malformedWirePost(resolvePath, "resolve-media", "{}", { type: "text/plain", admin: true })); semanticError(responses.at(-1), 415, "UNSUPPORTED_MEDIA_TYPE");
    responses.push(await malformedWirePost(resolvePath, "resolve-malformed", "{", { admin: true })); semanticError(responses.at(-1), 400, "MALFORMED_JSON");
    responses.push(await malformedWirePost(resolvePath, "resolve-unknown", JSON.stringify({ decision: "REFUND", note: "hidden", hidden: true }), { admin: true })); semanticError(responses.at(-1), 400, "UNKNOWN_FIELD");
    responses.push(await malformedWirePost(resolvePath, "resolve-missing", JSON.stringify({ decision: "REFUND" }), { admin: true })); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    responses.push(await malformedWirePost(resolvePath, "resolve-invalid", JSON.stringify({ decision: "DENY", note: "invalid" }), { admin: true })); semanticError(responses.at(-1), 400, "INVALID_REQUEST");
    for (const token of [undefined, "Bearer wrong"]) { const denied = await ctx.request(api.baseUrl, resolvePath, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key(`auth-${token}`), ...(token ? { authorization: token } : {}) }, json: { decision: "REFUND", note: "Denied" }, ...(token === undefined ? { contractExpectation: "invalid" } : {}) }); responses.push(denied); semanticError(denied, 401, "ADMIN_AUTH_REQUIRED"); }
    const keyCases = [
      ["/api/v1/escrows", body, false],
      [`${currentPath}/accept`, {}, false],
      [`${currentPath}/disputes`, { openedBy: "BUYER", reason: "header validation" }, false],
      [resolvePath, { decision: "REFUND", note: "header validation" }, true],
    ];
    for (const [path, payload, admin] of keyCases) {
      for (const key of [undefined, "", "x".repeat(129)]) {
        const invalidKey = await ctx.request(api.baseUrl, path, { method: "POST", headers: { ...(key === undefined ? {} : { "idempotency-key": key }), ...(admin ? { authorization: `Bearer ${ctx.adminToken}` } : {}) }, json: payload, contractExpectation: "invalid" });
        responses.push(invalidKey); semanticError(invalidKey, 400, "INVALID_REQUEST");
      }
    }
    const missingEscrow = submitted.fixtures.uuid("missing-escrow"), missingMilestone = submitted.fixtures.uuid("missing-milestone"), missingDispute = submitted.fixtures.uuid("missing-dispute");
    for (const [path, payload, label] of [[`/api/v1/escrows/${missingEscrow}/milestones/${missingMilestone}/submit`, { evidence: {} }, "missing-submit"], [`/api/v1/escrows/${missingEscrow}/milestones/${missingMilestone}/accept`, {}, "missing-accept"], [`/api/v1/escrows/${missingEscrow}/milestones/${missingMilestone}/disputes`, { openedBy: "BUYER", reason: "missing" }, "missing-dispute-open"]]) { const missingMutation = await ctx.mutate(api.baseUrl, path, ctx.key(label), payload); responses.push(missingMutation); semanticError(missingMutation, 404, "NOT_FOUND"); }
    const missingResolve = await ctx.mutate(api.baseUrl, `/api/v1/admin/disputes/${missingDispute}/resolve`, ctx.key("missing-resolve"), { decision: "REFUND", note: "missing" }, { admin: true }); responses.push(missingResolve); semanticError(missingResolve, 404, "NOT_FOUND");
    const missingRead = await ctx.request(api.baseUrl, `/api/v1/escrows/${missingEscrow}`); responses.push(missingRead); semanticError(missingRead, 404, "NOT_FOUND");
    for (const response of responses) { assertNoPrivatePaths(response.text, "HTTP error"); ctx.ok(!/(?:seedVersion|escrowguard-admin-)/iu.test(response.text ?? ""), "errors redact seed and admin secrets"); } ctx.equal(exactPublicState(assertSnapshot(await ctx.snapshot(api.baseUrl))), exactPublicState(before), "all HTTP failures have zero side effects"); return finalEvidence(ctx, { failures: responses.length, mutationFamilies: 5 }); } });

const A05 = defineCase({ id: "A-05", fixtureFamily: "EG-F-READS", action: "Import one hundred twenty-one Escrows in a deterministic noncanonical order, traverse default, one and one-hundred item pages, restart API between opaque cursor pages, reject a malformed cursor, and cross-check detail and snapshot.", oracle: "Pages have no omission or duplicate and stable restart-safe opaque cursors; detail has exact ordered resources and Fund Position; snapshot is one point-in-time, exact, sorted, and recursively secret-free.", async run(ctx) { const base = makeEscrowFixture(options(ctx), { label: "page-0" }); const fixtures = Array.from({ length: 121 }, (_, index) => makeEscrowFixture(options(ctx), { label: `page-${index}`, amounts: [index + 1] })).reverse(); const seed = combine(fixtures, base.fixtures.seedVersion("pages")); const { target, api } = await prepare(ctx, { seed }); const firstDefault = await listEscrows(ctx, api.baseUrl); ctx.equal(firstDefault.items.length, 50, "default limit 50"); const ids = []; let cursor; do { const page = await listEscrows(ctx, api.baseUrl, { limit: 1, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(({ escrowId }) => escrowId)); cursor = page.nextCursor; } while (cursor); ctx.equal(ids.length, 121, "all Escrows paged"); ctx.equal(new Set(ids).size, 121, "no duplicate Escrows"); const first = await listEscrows(ctx, api.baseUrl, { limit: 100 }); ctx.equal(first.items.length, 100, "limit 100"); ctx.equal(first.items.map(({ escrowId }) => escrowId), ids.slice(0, 100), "page-size changes preserve stable collection order"); ctx.ok(typeof first.nextCursor === "string" && !first.nextCursor.includes(first.items.at(-1).escrowId), "cursor is opaque rather than a public identity"); await ctx.stop(api); const restarted = await target.startApi(); const rest = await listEscrows(ctx, restarted.baseUrl, { limit: 100, cursor: first.nextCursor }); ctx.equal([...first.items, ...rest.items].map(({ escrowId }) => escrowId), ids, "cursor survives restart with stable order"); const before = await ctx.snapshot(restarted.baseUrl); semanticError(await ctx.request(restarted.baseUrl, "/api/v1/escrows?cursor=not-opaque"), 400, "INVALID_CURSOR"); ctx.equal(stableSnapshot(await ctx.snapshot(restarted.baseUrl)), stableSnapshot(before), "bad cursor no-op"); await getDetail(ctx, restarted.baseUrl, ids[0]); assertSnapshot(await ctx.snapshot(restarted.baseUrl)); return finalEvidence(ctx, { items: ids.length, stableOrder: true, restartSafeCursor: true }); } });

const A06 = defineCase({ id: "A-06", fixtureFamily: "EG-F-FUND", action: "Create funded Escrows with one, two and twenty Milestones, then attempt zero or twenty-one Milestones, nonpositive, unsafe and mismatched amounts, malformed currency, and broken exact sums.", oracle: "Each legal request atomically creates one FUNDED Escrow, contiguous Milestones, one expiry Work and one funded Event; INVALID_ESCROW_TOTAL rejects the complete illegal aggregate with no side effect.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const created = []; for (const count of [1, 2, 20]) { const amounts = Array.from({ length: count }, () => 10); created.push(await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, amounts), { key: ctx.key(`create-${count}`) })); } const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); for (const escrow of created) { const milestones = resources(snapshot).milestones.filter(({ escrowId }) => escrowId === escrow.escrowId); ctx.equal(milestones.length, escrow.totalMinor / 10, "Milestone count"); ctx.equal(snapshot.work.filter(({ aggregateId, kind }) => aggregateId === escrow.escrowId && kind === "ESCROW_EXPIRY").length, 1, "one expiry Work"); ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === escrow.escrowId && type === "escrow.funded").length, 1, "one funded Event"); } const before = stableSnapshot(snapshot); const invalid = [fundedRequest(fixture, []), fundedRequest(fixture, Array(21).fill(1)), fundedRequest(fixture, [0]), fundedRequest(fixture, [-1]), fundedRequest(fixture, [Number.MAX_SAFE_INTEGER + 1]), fundedRequest(fixture, [10], { currency: "usd" }), fundedRequest(fixture, [10], { totalMinor: 11 })]; for (let index = 0; index < invalid.length; index += 1) semanticError(await createEscrow(ctx, api.baseUrl, invalid[index], { key: ctx.key(`invalid-${index}`), allowFailure: true, ...(index === 4 ? { contractExpectation: "invalid" } : {}) }), 400, "INVALID_ESCROW_TOTAL"); ctx.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), before, "invalid funding zero side effect"); return finalEvidence(ctx, { legal: created.length, rejected: invalid.length }); } });

const A07 = defineCase({ id: "A-07", fixtureFamily: "EG-F-V1-ORDER", action: "Use V1 exact seeds for one all-PENDING and one current-SUBMITTED three-Milestone Escrow, attempt acceptance and Dispute on later ordinals and acceptance on the current PENDING ordinal, then read detail and history.", oracle: "Later ordinals return MILESTONE_NOT_CURRENT, the current PENDING ordinal returns MILESTONE_NOT_SUBMITTED, each failure has zero effect, and seeded SUBMITTED amount and ordinal remain immutable without inventing evidence JSON.", async run(ctx) { const pending = makeEscrowFixture(options(ctx), { label: "pending", states: ["PENDING", "PENDING", "PENDING"] }); const submitted = makeEscrowFixture(options(ctx), { label: "submitted", states: ["SUBMITTED", "PENDING", "PENDING"] }); const { api } = await prepare(ctx, { seed: combine([pending, submitted]) }); const before = stableSnapshot(await ctx.snapshot(api.baseUrl)); semanticError(await acceptMilestone(ctx, api.baseUrl, pending.escrowId, pending.milestones[0].milestoneId, { allowFailure: true }), 409, "MILESTONE_NOT_SUBMITTED"); semanticError(await acceptMilestone(ctx, api.baseUrl, submitted.escrowId, submitted.milestones[1].milestoneId, { allowFailure: true }), 409, "MILESTONE_NOT_CURRENT"); semanticError(await openDispute(ctx, api.baseUrl, submitted.escrowId, submitted.milestones[1].milestoneId, "BUYER", "later", { allowFailure: true }), 409, "MILESTONE_NOT_CURRENT"); ctx.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), before, "ordering failures no-op"); const detail = await getDetail(ctx, api.baseUrl, submitted.escrowId); ctx.equal(detail.milestones[0].ordinal, 1, "seeded ordinal immutable"); ctx.equal(detail.milestones[0].amountMinor, 30, "seeded amount immutable"); return finalEvidence(ctx, { guardedActions: 3 }); } });

const A08 = defineCase({ id: "A-08", fixtureFamily: "EG-F-V1-RELEASE", action: "Import a current SUBMITTED Milestone, accept it once, replay the identical Idempotency-Key and body, then attempt duplicate acceptance and premature acceptance of the next PENDING Milestone.", oracle: "Exactly one Release moves the exact current amount available to released, replay returns the original semantic response, terminal or ACTIVE state is correct, and no duplicate amount or Event appears.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING", "PENDING"], label: "accept" }); const { api } = await prepare(ctx, { seed: fixture.seed }); const before = assertSnapshot(await ctx.snapshot(api.baseUrl)); const beforeEvents = before.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId); const key = ctx.key("accept"); const release = await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, { key }); const replay = await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, { key }); ctx.equal(replay, release, "accept replay semantic body"); semanticError(await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, { key: ctx.key("duplicate"), allowFailure: true }), 409, "MILESTONE_NOT_CURRENT"); semanticError(await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[1].milestoneId, { key: ctx.key("later"), allowFailure: true }), 409, "MILESTONE_NOT_SUBMITTED"); const detail = await getDetail(ctx, api.baseUrl, fixture.escrowId); ctx.equal(detail.escrow.state, "ACTIVE", "partial release leaves Escrow ACTIVE"); ctx.equal(detail.escrow.availableMinor, 70, "available decreased once"); ctx.equal(detail.escrow.releasedMinor, 30, "released increased once"); ctx.equal(detail.releases.length, 1, "one Release"); ctx.equal(detail.releases[0].releaseId, release.releaseId, "Release identity"); const after = assertSnapshot(await ctx.snapshot(api.baseUrl)); const afterEvents = after.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId); ctx.equal(afterEvents.length, beforeEvents.length + 1, "one release Event despite replay and rejected actions"); ctx.equal(afterEvents.at(-1).type, "milestone.released", "release Event type"); return finalEvidence(ctx, { releaseId: release.releaseId, eventsAdded: 1 }); } });

const A09 = defineCase({ id: "A-09", fixtureFamily: "EG-F-V1-DISPUTE", action: "Open independent BUYER and SELLER Disputes on current SUBMITTED Milestones, reject unauthorized resolution, resolve both through ADMIN_TOKEN, and replay an authorized resolution.", oracle: "Each opening freezes Escrow and Milestone, authorized RELEASE applies ordinary exact release atomically with Dispute and Events, and unauthorized or duplicate operations cannot create a second effect.", async run(ctx) { const buyerFixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], amounts: [40, 60], label: "buyer-dispute-release" }); const sellerFixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], amounts: [25, 75], label: "seller-dispute-release" }); const { api } = await prepare(ctx, { seed: combine([buyerFixture, sellerFixture]) }); const opened = [];
    for (const [fixture, openedBy] of [[buyerFixture, "BUYER"], [sellerFixture, "SELLER"]]) { const beforeEvents = assertSnapshot(await ctx.snapshot(api.baseUrl)).events.filter(({ aggregateId }) => aggregateId === fixture.escrowId); const dispute = await openDispute(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, openedBy, `${openedBy} visible reason`); const frozen = await getDetail(ctx, api.baseUrl, fixture.escrowId); ctx.equal({ escrow: frozen.escrow.state, milestone: frozen.milestones[0].state, openedBy: frozen.dispute.openedBy }, { escrow: "DISPUTED", milestone: "DISPUTED", openedBy }, `${openedBy} opening freezes current aggregate`); const openEvents = assertSnapshot(await ctx.snapshot(api.baseUrl)).events.filter(({ aggregateId }) => aggregateId === fixture.escrowId); ctx.equal(openEvents.length, beforeEvents.length + 1, `${openedBy} opening commits one Event`); ctx.equal(openEvents.at(-1).type, "dispute.opened", `${openedBy} opening Event type`); opened.push({ fixture, dispute, openEvents }); }
    const denied = await resolveDispute(ctx, api.baseUrl, opened[0].dispute.disputeId, "RELEASE", "no auth", { key: ctx.key("denied"), admin: false, allowFailure: true, contractExpectation: "invalid" }); semanticError(denied, 401, "ADMIN_AUTH_REQUIRED");
    for (let index = 0; index < opened.length; index += 1) { const { fixture, dispute, openEvents } = opened[index]; const key = ctx.key(`resolve-release-${index}`); const resolved = await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "RELEASE", "approved", { key }); if (index === 0) ctx.equal(await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "RELEASE", "approved", { key }), resolved, "resolution replay"); const detail = await getDetail(ctx, api.baseUrl, fixture.escrowId); ctx.equal({ disputeId: assertDispute(resolved).disputeId, state: resolved.state }, { disputeId: dispute.disputeId, state: "RESOLVED_RELEASE" }, "Dispute resolution"); ctx.equal(detail.dispute, null, "resolved Dispute is no longer current"); ctx.equal(detail.escrow.releasedMinor, fixture.milestones[0].amountMinor, "released exact current amount"); ctx.equal(detail.releases.length, 1, "one Release"); const afterEvents = assertSnapshot(await ctx.snapshot(api.baseUrl)).events.filter(({ aggregateId }) => aggregateId === fixture.escrowId); ctx.equal(afterEvents.length, openEvents.length + 2, "resolution atomically appends resolution and release Events"); ctx.equal(new Set(afterEvents.slice(openEvents.length).map(({ type }) => type)), new Set(["dispute.resolved", "milestone.released"]), "resolution Event identities"); }
    assertSnapshot(await ctx.snapshot(api.baseUrl)); return finalEvidence(ctx, { disputeIds: opened.map(({ dispute }) => dispute.disputeId), openedBy: ["BUYER", "SELLER"] }); } });

const A10 = defineCase({ id: "A-10", fixtureFamily: "EG-F-V1-REFUND", action: "Import one prior RELEASED Milestone plus an OPEN Dispute on the current Milestone and one later PENDING Milestone, then resolve the Dispute to REFUND through the authorized public route.", oracle: "The current and every later Milestone become REFUNDED, their exact sum moves available to refunded, the prior Release is immutable, Escrow becomes REFUNDED, and the refund path creates no beneficiary Payout.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx), { amounts: [30, 20, 50], states: ["RELEASED", "DISPUTED", "PENDING"], dispute: { state: "OPEN", milestoneIndex: 1 }, label: "refund" }); const { api } = await prepare(ctx, { seed: fixture.seed }); const before = await getDetail(ctx, api.baseUrl, fixture.escrowId); const priorRelease = before.releases[0]; await resolveDispute(ctx, api.baseUrl, fixture.dispute.disputeId, "REFUND", "refund remainder"); const detail = await getDetail(ctx, api.baseUrl, fixture.escrowId); ctx.equal(detail.escrow.state, "REFUNDED", "Escrow terminal refund"); ctx.equal(detail.escrow.availableMinor, 0, "available zero"); ctx.equal(detail.escrow.releasedMinor, 30, "prior release preserved"); ctx.equal(detail.escrow.refundedMinor, 70, "current and later refunded"); ctx.equal(detail.milestones.map(({ state }) => state), ["RELEASED", "REFUNDED", "REFUNDED"], "Milestone refund suffix"); ctx.equal(detail.releases, [priorRelease], "prior Release immutable and no new Release"); const refundedMilestoneIds = new Set(detail.milestones.filter(({ state }) => state === "REFUNDED").map(({ milestoneId }) => milestoneId)); const refundedShareIds = new Set(detail.beneficiaryShares.filter(({ milestoneId }) => refundedMilestoneIds.has(milestoneId)).map(({ beneficiaryShareId }) => beneficiaryShareId)); ctx.ok(detail.beneficiaryPayouts.every(({ beneficiaryShareId }) => !refundedShareIds.has(beneficiaryShareId)), "refund suffix creates no beneficiary Payout"); assertSnapshot(await ctx.snapshot(api.baseUrl)); return finalEvidence(ctx, { refundedMinor: 70, refundPayouts: 0 }); } });

const A11 = defineCase({ id: "A-11", fixtureFamily: "EG-F-EXPIRY", action: "Import due FUNDED, due partially released ACTIVE, due SUBMITTED, due DISPUTED, future FUNDED and terminal Escrows, start one real expiry Worker and observe every matching Work to a stable public state.", oracle: "Only due FUNDED or ACTIVE aggregates without SUBMITTED or DISPUTED Milestones refund once; future, blocked and terminal aggregates are unchanged and due Work safely converges without a Payout.", async run(ctx) { const variants = [makeEscrowFixture(options(ctx), { label: "due-funded", expiresAt: ctx.at({ minutes: -1 }) }), makeEscrowFixture(options(ctx), { label: "due-active", states: ["RELEASED", "PENDING"], amounts: [30, 70], expiresAt: ctx.at({ minutes: -1 }) }), makeEscrowFixture(options(ctx), { label: "due-submitted", states: ["SUBMITTED", "PENDING"], expiresAt: ctx.at({ minutes: -1 }) }), makeEscrowFixture(options(ctx), { label: "due-disputed", states: ["DISPUTED", "PENDING"], dispute: { state: "OPEN", milestoneIndex: 0 }, expiresAt: ctx.at({ minutes: -1 }) }), makeEscrowFixture(options(ctx), { label: "future", expiresAt: ctx.at({ hours: 2 }) }), makeEscrowFixture(options(ctx), { label: "terminal", states: ["RELEASED", "RELEASED", "RELEASED"], expiresAt: ctx.at({ minutes: -1 }) })]; const { target, api } = await prepare(ctx, { seed: combine(variants) }); const initial = assertSnapshot(await ctx.snapshot(api.baseUrl)); for (const fixture of variants) ctx.equal(initial.work.filter(({ aggregateId, kind }) => aggregateId === fixture.escrowId && kind === "ESCROW_EXPIRY").length, 1, `one retained expiry Work for ${fixture.escrowId}`); const worker = await target.startWorker(); await Promise.all(variants.slice(0, 2).map((fixture) => waitForEscrow(ctx, api.baseUrl, fixture.escrowId, "REFUNDED", [worker]))); await ctx.waitFor(async () => { const value = await ctx.snapshot(api.baseUrl); const dueIds = new Set(variants.filter(({ escrow }) => escrow.expiresAt <= ctx.fixtures.baseTime).map(({ escrowId }) => escrowId)); const dueWork = value.work.filter(({ aggregateId }) => dueIds.has(aggregateId)); return dueWork.length === dueIds.size && dueWork.every(({ terminal }) => terminal) ? value : undefined; }, { timeoutMs: 120_000, label: "all due expiry Work converges", processes: [worker] }); const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); const byId = new Map(resources(snapshot).escrows.map((value) => [value.escrowId, value])); ctx.equal(byId.get(variants[2].escrowId).state, "ACTIVE", "SUBMITTED blocks expiry"); ctx.equal(byId.get(variants[3].escrowId).state, "DISPUTED", "Dispute blocks expiry"); ctx.equal(byId.get(variants[4].escrowId).state, "FUNDED", "future not expired"); ctx.equal(byId.get(variants[5].escrowId).state, "RELEASED", "terminal unchanged"); const eligibleIds = new Set(variants.slice(0, 2).map(({ escrowId }) => escrowId)); const eligibleMilestoneIds = new Set(resources(snapshot).milestones.filter(({ escrowId }) => eligibleIds.has(escrowId)).map(({ milestoneId }) => milestoneId)); const eligibleShareIds = new Set(resources(snapshot).beneficiaryShares.filter(({ milestoneId }) => eligibleMilestoneIds.has(milestoneId)).map(({ beneficiaryShareId }) => beneficiaryShareId)); ctx.ok(resources(snapshot).beneficiaryPayouts.every(({ beneficiaryShareId }) => !eligibleShareIds.has(beneficiaryShareId)), "expiry creates no Payout"); const eligibleWork = snapshot.work.filter(({ aggregateId }) => eligibleIds.has(aggregateId)), futureWork = snapshot.work.filter(({ aggregateId }) => aggregateId === variants[4].escrowId); ctx.equal(eligibleWork.length, eligibleIds.size, "every eligible aggregate retains one Work"); ctx.ok(eligibleWork.every(({ terminal }) => terminal), "eligible Work terminal"); ctx.equal(futureWork.length, 1, "future Work exists exactly once"); ctx.ok(futureWork.every(({ terminal, state }) => !terminal && state === "PENDING"), "future Work remains pending"); return finalEvidence(ctx, { eligibleRefunded: 2, blocked: 4, expiryPayouts: 0 }); } });

const A12 = defineCase({
  id: "A-12",
  fixtureFamily: "EG-F-EVENT",
  action: "Create a funded Escrow, use exact seeded SUBMITTED history for release and dispute-refund transitions, query Domain Events by aggregateId, afterSequence and limit, traverse pagination, and compare with the point-in-time snapshot.",
  oracle: "Sequences start at one and are contiguous, types belong to the exact published set, payload is exactly empty, sorting is stable, successful state and Event co-appear, and rejected mutations create no Event.",
  async run(ctx) {
    const releaseFixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "events-release" });
    const refundFixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "events-refund" });
    const { api } = await prepare(ctx, { seed: combine([releaseFixture, refundFixture], releaseFixture.fixtures.seedVersion("event-histories")) });
    const publicCreated = await createEscrow(ctx, api.baseUrl, fundedRequest(releaseFixture, [15, 25]), { key: ctx.key("events-public-create") });
    await acceptMilestone(ctx, api.baseUrl, releaseFixture.escrowId, releaseFixture.milestones[0].milestoneId);
    const dispute = await openDispute(ctx, api.baseUrl, refundFixture.escrowId, refundFixture.milestones[0].milestoneId, "SELLER", "event refund history");
    await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "REFUND", "event refund resolution");

    const beforeRollback = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const releaseEventCount = beforeRollback.events.filter(({ aggregateId }) => aggregateId === releaseFixture.escrowId).length;
    semanticError(await acceptMilestone(ctx, api.baseUrl, releaseFixture.escrowId, releaseFixture.milestones[1].milestoneId, { allowFailure: true }), 409, "MILESTONE_NOT_SUBMITTED");
    const afterRollback = assertSnapshot(await ctx.snapshot(api.baseUrl));
    ctx.equal(afterRollback.events.filter(({ aggregateId }) => aggregateId === releaseFixture.escrowId).length, releaseEventCount, "rollback appends no Event");

    const aggregateIds = [publicCreated.escrowId, releaseFixture.escrowId, refundFixture.escrowId];
    for (const aggregateId of aggregateIds) {
      const paged = [];
      let afterSequence = 0;
      do {
        const page = await queryEvents(ctx, api.baseUrl, { aggregateId, afterSequence, limit: 1 });
        paged.push(...page.items);
        if (!page.nextCursor) break;
        ctx.equal(page.items.length, 1, "one-item event page before continuation");
        afterSequence = page.items[0].sequence;
      } while (true);
      assertEvents(paged);
      const expected = afterRollback.events.filter((event) => event.aggregateId === aggregateId);
      ctx.equal(paged, expected, `aggregate ${aggregateId} pagination matches point-in-time snapshot exactly`);
      ctx.equal(paged.map(({ sequence }) => sequence), paged.map((_, index) => index + 1), `aggregate ${aggregateId} sequence contiguous from one`);
    }
    const releaseTypes = afterRollback.events.filter(({ aggregateId }) => aggregateId === releaseFixture.escrowId).map(({ type }) => type);
    const refundTypes = afterRollback.events.filter(({ aggregateId }) => aggregateId === refundFixture.escrowId).map(({ type }) => type);
    ctx.ok(releaseTypes.includes("milestone.released"), "public acceptance commits release Event with state");
    ctx.ok(["dispute.opened", "dispute.resolved", "escrow.refunded"].every((type) => refundTypes.includes(type)), "public dispute-refund history is complete");
    return finalEvidence(ctx, { aggregates: aggregateIds, events: afterRollback.events.filter(({ aggregateId }) => aggregateIds.includes(aggregateId)).length });
  },
});

const A13 = defineCase({ id: "A-13", fixtureFamily: "EG-F-FINAL-SHARES", action: "Create mixed FINAL Escrows containing legacy, one, two and twenty beneficiary Shares, read captured detail, then send zero, twenty-one, duplicate, nonpositive and bad-sum beneficiary allocations.", oracle: "Every legal Share set is immutable, contiguous and exactly conserves its Milestone; legacy captures the Seller as one Share; each invalid allocation returns INVALID_BENEFICIARY_ALLOCATION and leaves the whole Escrow absent.", async run(ctx) { const fixture = makeEscrowFixture(options(ctx)); const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } }); const request = beneficiaryRequest(fixture, [1, 2, 20]); request.milestones.unshift({ title: "Legacy", amountMinor: 15 }); request.totalMinor += 15; const escrow = await createEscrow(ctx, api.baseUrl, request); const detail = await getDetail(ctx, api.baseUrl, escrow.escrowId); const sharesByMilestone = new Map(); for (const share of detail.beneficiaryShares) { const values = sharesByMilestone.get(share.milestoneId) ?? []; values.push(share); sharesByMilestone.set(share.milestoneId, values); } const orderedMilestones = [...detail.milestones].sort((left, right) => left.ordinal - right.ordinal); const orderedShareGroups = orderedMilestones.map(({ milestoneId }) => sharesByMilestone.get(milestoneId) ?? []); ctx.equal(orderedShareGroups.map((values) => values.length), [1, 1, 2, 20], "captured Share cardinalities"); ctx.equal(orderedShareGroups[0][0].beneficiaryId, fixture.sellerId, "legacy Seller Share"); const captured = canonicalJson(detail.beneficiaryShares); request.milestones.at(-1).beneficiaries[0].amountMinor += 1; ctx.equal(canonicalJson((await getDetail(ctx, api.baseUrl, escrow.escrowId)).beneficiaryShares), captured, "captured allocation is immutable after request object changes"); const base = beneficiaryRequest(fixture, [2]); const invalidMilestones = [[], Array.from({ length: 21 }, (_, index) => ({ beneficiaryId: fixture.parties[2 + index].partyId, amountMinor: 1 })), [{ beneficiaryId: fixture.parties[2].partyId, amountMinor: 10 }, { beneficiaryId: fixture.parties[2].partyId, amountMinor: 10 }], [{ beneficiaryId: fixture.parties[2].partyId, amountMinor: 0 }], [{ beneficiaryId: fixture.parties[2].partyId, amountMinor: 1 }]]; for (let index = 0; index < invalidMilestones.length; index += 1) { const body = clone(base); body.milestones[0].beneficiaries = invalidMilestones[index]; semanticError(await createEscrow(ctx, api.baseUrl, body, { key: ctx.key(`bad-shares-${index}`), allowFailure: true }), 400, "INVALID_BENEFICIARY_ALLOCATION"); } const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)); ctx.equal(resources(snapshot).escrows.length, 1, "invalid allocations create no Escrow"); return finalEvidence(ctx, { shareCounts: [1, 1, 2, 20], rejected: invalidMilestones.length }); } });

const A14 = defineCase({
  id: "A-14",
  fixtureFamily: "EG-F-FINAL-PAYOUTS",
  action: "Create FINAL Escrows with multiple captured Shares, use only production UI visible controls to submit the current Milestone, then exercise both direct acceptance and administrator RELEASE resolution through public HTTP.",
  oracle: "Each release path atomically creates one Release and the complete ordinal-ordered Payout set matching captured Share identity, beneficiary and amount; replay creates no partial or duplicate payout.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const { api } = await prepare(ctx, { seed: { ...makeEmptySeed(fixture.fixtures), parties: fixture.parties } });
    const direct = await createEscrow(ctx, api.baseUrl, beneficiaryRequest(fixture, [2]), { key: ctx.key("direct-create") });
    await browserSubmit(ctx, api.baseUrl, direct.escrowId);
    const directBefore = await getDetail(ctx, api.baseUrl, direct.escrowId);
    const directKey = ctx.key("direct-accept");
    const directRelease = assertReleasePayouts(await acceptMilestone(ctx, api.baseUrl, direct.escrowId, directBefore.milestones[0].milestoneId, { key: directKey }), directBefore.beneficiaryShares);
    const directReplay = await acceptMilestone(ctx, api.baseUrl, direct.escrowId, directBefore.milestones[0].milestoneId, { key: directKey });
    ctx.equal(directReplay, directRelease, "direct Release response replays exactly");
    const directAfter = await getDetail(ctx, api.baseUrl, direct.escrowId);
    const persistedDirectRelease = directAfter.releases.find(({ releaseId }) => releaseId === directRelease.releaseId);
    const persistedDirectPayouts = directAfter.beneficiaryPayouts.filter(({ releaseId }) => releaseId === directRelease.releaseId);
    assertReleasePayouts({ ...persistedDirectRelease, payouts: persistedDirectPayouts }, directBefore.beneficiaryShares);
    ctx.equal(persistedDirectPayouts, directRelease.payouts, "direct response Payout identities and order equal persisted detail");

    const disputed = await createEscrow(ctx, api.baseUrl, beneficiaryRequest(fixture, [2]), { key: ctx.key("disputed-create") });
    await browserSubmit(ctx, api.baseUrl, disputed.escrowId);
    const disputeBefore = await getDetail(ctx, api.baseUrl, disputed.escrowId);
    const dispute = await openDispute(ctx, api.baseUrl, disputed.escrowId, disputeBefore.milestones[0].milestoneId);
    const resolveKey = ctx.key("disputed-release-resolve");
    const resolvedResponse = await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "RELEASE", "beneficiary release", { key: resolveKey });
    const resolvedReplay = await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "RELEASE", "beneficiary release", { key: resolveKey });
    ctx.equal(resolvedReplay, resolvedResponse, "administrator resolution response replays exactly");
    const resolvedDetail = await getDetail(ctx, api.baseUrl, disputed.escrowId);
    const resolvedRelease = resolvedDetail.releases.find(({ milestoneId }) => milestoneId === disputeBefore.milestones[0].milestoneId);
    const resolvedPayouts = resolvedDetail.beneficiaryPayouts.filter(({ releaseId }) => releaseId === resolvedRelease?.releaseId);
    assertReleasePayouts({ ...resolvedRelease, payouts: resolvedPayouts }, disputeBefore.beneficiaryShares);

    const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
    for (const [releaseId, payoutIds] of [[directRelease.releaseId, directRelease.payouts.map(({ payoutId }) => payoutId)], [resolvedRelease.releaseId, resolvedPayouts.map(({ payoutId }) => payoutId)]]) {
      ctx.equal(resources(snapshot).releases.filter((release) => release.releaseId === releaseId).length, 1, `one persisted Release ${releaseId}`);
      ctx.equal(resources(snapshot).beneficiaryPayouts.filter((payout) => payout.releaseId === releaseId).map(({ payoutId }) => payoutId).sort(), [...payoutIds].sort(), `complete persisted Payout set ${releaseId}`);
    }
    return finalEvidence(ctx, { releasePaths: 2, payoutCounts: [directRelease.payouts.length, resolvedPayouts.length] });
  },
});

const A15 = defineCase({
  id: "A-15",
  fixtureFamily: "EG-F-FINAL-COMPAT",
  action: "Run old one-Seller create, read, accept and resolve requests beside a mixed FINAL beneficiary Escrow, exercise a legacy public failure, then validate FINAL detail, OpenAPI and the exact snapshot union.",
  oracle: "Legacy routes and error semantics still work, every legacy Milestone has one Seller Share, accepted or RELEASE-resolved legacy flows persist one Seller Payout, old IDs, Work and Events remain unchanged, FINAL snapshot contains only the V1 resources plus Shares and Payouts, and no assertion guesses EG-GAP-02 response negotiation.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const legacySeed = makeEscrowFixture(options(ctx), { label: "legacy-preserved", states: ["RELEASED", "PENDING"], amounts: [35, 65] });
    const { api } = await prepare(ctx, { seed: legacySeed.seed });
    const initial = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const projectAggregate = (snapshot, escrowId) => {
      const data = resources(snapshot);
      const milestoneIds = new Set(data.milestones.filter((item) => item.escrowId === escrowId).map(({ milestoneId }) => milestoneId));
      const releaseIds = new Set(data.releases.filter((item) => item.escrowId === escrowId).map(({ releaseId }) => releaseId));
      return {
        escrow: data.escrows.find((item) => item.escrowId === escrowId),
        milestones: data.milestones.filter((item) => item.escrowId === escrowId),
        disputes: data.disputes.filter((item) => item.escrowId === escrowId),
        releases: data.releases.filter((item) => item.escrowId === escrowId),
        beneficiaryShares: data.beneficiaryShares.filter((item) => milestoneIds.has(item.milestoneId)),
        beneficiaryPayouts: data.beneficiaryPayouts.filter((item) => releaseIds.has(item.releaseId)),
        work: snapshot.work.filter((item) => item.aggregateId === escrowId),
        events: snapshot.events.filter((item) => item.aggregateId === escrowId),
      };
    };
    const preservedHistory = projectAggregate(initial, legacySeed.escrowId);

    const accepted = await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, [40, 60]), { key: ctx.key("legacy-accept-create") });
    const resolved = await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, [30, 70]), { key: ctx.key("legacy-resolve-create") });
    const mixed = await createEscrow(ctx, api.baseUrl, beneficiaryRequest(fixture, [1, 2]), { key: ctx.key("mixed") });
    const acceptedBefore = await getDetail(ctx, api.baseUrl, accepted.escrowId);
    ctx.equal(acceptedBefore.beneficiaryShares.length, 2, "one Seller Share per legacy Milestone");
    ctx.ok(acceptedBefore.beneficiaryShares.every(({ beneficiaryId }) => beneficiaryId === fixture.sellerId), "legacy Shares use Seller");
    semanticError(await acceptMilestone(ctx, api.baseUrl, accepted.escrowId, acceptedBefore.milestones[0].milestoneId, { allowFailure: true }), 409, "MILESTONE_NOT_SUBMITTED");
    await browserSubmit(ctx, api.baseUrl, accepted.escrowId);
    const acceptResponse = await ctx.mutate(api.baseUrl, `/api/v1/escrows/${accepted.escrowId}/milestones/${acceptedBefore.milestones[0].milestoneId}/accept`, ctx.key("legacy-accept"), {});
    ctx.equal(acceptResponse.status, 200, "old accept request succeeds without beneficiary fields");
    const acceptedAfter = await getDetail(ctx, api.baseUrl, accepted.escrowId);
    ctx.equal(acceptedAfter.beneficiaryPayouts.length, 1, "legacy accept persists one Seller Payout");

    await browserSubmit(ctx, api.baseUrl, resolved.escrowId);
    const resolvedBefore = await getDetail(ctx, api.baseUrl, resolved.escrowId);
    const dispute = await openDispute(ctx, api.baseUrl, resolved.escrowId, resolvedBefore.milestones[0].milestoneId, "SELLER", "legacy seller dispute");
    await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "RELEASE", "legacy release");
    const resolvedAfter = await getDetail(ctx, api.baseUrl, resolved.escrowId);
    ctx.equal(resolvedAfter.beneficiaryPayouts.length, 1, "old resolve request persists one Seller Payout");
    await getDetail(ctx, api.baseUrl, mixed.escrowId);

    const document = successful(await ctx.request(api.baseUrl, "/openapi.json"), "FINAL OpenAPI", 200).json;
    ctx.ok(assertEscrowGuardOpenApi(document), "exact EscrowGuard FINAL OpenAPI");
    const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
    ctx.equal(projectAggregate(snapshot, legacySeed.escrowId), preservedHistory, "pre-existing V1 resource, Work and Event identities remain byte-equivalent");
    ctx.equal(Object.keys(resources(snapshot)).sort(), ["beneficiaryPayouts", "beneficiaryShares", "disputes", "escrows", "milestones", "parties", "releases"], "exact FINAL resources");
    return finalEvidence(ctx, { preservedLegacyEscrowId: legacySeed.escrowId, legacyEscrowIds: [accepted.escrowId, resolved.escrowId], finalEscrowId: mixed.escrowId });
  },
});

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15]);
