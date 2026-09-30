import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { fillVisible, visibleText } from '../evaluators/transfer/incidentrelay/v2/cases/helpers.mjs';
import { performWatermarkUi, accessibleName, expectVisible } from '../evaluators/transfer/metersettle/v2/cases/ui.mjs';
import { fillVisible as fillCold } from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';

function functions(task, names) {
  const source = ts.createSourceFile('d.mjs', readFileSync(new URL(`../evaluators/transfer/${task}/v2/cases/d.mjs`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const body = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source)).join('\n');
  return runInNewContext(body + `;({${names.join(',')}})`, { assert });
}
test('actual Transfer UI helpers accept supported HTML and still reject missing behavior', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); page.setDefaultTimeout(500);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await t.test('Incident spaced/implicit labels, real select and missing-option negative control', async () => {
    await page.setContent('<label>Service ID<input></label><label>Severity<select><option>HIGH</option></select></label>');
    await fillVisible(page, 'serviceId', 'service'); await fillVisible(page, 'severity', 'HIGH');
    assert.equal(await page.locator('input').inputValue(), 'service');
    await assert.rejects(fillVisible(page, 'severity', 'UNKNOWN'));
    await assert.rejects(fillVisible(page, 'missingId', 'missing'));
    await page.setContent('<div id="status"></div>');
    await page.evaluate(() => setTimeout(() => document.querySelector('#status').textContent = 'Loading incidents...', 25));
    await visibleText(page, /loading|busy|fetching/iu);
    await assert.rejects(visibleText(page, /definitely absent/));
  });
  await t.test('Parcel actual line groups and button navigation, with missing-navigation rejection', async () => {
    const ui = functions('parcelflow', ['firstVisible', 'orderLineGroups', 'addOrderLines', 'openOrderFromHistory']);
    await page.setContent('<form><div><label>SKU<select><option>A</option></select></label><label>Quantity<input type="number"></label></div><button type="button" onclick="this.before(this.previousElementSibling.cloneNode(true))">Add line</button></form><button onclick="this.textContent=\'opened\'">ref-test</button>');
    assert.equal(await ui.orderLineGroups(page).count(), 1);
    await ui.addOrderLines(page, 3); assert.equal(await ui.orderLineGroups(page).count(), 3);
    await ui.openOrderFromHistory(page, 'ref-test');
    assert.equal(await page.getByRole('button', { name: 'opened' }).count(), 1);
    await assert.rejects(ui.openOrderFromHistory(page, 'absent'));
  });
  await t.test('Meter scoped Watermark uses datetime-local and waits for its real UI request', async () => {
    await page.setContent('<section aria-label="Usage"><button onclick="fetch(\'/api/v1/usage-batches\',{method:\'POST\'})">Submit</button></section><section aria-label="Watermark"><label>Tenant<input></label><label>Through<input type="datetime-local"></label><button onclick="fetch(\'/api/v1/tenants/t/watermark\',{method:\'POST\'})">Advance</button></section>');
    requests.length = 0;
    await performWatermarkUi(page, 't', '2035-03-01T00:00:00.123Z');
    assert.deepEqual(requests, ['/api/v1/tenants/t/watermark']);
    assert.equal(await page.locator('[type="datetime-local"]').inputValue(), '2035-03-01T00:00:00.123');
  });
  await t.test('Meter semantic names and empty-state text do not accept unnamed controls', async () => {
    await page.setContent('<button>Submit Usage</button><button></button><input aria-labelledby="label"><span id="label">Quantity</span><p>No events.</p>');
    assert.equal(await page.locator('button').nth(0).evaluate(accessibleName), 'Submit Usage');
    assert.equal(await page.locator('button').nth(1).evaluate(accessibleName), '');
    assert.equal(await page.locator('input').evaluate(accessibleName), 'Quantity');
    await expectVisible(page, /empty|no\b[^\n]*(?:yet|available|selected|recorded|events?|statements?)|nothing/i);
    await assert.rejects(expectVisible(page, /unavailable text/));
  });
  await t.test('Cold select is operated as a select, not a text field', async () => {
    await page.setContent('<label>Tenant<select><option value="t">Tenant t</option></select></label>');
    await fillCold(page, 'Tenant', 't');
    assert.equal(await page.locator('select').inputValue(), 't');
    await assert.rejects(fillCold(page, 'Tenant', 'absent'));
  });
  await t.test('Flag non-keyboard select preserves the existing option value', async () => {
    const { enter } = functions('flagfoundry', ['enter']);
    await page.setContent('<select><option value="boolean">Boolean</option></select>');
    const select = page.locator('select');
    await enter(page, select, 'boolean');
    assert.equal(await select.inputValue(), 'boolean');
    await assert.rejects(enter(page, select, 'absent'));
  });
});
