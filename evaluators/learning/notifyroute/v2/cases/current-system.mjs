import { nextWindow } from "../oracles/index.mjs";
import { assertInvariants, clickControl, coreNotification, createNotification, exactKeys, finalEvidence, launchBrowser, prepare, providerReceiver, resource, scriptedSeed, waitDelivery, waitSnapshot } from "./helpers.mjs";

export async function campaignSetup(ctx) {
  const receiver = await providerReceiver(ctx, () => ({ status: 204 }));
  const { seed } = scriptedSeed(ctx, receiver, { tenantLimit: 100, recipientLimit: 100 });
  seed.recipients = seed.recipients.slice(0, 4);
  const endpoint = seed.channelEndpoints.find(item => item.channel === "WEBHOOK");
  seed.channelEndpoints = seed.recipients.map((recipient, index) => ({ ...endpoint, endpointId: ctx.uuid(`campaign-endpoint-${index}`), recipientId: recipient.recipientId }));
  const target = await prepare(ctx, { seed });
  const apis = [await target.startApi(), await target.startApi()];
  return { seed, target, apis, api: apis[0], receiver };
}

export async function createCampaign(ctx, setup, label = "campaign") {
  const body = { tenantId: setup.seed.tenants[0].tenantId, name: ctx.key(label), templateVersionId: setup.seed.templateVersions[0].templateVersionId,
    routePolicyId: setup.seed.routePolicies[0].routePolicyId, category: "OPERATIONS", data: {},
    recipientIds: [...setup.seed.recipients.slice(0, 3).map(item => item.recipientId), setup.seed.recipients[0].recipientId] };
  const key = ctx.key(`${label}-create`);
  const response = await ctx.mutate(setup.api.baseUrl, "/api/v1/campaigns", key, body);
  ctx.equal(response.status, 200, "public Campaign create");
  const detail = assertCampaignDetail(ctx, response.json, setup.seed, body);
  ctx.equal(detail.campaign.state, "QUEUED", "new campaign queues durable fan-out before a worker runs");
  return { ...detail, body, key };
}

export function assertCampaignDetail(ctx, detail, seed, body) {
  exactKeys(detail, ["campaign", "campaignRecipients"], "CampaignDetail");
  const { campaign, campaignRecipients } = detail;
  ctx.equal(campaign.recipientCount, new Set(body.recipientIds).size, "Campaign recipientCount deduplicates audience");
  ctx.equal(campaignRecipients.length, campaign.recipientCount, "every frozen audience member is observable");
  ctx.equal([...campaignRecipients.map(item => item.recipientId)].sort(), [...new Set(body.recipientIds)].sort(), "audience is exact, with neither duplicate nor missing member");
  ctx.equal(campaign.templateVersionId, body.templateVersionId, "Campaign freezes TemplateVersion");
  ctx.equal(campaign.routePolicyId, body.routePolicyId, "Campaign freezes RoutePolicy identity");
  ctx.equal(campaign.routePolicyRevision, seed.routePolicies[0].revision, "Campaign freezes RoutePolicy revision");
  ctx.equal(campaign.data, body.data, "Campaign freezes canonical data");
  for (const member of campaignRecipients) {
    exactKeys(member, ["campaignId", "recipientId", "suppressionRevision", "notificationId"], "CampaignRecipient");
    ctx.equal(member.campaignId, campaign.campaignId, "member belongs to Campaign");
    ctx.equal(member.suppressionRevision, seed.recipients.find(item => item.recipientId === member.recipientId).preferenceRevision, "Campaign freezes recipient preference revision");
  }
  return detail;
}

async function readCampaign(ctx, setup, created) {
  const response = await ctx.request(setup.api.baseUrl, `/api/v1/campaigns/${created.campaign.campaignId}`);
  ctx.equal(response.status, 200, "Campaign read");
  return assertCampaignDetail(ctx, response.json, setup.seed, created.body);
}

