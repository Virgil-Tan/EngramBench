import assert from "node:assert/strict";
import { assertCoreInvariants, exactKeys, resource } from "../oracles/index.mjs";
import { blockedCase, capture, guardedCase, prepare, waitSnapshot } from "./helpers.mjs";

const C01 = guardedCase("C-01", ["WORK_FENCING", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.work();
  const { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, "work-lifecycle");
  const pending = await ctx.snapshot(api.baseUrl);
  const selected = pending.work.filter((work) => work.kind === "FULFILLMENT" && (work.aggregateId === captured.orderId || resource(pending, "fulfillmentPlans").some((plan) => plan.orderId === captured.orderId && plan.fulfillmentPlanId === work.aggregateId)));
  assert.ok(selected.length > 0, "capture publishes Fulfillment Work");
  for (const work of selected) {
    exactKeys(work, ["workId", "tenantId", "kind", "aggregateId", "payloadVersion", "state", "attempts", "availableAt", "leaseOwner", "leaseExpiresAt", "fencingToken", "terminal"], `Work ${work.workId}`);
    assert.equal(work.state, "PENDING", "new Work pending");
    assert.equal(work.terminal, false, "new Work nonterminal");
    assert.equal(work.attempts, 0, "new Work attempts zero");
  }
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const terminal = await waitSnapshot(ctx, api.baseUrl, (snapshot) => {
    const ids = new Set(selected.map(({ workId }) => workId));
    const current = snapshot.work.filter(({ workId }) => ids.has(workId));
    return current.length === selected.length && current.every(({ terminal: value }) => value);
  }, { timeoutMs: 120_000, processes: workers, label: "Fulfillment Work terminal retention" });
  for (const initial of selected) {
    const final = terminal.work.find(({ workId }) => workId === initial.workId);
    assert.ok(final.attempts >= 1 && final.fencingToken >= initial.fencingToken, "attempt and fencing monotonic");
    assert.ok(["SUCCEEDED", "DEAD"].includes(final.state), "terminal Work state");
    assert.equal(final.terminal, true, "terminal retained");
  }
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const afterRestart = await ctx.snapshot(restarted.baseUrl);
  assert.ok(selected.every((initial) => afterRestart.work.some(({ workId, terminal: value }) => workId === initial.workId && value)), "terminal Work survives process restart");
  assertCoreInvariants(afterRestart);
  return ctx.pass({ evidence: [{ terminalWorkIds: selected.map(({ workId }) => workId) }] });
});

const C02 = blockedCase("C-02", [["CC-C02-BARRIER", "CC-GAP-04"]]);
const C03 = blockedCase("C-03", [["CC-C03-BARRIER", "CC-GAP-04"]]);
const C04 = blockedCase("C-04", [["CC-C04-BARRIER", "CC-GAP-04"]]);
const C05 = blockedCase("C-05", [["CC-C05-BARRIER", "CC-GAP-04"]]);
const C06 = blockedCase("C-06", [["CC-C06-MANAGER-WIRE", "CC-GAP-02"], ["CC-C06-BARRIER", "CC-GAP-04"], ["CC-C06-FINAL-SEED", "CC-GAP-05"], ["CC-C06-SETTLEMENT-FORMULA", "CC-GAP-10"]]);
const C07 = blockedCase("C-07", [["CC-C07-BARRIER", "CC-GAP-04"]]);
const C08 = blockedCase("C-08", [["CC-C08-BARRIER", "CC-GAP-04"]]);

export const C_CASES = Object.freeze([C01, C02, C03, C04, C05, C06, C07, C08]);
