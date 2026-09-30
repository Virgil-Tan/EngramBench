import { seededAssignment, seededLegacyDeployment, v1Seed } from "../lib/fixtures.mjs";
import { assertAgentPoll, percentile, reconcileSnapshot } from "../lib/oracle.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import { activeWork, boot, createLegacy, defineCase, snapshot, stableResponses, waitForCommand, waitForState } from "./helpers.mjs";

function factor() {
  const value = Number(process.env.BENCH_PERF_SCALE ?? "1");
  if (!(value > 0 && value <= 1)) throw new Error("BENCH_PERF_SCALE must be in (0,1]");
  return value;
}

function bytewiseAgents(agents) {
  return [...agents].sort((left,right) => Buffer.compare(Buffer.from(left.agentId),Buffer.from(right.agentId)));
}

async function waitDeliveryDrain(ctx,url,workers,expected,timeoutMs = 180_000) {
  return waitForState(ctx,url,(state) => ({ sent:state.resources.assignments.filter(({ state:assignmentState }) => assignmentState === "SENT").length,active:activeWork(state,"ASSIGNMENT_DELIVERY").length,state }),(value) => value.sent === expected && value.active === 0,{ label:`${expected} Assignment deliveries`,timeoutMs,intervalMs:500,requestTimeoutMs:30_000,processes:workers });
}

async function pollBlock(ctx,url,commandAgents,currentAgents,startIndex,records,latencies) {
  const operations = Array.from({ length:100 },(_item,index) => ({ command:index < 50,index:startIndex + Math.floor(index / 50) }));
  const responses = await ctx.concurrent(operations,64,async ({ command,index }) => {
    const pool = command ? commandAgents : currentAgents, agent = pool[index % pool.length], response = await ctx.pollAgent(url,agent.agentId,agent.appliedRevision,{ timeoutMs:10_000 });
    if (response.status !== 200) throw new Error(`poll returned ${response.status}`);
    assertAgentPoll(response.json);
    const expected = command ? "COMMAND" : "NO_CHANGE";
    if (response.json.status !== expected) throw new Error(`poll mix expected ${expected} for ${agent.agentId}`);
    if (command) {
      if (response.json.command.agentId !== agent.agentId) throw new Error("Agent command identity mix-up");
      const prior = records.get(agent.agentId), identity = ctx.canonical(response.json.command);
      if (prior && prior !== identity) throw new Error("Agent command identity changed during load");
      records.set(agent.agentId,identity);
    }
    latencies?.push(response.durationMs);
    return response;
  });
  return responses.length;
}

