import { candidateAssert as assert } from "../lib/execution.mjs";
import { assertOpenApiContract, assertPublishedResponse, PUBLIC_OPERATIONS, validateJson } from "../oracles/openapi.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import { acceptHandoff, assertSnapshotShape, clickVisible, createCustody, createRecall, defineCase, deviceRequest, diagnostic, fillVisible, fillControl, guardedCase, getCustody, ingest, launchBrowser, offerHandoff, prepare, quarantineRecall, resourceFrom, resources, successful, visibleText, waitForWork, waitSnapshot } from "./helpers.mjs";
const { captureBrowserAction, captureBrowserResponse, observeBrowserWait } = await import(new URL('browser.mjs', process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL('../../../../../src/task-evaluator-v2/', import.meta.url)));

function responseSchema(document,method,path,status){const operation=document.paths[path][method],response=operation.responses[String(status)]??operation.responses.default,schema=response?.content?.["application/json"]?.schema;assert.ok(schema,`${method.toUpperCase()} ${path} ${status} response schema`);return schema;}
async function fillVisibleAt(page,name,index,value){const labelled=page.getByLabel(new RegExp(name,"i")).nth(index),named=page.locator(`[name*="${name}"]`).nth(index),control=await labelled.count()?labelled:named;assert.ok(await control.count(),`visible control ${name}[${index}]`);await fillControl(control,value);}

// A reload does not imply that an authenticated operational view has been read.
// Drive only the page's visible read control; never substitute a direct API call.
async function readBrowserView(ctx, page, { reload = true, pending, failed = false, status = 200 } = {}) {
  const origin = new URL(page.url()).origin;
  const token = page.getByLabel(/admin[\s_-]*token/i).and(page.locator('input:visible'));
  assert.ok(await token.count() <= 1, 'unambiguous visible Admin token');
  const authenticatedView = await token.count() === 1;
  let armed = !authenticatedView, requested = false;
  const selected = new Set(), matches = request => selected.has(request);
  const onRequest = request => {
    if (armed && request.method() === 'GET' && new URL(request.url()).origin === origin && new URL(request.url()).pathname.startsWith('/api/v1/')) {
      selected.add(request); requested = true;
    }
  };
  page.on('request', onRequest);
  try {
    const observed = await captureBrowserAction(page, matches, async () => {
      const started = observeBrowserWait(page.waitForRequest(matches));
      if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
      if (authenticatedView) {
        // Finish unrelated bootstrap reads before observing the authenticated
        // input/read action. Input itself may legitimately trigger the GET.
        await page.waitForLoadState('networkidle');
        armed = true;
        await token.fill(ctx.adminToken);
      }
      if (!requested) {
        const action = page.getByRole('button', { name: /^(?:refresh|reload|retry)(?:\s+(?:snapshot|data|view))?$/i }).and(page.locator(':visible'));
        assert.ok(await action.count() <= 1, 'unambiguous visible operational read action');
        if (await action.count()) await action.click();
      }
      await started;
      if (pending) await pending();
    });
    if (failed) assert.ok(observed.failure, 'offline probe observes a failed API GET');
    else {
      assert.ok(observed.response, 'operational read receives an HTTP response');
      assert.equal(observed.response.status(), status, 'operational read HTTP status');
    }
    await page.waitForLoadState('networkidle');
    return observed;
  } finally { page.off('request', onRequest); }
}

