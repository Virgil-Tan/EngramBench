import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as helpers from '../src/task-evaluator-v2/browser.mjs';
import { performUsageUi } from '../evaluators/transfer/metersettle/v2/cases/ui.mjs';

test('real CapacityLease driver accepts public UI control variants', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(150);
  const source = ts.createSourceFile('d.mjs', readFileSync(new URL('../evaluators/transfer/capacitylease/v2/cases/d.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['setControl', 'firstVisible', 'control', 'openLeaseForm', 'localTimestamp', 'fillBaseLeaseForm', 'fillLegacyLeaseForm'];
  const code = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source)).join('\n');
  const driver = runInNewContext(code + ';({setControl,fillLegacyLeaseForm,localTimestamp})', { assert, ...helpers });
  await t.test('boolean select is not assumed to be a checkbox', async () => {
    await page.setContent(`<form><label>Owner<input></label><label>Start<input type=datetime-local></label><label>End<input type=datetime-local></label><label>Pool<input></label><label>Units<input type=number></label><label>Allow wait<select><option value=false>No</option><option value=true>Yes</option></select></label></form>`);
    await driver.fillLegacyLeaseForm(page, { ids: { ownerId: 'owner', poolIds: ['pool'] }, startAt: '2035-01-01T10:00:00.000Z', endAt: '2035-01-01T11:00:00.000Z' }, { allowWait: true });
    assert.equal(await page.getByLabel('Allow wait').inputValue(), 'true');
  });
  await t.test('checkbox receives requested boolean and can be cleared', async () => {
    await page.setContent('<label>Allow wait<input type=checkbox></label>');
    await driver.setControl(page.getByLabel('Allow wait'), true);
    assert.equal(await page.getByLabel('Allow wait').isChecked(), true);
    await driver.setControl(page.getByLabel('Allow wait'), false);
    assert.equal(await page.getByLabel('Allow wait').isChecked(), false);
  });
  await t.test('empty select does not fall back to illegal fill or get silently skipped', async () => {
    await page.setContent('<label>Owner<select></select></label>');
    await assert.rejects(driver.setControl(page.getByLabel('Owner'), 'owner'), e => e.code === 'EVALUATOR_UI_OPTION_UNRESOLVED');
  });
  await t.test('datetime input keeps the requested instant, including seconds', () => {
    assert.equal(driver.localTimestamp('2035-01-01T10:22:33.123Z'), '2035-01-01T10:22:33.123');
  });
});

test('MeterSettle UI can use an events-array editor or combined business panel', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(500);
  await page.route('http://fixture/**', r => r.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
  await page.goto('http://fixture/');
  const family = { tenant: { tenantId: 'tenant' }, meters: [{ meterId: 'meter' }], events: [{ eventId: 'e', meterId: 'meter', occurredAt: '2035-01-01T00:00:00.000Z', quantity: 1 }] };
  await t.test('array editor receives events, not an entire request envelope', async () => {
    await page.setContent(`<section><h2>Usage</h2><label>Tenant<input id=tenant></label><label>Events JSON<textarea id=events></textarea></label><button onclick="fetch('/api/v1/usage-batches',{method:'POST',body:JSON.stringify({tenantId:document.getElementById('tenant').value,events:JSON.parse(document.getElementById('events').value)})})">Submit</button></section>`);
    const body = await performUsageUi(page, family);
    assert.equal(body.tenantId, 'tenant'); assert.equal(body.events.length, 1);
  });
  await t.test('usage action cannot collide with Create Correction in a shared panel', async () => {
    await page.setContent(`<section><h2>Usage and corrections</h2><label>Tenant<input id=tenant></label><label>Meter<input id=meter></label><label>Usage event ID<input id=event></label><label>Usage occurred at<input id=time></label><label>Usage quantity<input id=quantity></label><label>Correction quantity delta<input id=delta></label><button onclick="fetch('/api/v1/usage-batches',{method:'POST',body:JSON.stringify({tenantId:document.getElementById('tenant').value,events:[{eventId:document.getElementById('event').value,meterId:document.getElementById('meter').value,quantity:Number(document.getElementById('quantity').value),occurredAt:document.getElementById('time').value}]})})">Ingest Usage</button><button>Create Correction</button></section>`);
    const body = await performUsageUi(page, family);
    assert.equal(body.events[0].quantity, 1); assert.equal(await page.getByLabel('Correction quantity delta').inputValue(), '');
  });
});

test('shared action scope prefers the actual inner form over an encompassing section', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(150);
  await page.setContent(`<section><h2>Usage</h2><form><label>Quantity<input></label><button>Submit</button></form><form><h3>Correction</h3><label>Quantity delta<input></label><button>Correct</button></form></section>`);
  const scoped = await helpers.scopeUiAction(page, /usage/i, /submit|ingest|create|add|accept/i);
  assert.equal(await scoped.getByLabel(/quantity/i).count(), 1, 'a sibling form must not pollute field matching');
});
