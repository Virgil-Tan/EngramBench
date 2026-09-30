import assert from "node:assert/strict";
import test from "node:test";

import { canonical, compareClaimOrder, operationResult, retryDelayMs, workflowOracle } from "../lib/oracle.mjs";

test("operation oracle uses known exact ECHO, SHA256, and integer SUM results", () => {
  assert.deepEqual(operationResult("ECHO", { b: 2, a: 1 }), { a: 1, b: 2 });
  assert.deepEqual(operationResult("SHA256", { a: 1 }), { sha256: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862" });
  assert.deepEqual(operationResult("SUM_INTEGERS", { values: [4, -2, 9] }), { sum: 11 });
  assert.throws(() => operationResult("SUM_INTEGERS", { values: [Number.MAX_SAFE_INTEGER, 1] }), /overflow/iu);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("workflow oracle rejects invalid graphs and models the worked example", () => {
  assert.throws(() => workflowOracle([{ nodeKey: "a", dependsOn: ["a"] }]), /cycle|self/iu);
  const graph = workflowOracle([
    { nodeKey: "A", dependsOn: [] },
    { nodeKey: "B", dependsOn: ["A"] },
    { nodeKey: "C", dependsOn: ["A"] },
    { nodeKey: "D", dependsOn: ["B", "C"] },
    { nodeKey: "E", dependsOn: ["D"] },
  ]);
  assert.deepEqual(graph.eligible(new Map()), ["A"]);
  assert.deepEqual(graph.eligible(new Map([["A", "SUCCEEDED"]])), ["B", "C"]);
  assert.deepEqual(graph.blockedBy(new Map([["A", "SUCCEEDED"], ["B", "FAILED"], ["C", "SUCCEEDED"]])), ["D", "E"]);
});

test("queue and selective retry oracles cover every published tie-break and failed ancestor", () => {
  const runs = [
    { runId: "b", priority: 1, notBefore: "2030-01-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
    { runId: "a", priority: 1, notBefore: "2030-01-01T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
    { runId: "c", priority: 2, notBefore: "2030-01-02T00:00:00.000Z", createdAt: "2030-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(runs.toSorted(compareClaimOrder).map(({ runId }) => runId), ["c", "a", "b"]);
  assert.deepEqual([1, 2, 7, 8].map(retryDelayMs), [100, 200, 5000, 5000]);
  const graph = workflowOracle([
    { nodeKey: "A", dependsOn: [] }, { nodeKey: "B", dependsOn: [] },
    { nodeKey: "X", dependsOn: ["A"] }, { nodeKey: "Y", dependsOn: ["A", "B"] },
  ]);
  const states = new Map([["A", "FAILED"], ["B", "FAILED"], ["X", "BLOCKED"], ["Y", "BLOCKED"]]);
  assert.deepEqual(graph.retryRelease(states, "A"), ["X"]);
  assert.equal(graph.aggregateState(states), "FAILED");
});
