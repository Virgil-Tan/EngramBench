import { assertEvent, assertRolloutCommand, canonical } from "../lib/oracle.mjs";
import { activeWork, assignmentFrom, boot, createLegacy, createStaged, defineCase, resetFixture, rollbackFor, snapshot, waitForCommand, waitForState, workFor } from "./helpers.mjs";

const BARRIERS = ["worker.claimed","worker.effect-complete","worker.before-commit"];

const C01 = defineCase(
  "C-01",
  "One isolated ASSIGNMENT_DELIVERY database for each published worker barrier",
  "Hold the exact Work, SIGKILL its worker, wait for persisted lease expiry and start a replacement before polling the Agent",
  "Trace retained workId and attempts, require one WAITING-to-SENT effect, stable delivery identity and no stale-owner Event or sequence effect",
  ["seed-command","public-http","agent-poll","worker-process","verification-snapshot"],
  async (ctx) => {
    const evidence = [];
    for (const point of BARRIERS) {
      const { catalog,api } = await resetFixture(ctx,{ catalogOptions:{ count:1 },seedVersion:`c01-${point.replaceAll(".","-")}` });
      const deployment = await createLegacy(ctx,api.baseUrl,catalog);
      const before = await snapshot(ctx,api.baseUrl), work = activeWork(before,"ASSIGNMENT_DELIVERY")[0], assignment = before.resources.assignments.find(({ deploymentId }) => deploymentId === deployment.deploymentId);
      ctx.ok(`${point} has pending delivery Work`,Boolean(work && assignment));
      const barrier = await ctx.workerBarrier(point,(payload) => payload.workId === work.workId), original = await ctx.startWorkerAtBarrier(barrier);
      const held = await barrier.waitFor((entry) => entry.json.workId === work.workId,{ processes:[original],timeoutMs:15_000 });
      ctx.equal(`${point} barrier identity`,held.json,{ schemaVersion:1,processRole:"worker",point,workId:work.workId,aggregateId:work.aggregateId,attempt:held.json.attempt,leaseTokenHash:held.json.leaseTokenHash });
      await ctx.kill(original);
      await ctx.sleep(3_250);
      const replacement = await ctx.startWorker();
      const settled = await waitForState(ctx,api.baseUrl,(state) => ({ assignment:assignmentFrom(state,assignment.assignmentId),work:state.work.find(({ workId }) => workId === work.workId) }),(value) => value.assignment?.state === "SENT" && value.work?.terminal,{ label:`${point} replacement drain`,timeoutMs:20_000,processes:[replacement] });
      ctx.equal(`${point} deliveryId survives retry`,settled.selected.assignment.deliveryId,assignment.deliveryId,{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
      ctx.ok(`${point} Work attempt advances`,settled.selected.work.attempt >= held.json.attempt + 1);
      const command = await waitForCommand(ctx,api.baseUrl,catalog.agents[0],{ processes:[replacement] });
      ctx.equal(`${point} public poll returns retained delivery`,command.deliveryId,assignment.deliveryId);
      ctx.equal(`${point} emits one assignment.sent Event`,settled.state.events.filter(({ type }) => type === "assignment.sent").length,1);
      evidence.push({ point,workId:work.workId,deliveryId:command.deliveryId,attempt:settled.selected.work.attempt });
    }
    return { evidence };
  },
);

async function deadlineRecovery(ctx,point,index) {
  const nonLastFailure = index % 2 === 0;
  const catalogOptions = nonLastFailure ? { count:2,cohortCount:2 } : { count:1,cohortCount:1 };
  const { catalog,api } = await resetFixture(ctx,{ catalogOptions,seedVersion:`c02-${index}` });
  const plan = nonLastFailure ? [
    { name:"Must fail",selector:{ labels:{ key:"cohort",value:"c0" } },minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:1 },
    { name:"Unstarted",selector:{ labels:{ key:"cohort",value:"c1" } },minimumSuccessBasisPoints:0,maximumFailureBasisPoints:10_000,observationSeconds:60 },
  ] : [{ name:"Last succeeds",selector:catalog.outerSelector,minimumSuccessBasisPoints:0,maximumFailureBasisPoints:10_000,observationSeconds:1 }];
  const deployment = await createStaged(ctx,api.baseUrl,catalog,plan), activeAgent = catalog.agents[0];
  const deliveryWorker = await ctx.startWorker(), command = await waitForCommand(ctx,api.baseUrl,activeAgent,{ processes:[deliveryWorker] });
  await ctx.stop(deliveryWorker);
  const cohortId = deployment.cohorts[0].cohortId;
  const before = await snapshot(ctx,api.baseUrl), deadline = workFor(before,"COHORT_DEADLINE",cohortId)[0] ?? workFor(before,"COHORT_DEADLINE")[0];
  ctx.ok(`${point} deadline Work exists`,Boolean(deadline));
  const barrier = await ctx.workerBarrier(point,(payload) => payload.workId === deadline.workId), original = await ctx.startWorkerAtBarrier(barrier);
  const held = await barrier.waitFor((entry) => entry.json.workId === deadline.workId,{ timeoutMs:15_000,processes:[original] });
  await ctx.kill(original);
  const acknowledgementFirst = index % 2 === 0;
  let ack;
  if (acknowledgementFirst) ack = await ctx.acknowledge(api.baseUrl,command.agentId,command,nonLastFailure ? "REJECTED" : "APPLIED");
  await ctx.sleep(3_250);
  const replacement = await ctx.startWorker();
  const wanted = nonLastFailure ? "FAILED" : "SUCCEEDED";
  let settled;
  if (acknowledgementFirst) {
    settled = await waitForState(ctx,api.baseUrl,(state) => state.resources.deploymentCohorts.find(({ cohortId:id }) => id === cohortId),(cohort) => cohort?.state === wanted,{ label:`${point} acknowledgement-first verdict`,timeoutMs:20_000,processes:[replacement] });
  } else {
    settled = await waitForState(ctx,api.baseUrl,(state) => state.resources.deploymentCohorts.find(({ cohortId:id }) => id === cohortId),(cohort) => cohort?.state === wanted,{ label:`${point} deadline-first verdict`,timeoutMs:20_000,processes:[replacement] });
    ack = await ctx.acknowledge(api.baseUrl,command.agentId,command,nonLastFailure ? "REJECTED" : "APPLIED");
  }
  ctx.ok(`${point} race acknowledgement has published outcome`,[200,409].includes(ack.status));
  ctx.equal(`${point} counts conserve target`,settled.selected.successCount + settled.selected.failureCount + settled.selected.pendingCount,settled.selected.targetCount,{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS"] });
  ctx.equal(`${point} no dual health verdict`,settled.state.resources.deploymentCohorts.filter(({ cohortId:id,state }) => id === cohortId && ["SUCCEEDED","FAILED"].includes(state)).length,1);
  const retained = settled.state.work.find(({ workId }) => workId === deadline.workId);
  ctx.ok(`${point} deadline Work retained and fenced`,retained?.terminal && retained.attempt >= held.json.attempt + (acknowledgementFirst ? 0 : 1));
  if (nonLastFailure) ctx.ok(`${point} failure creates one rollback`,Boolean(rollbackFor(settled.state,deployment.deploymentId)));
  else ctx.equal(`${point} last success creates no rollback`,rollbackFor(settled.state,deployment.deploymentId),undefined);
  return { point,acknowledgementFirst,state:wanted,workId:deadline.workId };
}

const C02 = defineCase(
  "C-02",
  "Non-last Cohort that must fail and last Cohort that must succeed without observing successor activation",
  "At each deadline barrier kill the owner and alternate final acknowledgement before versus after replacement startup",
  "Require stale fencing, one conserved verdict, exactly one rollback only for failure and no assertion about a successful next Cohort",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const results = [];
    for (let index=0;index<BARRIERS.length;index += 1) results.push(await deadlineRecovery(ctx,BARRIERS[index],index));
    ctx.equal("both acknowledgement commit orders execute",new Set(results.map(({ acknowledgementFirst }) => acknowledgementFirst)).size,2);
    return { evidence:results };
  },
);

async function rollbackRecovery(ctx,point,index) {
  const { catalog,api } = await resetFixture(ctx,{ catalogOptions:{ count:2,cohortCount:1 },seedVersion:`c03-${index}` });
  const plan = [{ name:"Rollback",selector:catalog.outerSelector,minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:60 }];
  const deployment = await createStaged(ctx,api.baseUrl,catalog,plan), deliveryWorker = await ctx.startWorker();
  const apply = await ctx.concurrent(catalog.agents,2,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[deliveryWorker] }));
  await ctx.stop(deliveryWorker);
  await ctx.acknowledge(api.baseUrl,apply[0].agentId,apply[0],"APPLIED");
  await ctx.acknowledge(api.baseUrl,apply[1].agentId,apply[1],"REJECTED");
  const frozen = await snapshot(ctx,api.baseUrl), rollback = rollbackFor(frozen,deployment.deploymentId), rollbackCommand = frozen.resources.rolloutCommands.find(({ deploymentId,kind }) => deploymentId === deployment.deploymentId && kind === "ROLLBACK"), work = activeWork(frozen,"ROLLBACK_DELIVERY")[0];
  ctx.ok(`${point} has one frozen rollback fanout`,Boolean(rollback && rollbackCommand && work && rollback.commandCount === 1));
  const stable = { commandId:rollbackCommand.commandId,deliveryId:rollbackCommand.deliveryId,agentId:rollbackCommand.agentId,commandSequence:rollbackCommand.commandSequence };
  const barrier = await ctx.workerBarrier(point,(payload) => payload.workId === work.workId), original = await ctx.startWorkerAtBarrier(barrier);
  const held = await barrier.waitFor((entry) => entry.json.workId === work.workId,{ timeoutMs:15_000,processes:[original] });
  await ctx.kill(original);
  await ctx.sleep(3_250);
  const replacements = [await ctx.startWorker(),await ctx.startWorker()];
  const delivered = await waitForState(ctx,api.baseUrl,(state) => ({ command:state.resources.rolloutCommands.find(({ commandId }) => commandId === stable.commandId),work:state.work.find(({ workId }) => workId === work.workId),rollback:rollbackFor(state,deployment.deploymentId) }),(value) => value.command?.state === "SENT" && value.work?.terminal,{ label:`${point} rollback delivery drain`,timeoutMs:20_000,processes:replacements });
  ctx.equal(`${point} frozen command identity survives`,{ commandId:delivered.selected.command.commandId,deliveryId:delivered.selected.command.deliveryId,agentId:delivered.selected.command.agentId,commandSequence:delivered.selected.command.commandSequence },stable,{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS","ORDERED_DELIVERY_CORRECTNESS"] });
  ctx.ok(`${point} rollback does not close on delivery alone`,delivered.selected.rollback.state !== "COMPLETED");
  const affectedAgent = catalog.agents.find(({ agentId }) => agentId === stable.agentId), publicCommand = await waitForCommand(ctx,api.baseUrl,{ ...affectedAgent,appliedRevision:apply[0].toRevision },{ lastCommandSequence:apply[0].commandSequence,processes:replacements });
  ctx.assert(`${point} public rollback command remains exact`,() => assertRolloutCommand(publicCommand));
  await ctx.acknowledge(api.baseUrl,publicCommand.agentId,publicCommand,"APPLIED");
  const complete = await waitForState(ctx,api.baseUrl,(state) => rollbackFor(state,deployment.deploymentId),(value) => value?.state === "COMPLETED",{ label:`${point} rollback completion`,processes:replacements });
  ctx.equal(`${point} closes exact fanout`,[complete.selected.completedCount,complete.selected.commandCount],[1,1]);
  ctx.ok(`${point} stale owner cannot add command`,complete.state.resources.rolloutCommands.filter(({ deploymentId,kind }) => deploymentId === deployment.deploymentId && kind === "ROLLBACK").length === 1);
  return { point,workId:work.workId,attempt:held.json.attempt,commandId:stable.commandId };
}

const C03 = defineCase(
  "C-03",
  "One frozen changed Agent and one rejected Agent for each ROLLBACK_DELIVERY barrier",
  "Create rollback only through public staged poll and acknowledgement flow, SIGKILL the held worker and start two replacements after lease expiry",
  "Preserve commandId, deliveryId, body, token and member set, drain retained Work once and delay Rollback completion until acknowledgement",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const evidence = [];
    for (let index=0;index<BARRIERS.length;index += 1) evidence.push(await rollbackRecovery(ctx,BARRIERS[index],index));
    return { evidence };
  },
);

const C04 = defineCase(
  "C-04",
  "Two Deployment aggregates with committed create, sent and acknowledgement Events",
  "Persist receiver requests, hold dispatcher after a 204 response, SIGKILL it and resume delivery with a replacement",
  "Canonicalize JSON independently and require stable Event headers/identity/body, nondecreasing per-aggregate successful sequence and empty payload without token leaks",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","dispatcher-process","verification-snapshot"],
  async (ctx) => {
    const catalog = ctx.catalog({ count:2 });
    catalog.agents[0].labels.slot = "a"; catalog.agents[1].labels.slot = "b";
    const { api } = await boot(ctx,{ catalog });
    const first = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"slot",value:"a" } } }), second = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"slot",value:"b" } } });
    const worker = await ctx.startWorker();
    const commands = await ctx.concurrent(catalog.agents,2,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] }));
    await ctx.concurrent(commands,2,(command) => ctx.acknowledge(api.baseUrl,command.agentId,command,"APPLIED"));
    const state = await snapshot(ctx,api.baseUrl), receiver = await ctx.receiver(() => ({ status:204 })), barrier = await ctx.dispatcherBarrier(), original = await ctx.startDispatcherAtBarrier(receiver,barrier);
    const held = await barrier.waitFor(() => true,{ label:"dispatcher response boundary",timeoutMs:15_000,processes:[original] });
    await ctx.kill(original);
    const firstDelivery = receiver.ledger.find((entry) => entry.json?.eventId);
    ctx.ok("receiver persisted request before dispatcher death",Boolean(firstDelivery));
    await ctx.sleep(3_250);
    const replacement = await ctx.startDispatcher({ webhookUrl:receiver.url });
    await ctx.waitFor(() => {
      const identities = new Set(receiver.ledger.map((entry) => entry.json?.eventId).filter(Boolean));
      return identities.size === state.events.length && receiver.ledger.length > state.events.length ? identities : undefined;
    },{ label:"outbox replay and complete drain",timeoutMs:30_000,processes:[replacement] });
    const duplicates = receiver.ledger.filter((entry) => entry.json?.eventId === firstDelivery.json.eventId);
    ctx.ok("unknown acknowledgement causes stable retry",duplicates.length >= 2);
    ctx.equal("Event identity header remains stable",new Set(duplicates.map((entry) => entry.headers["x-configrelay-event-id"])).size,1);
    ctx.equal("Event type header remains stable",new Set(duplicates.map((entry) => entry.headers["x-configrelay-event-type"])).size,1);
    ctx.equal("retry body remains semantically stable",new Set(duplicates.map((entry) => canonical(entry.json))).size,1);
    receiver.ledger.forEach((entry) => { if (entry.json?.eventId) ctx.assert("receiver Event has exact public shape",() => assertEvent(entry.json)); });
    const aggregateIds = new Set(receiver.ledger.map((entry) => entry.json?.aggregateId).filter(Boolean));
    ctx.ok("receiver observes mixed aggregate identities",aggregateIds.size >= 2);
    for (const aggregateId of aggregateIds) {
      const sequence = receiver.ledger.filter((entry) => entry.json?.aggregateId === aggregateId).map((entry) => entry.json.sequence);
      ctx.equal("successful aggregate delivery is nondecreasing",sequence,[...sequence].sort((left,right) => left-right));
    }
    ctx.ok("dispatcher body omits fencing tokens and private paths",receiver.ledger.every((entry) => !/Token|assignmentToken|\/(?:Users|home|tmp)\//u.test(entry.raw)));
    return { evidence:[held.json.workId,firstDelivery.json.eventId,receiver.ledger.length] };
  },
);

export const C_CASES = [C01,C02,C03,C04];