async function controlCampaign(ctx, setup, created, action, baseUrl = setup.api.baseUrl) {
  const key = ctx.key(`campaign-${action}`);
  const path = `/api/v1/campaigns/${created.campaign.campaignId}/${action}`;
  const response = await ctx.mutate(baseUrl, path, key, {});
  ctx.equal(response.status, 200, `Campaign ${action}`);
  ctx.equal((await ctx.mutate(setup.apis[1].baseUrl, path, key, {})).json, response.json, `${action} durable replay`);
  ctx.equal(response.json.campaignId, created.campaign.campaignId, "control retains Campaign identity");
  return response.json;
}

async function workerProgressProbe(ctx, setup, label, processes) {
  const created = await createNotification(ctx, setup.api.baseUrl, coreNotification(ctx, setup.seed, { recipientId: setup.seed.recipients[3].recipientId, dedupeKey: ctx.key(label) }));
  await waitDelivery(ctx, setup.api.baseUrl, created.notification.notificationId, ["ACCEPTED", "DELIVERED"], { processes, timeoutMs: 60_000 });
  return created.notification;
}

export async function campaignFreezeScenario(ctx) {
  const setup = await campaignSetup(ctx);
  const created = await createCampaign(ctx, setup);
  const replay = await ctx.mutate(setup.apis[1].baseUrl, "/api/v1/campaigns", created.key, created.body);
  ctx.equal(replay.json, { campaign: created.campaign, campaignRecipients: created.campaignRecipients }, "Campaign creation exact replay");
  const before = await ctx.snapshot(setup.api.baseUrl);
  const conflict = await ctx.mutate(setup.apis[1].baseUrl, "/api/v1/campaigns", created.key, { ...created.body, name: "changed" });
  ctx.ok(conflict.status >= 400 && conflict.status < 500, "changed replay rejects");
  const template = await ctx.mutate(setup.api.baseUrl, "/api/v1/template-versions", ctx.key("campaign-later-template"), { templateId: setup.seed.templates[0].templateId, version: 3, channel: "WEBHOOK", subject: "Later", body: "Later" });
  ctx.equal(template.status, 200, "publish later content");
  ctx.equal(await readCampaign(ctx, setup, created), { campaign: created.campaign, campaignRecipients: created.campaignRecipients }, "later content does not rewrite Campaign inputs");
  const after = await ctx.snapshot(setup.api.baseUrl);
  ctx.equal(resource(after, "campaigns"), resource(before, "campaigns"), "rejected replay and later content preserve Campaign state");
  ctx.equal(resource(after, "campaignRecipients"), resource(before, "campaignRecipients"), "frozen member ledger is immutable");
  assertInvariants(ctx, after);
  return finalEvidence(ctx, { campaignId: created.campaign.campaignId, deduplicatedRecipients: 3 });
}