async function acknowledgeExcursion(page, excursion) {
  const buttons = page.getByRole('button', { name: /\backnowledge\b/i }).and(page.locator(':visible'));
  const rows = [], forms = [];
  for (const button of await buttons.all()) {
    // Some public views display shipment/kind/state rather than the internal ID.
    // A unique card plus the exact emitted POST binds the action to this excursion.
    const inRow = await button.evaluate((element, target) => {
      for (let row = element.parentElement; row && row !== document.body; row = row.parentElement) {
        const visible = [...row.querySelectorAll('*')].filter(item => item.checkVisibility());
        const shows = value => visible.some(item => item.innerText?.trim().toUpperCase() === value.toUpperCase());
        const actions = [...row.querySelectorAll('button')].filter(item => item.checkVisibility() && /\backnowledge\b/i.test(item.innerText));
        if (actions.length === 1 && shows('OPEN') && (shows(target.excursionId) || (shows(target.shipmentId) && shows(target.kind)))) return true;
      }
      return false;
    }, excursion);
    if (inRow) rows.push(button);
    const form = button.locator('xpath=ancestor::form[1]');
    if (await form.count()) {
      const input = form.getByLabel(/excursion/i).or(form.locator('[name="excursion"],[name="excursionId"]')).and(form.locator('input:visible,select:visible'));
      if (await input.count() === 1) forms.push({ button, input });
    }
  }
  assert.ok(rows.length <= 1 && forms.length <= 1, 'unambiguous visible excursion acknowledge action');
  const selected = rows[0] ?? forms[0]?.button;
  assert.ok(selected, 'visible excursion acknowledge action bound to the observed target');
  if (!rows.length) await fillControl(forms[0].input, excursion.excursionId);
  const response = await captureBrowserResponse(page, request => request.method() === 'POST'
    && new URL(request.url()).origin === new URL(page.url()).origin
    && /^\/api\/v1\/excursions\/[^/]+\/acknowledge$/.test(new URL(request.url()).pathname), () => selected.click());
  assert.equal(new URL(response.url()).pathname, `/api/v1/excursions/${excursion.excursionId}/acknowledge`, 'acknowledge POST targets the exact observed excursion');
  assert.ok(response.status() >= 200 && response.status() < 300, `excursion acknowledge returned ${response.status()}`);
}

const D01 = defineCase("D-01", async (ctx) => {
  const fixture = ctx.fixtures.recall(), { api } = await prepare(ctx, fixture);
  const document = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI", [200]).json;
  assertOpenApiContract(document);
  const emptyBodyRoutes = new Set([
    "/api/v1/shipments/{shipmentId}/activate", "/api/v1/shipments/{shipmentId}/cancel",
    "/api/v1/shipments/{shipmentId}/deliver", "/api/v1/excursions/{excursionId}/acknowledge",
  ]);
  const missingDeviceAuth = new Set([
    "/api/v1/devices/{deviceId}/config", "/api/v1/devices/{deviceId}/config-acknowledgements", "/api/v1/telemetry-readings",
  ]);
  for (const [method, template] of PUBLIC_OPERATIONS) {
    const path = template.replace(/\{([^}]+)\}/g, (_, name) => name === "keyVersion" ? "1" : ctx.uuid("contract-missing-" + name));
    // Each selected route deliberately omits its required body or authentication.
    // Empty-object transitions and valid reads remain ordinary legal-wire requests.
    const authMissing = missingDeviceAuth.has(template) || template === "/api/v1/verification-snapshot";
    const invalidWire = authMissing || (method === "post" && !emptyBodyRoutes.has(template));
    const before = invalidWire ? await ctx.snapshot(api.baseUrl) : undefined;
    const response = await ctx.request(api.baseUrl, path, {
      method: method.toUpperCase(),
      ...(invalidWire ? { contractExpectation: "invalid" } : {}),
      ...(method === "post" ? { headers: { "content-type": "application/json", "idempotency-key": ctx.key("contract:" + template) }, json: {} } : {}),
    });
    assert.ok(response.json !== undefined, `${method.toUpperCase()} ${template} live JSON`);
    validateJson(document, responseSchema(document, method, template, response.status), response.json, "live " + template);
    assertPublishedResponse(method.toUpperCase(), template, response);
    if (invalidWire) {
      assert.equal(response.status, authMissing ? 401 : 400);
      assert.equal(response.json.error.code, missingDeviceAuth.has(template) ? "INVALID_DEVICE_SIGNATURE" : authMissing ? "UNAUTHORIZED" : "INVALID_REQUEST");
      const after = await ctx.snapshot(api.baseUrl);
      delete before.asOf; delete after.asOf;
      assert.equal(canonicalJson(after), canonicalJson(before), "invalid wire has no side effects");
    }
  }
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const configPath=`/api/v1/devices/${fixture.device.deviceId}/config`,config=await deviceRequest(ctx,api.baseUrl,fixture,"GET",configPath);validateJson(document,responseSchema(document,"get","/api/v1/devices/{deviceId}/config",config.status),config.json,"live config");const reading=fixture.reading?fixture.reading("openapi",{sequence:1}):ctx.fixtures.reading(fixture,"openapi",{sequence:1}),telemetry=await ingest(ctx,api.baseUrl,fixture,reading,"openapi");validateJson(document,responseSchema(document,"post","/api/v1/telemetry-readings",telemetry.status),telemetry.json,"live telemetry");const chain=await createCustody(ctx,api.baseUrl,fixture),offer=successful(await offerHandoff(ctx,api.baseUrl,chain.chain.custodyChainId,chain.chain.revision)),handoff=resourceFrom(offer.json,"custodyHandoffId","handoff"),currentRevision=(await getCustody(ctx,api.baseUrl,chain.chain.custodyChainId)).chain.revision,accepted=await acceptHandoff(ctx,api.baseUrl,fixture,handoff,currentRevision);validateJson(document,responseSchema(document,"post","/api/v1/custody-handoffs/{handoffId}/accept",accepted.status),accepted.json,"live handoff accept");const recall=await createRecall(ctx,api.baseUrl,fixture);await quarantineRecall(ctx,api.baseUrl,recall.recall.recallId,recall.recall.revision);await waitSnapshot(ctx,api.baseUrl,(snapshot)=>snapshot.managerResources.recallOrders.some((item)=>item.recallId===recall.recall.recallId&&item.state==="CONTAINED"),{processes:workers});const invalid=await ctx.request(api.baseUrl,"/api/v1/verification-snapshot",{contractExpectation:"invalid"});assert.equal(invalid.status,401);validateJson(document,responseSchema(document,"get","/api/v1/verification-snapshot",invalid.status),invalid.json,"live unauthorized snapshot");assertPublishedResponse("GET", "/api/v1/devices/{deviceId}/config", config); assertPublishedResponse("POST", "/api/v1/telemetry-readings", telemetry); assertPublishedResponse("POST", "/api/v1/custody-handoffs/{handoffId}/accept", accepted); return ctx.pass();
});

