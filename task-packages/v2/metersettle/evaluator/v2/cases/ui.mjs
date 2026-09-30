// Evaluator-only UI wiring. No candidate-specific IDs, routes, or implementation shortcuts.
import { usageBody, correctionBody } from './helpers.mjs';
import { candidateAssert as assert } from '../lib/execution.mjs';
const { localDateTimeValue, uniqueUiTarget, scopeUiAction, navigateReadView, captureBrowserAction, assertUiEvidence } = await import(new URL('browser.mjs', process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL('../../../../../src/task-evaluator-v2/', import.meta.url)));
const editable = 'input:visible,textarea:visible,select:visible,[contenteditable="true"]:visible';
async function unique(locator, label) {
  return uniqueUiTarget(locator, label);
}
async function scope(page, pattern, action) {
  return scopeUiAction(page, pattern, action);
}
async function enter(page, target, value, options) {
  const tag = await target.evaluate(e => e.tagName.toLowerCase());
  // HTML datetime-local does not accept a timezone suffix. Keep seconds and
  // fractional precision; do not truncate the business instant to minutes.
  if (await target.getAttribute('type') === 'datetime-local') value = localDateTimeValue(value);
  if (!options.keyboard) {
    if (tag === 'select') await target.selectOption(String(value));
    else await target.fill(String(value));
    return;
  }
  await target.focus();
  if (tag === 'select') {
    const values = await target.locator('option').evaluateAll(xs => xs.map(x => x.value));
    const index = values.indexOf(String(value));
    if (index < 0) throw new Error(`select missing ${value}`);
    await page.keyboard.press('Home');
    for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  } else {
    await page.keyboard.press('Control+A');
    await page.keyboard.type(String(value));
  }
}
async function fill(page, root, pattern, value, options, optional = false) {
  let target = root.getByLabel(pattern).and(page.locator(editable));
  if (!await target.count() && /tenant|meter/.test(pattern.source)) {
    // Shared context is a visible, explicitly named Scope/Context group, not a
    // similarly named field from some other business form.
    const context = page.locator('section:visible,fieldset:visible')
      .filter({ has: page.getByRole('heading', { name: /^(scope|context)$/i }) });
    target = context.getByLabel(pattern).and(page.locator(editable));
    if (!await target.count()) {
      const shared = page.getByLabel(pattern).and(page.locator(editable));
      if (await shared.count() === 1 && !await shared.locator('xpath=ancestor::form').count()) target = shared;
    }
  }
  if (optional && !await target.count()) return;
  await enter(page, await unique(target, String(pattern)), value, options);
}
async function submit(page, root, pattern, route, options) {
  const target = await unique(root.getByRole('button', { name: pattern }).and(page.locator(':visible')), `submit ${route}`);
  const click = async () => {
    if (options.keyboard) { await target.focus(); await page.keyboard.press('Enter'); }
    else await target.click();
  };
  if (options.invalidQuantity) return click();
  return captureBrowserAction(page, req => req.method() === 'POST' && new URL(req.url()).pathname === route, click);
}
async function jsonOrFields(page, root, pattern, body, fields, options, arrayField) {
  const json = root.getByLabel(pattern).and(page.locator(editable));
  if (await json.count()) {
    const target = await unique(json, 'JSON editor');
    const name = await target.evaluate(accessibleName);
    const arrayEditor = arrayField && new RegExp(`^${arrayField}\\s+json$`, 'i').test(name);
    if (arrayEditor) await fill(page, root, /tenant/i, body.tenantId, options, true);
    await enter(page, target, JSON.stringify(arrayEditor ? body[arrayField] : body), options);
  }
  else for (const [label, value] of fields) await fill(page, root, label, value, options, true);
}
export async function performUsageUi(page, family, options = {}) {
  await navigateReadView(page, /^usage$/i, options);
  const specificAction = /(?:submit|ingest|create|add|accept).*usage|usage.*(?:submit|ingest|create|add|accept)/i;
  const action = await page.getByRole('button', { name: specificAction }).and(page.locator(':visible')).count() === 1
    ? specificAction : /submit|ingest|create|add|accept/i;
  const root = await scope(page, /usage|ingest/i, action);
  const quantity = await root.getByLabel(/usage.*quantity/i).and(page.locator(editable)).count() === 1 ? /usage.*quantity/i : /quantity/i;
  const body = usageBody(family.tenant.tenantId, [{ ...family.events[0], eventId: options.eventId ?? `ui-${family.events[0].eventId}`, quantity: options.invalidQuantity ? -1 : 1 }]);
  await jsonOrFields(page, root, /usage.*batch|batch.*json|events.*json|request.*body/i, body, [
    [/tenant/i, body.tenantId], [/meter/i, body.events[0].meterId],
    [/event.*id|identifier/i, body.events[0].eventId, true], [/occurred|timestamp|time/i, family.events[0].occurredAt], [quantity, body.events[0].quantity],
  ], options, 'events');
  const observed = await submit(page, root, action, '/api/v1/usage-batches', options);
  if (options.invalidQuantity) return body;
  const actual = requestBody(observed);
  assert.equal(actual.tenantId, body.tenantId, 'UI preserved chosen tenant');
  assert.equal(actual.events?.length, 1, 'UI emitted one requested usage event');
  const event = actual.events[0];
  assert.equal(typeof event.eventId, 'string', 'UI supplied an event identity');
  assert.equal(event.meterId, body.events[0].meterId, 'UI preserved chosen meter');
  assert.equal(event.quantity, body.events[0].quantity, 'UI preserved chosen quantity');
  assert.equal(Date.parse(event.occurredAt), Date.parse(body.events[0].occurredAt), 'UI preserved chosen instant');
  return actual;
}
export async function performWatermarkUi(page, tenantId, through, options = {}) {
  await navigateReadView(page, /^watermark$/i, options);
  const root = await scope(page, /watermark/i, /advance|submit|finaliz/i);
  await jsonOrFields(page, root, /watermark.*json|request.*body/i, { tenantId, through }, [[/tenant/i, tenantId], [/through|cutoff|watermark/i, through]], options);
  await submit(page, root, /advance|submit|finaliz/i, `/api/v1/tenants/${tenantId}/watermark`, options);
}
export async function performCorrectionUi(page, tenantId, correction, options = {}) {
  await navigateReadView(page, /^corrections?$/i, options);
  const root = await scope(page, /correction/i, /submit|correct|create/i);
  const delta = await root.getByLabel(/delta/i).and(page.locator(editable)).count() === 1 ? /delta/i : /delta|quantity/i;
  await jsonOrFields(page, root, /correction.*batch|batch.*json|corrections.*json|request.*body/i, correctionBody(tenantId, [correction]), [
    [/tenant/i, tenantId], [/correction.*id|identifier/i, correction.correctionId, true], [/source.*event/i, correction.sourceEventId],
    [delta, correction.quantityDelta], [/reason/i, correction.reason], [/occurred|timestamp|time/i, correction.occurredAt, true],
  ], options, 'corrections');
  const actual = requestBody(await submit(page, root, /submit|correct|create/i, '/api/v1/correction-batches', options));
  assert.equal(actual.tenantId, tenantId, 'UI preserved chosen tenant');
  assert.equal(actual.corrections?.length, 1, 'UI emitted one requested correction');
  const item = actual.corrections[0];
  for (const key of ['sourceEventId', 'quantityDelta', 'reason']) assert.equal(item[key], correction[key], `UI preserved ${key}`);
  assert.equal(typeof item.correctionId, 'string', 'UI supplied a correction identity');
  assert.ok(Number.isFinite(Date.parse(item.occurredAt)), 'UI supplied a valid correction instant');
  return item;
}
function requestBody(observed) {
  let body;
  try { body = observed.request.postDataJSON(); } catch { assert.fail('UI request body is not JSON'); }
  assert.ok(body && typeof body === 'object', 'UI request has a JSON object');
  return body;
}
export async function navigateVisible(page, pattern, options = {}) {
  return navigateReadView(page, pattern, options);
}
async function clickTarget(page, target, options) {
  if (options.keyboard) { await target.focus(); await page.keyboard.press('Enter'); }
  else await target.click();
}
export async function clickVisible(page, pattern, options = {}) {
  await clickTarget(page, await unique(page.getByRole('button', { name: pattern }).and(page.locator(':visible')), String(pattern)), options);
}
export async function expectVisible(page, pattern) {
  const target = page.getByText(pattern).or(page.locator("[role='status'],[role='alert']").filter({ hasText: pattern })).and(page.locator(':visible')).first();
  await assertUiEvidence(target, String(pattern));
}
export function accessibleName(element) {
  const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  return element.getAttribute('aria-label')?.trim() || labelled || [...(element.labels ?? [])].map(l => l.textContent).join(' ').trim()
    || (element.matches('button,a[href],input[type="button"],input[type="submit"]') ? (element.textContent?.trim() || element.value) : '')
    || element.getAttribute('title')?.trim() || element.getAttribute('placeholder')?.trim() || '';
}
