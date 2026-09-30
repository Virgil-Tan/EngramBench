import { createHash } from "node:crypto";

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
}

function offsetMilliseconds(offset = {}) {
  if (typeof offset === "number") return offset * 1_000;
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMilliseconds(offset)).toISOString(); },
    time(seconds = 0) { return new Date(epoch + seconds * 1_000).toISOString(); },
    date(offsetDays = 0) { return new Date(epoch + offsetDays * 86_400_000).toISOString().slice(0, 10); },
    key(label) { return `rh-${slug(caseId)}-${slug(label)}-${digest(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    sha(label) { return digest(namespace, "sha", label).toString("hex"); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (digest(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

function seedLine(fixtures, batchId, label, options = {}) {
  return {
    statementLineId: fixtures.uuid(`line-${label}`),
    externalId: options.externalId ?? `external-${label}`,
    bookedAt: options.bookedAt ?? fixtures.date(options.day ?? 0),
    currency: options.currency ?? "USD",
    amountMinor: options.amountMinor ?? 10_000 + Number(label),
    reference: options.reference ?? `REF-${label}`,
    state: options.state ?? "UNMATCHED",
    ...(batchId === undefined ? {} : { batchId }),
    ...(options.includeRevision === false ? {} : { revision: options.revision ?? 1 }),
  };
}

function ledgerEntry(fixtures, label, options = {}) {
  return {
    ledgerEntryId: fixtures.uuid(`ledger-${label}`),
    postedAt: options.postedAt ?? fixtures.date(options.day ?? 0),
    currency: options.currency ?? "USD",
    amountMinor: options.amountMinor ?? 10_000 + Number(label),
    reference: options.reference ?? `REF-${label}`,
    state: options.state ?? "UNMATCHED",
    revision: options.revision ?? 1,
  };
}

export function reconciliationSeed(fixtures, label = "base", options = {}) {
  const batchId = fixtures.uuid(`batch-${label}`);
  const lineCount = options.lineCount ?? 8;
  const fullLines = Array.from({ length: lineCount }, (_, index) => seedLine(fixtures, batchId, `${label}-${index}`, {
    amountMinor: 20_000 + index,
    day: index % 4,
  }));
  const statementBatches = [{
    batchId,
    source: `source-${label}`,
    batchKey: `batch-${label}`,
    digest: fixtures.sha(`batch-${label}`),
    createdAt: fixtures.at({ minutes: -10 }),
    lines: fullLines.map(({ batchId: _batchId, revision: _revision, ...line }) => line),
  }];
  const ledgerEntries = fullLines.map((line, index) => ledgerEntry(fixtures, `${label}-${index}`, {
    amountMinor: line.amountMinor,
    day: index % 4,
    reference: line.reference,
  }));
  return {
    schemaVersion: 1,
    seedVersion: options.seedVersion ?? `rh-${slug(label)}-${fixtures.sha(`seed-${label}`).slice(0, 12)}`,
    ledgerEntries,
    statementBatches,
    matches: options.matches ?? [],
  };
}

export function workedExample(fixtures) {
  const batchId = fixtures.uuid("worked-batch");
  const statementLine = seedLine(fixtures, batchId, "worked", { amountMinor: 100, bookedAt: "2026-01-10", reference: "ABC" });
  const ledgerEntries = [
    ledgerEntry(fixtures, "worked-exact", { amountMinor: 100, postedAt: "2026-01-10", reference: "ABC" }),
    ledgerEntry(fixtures, "worked-previous", { amountMinor: 100, postedAt: "2026-01-09", reference: "ABC" }),
    ledgerEntry(fixtures, "worked-other-reference", { amountMinor: 100, postedAt: "2026-01-10", reference: "XYZ" }),
    ledgerEntry(fixtures, "worked-outside-window", { amountMinor: 100, postedAt: "2026-01-14", reference: "ABC" }),
  ];
  return { statementLines: [statementLine], ledgerEntries };
}

export function groupFixture(fixtures, options = {}) {
  const batchId = fixtures.uuid(`group-batch-${options.label ?? "base"}`);
  const statementLines = [
    seedLine(fixtures, batchId, `group-${options.label ?? "base"}-line-1`, { amountMinor: 100, bookedAt: "2026-01-10", reference: "GROUP-A" }),
    seedLine(fixtures, batchId, `group-${options.label ?? "base"}-line-2`, { amountMinor: 50, bookedAt: "2026-01-11", reference: "GROUP-B" }),
  ];
  const ledgerEntries = [
    ledgerEntry(fixtures, `group-${options.label ?? "base"}-ledger-1`, { amountMinor: 75, postedAt: "2026-01-10", reference: "GROUP-X" }),
    ledgerEntry(fixtures, `group-${options.label ?? "base"}-ledger-2`, { amountMinor: 75, postedAt: "2026-01-11", reference: "GROUP-Y" }),
  ];
  return { statementLines, ledgerEntries };
}

export function importRequest(fixtures, label = "import", count = 4) {
  return {
    source: `public-${label}`,
    batchKey: `batch-${label}`,
    lines: Array.from({ length: count }, (_, index) => ({
      externalId: `${label}-${String(index).padStart(3, "0")}`,
      bookedAt: fixtures.date(index % 4),
      currency: index % 2 === 0 ? "USD" : "EUR",
      amountMinor: 1_000 + index,
      reference: `REF-${label}-${index}`,
    })),
  };
}

export function performanceContract() {
  return Object.freeze({
    import: { clients: 64, warmupSeconds: 10, measureSeconds: 60, batchesPerSecond: 50, linesPerBatch: 100, p95Ms: 500, warmupBatches: 500, measuredBatches: 3_000 },
    review: { clients: 64, warmupSeconds: 10, measureSeconds: 60, readsPerSecond: 250, p95Ms: 180, limit: 100 },
    suggestion: { workers: 2, seconds: 60, unmatchedLines: 10_000, unmatchedLedgerEntries: 10_000, proposals: 10_000 },
    seed: { ledgerEntries: 20_000, statementBatches: 200, linesPerBatch: 100, confirmedMatches: 10_000 },
  });
}

export function performanceSeed(fixtures) {
  const ledgerEntries = [];
  const statementBatches = [];
  const matches = [];
  for (let batchIndex = 0; batchIndex < 200; batchIndex += 1) {
    const batchId = fixtures.uuid(`perf-batch-${batchIndex}`);
    const lines = [];
    for (let lineIndex = 0; lineIndex < 100; lineIndex += 1) {
      const ordinal = batchIndex * 100 + lineIndex;
      const matched = ordinal < 10_000;
      const currency = ordinal % 2 === 0 ? "USD" : "EUR";
      const amountMinor = ordinal + 1;
      const bookedAt = `2026-01-${String((ordinal % 28) + 1).padStart(2, "0")}`;
      const statementLineId = fixtures.uuid(`perf-line-${ordinal}`);
      const ledgerEntryId = fixtures.uuid(`perf-ledger-${ordinal}`);
      lines.push({
        statementLineId,
        externalId: `perf-${String(ordinal).padStart(5, "0")}`,
        bookedAt,
        currency,
        amountMinor,
        reference: `PERF-${ordinal}`,
        state: matched ? "MATCHED" : "UNMATCHED",
      });
      ledgerEntries.push({
        ledgerEntryId,
        postedAt: bookedAt,
        currency,
        amountMinor,
        reference: `PERF-${ordinal}`,
        state: matched ? "MATCHED" : "UNMATCHED",
        revision: matched ? 2 : 1,
      });
      if (matched) matches.push({
        matchId: fixtures.uuid(`perf-match-${ordinal}`),
        statementLineId,
        ledgerEntryId,
        state: "CONFIRMED",
        score: 1050,
        reasons: ["AMOUNT_AND_CURRENCY", "DATE_DISTANCE_0", "REFERENCE_EXACT"],
        createdAt: fixtures.at({ minutes: ordinal }),
        confirmedAt: fixtures.at({ minutes: ordinal, seconds: 1 }),
        reversedAt: null,
        sequence: 2,
      });
    }
    statementBatches.push({
      batchId,
      source: `perf-source-${batchIndex}`,
      batchKey: `perf-batch-${batchIndex}`,
      digest: fixtures.sha(`perf-batch-${batchIndex}`),
      createdAt: fixtures.at({ minutes: batchIndex }),
      lines,
    });
  }
  return { schemaVersion: 1, seedVersion: "perf-v1", ledgerEntries, statementBatches, matches };
}
