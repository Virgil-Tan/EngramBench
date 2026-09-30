import { digestMembers } from "../lib/oracle.mjs";

export function defineCase(id,fixtureFamily,action,oracle,seams,run) {
  return Object.freeze({ id,taskId:"configrelay",fixtureFamily,action,oracle,seams:Object.freeze([...seams]),run });
}

export async function boot(ctx,options = {}) {
  const catalog = options.catalog ?? ctx.catalog(options.catalogOptions);
  if (options.seed !== false) await ctx.seed(options.seed ?? ctx.seedFor(options.seedVersion ?? `${ctx.caseId.toLowerCase()}-v1`,{ catalog,...options.seedOptions }));
  const apis = [];
  for (let index=0;index < (options.apiCount ?? 1);index += 1) apis.push(await ctx.startApi());
  return { catalog,apis,api:apis[0] };
}

export function expectStatus(ctx,response,status,label = "HTTP status") {
  ctx.equal(label,response.status,status);
  return response.json;
}

export function expectError(ctx,response,status,code,options) {
  const { assertPublicError } = ctx.oracle ?? {};
  if (assertPublicError) ctx.assert(`${code} exact error`,() => assertPublicError(response,status,code),options);
  else {
    ctx.equal(`${code} status`,response.status,status,options);
    ctx.equal(`${code} code`,response.json?.error?.code,code,options);
    ctx.equal(`${code} envelope keys`,Object.keys(response.json ?? {}).sort(),["error"],options);
    ctx.equal(`${code} shape`,Object.keys(response.json?.error ?? {}).sort(),["code","details","message"],options);
  }
  return response;
}

export async function snapshot(ctx,url,options = {}) {
  const value = await ctx.snapshot(url,options);
  ctx.equal("snapshot top-level shape",Object.keys(value).sort(),["asOf","events","resources","work"]);
  return value;
}

export function deploymentFrom(state,id) { return state.resources.deployments.find(({ deploymentId }) => deploymentId === id); }
export function cohortFrom(state,id) { return state.resources.deploymentCohorts?.find(({ cohortId }) => cohortId === id); }
export function assignmentFrom(state,id) { return state.resources.assignments.find(({ assignmentId }) => assignmentId === id); }
export function commandsFor(state,deploymentId) { return (state.resources.rolloutCommands ?? []).filter((item) => item.deploymentId === deploymentId); }
export function cohortsFor(state,deploymentId) { return (state.resources.deploymentCohorts ?? []).filter((item) => item.deploymentId === deploymentId).sort((left,right) => left.ordinal-right.ordinal); }
export function rollbackFor(state,deploymentId) { return (state.resources.deploymentRollbacks ?? []).find((item) => item.deploymentId === deploymentId); }
export function eventsFor(state,aggregateId) { return state.events.filter((event) => event.aggregateId === aggregateId); }
export function workFor(state,kind,aggregateId) { return state.work.filter((item) => item.kind === kind && (aggregateId === undefined || item.aggregateId === aggregateId)); }

export async function createLegacy(ctx,url,catalog,options = {}) {
  const response = await ctx.createDeployment(url,ctx.deploymentBody(catalog,options),{ key:options.key });
  ctx.equal("legacy Deployment create status",response.status,202);
  return response.json;
}

export async function createStaged(ctx,url,catalog,cohorts = ctx.stagedPlan(catalog),options = {}) {
  const response = await ctx.createDeployment(url,ctx.deploymentBody(catalog,{ ...options,cohorts }),{ key:options.key });
  ctx.equal("staged Deployment create status",response.status,202);
  return response.json;
}

export async function waitForCommand(ctx,url,agent,options = {}) {
  return ctx.waitFor(async () => {
    const response = await ctx.pollAgent(url,agent.agentId,agent.appliedRevision,{ lastCommandSequence:options.lastCommandSequence });
    return response.status === 200 && response.json?.status === "COMMAND" ? response.json.command : undefined;
  },{ label:options.label ?? `command for ${agent.agentId}`,timeoutMs:options.timeoutMs ?? 30_000,processes:options.processes ?? [] });
}

export async function waitForState(ctx,url,select,predicate,options = {}) {
  return ctx.waitFor(async () => {
    const state = await ctx.snapshot(url,{ timeoutMs:options.requestTimeoutMs });
    const selected = select(state);
    return predicate(selected,state) ? { selected,state } : undefined;
  },{ label:options.label ?? "durable ConfigRelay state",timeoutMs:options.timeoutMs ?? 30_000,intervalMs:options.intervalMs ?? 100,processes:options.processes ?? [] });
}

export function assertFrozenTarget(ctx,deployment,agents) {
  const ids = agents.map(({ agentId }) => agentId);
  ctx.equal("frozen target count",deployment.targetCount,ids.length,{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
  ctx.equal("frozen target digest",deployment.targetDigest,digestMembers(ids),{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
}

export function stableResponses(ctx,responses,label,options = {}) {
  const first = responses[0];
  ctx.ok(`${label} returned at least once`,Boolean(first));
  ctx.equal(`${label} statuses are stable`,new Set(responses.map(({ status }) => status)).size,1,options);
  ctx.equal(`${label} semantic bodies are stable`,new Set(responses.map(({ json }) => ctx.canonical(json))).size,1,options);
  return first;
}

export async function resetFixture(ctx,options = {}) {
  await ctx.resetDatabase();
  await ctx.migrate();
  return boot(ctx,options);
}

export async function stopAll(ctx,records) { for (const record of records) await ctx.stop(record); }

export function activeWork(state,kind) { return state.work.filter((item) => item.kind === kind && !item.terminal); }
