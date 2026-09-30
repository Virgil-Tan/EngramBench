import { acknowledgementBody } from "../lib/fixtures.mjs";
import { affectedAgents, assertRolloutCommand, cohortVerdict } from "../lib/oracle.mjs";
import { assertFrozenTarget, boot, cohortsFor, commandsFor, createLegacy, createStaged, defineCase, deploymentFrom, expectError, resetFixture, rollbackFor, snapshot, stableResponses, waitForCommand, waitForState } from "./helpers.mjs";

const B01 = defineCase(
  "B-01",
  "Six Agents with two immutable Deployment snapshots and two Configuration revisions",
  "Create ordered Deployments, run two workers, repeat polls across reconnect-style requests, acknowledge the first and observe the next command",
  "Independently sort member IDs and hash newline bytes, then require gapless per-Agent sequences, nondecreasing revisions and stable command identity/body/token",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const { catalog,apis } = await boot(ctx,{ apiCount:2,catalogOptions:{ count:6 } });
    const secondConfiguration = await ctx.publishConfiguration(apis[0].baseUrl,catalog.fleet.fleetId,{ revision:2,mode:"second" },1);
    ctx.equal("second Configuration status",secondConfiguration.status,201);
    const selector = { labels:{ key:"parity",value:"even" } }, members = catalog.agents.filter(({ labels }) => labels.parity === "even");
    const first = await createLegacy(ctx,apis[0].baseUrl,catalog,{ selector,configurationRevision:1,expectedFleetRevision:2 });
    const second = await createLegacy(ctx,apis[1].baseUrl,catalog,{ selector,configurationRevision:2,expectedFleetRevision:2 });
    assertFrozenTarget(ctx,first,members); assertFrozenTarget(ctx,second,members);
    const workers = [await ctx.startWorker(),await ctx.startWorker()];
    const agent = members[0], commandOne = await waitForCommand(ctx,apis[0].baseUrl,agent,{ processes:workers });
    const repeated = [];
    for (let index=0;index<5;index += 1) repeated.push(await ctx.pollAgent(apis[index % 2].baseUrl,agent.agentId,agent.appliedRevision));
    stableResponses(ctx,repeated,"lowest command repeat",{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    ctx.equal("first command belongs to first Deployment",commandOne.deploymentId,first.deploymentId);
    ctx.equal("first command starts gapless sequence",commandOne.commandSequence,1);
    await ctx.acknowledge(apis[1].baseUrl,agent.agentId,commandOne,"APPLIED");
    const commandTwo = await waitForCommand(ctx,apis[0].baseUrl,{ ...agent,appliedRevision:commandOne.revision },{ processes:workers });
    ctx.equal("next command belongs to second Deployment",commandTwo.deploymentId,second.deploymentId);
    ctx.equal("next command is exactly prior plus one",commandTwo.commandSequence,commandOne.commandSequence + 1,{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    ctx.ok("revision does not downgrade",commandTwo.revision >= commandOne.revision,undefined,{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    const secondRepeats = await Promise.all(Array.from({ length:4 },() => ctx.pollAgent(apis[1].baseUrl,agent.agentId,commandOne.revision)));
    stableResponses(ctx,secondRepeats,"second command repeat",{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    const state = await snapshot(ctx,apis[0].baseUrl);
    ctx.equal("Deployment target digest remains immutable",[deploymentFrom(state,first.deploymentId).targetDigest,deploymentFrom(state,second.deploymentId).targetDigest],[first.targetDigest,second.targetDigest]);
    return { evidence:[first.deploymentId,second.deploymentId,commandOne.deliveryId,commandTwo.deliveryId] };
  },
);

const B02 = defineCase(
  "B-02",
  "Three-Agent Deployment replayed concurrently across two APIs, through response loss and after restart",
  "Race identical create requests, reuse the key with different semantics, acknowledge one Assignment and cancel the mixed remaining set",
  "Require one saved response and aggregate effect, exact idempotency conflict, ACKED preservation, only unacknowledged supersession and no duplicate Event or Work",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const { catalog,apis } = await boot(ctx,{ apiCount:2,catalogOptions:{ count:3 } });
    const body = ctx.deploymentBody(catalog), key = ctx.key("concurrent-create");
    const responses = await Promise.all(Array.from({ length:20 },(_item,index) => ctx.createDeployment(apis[index % 2].baseUrl,body,{ key })));
    const original = stableResponses(ctx,responses,"concurrent Deployment create",{ hardCapIds:["IDEMPOTENCY_CORRECTNESS"] });
    ctx.equal("create replay status",original.status,202);
    expectError(ctx,await ctx.createDeployment(apis[1].baseUrl,{ ...body,configurationRevision:999 },{ key }),409,"IDEMPOTENCY_CONFLICT",{ hardCapIds:["IDEMPOTENCY_CORRECTNESS"] });
    let state = await snapshot(ctx,apis[0].baseUrl);
    ctx.equal("concurrent create leaves one Deployment",state.resources.deployments.filter(({ deploymentId }) => deploymentId === original.json.deploymentId).length,1);
    const shield = await ctx.responseShield(apis[0].baseUrl), unknownKey = ctx.key("unknown-create"), unknownBody = { ...body,selector:{ labels:{ key:"parity",value:"even" } } };
    shield.dropNextMutation();
    let disconnected = false;
    try { await ctx.createDeployment(shield.baseUrl,unknownBody,{ key:unknownKey }); } catch { disconnected = true; }
    ctx.ok("complete response was hidden from client",disconnected);
    await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped),{ label:"hidden complete response" });
    const unknownReplay = await ctx.createDeployment(apis[1].baseUrl,unknownBody,{ key:unknownKey });
    const captured = JSON.parse(shield.captures.find(({ dropped }) => dropped).response.body);
    ctx.equal("unknown outcome replay preserves saved response",[unknownReplay.status,ctx.canonical(unknownReplay.json)],[202,ctx.canonical(captured)]);
    const workers = [await ctx.startWorker(),await ctx.startWorker()];
    const firstCommand = await waitForCommand(ctx,apis[0].baseUrl,catalog.agents[0],{ processes:workers });
    await ctx.acknowledge(apis[0].baseUrl,firstCommand.agentId,firstCommand,"APPLIED");
    const cancelled = await ctx.cancelDeployment(apis[1].baseUrl,original.json.deploymentId,{ key:ctx.key("mixed-cancel") });
    ctx.equal("mixed cancel succeeds",cancelled.status,200);
    state = await snapshot(ctx,apis[0].baseUrl);
    const affected = state.resources.assignments.filter(({ deploymentId }) => deploymentId === original.json.deploymentId);
    ctx.equal("acknowledged Assignment remains ACKED",affected.find(({ agentId }) => agentId === firstCommand.agentId).state,"ACKED");
    ctx.ok("cancel supersedes every other Assignment",affected.filter(({ agentId }) => agentId !== firstCommand.agentId).every(({ state:assignmentState }) => assignmentState === "SUPERSEDED"));
    for (const api of apis) await ctx.stop(api);
    const restarted = await ctx.startApi(), restartReplay = await ctx.createDeployment(restarted.baseUrl,body,{ key });
    ctx.equal("restart preserves original create response",[restartReplay.status,ctx.canonical(restartReplay.json)],[original.status,ctx.canonical(original.json)]);
    const final = await snapshot(ctx,restarted.baseUrl);
    ctx.equal("logical create identities remain unique",new Set(final.resources.deployments.map(({ deploymentId }) => deploymentId)).size,final.resources.deployments.length);
    return { evidence:[original.json.deploymentId,unknownReplay.json.deploymentId,firstCommand.assignmentId] };
  },
);

async function exerciseHealth(ctx,fixture) {
  const { catalog,api } = await resetFixture(ctx,{ catalogOptions:{ count:fixture.targetCount,cohortCount:1 },seedVersion:`b03-${fixture.label}` });
  const plan = [{ name:fixture.label,selector:catalog.outerSelector,minimumSuccessBasisPoints:fixture.minimumSuccessBasisPoints,maximumFailureBasisPoints:fixture.maximumFailureBasisPoints,observationSeconds:1 }];
  const deployment = await createStaged(ctx,api.baseUrl,catalog,plan);
  ctx.equal("only ordinal zero starts",deployment.cohorts.map(({ ordinal,state }) => [ordinal,state]),[[0,"DELIVERING"]]);
  const worker = await ctx.startWorker(), commands = await ctx.concurrent(catalog.agents,16,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] }));
  const outcomes = [...Array(fixture.successCount).fill("APPLIED"),...Array(fixture.failureCount).fill("REJECTED")];
  await ctx.concurrent(outcomes,16,(outcome,index) => ctx.acknowledge(api.baseUrl,commands[index].agentId,commands[index],outcome));
  const expected = cohortVerdict({ targetCount:fixture.targetCount,successCount:fixture.successCount,failureCount:fixture.failureCount,pendingCount:fixture.targetCount-fixture.successCount-fixture.failureCount,minimumSuccessBasisPoints:fixture.minimumSuccessBasisPoints,maximumFailureBasisPoints:fixture.maximumFailureBasisPoints },{ deadline:true });
  const settled = await waitForState(ctx,api.baseUrl,(state) => state.resources.deploymentCohorts.find(({ deploymentId }) => deploymentId === deployment.deploymentId),(cohort) => cohort && ["SUCCEEDED","FAILED"].includes(cohort.state),{ label:`${fixture.label} health verdict`,timeoutMs:15_000,processes:[worker] });
  ctx.equal(`${fixture.label} conserved counts`,[settled.selected.successCount,settled.selected.failureCount,settled.selected.pendingCount],[expected.successCount,expected.failureCount,expected.pendingCount],{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS"] });
  ctx.equal(`${fixture.label} integer verdict`,settled.selected.state,expected.state,{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS"] });
  return { deploymentId:deployment.deploymentId,cohortId:settled.selected.cohortId,state:settled.selected.state };
}

const B03 = defineCase(
  "B-03",
  "Independent one-Cohort targetCount 3, 7 and 10 fixtures including the exact 5714/4285 worked boundary",
  "Deliver and acknowledge fixed APPLIED/REJECTED subsets, leave the worked example missing at deadline and execute a threshold-plus-one failure",
  "Use BigInt floor against immutable targetCount, conserve success/failure/pending and require exactly one terminal health transition",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const fixtures = [
      { label:"three-all",targetCount:3,successCount:3,failureCount:0,minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0 },
      { label:"seven-boundary",targetCount:7,successCount:4,failureCount:2,minimumSuccessBasisPoints:5714,maximumFailureBasisPoints:4285 },
      { label:"seven-plus-one",targetCount:7,successCount:4,failureCount:2,minimumSuccessBasisPoints:5715,maximumFailureBasisPoints:4285 },
      { label:"ten-ninety",targetCount:10,successCount:9,failureCount:1,minimumSuccessBasisPoints:9000,maximumFailureBasisPoints:1000 },
    ];
    const results = [];
    for (const fixture of fixtures) results.push(await exerciseHealth(ctx,fixture));
    ctx.equal("worked threshold succeeds and plus-one fails",results.slice(1,3).map(({ state }) => state),["SUCCEEDED","FAILED"]);
    return { evidence:results };
  },
);

const B04 = defineCase(
  "B-04",
  "Two disjoint Cohorts whose first Cohort explicitly rejects every command",
  "Observe only ordinal zero starting, reject its delivered commands and recover the API after failure",
  "Failure must not activate the later Cohort, manufacture successful Agents or send it APPLY commands",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:4,cohortCount:2 } });
    const deployment = await createStaged(ctx,api.baseUrl,catalog,ctx.stagedPlan(catalog,2));
    ctx.equal("only first cohort starts",deployment.cohorts.map(c => c.state),["DELIVERING","WAITING"]);
    const first = deployment.cohorts[0], later = deployment.cohorts[1];
    const matches = (agent,cohort) => agent.labels[cohort.selector.labels.key] === cohort.selector.labels.value;
    const targets = catalog.agents.filter(agent => matches(agent,first));
    const untouched = catalog.agents.filter(agent => matches(agent,later));
    ctx.ok("both cohorts have live independent targets",targets.length > 0 && untouched.length > 0);
    const worker = await ctx.startWorker();
    for (const agent of untouched) {
      const poll = await ctx.pollAgent(api.baseUrl,agent.agentId,agent.appliedRevision);
      ctx.equal("later cohort receives no premature command",poll.json.status,"NO_CHANGE");
    }
    const commands = await Promise.all(targets.map(agent => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] })));
    for (const command of commands) ctx.equal("first cohort rejection accepted",(await ctx.acknowledge(api.baseUrl,command.agentId,command,"REJECTED")).status,200);
    const settled = await waitForState(ctx,api.baseUrl,state => cohortsFor(state,deployment.deploymentId),
      cohorts => cohorts[0]?.state === "FAILED" || cohorts[0]?.state === "ROLLED_BACK",
      { label:"failed first cohort",processes:[worker] });
    ctx.equal("failed cohort has no successes",settled.selected[0].successCount,0);
    ctx.equal("later cohort was never started",settled.selected[1].startedAt,null);
    await ctx.stop(worker);
    const beforeRestart = await snapshot(ctx,api.baseUrl);
    await ctx.kill(api);
    const restarted = await ctx.startApi(), state = await snapshot(ctx,restarted.baseUrl);
    ctx.equal("restart preserves cohort state",cohortsFor(state,deployment.deploymentId),cohortsFor(beforeRestart,deployment.deploymentId));
    const laterCommands = commandsFor(state,deployment.deploymentId).filter(c => c.cohortId === later.cohortId);
    ctx.ok("later APPLY commands never delivered",laterCommands.every(c => c.state === "WAITING" || c.state === "SUPERSEDED"));
    for (const agent of untouched) ctx.equal("later Agent applied revision stays unchanged",
      state.resources.agents.find(a => a.agentId === agent.agentId).appliedRevision,agent.appliedRevision);
    return { evidence:[deployment.deploymentId,first.cohortId,later.cohortId,commands.map(c => c.commandId)] };
  },
);