const D02 = defineCase("D-02", async (ctx) => {
  const fixture=ctx.fixtures.browser(),{api,page,workerRecords}=await launchBrowser(ctx,fixture,{workers:2,dispatchers:0}),deviceRecord=fixture.carrierDevices[1],device=deviceRecord.device;await fillVisible(page,"tenant",fixture.tenant.tenantId);await fillVisible(page,"externalRef","BROWSER-SHIPMENT");await fillVisible(page,"productLotCode","BROWSER-LOT");await fillVisible(page,"carrier",device.carrierId);await fillVisible(page,"device",device.deviceId);await fillVisible(page,"origin",fixture.sites[0].siteId);await fillVisible(page,"destination",fixture.sites[2].siteId);await fillVisible(page,"minimumTemperatureMilliC","2000");await fillVisible(page,"maximumTemperatureMilliC","8000");await clickVisible(page,/create.*shipment/u);await visibleText(page,/DRAFT|draft/u);await clickVisible(page,/activate/u);await visibleText(page,/ACTIVE|active/u);let snapshot=await ctx.snapshot(api.baseUrl);const shipment=snapshot.resources.shipments.find((item)=>item.externalRef==="BROWSER-SHIPMENT");assert.ok(shipment);const deviceFixture={...fixture,device,deviceSecret:deviceRecord.secret,shipment};for(let sequence=1;sequence<=3;sequence+=1)await ingest(ctx,api.baseUrl,deviceFixture,ctx.fixtures.reading(deviceFixture,`browser-timeline:${sequence}`,{sequence,temperatureMilliC:5_000}),`browser-timeline:${sequence}`,{deviceId:device.deviceId,secret:deviceRecord.secret});snapshot=await waitSnapshot(ctx,api.baseUrl,(value)=>value.resources.shipmentProjections.some((item)=>item.shipmentId===shipment.shipmentId&&item.lastSequence===3),{processes:workerRecords});const timeline=successful(await ctx.request(api.baseUrl,`/api/v1/shipments/${shipment.shipmentId}/timeline`),"shipment timeline",[200]);assert.ok(timeline.text.includes("5000")&&timeline.text.includes("3"),"timeline exposes accepted ordered telemetry");await page.reload({waitUntil:"networkidle"});await visibleText(page,new RegExp(shipment.shipmentId,"i"));await visibleText(page,/config|device/u);await visibleText(page,/temperature|timeline|5(?:\.0)?\s*°?C/iu);const second=await page.context().newPage();await second.goto(api.baseUrl,{waitUntil:"networkidle"});await visibleText(second,new RegExp(shipment.shipmentId,"i"));assert.equal(snapshot.resources.shipmentProjections.find((item)=>item.shipmentId===shipment.shipmentId).lastSequence,3);return ctx.pass();
});