const E01 = defineCase(
  "E-01",
  "Published perf-v1 seed with 50000 command-eligible and 50000 current Agents",
  "Drain delivery setup, run disjoint warm-up identities and exact 100-request 50/50 blocks through 64 closed-loop clients for the fixed interval",
  "Require exact poll bodies, bytewise subgroup round-robin, 2000 per second, p95 80 ms, stable command identity and full post-load sequence/digest closure",
  ["seed-command","public-http","agent-poll","worker-process","performance-load","verification-snapshot"],
  async (ctx) => {
    const scale = factor(), contract = ctx.performanceContract(scale), seed = ctx.performanceSeed(scale);
    await ctx.seed(seed,{ timeoutMs:1_800_000 });
    const api = await ctx.startApi(), workers = [await ctx.startWorker(),await ctx.startWorker()];
    await waitDeliveryDrain(ctx,api.baseUrl,workers,contract.seed.assignmentCount,Math.max(180_000,contract.delivery.maximumSeconds * 2_000));
    const commandAgents = bytewiseAgents(seed.agents.slice(0,contract.seed.assignmentCount)), currentAgents = bytewiseAgents(seed.agents.slice(contract.seed.assignmentCount));
    const warmCommandCount = Math.max(1,Math.min(Math.floor(commandAgents.length / 10),5_000)), warmCurrentCount = Math.max(1,Math.min(Math.floor(currentAgents.length / 10),5_000));
    const warmCommands = commandAgents.slice(0,warmCommandCount), warmCurrent = currentAgents.slice(0,warmCurrentCount), measuredCommands = commandAgents.slice(warmCommandCount), measuredCurrent = currentAgents.slice(warmCurrentCount);
    ctx.ok("performance subgroups have disjoint warm-up and measurement identities",measuredCommands.length > 0 && measuredCurrent.length > 0);
    const warmDeadline = performance.now() + contract.poll.warmupSeconds * 1000, identities = new Map(); let block = 0;
    while (performance.now() < warmDeadline) { await pollBlock(ctx,api.baseUrl,warmCommands,warmCurrent,block * 50,identities); block += 1; }
    const latencies = [], start = performance.now(), deadline = start + contract.poll.measureSeconds * 1000; let successes = 0; block = 0;
    while (performance.now() < deadline) { successes += await pollBlock(ctx,api.baseUrl,measuredCommands,measuredCurrent,block * 50,identities,latencies); block += 1; }
    const elapsedSeconds = (performance.now() - start) / 1000, rate = successes / elapsedSeconds, p95 = percentile(latencies,.95);
    ctx.metric("successfulPolls",successes); ctx.metric("throughputPerSecond",rate); ctx.metric("p50Ms",percentile(latencies,.5)); ctx.metric("p95Ms",p95); ctx.metric("p99Ms",percentile(latencies,.99));
    ctx.ok("poll throughput meets published target",rate >= contract.poll.targetPerSecond);
    ctx.ok("poll p95 meets published target",p95 <= contract.poll.p95Ms);
    ctx.equal("each complete block has exact 50/50 mix",successes % 100,0);
    const final = await snapshot(ctx,api.baseUrl,{ timeoutMs:60_000 });
    ctx.assert("post-poll FINAL snapshot reconciles",() => reconcileSnapshot(final),{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    ctx.equal("poll load does not acknowledge commands",final.resources.acknowledgements.length,0);
    ctx.equal("all delivery Work stays drained",activeWork(final,"ASSIGNMENT_DELIVERY").length,0);
    return { evidence:[contract.seed,successes,elapsedSeconds,rate,p95,identities.size] };
  },
);

async function collectCommands(ctx,url,workers,agents) {
  return ctx.concurrent(agents,64,(agent) => waitForCommand(ctx,url,agent,{ processes:workers,timeoutMs:120_000 }));
}

async function acknowledgementPairs(ctx,url,commands,startIndex,latencies) {
  return ctx.concurrent(commands,64,async (command,index) => {
    const outcome = (startIndex + index) % 10 === 9 ? "REJECTED" : "APPLIED", key = ctx.key(`perf-ack-${startIndex + index}`);
    const first = await ctx.acknowledge(url,command.agentId,command,outcome,{ key,timeoutMs:10_000 }), replay = await ctx.acknowledge(url,command.agentId,command,outcome,{ key,timeoutMs:10_000 });
    if (first.status !== 200 || replay.status !== 200 || ctx.canonical(first.json) !== ctx.canonical(replay.json)) throw new Error("acknowledgement pair was not an exact successful replay");
    latencies?.push(first.durationMs,replay.durationMs);
    return { outcome,first,replay };
  });
}

const E02 = defineCase(
  "E-02",
  "Published 5000 warm-up plus 30000 measured disjoint Assignment acknowledgement identities",
  "Poll exact tokens before timing and run 90 percent APPLIED, 10 percent REJECTED unique requests each followed by one same-key byte-identical replay",
  "Require the exact 45/5/50 request mix, 1000 responses per second, p95 180 ms and one terminal state, Agent and Event effect per unique Assignment",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","performance-load","verification-snapshot"],
  async (ctx) => {
    const scale = factor(), contract = ctx.performanceContract(scale), seed = ctx.performanceSeed(scale);
    await ctx.seed(seed,{ timeoutMs:1_800_000 });
    const api = await ctx.startApi(), workers = [await ctx.startWorker(),await ctx.startWorker()];
    await waitDeliveryDrain(ctx,api.baseUrl,workers,contract.seed.assignmentCount,Math.max(180_000,contract.delivery.maximumSeconds * 2_000));
    const uniqueCount = contract.acknowledgement.warmupUnique + contract.acknowledgement.measuredUnique, agents = bytewiseAgents(seed.agents.slice(0,contract.seed.assignmentCount)).slice(0,uniqueCount), commands = await collectCommands(ctx,api.baseUrl,workers,agents);
    ctx.equal("poll setup obtains every exact command",commands.length,uniqueCount);
    const warmup = commands.slice(0,contract.acknowledgement.warmupUnique), measured = commands.slice(contract.acknowledgement.warmupUnique), warmStart = performance.now();
    await acknowledgementPairs(ctx,api.baseUrl,warmup,0);
    const warmRemaining = contract.acknowledgement.warmupSeconds * 1000 - (performance.now() - warmStart); if (warmRemaining > 0) await ctx.sleep(warmRemaining);
    const latencies = [], start = performance.now(), pairs = await acknowledgementPairs(ctx,api.baseUrl,measured,contract.acknowledgement.warmupUnique,latencies), workMs = performance.now() - start, remaining = contract.acknowledgement.measureSeconds * 1000 - workMs; if (remaining > 0) await ctx.sleep(remaining);
    const responses = pairs.length * 2, elapsedSeconds = Math.max(contract.acknowledgement.measureSeconds,workMs / 1000), rate = responses / elapsedSeconds, p95 = percentile(latencies,.95), applied = pairs.filter(({ outcome }) => outcome === "APPLIED").length, rejected = pairs.length - applied;
    ctx.metric("successfulResponses",responses); ctx.metric("throughputPerSecond",rate); ctx.metric("p50Ms",percentile(latencies,.5)); ctx.metric("p95Ms",p95); ctx.metric("p99Ms",percentile(latencies,.99)); ctx.metric("uniqueApplied",applied); ctx.metric("uniqueRejected",rejected);
    ctx.ok("acknowledgement throughput meets target",rate >= contract.acknowledgement.targetPerSecond);
    ctx.ok("acknowledgement p95 meets target",p95 <= contract.acknowledgement.p95Ms);
    ctx.equal("request mix is exact 45/5/50",[applied,rejected,pairs.length],[Math.floor(pairs.length * .9),pairs.length-Math.floor(pairs.length * .9),pairs.length]);
    const final = await snapshot(ctx,api.baseUrl,{ timeoutMs:60_000 });
    ctx.assert("post-ack FINAL snapshot reconciles",() => reconcileSnapshot(final),{ hardCapIds:["IDEMPOTENCY_CORRECTNESS","ORDERED_DELIVERY_CORRECTNESS"] });
    ctx.equal("one Acknowledgement per unique request",final.resources.acknowledgements.length,uniqueCount);
    const assignmentStates = new Map(final.resources.assignments.map(({ assignmentId,state }) => [assignmentId,state]));
    ctx.equal("measured Assignments change state once",measured.filter((command) => ["ACKED","FAILED"].includes(assignmentStates.get(command.assignmentId))).length,measured.length);
    return { evidence:[contract.seed,responses,rate,p95,applied,rejected] };
  },
);

const E03 = defineCase(
  "E-03",
  "Published 50000 distinct WAITING Assignments and two claimed worker deaths",
  "Hold two workers at claimed, SIGKILL both, wait for lease expiry, start exactly two replacements and time the point-in-time SENT and drain proof",
  "Require every original deliveryId and commandSequence, all retained Work attempts and complete Agent/Deployment reconciliation within 120 seconds",
  ["seed-command","worker-process","performance-load","verification-snapshot"],
  async (ctx) => {
    const scale = factor(), contract = ctx.performanceContract(scale), seed = ctx.performanceSeed(scale);
    await ctx.seed(seed,{ timeoutMs:1_800_000 });
    const api = await ctx.startApi(), barrier = await ctx.workerBarrier("worker.claimed"), originals = [await ctx.startWorkerAtBarrier(barrier),await ctx.startWorkerAtBarrier(barrier)];
    const held = await ctx.waitFor(() => {
      const entries = barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed"), distinct = new Map(entries.map((entry) => [entry.json.workId,entry]));
      return distinct.size >= 2 ? [...distinct.values()].slice(0,2) : undefined;
    },{ label:"two distinct claimed delivery tasks",timeoutMs:30_000,processes:originals });
    for (const worker of originals) await ctx.kill(worker);
    await ctx.sleep(3_250);
    const start = performance.now(), replacements = [await ctx.startWorker(),await ctx.startWorker()];
    const drained = await waitDeliveryDrain(ctx,api.baseUrl,replacements,contract.delivery.assignmentCount,contract.delivery.maximumSeconds * 1000), elapsedSeconds = (performance.now() - start) / 1000;
    ctx.metric("deliveredAssignments",drained.selected.sent); ctx.metric("elapsedSeconds",elapsedSeconds); ctx.metric("throughputPerSecond",drained.selected.sent / elapsedSeconds);
    ctx.ok("delivery recovery meets fixed deadline",elapsedSeconds <= contract.delivery.maximumSeconds);
    const expected = new Map(seed.assignments.map((assignment) => [assignment.assignmentId,{ deliveryId:assignment.deliveryId,commandSequence:assignment.commandSequence }]));
    ctx.equal("every Assignment reaches SENT",drained.state.resources.assignments.filter(({ state }) => state === "SENT").length,contract.delivery.assignmentCount);
    const mismatches = drained.state.resources.assignments.filter((assignment) => ctx.canonical({ deliveryId:assignment.deliveryId,commandSequence:assignment.commandSequence }) !== ctx.canonical(expected.get(assignment.assignmentId))).map(({ assignmentId }) => assignmentId);
    ctx.equal("recovery preserves every delivery identity and sequence",mismatches,[],{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
    ctx.ok("killed claims advance retained attempts",held.every((entry) => { const work = drained.state.work.find(({ workId }) => workId === entry.json.workId); return work?.terminal && work.attempt >= entry.json.attempt + 1; }));
    ctx.assert("post-recovery snapshot reconciles",() => reconcileSnapshot(drained.state),{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
    return { evidence:[contract.seed,elapsedSeconds,held.map((entry) => entry.json.workId)] };
  },
);

const E04 = defineCase(
  "E-04",
  "Populated V1 Assignments, saved create/ack/cancel responses, leased delivery Work and an unknown dispatcher acknowledgement",
  "Build only through the frozen V1 binary and exact seed, record public observations, migrate the same database with FINAL and replay/recover every operation",
  "Compare identities, semantic bodies, sequences, tokens, Work attempts and Events while requiring one compatibility Cohort and forbidding RolloutCommand replacement, rollback or downgrade",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","dispatcher-process","v1-migration","verification-snapshot"],
  async (ctx) => {
    if (!ctx.v1Workspace) throw new EvaluationInfrastructureError("EVALUATOR_V1_WORKSPACE_REQUIRED","EVALUATOR_V1_WORKSPACE_REQUIRED");
    const v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate();
    const catalog = ctx.catalog({ count:3 }), seededDeployment = seededLegacyDeployment(ctx.fixtures,catalog,"migration"), seededAssignments = catalog.agents.map((agent,index) => seededAssignment(ctx.fixtures,seededDeployment,agent,index,{ digest:catalog.configuration.canonicalDigest,state:index === 1 ? "SENT" : "WAITING",sentAt:index === 1 ? ctx.at({ seconds:2 }) : null }));
    catalog.agents.forEach((agent) => { agent.lastCommandSequence = 1; });
    const seed = v1Seed(ctx.fixtures,"e04-v1",{ catalog,deployments:[seededDeployment],assignments:seededAssignments });
    await ctx.seed(seed,{ workspace:v1.workspace,timeoutMs:1_800_000 });
    const v1Api = await v1.startApi(), createKey = ctx.key("saved-create"), createBody = ctx.deploymentBody(catalog), created = await ctx.createDeployment(v1Api.baseUrl,createBody,{ key:createKey });
    ctx.equal("V1 create status",created.status,202);
    const worker = await v1.startWorker(), command = await waitForCommand(ctx,v1Api.baseUrl,catalog.agents[0],{ processes:[worker] }), ackKey = ctx.key("saved-ack"), acked = await ctx.acknowledge(v1Api.baseUrl,command.agentId,command,"APPLIED",{ key:ackKey });
    ctx.equal("V1 acknowledgement status",acked.status,200);
    const cancelKey = ctx.key("saved-cancel"), cancelled = await ctx.cancelDeployment(v1Api.baseUrl,created.json.deploymentId,{ key:cancelKey });
    ctx.equal("V1 cancellation status",cancelled.status,200);
    await ctx.stop(worker);
    const inFlight = await createLegacy(ctx,v1Api.baseUrl,catalog,{ key:ctx.key("inflight-create") }), workerBarrier = await ctx.workerBarrier("worker.claimed"), leasedWorker = await v1.startWorker({ env:{ TEST_BARRIER_URL:workerBarrier.url,TEST_BARRIER_TOKEN:workerBarrier.token } });
    const heldWork = await workerBarrier.waitFor(() => true,{ label:"V1 leased delivery Work",timeoutMs:20_000,processes:[leasedWorker] });
    const receiver = await ctx.receiver(() => ({ status:204 })), dispatcherBarrier = await ctx.dispatcherBarrier(), v1Dispatcher = await v1.startDispatcher({ webhookUrl:receiver.url,env:{ TEST_BARRIER_URL:dispatcherBarrier.url,TEST_BARRIER_TOKEN:dispatcherBarrier.token } });
    const heldDispatch = await dispatcherBarrier.waitFor(() => true,{ label:"V1 unknown Event acknowledgement",timeoutMs:20_000,processes:[v1Dispatcher] }), unknownDelivery = receiver.ledger.find((entry) => entry.json?.eventId);
    const before = await ctx.snapshot(v1Api.baseUrl), saved = {
      create:await ctx.createDeployment(v1Api.baseUrl,createBody,{ key:createKey }),
      ack:await ctx.acknowledge(v1Api.baseUrl,command.agentId,command,"APPLIED",{ key:ackKey }),
      cancel:await ctx.cancelDeployment(v1Api.baseUrl,created.json.deploymentId,{ key:cancelKey }),
    };
    await ctx.kill(leasedWorker); await ctx.kill(v1Dispatcher); await ctx.stop(v1Api);
    await ctx.migrate();
    const finalApi = await ctx.startApi(), afterMigration = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal("FINAL snapshot resource union",Object.keys(afterMigration.resources).sort(),["acknowledgements","agents","assignments","configurations","deploymentCohorts","deploymentRollbacks","deployments","rolloutCommands"].sort());
    const beforeAssignments = new Map(before.resources.assignments.map((item) => [item.assignmentId,item]));
    for (const assignment of afterMigration.resources.assignments) if (beforeAssignments.has(assignment.assignmentId)) ctx.equal("V1 Assignment identity and body survive",assignment,beforeAssignments.get(assignment.assignmentId),{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    ctx.equal("migration preserves committed Event identity and body",afterMigration.events.filter(({ eventId }) => before.events.some((event) => event.eventId === eventId)),before.events,{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    ctx.equal("migration creates no synthetic RolloutCommand or rollback",[afterMigration.resources.rolloutCommands.length,afterMigration.resources.deploymentRollbacks.length],[0,0],{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    const migratedDeploymentIds = new Set(before.resources.deployments.map(({ deploymentId }) => deploymentId));
    ctx.equal("each V1 Deployment gains one compatibility Cohort",afterMigration.resources.deploymentCohorts.filter(({ deploymentId }) => migratedDeploymentIds.has(deploymentId)).length,migratedDeploymentIds.size);
    const replayed = {
      create:await ctx.createDeployment(finalApi.baseUrl,createBody,{ key:createKey }),
      ack:await ctx.acknowledge(finalApi.baseUrl,command.agentId,command,"APPLIED",{ key:ackKey }),
      cancel:await ctx.cancelDeployment(finalApi.baseUrl,created.json.deploymentId,{ key:cancelKey }),
    };
    for (const name of ["create","ack","cancel"]) ctx.equal(`saved ${name} response survives migration`,[replayed[name].status,ctx.canonical(replayed[name].json)],[saved[name].status,ctx.canonical(saved[name].json)],{ hardCapIds:["MIGRATION_CORRECTNESS","IDEMPOTENCY_CORRECTNESS"] });
    await ctx.sleep(3_250);
    const finalWorkers = [await ctx.startWorker(),await ctx.startWorker()], finalDispatcher = await ctx.startDispatcher({ webhookUrl:receiver.url });
    const recovered = await waitForState(ctx,finalApi.baseUrl,(state) => ({ work:state.work.find(({ workId }) => workId === heldWork.json.workId),deployment:state.resources.deployments.find(({ deploymentId }) => deploymentId === inFlight.deploymentId) }),(value) => value.work?.terminal,{ label:"migrated in-flight Work recovery",timeoutMs:30_000,processes:finalWorkers });
    ctx.ok("migrated Work retains identity and advances attempt",recovered.selected.work.attempt >= heldWork.json.attempt + 1,undefined,{ hardCapIds:["MIGRATION_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
    const retried = await ctx.waitFor(() => { const matching = receiver.ledger.filter((entry) => entry.json?.eventId === unknownDelivery.json.eventId); return matching.length >= 2 ? matching : undefined; },{ label:"migrated dispatcher retry",timeoutMs:30_000,processes:[finalDispatcher] });
    ctx.equal("migrated dispatcher preserves Event header identity",new Set(retried.map((entry) => entry.headers["x-configrelay-event-id"])).size,1,{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    ctx.equal("migrated dispatcher preserves semantic body",new Set(retried.map((entry) => ctx.canonical(entry.json))).size,1,{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    const final = await snapshot(ctx,finalApi.baseUrl);
    ctx.assert("migrated FINAL snapshot reconciles",() => reconcileSnapshot(final),{ hardCapIds:["MIGRATION_CORRECTNESS"] });
    ctx.ok("migration never lowers an Agent revision",final.resources.agents.every((agent) => { const prior = before.resources.agents.find(({ agentId }) => agentId === agent.agentId); return !prior || agent.appliedRevision >= prior.appliedRevision; }));
    return { evidence:[seededDeployment.deploymentId,created.json.deploymentId,inFlight.deploymentId,heldWork.json.workId,heldDispatch.json.workId] };
  },
);

export const E_CASES = [E01,E02,E03,E04];
