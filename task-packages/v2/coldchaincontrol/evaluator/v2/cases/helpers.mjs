import { candidateAssert as assert } from "../lib/execution.mjs";
import { canonicalJson, exactKeys, hmacSha256, handoffAttestationLine, assertEventSequence, assertNoSecrets, assertWork, percentile, signedDeviceHeaders, tupleSort } from "../oracles/index.mjs";

export const RESOURCE_KEYS = ["tenants", "sites", "carriers", "deviceCredentials", "devices", "configRevisions", "configAssignments", "shipments", "shipmentLegs", "telemetryReadings", "shipmentProjections", "excursions", "notificationPolicies", "notificationDeliveries", "auditEntries"];
export const MANAGER_KEYS = ["custodyChains", "custodyHandoffs", "recallOrders", "quarantineActions"];
export const SHAPES = Object.freeze({
  tenants: ["tenantId", "name"], sites: ["siteId", "tenantId", "code", "name", "latitudeE6", "longitudeE6", "radiusMeters", "timeZone"], carriers: ["carrierId", "tenantId", "code", "name", "state"], deviceCredentials: ["deviceCredentialId", "tenantId", "deviceId", "keyVersion", "state", "validFrom", "revokedAt"], devices: ["deviceId", "tenantId", "carrierId", "serialNumber", "state", "currentKeyVersion", "currentConfigVersion", "lastSequence", "lastSeenAt"], configRevisions: ["configRevisionId", "tenantId", "version", "state", "minTemperatureMilliC", "maxTemperatureMilliC", "sampleIntervalSeconds", "offlineAfterSeconds", "createdAt", "publishedAt"], configAssignments: ["configAssignmentId", "tenantId", "deviceId", "configRevisionId", "state", "expiresAt", "confirmedAt", "createdAt"], shipments: ["shipmentId", "tenantId", "externalRef", "productLotCode", "carrierId", "originSiteId", "destinationSiteId", "deviceId", "state", "minimumTemperatureMilliC", "maximumTemperatureMilliC", "expectedStartAt", "expectedEndAt", "activatedAt", "terminalAt"], shipmentLegs: ["shipmentLegId", "shipmentId", "ordinal", "fromSiteId", "toSiteId", "plannedDepartureAt", "plannedArrivalAt"], telemetryReadings: ["telemetryReadingId", "tenantId", "deviceId", "readingId", "sequence", "observedAt", "receivedAt", "latitudeE6", "longitudeE6", "temperatureMilliC", "configVersion", "keyVersion", "signature"], shipmentProjections: ["shipmentId", "tenantId", "lastSequence", "lastObservedAt", "lastLatitudeE6", "lastLongitudeE6", "lastTemperatureMilliC", "currentSiteId", "currentLegOrdinal", "state", "updatedAt"], excursions: ["excursionId", "tenantId", "shipmentId", "kind", "state", "openedAt", "acknowledgedAt", "resolvedAt", "firstSequence", "lastSequence", "minimumObservedMilliC", "maximumObservedMilliC"], notificationPolicies: ["notificationPolicyId", "tenantId", "eventKinds", "destination", "rateLimitPerMinute", "state"], notificationDeliveries: ["notificationDeliveryId", "tenantId", "notificationPolicyId", "eventId", "state", "attempts", "nextAttemptAt", "deliveredAt"], auditEntries: ["auditEntryId", "tenantId", "actorType", "actorRef", "action", "resourceType", "resourceId", "occurredAt", "details"], custodyChains: ["custodyChainId", "tenantId", "shipmentId", "revision", "state", "currentOrdinal", "createdAt", "terminalAt"], custodyHandoffs: ["custodyHandoffId", "custodyChainId", "ordinal", "fromCarrierId", "toCarrierId", "siteId", "windowStart", "windowEnd", "state", "offeredAt", "acceptedAt", "terminalAt"], recallOrders: ["recallId", "tenantId", "productLotCode", "reason", "state", "revision", "issuedAt", "terminalAt"], quarantineActions: ["quarantineActionId", "recallId", "shipmentId", "state", "expectedShipmentState", "createdAt", "appliedAt", "releasedAt"],
});