const D03 = defineCase("D-03", async (ctx) => {
  const receiver=await ctx.receiver({path:"/events"}),fixture=ctx.fixtures.notification(receiver.url),{api,page,workerRecords,dispatcherRecords}=await launchBrowser(ctx,fixture,{workers:2,dispatchers:1,receiver});for(const reading of fixture.readings.slice(0,3))await ingest(ctx,api.baseUrl,fixture,reading,`browser-out-${reading.sequence}`);const opened=await waitSnapshot(ctx,api.baseUrl,(snapshot)=>snapshot.resources.excursions.some((item)=>item.shipmentId===fixture.shipment.shipmentId&&item.state==="OPEN"),{processes:workerRecords}),excursion=opened.resources.excursions.find((item)=>item.shipmentId===fixture.shipment.shipmentId&&item.state==="OPEN");await readBrowserView(ctx,page);await visibleText(page,/OPEN|temperature/u);await acknowledgeExcursion(page,excursion);await visibleText(page,/ACKNOWLEDGED|acknowledged/u);for(const reading of fixture.readings.slice(3))await ingest(ctx,api.baseUrl,fixture,reading,`browser-in-${reading.sequence}`);await waitSnapshot(ctx,api.baseUrl,(snapshot)=>snapshot.resources.excursions.some((item)=>item.excursionId===excursion.excursionId&&item.state==="RESOLVED"),{processes:workerRecords});await ctx.waitFor(()=>receiver.ledger.some((entry)=>entry.acknowledged),{processes:dispatcherRecords,timeoutMs:20_000,label:"browser flow notification delivery"});await readBrowserView(ctx,page);await visibleText(page,/RESOLVED|resolved/u);await visibleText(page,/notification|delivery|audit/u);const final=resources(await ctx.snapshot(api.baseUrl)).excursions.find((item)=>item.excursionId===excursion.excursionId);assert.equal(final.state,"RESOLVED");assert.ok(final.acknowledgedAt);return ctx.pass();
});

