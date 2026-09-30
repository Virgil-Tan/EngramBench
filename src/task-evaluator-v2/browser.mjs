import { candidateAssert } from './execution.mjs';

// Attach a rejection observer before a UI action can throw or a second wait can
// fail. Return the original promise: callers still receive the real response or
// error when they await it. Browser teardown cancels abandoned Playwright waits.
export function observeBrowserWait(promise) {
  void promise.catch(() => {});
  return promise;
}

// Canonical datetime-local syntax without discarding nonzero seconds/fractions.
export function localDateTimeValue(value) {
  return String(value).replace(/Z$/iu, '').replace(/(\.\d*?[1-9])0+$/u, '$1')
    .replace(/\.0+$/u, '').replace(/(T\d{2}:\d{2}):00$/u, '$1');
}

export function uiAutomationError(code, message, details = {}, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: `EVALUATOR_UI_${code}`, origin: 'evaluator', details,
  });
}

// Operate on the actual HTML control, not a guessed widget type. A missing
// option is unresolved automation, never a reason to fill a select as text.
export async function setUiControl(target, value) {
  const tag = await target.evaluate(element => element.tagName.toLowerCase());
  const type = await target.getAttribute('type');
  if (tag === 'select') {
    try { await target.selectOption({ value: String(value) }); }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      try { await target.selectOption({ label: String(value) }); }
      catch (cause) {
        if (cause.name !== 'TimeoutError') throw cause;
        throw uiAutomationError('OPTION_UNRESOLVED', 'Requested option is not available in the visible select', {}, cause);
      }
    }
  } else if (type === 'checkbox' && typeof value === 'boolean') await target.setChecked(value);
  else if (type === 'radio' && typeof value === 'boolean' && value) await target.check();
  else if (type === 'checkbox' || type === 'radio') throw uiAutomationError('CONTROL_TYPE_UNRESOLVED', 'Text value cannot be entered into a boolean control');
  else await target.fill(type === 'datetime-local' ? localDateTimeValue(value) : String(value));
}

// Automation uncertainty is not proof of a missing business feature.
export async function uniqueUiTarget(locator, label) {
  try { await locator.first().waitFor({ state: 'visible' }); }
  catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    throw uiAutomationError('TARGET_UNRESOLVED', `Cannot locate ${label}`, { target: label }, error);
  }
  const count = await locator.count();
  if (count !== 1) throw uiAutomationError('TARGET_AMBIGUOUS', `Ambiguous ${label}`, { target: label, count });
  return locator;
}

// Inline views need no navigation. Never substitute a mutation button.
export async function navigateReadView(page, pattern, options = {}) {
  const visible = page.locator(':visible');
  let targets = page.getByRole('link', { name: pattern }).or(page.getByRole('tab', { name: pattern })).and(visible);
  if (!await targets.count() && !options.linksOnly) targets = page.getByRole('button', { name: pattern })
    .and(page.getByRole('button', { name: /^(load|view|show|browse|open|refresh)\b/i })).and(visible);
  if (!await targets.count() && !options.linksOnly) targets = page.getByRole('button', {
    name: new RegExp(`^(?:${pattern.source})$`, pattern.flags),
  }).and(visible);
  if (!await targets.count()) return false;
  const target = await uniqueUiTarget(targets, `read navigation ${pattern}`);
  if (options.keyboard) { await target.focus(); await page.keyboard.press('Enter'); }
  else await target.click();
  return true;
}

// Supply scenario-owned values through visible inputs, never through storage,
// application functions, or direct API calls. Multiple matching controls remain
// unresolved: the driver must specify the relevant form instead.
export async function fillUiContext(page, values) {
  for (const [pattern, value] of values) {
    const target = page.getByLabel(pattern).and(page.locator('input:visible,select:visible,textarea:visible'));
    if (await target.count() !== 1) continue;
    if (await target.evaluate(e => e.tagName.toLowerCase()) === 'select') await target.selectOption(String(value));
    else await target.fill(String(value));
  }
}

// Explicit assertion boundary, not a catch-all for Playwright operations. The
// caller must have established the business state before asserting its display.
export async function assertUiEvidence(locator, label) {
  try { await locator.first().waitFor({ state: 'visible' }); }
  catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    candidateAssert.fail(`Required visible UI evidence was not displayed: ${label}`);
  }
}

export async function assertUiLoading(page, action) {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const handler = async route => { await held; await route.continue(); };
  await page.route('**/api/v1/**', handler, { times: 1 });
  const requested = observeBrowserWait(page.waitForRequest('**/api/v1/**'));
  const acting = observeBrowserWait(Promise.resolve().then(action));
  try {
    try { await requested; }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw uiAutomationError('NO_MATCHING_REQUEST', 'Loading probe did not observe an API request', {}, error);
    }
    await assertUiEvidence(page.locator('[aria-busy="true"],[role="progressbar"]').or(page.getByText(/loading/i)).and(page.locator(':visible')), 'loading during an observed, held API request');
  } finally {
    release(); await page.unroute('**/api/v1/**', handler); await acting;
  }
}

