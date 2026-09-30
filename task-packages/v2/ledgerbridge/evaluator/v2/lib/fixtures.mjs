import { createHash } from "node:crypto";

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

function digest(seed, label) {
  return createHash("sha256").update(`${seed}\0${label}`).digest("hex");
}

function uuidFrom(hex) {
  const value = `${hex.slice(0, 12)}4${hex.slice(13, 16)}a${hex.slice(17, 20)}${hex.slice(20, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const seed = `${evaluationSeed}\0${caseId}`;
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  return Object.freeze({
    uuid: (label) => uuidFrom(digest(seed, `uuid:${label}`)),
    key: (label) => `lb-${String(label).replace(/[^a-z0-9-]/giu, "-").slice(0, 72)}-${digest(seed, `key:${label}`).slice(0, 24)}`,
    at: ({ milliseconds = 0, seconds = 0 } = {}) => new Date(epoch + milliseconds + seconds * 1_000).toISOString(),
    seed,
  });
}

export function accountFixture(fixtures, label, openingBalanceMinor, currency = "USD") {
  if (!Number.isSafeInteger(openingBalanceMinor) || openingBalanceMinor < 0) throw new TypeError("opening balance must be a non-negative safe integer");
  return { accountId: fixtures.uuid(`account:${label}`), currency, openingBalanceMinor };
}

export function accountCatalog(fixtures, options = {}) {
  const sourceBalance = options.sourceBalance ?? 1_000;
  return Object.freeze({
    source: accountFixture(fixtures, "source", sourceBalance),
    source2: accountFixture(fixtures, "source-2", sourceBalance),
    destinations: Array.from({ length: options.destinationCount ?? 20 }, (_, index) => accountFixture(fixtures, `destination-${index + 1}`, 0)),
    euro: accountFixture(fixtures, "euro", 500, "EUR"),
    empty: accountFixture(fixtures, "empty", 0),
    maximum: accountFixture(fixtures, "maximum", SAFE_MAX),
  });
}

export function legacyTransferBody(catalog, amountMinor = 100, overrides = {}) {
  return {
    sourceAccountId: catalog.source.accountId,
    destinationAccountId: catalog.destinations[0].accountId,
    currency: "USD",
    amountMinor,
    ...overrides,
  };
}

export function multiTransferBody(catalog, amounts = [30, 20, 10], overrides = {}) {
  return {
    sourceAccountId: catalog.source.accountId,
    currency: "USD",
    legs: amounts.map((amountMinor, index) => ({
      destinationAccountId: catalog.destinations[index].accountId,
      amountMinor,
    })),
    ...overrides,
  };
}

export function ledgerSeed(fixtures, seedVersion = "ledger-v1", options = {}) {
  const catalog = options.catalog ?? accountCatalog(fixtures, options);
  const accounts = options.accounts ?? [catalog.source, catalog.source2, ...catalog.destinations, catalog.euro, catalog.empty, catalog.maximum];
  return {
    schemaVersion: 1,
    seedVersion,
    accounts: accounts.map(({ accountId, currency, openingBalanceMinor }) => ({ accountId, currency, openingBalanceMinor })),
    transfers: options.transfers ?? [],
  };
}

export function seededTransfer(fixtures, catalog, label, state, options = {}) {
  return {
    transferId: fixtures.uuid(`seed-transfer:${label}`),
    sourceAccountId: options.sourceAccountId ?? catalog.source.accountId,
    destinationAccountId: options.destinationAccountId ?? catalog.destinations[0].accountId,
    currency: options.currency ?? "USD",
    amountMinor: options.amountMinor ?? 1,
    state,
    createdAt: options.createdAt ?? fixtures.at({ seconds: options.seconds ?? 0 }),
    terminalAt: options.terminalAt ?? (state === "PENDING" ? null : fixtures.at({ seconds: (options.seconds ?? 0) + 1 })),
  };
}

export function workedExample(fixtures) {
  const catalog = accountCatalog(fixtures, { sourceBalance: 100, destinationCount: 3 });
  return {
    catalog,
    body: multiTransferBody(catalog, [30, 20, 10]),
    total: 60,
    sourceAfterCreate: { balanceMinor: 100, reservedMinor: 60, availableMinor: 40 },
    transferOrder: ["DEBIT", "CREDIT", "CREDIT", "CREDIT"],
    reversalOrder: ["DEBIT", "DEBIT", "DEBIT", "CREDIT"],
  };
}

export function performanceContract(scale = 1) {
  if (!(scale > 0 && scale <= 1)) throw new TypeError("performance scale must be in (0,1]");
  const duration = (seconds) => Math.max(1, Math.round(seconds * scale));
  return Object.freeze({
    statementRead: { concurrency: 64, warmupSeconds: duration(10), measureSeconds: duration(60), targetPerSecond: 150, p95Ms: 150, limit: 50 },
    mutationMix: { concurrency: 64, warmupSeconds: duration(10), measureSeconds: duration(60), targetPerSecond: 40, p95Ms: 500, order: ["CREATE", "CREATE", "CANCEL", "REVERSE"] },
    settlementRecovery: { concurrency: 2, transferCount: Math.max(2, Math.round(2_000 * scale)), maximumSeconds: scale === 1 ? 45 : Math.max(5, Math.round(45 * scale)) },
    seed: { seedVersion: "perf-v1", accountCount: Math.max(20, Math.round(20_000 * scale)), postedCount: Math.max(10, Math.round(100_000 * scale)), pendingCount: Math.max(2, Math.round(2_000 * scale)) },
  });
}

export function performanceSeed(fixtures, scale = 1) {
  const contract = performanceContract(scale).seed;
  const accounts = Array.from({ length: contract.accountCount }, (_, index) => ({
    accountId: fixtures.uuid(`perf-account:${String(index).padStart(5, "0")}`),
    currency: "USD",
    openingBalanceMinor: 1_000_000,
  }));
  const transfers = [];
  for (let index = 0; index < contract.postedCount; index += 1) {
    const sourceIndex = index % accounts.length;
    transfers.push({
      transferId: fixtures.uuid(`perf-posted:${String(index).padStart(6, "0")}`),
      sourceAccountId: accounts[sourceIndex].accountId,
      destinationAccountId: accounts[(sourceIndex + 1) % accounts.length].accountId,
      currency: "USD",
      amountMinor: 1,
      state: "POSTED",
      createdAt: fixtures.at({ milliseconds: index }),
      terminalAt: fixtures.at({ milliseconds: index + 1 }),
    });
  }
  for (let index = 0; index < contract.pendingCount; index += 1) {
    const sourceIndex = index % accounts.length;
    transfers.push({
      transferId: fixtures.uuid(`perf-pending:${String(index).padStart(4, "0")}`),
      sourceAccountId: accounts[sourceIndex].accountId,
      destinationAccountId: accounts[(sourceIndex + Math.floor(accounts.length / 2)) % accounts.length].accountId,
      currency: "USD",
      amountMinor: 1,
      state: "PENDING",
      createdAt: fixtures.at({ milliseconds: contract.postedCount + index }),
      terminalAt: null,
    });
  }
  return { schemaVersion: 1, seedVersion: "perf-v1", accounts, transfers };
}

export { SAFE_MAX };