const TITLES = Object.freeze({
  "A-01":"Clean lifecycle and independent roles","A-02":"Populated migration and seed replay","A-03":"Atomic seed rejection and secret protection","A-04":"OpenAPI 3.1 route/error coverage","A-05":"Strict input, error envelope and tenant isolation","A-06":"Device authentication and scalar boundaries","A-07":"Excursion list filters and stable cursor","A-08":"Tenant, Site, Carrier and Device catalog","A-09":"Gapless Config publication","A-10":"Assignment delivery and acknowledgement","A-11":"Credential rotation and revocation","A-12":"Signed telemetry acceptance","A-13":"Shipment creation and activation","A-14":"Projection, excursion, cancellation and delivery","A-15":"Notification policies, deliveries and snapshot","A-16":"FINAL custody and recall public lifecycle",
  "B-01":"Config version/CAS contention","B-02":"Credential rotation versus ingest","B-03":"Telemetry identity and durable idempotency","B-04":"Device auth anti-replay boundary","B-05":"Hot-device two-API ordering","B-06":"Late-reading historical correction","B-07":"Shipment activate/device/terminal races","B-08":"Excursion/offline race matrix","B-09":"Custody handoff authority contention","B-10":"Recall frozen-set atomicity",
  "C-01":"Work schema/lifecycle/retention","C-02":"Config assignment Worker kill","C-03":"Telemetry projection Worker kill","C-04":"Offline-check recovery and fencing","C-05":"Handoff expiry and replacement","C-06":"Recall propagation/quarantine recovery","C-07":"Dispatcher unknown ACK","C-08":"Shared notification quota and ordering",
  "D-01":"OpenAPI validates live traffic","D-02":"Browser configuration-to-live-shipment","D-03":"Browser excursions and notifications","D-04":"Browser FINAL custody and recall","D-05":"Loading/empty/conflict/stale/offline/retry/permission","D-06":"Keyboard, focus, labels and mobile","D-07":"Project-owned gates are real","D-08":"README-to-evidence closure",
  "E-01":"Populated V1→FINAL migration","E-02":"Saved replay and credential/Event identity","E-03":"Pending Work/delivery across migration","E-04":"Signed telemetry ingest performance","E-05":"Hot-device ordering performance","E-06":"Configuration rollout recovery performance","E-07":"Excursion notification recovery performance","E-08":"Recall quarantine convergence performance","E-09":"Cleanup, reproducibility and log hygiene",
});
const FAMILY = Object.freeze({ A:["EMPTY","MIGRATION","EMPTY","CONFIG","CONFIG","CREDENTIAL","EXCURSION","CONFIG","CONFIG","CONFIG","CREDENTIAL","TELEMETRY","SHIPMENT","EXCURSION","NOTIFICATION","CUSTODY"], B:["CONFIG","CREDENTIAL","IDEMPOTENCY","CREDENTIAL","TELEMETRY","EXCURSION","SHIPMENT","EXCURSION","CUSTODY","RECALL"], C:["WORK","WORK","WORK","WORK","CUSTODY","RECALL","NOTIFICATION","NOTIFICATION"], D:["CONFIG","BROWSER","BROWSER","BROWSER","BROWSER","BROWSER","BROWSER","BROWSER"], E:["MIGRATION","MIGRATION","MIGRATION","PERF","PERF","PERF","PERF","PERF","PERF"] });

