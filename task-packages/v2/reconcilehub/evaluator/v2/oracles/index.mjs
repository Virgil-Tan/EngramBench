import assert from "node:assert/strict";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("ReconcileHub canonical JSON accepts safe integers only");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is outside RFC 8785 domain");
}

export function dateDistanceDays(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00.000Z`);
  const rightTime = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) throw new TypeError("invalid strict date");
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function bytes(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }

export function rankOneToOne(statementLines, ledgerEntries) {
  const unused = new Set(ledgerEntries.filter(({ state }) => state === "UNMATCHED").map(({ ledgerEntryId }) => ledgerEntryId));
  const result = [];
  const lines = statementLines.filter(({ state }) => state === "UNMATCHED").sort((left, right) => bytes(left.bookedAt, right.bookedAt) || bytes(left.externalId, right.externalId) || bytes(left.statementLineId, right.statementLineId));
  for (const line of lines) {
    const candidates = ledgerEntries.filter((entry) => unused.has(entry.ledgerEntryId)
      && entry.currency === line.currency && entry.amountMinor === line.amountMinor
      && dateDistanceDays(line.bookedAt, entry.postedAt) <= 3)
      .map((entry) => ({
        ...entry,
        score: 1000 - dateDistanceDays(line.bookedAt, entry.postedAt) * 100 + (line.reference === entry.reference ? 50 : 0),
      }))
      .sort((left, right) => right.score - left.score || bytes(left.postedAt, right.postedAt) || bytes(left.ledgerEntryId, right.ledgerEntryId));
    if (candidates.length === 0) continue;
    const winner = candidates[0];
    unused.delete(winner.ledgerEntryId);
    result.push({
      statementLineId: line.statementLineId,
      ledgerEntryId: winner.ledgerEntryId,
      score: winner.score,
      reasons: ["AMOUNT_AND_CURRENCY", `DATE_DISTANCE_${dateDistanceDays(line.bookedAt, winner.postedAt)}`, ...(line.reference === winner.reference ? ["REFERENCE_EXACT"] : [])],
    });
  }
  return result;
}

export function validateMatchGroup(statementLines, ledgerEntries) {
  if (statementLines.length < 1 || statementLines.length > 20 || ledgerEntries.length < 1 || ledgerEntries.length > 20) throw new Error("group member count must be 1..20 per side");
  const statementLineIds = statementLines.map(({ statementLineId }) => statementLineId);
  const ledgerEntryIds = ledgerEntries.map(({ ledgerEntryId }) => ledgerEntryId);
  if (new Set(statementLineIds).size !== statementLineIds.length || new Set(ledgerEntryIds).size !== ledgerEntryIds.length) throw new Error("duplicate group member");
  if (statementLines.some(({ state }) => state !== "UNMATCHED") || ledgerEntries.some(({ state }) => state !== "UNMATCHED")) throw new Error("group member is not available");
  const currencies = new Set([...statementLines, ...ledgerEntries].map(({ currency }) => currency));
  if (currencies.size !== 1) throw new Error("group currency differs");
  const statementTotalMinor = statementLines.reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  const ledgerTotalMinor = ledgerEntries.reduce((sum, { amountMinor }) => sum + amountMinor, 0);
  if (!Number.isSafeInteger(statementTotalMinor) || !Number.isSafeInteger(ledgerTotalMinor) || statementTotalMinor !== ledgerTotalMinor) throw new Error("group integer sum is imbalanced");
  return {
    statementLineIds: [...statementLineIds].sort(bytes),
    ledgerEntryIds: [...ledgerEntryIds].sort(bytes),
    currency: [...currencies][0],
    statementTotalMinor,
    ledgerTotalMinor,
  };
}

export function foldMatchActions(initialState, actions) {
  let state = initialState;
  let releaseCount = 0;
  let previousSequence = 0;
  const sequences = [];
  for (const action of actions) {
    if (!Number.isSafeInteger(action.sequence) || action.sequence !== previousSequence + 1) throw new Error("illegal action sequence");
    if (action.type === "CONFIRM" && state === "PROPOSED") state = "CONFIRMED";
    else if (action.type === "REJECT" && state === "PROPOSED") state = "REJECTED";
    else if (action.type === "REVERSE" && state === "CONFIRMED") { state = "REVERSED"; releaseCount += 1; }
    else throw new Error(`illegal ${action.type} from ${state}`);
    previousSequence = action.sequence;
    sequences.push(action.sequence);
  }
  return { state, releaseCount, sequences };
}

function choose(values, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) { output.push(prefix); return output; }
  for (let index = start; index <= values.length - (size - prefix.length); index += 1) choose(values, size, index + 1, [...prefix, values[index]], output);
  return output;
}

export function enumerateGroupSuggestions(statementLines, ledgerEntries, oneToOne = rankOneToOne(statementLines, ledgerEntries)) {
  const usedLines = new Set(oneToOne.map(({ statementLineId }) => statementLineId));
  const usedEntries = new Set(oneToOne.map(({ ledgerEntryId }) => ledgerEntryId));
  const lines = statementLines.filter((item) => item.state === "UNMATCHED" && !usedLines.has(item.statementLineId)).sort((left, right) => bytes(left.bookedAt, right.bookedAt) || bytes(left.statementLineId, right.statementLineId));
  const entries = ledgerEntries.filter((item) => item.state === "UNMATCHED" && !usedEntries.has(item.ledgerEntryId)).sort((left, right) => bytes(left.postedAt, right.postedAt) || bytes(left.ledgerEntryId, right.ledgerEntryId));
  const groups = [];
  for (let lineCount = 1; lineCount <= Math.min(3, lines.length); lineCount += 1) {
    for (let entryCount = 1; entryCount <= Math.min(3, entries.length); entryCount += 1) {
      if (lineCount + entryCount < 3 || lineCount + entryCount > 4) continue;
      for (const selectedLines of choose(lines, lineCount)) for (const selectedEntries of choose(entries, entryCount)) {
        try { groups.push(validateMatchGroup(selectedLines, selectedEntries)); } catch {}
      }
    }
  }
  return groups.sort((left, right) => bytes(left.statementLineIds.join("\0"), right.statementLineIds.join("\0")) || bytes(left.ledgerEntryIds.join("\0"), right.ledgerEntryIds.join("\0")));
}

export function assertEventLedger(events) {
  const identities = new Map();
  const byAggregate = new Map();
  for (const event of events) {
    const semantic = canonicalJson(event);
    if (identities.has(event.eventId) && identities.get(event.eventId) !== semantic) throw new Error(`event ${event.eventId} changed`);
    identities.set(event.eventId, semantic);
    const sequences = byAggregate.get(event.aggregateId) ?? [];
    sequences.push(event.sequence);
    byAggregate.set(event.aggregateId, sequences);
  }
  for (const [aggregateId, sequences] of byAggregate) {
    const unique = [...new Set(sequences)].sort((left, right) => left - right);
    assert.deepEqual(unique, Array.from({ length: unique.at(-1) ?? 0 }, (_, index) => index + 1), `event sequence for ${aggregateId}`);
  }
  return { uniqueEvents: identities.size, aggregates: byAggregate.size };
}

export function assertOwnershipAndConservation(snapshot) {
  const resources = snapshot.resources ?? {};
  const lines = new Map((resources.statementLines ?? []).map((item) => [item.statementLineId, item]));
  const entries = new Map((resources.ledgerEntries ?? []).map((item) => [item.ledgerEntryId, item]));
  const lineOwners = new Map();
  const entryOwners = new Map();
  const activeGroups = resources.matchGroups?.filter(({ state }) => state === "CONFIRMED")
    ?? (resources.matches ?? []).filter(({ state }) => state === "CONFIRMED").map((match) => ({ matchGroupId: match.matchId, statementLineIds: [match.statementLineId], ledgerEntryIds: [match.ledgerEntryId], currency: lines.get(match.statementLineId)?.currency, statementTotalMinor: lines.get(match.statementLineId)?.amountMinor, ledgerTotalMinor: entries.get(match.ledgerEntryId)?.amountMinor }));
  for (const group of activeGroups) {
    const selectedLines = group.statementLineIds.map((id) => lines.get(id));
    const selectedEntries = group.ledgerEntryIds.map((id) => entries.get(id));
    if (selectedLines.some((item) => !item) || selectedEntries.some((item) => !item)) throw new Error("active group references a missing member");
    const checked = validateMatchGroup(selectedLines.map((item) => ({ ...item, state: "UNMATCHED" })), selectedEntries.map((item) => ({ ...item, state: "UNMATCHED" })));
    if (checked.currency !== group.currency || checked.statementTotalMinor !== group.statementTotalMinor || checked.ledgerTotalMinor !== group.ledgerTotalMinor) throw new Error("active group totals differ from members");
    for (const id of group.statementLineIds) { if (lineOwners.has(id)) throw new Error(`Statement Line ${id} has two active owners`); lineOwners.set(id, group.matchGroupId); }
    for (const id of group.ledgerEntryIds) { if (entryOwners.has(id)) throw new Error(`Ledger Entry ${id} has two active owners`); entryOwners.set(id, group.matchGroupId); }
  }
  return { activeGroups: activeGroups.length, ownedStatementLines: lineOwners.size, ownedLedgerEntries: entryOwners.size };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0 || fraction < 0 || fraction > 1) throw new TypeError("invalid percentile input");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}
