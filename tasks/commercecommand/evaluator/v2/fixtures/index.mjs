import { createHash } from "node:crypto";

function digest(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest();
}

function uuidFrom(bytes) {
  const value = Buffer.from(bytes.subarray(0, 16));
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `commercecommand\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `cc-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ milliseconds = 0, seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) => new Date(
    Date.parse(baseTime) + (((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds,
  ).toISOString();

  const offer = (label, tenantId, productId, version, unitPriceMinor, taxMinor, fulfillmentKind) => ({
    offerVersionId: uuid(`offer:${label}:v${version}`),
    tenantId,
    productId,
    version,
    currency: "USD",
    unitPriceMinor,
    taxMinor,
    fulfillmentKind,
    effectiveFrom: at({ days: -30 }),
    effectiveUntil: at({ days: 365 }),
    state: "ACTIVE",
  });

  function base({ stockA = 3, stockB = 5, deliveryUrl } = {}) {
    const tenant = { tenantId: uuid("tenant:primary"), name: "Commerce North" };
    const foreignTenant = { tenantId: uuid("tenant:foreign"), name: "Commerce South" };
    const buyer = { buyerId: uuid("buyer:primary"), tenantId: tenant.tenantId, displayName: "Primary Buyer" };
    const foreignBuyer = { buyerId: uuid("buyer:foreign"), tenantId: foreignTenant.tenantId, displayName: "Foreign Buyer" };
    const physical = { productId: uuid("product:physical"), tenantId: tenant.tenantId, sku: "CC-PHYSICAL", name: "Physical Kit", kind: "PHYSICAL" };
    const digital = { productId: uuid("product:digital"), tenantId: tenant.tenantId, sku: "CC-DIGITAL", name: "Digital License", kind: "DIGITAL" };
    const foreignProduct = { productId: uuid("product:foreign"), tenantId: foreignTenant.tenantId, sku: "CC-FOREIGN", name: "Foreign Kit", kind: "PHYSICAL" };
    const physicalOffer = offer("physical", tenant.tenantId, physical.productId, 1, 1_200, 120, "PHYSICAL");
    const digitalOffer = offer("digital", tenant.tenantId, digital.productId, 1, 700, 70, "DIGITAL");
    const foreignOffer = offer("foreign", foreignTenant.tenantId, foreignProduct.productId, 1, 900, 90, "PHYSICAL");
    const pools = [
      { inventoryPoolId: uuid("pool:a"), tenantId: tenant.tenantId, productId: physical.productId, priority: 1, onHand: stockA, reserved: 0 },
      { inventoryPoolId: uuid("pool:b"), tenantId: tenant.tenantId, productId: physical.productId, priority: 2, onHand: stockB, reserved: 0 },
      { inventoryPoolId: uuid("pool:foreign"), tenantId: foreignTenant.tenantId, productId: foreignProduct.productId, priority: 1, onHand: 10, reserved: 0 },
    ];
    const seed = {
      schemaVersion: 1,
      seedVersion: `${caseId.toLowerCase()}-v1`,
      tenants: [tenant, foreignTenant],
      buyers: [buyer, foreignBuyer],
      products: [physical, digital, foreignProduct],
      offerVersions: [physicalOffer, digitalOffer, foreignOffer],
      inventoryPools: pools,
      orders: [],
      orderLines: [],
      inventoryHolds: [],
      paymentAttempts: [],
      fulfillmentPlans: [],
      entitlementGrants: [],
      ledgerEntries: [],
      notificationDeliveries: [],
    };
    return {
      fixtureFamily: "CC-F-MAIN",
      tenant,
      foreignTenant,
      buyer,
      foreignBuyer,
      physical,
      digital,
      foreignProduct,
      physicalOffer,
      digitalOffer,
      pools,
      deliveryUrl,
      seed,
    };
  }

  function quoteBody(value, label = "quote", overrides = {}) {
    const quantity = overrides.quantity ?? 1;
    return {
      tenantId: overrides.tenantId ?? value.tenant.tenantId,
      buyerId: overrides.buyerId ?? value.buyer.buyerId,
      channel: overrides.channel ?? "WEB",
      lines: overrides.lines ?? [{ productId: overrides.productId ?? value.physical.productId, quantity }],
      holdTtlSeconds: overrides.holdTtlSeconds ?? 900,
      ...(overrides.extra ?? {}),
    };
  }

  function mixedQuoteBody(value, label = "mixed", overrides = {}) {
    return quoteBody(value, label, {
      ...overrides,
      lines: overrides.lines ?? [
        { productId: value.physical.productId, quantity: overrides.physicalQuantity ?? 1 },
        { productId: value.digital.productId, quantity: overrides.digitalQuantity ?? 1 },
      ],
    });
  }

  function family(name, options) {
    return { ...base(options), fixtureFamily: `CC-F-${name}` };
  }

  function largeCatalog(productCount = 20_000, { stockPerProduct = 1_000_000 } = {}) {
    const value = base({ stockA: stockPerProduct, stockB: stockPerProduct });
    const products = [];
    const offerVersions = [];
    const inventoryPools = [];
    for (let index = 0; index < productCount; index += 1) {
      const product = {
        productId: uuid(`perf:product:${index}`),
        tenantId: value.tenant.tenantId,
        sku: `CC-PERF-${String(index).padStart(6, "0")}`,
        name: `Performance Product ${index}`,
        kind: "PHYSICAL",
      };
      products.push(product);
      offerVersions.push(offer(`perf:${index}`, value.tenant.tenantId, product.productId, 1, 100 + (index % 100), 10, "PHYSICAL"));
      inventoryPools.push({
        inventoryPoolId: uuid(`perf:pool:${index}`),
        tenantId: value.tenant.tenantId,
        productId: product.productId,
        priority: 1,
        onHand: stockPerProduct,
        reserved: 0,
      });
    }
    return {
      ...value,
      fixtureFamily: "CC-F-PERF",
      products,
      seed: {
        ...value.seed,
        seedVersion: `${caseId.toLowerCase()}-catalog-${productCount}`,
        products,
        offerVersions,
        inventoryPools,
      },
    };
  }

  const scenarios = Object.freeze({
    quoteReadMix: { products: 20_000, clients: 64, warmupMs: 10_000, measureMs: 60_000, readRatio: 0.8, minimumThroughput: 250, maximumP95: 300 },
    checkoutContention: { quotes: 2_000, clients: 64, measureMs: 60_000, minimumThroughput: 120, maximumP95: 500 },
    inventoryHotspot: { pools: 10, attempts: 50_000, apiCount: 2, clients: 64, measureMs: 60_000, minimumThroughput: 150, maximumP95: 500 },
    paymentUnknown: { attempts: 5_000, clients: 64, measureMs: 60_000, convergenceMs: 120_000, minimumThroughput: 100, maximumP95: 700 },
    fulfillmentDrain: { orders: 10_000, workers: 4, minimumThroughput: 50, drainMs: 300_000 },
    notificationUnknownAck: { notifications: 10_000, dispatchers: 2, lostAckRatio: 0.1, minimumThroughput: 100, drainMs: 180_000 },
    entitlementStorm: { lines: 20_000, clients: 64, measureMs: 60_000, minimumThroughput: 150, maximumP95: 500 },
    settlementClose: { allocations: 50_000, clients: 64, measureMs: 60_000, minimumThroughput: 80, maximumP95: 750 },
    refundDisputeRace: { orders: 20_000, clients: 64, measureMs: 60_000, minimumThroughput: 100, maximumP95: 750 },
    catastrophe: { entities: 10_000, drainMs: 300_000 },
  });

  return Object.freeze({
    uuid,
    key,
    at,
    base,
    empty: () => ({ ...base(), fixtureFamily: "CC-F-EMPTY", seed: { ...base().seed, tenants: [], buyers: [], products: [], offerVersions: [], inventoryPools: [] } }),
    main: () => family("MAIN"),
    quote: () => family("QUOTE"),
    payment: () => family("PAYMENT", { stockA: 10_000, stockB: 10_000 }),
    fulfillment: () => family("FULFILLMENT", { stockA: 10_000, stockB: 10_000 }),
    entitlement: () => family("ENTITLEMENT", { stockA: 10_000, stockB: 10_000 }),
    ledger: () => family("LEDGER", { stockA: 10_000, stockB: 10_000 }),
    idempotency: () => family("IDEMPOTENCY", { stockA: 10_000, stockB: 10_000 }),
    work: () => family("WORK", { stockA: 10_000, stockB: 10_000 }),
    migration: () => ({ ...family("MIGRATION", { stockA: 10_000, stockB: 10_000 }), savedReplayKey: key("migration:replay") }),
    browser: () => family("BROWSER", { stockA: 10_000, stockB: 10_000 }),
    performance: () => ({ fixtureFamily: "CC-F-PERF", scenarios }),
    largeCatalog,
    quoteBody,
    mixedQuoteBody,
  });
}
