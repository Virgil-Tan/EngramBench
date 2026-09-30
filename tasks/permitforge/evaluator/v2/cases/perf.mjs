export function latency(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

export async function closedLoop({ clients, durationMs, operation, ordinalStart = 0, accept = (value) => value?.status >= 200 && value.status < 300 }) {
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  const records = [];
  let ordinal = ordinalStart;
  await Promise.all(Array.from({ length: clients }, async (_, client) => {
    while (performance.now() < deadline) {
      const current = ordinal;
      ordinal += 1;
      const requestStartedAt = performance.now();
      let value;
      try { value = await operation({ client, ordinal: current }); } catch (error) { value = { error }; }
      const completedAt = performance.now();
      if (completedAt <= deadline) records.push({ client, ordinal: current, requestStartedAt, completedAt, durationMs: value?.durationMs ?? completedAt - requestStartedAt, accepted: accept(value), value });
    }
  }));
  const completedAt = performance.now();
  const accepted = records.filter(({ accepted: value }) => value);
  return {
    startedAt, completedAt, deadline, durationMs: completedAt - startedAt, records, accepted, nextOrdinal: ordinal,
    throughput: accepted.length / (durationMs / 1_000),
    statusCounts: Object.fromEntries([...Map.groupBy(records, ({ value }) => String(value?.status ?? "error"))].map(([status, items]) => [status, items.length])),
    latency: latency(accepted.map(({ durationMs: value }) => value)),
  };
}

export function assertMeasuredWindow(ctx, metrics, expectedMs, label) {
  ctx.ok(metrics.startedAt < metrics.deadline && metrics.completedAt >= metrics.deadline, `${label} spans full window`);
  ctx.ok(metrics.durationMs >= expectedMs, `${label} duration`);
  ctx.ok(metrics.accepted.length > 0, `${label} accepted responses`);
  ctx.ok(!Object.keys(metrics.statusCounts).some((status) => /^5/u.test(status)), `${label} unexpected 5xx zero`);
  return metrics;
}
