import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BenchError } from "./errors.mjs";

export class CodexSession {
  constructor({
    container,
    model,
    effort,
    serviceTier,
    scratchHostPath,
    commandTimeoutMs,
    sandbox = "danger-full-access",
    sessionId,
    turnIndex = 0,
    retry = {},
  }) {
    this.container = container;
    this.model = model;
    this.effort = effort;
    this.serviceTier = serviceTier;
    this.scratchHostPath = scratchHostPath;
    this.commandTimeoutMs = commandTimeoutMs;
    this.sandbox = sandbox;
    this.sessionId = sessionId;
    this.turnIndex = turnIndex;
    this.retry = retry;
  }

  async send(message) {
    const outputName = `turn-${this.turnIndex}.txt`;
    const outputInContainer = `/bench/${outputName}`;
    const common = [
      "--json", "--output-last-message", outputInContainer,
      "--model", this.model,
      "--config", `model_reasoning_effort=\"${this.effort}\"`,
      ...(this.serviceTier ? ["--config", `service_tier=\"${this.serviceTier}\"`] : []),
    ];
    let retrySessionId = this.sessionId;
    const result = await runCodexWithRetry(async () => {
      const args = retrySessionId
        ? ["exec", "resume", ...common, "--dangerously-bypass-approvals-and-sandbox", retrySessionId, "-"]
        : ["exec", ...common, "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--cd", "/workspace", "-"];
      return await this.container.exec("codex", args, {
        input: message,
        timeoutMs: null,
        idleTimeoutMs: this.commandTimeoutMs,
        maxOutputBytes: 32 * 1024 * 1024,
      });
    }, {
      ...this.retry,
      onRetry: (retry) => {
        retrySessionId ??= findSessionId(parseJsonl(retry.error?.details?.stdout ?? ""));
        if (this.retry.onRetry) this.retry.onRetry(retry);
        else reportCodexRetry(retry);
      },
    });
    const events = parseJsonl(result.stdout);
    const observedSessionId = findSessionId(events);
    const expectedSessionId = this.sessionId ?? retrySessionId;
    if (!expectedSessionId && !observedSessionId) throw new BenchError("codex_session_missing", "Codex did not report a session ID");
    if (expectedSessionId && observedSessionId && observedSessionId !== expectedSessionId) {
      throw new BenchError("codex_session_changed", "Codex resume returned a different session ID");
    }
    this.sessionId = expectedSessionId ?? observedSessionId;
    const finalMessage = (await readFile(join(this.scratchHostPath, outputName), "utf8")).trim();
    if (!finalMessage) throw new BenchError("codex_empty_response", "Codex returned an empty final message");
    this.turnIndex += 1;
    return {
      sessionId: this.sessionId,
      finalMessage,
      usage: aggregateUsage(events),
      events,
    };
  }
}

export async function runCodexWithRetry(call, options = {}) {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      const retry = codexRetryPolicy(error, attempt, now());
      if (!retry || attempt >= retry.maxAttempts) throw error;
      const event = { ...retry, attempt, error };
      if (options.onRetry) options.onRetry(event);
      else reportCodexRetry(event);
      await sleep(retry.delayMs);
    }
  }
}

export function codexRetryPolicy(error, attempt, nowMs = Date.now()) {
  if (error?.code !== "process_failed") return null;
  const diagnostic = [error.message, error.details?.stdout, error.details?.stderr]
    .filter((value) => typeof value === "string")
    .join("\n");
  if (/hit your usage limit/iu.test(diagnostic)) {
    const resetAt = parseUsageReset(diagnostic);
    return {
      reason: "usage_limit",
      delayMs: resetAt === null ? 60 * 60_000 : Math.max(60_000, resetAt - nowMs + 60_000),
      maxAttempts: 4,
    };
  }
  if (/selected model is at capacity/iu.test(diagnostic)) {
    return { reason: "capacity", delayMs: 60_000, maxAttempts: 30 };
  }
  if (/(?:^|\D)429(?:\D|$)|too many requests|rate[_ -]?limit/iu.test(diagnostic)) {
    return { reason: "rate_limit", delayMs: Math.min(30_000 * (2 ** (attempt - 1)), 10 * 60_000), maxAttempts: 12 };
  }
  // The Codex gateway occasionally returns a transient provider 500 without
  // exposing a more specific capacity or network diagnostic.  Treat that as
  // retryable; otherwise one transient upstream error aborts the whole stage.
  if (/internal server error|internal_error|server error/iu.test(diagnostic)) {
    return { reason: "upstream_server", delayMs: Math.min(15_000 * (2 ** (attempt - 1)), 2 * 60_000), maxAttempts: 6 };
  }
  if (/tls handshake eof|failed to connect to websocket|connection (?:reset|closed)|network is unreachable|temporary failure in name resolution|econnreset|eai_again/iu.test(diagnostic)) {
    return { reason: "network", delayMs: Math.min(15_000 * (2 ** (attempt - 1)), 2 * 60_000), maxAttempts: 8 };
  }
  return null;
}

function reportCodexRetry({ reason, attempt, delayMs }) {
  process.stderr.write(`Codex ${reason}; retry ${attempt + 1} in ${Math.ceil(delayMs / 1000)}s\n`);
}

function parseUsageReset(diagnostic) {
  const match = diagnostic.match(/try again at ([A-Z][a-z]{2} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} [AP]M)/u);
  if (!match) return null;
  const parsed = Date.parse(match[1].replace(/(\d)(?:st|nd|rd|th)/u, "$1"));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseJsonl(text) {
  const events = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Non-JSON diagnostics are intentionally excluded from the event stream.
    }
  }
  return events;
}

export function findSessionId(events) {
  for (const event of events) {
    const found = deepString(event, new Set(["thread_id", "threadId", "session_id", "sessionId"]));
    if (found && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(found)) return found;
  }
  return undefined;
}

function aggregateUsage(events) {
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let observedIncrementalUsage = false;
  for (const event of events) {
    const usage = event?.payload?.info?.last_token_usage;
    if (event?.payload?.type !== "token_count" || !usage) continue;
    observedIncrementalUsage = true;
    totals.inputTokens += Number(usage.input_tokens ?? 0);
    totals.cachedInputTokens += Number(usage.cached_input_tokens ?? 0);
    totals.outputTokens += Number(usage.output_tokens ?? 0);
  }
  if (observedIncrementalUsage) return totals;

  // Older Codex event streams do not expose per-call increments.
  for (const event of events) {
    visit(event, (key, value) => {
      if (!Number.isFinite(value)) return;
      if (["input_tokens", "inputTokens"].includes(key)) totals.inputTokens = Math.max(totals.inputTokens, value);
      if (["cached_input_tokens", "cachedInputTokens"].includes(key)) totals.cachedInputTokens = Math.max(totals.cachedInputTokens, value);
      if (["output_tokens", "outputTokens"].includes(key)) totals.outputTokens = Math.max(totals.outputTokens, value);
    });
  }
  return totals;
}

function deepString(value, keys) {
  let result;
  visit(value, (key, child) => {
    if (!result && keys.has(key) && typeof child === "string") result = child;
  });
  return result;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child);
    if (child && typeof child === "object") visit(child, callback);
  }
}
