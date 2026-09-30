import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("NotifyRoute canonical JSON accepts safe integers only");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("value is outside canonical JSON domain");
}

export function contentDigest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function renderTemplate(templateVersion, data) {
  const source = `${templateVersion.subject ?? ""}\0${templateVersion.body}`;
  const variables = [...source.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu)].map((match) => match[1]);
  const required = [...new Set(variables)].sort();
  const supplied = Object.keys(data).sort();
  if (canonicalJson(required) !== canonicalJson(supplied) || supplied.some((key) => typeof data[key] !== "string")) throw new Error("TEMPLATE_RENDER_INVALID");
  const replace = (text) => text === null ? null : text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu, (_match, key) => data[key]);
  return { subject: replace(templateVersion.subject), body: replace(templateVersion.body) };
}

export function projectRoute(steps, deliveries) {
  const ordered = [...steps].sort((left, right) => left.ordinal - right.ordinal);
  const byOrdinal = new Map(deliveries.map((item) => [item.routeOrdinal, item]));
  const eligibleOrdinals = [];
  for (const step of ordered) {
    const existing = byOrdinal.get(step.ordinal);
    if (existing && ["ACCEPTED", "DELIVERED"].includes(existing.state)) break;
    if (!existing) { eligibleOrdinals.push(step.ordinal); break; }
    if (!["FAILED", "SUPPRESSED", "CANCELLED"].includes(existing.state)) break;
  }
  return { eligibleOrdinals, frozenOrdinals: ordered.map(({ ordinal }) => ordinal) };
}

export function evaluateSuppression(suppressions, target) {
  return suppressions.filter((item) => item.state === "ACTIVE"
    && item.recipientId === target.recipientId
    && (item.channel === "ALL" || item.channel === target.channel)
    && (item.category === null || item.category === target.category))
    .sort((left, right) => right.revision - left.revision || left.suppressionId.localeCompare(right.suppressionId))[0] ?? null;
}

export function nextWindow(at, windowSeconds) {
  const time = Date.parse(at);
  if (!Number.isFinite(time) || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) throw new TypeError("invalid rate window");
  const width = windowSeconds * 1_000;
  return new Date((Math.floor(time / width) + 1) * width).toISOString();
}

export function consumeRate(policy, calls, target) {
  const start = Date.parse(target.at) - (Date.parse(target.at) % (policy.windowSeconds * 1_000));
  const within = calls.filter((call) => call.tenantId === target.tenantId && call.channel === target.channel && Date.parse(call.at) >= start && Date.parse(call.at) < start + policy.windowSeconds * 1_000);
  const tenantUsed = new Set(within.map(({ notificationId }) => notificationId)).size;
  const recipientUsed = new Set(within.filter(({ recipientId }) => recipientId === target.recipientId).map(({ notificationId }) => notificationId)).size;
  const allowed = tenantUsed < policy.tenantLimit && (policy.recipientLimit === null || recipientUsed < policy.recipientLimit);
  return { allowed, tenantUsed, recipientUsed, nextAttemptAt: allowed ? null : new Date(start + policy.windowSeconds * 1_000).toISOString() };
}

export function reduceProviderFacts(facts) {
  const identities = new Set(facts.map(({ providerRequestId }) => providerRequestId));
  if (identities.size !== 1) throw new Error("provider identity changed");
  const messages = new Set(facts.flatMap(({ providerMessageId }) => providerMessageId ? [providerMessageId] : []));
  if (messages.size > 1) throw new Error("provider message identity conflict");
  const receipt = [...facts].reverse().find(({ kind }) => kind === "receipt");
  const attempt = [...facts].reverse().find(({ kind }) => kind === "attempt");
  const state = receipt ? ({ DELIVERED: "DELIVERED", BOUNCED: "FAILED", COMPLAINED: "FAILED", FAILED: "FAILED" })[receipt.outcome]
    : ["TIMEOUT", "CONNECTION_RESET"].includes(attempt?.outcome) ? "UNKNOWN"
      : attempt?.outcome === "ACCEPTED" ? "ACCEPTED" : "FAILED";
  return { state, providerRequestId: [...identities][0], providerMessageId: [...messages][0] ?? null };
}

export function webhookSignature(secret, body) { return createHmac("sha256", secret).update(body).digest("hex"); }

export function verifyWebhookSignature(secret, body, signature) {
  if (!/^[a-f0-9]{64}$/u.test(signature ?? "")) return false;
  return timingSafeEqual(Buffer.from(webhookSignature(secret, body)), Buffer.from(signature));
}

export function sortEvents(events) {
  return [...events].sort((left, right) => Buffer.compare(Buffer.from(left.aggregateId), Buffer.from(right.aggregateId)) || left.sequence - right.sequence || Buffer.compare(Buffer.from(left.eventId), Buffer.from(right.eventId)));
}

export function assertEventLedger(events) {
  const identities = new Map();
  const sequences = new Map();
  for (const event of events) {
    const body = canonicalJson(event);
    if (identities.has(event.eventId) && identities.get(event.eventId) !== body) throw new Error(`Event ${event.eventId} changed body`);
    identities.set(event.eventId, body);
    const values = sequences.get(event.aggregateId) ?? [];
    values.push(event.sequence);
    sequences.set(event.aggregateId, values);
  }
  for (const [aggregateId, values] of sequences) {
    const actual = [...new Set(values)].sort((left, right) => left - right);
    const expected = Array.from({ length: actual.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Event sequence for ${aggregateId} is not contiguous`);
  }
  return { events: identities.size, aggregates: sequences.size };
}

export function assertNoTerminalRegression(history) {
  const terminal = new Set(["DELIVERED", "PARTIALLY_DELIVERED", "SUPPRESSED", "FAILED", "CANCELLED"]);
  const first = history.findIndex(({ state }) => terminal.has(state));
  if (first >= 0 && history.slice(first).some(({ state }) => !terminal.has(state) || state !== history[first].state)) throw new Error("terminal state regressed");
  return history.at(-1)?.state;
}
