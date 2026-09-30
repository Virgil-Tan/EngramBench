import { seededAssignment, seededLegacyDeployment, v1Seed } from "../lib/fixtures.mjs";
import { assertDeployment, assertPublicError, reconcileSnapshot } from "../lib/oracle.mjs";
import { boot, createLegacy, createStaged, defineCase, deploymentFrom, expectError, rollbackFor, snapshot, waitForCommand, waitForState } from "./helpers.mjs";

const D01 = defineCase(
  "D-01",
  "Exact V1 Fleet, Configuration, Deployment and Assignment graph with contiguous revisions and sequences",
  "Import by public seed command, replay it, reject a version conflict and four independently broken graphs, then read runtime and canonical OpenAPI",
  "Recompute all digests and references, compare atomic snapshots and triangulate exact statuses, schemas, required fields, nullability and error envelope",
  ["seed-command","public-http","openapi","verification-snapshot"],
  async (ctx) => {
    const catalog = ctx.catalog({ count:2 }), deployment = seededLegacyDeployment(ctx.fixtures,catalog), assignments = catalog.agents.map((agent,index) => seededAssignment(ctx.fixtures,deployment,agent,index,{ digest:catalog.configuration.canonicalDigest }));
    catalog.agents.forEach((agent) => { agent.lastCommandSequence = 1; });
    const seed = v1Seed(ctx.fixtures,"d01-valid",{ catalog,deployments:[deployment],assignments });
    await ctx.seed(seed); await ctx.seed(seed);
    const api = await ctx.startApi(), baseline = await snapshot(ctx,api.baseUrl);
    const detail = await ctx.getDeployment(api.baseUrl,deployment.deploymentId);
    ctx.equal("seeded Deployment runtime status",detail.status,200); ctx.assert("seeded Deployment exact runtime shape",() => assertDeployment(detail.json));
    const changed = structuredClone(seed); changed.fleets[0].name = "Different";
    const conflict = await ctx.seed(changed,{ expectFailure:true });
    ctx.ok("seed version conflict is exact",`${conflict.stdout}\n${conflict.stderr}`.includes("SEED_VERSION_CONFLICT"));
    const invalid = [];
    const brokenRevision = structuredClone(seed); brokenRevision.seedVersion = "d01-broken-revision"; brokenRevision.fleets[0].currentRevision = 2; brokenRevision.configurations[0].revision = 2; invalid.push(brokenRevision);
    const brokenSequence = structuredClone(seed); brokenSequence.seedVersion = "d01-broken-sequence"; brokenSequence.assignments[0].commandSequence = 2; brokenSequence.agents[0].lastCommandSequence = 2; invalid.push(brokenSequence);
    const brokenReference = structuredClone(seed); brokenReference.seedVersion = "d01-broken-reference"; brokenReference.assignments[0].agentId = ctx.uuid("missing-agent"); invalid.push(brokenReference);
    const unknownMember = structuredClone(seed); unknownMember.seedVersion = "d01-unknown-member"; unknownMember.managerState = []; invalid.push(unknownMember);
    for (const graph of invalid) {
      await ctx.seed(graph,{ expectFailure:true });
      const after = await snapshot(ctx,api.baseUrl);
      ctx.equal("invalid seed leaves business state, Work and Events unchanged",ctx.canonical({ resources:after.resources,work:after.work,events:after.events }),ctx.canonical({ resources:baseline.resources,work:baseline.work,events:baseline.events }));
    }
    const openapi = await ctx.readOpenApi(api.baseUrl);
    ctx.ok("OpenAPI is version 3.1",/^3\.1(?:\.|$)/u.test(openapi.openapi));
    const requiredOperations = [
      ["/api/v1/fleets/{fleetId}/configurations","post","201"],
      ["/api/v1/deployments","post","202"],
      ["/api/v1/deployments/{deploymentId}","get","200"],
      ["/api/v1/agents/{agentId}/poll","post","200"],
      ["/api/v1/agents/{agentId}/acknowledgements","post","200"],
      ["/api/v1/verification-snapshot","get","200"],
    ];
    for (const [path,method,status] of requiredOperations) ctx.ok(`OpenAPI publishes ${method.toUpperCase()} ${path} ${status}`,Boolean(openapi.paths?.[path]?.[method]?.responses?.[status]));
    ctx.ok("OpenAPI publishes exact common error envelope",Boolean(openapi.components?.schemas && JSON.stringify(openapi.components.schemas).includes("UNKNOWN_FIELD") && JSON.stringify(openapi.components.schemas).includes("FLEET_REVISION_CHANGED")));
    return { evidence:[deployment.deploymentId,assignments.map(({ assignmentId }) => assignmentId),openapi.openapi] };
  },
);

