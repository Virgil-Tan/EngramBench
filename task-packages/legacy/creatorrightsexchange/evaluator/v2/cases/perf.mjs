import { readFile } from "node:fs/promises";

export function latency(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

export async function closedLoop({
  clients,
  durationMs,
  operation,
  ordinalStart = 0,
  accept = (value) => value?.status >= 200 && value.status < 300,
}) {
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  const records = [];
  let ordinal = ordinalStart;
  await Promise.all(
    Array.from({ length: clients }, async (_, client) => {
      while (performance.now() < deadline) {
        const current = ordinal;
        ordinal += 1;
        const requestStartedAt = performance.now();
        let value;
        try {
          value = await operation({ client, ordinal: current });
        } catch (error) {
          value = { error };
        }
        const completedAt = performance.now();
        if (completedAt <= deadline)
          records.push({
            client,
            ordinal: current,
            requestStartedAt,
            completedAt,
            durationMs: value?.durationMs ?? completedAt - requestStartedAt,
            accepted: accept(value),
            value,
          });
      }
    }),
  );
  const completedAt = performance.now();
  const accepted = records.filter((record) => record.accepted);
  return {
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    deadline,
    records,
    accepted,
    nextOrdinal: ordinal,
    throughput: accepted.length / (durationMs / 1_000),
    statusCounts: Object.fromEntries(
      [
        ...Map.groupBy(records, (record) =>
          String(record.value?.status ?? "error"),
        ).entries(),
      ].map(([status, items]) => [status, items.length]),
    ),
    latency: latency(accepted.map(({ durationMs: value }) => value)),
  };
}

async function residentBytes(process) {
  if (!process?.pid) return 0;
  const body = await readFile(`/proc/${process.pid}/status`, "utf8").catch(
    () => "",
  );
  return Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(body)?.[1] ?? 0) * 1024;
}

export function monitorRss(processes, intervalMs = 100) {
  let active = true;
  let maximum = 0;
  const done = (async () => {
    while (active) {
      maximum = Math.max(
        maximum,
        ...(await Promise.all(processes.map(residentBytes))),
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    maximum = Math.max(
      maximum,
      ...(await Promise.all(processes.map(residentBytes))),
    );
    return maximum;
  })();
  return {
    async stop() {
      active = false;
      return done;
    },
  };
}

export function assertMeasuredWindow(ctx, metrics, expectedMs, label) {
  ctx.ok(
    metrics.startedAt < metrics.deadline &&
      metrics.completedAt >= metrics.deadline,
    `${label} spans full window`,
  );
  ctx.ok(metrics.durationMs >= expectedMs, `${label} duration`);
  ctx.ok(metrics.accepted.length > 0, `${label} has accepted responses`);
  ctx.ok(
    !Object.keys(metrics.statusCounts).some((status) => /^5/u.test(status)),
    `${label} has no 5xx`,
  );
  return metrics;
}
