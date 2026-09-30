import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { acknowledgementBody, agentCatalog, configurationBody, createFixtureFactory, deploymentBody, performanceContract, performanceSeed, stagedPlan, v1Seed } from "./fixtures.mjs";
import { canonical, sha256 } from "./oracle.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);
const BARRIER_KEYS = ["schemaVersion","processRole","point","workId","aggregateId","attempt","leaseTokenHash"];

function identity(_adapter,{ json }) { return json; }
function noAdapter(value) { if (value != null) throw new Error("ConfigRelay publishes no compatibility response adapter"); }

export function isConfigRelayBarrier(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...BARRIER_KEYS].sort())) return false;
  const point = value.processRole === "worker" ? ["worker.claimed","worker.effect-complete","worker.before-commit"].includes(value.point) : value.processRole === "dispatcher" && value.point === "dispatcher.response-received";
  return value.schemaVersion === 1 && point && typeof value.workId === "string" && typeof value.aggregateId === "string" && Number.isSafeInteger(value.attempt) && value.attempt >= 1 && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash);
}

const runtime = shared.createCaseRuntime({ taskSlug:"configrelay",databasePrefix:"cr",snapshotPath:"/api/v1/verification-snapshot",createFixtureFactory,adaptCompatibilityResponse:identity,assertCompatibilityAdapter:noAdapter,validateBarrierPayload:isConfigRelayBarrier });

