import { once } from "node:events";
import { createWriteStream } from "node:fs";

export async function writePerformanceSeed(ctx) {
  const spec = ctx.fixtures.performance(); const path = ctx.tempPath("perf-v1.json"); const tenants = Array.from({ length: spec.tenantCount }, (_, index) => ({ tenantId: ctx.uuid(`perf-tenant:${index}`), name: `Perf Tenant ${String(index).padStart(3, "0")}`, watermarkThrough: null })); const meters = Array.from({ length: spec.meterCount }, (_, index) => ({ meterId: ctx.uuid(`perf-meter:${index}`), tenantId: tenants[index % tenants.length].tenantId, name: `Perf Meter ${String(index).padStart(5, "0")}` })); const plans = tenants.map((tenant, index) => ({ tenantId: tenant.tenantId, version: 1, effectiveFrom: "2025-01-01T00:00:00.000Z", effectiveTo: null, unitPriceMinor: 1 + (index % 10) }));
  const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 }); const write = async (value) => { if (!stream.write(value)) await once(stream, "drain"); };
  await write(`{"schemaVersion":1,"seedVersion":"perf-v1","importedAt":"${spec.importedAt}","tenants":${JSON.stringify(tenants)},"meterDefinitions":${JSON.stringify(meters)},"ratePlans":${JSON.stringify(plans)},"usageEvents":[`);
  for (let start = 0; start < spec.eventCount; start += 1_000) { const values = []; for (let index = start; index < Math.min(start + 1_000, spec.eventCount); index += 1) { const meter = meters[index % meters.length]; values.push({ eventId: `perf-seed-${String(index).padStart(7, "0")}`, meterId: meter.meterId, tenantId: meter.tenantId, occurredAt: index < spec.closedEventCount ? "2025-12-15T12:00:00.000Z" : "2026-02-15T12:00:00.000Z", quantity: 1 }); } await write(`${start === 0 ? "" : ","}${values.map(JSON.stringify).join(",")}`); }
  await write("]}"); stream.end(); await once(stream, "close");
  return { spec, path, tenants, meters, plans };
}

export function performanceBatch(catalog, prefix, batchIndex) {
  const tenant = catalog.tenants[batchIndex % catalog.tenants.length]; const tenantMeters = catalog.meters.filter(({ tenantId }) => tenantId === tenant.tenantId).sort((a, b) => Buffer.from(a.meterId).compare(Buffer.from(b.meterId)));
  return { tenantId: tenant.tenantId, events: Array.from({ length: 100 }, (_, memberIndex) => ({ eventId: `${prefix}-${String(batchIndex * 100 + memberIndex).padStart(12, "0")}`, meterId: tenantMeters[(batchIndex * 100 + memberIndex) % tenantMeters.length].meterId, occurredAt: "2026-02-20T12:00:00.000Z", quantity: 1 })) };
}

export async function closedLoopWindow(ctx, values, concurrency, seconds, targetPerSecond, operation) {
  if (!Number.isSafeInteger(targetPerSecond) || targetPerSecond < 1) throw new TypeError("targetPerSecond must be a positive integer");
  const startedAt = performance.now(); const deadline = startedAt + seconds * 1_000; const samples = []; const targetCount = seconds * targetPerSecond; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, targetCount) }, async () => { while (next < targetCount) { const index = next++; const scheduledAt = startedAt + (index * 1_000) / targetPerSecond; const delayMs = scheduledAt - performance.now(); if (delayMs > 0) await ctx.sleep(delayMs); if (performance.now() >= deadline) return; const started = performance.now(); const response = await operation(values[index % values.length], index); samples.push({ response, durationMs: performance.now() - started }); } }));
  return samples;
}