export function defineCase(id, run) { const title = TITLES[id], dimension = id[0], family = FAMILY[dimension]?.[Number(id.slice(2)) - 1]; if (!title || !family) throw new Error(`unknown ColdChainControl case ${id}`); return Object.freeze({ id, taskId:"coldchaincontrol", fixtureFamily:`CCC-F-${family}`, action:`Exercise ColdChainControl ${title} through published commands HTTP production processes and public observation seams`, oracle:`Compare ${title} with task-local deterministic HMAC projection custody recall and persistence oracles`, async run(ctx){ return run(ctx); } }); }
export function guardedCase(id, hardCapIds, run) { return defineCase(id, async (ctx) => { try { return await run(ctx); } catch (error) { error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; } }); }
export function diagnostic(assertionId, blockedBy) { return { assertionId, blockedBy, policy:"fail-closed-diagnostic" }; }
export function successful(response, label = "request", statuses) { assert.ok(statuses ? statuses.includes(response.status) : response.status >= 200 && response.status < 300, `${label} returned ${response.status}: ${response.text}`); assert.ok(response.json !== undefined, `${label} returns JSON`); return response; }
export function semanticError(response, status, code) { assert.equal(response.status, status, `${code} status`); exactKeys(response.json, ["error"], `${code} envelope`); exactKeys(response.json.error, ["code","message","details"], `${code} error`); assert.equal(response.json.error.code, code); assert.equal(typeof response.json.error.message, "string"); assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details)); }
export function resourceFrom(json, idField, envelope) { if (json && typeof json === "object" && !Array.isArray(json) && Object.hasOwn(json, idField)) return json; const value = json?.[envelope]; assert.ok(value && typeof value === "object", `${envelope} resource response`); return value; }
export function listFrom(json) { if (Array.isArray(json)) return json; assert.ok(Array.isArray(json?.items), "list items"); return json.items; }
export function resources(snapshot) { assert.ok(snapshot?.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events)); return snapshot.resources; }
export function stableSnapshot(snapshot) { const copy = structuredClone(snapshot); delete copy.asOf; return canonicalJson(copy); }

export async function heldWorker(ctx, kinds, { onClaim } = {}) {
  let captured;
  const accepted = Array.isArray(kinds) ? kinds : [kinds];
  const barrier = await ctx.barrier({ hold: (body, entry) => {
    if (onClaim && body.point === 'worker.claimed') onClaim(body, Date.now());
    if (!captured && body.point === 'worker.before-commit' && accepted.includes(body.kind)) { captured = entry; return true; }
    return false;
  } });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(item => item === captured, { processes: [worker], timeoutMs: 60_000 });
  return { worker, entry, barrier };
}
export async function faultWorkers(ctx, kinds, { onClaim } = {}) {
  const observer = onClaim && await ctx.barrier({ hold: body => { if (body.point === 'worker.claimed') onClaim(body, Date.now()); return false; } });
  const observerEnv = observer ? { TEST_BARRIER_URL: observer.url, TEST_BARRIER_TOKEN: observer.token } : {};
  const held = await Promise.all(Array.from({ length: 3 }, () => heldWorker(ctx, kinds, { onClaim })));
  const other = await ctx.startWorker({ env: observerEnv });
  return { workers: [...held.map(item => item.worker), other], stale: held[2], observerEnv };
}
export function firstClaimQueueAge(work, claims) {
  const claim = claims.get(work.workId), available = Date.parse(work.availableAt);
  assert.ok(Number.isFinite(claim), 'each measured Work has an observed first claim');
  assert.ok(Number.isFinite(available), 'each measured Work publishes availableAt');
  return Math.max(0, claim - available);
}
export async function releaseStaleWorker(ctx, baseUrl, held) {
  const { workId, attempt } = held.entry.json;
  const snapshotBefore = await ctx.snapshot(baseUrl), before = snapshotBefore.work.find(row => row.workId === workId);
  assert.ok(before && before.terminal && before.attempt > attempt, 'replacement completes the exact held Work with a newer attempt');
  held.barrier.release(held.entry);
  const receipt = await held.barrier.waitFor(entry => entry.json.point === 'worker.after-attempt' && entry.json.workId === workId && entry.json.attempt === attempt, { processes: [held.worker], timeoutMs: 30_000 });
  assert.equal(receipt.json.outcome, 'stale', 'released obsolete owner cannot commit');
  const snapshotAfter = await ctx.snapshot(baseUrl), after = snapshotAfter.work.find(row => row.workId === workId);
  assert.deepEqual(after, before, 'stale completion cannot rewrite terminal Work');
  const surface = snapshot => ({ resources: Object.fromEntries(Object.entries({ ...snapshot.resources, ...snapshot.managerResources }).map(([name, rows]) => [name, rows.filter(row => JSON.stringify(row).includes(held.entry.json.aggregateId))])), events: snapshot.events.filter(event => event.aggregateId === held.entry.json.aggregateId) });
  assert.deepEqual(surface(snapshotAfter), surface(snapshotBefore), 'stale completion cannot rewrite the protected aggregate or its Events');
  await ctx.kill(held.worker);
}

