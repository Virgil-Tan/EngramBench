import { createHash } from "node:crypto";

function invariant(condition, message) { if (!condition) throw new Error(message); }
function bytewise(left, right) { return Buffer.from(left).compare(Buffer.from(right)); }

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "canonical JSON rejects non-finite money");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  invariant(value && typeof value === "object", "canonical JSON rejects unsupported values");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256(value) { return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }

export function safeMoney(value, label = "money") {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a safe non-negative integer`);
  return value;
}

export function selectEffectiveVersion(versions, instant) {
  invariant(Array.isArray(versions), "versions must be an array");
  const target = Date.parse(instant);
  invariant(Number.isFinite(target), "effective instant is invalid");
  const ordered = versions.toSorted((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom) || left.version - right.version);
  for (const [index, version] of ordered.entries()) {
    const start = Date.parse(version.effectiveFrom);
    const end = version.effectiveTo === null ? Infinity : Date.parse(version.effectiveTo);
    invariant(Number.isFinite(start) && (end === Infinity || Number.isFinite(end)) && start < end, "effective interval is invalid");
    if (index > 0) {
      const previousEnd = ordered[index - 1].effectiveTo === null ? Infinity : Date.parse(ordered[index - 1].effectiveTo);
      invariant(previousEnd <= start, "effective versions overlap");
    }
  }
  const matches = ordered.filter((version) => Date.parse(version.effectiveFrom) <= target && (version.effectiveTo === null || target < Date.parse(version.effectiveTo)));
  invariant(matches.length === 1, "effective version selection is not unique");
  return structuredClone(matches[0]);
}

export function effectiveBalance(invoice) {
  const total = safeMoney(invoice.totalMinor, "Invoice total");
  const paid = safeMoney(invoice.paidMinor, "Invoice paid");
  const refunded = safeMoney(invoice.refundedMinor, "Invoice refunded");
  const value = total - paid + refunded;
  return safeMoney(value, "Invoice effective balance");
}

export function assertInvoiceArithmetic(invoice) {
  invariant(Array.isArray(invoice.lines), "Invoice lines must be an array");
  let total = 0;
  for (const line of invoice.lines) {
    safeMoney(line.unitAmountMinor, "InvoiceLine unit amount");
    safeMoney(line.amountMinor, "InvoiceLine amount");
    invariant(Number.isSafeInteger(line.quantity), "InvoiceLine quantity must be a safe integer");
    total += line.amountMinor;
    invariant(Number.isSafeInteger(total), "Invoice line sum overflow");
  }
  invariant(total === invoice.totalMinor, "Invoice total does not equal its lines");
  invariant(effectiveBalance(invoice) === invoice.outstandingMinor, "Invoice outstanding balance is inconsistent");
  return true;
}

export function balancePostings(entries) {
  invariant(Array.isArray(entries), "Ledger entries must be an array");
  const groups = new Map();
  for (const entry of entries) {
    safeMoney(entry.amountMinor, "LedgerEntry amount");
    invariant(entry.direction === "DEBIT" || entry.direction === "CREDIT", "LedgerEntry direction is invalid");
    const group = groups.get(entry.postingId) ?? { currencies: new Set(), debitMinor: 0, creditMinor: 0 };
    group.currencies.add(entry.currency);
    group[entry.direction === "DEBIT" ? "debitMinor" : "creditMinor"] += entry.amountMinor;
    invariant(Number.isSafeInteger(group.debitMinor) && Number.isSafeInteger(group.creditMinor), "Posting amount overflow");
    groups.set(entry.postingId, group);
  }
  return [...groups].map(([postingId, group]) => {
    invariant(group.currencies.size === 1, `Posting ${postingId} mixes currencies`);
    invariant(group.debitMinor === group.creditMinor, `Posting ${postingId} is unbalanced`);
    return { postingId, currency: [...group.currencies][0], debitMinor: group.debitMinor, creditMinor: group.creditMinor };
  }).sort((left, right) => bytewise(left.postingId, right.postingId));
}

export function refundableMinor(paymentIntent, refunds) {
  const captured = paymentIntent.state === "SUCCEEDED" ? safeMoney(paymentIntent.amountMinor, "captured amount") : 0;
  const succeeded = refunds.filter(({ state }) => state === "SUCCEEDED").reduce((sum, refund) => {
    const value = sum + safeMoney(refund.amountMinor, "Refund amount");
    invariant(Number.isSafeInteger(value), "Refund sum overflow");
    return value;
  }, 0);
  invariant(succeeded <= captured, "successful refunds exceed captured amount");
  return captured - succeeded;
}

export function assertFrozen(before, after, label = "resource") {
  invariant(canonical(before) === canonical(after), `${label} was rewritten`);
  return true;
}
