import { createHash } from "node:crypto";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `dockchain\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `dc-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const alignedBaseTime = Math.floor(Date.parse(baseTime) / (15 * 60_000)) * 15 * 60_000;
  const at = ({ seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) => new Date(alignedBaseTime + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000).toISOString();
  const interval = (start, end) => ({ startAt: at(start), endAt: at(end) });
  const calendar = [interval({ days: 1 }, { days: 31 })];

  const berths = [
    { berthId: uuid("berth-a"), name: "Berth Alpha", priority: 1, maxLengthMeters: 300, availability: calendar },
    { berthId: uuid("berth-b"), name: "Berth Bravo", priority: 2, maxLengthMeters: 400, availability: calendar },
    { berthId: uuid("berth-c"), name: "Berth Charlie", priority: 3, maxLengthMeters: 500, availability: calendar },
  ];
  const tugPools = [
    { tugPoolId: uuid("tug-a"), name: "Tug Pool Alpha", priority: 1, capacity: 2, availability: calendar },
    { tugPoolId: uuid("tug-b"), name: "Tug Pool Bravo", priority: 2, capacity: 4, availability: calendar },
    { tugPoolId: uuid("tug-c"), name: "Tug Pool Charlie", priority: 3, capacity: 8, availability: calendar },
  ];
  const yardWindows = [
    { yardWindowId: uuid("yard-a"), priority: 1, capacityUnits: 100, startAt: at({ days: 1 }), endAt: at({ days: 31 }) },
    { yardWindowId: uuid("yard-b"), priority: 2, capacityUnits: 250, startAt: at({ days: 1 }), endAt: at({ days: 31 }) },
    { yardWindowId: uuid("yard-c"), priority: 3, capacityUnits: 500, startAt: at({ days: 1 }), endAt: at({ days: 31 }) },
  ];
  const vessels = [
    { vesselId: uuid("vessel-small"), name: "MV Small", lengthMeters: 200 },
    { vesselId: uuid("vessel-medium"), name: "MV Medium", lengthMeters: 350 },
    { vesselId: uuid("vessel-large"), name: "MV Large", lengthMeters: 450 },
    { vesselId: uuid("vessel-too-large"), name: "MV Too Large", lengthMeters: 700 },
  ];

  const v1Payload = (label, overrides = {}) => ({ vesselId: vessels[0].vesselId, arrivalAt: at({ days: 2, hours: 8 }), departureAt: at({ days: 2, hours: 10 }), requiredTugs: 1, containerUnits: 25, ...overrides });
  const linkedPayload = (label, overrides = {}) => ({ vesselId: vessels[0].vesselId, arrival: { startAt: at({ days: 3, hours: 8 }), endAt: at({ days: 3, hours: 10 }), requiredTugs: 1, containerUnits: 25 }, departure: { startAt: at({ days: 3, hours: 12 }), endAt: at({ days: 3, hours: 14 }), requiredTugs: 1, containerUnits: 25 }, ...overrides });
  const standbyPayload = (label, overrides = {}) => ({ vesselId: vessels[0].vesselId, arrivalFrom: at({ days: 4, hours: 8 }), arrivalTo: at({ days: 4, hours: 16 }), durationMinutes: 120, requiredTugs: 1, containerUnits: 25, priority: 10, ...overrides });

  const v1Call = (label, overrides = {}) => ({
    portCallId: uuid(`port-call:${label}`), vesselId: vessels[0].vesselId,
    arrivalAt: at({ days: 5, hours: 8 }), departureAt: at({ days: 5, hours: 10 }), requiredTugs: 1, containerUnits: 25,
    berthId: berths[0].berthId, tugPoolId: tugPools[0].tugPoolId, yardWindowId: yardWindows[0].yardWindowId,
    state: "HELD", expiresAt: "2099-01-01T00:00:00.000Z", startedAt: null, completedAt: null, sequence: 1,
    ...overrides,
  });
  const standbyEntry = (label, overrides = {}) => ({
    standbyEntryId: uuid(`standby:${label}`), vesselId: vessels[0].vesselId,
    arrivalFrom: at({ days: 6, hours: 8 }), arrivalTo: at({ days: 6, hours: 16 }), durationMinutes: 120,
    requiredTugs: 1, containerUnits: 25, priority: 10, state: "WAITING", requestedAt: at({ hours: Number.parseInt(label, 10) || 0 }), portCallId: null,
    ...overrides,
  });
  const seed = (version, overrides = {}) => ({ schemaVersion: 1, seedVersion: version, berths, tugPools, yardWindows, vessels, portCalls: [], standbyEntries: [], ...overrides });

  function empty() { return { fixtureFamily: "DC-F-EMPTY", seed: seed(`${caseId.toLowerCase()}-empty`, { berths: [], tugPools: [], yardWindows: [], vessels: [] }) }; }
  function resourceGrid() { return { fixtureFamily: "DC-F-RESOURCE-GRID", uuid, key, at, berths, tugPools, yardWindows, vessels, v1Payload, linkedPayload, v1Call, seed: seed(`${caseId.toLowerCase()}-grid`), workedExample: { firstBerthId: berths[0].berthId, firstTugInsufficientId: tugPools[0].tugPoolId, expectedTugId: tugPools[1].tugPoolId, firstYardId: yardWindows[0].yardWindowId } }; }
  function portCall() { return { ...resourceGrid(), fixtureFamily: "DC-F-PORT-CALL", v1Call, seed: seed(`${caseId.toLowerCase()}-call`) }; }
  function standby() { const withdrawn = standbyEntry("99", { state: "WITHDRAWN" }); return { ...resourceGrid(), fixtureFamily: "DC-F-STANDBY", standbyPayload, standbyEntry, withdrawn, seed: seed(`${caseId.toLowerCase()}-standby`, { standbyEntries: [withdrawn] }) }; }
  function idempotency() { return { ...standby(), fixtureFamily: "DC-F-IDEMPOTENCY", mutationPaths: ["create", "confirm", "start-service", "cancel", "complete", "standby", "movement"] }; }
  function work() { return { ...standby(), fixtureFamily: "DC-F-WORK", barriers: ["worker.claimed", "worker.effect-complete", "worker.before-commit"], workKinds: ["PORT_CALL_EXPIRY", "CLEARANCE", "STANDBY_PROMOTION"] }; }
  function event() { return { ...work(), fixtureFamily: "DC-F-EVENT", eventTypes: ["port-call.held", "port-call.cleared", "port-call.started", "port-call.completed", "port-call.cancelled", "port-call.expired", "standby.created", "standby.promoted"] }; }
  function linked() { return { ...work(), fixtureFamily: "DC-F-LINKED", linkedPayload, movementTypes: ["ARRIVAL", "DEPARTURE"] }; }
  function migration() { return { ...event(), fixtureFamily: "DC-F-MIGRATION", savedReplayKey: key("v1-saved-replay"), states: ["HELD", "CLEARED", "IN_SERVICE", "COMPLETED", "CANCELLED", "EXPIRED"] }; }
  function browser() { return { ...linked(), fixtureFamily: "DC-F-BROWSER" }; }
  function performance() { return { ...resourceGrid(), fixtureFamily: "DC-F-PERF-V1", scenarioIds: ["feasible-window-read", "port-call-create", "clearance-recovery"] }; }

  return Object.freeze({ uuid, key, at, empty, resourceGrid, portCall, standby, idempotency, work, event, linked, migration, browser, performance });
}