export async function prepare(ctx, fixture, { apiCount=1, workerCount=0, dispatcherCount=0, migrateTwice=false, webhookUrl } = {}) { await ctx.migrate(); if (migrateTwice) await ctx.migrate(); await ctx.seed(fixture.seed); const apis = await Promise.all(Array.from({length:apiCount},()=>ctx.startApi())), workers = await Promise.all(Array.from({length:workerCount},()=>ctx.startWorker())), dispatchers = await Promise.all(Array.from({length:dispatcherCount},()=>ctx.startDispatcher({ webhookUrl }))); ctx.mark("coldchaincontrol.prepared",{fixtureFamily:fixture.fixtureFamily,apiCount,workerCount,dispatcherCount}); return {api:apis[0],apis,workers,dispatchers}; }
export async function mutate(ctx, baseUrl, path, label, body, options={}) { const response = await ctx.mutate(baseUrl,path,options.key??ctx.key(label),body,{method:options.method??"POST",headers:options.headers,contractExpectation:options.contractExpectation}); if(options.expectSuccess!==false) successful(response,label,options.statuses); return response; }
export async function snapshotTime(ctx, baseUrl) { return (await ctx.snapshot(baseUrl)).asOf; }
export async function deviceRequest(ctx, baseUrl, fixture, method, path, { body, keyVersion=1, secret=fixture.deviceSecret, deviceId=fixture.device.deviceId, timestamp, signature, expectSuccess=true, key, contractExpectation }={}) { const time = timestamp ?? await snapshotTime(ctx,baseUrl), headers = signedDeviceHeaders({method,path,timestamp:time,keyVersion,deviceId,secret}); if(signature) headers["x-device-signature"] = signature; const response = await ctx.request(baseUrl,path,{method,contractExpectation,headers:{...headers,...(key?{"idempotency-key":key}:{}),...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{json:body}:{})}); if(expectSuccess) successful(response,`${method} ${path}`); return response; }
export async function ingest(ctx, baseUrl, fixture, reading, label="reading", options={}) { const path="/api/v1/telemetry-readings"; return deviceRequest(ctx,baseUrl,fixture,"POST",path,{body:reading,key:options.key??ctx.key(`telemetry:${label}`),keyVersion:options.keyVersion??reading.keyVersion,secret:options.secret??fixture.deviceSecret,deviceId:options.deviceId??reading.deviceId,timestamp:options.timestamp,signature:options.headerSignature,expectSuccess:options.expectSuccess!==false,contractExpectation:options.contractExpectation}); }
export async function createConfig(ctx,baseUrl,fixture,label,overrides={}) { const body={tenantId:fixture.tenant.tenantId,minTemperatureMilliC:overrides.minimum??1_500,maxTemperatureMilliC:overrides.maximum??8_500,sampleIntervalSeconds:overrides.sampleIntervalSeconds??30,offlineAfterSeconds:overrides.offlineAfterSeconds??180,...overrides.extra}; const response=await mutate(ctx,baseUrl,"/api/v1/config-revisions",`config:${label}`,body,{expectSuccess:overrides.expectSuccess!==false}); return {body,response,config:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"configRevisionId","configRevision")}; }
export async function publishConfig(ctx,baseUrl,configRevisionId,expectedVersion,label="publish",options={}) { return mutate(ctx,baseUrl,`/api/v1/config-revisions/${configRevisionId}/publish`,`publish:${label}`,{expectedVersion},{expectSuccess:options.expectSuccess!==false}); }
export async function createAssignment(ctx,baseUrl,fixture,configRevisionId,label="assignment",options={}) { const body={configRevisionId,expiresAt:options.expiresAt??fixture.at?.({hours:2})??ctx.at({hours:2})}; const response=await mutate(ctx,baseUrl,`/api/v1/devices/${fixture.device.deviceId}/config-assignments`,`assignment:${label}`,body,{expectSuccess:options.expectSuccess!==false}); return {body,response,assignment:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"configAssignmentId","configAssignment")}; }
export async function rotateCredential(ctx,baseUrl,fixture,label="rotate",options={}) { const body={expectedKeyVersion:options.expectedKeyVersion??fixture.device.currentKeyVersion,secret:options.secret??ctx.fixtures.secret(`rotation:${label}`),validFrom:options.validFrom??await snapshotTime(ctx,baseUrl)}; const response=await mutate(ctx,baseUrl,`/api/v1/devices/${fixture.device.deviceId}/credentials/rotate`,`rotate:${label}`,body,{expectSuccess:options.expectSuccess!==false}); return {body,response,credential:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"deviceCredentialId","deviceCredential")}; }
export async function revokeCredential(ctx,baseUrl,fixture,keyVersion,label="revoke",options={}) { return mutate(ctx,baseUrl,`/api/v1/devices/${fixture.device.deviceId}/credentials/${keyVersion}/revoke`,`revoke:${label}`,{reason:options.reason??"Evaluator credential revocation"},{expectSuccess:options.expectSuccess!==false}); }
export async function createShipment(ctx,baseUrl,fixture,label="shipment",overrides={},options={}) { const body=ctx.fixtures.shipmentBody(fixture,label,overrides), response=await mutate(ctx,baseUrl,"/api/v1/shipments",`shipment:${label}`,body,{expectSuccess:options.expectSuccess!==false}); return {body,response,shipment:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"shipmentId","shipment")}; }
export async function shipmentAction(ctx,baseUrl,shipmentId,action,label=action,options={}) { return mutate(ctx,baseUrl,`/api/v1/shipments/${shipmentId}/${action}`,`${action}:${label}`,options.body??{},{expectSuccess:options.expectSuccess!==false}); }
export function custodyBodyAt(body, asOf) {
  const shift = Date.parse(asOf) - 5 * 60_000 - Date.parse(body.steps[0].windowStart);
  return { ...body, steps: body.steps.map(step => ({ ...step,
    windowStart: new Date(Date.parse(step.windowStart) + shift).toISOString(),
    windowEnd: new Date(Date.parse(step.windowEnd) + shift).toISOString(),
  })) };
}
export async function createCustody(ctx,baseUrl,fixture,label="chain",options={}) { const body=options.body??custodyBodyAt(fixture.custodyBody,await snapshotTime(ctx,baseUrl)),response=await mutate(ctx,baseUrl,"/api/v1/custody-chains",`custody:${label}`,body,{expectSuccess:options.expectSuccess!==false,statuses:[201]}); return {body,response,chain:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"custodyChainId","chain")}; }
export async function getCustody(ctx,baseUrl,chainId) { return successful(await ctx.request(baseUrl,`/api/v1/custody-chains/${chainId}`),"GET custody",[200]).json; }
export async function offerHandoff(ctx,baseUrl,chainId,revision,label="offer",options={}) { return mutate(ctx,baseUrl,`/api/v1/custody-chains/${chainId}/handoffs`,`offer:${label}`,{expectedChainRevision:revision},{expectSuccess:options.expectSuccess!==false,statuses:[200]}); }
export async function acceptHandoff(ctx,baseUrl,fixture,handoff,revision,label="accept",options={}) { const carrierDevice=fixture.carrierDevices.find(({device})=>device.carrierId===handoff.toCarrierId),acceptedAt=options.acceptedAt??await snapshotTime(ctx,baseUrl),keyVersion=carrierDevice.device.currentKeyVersion,attestation=hmacSha256(carrierDevice.secret,handoffAttestationLine(handoff.custodyHandoffId,handoff.toCarrierId,acceptedAt,revision,keyVersion)),body={carrierId:handoff.toCarrierId,deviceId:carrierDevice.device.deviceId,keyVersion,attestation:options.attestation??attestation,acceptedAt,expectedChainRevision:revision}; return mutate(ctx,baseUrl,`/api/v1/custody-handoffs/${handoff.custodyHandoffId}/accept`,`accept:${label}`,body,{expectSuccess:options.expectSuccess!==false,statuses:[200]}); }
export async function createRecall(ctx,baseUrl,fixture,label="recall",options={}) { const body={...fixture.recallBody,issuedAt:options.issuedAt??await snapshotTime(ctx,baseUrl),...(options.body??{})},response=await mutate(ctx,baseUrl,"/api/v1/recalls",`recall:${label}`,body,{expectSuccess:options.expectSuccess!==false,statuses:[201]}); return {body,response,recall:response.status>=200&&response.status<300&&response.json&&resourceFrom(response.json,"recallId","recall")}; }
export async function quarantineRecall(ctx,baseUrl,recallId,revision,label="quarantine",options={}) { return mutate(ctx,baseUrl,`/api/v1/recalls/${recallId}/quarantine`,`quarantine:${label}`,{expectedRevision:revision},{expectSuccess:options.expectSuccess!==false,statuses:[202]}); }

