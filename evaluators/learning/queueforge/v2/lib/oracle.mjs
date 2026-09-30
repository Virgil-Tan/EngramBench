import { createHash } from "node:crypto";

function invariant(condition, message) { if (!condition) throw new Error(message); }

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  invariant(value && typeof value === "object", "canonical JSON rejects unsupported values");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

export function operationResult(operation, input) {
  canonical(input);
  if (operation === "ECHO") return JSON.parse(canonical(input));
  if (operation === "SHA256") return { sha256: sha256Bytes(input) };
  invariant(operation === "SUM_INTEGERS", `unknown operation ${operation}`);
  invariant(input && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).length === 1 && Array.isArray(input.values)
    && input.values.length >= 1 && input.values.length <= 10_000, "invalid SUM_INTEGERS input");
  let sum = 0;
  for (const value of input.values) {
    invariant(Number.isSafeInteger(value), "SUM_INTEGERS values must be safe integers");
    sum += value;
    invariant(Number.isSafeInteger(sum), "SUM_INTEGERS overflow");
  }
  return { sum };
}

export function outputDigest(output) { return sha256Bytes(canonical(output)); }

export function retryDelayMs(attemptNumber) {
  invariant(Number.isSafeInteger(attemptNumber) && attemptNumber > 0, "attempt must be positive");
  return Math.min(100 * (2 ** (attemptNumber - 1)), 5_000);
}

export function compareClaimOrder(left, right) {
  return right.priority - left.priority
    || Date.parse(left.notBefore) - Date.parse(right.notBefore)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || Buffer.from(left.runId).compare(Buffer.from(right.runId));
}

export function workflowOracle(nodes) {
  invariant(Array.isArray(nodes) && nodes.length >= 1 && nodes.length <= 50, "workflow requires 1 through 50 nodes");
  const normalized = nodes.map((node) => {
    invariant(node && typeof node === "object" && typeof node.nodeKey === "string" && node.nodeKey.length > 0, "invalid nodeKey");
    invariant(Array.isArray(node.dependsOn), "dependsOn must be an array");
    invariant(new Set(node.dependsOn).size === node.dependsOn.length, "duplicate edge");
    invariant(!node.dependsOn.includes(node.nodeKey), "self edge creates a cycle");
    return { nodeKey: node.nodeKey, dependsOn: [...node.dependsOn].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))) };
  });
  const keys = new Set(normalized.map(({ nodeKey }) => nodeKey));
  invariant(keys.size === normalized.length, "duplicate node key");
  for (const node of normalized) for (const dependency of node.dependsOn) invariant(keys.has(dependency), "missing dependency creates an invalid cycle graph");
  const byKey = new Map(normalized.map((node) => [node.nodeKey, node]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) throw new Error("workflow dependency cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key).dependsOn) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
  const descendants = (start) => normalized.filter(({ nodeKey }) => {
    const seen = new Set();
    const contains = (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      const item = byKey.get(key);
      return item.dependsOn.includes(start) || item.dependsOn.some(contains);
    };
    return nodeKey !== start && contains(nodeKey);
  }).map(({ nodeKey }) => nodeKey);
  const failedAncestors = (states, key) => {
    const failed = new Set();
    const collect = (candidate) => {
      for (const dependency of byKey.get(candidate).dependsOn) {
        if (states.get(dependency) === "FAILED") failed.add(dependency);
        collect(dependency);
      }
    };
    collect(key);
    return [...failed].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  };
  const order = (values) => [...values].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return Object.freeze({
    nodes: normalized.toSorted((a, b) => Buffer.from(a.nodeKey).compare(Buffer.from(b.nodeKey))),
    eligible(states) {
      return order(normalized.filter(({ nodeKey, dependsOn }) => {
        const state = states.get(nodeKey) ?? "QUEUED";
        return state === "QUEUED" && dependsOn.every((key) => states.get(key) === "SUCCEEDED");
      }).map(({ nodeKey }) => nodeKey));
    },
    blockedBy(states) {
      const failed = normalized.filter(({ nodeKey }) => states.get(nodeKey) === "FAILED").map(({ nodeKey }) => nodeKey);
      return order(new Set(failed.flatMap(descendants)).difference(new Set(normalized.filter(({ nodeKey }) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(states.get(nodeKey))).map(({ nodeKey }) => nodeKey))));
    },
    failedAncestors: (states, key) => failedAncestors(states, key),
    retryRelease(states, failedKey) {
      invariant(states.get(failedKey) === "FAILED", "retry target must be FAILED");
      return order(descendants(failedKey).filter((key) => states.get(key) === "BLOCKED" && failedAncestors(states, key).every((value) => value === failedKey)));
    },
    aggregateState(states, { cancelled = false, started = false } = {}) {
      if (cancelled) return "CANCELLED";
      const values = normalized.map(({ nodeKey }) => states.get(nodeKey) ?? "QUEUED");
      if (values.every((state) => state === "SUCCEEDED")) return "SUCCEEDED";
      if (!values.some((state) => state === "QUEUED" || state === "RUNNING") && values.some((state) => state === "FAILED" || state === "BLOCKED")) return "FAILED";
      return started || values.some((state) => state !== "QUEUED") ? "RUNNING" : "QUEUED";
    },
  });
}
