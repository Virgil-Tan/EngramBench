import { acknowledgementBody } from "../lib/fixtures.mjs";
import { assertAcknowledgement, assertAgentPoll, assertAssignment, assertConfiguration, assertDeployment, assertPublicError, assertRollback, assertRolloutCommand, canonical } from "../lib/oracle.mjs";
import { assertFrozenTarget, boot, createLegacy, createStaged, defineCase, expectError, snapshot, stableResponses, waitForCommand, waitForState } from "./helpers.mjs";

const A01 = defineCase(
  "A-01",
  "Seeded Fleet at revision one plus scalar, structured and exact one-MiB JSON values",
  "Publish through public HTTP and separately submit stale CAS, unknown field, unsupported media, malformed JSON and oversize content",
  "Canonicalize with an evaluator-owned RFC 8785 encoder, hash bytes independently and compare atomic before/after snapshots",
  ["seed-command","public-http","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:2 } });
    const values = [null,true,17,"snowman-☃",[3,2,1],{ z:-0,a:{ b:"text",n:1e30 } },"x".repeat(1_048_574)];
    let revision = catalog.fleet.currentRevision;
    for (const content of values) {
      const response = await ctx.publishConfiguration(api.baseUrl,catalog.fleet.fleetId,content,revision);
      ctx.equal("Configuration publish status",response.status,201);
      ctx.assert("Configuration exact shape and digest",() => assertConfiguration(response.json,{ revision:revision + 1,content }));
      ctx.equal("digest uses canonical content bytes",response.json.canonicalDigest,ctx.sha256(canonical(content)));
      revision += 1;
    }
    const before = await snapshot(ctx,api.baseUrl);
    const path = `/api/v1/fleets/${catalog.fleet.fleetId}/configurations`;
    expectError(ctx,await ctx.publishConfiguration(api.baseUrl,catalog.fleet.fleetId,{ stale:true },revision - 1),409,"FLEET_REVISION_CHANGED");
    expectError(ctx,await ctx.mutate(api.baseUrl,path,ctx.key("unknown"),{ content:{ ok:true },expectedFleetRevision:revision,extra:true },{ contractExpectation:"invalid" }),400,"UNKNOWN_FIELD");
    expectError(ctx,await ctx.request(api.baseUrl,path,{ method:"POST",headers:{ "content-type":"text/plain","idempotency-key":ctx.key("media") },raw:JSON.stringify({ content:true,expectedFleetRevision:revision }),contractExpectation:"invalid" }),415,"UNSUPPORTED_MEDIA_TYPE");
    expectError(ctx,await ctx.request(api.baseUrl,path,{ method:"POST",headers:{ "content-type":"application/json","idempotency-key":ctx.key("malformed") },raw:"{",contractExpectation:"invalid" }),400,"MALFORMED_JSON");
    expectError(ctx,await ctx.publishConfiguration(api.baseUrl,catalog.fleet.fleetId,"x".repeat(1_048_575),revision),400,"INVALID_REQUEST");
    expectError(ctx,await ctx.publishConfiguration(api.baseUrl,catalog.fleet.fleetId,"\ud800",revision),400,"INVALID_REQUEST");
    const after = await snapshot(ctx,api.baseUrl);
    ctx.equal("all rejected Configuration requests leave resources unchanged",ctx.canonical(after.resources),ctx.canonical(before.resources));
    ctx.equal("all rejected Configuration requests leave Events unchanged",ctx.canonical(after.events),ctx.canonical(before.events));
    return { evidence:[revision,values.map((value) => ctx.sha256(canonical(value)))] };
  },
);

