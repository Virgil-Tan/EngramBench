import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("EvidenceChain canonical JSON accepts safe integers only");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("value is outside canonical JSON domain");
}
export function canonicalDigest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function rankMatches(items, scans) {
  const candidates = [];
  for (const item of items) for (const scan of scans) {
    if (item.expectedLabel !== scan.label) continue;
    candidates.push({ item, scan, sealRank: item.expectedSealCode === scan.sealCode ? 0 : 1 });
  }
  return candidates.sort((left, right) => left.item.caseId.localeCompare(right.item.caseId)
    || left.item.expectedLabel.localeCompare(right.item.expectedLabel)
    || left.item.collectedItemId.localeCompare(right.item.collectedItemId)
    || left.sealRank - right.sealRank
    || left.scan.scannedAt.localeCompare(right.scan.scannedAt)
    || left.scan.deviceId.localeCompare(right.scan.deviceId)
    || left.scan.intakeScanId.localeCompare(right.scan.intakeScanId));
}

export function assertQuantityConserved(parentQuantity, aliquots) {
  if (!Number.isSafeInteger(parentQuantity) || parentQuantity <= 0 || !Array.isArray(aliquots) || aliquots.length < 2 || aliquots.length > 20) throw new Error("invalid split cardinality or parent quantity");
  let sum = 0n;
  const ids = new Set();
  for (const aliquot of aliquots) {
    if (!Number.isSafeInteger(aliquot.quantity) || aliquot.quantity <= 0) throw new Error("aliquot quantity must be a positive safe integer");
    if (ids.has(aliquot.aliquotId)) throw new Error("duplicate Aliquot identity");
    ids.add(aliquot.aliquotId);
    sum += BigInt(aliquot.quantity);
  }
  if (sum !== BigInt(parentQuantity)) throw new Error("ALIQUOT_QUANTITY_MISMATCH");
  return true;
}

export function assertTimeline(items) {
  const sequences = items.map(({ sequence }) => sequence);
  const expected = Array.from({ length: sequences.length }, (_, index) => index + 1);
  if (canonicalJson(sequences) !== canonicalJson(expected)) throw new Error("timeline sequence is not contiguous");
  for (const item of items) {
    const custody = item.type === "CUSTODY_TRANSFERRED";
    if (custody !== Boolean(item.transferId && item.fromCustodianId && item.toCustodianId)) throw new Error("timeline custody fields are inconsistent");
    const matched = ["MATCH_CONFIRMED", "MATCH_REVERSED"].includes(item.type);
    if (matched !== Boolean(item.matchId)) throw new Error("timeline Match field is inconsistent");
  }
  return true;
}

function unique(items, select, label) {
  const values = new Set();
  for (const item of items) { const value = select(item); if (values.has(value)) throw new Error(`${label} is duplicated`); values.add(value); }
}

export function assertEvidenceInvariants(snapshot) {
  const resources = snapshot?.resources ?? snapshot;
  for (const key of ["cases", "caseManifests", "facilities", "custodians", "deviceRegistrations", "intakeScans", "collectedItems", "custodyMatches", "custodyTransfers"]) if (!Array.isArray(resources?.[key])) throw new Error(`missing EvidenceChain resource ${key}`);
  unique(resources.intakeScans, ({ intakeScanId }) => intakeScanId, "Intake Scan");
  unique(resources.custodyMatches.filter(({ state }) => state !== "REVERSED"), ({ intakeScanId }) => intakeScanId, "active matched Scan");
  unique(resources.custodyMatches.filter(({ state }) => state !== "REVERSED"), ({ collectedItemId }) => collectedItemId, "active matched Item");
  const transfers = new Map(resources.custodyTransfers.map((item) => [item.transferId, item]));
  for (const transfer of resources.custodyTransfers) if (transfer.priorTransferId && !transfers.has(transfer.priorTransferId)) throw new Error("broken custody transfer chain");
  if (resources.itemSplits) {
    unique(resources.itemSplits, ({ splitId }) => splitId, "Item Split");
    unique(resources.aliquots, ({ aliquotId }) => aliquotId, "Aliquot");
    for (const split of resources.itemSplits.filter(({ state }) => state === "ACTIVE")) assertQuantityConserved(split.totalQuantity, resources.aliquots.filter(({ parentItemId }) => parentItemId === split.parentItemId));
    for (const group of resources.custodyMatchGroups) {
      const memberIds = group.members.map(({ collectedItemId, aliquotId }) => collectedItemId ?? aliquotId);
      if (new Set(memberIds).size !== memberIds.length) throw new Error("Group member is duplicated");
      if (new Set(group.members.map(({ intakeScanId }) => intakeScanId)).size !== group.members.length) throw new Error("Group reuses an Intake Scan");
    }
  }
  const sequences = new Map();
  for (const event of snapshot?.events ?? []) { const values = sequences.get(event.aggregateId) ?? []; values.push(event.sequence); sequences.set(event.aggregateId, values); }
  for (const [aggregateId, values] of sequences) {
    const actual = [...new Set(values)].sort((a, b) => a - b);
    const expected = Array.from({ length: actual.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`event sequence for ${aggregateId} is not contiguous`);
  }
  return true;
}

export function percentile(samples, quantile) {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * ordered.length));
  return ordered[Math.min(rank - 1, ordered.length - 1)];
}