export async function campaignControlScenario(ctx, { recover = false, cancel = false } = {}) {
  const setup = await campaignSetup(ctx);
  const created = await createCampaign(ctx, setup);
  const paused = await controlCampaign(ctx, setup, created, "pause");
  ctx.equal(paused.state, "PAUSED", "pause becomes durable");
  if (cancel) ctx.equal((await controlCampaign(ctx, setup, created, "cancel")).state, "CANCELLED", "cancel becomes durable");
  if (recover) {
    await ctx.kill(setup.api);
    setup.api = await setup.target.startApi();
    ctx.equal((await readCampaign(ctx, setup, created)).campaign.state, cancel ? "CANCELLED" : "PAUSED", "control fence survives process replacement");
  }
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  await workerProgressProbe(ctx, setup, "control-worker-progress", workers);
  let detail = await readCampaign(ctx, setup, created);
  ctx.ok(detail.campaignRecipients.every(item => item.notificationId === null), "paused or cancelled Campaign creates no member Notification while workers make progress");
  ctx.equal(setup.receiver.ledger.length, 1, "only independent progress probe sends before resume");
  if (!cancel) {
    const resumed = await controlCampaign(ctx, setup, created, "resume");
    ctx.ok(["QUEUED", "RUNNING", "COMPLETED"].includes(resumed.state), "resume reopens unfinished fan-out");
    await waitSnapshot(ctx, setup.api.baseUrl, snapshot => resource(snapshot, "campaignRecipients").filter(item => item.campaignId === created.campaign.campaignId && item.notificationId !== null).length === 3, { processes: workers, timeoutMs: 60_000 });
    detail = await readCampaign(ctx, setup, created);
    const snapshot = await ctx.snapshot(setup.api.baseUrl);
    assertCampaignFanout(ctx, snapshot, detail);
    assertInvariants(ctx, snapshot);
  } else {
    ctx.equal(detail.campaign.state, "CANCELLED", "workers cannot resurrect cancelled Campaign");
    assertInvariants(ctx, await ctx.snapshot(setup.api.baseUrl));
  }
  return finalEvidence(ctx, { campaignId: created.campaign.campaignId, workers: 2, recover, cancel });
}

export function assertCampaignFanout(ctx, snapshot, detail) {
  const ids = detail.campaignRecipients.map(item => item.notificationId);
  ctx.ok(ids.every(Boolean), "every audience member is durably linked to a Notification");
  ctx.equal(new Set(ids).size, ids.length, "Campaign members never share or duplicate logical Notifications");
  for (const member of detail.campaignRecipients) {
    const notifications = resource(snapshot, "notifications").filter(item => item.notificationId === member.notificationId);
    ctx.equal(notifications.length, 1, "member link identifies exactly one real Notification");
    const notification = notifications[0];
    ctx.equal(notification.recipientId, member.recipientId, "fan-out targets frozen recipient");
    ctx.equal(notification.templateVersionId, detail.campaign.templateVersionId, "fan-out uses frozen template");
    ctx.equal(notification.routePolicyRevision, detail.campaign.routePolicyRevision, "fan-out uses frozen route revision");
  }
}

export async function campaignRecoveryScenario(ctx) {
  const setup = await campaignSetup(ctx);
  const created = await createCampaign(ctx, setup);
  const before = await ctx.snapshot(setup.api.baseUrl);
  ctx.ok(before.work.some(item => item.kind === "CAMPAIGN_FANOUT" && item.aggregateId === created.campaign.campaignId && !item.terminal), "Campaign enqueues durable fan-out");
  await ctx.kill(setup.api);
  setup.api = await setup.target.startApi();
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  await waitSnapshot(ctx, setup.api.baseUrl, snapshot => resource(snapshot, "campaignRecipients").filter(item => item.campaignId === created.campaign.campaignId && item.notificationId !== null).length === 3, { processes: workers, timeoutMs: 60_000 });
  for (const worker of workers) await ctx.stop(worker);
  const snapshot = await ctx.snapshot(setup.api.baseUrl);
  const detail = await readCampaign(ctx, setup, created);
  assertCampaignFanout(ctx, snapshot, detail);
  const replacement = await ctx.startWorker();
  await workerProgressProbe(ctx, setup, "recovered-fanout-progress", [replacement]);
  const after = await ctx.snapshot(setup.api.baseUrl);
  ctx.equal(resource(after, "campaignRecipients"), resource(snapshot, "campaignRecipients"), "worker replacement never fans out members again");
  assertInvariants(ctx, after);
  return finalEvidence(ctx, { campaignId: created.campaign.campaignId, recoveredMembers: 3 });
}