const D04 = guardedCase("D-04", ["CUSTODY_RECALL_AUTHORITY","TENANT_SECRET_AUTHORITY"], async (ctx) => {
  const fixture=ctx.fixtures.browser(),{api,page,workerRecords}=await launchBrowser(ctx,fixture,{workers:2,dispatchers:1}),asOf=(await ctx.snapshot(api.baseUrl)).asOf,firstEnd=new Date(Date.parse(asOf)+5_000).toISOString(),secondEnd=new Date(Date.parse(asOf)+30_000).toISOString();await fillVisible(page,"shipment",fixture.shipment.shipmentId);await fillVisibleAt(page,"fromCarrier",0,fixture.carriers[0].carrierId);await fillVisibleAt(page,"toCarrier",0,fixture.carriers[1].carrierId);await fillVisibleAt(page,"site",0,fixture.sites[1].siteId);await fillVisibleAt(page,"windowStart",0,new Date(Date.parse(asOf)-10_000).toISOString());await fillVisibleAt(page,"windowEnd",0,firstEnd);await clickVisible(page,/add.*step/u);await fillVisibleAt(page,"fromCarrier",1,fixture.carriers[1].carrierId);await fillVisibleAt(page,"toCarrier",1,fixture.carriers[2].carrierId);await fillVisibleAt(page,"site",1,fixture.sites[2].siteId);await fillVisibleAt(page,"windowStart",1,firstEnd);await fillVisibleAt(page,"windowEnd",1,secondEnd);await clickVisible(page,/create.*chain/u);await visibleText(page,/PLANNED|planned/u);await clickVisible(page,/offer/u);await visibleText(page,/OFFERED|offered/u);let snapshot=await ctx.snapshot(api.baseUrl),chain=snapshot.managerResources.custodyChains.find((item)=>item.shipmentId===fixture.shipment.shipmentId),handoff=snapshot.managerResources.custodyHandoffs.find((item)=>item.custodyChainId===chain.custodyChainId&&item.ordinal===0),receiverDevice=fixture.carrierDevices[1],acceptedAt=snapshot.asOf;assert.equal(snapshot.managerResources.custodyHandoffs.filter((item)=>item.custodyChainId===chain.custodyChainId).length,2);await fillVisible(page,"carrierId",handoff.toCarrierId);await fillVisible(page,"deviceId",receiverDevice.device.deviceId);await fillVisible(page,"keyVersion","1");await fillVisible(page,"acceptedAt",acceptedAt);await fillVisible(page,"expectedChainRevision",String(chain.revision));await fillVisible(page,"attestation",ctx.fixtures.hmac([handoff.custodyHandoffId,handoff.toCarrierId,acceptedAt,chain.revision,1].join("|"),receiverDevice.secret));await clickVisible(page,/accept/u);await visibleText(page,/ACTIVE|active/u);await new Promise((resolve)=>setTimeout(resolve,Math.max(0,Date.parse(firstEnd)-Date.now()+150)));await clickVisible(page,/offer/u);await visibleText(page,/OFFERED|offered/u);snapshot=await ctx.snapshot(api.baseUrl);chain=snapshot.managerResources.custodyChains.find((item)=>item.custodyChainId===chain.custodyChainId);handoff=snapshot.managerResources.custodyHandoffs.find((item)=>item.custodyChainId===chain.custodyChainId&&item.ordinal===1);receiverDevice=fixture.carrierDevices[2];acceptedAt=snapshot.asOf;await fillVisible(page,"carrierId",handoff.toCarrierId);await fillVisible(page,"deviceId",receiverDevice.device.deviceId);await fillVisible(page,"keyVersion","1");await fillVisible(page,"acceptedAt",acceptedAt);await fillVisible(page,"expectedChainRevision",String(chain.revision));await fillVisible(page,"attestation",ctx.fixtures.hmac([handoff.custodyHandoffId,handoff.toCarrierId,acceptedAt,chain.revision,1].join("|"),receiverDevice.secret));await clickVisible(page,/accept/u);await visibleText(page,/COMPLETED|completed/u);await fillVisible(page,"productLotCode",fixture.shipment.productLotCode);await fillVisible(page,"reason","Browser recall");await clickVisible(page,/create.*recall|issue.*recall/u);await visibleText(page,/ISSUED|issued/u);await clickVisible(page,/quarantine/u);await waitSnapshot(ctx,api.baseUrl,(value)=>value.managerResources.recallOrders.some((item)=>item.productLotCode===fixture.shipment.productLotCode&&item.state==="CONTAINED"),{processes:workerRecords});await page.reload({waitUntil:"networkidle"});await visibleText(page,/CONTAINED|quarantine|APPLIED/u);const final=await ctx.snapshot(api.baseUrl),finalChain=final.managerResources.custodyChains.find((item)=>item.custodyChainId===chain.custodyChainId);assert.equal(finalChain.state,"COMPLETED");assert.equal(finalChain.currentOrdinal,2);assert.equal(final.resources.shipments.find((item)=>item.shipmentId===fixture.shipment.shipmentId).carrierId,fixture.carriers[2].carrierId);assert.equal((await page.content()).includes(receiverDevice.secret),false);return ctx.pass();
});