const A02 = defineCase(
  "A-02",
  "Legacy all-at-once Deployment over exact AND label matches with cancellable and terminal states",
  "Create, read and cancel through public routes while isolating invalid selector, missing resource and terminal cancellation requests",
  "Recompute sorted member digest independently, enforce the closed V1 shape and prove every rejection has no aggregate, Work or Event effect",
  ["seed-command","public-http","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:6 } });
    const selected = catalog.agents.filter(({ labels }) => labels.parity === "even");
    const legacy = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"parity",value:"even" } } });
    ctx.assert("legacy create has exact V1 Deployment shape",() => assertDeployment(legacy));
    assertFrozenTarget(ctx,legacy,selected);
    const detail = await ctx.getDeployment(api.baseUrl,legacy.deploymentId);
    ctx.equal("legacy detail status",detail.status,200);
    ctx.assert("legacy detail omits Manager-only fields",() => assertDeployment(detail.json));
    const baseline = await snapshot(ctx,api.baseUrl);
    expectError(ctx,await ctx.createDeployment(api.baseUrl,{ ...ctx.deploymentBody(catalog),selector:{ labels:{ key:"BadKey",value:"even" } } }),400,"INVALID_AGENT_SELECTOR");
    expectError(ctx,await ctx.createDeployment(api.baseUrl,{ ...ctx.deploymentBody(catalog),configurationRevision:999 }),404,"NOT_FOUND");
    const rejected = await snapshot(ctx,api.baseUrl);
    ctx.equal("invalid creates have no resource effect",ctx.canonical(rejected.resources),ctx.canonical(baseline.resources));
    ctx.equal("invalid creates have no Work or Event effect",[ctx.canonical(rejected.work),ctx.canonical(rejected.events)],[ctx.canonical(baseline.work),ctx.canonical(baseline.events)]);
    const cancelled = await ctx.cancelDeployment(api.baseUrl,legacy.deploymentId);
    ctx.equal("cancel status",cancelled.status,200);
    ctx.assert("cancel returns exact legacy Deployment",() => assertDeployment(cancelled.json));
    ctx.equal("cancel reaches CANCELLED",cancelled.json.state,"CANCELLED");
    const beforeTerminalRetry = await snapshot(ctx,api.baseUrl);
    expectError(ctx,await ctx.cancelDeployment(api.baseUrl,legacy.deploymentId),409,"DEPLOYMENT_NOT_CANCELLABLE");
    const afterTerminalRetry = await snapshot(ctx,api.baseUrl);
    ctx.equal("terminal cancel rejection is side-effect free",ctx.canonical({ resources:afterTerminalRetry.resources,work:afterTerminalRetry.work,events:afterTerminalRetry.events }),ctx.canonical({ resources:beforeTerminalRetry.resources,work:beforeTerminalRetry.work,events:beforeTerminalRetry.events }));
    return { evidence:[legacy.deploymentId,legacy.targetDigest,cancelled.json.state] };
  },
);