export async function waitSnapshot(ctx,baseUrl,predicate,{timeoutMs=30_000,intervalMs=50,processes=[],label="snapshot predicate"}={}) { return ctx.waitFor(async()=>{const snapshot=await ctx.snapshot(baseUrl);return predicate(snapshot)?snapshot:undefined;},{timeoutMs,intervalMs,processes,label}); }
export async function waitForWork(ctx,baseUrl,predicate,options={}) { return waitSnapshot(ctx,baseUrl,(snapshot)=>snapshot.work.some(predicate),{...options,label:options.label??"public Work observation"}); }
export async function waitTerminalWork(ctx,baseUrl,aggregateId,options={}) { return waitSnapshot(ctx,baseUrl,(snapshot)=>{const selected=snapshot.work.filter((item)=>item.aggregateId===aggregateId);return selected.length>0&&selected.every((item)=>item.terminal);},{...options,label:`Work ${aggregateId} terminal`}); }
export async function startReceivers(ctx,count,behavior=()=>({status:204})) { return Promise.all(Array.from({length:count},(_,index)=>ctx.receiver({path:`/coldchain/${index}`,behavior:(entry,ledger)=>behavior(index,entry,ledger)}))); }

export function assertSnapshotShape(snapshot,{final=true,secrets=[]}={}) { exactKeys(snapshot,final?["schemaVersion","asOf","resources","work","events","managerResources"]:["schemaVersion","asOf","resources","work","events"],"snapshot"); assert.equal(snapshot.schemaVersion,1); exactKeys(snapshot.resources,RESOURCE_KEYS,"snapshot resources"); for(const [name,keys] of Object.entries(SHAPES)) { const collection=snapshot.resources[name]??snapshot.managerResources?.[name]; if(!collection) continue; assert.ok(Array.isArray(collection)); for(const value of collection) exactKeys(value,keys,name); const idField=keys[0]; assert.deepEqual(collection,tupleSort(collection,[idField]),`${name} sorted`); } if(final) exactKeys(snapshot.managerResources,MANAGER_KEYS,"manager resources"); assertWork(snapshot.work); assertEventSequence(snapshot.events); assertNoSecrets(snapshot,secrets,{snapshot:true}); return true; }
export function assertZeroEffect(before,after,label) { assert.equal(stableSnapshot(after),stableSnapshot(before),`${label} zero resources Work Event audit and replay side effect`); }

