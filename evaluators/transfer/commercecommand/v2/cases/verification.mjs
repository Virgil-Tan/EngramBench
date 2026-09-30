import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateBarrierPayload } from '../lib/runtime.mjs';

// Independent public-protocol dependency; it never imports or changes submitted code.
export async function recoveryGateController(ctx, { reject = false } = {}) {
  const token = ctx.key(`recovery-gate-controller:${reject}`), ledger = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/barrier' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(); return;
    }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.match(request.headers['content-type'] ?? '', /^application\/json(?:;|$)/i);
      assert(validateBarrierPayload(body), 'published recovery barrier payload');
      ledger.push({ role: body.role, point: body.point, responseStatus: reject ? 503 : 204 });
      response.writeHead(reject ? 503 : 204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  ctx.defer(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ledger, env: { TEST_BARRIER_URL: `http://127.0.0.1:${server.address().port}/barrier`, TEST_BARRIER_TOKEN: token } };
}

export function assertRecoveryGateObserved(controller) {
  for (const [role, point] of [['worker', 'worker.claimed'], ['dispatcher', 'dispatcher.response-received']]) {
    assert(controller.ledger.some(entry => entry.role === role && entry.point === point && entry.responseStatus === 204), `test:recovery must actually reach ${point} through its supplied controller`);
  }
}

export async function assertVisibleMinor(page, testId, expected) {
  const locator = page.getByTestId(testId);
  assert.equal(await locator.count(), 1, `one visible result ${testId}`);
  assert.equal(await locator.isVisible(), true, `${testId} is visible`);
  const text = (await locator.textContent()).trim();
  assert.match(text, /^-?(?:0|[1-9][0-9]*)$/, `${testId} displays published integer minor units`);
  assert.equal(Number(text), expected, `${testId} agrees with committed API/snapshot money`);
}