const B05 = defineCase(
  "B-05",
  "Four-Agent one-Cohort failure with two changed Agents, one rejected Agent and one missing Agent",
  "Deliver APPLY commands, acknowledge the fixed subset, allow deadline failure, send a late acknowledgement and complete every public rollback command",
  "Freeze exactly successful changed Agents, supersede remaining APPLY, allocate one new higher sequence per affected Agent and close only after all are terminal",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:4,cohortCount:1,rollbackBaseline:true } });
    const plan = [{ name:"Failing",selector:catalog.outerSelector,minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:1 }];
    const deployment = await createStaged(ctx,api.baseUrl,catalog,plan), worker = await ctx.startWorker();
    const apply = await ctx.concurrent(catalog.agents,8,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] }));
    await ctx.acknowledge(api.baseUrl,apply[0].agentId,apply[0],"APPLIED");
    await ctx.acknowledge(api.baseUrl,apply[1].agentId,apply[1],"APPLIED");
    await ctx.acknowledge(api.baseUrl,apply[2].agentId,apply[2],"REJECTED");
    const failed = await waitForState(ctx,api.baseUrl,(state) => rollbackFor(state,deployment.deploymentId),Boolean,{ label:"failed Cohort rollback freeze",timeoutMs:15_000,processes:[worker] });
    const expected = affectedAgents(apply.map((command,index) => ({ ...command,cohortOrdinal:0,state:index < 2 ? "ACKED" : index === 2 ? "FAILED" : "SENT" })),0);
    ctx.equal("rollback affected count is independently frozen",failed.selected.commandCount,expected.length,{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS"] });
    const late = await ctx.acknowledge(api.baseUrl,apply[3].agentId,apply[3],"APPLIED");
    ctx.ok("late APPLY cannot become a successful new member",late.status === 409 || late.json?.outcome !== "APPLIED");
    const rollbackCommands = await ctx.concurrent(catalog.agents.slice(0,2),4,(agent,index) => waitForCommand(ctx,api.baseUrl,{ ...agent,appliedRevision:apply[index].toRevision },{ lastCommandSequence:apply[index].commandSequence,processes:[worker],label:"rollback command" }));
    rollbackCommands.forEach((command,index) => ctx.assert("rollback command identity and sequence",() => { assertRolloutCommand(command); if (command.kind !== "ROLLBACK" || !expected.includes(command.agentId) || command.commandSequence <= apply[index].commandSequence) throw new Error("affected-set command mismatch"); },{ hardCapIds:["ROLLBACK_RECOVERY_CORRECTNESS","ORDERED_DELIVERY_CORRECTNESS"] }));
    let mid = await snapshot(ctx,api.baseUrl);
    ctx.ok("Rollback is not complete while commands remain nonterminal",rollbackFor(mid,deployment.deploymentId).state !== "COMPLETED");
    await ctx.concurrent(rollbackCommands,4,(command) => ctx.acknowledge(api.baseUrl,command.agentId,command,"APPLIED"));
    const complete = await waitForState(ctx,api.baseUrl,(state) => rollbackFor(state,deployment.deploymentId),(rollback) => rollback?.state === "COMPLETED",{ label:"rollback closure",processes:[worker] });
    ctx.equal("Rollback closes at exact command count",complete.selected.completedCount,complete.selected.commandCount);
    const savedCommands = commandsFor(complete.state,deployment.deploymentId);
    ctx.equal("one rollback command per frozen Agent",savedCommands.filter(({ kind }) => kind === "ROLLBACK").map(({ agentId }) => agentId).sort(),expected);
    return { evidence:[deployment.deploymentId,expected,rollbackCommands.map(({ commandId }) => commandId)] };
  },
);

export const B_CASES = [B01,B02,B03,B04,B05];