const D05 = defineCase("D-05", async (ctx) => {
  const fixture=ctx.fixtures.browser(),{api,page}=await launchBrowser(ctx,fixture,{workers:0,dispatchers:0});await visibleText(page,/shipment|empty|device/u);let delayed=false;await page.route("**/api/v1/**",async(route)=>{if(route.request().method()!=="GET")return route.continue();delayed=true;await new Promise((resolve)=>setTimeout(resolve,500));await route.continue();});await readBrowserView(ctx,page,{pending:()=>visibleText(page,/loading|busy|fetching/u)});assert.ok(delayed);await page.unroute("**/api/v1/**");await page.route("**/api/v1/**",route=>route.abort("internetdisconnected"));await readBrowserView(ctx,page,{failed:true});await visibleText(page,/offline|retry|network|failed to fetch|fetch failed/u);await page.unroute("**/api/v1/**");await readBrowserView(ctx,page,{reload:false});await visibleText(page,/shipment/u);await page.route("**/api/v1/**",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:{code:"UNAUTHORIZED",message:"Permission denied",details:{}}})}));await readBrowserView(ctx,page,{status:401});await visibleText(page,/permission|unauthorized|denied/u);await page.unroute("**/api/v1/**");await readBrowserView(ctx,page);const denied=await ctx.request(api.baseUrl,"/api/v1/verification-snapshot",{contractExpectation:"invalid"});assert.equal(denied.status,401);const before=stableBrowserSnapshot(await ctx.snapshot(api.baseUrl));await fillVisible(page,"tenant",fixture.tenant.tenantId);await fillVisible(page,"externalRef",fixture.shipment.externalRef);await fillVisible(page,"productLotCode",fixture.shipment.productLotCode);await fillVisible(page,"carrier",fixture.shipment.carrierId);await fillVisible(page,"device",fixture.shipment.deviceId);await fillVisible(page,"origin",fixture.shipment.originSiteId);await fillVisible(page,"destination",fixture.shipment.destinationSiteId);await fillVisible(page,"minimumTemperatureMilliC",fixture.shipment.minimumTemperatureMilliC);await fillVisible(page,"maximumTemperatureMilliC",fixture.shipment.maximumTemperatureMilliC);await clickVisible(page,/create.*shipment/u);await visibleText(page,/conflict|exists|stale/u);assert.equal(stableBrowserSnapshot(await ctx.snapshot(api.baseUrl)),before,"UI conflict has no duplicate mutation");const html=await page.content();for(const value of fixture.carrierDevices.map((item)=>item.secret))assert.equal(html.includes(value),false);return ctx.pass();
});
function stableBrowserSnapshot(snapshot){const copy=structuredClone(snapshot);delete copy.asOf;return canonicalJson(copy);}
async function keyboardFill(page,name,value){const labelled=page.getByLabel(new RegExp(name,"i")).first(),named=page.locator(`[name="${name}"]`).first(),control=await labelled.count()?labelled:named;assert.ok(await control.count(),`keyboard control ${name}`);await fillControl(control,value,{keyboard:page.keyboard});}
async function keyboardAction(page,name){const button=page.getByRole("button",{name}).first();assert.ok(await button.count(),`keyboard action ${name}`);await button.focus();await page.keyboard.press("Enter");}

const D06 = defineCase("D-06", async (ctx) => {
  const fixture=ctx.fixtures.browser(),{api,page,workerRecords}=await launchBrowser(ctx,fixture,{workers:1,dispatchers:0,viewport:{width:390,height:844}}),controls=page.locator("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]");const count=await controls.count();assert.ok(count>0,"production UI exposes keyboard-operable controls");await page.keyboard.press("Tab");for(let index=0;index<Math.min(count,20);index+=1){const focused=await page.evaluate(()=>document.activeElement?.tagName);assert.ok(["A","BUTTON","INPUT","SELECT","TEXTAREA"].includes(focused));await page.keyboard.press("Tab");}const unlabeled=await page.locator("input:not([type=hidden]),select,textarea").evaluateAll((elements)=>elements.filter((element)=>!(element.labels?.length||element.getAttribute("aria-label")||element.getAttribute("aria-labelledby")||(element.id&&document.querySelector(`label[for=\"${CSS.escape(element.id)}\"]`)))).length);assert.equal(unlabeled,0);await keyboardFill(page,"externalRef","");await keyboardAction(page,/create.*shipment/u);const focus=await page.evaluate(()=>({name:document.activeElement?.getAttribute("name"),invalid:document.activeElement?.getAttribute("aria-invalid")}));assert.ok(focus.invalid==="true"||focus.name==="externalRef");const device=fixture.carrierDevices[1].device;for(const[name,value]of[["tenant",fixture.tenant.tenantId],["externalRef","KEYBOARD-SHIPMENT"],["productLotCode","KEYBOARD-LOT"],["carrier",device.carrierId],["device",device.deviceId],["origin",fixture.sites[0].siteId],["destination",fixture.sites[2].siteId],["minimumTemperatureMilliC","2000"],["maximumTemperatureMilliC","8000"]])await keyboardFill(page,name,value);await keyboardAction(page,/create.*shipment/u);await visibleText(page,/DRAFT|draft/u);await keyboardAction(page,/activate/u);await visibleText(page,/ACTIVE|active/u);for(const reading of fixture.readings??[1,2,3].map((sequence)=>ctx.fixtures.reading(fixture,`keyboard-out:${sequence}`,{sequence,temperatureMilliC:9_000})))await ingest(ctx,api.baseUrl,fixture,reading,`keyboard-out-${reading.sequence}`);const opened=await waitSnapshot(ctx,api.baseUrl,(snapshot)=>snapshot.resources.excursions.find((item)=>item.shipmentId===fixture.shipment.shipmentId&&item.kind==="TEMPERATURE"&&item.state==="OPEN"),{processes:workerRecords}),excursion=opened.resources.excursions.find((item)=>item.shipmentId===fixture.shipment.shipmentId&&item.kind==="TEMPERATURE"&&item.state==="OPEN");await page.reload({waitUntil:"networkidle"});await keyboardFill(page,"excursion",excursion.excursionId);await keyboardAction(page,/acknowledge/u);await visibleText(page,/ACKNOWLEDGED|acknowledged/u);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);assert.ok(overflow<=1,"mobile has no horizontal overflow");return ctx.pass();
});