const A03 = defineCase(
  "A-03",
  "One-Agent legacy Assignment with repeat poll, exact acknowledgement, stale token and conflicting outcome",
  "Drive a real delivery worker then use only public poll and acknowledgement HTTP requests including malformed and unknown-field bodies",
  "Validate closed poll, Assignment and Acknowledgement shapes and isolate each published token or semantic conflict without state or Event changes",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:1 } });
    const deployment = await createLegacy(ctx,api.baseUrl,catalog);
    const worker = await ctx.startWorker();
    const command = await waitForCommand(ctx,api.baseUrl,catalog.agents[0],{ processes:[worker] });
    ctx.assert("legacy poll command is exact Assignment",() => assertAssignment(command));
    const polls = [];
    for (let index=0;index<3;index += 1) polls.push(await ctx.pollAgent(api.baseUrl,catalog.agents[0].agentId,0));
    stableResponses(ctx,polls,"repeat poll",{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    polls.forEach((response) => ctx.assert("poll response is closed",() => assertAgentPoll(response.json)));
    const beforeStale = await snapshot(ctx,api.baseUrl);
    const stale = { ...acknowledgementBody(command,"APPLIED"),assignmentToken:`${command.assignmentToken}-stale` };
    expectError(ctx,await ctx.mutate(api.baseUrl,`/api/v1/agents/${command.agentId}/acknowledgements`,ctx.key("stale-token"),stale),409,"STALE_ASSIGNMENT_TOKEN",{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS"] });
    const afterStale = await snapshot(ctx,api.baseUrl);
    ctx.equal("stale token cannot mutate state",ctx.canonical({ resources:afterStale.resources,work:afterStale.work,events:afterStale.events }),ctx.canonical({ resources:beforeStale.resources,work:beforeStale.work,events:beforeStale.events }));
    const ackKey = ctx.key("accepted-ack"), accepted = await ctx.acknowledge(api.baseUrl,command.agentId,command,"APPLIED",{ key:ackKey });
    ctx.equal("acknowledgement status",accepted.status,200);
    ctx.assert("acknowledgement exact shape",() => assertAcknowledgement(accepted.json));
    const replay = await ctx.acknowledge(api.baseUrl,command.agentId,command,"APPLIED",{ key:ackKey });
    ctx.equal("exact acknowledgement replay",[replay.status,ctx.canonical(replay.json)],[accepted.status,ctx.canonical(accepted.json)]);
    expectError(ctx,await ctx.acknowledge(api.baseUrl,command.agentId,command,"REJECTED"),409,"ACKNOWLEDGEMENT_CONFLICT");
    const noChange = await ctx.pollAgent(api.baseUrl,command.agentId,command.revision);
    ctx.equal("accepted command leaves exact NO_CHANGE",noChange.json,{ status:"NO_CHANGE",command:null });
    const unknown = { ...acknowledgementBody(command),unexpected:true };
    expectError(ctx,await ctx.mutate(api.baseUrl,`/api/v1/agents/${command.agentId}/acknowledgements`,ctx.key("unknown-ack"),unknown,{ contractExpectation:"invalid" }),400,"UNKNOWN_FIELD");
    return { evidence:[deployment.deploymentId,command.assignmentId,accepted.json.reportedAt] };
  },
);

const A04 = defineCase(
  "A-04",
  "Twenty-Agent exact-one cohort partition with one- and twenty-Cohort valid plans plus every published boundary family",
  "Submit staged Deployment plans through public HTTP at count, threshold, duration, name, selector and partition boundaries",
  "Require ordinal closed Cohort shapes and rollback null for valid plans and atomic exact error responses for invalid plans",
  ["seed-command","public-http","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:20,cohortCount:20 } });
    const one = [{ name:"All",selector:catalog.outerSelector,minimumSuccessBasisPoints:0,maximumFailureBasisPoints:10_000,observationSeconds:1 }];
    const stagedOne = await createStaged(ctx,api.baseUrl,catalog,one);
    ctx.assert("one-Cohort response exact",() => assertDeployment(stagedOne,{ staged:true }));
    ctx.equal("one-Cohort rollback starts null",stagedOne.rollback,null);
    const twenty = ctx.stagedPlan(catalog,20,{ minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:86_400 });
    const stagedTwenty = await createStaged(ctx,api.baseUrl,catalog,twenty);
    ctx.assert("twenty-Cohort response exact",() => assertDeployment(stagedTwenty,{ staged:true }));
    ctx.equal("twenty Cohorts preserve order and one member each",stagedTwenty.cohorts.map(({ ordinal,targetCount }) => [ordinal,targetCount]),Array.from({ length:20 },(_item,index) => [index,1]));
    const baseline = await snapshot(ctx,api.baseUrl);
    const invalidPlans = [
      [],
      Array.from({ length:21 },(_item,index) => ({ name:`Too many ${index}`,selector:{ labels:{ key:"cohort",value:`c${index}` } },minimumSuccessBasisPoints:0,maximumFailureBasisPoints:10_000,observationSeconds:1 })),
      [{ ...one[0],minimumSuccessBasisPoints:-1 }],
      [{ ...one[0],maximumFailureBasisPoints:10_001 }],
      [{ ...one[0],observationSeconds:0 }],
      [{ ...one[0],observationSeconds:86_401 }],
      [{ ...one[0],name:"" }],
      [{ ...one[0],selector:{ labels:{ key:"BadKey",value:"x" } } }],
    ];
    for (const [index,cohorts] of invalidPlans.entries()) expectError(ctx,await ctx.createDeployment(api.baseUrl,ctx.deploymentBody(catalog,{ cohorts }),{ contractExpectation:index < 7 ? "invalid" : undefined }),400,"INVALID_COHORT_PLAN");
    const unmatched = [{ ...one[0],selector:{ labels:{ key:"cohort",value:"absent" } } }];
    expectError(ctx,await ctx.createDeployment(api.baseUrl,ctx.deploymentBody(catalog,{ cohorts:unmatched })),409,"COHORT_TARGET_PARTITION_INVALID");
    const duplicate = [{ ...one[0],name:"Duplicate A" },{ ...one[0],name:"Duplicate B" }];
    expectError(ctx,await ctx.createDeployment(api.baseUrl,ctx.deploymentBody(catalog,{ cohorts:duplicate })),409,"COHORT_TARGET_PARTITION_INVALID");
    const after = await snapshot(ctx,api.baseUrl);
    ctx.equal("invalid plans leave all resources unchanged",ctx.canonical(after.resources),ctx.canonical(baseline.resources));
    ctx.equal("invalid plans leave Work and Events unchanged",[ctx.canonical(after.work),ctx.canonical(after.events)],[ctx.canonical(baseline.work),ctx.canonical(baseline.events)]);
    return { evidence:[stagedOne.deploymentId,stagedTwenty.deploymentId,stagedTwenty.cohorts.map(({ cohortId }) => cohortId)] };
  },
);

const A05 = defineCase(
  "A-05",
  "Disjoint legacy Agent and two staged Agents where one APPLY succeeds and one rejects",
  "Observe legacy Assignment and staged APPLY/ROLLBACK commands by public poll, create failure by exact acknowledgements and send an out-of-sequence acknowledgement",
  "Enforce the command union and rollback shapes, higher sequence, legacy omission, exact sequence conflict and absence of invented rollback Events",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const catalog = ctx.catalog({ count:3,cohortCount:1,rollbackBaseline:true });
    catalog.agents[0].labels.flow = "legacy";
    catalog.agents[1].labels.flow = "staged";
    catalog.agents[2].labels.flow = "staged";
    const { api } = await boot(ctx,{ catalog });
    const legacy = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"flow",value:"legacy" } } });
    const outer = { labels:{ key:"flow",value:"staged" } };
    const cohorts = [{ name:"Staged",selector:outer,minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:60 }];
    const staged = await createStaged(ctx,api.baseUrl,catalog,cohorts,{ selector:outer });
    const worker = await ctx.startWorker();
    const legacyCommand = await waitForCommand(ctx,api.baseUrl,catalog.agents[0],{ processes:[worker] });
    const applyOne = await waitForCommand(ctx,api.baseUrl,catalog.agents[1],{ processes:[worker],lastCommandSequence:0 });
    const applyTwo = await waitForCommand(ctx,api.baseUrl,catalog.agents[2],{ processes:[worker],lastCommandSequence:0 });
    ctx.assert("legacy poll retains Assignment",() => assertAssignment(legacyCommand));
    ctx.assert("staged poll returns APPLY RolloutCommand",() => { assertRolloutCommand(applyOne); if (applyOne.kind !== "APPLY") throw new Error("expected APPLY"); });
    await ctx.acknowledge(api.baseUrl,applyOne.agentId,applyOne,"APPLIED");
    await ctx.acknowledge(api.baseUrl,applyTwo.agentId,applyTwo,"REJECTED");
    const failed = await waitForState(ctx,api.baseUrl,(state) => state.resources.deploymentRollbacks.find(({ deploymentId }) => deploymentId === staged.deploymentId),Boolean,{ label:"automatic rollback",processes:[worker] });
    ctx.assert("DeploymentRollback exact shape",() => assertRollback(failed.selected));
    ctx.equal("affected set freezes one changed Agent",failed.selected.commandCount,1);
    const rollbackCommand = await waitForCommand(ctx,api.baseUrl,catalog.agents[1],{ processes:[worker],lastCommandSequence:applyOne.commandSequence });
    ctx.assert("rollback command exact",() => { assertRolloutCommand(rollbackCommand); if (rollbackCommand.kind !== "ROLLBACK") throw new Error("expected ROLLBACK"); });
    ctx.ok("rollback sequence strictly increases",rollbackCommand.commandSequence > applyOne.commandSequence,undefined,{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
    const wrong = { ...acknowledgementBody(rollbackCommand,"APPLIED"),commandSequence:rollbackCommand.commandSequence + 1 };
    expectError(ctx,await ctx.mutate(api.baseUrl,`/api/v1/agents/${rollbackCommand.agentId}/acknowledgements`,ctx.key("wrong-sequence"),wrong),409,"AGENT_COMMAND_SEQUENCE_CONFLICT");
    const legacyDetail = await ctx.getDeployment(api.baseUrl,legacy.deploymentId);
    ctx.assert("legacy detail remains exact V1",() => assertDeployment(legacyDetail.json));
    ctx.ok("rollback creates no unpublished Event",failed.state.events.every(({ type }) => ["deployment.created","assignment.sent","assignment.acknowledged","assignment.failed","deployment.completed","deployment.cancelled"].includes(type)));
    return { evidence:[legacy.deploymentId,staged.deploymentId,applyOne.commandId,rollbackCommand.commandId] };
  },
);

export const A_CASES = [A01,A02,A03,A04,A05];