async function requireVisible(control,label) {
  if (await control.count() === 0) throw new Error(`missing visible ${label}`);
  return control.first();
}

async function fillLabel(page,name,value) {
  const control = await requireVisible(page.getByLabel(name),`control ${name}`);
  await control.fill(String(value));
}

async function maybeOpen(page,name) {
  const button = page.getByRole("button",{ name });
  if (await button.count()) await button.first().click();
}

async function submitAndCapture(page,name,pathPattern) {
  const button = await requireVisible(page.getByRole("button",{ name }),`button ${name}`);
  const [response] = await Promise.all([page.waitForResponse((candidate) => candidate.request().method() === "POST" && pathPattern.test(new URL(candidate.url()).pathname)),button.click()]);
  const json = await response.json();
  if (response.status() >= 400) throw new Error(`UI mutation failed ${response.status()}: ${JSON.stringify(json)}`);
  return { status:response.status(),json };
}

const D02 = defineCase(
  "D-02",
  "Desktop Configuration and legacy Deployment creation followed by Agent delivery, acknowledgement and mobile refresh",
  "Use production Chromium visible labelled controls, then public Agent seams and refresh the UI to observe history, Events and terminal state",
  "Compare captured browser HTTP identities to API and snapshot state while enforcing semantic controls, keyboard focus and legacy field omission",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","chromium","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:1 } });
    let configuration, deployment;
    await ctx.withPage(api,{ width:1280,height:800 },async (page) => {
      await page.goto("/",{ waitUntil:"networkidle" });
      await requireVisible(page.getByRole("heading",{ name:/ConfigRelay/i }),"ConfigRelay heading");
      await maybeOpen(page,/new configuration|publish configuration/i);
      await fillLabel(page,/fleet id/i,catalog.fleet.fleetId);
      await fillLabel(page,/expected fleet revision/i,1);
      await fillLabel(page,/configuration content|content json/i,JSON.stringify({ ui:"legacy",enabled:true }));
      configuration = await submitAndCapture(page,/publish|create configuration/i,/\/api\/v1\/fleets\/[^/]+\/configurations$/u);
      await maybeOpen(page,/new deployment|create deployment/i);
      await fillLabel(page,/fleet id/i,catalog.fleet.fleetId);
      await fillLabel(page,/configuration revision/i,configuration.json.revision);
      await fillLabel(page,/expected fleet revision/i,configuration.json.revision);
      await fillLabel(page,/selector key/i,"environment");
      await fillLabel(page,/selector value/i,"production");
      deployment = await submitAndCapture(page,/create deployment|deploy/i,/\/api\/v1\/deployments$/u);
      await page.keyboard.press("Tab");
      ctx.ok("keyboard focus remains visible",await page.evaluate(() => document.activeElement !== document.body));
    });
    ctx.equal("UI publishes Configuration status",configuration.status,201);
    ctx.equal("UI publishes legacy Deployment status",deployment.status,202);
    ctx.assert("UI-created legacy response omits Manager fields",() => assertDeployment(deployment.json));
    const worker = await ctx.startWorker(), command = await waitForCommand(ctx,api.baseUrl,catalog.agents[0],{ processes:[worker] });
    await ctx.acknowledge(api.baseUrl,command.agentId,command,"APPLIED");
    const terminal = await waitForState(ctx,api.baseUrl,(state) => deploymentFrom(state,deployment.json.deploymentId),(value) => value?.state === "APPLIED",{ label:"legacy terminal Deployment",processes:[worker] });
    await ctx.withPage(api,{ width:390,height:844 },async (page) => {
      await page.goto("/",{ waitUntil:"networkidle" });
      await page.reload({ waitUntil:"networkidle" });
      await requireVisible(page.getByText(deployment.json.deploymentId,{ exact:false }),"Deployment identity after refresh");
      await requireVisible(page.getByText(/APPLIED/i),"terminal state");
      await requireVisible(page.getByText(/history|event/i),"history or Event evidence");
    });
    ctx.equal("browser and snapshot share Deployment identity",terminal.selected.deploymentId,deployment.json.deploymentId);
    return { evidence:[configuration.json.canonicalDigest,deployment.json.deploymentId,command.assignmentId] };
  },
);

