export const LEARNING_TASK_ORDER = Object.freeze([
  "launchpass",
  "schemaharbor",
  "importworks",
  "rulebench",
  "auctionguard",
  "queueforge",
  "ledgerbridge",
  "geopulse",
  "mediadock",
  "quotamesh",
  "billforge",
  "clinicgrid",
  "configrelay",
  "dispatchboard",
  "notifyroute",
  "routeweave",
  "edgetwin",
  "reconcilehub",
  "mergeboard",
  "evidencechain",
  "artifactvault",
  "exportvault",
  "firmwarefleet",
  "configorbit",
  "entitlementhub",
  "moderationflow",
  "fraudlens",
  "identitymesh",
  "seatreserve",
  "routepilot",
]);

export const TRANSFER_TASK_ORDER = Object.freeze([
  "metersettle", "dockchain", "incidentrelay", "flagfoundry", "carbonledger", "parcelflow",
  "coldchaincontrol", "creatorrightsexchange", "accesssentinel", "commercecommand",
  "escrowguard", "permitforge", "capacitylease",
]);

export const TASK_ORDER = Object.freeze([
  ...LEARNING_TASK_ORDER,
  ...TRANSFER_TASK_ORDER,
]);

const EXPECTED_PHASE = new Map([
  ...LEARNING_TASK_ORDER.map((id) => [id, "learning"]),
  ...TRANSFER_TASK_ORDER.map((id) => [id, "transfer"]),
]);

export function resolveTaskOrder(entries, requestedIds) {
  const byId = new Map();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`Duplicate task package: ${entry.id}`);
    byId.set(entry.id, entry);
  }

  const missing = TASK_ORDER.filter((id) => !byId.has(id));
  const unknown = [...byId.keys()].filter((id) => !EXPECTED_PHASE.has(id));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Task package set does not match the frozen curriculum (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`);
  }

  for (const [id, expectedPhase] of EXPECTED_PHASE) {
    const actualPhase = byId.get(id).phase;
    if (actualPhase !== expectedPhase) {
      throw new Error(`Task ${id} must be ${expectedPhase}, received ${actualPhase}`);
    }
  }

  if (requestedIds === undefined) return [...TASK_ORDER];
  const requested = new Set();
  for (const id of requestedIds) {
    if (!EXPECTED_PHASE.has(id)) throw new Error(`Unknown requested task: ${id}`);
    if (requested.has(id)) throw new Error(`Duplicate requested task: ${id}`);
    requested.add(id);
  }
  return TASK_ORDER.filter((id) => requested.has(id));
}