const D07 = guardedCase("D-07", ["PRODUCTION_BOOT","STALE_WORK_AUTHORITY"], async (ctx) => {
  const gates=["test:unit","test:integration","test:e2e","test:concurrency","test:recovery","test:perf","test:all"];for(const gate of gates){const result=await ctx.npm(gate,[],{timeoutMs:600_000});assert.equal(result.exitCode,0,gate);assert.ok(result.stdout.length+result.stderr.length>0,`${gate} output`);const broken=await ctx.npm(gate,[],{timeoutMs:60_000,allowFailure:true,env:{NODE_OPTIONS:"--require=/coldchaincontrol-evaluator/missing-required-module.cjs"}});assert.notEqual(broken.exitCode,0,`${gate} negative sensitivity`);}const fixture=ctx.fixtures.telemetry(),{apis}=await prepare(ctx,fixture,{apiCount:2});for(let sequence=1;sequence<=100;sequence+=1)await ingest(ctx,apis[sequence%2].baseUrl,fixture,fixture.reading(`gate-${sequence}`,{sequence}),`gate-${sequence}`);const worker=await ctx.startWorker();await waitForWork(ctx,apis[0].baseUrl,(item)=>item.kind==="TELEMETRY_PROJECT"&&item.state==="LEASED",{processes:[worker],intervalMs:5});await ctx.kill(worker);const replacement=await ctx.startWorker();await waitSnapshot(ctx,apis[0].baseUrl,(snapshot)=>snapshot.resources.shipmentProjections.some((item)=>item.shipmentId===fixture.shipment.shipmentId&&item.lastSequence===100),{processes:[replacement]});const chromium=await ctx.loadChromium(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??"/usr/bin/chromium",headless:true});ctx.defer(()=>browser.close());const page=await browser.newPage();await page.goto(apis[0].baseUrl,{waitUntil:"networkidle"});assert.ok((await page.locator("body").innerText()).trim().length>0);return ctx.pass();
});

const D08 = defineCase("D-08", async (ctx) => {
  const receiver=await ctx.receiver({path:"/events"}),fixture=ctx.fixtures.notification(receiver.url),{api,page,workerRecords,dispatcherRecords}=await launchBrowser(ctx,fixture,{workers:2,dispatchers:2,receiver}),openapi=successful(await ctx.request(api.baseUrl,"/openapi.json"),"OpenAPI",[200]).json;assertOpenApiContract(openapi);for(const reading of fixture.readings.slice(0,3))await ingest(ctx,api.baseUrl,fixture,reading,`closure-${reading.sequence}`);const snapshot=await waitSnapshot(ctx,api.baseUrl,(value)=>{const work=value.work.filter((item)=>item.aggregateId===fixture.shipment.shipmentId),events=value.events.filter((item)=>item.aggregateId===fixture.shipment.shipmentId);return value.resources.excursions.some((item)=>item.shipmentId===fixture.shipment.shipmentId)&&work.length>0&&events.length>0&&receiver.ledger.length>0;},{processes:[...workerRecords,...dispatcherRecords]});await page.reload({waitUntil:"networkidle"});await visibleText(page,/excursion|OPEN|temperature/u);assert.ok(openapi.paths["/api/v1/telemetry-readings"]);assert.ok(snapshot.resources.auditEntries.some((item)=>item.resourceId===fixture.shipment.shipmentId||item.resourceId===fixture.device.deviceId));assert.ok(snapshot.work.some((item)=>item.aggregateId===fixture.shipment.shipmentId));assert.ok(snapshot.events.some((item)=>item.aggregateId===fixture.shipment.shipmentId));assertSnapshotShape(snapshot,{secrets:fixture.carrierDevices.map((item)=>item.secret)});ctx.mark("readme.cross-layer.closed",{HTTP:true,OpenAPI:true,UI:true,snapshot:true,Work:true,Event:true,receiver:true});return ctx.pass();
});

export const D_CASES=[D01,D02,D03,D04,D05,D06,D07,D08];