export async function fixedDurationLoad(ctx,{warmupMs,measureMs,concurrency,request,validate}) { let ordinal=0; async function phase(durationMs,measured){const deadline=performance.now()+durationMs,latencies=[],statuses=new Map();let completed=0;await Promise.all(Array.from({length:concurrency},async()=>{while(performance.now()<deadline){const index=ordinal++,started=performance.now(),response=await request(index,measured),latency=performance.now()-started;if(validate)await validate(response,index,measured);if(measured){completed+=1;latencies.push(latency);statuses.set(response.status,(statuses.get(response.status)??0)+1);}}}));return{completed,durationMs,throughput:completed/(durationMs/1000),p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99),statuses:Object.fromEntries(statuses)};} await phase(warmupMs,false);return phase(measureMs,true); }
export function assertLoad(result,{minimumThroughput,maximumP95,acceptedStatuses}) { const accepted=Object.entries(result.statuses).filter(([status])=>acceptedStatuses?acceptedStatuses.includes(Number(status)):Number(status)>=200&&Number(status)<300).reduce((sum,[,count])=>sum+count,0);assert.equal(accepted,result.completed,"all measured responses accepted");assert.ok(result.throughput>=minimumThroughput);assert.ok(result.p95<=maximumP95); }

export async function launchBrowser(ctx,fixture,{workers=1,dispatchers=1,viewport={width:1280,height:900},receiver:providedReceiver}={}) { await ctx.migrate();await ctx.seed(fixture.seed);await ctx.npm("build",[],{timeoutMs:180_000});const api=await ctx.startApi({healthTimeoutMs:60_000}),workerRecords=await Promise.all(Array.from({length:workers},()=>ctx.startWorker())),receiver=providedReceiver??await ctx.receiver({path:"/events"}),dispatcherRecords=await Promise.all(Array.from({length:dispatchers},()=>ctx.startDispatcher({webhookUrl:receiver.url}))),chromium=await ctx.loadChromium(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",headless:true});ctx.defer(()=>browser.close());const page=await browser.newPage({viewport});await page.goto(api.baseUrl,{waitUntil:"networkidle"});return{api,workerRecords,receiver,dispatcherRecords,browser,page}; }
export async function fillVisible(page, name, value) {
  const labelled = page.getByLabel(new RegExp(name, "i")).and(page.locator("input:visible,textarea:visible,select:visible")).first();
  const target = await labelled.count() ? labelled : page.locator(`[name="${name}"]:visible`).first();
  assert.ok(await target.count(), `visible control ${name}`);
  return fillControl(target, value);
}
export async function fillControl(control, value, { keyboard } = {}) {
  const select = await control.evaluate(element => element.tagName === 'SELECT');
  if (select && !keyboard) return control.selectOption(String(value));
  if (select) {
    const index = await control.locator('option').evaluateAll((options, expected) => options.findIndex(option => option.value === expected), String(value));
    assert.ok(index >= 0, 'select exposes requested public resource');
    await control.focus(); await keyboard.press('Home');
    for (let i = 0; i < index; i++) await keyboard.press('ArrowDown');
    return keyboard.press('Enter');
  }
  const formatted = await control.getAttribute('type') === 'datetime-local' ? String(value).replace(/Z$/i, '') : String(value);
  if (!keyboard) return control.fill(formatted);
  await control.focus(); await keyboard.press('ControlOrMeta+A'); await keyboard.type(formatted);
}
export async function clickVisible(page,name){const button=page.getByRole("button",{name:new RegExp(name,"i")}).first();assert.ok(await button.count(),`visible action ${name}`);await button.click();}
export async function visibleText(page, expression) {
  const name = expression instanceof RegExp ? new RegExp(expression.source, [...new Set(expression.flags + 'i')].join('')) : expression;
  const locator = page.getByText(name).and(page.locator(':visible')).first();
  try { await locator.waitFor({ state: 'visible' }); }
  catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    assert.fail(`visible text ${expression}`);
  }
  return locator;
}