const D03 = defineCase(
  "D-03",
  "Visible two-Agent staged Deployment form followed by one successful and one rejected APPLY",
  "Create the Cohort plan in production Chromium, drive failure and rollback through public Agent seams, acknowledge rollback and refresh",
  "Close UI labels, runtime commands, snapshot counts and rollback identities without mock state, private endpoints or invented Events",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","chromium","verification-snapshot"],
  async (ctx) => {
    const { catalog,api } = await boot(ctx,{ catalogOptions:{ count:2,cohortCount:1 } });
    let deployment;
    await ctx.withPage(api,{ width:1280,height:800 },async (page) => {
      await page.goto("/",{ waitUntil:"networkidle" });
      await maybeOpen(page,/new deployment|create deployment/i);
      await fillLabel(page,/fleet id/i,catalog.fleet.fleetId);
      await fillLabel(page,/configuration revision/i,1);
      await fillLabel(page,/expected fleet revision/i,1);
      await fillLabel(page,/selector key/i,"environment");
      await fillLabel(page,/selector value/i,"production");
      await maybeOpen(page,/add cohort/i);
      await fillLabel(page,/cohort name|name/i,"Canary");
      await fillLabel(page,/cohort selector key/i,"environment");
      await fillLabel(page,/cohort selector value/i,"production");
      await fillLabel(page,/minimum success/i,10_000);
      await fillLabel(page,/maximum failure/i,0);
      await fillLabel(page,/observation seconds|deadline seconds/i,60);
      deployment = await submitAndCapture(page,/create deployment|deploy/i,/\/api\/v1\/deployments$/u);
    });
    ctx.equal("staged UI create status",deployment.status,202);
    ctx.assert("staged UI response exact",() => assertDeployment(deployment.json,{ staged:true }));
    const worker = await ctx.startWorker(), commands = await ctx.concurrent(catalog.agents,2,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] }));
    await ctx.acknowledge(api.baseUrl,commands[0].agentId,commands[0],"APPLIED");
    await ctx.acknowledge(api.baseUrl,commands[1].agentId,commands[1],"REJECTED");
    const rollbackCommand = await waitForCommand(ctx,api.baseUrl,{ ...catalog.agents[0],appliedRevision:commands[0].toRevision },{ lastCommandSequence:commands[0].commandSequence,processes:[worker] });
    await ctx.acknowledge(api.baseUrl,rollbackCommand.agentId,rollbackCommand,"APPLIED");
    const complete = await waitForState(ctx,api.baseUrl,(state) => rollbackFor(state,deployment.json.deploymentId),(value) => value?.state === "COMPLETED",{ label:"UI rollback completion",processes:[worker] });
    await ctx.withPage(api,{ width:390,height:844 },async (page) => {
      await page.goto("/",{ waitUntil:"networkidle" });
      await page.reload({ waitUntil:"networkidle" });
      await requireVisible(page.getByText(deployment.json.deploymentId,{ exact:false }),"staged Deployment identity");
      await requireVisible(page.getByText(/cohort/i),"Cohort evidence");
      await requireVisible(page.getByText(/rollback/i),"Rollback evidence");
      await requireVisible(page.getByText(/completed/i),"Rollback terminal state");
    });
    ctx.equal("UI rollback count matches runtime",[complete.selected.completedCount,complete.selected.commandCount],[1,1]);
    ctx.equal("UI flow creates no unpublished Event",complete.state.events.some(({ type }) => /cohort|rollback/iu.test(type)),false);
    return { evidence:[deployment.json.deploymentId,rollbackCommand.commandId,complete.selected.rollbackId] };
  },
);

