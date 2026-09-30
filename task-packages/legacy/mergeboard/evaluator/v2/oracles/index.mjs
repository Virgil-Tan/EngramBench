import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new TypeError("canonical domain numbers must be safe integers");
  return JSON.stringify(value);
}

export function documentDigest(documentId, revision, blocks) {
  return createHash("sha256").update(canonicalJson({ documentId, revision, blocks })).digest("hex");
}

function cloneBlocks(blocks) { return blocks.map((block) => ({ blockId: block.blockId, text: block.text })); }
function predecessor(blocks, index) { return index <= 0 ? null : blocks[index - 1].blockId; }
function conflict(operationIndex, code, path, baseValue, headValue) { return { operationIndex, code, path, baseValue, headValue }; }

function applyOne(blocks, operation, operationIndex) {
  const working = cloneBlocks(blocks);
  if (operation.op === "INSERT_AFTER") {
    if (working.some(({ blockId }) => blockId === operation.block?.blockId)) return { conflict: conflict(operationIndex, "BLOCK_ID_EXISTS", `/operations/${operationIndex}/block/blockId`, null, operation.block.blockId) };
    const anchor = operation.afterBlockId === null ? -1 : working.findIndex(({ blockId }) => blockId === operation.afterBlockId);
    if (operation.afterBlockId !== null && anchor < 0) return { conflict: conflict(operationIndex, "ANCHOR_MISSING", `/operations/${operationIndex}/afterBlockId`, operation.afterBlockId, null) };
    working.splice(anchor + 1, 0, { blockId: operation.block.blockId, text: operation.block.text });
    return { blocks: working };
  }
  const index = working.findIndex(({ blockId }) => blockId === operation.blockId);
  if (index < 0) return { conflict: conflict(operationIndex, "TARGET_MISSING", `/operations/${operationIndex}/blockId`, operation.blockId, null) };
  if (operation.op === "REPLACE") {
    if (working[index].text !== operation.expectedText) return { conflict: conflict(operationIndex, "TARGET_CHANGED", `/operations/${operationIndex}/expectedText`, operation.expectedText, working[index].text) };
    working[index] = { ...working[index], text: operation.newText };
    return { blocks: working };
  }
  if (operation.op === "DELETE") {
    if (working[index].text !== operation.expectedText) return { conflict: conflict(operationIndex, "TARGET_CHANGED", `/operations/${operationIndex}/expectedText`, operation.expectedText, working[index].text) };
    working.splice(index, 1);
    return { blocks: working };
  }
  if (operation.op === "MOVE_AFTER") {
    if (operation.afterBlockId === operation.blockId) return { conflict: conflict(operationIndex, "MOVE_BASE_CHANGED", `/operations/${operationIndex}/afterBlockId`, operation.expectedAfterBlockId, operation.afterBlockId) };
    const anchorIndex = operation.afterBlockId === null ? -1 : working.findIndex(({ blockId }) => blockId === operation.afterBlockId);
    if (operation.afterBlockId !== null && anchorIndex < 0) return { conflict: conflict(operationIndex, "ANCHOR_MISSING", `/operations/${operationIndex}/afterBlockId`, operation.afterBlockId, null) };
    const currentAfter = predecessor(working, index);
    if (currentAfter !== operation.expectedAfterBlockId) return { conflict: conflict(operationIndex, "MOVE_BASE_CHANGED", `/operations/${operationIndex}/expectedAfterBlockId`, operation.expectedAfterBlockId, currentAfter) };
    const [moved] = working.splice(index, 1);
    const destination = operation.afterBlockId === null ? 0 : working.findIndex(({ blockId }) => blockId === operation.afterBlockId) + 1;
    working.splice(destination, 0, moved);
    return { blocks: working };
  }
  throw new TypeError(`unknown operation ${operation.op}`);
}

export function applyOperations(blocks, operations) {
  let working = cloneBlocks(blocks);
  for (const [index, operation] of operations.entries()) {
    const outcome = applyOne(working, operation, index);
    if (outcome.conflict) return { blocks: cloneBlocks(blocks), conflicts: [outcome.conflict] };
    working = outcome.blocks;
  }
  return { blocks: working, conflicts: [] };
}

export function rebaseOperations(headBlocks, operations) {
  let working = cloneBlocks(headBlocks);
  const conflicts = [];
  for (const [index, operation] of operations.entries()) {
    const outcome = applyOne(working, operation, index);
    if (outcome.conflict) conflicts.push(outcome.conflict);
    else working = outcome.blocks;
  }
  return { blocks: conflicts.length === 0 ? working : cloneBlocks(headBlocks), conflicts };
}

function bytewise(left, right) { return Buffer.from(left).compare(Buffer.from(right)); }
export function documentDiff(fromBlocks, toBlocks) {
  const from = new Map(fromBlocks.map((item, index) => [item.blockId, { ...item, index }]));
  const to = new Map(toBlocks.map((item, index) => [item.blockId, { ...item, index }]));
  const items = [];
  for (const blockId of new Set([...from.keys(), ...to.keys()])) {
    const before = from.get(blockId); const after = to.get(blockId);
    if (!after) items.push({ blockId, kind: "DELETE", fromIndex: before.index, toIndex: null, fromText: before.text, toText: null });
    else if (!before) items.push({ blockId, kind: "INSERT", fromIndex: null, toIndex: after.index, fromText: null, toText: after.text });
    else {
      if (before.text !== after.text) items.push({ blockId, kind: "REPLACE", fromIndex: before.index, toIndex: after.index, fromText: before.text, toText: after.text });
      if (before.index !== after.index) items.push({ blockId, kind: "MOVE", fromIndex: before.index, toIndex: after.index, fromText: before.text, toText: after.text });
    }
  }
  const kindOrder = new Map([["DELETE", 0], ["INSERT", 1], ["REPLACE", 2], ["MOVE", 3]]);
  return items.sort((left, right) => bytewise(left.blockId, right.blockId) || kindOrder.get(left.kind) - kindOrder.get(right.kind));
}

export function mergePreview(targetBlocks, mergeOperations) {
  const operations = mergeOperations.map((item) => item.operation ?? item);
  return rebaseOperations(targetBlocks, operations);
}

export function assertEventSequence(events) {
  const byAggregate = new Map();
  for (const event of events) {
    assert.equal(event.schemaVersion, 1);
    assert.deepEqual(event.payload, {});
    const own = byAggregate.get(event.aggregateId) ?? [];
    own.push(event); byAggregate.set(event.aggregateId, own);
  }
  for (const own of byAggregate.values()) assert.deepEqual(own.map(({ sequence }) => sequence), Array.from({ length: own.length }, (_, index) => index + 1));
}

export function percentile(values, quantile) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}