export async function campaignBrowserScenario(ctx) {
  const setup = await campaignSetup(ctx);
  const created = await createCampaign(ctx, setup);
  const { page } = await launchBrowser(ctx, setup.api.baseUrl);
  await clickControl(page, [/campaigns/i, /campaign/i]);
  const name = page.getByText(created.campaign.name, { exact: false }).first();
  ctx.ok(await name.isVisible(), "production Campaign view exposes HTTP-created campaign");
  await name.click();
  for (const [action, expected] of [["pause", "PAUSED"], ["resume", "QUEUED"], ["cancel", "CANCELLED"]]) {
    await clickControl(page, [new RegExp(action, "i")]);
    if (action === "cancel") {
      const confirm = page.getByRole("button", { name: /confirm.*cancel|yes.*cancel/i }).first();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    }
    await ctx.waitFor(async () => {
      const detail = await readCampaign(ctx, setup, created);
      return action === "resume" ? ["QUEUED", "RUNNING"].includes(detail.campaign.state) : detail.campaign.state === expected;
    }, { timeoutMs: 30_000, label: `browser ${action} persisted` });
    await page.reload({ waitUntil: "domcontentloaded" });
    ctx.ok(await page.getByText(created.campaign.name, { exact: false }).first().isVisible(), "Campaign identity survives UI refresh");
  }
  assertInvariants(ctx, await ctx.snapshot(setup.api.baseUrl));
  return finalEvidence(ctx, { campaignId: created.campaign.campaignId, browserMutations: 3 });
}

export async function ingestScenario(ctx, { quota = false, restart = false } = {}) {
  const observedWindows = [];
  const receiver = await providerReceiver(ctx, () => { observedWindows.push(Math.floor(Date.now() / 60_000)); return { status: 204 }; });
  const { seed } = scriptedSeed(ctx, receiver, { tenantLimit: quota ? 2 : 100, recipientLimit: quota ? 1 : 100 });
  const target = await prepare(ctx, { seed });
  const apis = [await target.startApi(), await target.startApi()];
  const requests = Array.from({ length: quota ? 4 : 12 }, (_, index) => coreNotification(ctx, seed, { dedupeKey: ctx.key(`bounded-${index}`) }));
  const results = await Promise.all(requests.flatMap((body, index) => [0, 1].map(() => createNotification(ctx, apis[index % 2].baseUrl, body, { key: ctx.key(`ingest-${index}`) }))));
  ctx.equal(new Set(results.map(item => item.notification.notificationId)).size, requests.length, "concurrent replay conserves logical notifications");
  if (restart) {
    const before = await ctx.snapshot(apis[0].baseUrl);
    await ctx.kill(apis[0]);
    apis[0] = await target.startApi();
    const after = await ctx.snapshot(apis[0].baseUrl);
    ctx.equal(resource(after, "notifications"), resource(before, "notifications"), "accepted identities survive API replacement");
    ctx.equal(after.work, before.work, "queued work survives API replacement");
  }
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const snapshot = await waitSnapshot(ctx, apis[0].baseUrl, value => quota
    ? resource(value, "deliveries").some(item => item.state === "RATE_LIMITED") && receiver.ledger.length > 0
    : requests.every(body => resource(value, "notifications").some(item => item.dedupeKey === body.dedupeKey && item.terminalAt !== null)), { processes: workers, timeoutMs: 60_000 });
  for (const worker of workers) await ctx.stop(worker);
  if (quota) {
    for (const window of new Set(observedWindows)) ctx.ok(observedWindows.filter(value => value === window).length <= 1, "recipient quota is never overspent in an epoch window");
    for (const delivery of resource(snapshot, "deliveries").filter(item => item.state === "RATE_LIMITED")) ctx.equal(delivery.nextAttemptAt, nextWindow(new Date(Date.parse(delivery.nextAttemptAt) - 1).toISOString(), 60), "rate-limited Work records exact next boundary");
  } else ctx.equal(receiver.ledger.length, requests.length, "one successful external call per logical Notification");
  assertInvariants(ctx, snapshot);
  return finalEvidence(ctx, { logicalNotifications: requests.length, requests: results.length, workers: 2, quota, restart, performanceClaim: false });
}