const D04 = defineCase(
  "D-04",
  "Mixed cancelled legacy Deployment and failed staged Deployment with terminal and nonterminal Work",
  "Race a rollback acknowledgement with an ADMIN snapshot and compare the point-in-time result to stable public detail and Agent observations",
  "Validate the exact eight-resource union, scalar tuple ordering, token omission, three Work kinds, retained terminal rows, Event order and all references",
  ["seed-command","public-http","agent-poll","agent-ack","worker-process","verification-snapshot"],
  async (ctx) => {
    const catalog = ctx.catalog({ count:3,cohortCount:1 });
    catalog.agents[0].labels.flow = "legacy"; catalog.agents[1].labels.flow = "staged"; catalog.agents[2].labels.flow = "staged";
    const { api } = await boot(ctx,{ catalog });
    const legacy = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"flow",value:"legacy" } } });
    await ctx.cancelDeployment(api.baseUrl,legacy.deploymentId);
    const outer = { labels:{ key:"flow",value:"staged" } }, plan = [{ name:"Snapshot",selector:outer,minimumSuccessBasisPoints:10_000,maximumFailureBasisPoints:0,observationSeconds:60 }];
    const staged = await createStaged(ctx,api.baseUrl,catalog,plan,{ selector:outer }), worker = await ctx.startWorker();
    const apply = await ctx.concurrent(catalog.agents.slice(1),2,(agent) => waitForCommand(ctx,api.baseUrl,agent,{ processes:[worker] }));
    await ctx.acknowledge(api.baseUrl,apply[0].agentId,apply[0],"APPLIED");
    await ctx.acknowledge(api.baseUrl,apply[1].agentId,apply[1],"REJECTED");
    const rollbackCommand = await waitForCommand(ctx,api.baseUrl,{ ...catalog.agents[1],appliedRevision:apply[0].toRevision },{ lastCommandSequence:apply[0].commandSequence,processes:[worker] });
    await ctx.stop(worker);
    const pendingLegacy = await createLegacy(ctx,api.baseUrl,catalog,{ selector:{ labels:{ key:"flow",value:"legacy" } } });
    const [pointInTime,ack] = await Promise.all([ctx.snapshot(api.baseUrl),ctx.acknowledge(api.baseUrl,rollbackCommand.agentId,rollbackCommand,"APPLIED")]);
    ctx.ok("concurrent acknowledgement has published outcome",[200,409].includes(ack.status));
    ctx.assert("FINAL snapshot independently reconciles",() => reconcileSnapshot(pointInTime),{ hardCapIds:["ORDERED_DELIVERY_CORRECTNESS","ROLLBACK_RECOVERY_CORRECTNESS"] });
    ctx.equal("FINAL resources are exact union",Object.keys(pointInTime.resources).sort(),["acknowledgements","agents","assignments","configurations","deploymentCohorts","deploymentRollbacks","deployments","rolloutCommands"].sort());
    ctx.ok("snapshot includes retained terminal and active Work",pointInTime.work.some(({ terminal }) => terminal) && pointInTime.work.some(({ terminal }) => !terminal));
    ctx.ok("snapshot Work kinds stay within FINAL enum",pointInTime.work.every(({ kind }) => ["ASSIGNMENT_DELIVERY","COHORT_DEADLINE","ROLLBACK_DELIVERY"].includes(kind)));
    const legacyDetail = await ctx.getDeployment(api.baseUrl,legacy.deploymentId), stagedDetail = await ctx.getDeployment(api.baseUrl,staged.deploymentId);
    ctx.assert("legacy detail stays closed V1",() => assertDeployment(legacyDetail.json));
    ctx.assert("staged detail stays closed Manager shape",() => assertDeployment(stagedDetail.json,{ staged:true }));
    ctx.ok("recursive token omission holds",!/["']?[A-Za-z]*Token["']?\s*:/u.test(JSON.stringify(pointInTime)));
    return { evidence:[pointInTime.asOf,legacy.deploymentId,pendingLegacy.deploymentId,staged.deploymentId,rollbackCommand.commandId] };
  },
);

export const D_CASES = [D01,D02,D03,D04];
