import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const ACCOUNT_KEYS = ["accountId", "currency", "openingBalanceMinor", "balanceMinor", "reservedMinor", "availableMinor", "revision"];
const TRANSFER_V1_KEYS = ["transferId", "sourceAccountId", "destinationAccountId", "currency", "amountMinor", "state", "postingId", "reversalPostingId", "createdAt", "postedAt", "cancelledAt", "reversedAt", "sequence"];
const TRANSFER_FINAL_KEYS = [...TRANSFER_V1_KEYS, "legs"];
const EVENT_KEYS = ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"];
const WORK_KEYS = ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"];
const STATEMENT_V1_KEYS = ["postingId", "transferId", "kind", "direction", "amountMinor", "balanceAfterMinor", "createdAt"];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function safeSum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("amount must be a positive safe integer");
    if (!Number.isSafeInteger(total + value)) throw new RangeError("amount sum exceeds JSON safe integer range");
    total += value;
  }
  return total;
}

export function assertExactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has non-contract fields`);
}

export function assertUuid(value, label = "uuid") {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, `${label} must be a lowercase UUID`);
}

export function assertTimestamp(value, label = "timestamp") {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, `${label} must have millisecond UTC precision`);
  assert.ok(Number.isFinite(Date.parse(value)), `${label} is invalid`);
}

function expected(value, fields) {
  for (const [key, wanted] of Object.entries(fields)) assert.deepEqual(value[key], wanted, `${key} differs`);
}

export function assertAccount(value, fields = {}) {
  assertExactKeys(value, ACCOUNT_KEYS, "Account");
  assertUuid(value.accountId, "accountId");
  assert.match(value.currency, /^[A-Z]{3}$/u);
  for (const key of ["openingBalanceMinor", "balanceMinor", "reservedMinor", "availableMinor", "revision"]) assert.ok(Number.isSafeInteger(value[key]), `${key} must be safe integer`);
  assert.equal(value.availableMinor, value.balanceMinor - value.reservedMinor);
  assert.ok(value.balanceMinor >= 0 && value.reservedMinor >= 0 && value.availableMinor >= 0);
  expected(value, fields);
}

export function assertTransfer(value, options = {}) {
  assertExactKeys(value, options.final === false ? TRANSFER_V1_KEYS : TRANSFER_FINAL_KEYS, "Transfer");
  for (const key of ["transferId", "sourceAccountId"]) assertUuid(value[key], key);
  if (value.destinationAccountId !== null) assertUuid(value.destinationAccountId, "destinationAccountId");
  assert.match(value.currency, /^[A-Z]{3}$/u);
  assert.ok(["PENDING", "POSTED", "CANCELLED", "REVERSED"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 1);
  assertTimestamp(value.createdAt, "createdAt");
  if (options.final !== false) {
    assert.ok(Array.isArray(value.legs) && value.legs.length >= 1 && value.legs.length <= 20);
    value.legs.forEach((leg) => {
      assertExactKeys(leg, ["legId", "destinationAccountId", "amountMinor", "postingLegId"], "TransferLeg");
      assertUuid(leg.legId, "legId");
      assertUuid(leg.destinationAccountId, "leg destination");
      assert.ok(Number.isSafeInteger(leg.amountMinor) && leg.amountMinor > 0);
      if (leg.postingLegId !== null) assertUuid(leg.postingLegId, "postingLegId");
    });
    const total = safeSum(value.legs.map(({ amountMinor }) => amountMinor));
    if (value.legs.length === 1) {
      assert.equal(value.destinationAccountId, value.legs[0].destinationAccountId);
      assert.equal(value.amountMinor, total);
    } else {
      assert.equal(value.destinationAccountId, null);
      assert.equal(value.amountMinor, null);
    }
  }
  expected(value, options.expected ?? {});
}

export function assertPosting(value, { multi = false, expected: fields = {} } = {}) {
  assertExactKeys(value, ["postingId", "transferId", "kind", "legs", "createdAt"], "Posting");
  assertUuid(value.postingId, "postingId");
  assertUuid(value.transferId, "posting transferId");
  assert.ok(["TRANSFER", "REVERSAL"].includes(value.kind));
  assertTimestamp(value.createdAt, "posting createdAt");
  assert.ok(Array.isArray(value.legs));
  for (const leg of value.legs) {
    assertExactKeys(leg, multi ? ["postingLegId", "legId", "accountId", "direction", "amountMinor"] : ["accountId", "direction", "amountMinor"], "Posting leg");
    assertUuid(leg.accountId, "posting accountId");
    assert.ok(["DEBIT", "CREDIT"].includes(leg.direction));
    assert.ok(Number.isSafeInteger(leg.amountMinor) && leg.amountMinor > 0);
    if (multi) {
      assertUuid(leg.postingLegId, "postingLegId");
      if (leg.legId !== null) assertUuid(leg.legId, "posting legId");
    }
  }
  const signed = value.legs.reduce((sum, leg) => sum + (leg.direction === "CREDIT" ? leg.amountMinor : -leg.amountMinor), 0);
  assert.equal(signed, 0, "Posting must balance");
  expected(value, fields);
}

export function assertStatementPage(value) {
  assertExactKeys(value, ["items", "nextCursor"], "StatementPage");
  assert.ok(value.nextCursor === null || typeof value.nextCursor === "string");
  for (const item of value.items) {
    assertExactKeys(item, [...STATEMENT_V1_KEYS, "legId"], "Statement item");
    assertUuid(item.postingId, "statement postingId");
    assertUuid(item.transferId, "statement transferId");
    if (item.legId !== null) assertUuid(item.legId, "statement legId");
    assertTimestamp(item.createdAt, "statement createdAt");
    assert.ok(Number.isSafeInteger(item.balanceAfterMinor));
  }
  const ordered = [...value.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || compareUtf8(a.postingId, b.postingId));
  assert.deepEqual(value.items, ordered, "Statement items are not in public order");
}

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status);
  assertExactKeys(response.json, ["error"], "error response");
  assertExactKeys(response.json.error, ["code", "message", "details"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.deepEqual(typeof response.json.error.details, "object");
}

export function assertEvent(value, fields = {}) {
  assertExactKeys(value, EVENT_KEYS, "Domain Event");
  assertUuid(value.eventId, "eventId");
  assertUuid(value.aggregateId, "event aggregateId");
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.ok(["transfer.created", "transfer.posted", "transfer.cancelled", "transfer.reversed"].includes(value.type));
  assertTimestamp(value.occurredAt, "event occurredAt");
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.payload, {});
  expected(value, fields);
}

export function assertWork(value, fields = {}) {
  assertExactKeys(value, WORK_KEYS, "Work");
  assertUuid(value.workId, "workId");
  assertUuid(value.aggregateId, "work aggregateId");
  assert.equal(value.kind, "SETTLEMENT");
  assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state));
  assert.equal(value.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state));
  assert.equal(value.state === "LEASED", value.leaseOwner !== null && value.leaseExpiresAt !== null);
  expected(value, fields);
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

export function percentile(values, fraction) {
  assert.ok(values.length > 0 && fraction >= 0 && fraction <= 1);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export class ReferenceLedger {
  constructor(accounts, ids, startAt = "2035-06-01T12:00:00.000Z") {
    this.ids = ids;
    this.clock = Date.parse(startAt);
    this.accounts = new Map(accounts.map((item) => [item.accountId, { ...item, balanceMinor: item.openingBalanceMinor, reservedMinor: 0, revision: 0 }]));
    this.transfers = new Map();
    this.postings = [];
    this.statements = new Map(accounts.map(({ accountId }) => [accountId, []]));
    this.events = [];
    this.ordinal = 0;
  }

  now() { this.clock += 1; return new Date(this.clock).toISOString(); }
  id(label) { this.ordinal += 1; return this.ids(`${label}:${this.ordinal}`); }

  create(body) {
    const source = this.accounts.get(body.sourceAccountId);
    assert.ok(source, "source account missing");
    const rawLegs = body.legs ?? [{ destinationAccountId: body.destinationAccountId, amountMinor: body.amountMinor }];
    assert.ok(rawLegs.length >= 1 && rawLegs.length <= 20);
    const total = safeSum(rawLegs.map(({ amountMinor }) => amountMinor));
    assert.equal(new Set(rawLegs.map(({ destinationAccountId }) => destinationAccountId)).size, rawLegs.length);
    for (const leg of rawLegs) {
      const destination = this.accounts.get(leg.destinationAccountId);
      assert.ok(destination && destination.accountId !== source.accountId && destination.currency === body.currency);
    }
    assert.equal(source.currency, body.currency);
    assert.ok(source.balanceMinor - source.reservedMinor >= total);
    const multi = body.legs !== undefined && rawLegs.length > 1;
    const transfer = {
      transferId: this.id("transfer"), sourceAccountId: source.accountId,
      destinationAccountId: multi ? null : rawLegs[0].destinationAccountId,
      currency: body.currency, amountMinor: multi ? null : total,
      state: "PENDING", postingId: null, reversalPostingId: null, createdAt: this.now(),
      postedAt: null, cancelledAt: null, reversedAt: null, sequence: 1,
      legs: rawLegs.map((leg) => ({ legId: this.id("leg"), ...leg, postingLegId: null })),
    };
    source.reservedMinor += total; source.revision += 1;
    this.transfers.set(transfer.transferId, transfer);
    this.event(transfer, "transfer.created");
    return structuredClone(transfer);
  }

  cancel(transferId) {
    const transfer = this.transfers.get(transferId); assert.equal(transfer?.state, "PENDING");
    const source = this.accounts.get(transfer.sourceAccountId);
    source.reservedMinor -= safeSum(transfer.legs.map(({ amountMinor }) => amountMinor)); source.revision += 1;
    transfer.state = "CANCELLED"; transfer.cancelledAt = this.now(); transfer.sequence += 1;
    this.event(transfer, "transfer.cancelled");
    return structuredClone(transfer);
  }

  settle(transferId) {
    const transfer = this.transfers.get(transferId); assert.equal(transfer?.state, "PENDING");
    const total = safeSum(transfer.legs.map(({ amountMinor }) => amountMinor));
    const multi = transfer.legs.length > 1;
    const source = this.accounts.get(transfer.sourceAccountId);
    const legs = multi
      ? [{ postingLegId: this.id("posting-leg"), legId: null, accountId: source.accountId, direction: "DEBIT", amountMinor: total }, ...transfer.legs.map((leg) => ({ postingLegId: this.id("posting-leg"), legId: leg.legId, accountId: leg.destinationAccountId, direction: "CREDIT", amountMinor: leg.amountMinor }))]
      : [{ accountId: source.accountId, direction: "DEBIT", amountMinor: total }, { accountId: transfer.legs[0].destinationAccountId, direction: "CREDIT", amountMinor: total }];
    const posting = this.applyPosting(transfer, "TRANSFER", legs);
    source.reservedMinor -= total;
    transfer.state = "POSTED"; transfer.postingId = posting.postingId; transfer.postedAt = posting.createdAt; transfer.sequence += 1;
    if (multi) transfer.legs.forEach((leg, index) => { leg.postingLegId = posting.legs[index + 1].postingLegId; });
    this.event(transfer, "transfer.posted");
    return structuredClone(posting);
  }

  reverse(transferId) {
    const transfer = this.transfers.get(transferId); assert.equal(transfer?.state, "POSTED");
    const total = safeSum(transfer.legs.map(({ amountMinor }) => amountMinor));
    const multi = transfer.legs.length > 1;
    const legs = multi
      ? [...transfer.legs.map((leg) => ({ postingLegId: this.id("posting-leg"), legId: leg.legId, accountId: leg.destinationAccountId, direction: "DEBIT", amountMinor: leg.amountMinor })), { postingLegId: this.id("posting-leg"), legId: null, accountId: transfer.sourceAccountId, direction: "CREDIT", amountMinor: total }]
      : [{ accountId: transfer.legs[0].destinationAccountId, direction: "DEBIT", amountMinor: total }, { accountId: transfer.sourceAccountId, direction: "CREDIT", amountMinor: total }];
    const posting = this.applyPosting(transfer, "REVERSAL", legs);
    transfer.state = "REVERSED"; transfer.reversalPostingId = posting.postingId; transfer.reversedAt = posting.createdAt; transfer.sequence += 1;
    this.event(transfer, "transfer.reversed");
    return structuredClone(posting);
  }

  applyPosting(transfer, kind, legs) {
    const posting = { postingId: this.id("posting"), transferId: transfer.transferId, kind, legs, createdAt: this.now() };
    for (const leg of legs) {
      const account = this.accounts.get(leg.accountId);
      account.balanceMinor += leg.direction === "CREDIT" ? leg.amountMinor : -leg.amountMinor;
      account.revision += 1;
      this.statements.get(leg.accountId).push({
        postingId: posting.postingId, transferId: transfer.transferId, kind, legId: Object.hasOwn(leg, "legId") ? leg.legId : transfer.legs[0].legId,
        direction: leg.direction, amountMinor: leg.amountMinor, balanceAfterMinor: account.balanceMinor, createdAt: posting.createdAt,
      });
    }
    this.postings.push(posting); return posting;
  }

  event(transfer, type) {
    this.events.push({ eventId: this.id("event"), aggregateId: transfer.transferId, sequence: transfer.sequence, type, occurredAt: this.now(), schemaVersion: 1, payload: {} });
  }

  account(accountId) { const value = this.accounts.get(accountId); return { ...value, availableMinor: value.balanceMinor - value.reservedMinor }; }
  transfer(transferId) { return structuredClone(this.transfers.get(transferId)); }
}

export function reconcileSnapshot(snapshot, options = {}) {
  assertExactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot");
  assertTimestamp(snapshot.asOf, "snapshot asOf");
  assertExactKeys(snapshot.resources, ["accounts", "transfers", "postings"], "snapshot resources");
  snapshot.resources.accounts.forEach((account) => assertAccount(account));
  snapshot.resources.transfers.forEach((transfer) => assertTransfer(transfer, { final: options.final !== false }));
  const transferById = new Map(snapshot.resources.transfers.map((item) => [item.transferId, item]));
  snapshot.resources.postings.forEach((posting) => assertPosting(posting, { multi: (transferById.get(posting.transferId)?.legs?.length ?? 1) > 1 }));
  snapshot.work.forEach((work) => assertWork(work));
  snapshot.events.forEach((event) => assertEvent(event));
  const totals = new Map();
  for (const account of snapshot.resources.accounts) totals.set(account.currency, (totals.get(account.currency) ?? 0) + account.balanceMinor);
  const openings = new Map();
  for (const account of snapshot.resources.accounts) openings.set(account.currency, (openings.get(account.currency) ?? 0) + account.openingBalanceMinor);
  assert.deepEqual(totals, openings, "currency totals changed");
  for (const account of snapshot.resources.accounts) {
    const reserved = snapshot.resources.transfers.filter((transfer) => transfer.state === "PENDING" && transfer.sourceAccountId === account.accountId)
      .reduce((sum, transfer) => sum + (transfer.amountMinor ?? safeSum(transfer.legs.map(({ amountMinor }) => amountMinor))), 0);
    assert.equal(account.reservedMinor, reserved, `reservation mismatch for ${account.accountId}`);
  }
  assert.equal(canonical(snapshot).includes("Token"), false, "snapshot leaked a token field");
  return { totals, accountCount: snapshot.resources.accounts.length, transferCount: snapshot.resources.transfers.length };
}