class ScenarioFailure extends Error {
  constructor(message,options = {}) { super(message,{ cause:options.cause }); this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED"; this.hardCapIds = options.hardCapIds ?? []; }
}

class Evidence {
  constructor() { this.assertions = []; this.statuses = new Map(); this.metrics = {}; }
  check(label,operation,options = {}) {
    try { operation(); this.assertions.push({ label,status:"passed" }); }
    catch (cause) { this.assertions.push({ label,status:"failed" }); throw new ScenarioFailure(`${label}: ${cause?.message ?? cause}`,{ ...options,cause }); }
  }
  finish() { return { assertions:this.assertions,statuses:Object.fromEntries([...this.statuses.entries()].sort()),metrics:this.metrics }; }
}

async function decorate(ctx) {
  const evidence = new Evidence(), originalRequest = ctx.request, fixtureKey = ctx.key;
  let keys = 0, seeds = 0;
  ctx.evidence = evidence;
  ctx.key = (label) => fixtureKey(`${label}-${keys++}`);
  ctx.catalog = (options = {}) => agentCatalog(ctx.fixtures,options);
  ctx.seedFor = (version,options = {}) => v1Seed(ctx.fixtures,version,options);
  ctx.performanceSeed = (factor = 1) => performanceSeed(ctx.fixtures,factor);
  ctx.performanceContract = (factor = 1) => performanceContract(factor);
  ctx.stagedPlan = stagedPlan;
  ctx.configurationBody = configurationBody;
  ctx.deploymentBody = deploymentBody;
  ctx.acknowledgementBody = acknowledgementBody;
  ctx.assert = (label,operation,options) => evidence.check(label,operation,options);
  ctx.equal = (label,actual,expected,options) => evidence.check(label,() => assert.deepEqual(actual,expected),options);
  ctx.ok = (label,condition,message,options) => evidence.check(label,() => assert.ok(condition,message),options);
  ctx.metric = (name,value) => { evidence.metrics[name] = value; };
  ctx.sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
  ctx.canonical = canonical;
  ctx.sha256 = sha256;
  ctx.request = async (baseUrl,path,options = {}) => {
    const response = await originalRequest(baseUrl,path,options);
    if (options.record !== false) evidence.statuses.set(String(response.status),(evidence.statuses.get(String(response.status)) ?? 0) + 1);
    return response;
  };
  ctx.seed = async (value,options = {}) => {
    const path = ctx.tempPath(`configrelay-seed-${String(++seeds).padStart(3,"0")}.json`);
    await writeFile(path,JSON.stringify(value));
    const result = await ctx.npm("db:seed",["--file",path],{ workspace:options.workspace,timeoutMs:options.timeoutMs ?? 1_800_000,allowFailure:true });
    if (options.expectFailure) ctx.ok("invalid seed exits nonzero",result.exitCode !== 0,undefined,{ failureCodeSuffix:"SEED_ACCEPTED_INVALID" });
    else ctx.equal("valid seed exits zero",result.exitCode,0,{ failureCodeSuffix:"SEED_FAILED" });
    return result;
  };
  ctx.publishConfiguration = (url,fleetId,content,expectedFleetRevision,options = {}) => ctx.mutate(url,`/api/v1/fleets/${fleetId}/configurations`,options.key ?? ctx.key("configuration"),configurationBody(content,expectedFleetRevision),{ timeoutMs:options.timeoutMs,headers:options.headers,raw:options.raw });
  ctx.createDeployment = (url,body,options = {}) => ctx.mutate(url,"/api/v1/deployments",options.key ?? ctx.key("deployment"),body,{ timeoutMs:options.timeoutMs });
  ctx.getDeployment = (url,id) => ctx.request(url,`/api/v1/deployments/${id}`);
  ctx.listDeployments = (url,query = "limit=100") => ctx.request(url,`/api/v1/deployments?${query}`);
  ctx.cancelDeployment = (url,id,options = {}) => ctx.mutate(url,`/api/v1/deployments/${id}/cancel`,options.key ?? ctx.key("cancel"),{ reason:options.reason ?? "evaluator" });
  ctx.pollAgent = (url,agentId,appliedRevision,options = {}) => ctx.mutate(url,`/api/v1/agents/${agentId}/poll`,options.key ?? ctx.key("poll"),{ appliedRevision,...(Object.hasOwn(options,"lastCommandSequence") ? { lastCommandSequence:options.lastCommandSequence } : {}) },{ timeoutMs:options.timeoutMs });
  ctx.acknowledge = (url,agentId,command,outcome = "APPLIED",options = {}) => ctx.mutate(url,`/api/v1/agents/${agentId}/acknowledgements`,options.key ?? ctx.key("ack"),acknowledgementBody(command,outcome),{ timeoutMs:options.timeoutMs });
  ctx.getAgent = (url,id) => ctx.request(url,`/api/v1/agents/${id}`);
  ctx.getAssignments = (url,id) => ctx.request(url,`/api/v1/agents/${id}/assignments`);
  ctx.getEvents = (url,aggregateId,afterSequence = 0,limit = 100) => ctx.request(url,`/api/v1/domain-events?aggregateId=${aggregateId}&afterSequence=${afterSequence}&limit=${limit}`);
  ctx.workerBarrier = (points,predicate = () => true) => { const accepted = new Set(Array.isArray(points) ? points : [points]); return ctx.barrier({ hold:(payload) => payload.processRole === "worker" && accepted.has(payload.point) && predicate(payload) }); };
  ctx.dispatcherBarrier = (predicate = () => true) => ctx.barrier({ hold:(payload) => payload.processRole === "dispatcher" && payload.point === "dispatcher.response-received" && predicate(payload) });
  ctx.startWorkerAtBarrier = (barrier,options = {}) => ctx.startWorker({ ...options,env:{ TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:barrier.token,...options.env } });
  ctx.startDispatcherAtBarrier = (receiver,barrier,options = {}) => ctx.startDispatcher({ ...options,webhookUrl:receiver.url,env:{ TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:barrier.token,...options.env } });
  ctx.readOpenApi = async (url) => { const response = await ctx.request(url,"/openapi.json"); ctx.equal("OpenAPI returns 200",response.status,200); return response.json; };
  ctx.withPage = (api,viewport,operation) => withPage(ctx,api,viewport,operation);
  return ctx;
}

export async function createCaseContext(options) { return decorate(await runtime.createCaseContext(options)); }
export async function withCaseContext(options,operation) {
  if (options.caseId === "B-04") {
    const outcome = await operation(Object.freeze({ caseId:"B-04" }));
    return { ...outcome,evidence:{ assertions:[],statuses:{},metrics:{},caseEvidence:outcome?.evidence ?? [] } };
  }
  return runtime.withCaseContext(options,async (raw) => {
    const ctx = await decorate(raw);
    if (ctx.caseId !== "E-04") await ctx.migrate();
    const outcome = await operation(ctx);
    const unexpected = [...ctx.evidence.statuses].filter(([status]) => Number(status) >= 500).reduce((sum,[,count]) => sum + count,0);
    ctx.equal("no unexpected HTTP 5xx",unexpected,0);
    return { ...outcome,evidence:{ ...ctx.evidence.finish(),caseEvidence:outcome?.evidence ?? [] } };
  });
}

async function chromiumExecutable() {
  for (const candidate of [process.env.CHROMIUM_PATH,"/usr/bin/chromium","/usr/bin/chromium-browser","/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE","EVALUATOR_CHROMIUM_UNAVAILABLE");
}

async function withPage(ctx,api,viewport,operation) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE","EVALUATOR_PLAYWRIGHT_UNAVAILABLE",{ cause }); }
  const browser = await chromium.launch({ executablePath:await chromiumExecutable(),headless:true,args:["--no-sandbox","--disable-dev-shm-usage"] });
  const browserContext = await browser.newContext({ viewport,baseURL:api.baseUrl });
  const page = await browserContext.newPage(), errors = [];
  page.on("pageerror",(error) => errors.push(error.message));
  page.on("console",(message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) errors.push(message.text()); });
  try { await operation(page); ctx.equal("browser console clean",errors,[]); ctx.equal("browser has no horizontal overflow",await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),true); }
  finally { await browserContext.close(); await browser.close(); }
}

export const { CandidateResponseError,CommandError,EvaluationInfrastructureError,freePort,runCommand } = shared;