function integerUuid(kind, index) { return `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }
export function createPerformanceSeed(version = "perf-v1") {
  const startAt = "2040-01-01T00:00:00.000Z"; const endAt = "2041-01-01T00:00:00.000Z";
  const berths = Array.from({ length: 1_000 }, (_, index) => ({ berthId: integerUuid(1, index + 1), name: `Berth ${index + 1}`, priority: index + 1, maxLengthMeters: 500, availability: [{ startAt, endAt }] }));
  const tugPools = Array.from({ length: 20 }, (_, index) => ({ tugPoolId: integerUuid(2, index + 1), name: `Tug Pool ${index + 1}`, priority: index + 1, capacity: 100_000, availability: [{ startAt, endAt }] }));
  const yardWindows = Array.from({ length: 20 }, (_, index) => ({ yardWindowId: integerUuid(3, index + 1), priority: index + 1, capacityUnits: 1_000_000, startAt, endAt }));
  const vessels = Array.from({ length: 100_000 }, (_, index) => ({ vesselId: integerUuid(4, index + 1), name: `Vessel ${index + 1}`, lengthMeters: 200 }));
  const portCalls = Array.from({ length: 51_500 }, (_, index) => { const historical = index < 50_000; const slot = historical ? Math.floor(index / 1_000) : index - 50_000; const start = new Date(Date.parse(startAt) + (historical ? Math.floor(index / 1_000) * 3 * 3_600_000 : (168 + Math.floor(slot / 1_000) * 3) * 3_600_000)); const end = new Date(start.getTime() + 2 * 3_600_000); const berth = berths[index % 1_000]; return { portCallId: integerUuid(5, index + 1), vesselId: vessels[index].vesselId, arrivalAt: start.toISOString(), departureAt: end.toISOString(), requiredTugs: 1, containerUnits: 1, berthId: berth.berthId, tugPoolId: tugPools[index % 20].tugPoolId, yardWindowId: yardWindows[index % 20].yardWindowId, state: historical ? "COMPLETED" : "HELD", expiresAt: historical ? "2040-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", startedAt: historical ? start.toISOString() : null, completedAt: historical ? end.toISOString() : null, sequence: historical ? 4 : 1 }; });
  return { seed: { schemaVersion: 1, seedVersion: version, berths, tugPools, yardWindows, vessels, portCalls, standbyEntries: [] }, berths, tugPools, yardWindows, vessels, portCalls, vesselId: (index) => vessels[index].vesselId };
}