export async function scopeUiAction(page, heading, action) {
  // A named action also identifies a form without an internal heading. Do not
  // select a generic Submit from a different form or a read-only Load button.
  const specific = page.getByRole('button', { name: action })
    .and(page.getByRole('button', { name: heading })).and(page.locator(':visible'));
  const mutations = specific.and(page.getByRole('button', { name: /^(?!(?:load|view|show|browse|open|refresh)\b)/i }));
  if (await mutations.count() === 1) {
    const root = mutations.locator('xpath=ancestor::*[self::form or self::fieldset or self::section][1]');
    if (await root.count() === 1) return root;
  }
  for (const tag of ['form', 'fieldset', 'section']) {
    const roots = page.locator(`${tag}:visible`);
    const named = roots.filter({ has: page.getByRole('heading', { name: heading }) })
      .or(roots.and(page.getByRole(tag === 'form' ? 'form' : tag === 'fieldset' ? 'group' : 'region', { name: heading })));
    const candidates = [];
    for (let i = 0; i < await named.count(); i++) {
      const item = named.nth(i);
      if (await item.getByRole('button', { name: action }).count()) candidates.push(item);
    }
    const innermost = [];
    for (const item of candidates) {
      let containsAnother = false;
      for (const other of candidates) if (other !== item
        && await item.evaluate((element, child) => element.contains(child), await other.elementHandle())) { containsAnother = true; break; }
      if (!containsAnother) innermost.push(item);
    }
    if (innermost.length === 1) {
      const root = innermost[0];
      const actionButton = root.getByRole('button', { name: action }).and(page.locator(':visible'));
      // A section heading can name an inner, unlabelled form. Preserve that
      // form boundary instead of admitting fields from adjacent forms.
      if (await actionButton.count() === 1) {
        const form = actionButton.locator('xpath=ancestor::form[1]');
        if (await form.count() === 1 && await root.evaluate((element, child) => element.contains(child), await form.elementHandle())) return form;
      }
      return root;
    }
    if (innermost.length > 1) throw uiAutomationError('TARGET_AMBIGUOUS', `Ambiguous form ${heading}`, { count: innermost.length });
  }
  const button = await uniqueUiTarget(page.getByRole('button', { name: action }).and(page.locator(':visible')), `action ${action}`);
  return uniqueUiTarget(button.locator('xpath=ancestor::*[self::form or self::fieldset or self::section][1]'), `form for ${action}`);
}

// Observe actual traffic; do not synthesize requests. Private diagnostics omit
// query strings, headers, bodies and DOM values, which may contain credentials.
export async function captureBrowserAction(page, matches, action, { timeoutMs = 30_000, expectSuccessfulMutations = false } = {}) {
  const requests = []; let matchingRequest;
  let resolve, reject;
  const pending = observeBrowserWait(new Promise((yes, no) => { resolve = yes; reject = no; }));
  const onRequest = request => {
    if (requests.length < 20) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    if (matches(request)) matchingRequest = request;
  };
  const onResponse = response => {
    const request = response.request();
    if (matches(request)) resolve({ request, response });
    else if (expectSuccessfulMutations && request.method() === 'POST' && response.status() >= 400) {
      const url = new URL(request.url());
      // Only explicit positive UI flows opt in. A real rejected prerequisite
      // mutation on this candidate's API is not an absent-selector diagnosis.
      if (url.origin === new URL(page.url()).origin && url.pathname.startsWith('/api/v1/')) {
        try { candidateAssert.fail(`Positive UI flow emitted a rejected prerequisite: POST ${url.pathname} returned ${response.status()}`); }
        catch (error) { reject(error); }
      }
    }
  };
  const onFailure = request => {
    if (matches(request)) resolve({ request, failure: request.failure()?.errorText ?? 'request failed' });
  };
  page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailure);
  const timer = setTimeout(() => reject(uiAutomationError(
    matchingRequest ? 'RESPONSE_TIMEOUT' : 'NO_MATCHING_REQUEST',
    matchingRequest ? 'UI sent a matching request but no response was observed' : 'UI action produced no matching request',
    { requests, matchedRequest: Boolean(matchingRequest) },
  )), timeoutMs);
  try { await action(); return await pending; }
  catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    throw uiAutomationError('ACTION_UNRESOLVED', 'The visible UI action could not complete', {
      requests, matchedRequest: Boolean(matchingRequest),
    }, error);
  }
  finally {
    clearTimeout(timer);
    page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailure);
  }
}

export async function captureBrowserResponse(page, matches, action, options) {
  const observed = await captureBrowserAction(page, matches, action, options);
  if (!observed.response) throw uiAutomationError('REQUEST_FAILED', 'Observed UI request failed before an HTTP response', {
    method: observed.request.method(), path: new URL(observed.request.url()).pathname,
  });
  return observed.response;
}
