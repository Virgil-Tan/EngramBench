import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluatorContract } from './public-contract.mjs';
import { assertCandidateError } from './execution.mjs';
export { assertCandidateError };

const publicContract = await evaluatorContract(process.env.FRONTAL_PUBLIC_CONTRACT_ROOT);

const LOG_LIMIT = 256_000;
const TASK_RUNTIME_DEFAULTS_MAX_BYTES = 64 * 1024;
const SAFE_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS",
];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const COMMAND_OWNER_ENV = "FRONTAL_V2_COMMAND_OWNER";

export const TASK_RUNTIME_DEFAULTS_ENV = "FRONTAL_V2_TASK_RUNTIME_DEFAULTS";
export const PREPARE_CANDIDATE_ENV = "FRONTAL_V2_PREPARE_CANDIDATE";

export function serializeTaskRuntimeDefaults(value) {
  const normalized = normalizeTaskRuntimeDefaults(value);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized) > TASK_RUNTIME_DEFAULTS_MAX_BYTES) {
    throw new TypeError(`task runtime defaults exceed ${TASK_RUNTIME_DEFAULTS_MAX_BYTES} bytes`);
  }
  return serialized;
}

export function parseTaskRuntimeDefaults(serialized = process.env[TASK_RUNTIME_DEFAULTS_ENV]) {
  if (serialized === undefined) return {};
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > TASK_RUNTIME_DEFAULTS_MAX_BYTES) {
    throw new TypeError(`task runtime defaults must be bounded serialized JSON`);
  }
  try {
    return normalizeTaskRuntimeDefaults(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("task runtime defaults are invalid JSON", { cause: error });
  }
}

function normalizeTaskRuntimeDefaults(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("task runtime defaults must be an object");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!ENVIRONMENT_NAME.test(key) || key.startsWith("FRONTAL_V2_")) {
      throw new TypeError(`task runtime defaults contain invalid variable ${key}`);
    }
    if (typeof entry !== "string" || /[\r\n\0]/u.test(entry)) {
      throw new TypeError(`task runtime default ${key} must be a string without CR, LF, or NUL`);
    }
    return [key, entry];
  }));
}

export class EvaluationInfrastructureError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EvaluationInfrastructureError";
    this.code = code;
    this.origin = "infrastructure";
  }
}

export class CommandError extends Error {
  constructor(command, result) {
    const outcome = result.spawnError
      ? "could not be started"
      : result.leakedProcessGroup
        ? "left descendant processes running"
        : result.timedOut
          ? "timed out"
          : `exited ${result.exitCode ?? result.signal}`;
    super(`${command} ${outcome}`);
    this.name = "CommandError";
    this.command = command;
    this.result = result;
  }
}

export class CandidateResponseError extends Error {
  constructor(message, response) {
    super(message, response?.cause ? { cause: response.cause } : undefined);
    this.name = "CandidateResponseError";
    this.origin = 'candidate';
    this.response = response;
  }
}

function appendTail(value, chunk, maximum = LOG_LIMIT) {
  return `${value}${chunk}`.slice(-maximum);
}

function safeEnvironment(extra = {}) {
  const base = Object.fromEntries(SAFE_ENVIRONMENT_KEYS.flatMap((key) => (
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  )));
  return {
    ...base,
    ...Object.fromEntries(Object.entries(extra).flatMap(([key, value]) => (
      value === undefined ? [] : [[key, String(value)]]
    ))),
  };
}

function normalizeOptions(value) {
  return typeof value === "string" ? { workspace: value } : value ?? {};
}

function processGroupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    return readdirSync("/proc", { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return false;
      try {
        const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[2]) === pid && fields[0] !== "Z";
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}

async function waitForProcessGroupExit(pid, maximumMs) {
  const deadline = Date.now() + maximumMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processGroupAlive(pid);
}

function ownedCommandProcess(pid, ownerEntry) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (pid === process.pid || fields[0] === "Z") return undefined;
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!environment.split("\0").includes(ownerEntry)) return undefined;
    return { pid, startTime: fields[19] };
  } catch { return undefined; }
}

function ownedCommandProcesses(ownerEntry) {
  if (process.platform !== "linux") return [];
  try {
    return readdirSync("/proc").flatMap(entry => {
      if (!/^\d+$/u.test(entry)) return [];
      const record = ownedCommandProcess(Number(entry), ownerEntry);
      return record ? [record] : [];
    });
  } catch { return []; }
}

/** Run one public command without a shell and capture bounded stdout/stderr. */
export async function runCommand(binary, args = [], options = {}) {
  const startedAt = performance.now();
  const owner = randomUUID();
  const ownerEntry = `${COMMAND_OWNER_ENV}=${owner}`;
  let child;
  try {
    child = spawn(binary, args, {
      cwd: options.workspace,
      detached: true,
      env: { ...safeEnvironment(options.env), [COMMAND_OWNER_ENV]: owner },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new CommandError(`${binary} ${args.join(" ")}`, {
      exitCode: null, signal: null, stdout: "", stderr: String(cause), timedOut: false, durationMs: 0,
    });
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
  const streamsClosed = new Promise((resolveClose) => {
    child.once("close", (code, closeSignal) => resolveClose([code, closeSignal]));
  });
  let timedOut = false;
  const timer = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, options.timeoutMs)
    : undefined;
  let exitCode = null;
  let signal = null;
  let spawnError;
  try {
    [exitCode, signal] = await once(child, "exit");
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
    stderr = appendTail(stderr, spawnError);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let leakedProcessGroup = false;
  if (child.pid && processGroupAlive(child.pid)) {
    // A successful npm parent may exit before Chromium/test children drain.
    // This is post-exit cleanup grace, not a Coding Agent/turn time limit.
    if (!timedOut) await waitForProcessGroupExit(child.pid, exitCode === 0 ? 10_000 : 250);
    if (processGroupAlive(child.pid)) {
      leakedProcessGroup = !timedOut;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      await waitForProcessGroupExit(child.pid, 3_000);
    }
  }
  // A detached grandchild can leave the original process group while retaining
  // its pipes. Only the unique inherited marker establishes ownership here.
  let descendants = ownedCommandProcesses(ownerEntry);
  if (descendants.length && !timedOut) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    descendants = ownedCommandProcesses(ownerEntry);
  }
  const cleanupDeadline = Date.now() + 3_000;
  while (descendants.length && Date.now() < cleanupDeadline) {
    leakedProcessGroup ||= !timedOut;
    for (const record of descendants) {
      // Recheck both the marker and start time before signaling a recorded PID.
      if (ownedCommandProcess(record.pid, ownerEntry)?.startTime !== record.startTime) continue;
      try { process.kill(record.pid, "SIGKILL"); } catch {}
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    descendants = ownedCommandProcesses(ownerEntry);
  }
  let drainTimer;
  let streamsDrained = true;
  const [closeCode, closeSignal] = await Promise.race([
    streamsClosed,
    new Promise(resolveClose => {
      drainTimer = setTimeout(() => {
        streamsDrained = false;
        leakedProcessGroup ||= !timedOut;
        stderr = appendTail(stderr, "\n[evaluator] command exited but output streams remained open; descendant ownership could not be fully recovered\n");
        // Also bound cleanup on non-Linux systems or when descendants clear
        // their environment; never guess which unrelated process to signal.
        child.stdout.destroy();
        child.stderr.destroy();
        resolveClose([null, null]);
      }, 1_000);
    }),
  ]);
  clearTimeout(drainTimer);
  exitCode ??= closeCode;
  signal ??= closeSignal;
  const result = {
    exitCode,
    signal,
    stdout,
    stderr,
    timedOut,
    spawnError,
    leakedProcessGroup,
    cleanupComplete: streamsDrained && !processGroupAlive(child.pid)
      && process.platform === 'linux' && ownedCommandProcesses(ownerEntry).length === 0,
    durationMs: performance.now() - startedAt,
  };
  if (spawnError || leakedProcessGroup || timedOut || (!options.allowFailure && exitCode !== 0)) {
    throw new CommandError(`${binary} ${args.join(" ")}`, result);
  }
  return result;
}

// Explicit fault-injection boundary only. A deliberately broken dependency may
// crash the parent before it cleans children. Retain that fact as evidence, but
// expose the original exit when our ownership-checked cleanup really completed.
// Ordinary public gates and every timeout/spawn/unknown error remain unchanged.
export async function observeExpectedCommandFailure(operation) {
  try { return await operation(); }
  catch (error) {
    const r = error.result;
    if (!(error instanceof CommandError) || ['infrastructure', 'evaluator'].includes(error.origin)
      || !Number.isInteger(r?.exitCode) || r.exitCode === 0
      || r.signal || r.spawnError || r.timedOut || !r.leakedProcessGroup || r.cleanupComplete !== true) throw error;
    return r;
  }
}

export async function freePort() {
  const server = createNetServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string" || address.port <= 0) {
      throw new Error("localhost did not allocate a TCP port");
    }
    return address.port;
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_PORT_ALLOCATION_FAILED", "failed to allocate an isolated localhost port", { cause });
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function stopOwnedProcess(record, signal = "SIGTERM", graceMs = 5_000) {
  if (!record?.pid || record.stopped) return;
  if (!processGroupAlive(record.pid)) { record.stopped = true; return; }
  try { process.kill(-record.pid, "SIGCONT"); } catch {}
  try { process.kill(-record.pid, signal); } catch {}
  if (!(await waitForProcessGroupExit(record.pid, signal === 'SIGKILL' ? 3_000 : graceMs))) {
    record.forcedKill = true;
    try { process.kill(-record.pid, "SIGKILL"); } catch {}
    await waitForProcessGroupExit(record.pid, 3_000);
  }
  if (processGroupAlive(record.pid)) throw new EvaluationInfrastructureError('EVALUATOR_PROCESS_CLEANUP_FAILED', `owned ${record.role ?? 'process'} group ${record.pid} is still alive`);
  record.stopped = true;
}

async function closeServer(record) {
  if (!record?.server || record.closed) return;
  for (const socket of record.sockets) socket.destroy();
  record.server.closeAllConnections?.();
  if (record.server.listening) await new Promise((resolveClose, reject) => record.server.close(error => error ? reject(error) : resolveClose()));
  record.closed = true;
}

function listen(server, pathLabel) {
  return new Promise((resolveListen, reject) => {
    const onError = (cause) => {
      server.off("listening", onListening);
      reject(new EvaluationInfrastructureError("EVALUATOR_SERVER_BIND_FAILED", `failed to bind ${pathLabel} on localhost`, { cause }));
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function registerServer(context, server, values) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const address = server.address();
  const record = { server, sockets, closed: false, ...values };
  if (address && typeof address !== "string") record.baseUrl = `http://127.0.0.1:${address.port}`;
  context.servers.push(record);
  return record;
}

function parseBody(chunks) {
  const raw = Buffer.concat(chunks).toString("utf8");
  let json;
  try { json = JSON.parse(raw); } catch {}
  return { raw, json };
}

function adaptBufferedJsonResponse(adaptCompatibilityResponse, compatibilityAdapter, { method, path, status, headers, body }) {
  let json;
  try { json = JSON.parse(body.toString("utf8")); } catch { return { body, headers: { ...headers } }; }
  const adapted = adaptCompatibilityResponse(compatibilityAdapter, { method, path, status, json });
  if (adapted === json) return { body, headers: { ...headers } };
  const adaptedBody = Buffer.from(JSON.stringify(adapted));
  const adaptedHeaders = { ...headers, "content-length": String(adaptedBody.length) };
  delete adaptedHeaders.etag;
  return { body: adaptedBody, headers: adaptedHeaders };
}

function sendResponse(response, selected = {}) {
  if (selected.disconnect) {
    response.destroy();
    return;
  }
  const headers = { ...(selected.headers ?? {}) };
  let body = selected.body ?? "";
  if (Object.hasOwn(selected, "json")) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(selected.json);
  }
  response.writeHead(selected.status ?? 204, headers);
  response.end(body);
}

async function startReceiver(context, options = {}) {
  if (typeof options === "function") options = { behavior: options };
  const path = options.path ?? "/events";
  const behavior = options.behavior ?? (() => ({ status: 204 }));
  const ledger = [];
  const server = createServer(async (incoming, outgoing) => {
    if (new URL(incoming.url ?? "/", "http://127.0.0.1").pathname !== path) {
      outgoing.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const { raw, json } = parseBody(chunks);
    const entry = {
      attempt: ledger.length + 1,
      method: incoming.method,
      path,
      headers: { ...incoming.headers },
      raw,
      json,
      acknowledged: false,
    };
    ledger.push(entry);
    try {
      const selected = await behavior(entry, ledger) ?? { status: 204 };
      if (selected.delayMs) await new Promise((resolveWait) => setTimeout(resolveWait, selected.delayMs));
      entry.responseStatus = selected.status ?? 204;
      outgoing.once("finish", () => { entry.acknowledged = entry.responseStatus >= 200 && entry.responseStatus < 300; });
      sendResponse(outgoing, selected);
    } catch {
      if (!outgoing.destroyed) outgoing.writeHead(500).end();
    }
  });
  await listen(server, `receiver ${path}`);
  const record = registerServer(context, server, { ledger, path });
  record.url = `${record.baseUrl}${path}`;
  return record;
}

async function startResponseShield(context, upstreamBaseUrl) {
  const captures = [];
  let dropMutation = false;
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const requestBody = Buffer.concat(chunks);
    const target = new URL(incoming.url ?? "/", upstreamBaseUrl);
    const requestCapture = {
      method: incoming.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...incoming.headers },
      body: requestBody.toString("utf8"),
    };
    const proxy = httpRequest(target, {
      method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
    }, (upstream) => {
      const responseChunks = [];
      upstream.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
      upstream.on("end", () => {
        const adapted = adaptBufferedJsonResponse(context.runtimeConfig.adaptCompatibilityResponse, context.compatibilityAdapter, {
          method: incoming.method ?? "GET",
          path: `${target.pathname}${target.search}`,
          status: upstream.statusCode ?? 502,
          headers: upstream.headers,
          body: Buffer.concat(responseChunks),
        });
        const capture = {
          request: requestCapture,
          response: {
            status: upstream.statusCode ?? 502,
            headers: adapted.headers,
            body: adapted.body.toString("utf8"),
          },
          dropped: false,
        };
        captures.push(capture);
        if (dropMutation && incoming.method !== "GET" && incoming.method !== "HEAD") {
          dropMutation = false;
          capture.dropped = true;
          outgoing.destroy();
          return;
        }
        if (!outgoing.destroyed) {
          outgoing.writeHead(upstream.statusCode ?? 502, adapted.headers);
          outgoing.end(adapted.body);
        }
      });
    });
    proxy.on("error", () => { if (!outgoing.destroyed) outgoing.destroy(); });
    proxy.end(requestBody);
  });
  await listen(server, "response shield");
  const record = registerServer(context, server, { captures });
  record.dropNextMutation = () => { dropMutation = true; };
  return record;
}

async function startBarrier(context, options = {}) {
  const path = options.path ?? "/barrier";
  const token = options.token ?? context.barrierToken;
  const shouldHold = options.hold ?? (() => false);
  const ledger = [];
  const pending = new Map();
  const server = createServer(async (incoming, outgoing) => {
    if (new URL(incoming.url ?? "/", "http://127.0.0.1").pathname !== path) {
      outgoing.writeHead(404).end();
      return;
    }
    if (incoming.method !== "POST" || !context.runtimeConfig.authorizeBarrierRequest(incoming.headers, token)) {
      outgoing.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const { raw, json } = parseBody(chunks);
    const entry = { headers: { ...incoming.headers }, raw, json, released: false, disconnected: false };
    if (!context.runtimeConfig.validateBarrierPayload(json)) {
      outgoing.writeHead(400).end();
      return;
    }
    ledger.push(entry);
    if (!shouldHold(json, entry)) {
      entry.released = true;
      outgoing.writeHead(204).end();
      return;
    }
    pending.set(entry, outgoing);
    outgoing.on("close", () => {
      if (!entry.released) entry.disconnected = true;
      pending.delete(entry);
    });
  });
  await listen(server, `recovery barrier ${path}`);
  const record = registerServer(context, server, { ledger, path, token });
  record.url = `${record.baseUrl}${path}`;
  record.waitFor = (predicate, waitOptions = {}) => context.waitFor(
    () => ledger.find((entry) => predicate(entry)),
    { label: "recovery barrier request", ...waitOptions },
  );
  record.release = (entry) => {
    const response = pending.get(entry);
    entry.released = true;
    pending.delete(entry);
    if (response && !response.destroyed) response.writeHead(204).end();
  };
  record.releaseAll = () => {
    for (const entry of [...pending.keys()]) record.release(entry);
  };
  return record;
}

function databaseUrl(baseUrl, name) {
  const target = new URL(baseUrl);
  target.pathname = `/${name}`;
  target.search = "";
  target.hash = "";
  return target.toString();
}

function databaseName(caseId, prefix) {
  const slug = String(caseId).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "").slice(0, 28) || "case";
  return `${prefix}_${slug}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`.slice(0, 63);
}

function defaultBaseTime() {
  return new Date().toISOString();
}

async function createDatabase(context) {
  try {
    const ready = await runCommand("pg_isready", ["--dbname", context.postgresAdminUrl], {
      workspace: context.workspace,
      timeoutMs: 5_000,
      allowFailure: true,
    });
    if (ready.exitCode !== 0) throw new Error(ready.stderr || ready.stdout || "pg_isready failed");
    await runCommand("createdb", [`--maintenance-db=${context.postgresAdminUrl}`, context.databaseName], {
      workspace: context.workspace,
      timeoutMs: 60_000,
    });
    context.databaseCreated = true;
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_DATABASE_CREATE_FAILED", `failed to create isolated database ${context.databaseName}`, { cause });
  }
}

async function dropDatabase(context) {
  if (!context.databaseCreated) return;
  try {
    await runCommand("dropdb", [
      `--maintenance-db=${context.postgresAdminUrl}`, "--if-exists", "--force", context.databaseName,
    ], { workspace: context.workspace, timeoutMs: 60_000 });
    context.databaseCreated = false;
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_DATABASE_DROP_FAILED", `failed to drop isolated database ${context.databaseName}`, { cause });
  }
}

function candidateEnvironment(context, extra = {}) {
  return {
    ...context.taskRuntimeDefaults,
    DATABASE_URL: context.databaseUrl,
    TEST_DATABASE_URL: context.databaseUrl,
    ADMIN_TOKEN: context.adminToken,
    BENCH_POSTGRES_DATABASES: context.databaseName,
    CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    MANAGED_DATA_ROOT: context.managedDataRoot,
    WORK_LEASE_SECONDS: "3",
    TEST_BARRIER_URL: "",
    TEST_BARRIER_TOKEN: "",
    ...extra,
  };
}

async function startRole(context, role, script, options = {}) {
  const workspace = options.workspace ?? context.workspace;
  const child = spawn("npm", ["run", script], {
    cwd: workspace,
    detached: true,
    env: safeEnvironment(candidateEnvironment(context, options.env)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    role,
    script,
    workspace,
    pid: child.pid,
    spawnedAt: performance.now(),
    child,
    logs: "",
    stdout: "",
    stderr: "",
    stopped: false,
  };
  const appendStdout = (chunk) => {
    record.stdout = appendTail(record.stdout, chunk);
    record.logs = appendTail(record.logs, chunk);
  };
  const appendStderr = (chunk) => {
    record.stderr = appendTail(record.stderr, chunk);
    record.logs = appendTail(record.logs, chunk);
  };
  child.stdout.on("data", appendStdout);
  child.stderr.on("data", appendStderr);
  record.exited = once(child, "exit").catch((error) => [null, error?.message ?? "spawn-error"]);
  context.processes.push(record);
  return record;
}

function bindWorkspace(context, workspace) {
  const inject = (options) => ({ ...normalizeOptions(options), workspace });
  return {
    workspace,
    command: (binary, args = [], options = {}) => context.command(binary, args, inject(options)),
    npm: (script, args = [], options = {}) => context.npm(script, args, inject(options)),
    migrate: (options = {}) => context.migrate(inject(options)),
    seed: (value, options = {}) => context.seed(value, inject(options)),
    seedFile: (path, options = {}) => context.seedFile(path, inject(options)),
    startProcess: (role, script, options = {}) => context.startProcess(role, script, inject(options)),
    startDev: (options = {}) => context.startDev(inject(options)),
    startApi: (options = {}) => context.startApi(inject(options)),
    startWorker: (options = {}) => context.startWorker(inject(options)),
    startDispatcher: (options = {}) => context.startDispatcher(inject(options)),
  };
}

/**
 * Public ctx API used by cases:
 * setup/teardown/resetDatabase; command/npm/migrate/seed/seedFile;
 * startProcess/startDev/startApi/startWorker/startDispatcher/stop/kill; request/mutate/snapshot;
 * receiver/responseShield/barrier; waitFor/concurrent/freePort; and the
 * deterministic uuid/at/key fixture methods. Every optional workspace value
 * runs a V1 or FINAL binary against this case's same isolated database.
 */
export function createCaseRuntime(config) {
  const runtimeConfig = {
    taskSlug: requiredSlug(config?.taskSlug, "taskSlug"),
    databasePrefix: requiredSlug(config?.databasePrefix, "databasePrefix").replaceAll("-", "_"),
    snapshotPath: requiredPath(config?.snapshotPath, "snapshotPath"),
    createFixtureFactory: requiredFunction(config?.createFixtureFactory, "createFixtureFactory"),
    adaptCompatibilityResponse: requiredFunction(config?.adaptCompatibilityResponse, "adaptCompatibilityResponse"),
    assertCompatibilityAdapter: requiredFunction(config?.assertCompatibilityAdapter, "assertCompatibilityAdapter"),
    validateBarrierPayload: requiredFunction(config?.validateBarrierPayload, "validateBarrierPayload"),
    authorizeBarrierRequest: config?.authorizeBarrierRequest === undefined
      ? (headers, token) => headers["x-test-barrier-token"] === token
      : requiredFunction(config.authorizeBarrierRequest, "authorizeBarrierRequest"),
  };
  return Object.freeze({
    createCaseContext: (options) => createCaseContext(runtimeConfig, options),
    withCaseContext: (options, operation) => withCaseContext(runtimeConfig, options, operation),
  });
}

async function createCaseContext(runtimeConfig, options) {
  if (!options?.caseId || !options.workspace || !options.evaluationSeed) {
    throw new TypeError("caseId, workspace, and evaluationSeed are required");
  }
  runtimeConfig.assertCompatibilityAdapter(options.compatibilityAdapter);
  let temporary;
  try {
    temporary = await mkdtemp(join(tmpdir(), `${runtimeConfig.taskSlug}-${String(options.caseId).toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-`));
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_TEMP_CREATE_FAILED", "failed to create isolated evaluator data root", { cause });
  }
  const fixtures = runtimeConfig.createFixtureFactory({
    evaluationSeed: options.evaluationSeed,
    caseId: options.caseId,
    baseTime: options.baseTime ?? defaultBaseTime(),
  });
  const basePostgresUrl = options.postgresAdminUrl
    ?? process.env.EVALUATOR_POSTGRES_URL
    ?? "postgresql://postgres@127.0.0.1:5432/postgres";
  const context = {
    caseId: options.caseId,
    workspace: resolve(options.workspace),
    v1Workspace: options.v1Workspace ? resolve(options.v1Workspace) : undefined,
    evaluationSeed: options.evaluationSeed,
    fixtures,
    temporary,
    managedDataRoot: join(temporary, "managed"),
    postgresAdminUrl: basePostgresUrl,
    databaseName: databaseName(options.caseId, runtimeConfig.databasePrefix),
    databaseCreated: false,
    manageDatabase: options.manageDatabase !== false,
    adminToken: `${runtimeConfig.taskSlug}-admin-${randomBytes(24).toString("hex")}`,
    barrierToken: `${runtimeConfig.taskSlug}-barrier-${randomBytes(24).toString("hex")}`,
    compatibilityAdapter: options.compatibilityAdapter,
    taskRuntimeDefaults: parseTaskRuntimeDefaults(),
    runtimeConfig,
    processes: [],
    servers: [],
    disposers: [],
    setupComplete: false,
    teardownComplete: false,
  };
  context.databaseUrl = databaseUrl(basePostgresUrl, context.databaseName);
  context.uuid = fixtures.uuid;
  context.at = fixtures.at;
  context.key = fixtures.key;
  context.tempPath = (...parts) => join(context.temporary, ...parts);
  context.freePort = freePort;
  context.defer = (disposer) => { context.disposers.push(disposer); };
  context.forWorkspace = (workspace) => bindWorkspace(context, resolve(workspace));

  context.setup = async () => {
    if (context.setupComplete) return context;
    try {
      await mkdir(context.managedDataRoot, { recursive: true });
    } catch (cause) {
      throw new EvaluationInfrastructureError("EVALUATOR_TEMP_CREATE_FAILED", "failed to create managed data root", { cause });
    }
    if (context.manageDatabase) await createDatabase(context);
    if (process.env[PREPARE_CANDIDATE_ENV] === "1") {
      await context.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: null });
      await context.npm("build", [], { timeoutMs: null });
    }
    context.setupComplete = true;
    return context;
  };

  context.command = async (binary, args = [], commandOptions = {}) => {
    await publicContract?.command(binary, args, commandOptions);
    const normalized = normalizeOptions(commandOptions);
    return runCommand(binary, args, {
      ...normalized,
      workspace: normalized.workspace ?? context.workspace,
      env: candidateEnvironment(context, normalized.env),
    }).catch(error => {
      error.stage = normalized.stage ?? (binary === 'npm' && args[0] === 'run' ? args[1] : 'command');
      if (error.result?.spawnError) {
        error.origin = 'infrastructure';
        error.code = 'EVALUATOR_COMMAND_UNAVAILABLE';
      } else if (error instanceof CommandError && !error.result?.timedOut && !error.result?.leakedProcessGroup) {
        // The public command/seed boundary above has validated author inputs.
        error.origin = 'candidate';
      }
      throw error;
    });
  };

  context.npm = (script, args = [], commandOptions = {}) => {
    const separator = args.length > 0 ? ["--", ...args] : [];
    return context.command("npm", ["run", script, ...separator], commandOptions);
  };
  context.migrate = (commandOptions = {}) => context.npm("db:migrate", [], normalizeOptions(commandOptions));
  context.seedFile = (path, commandOptions = {}) => {
    if (publicContract) {
      const [binary, ...args] = publicContract.seedCommand(resolve(path));
      return context.command(binary, args, { ...normalizeOptions(commandOptions), stage: 'seed' });
    }
    return context.npm('db:seed', ['--file', resolve(path)], { ...normalizeOptions(commandOptions), stage: 'seed' });
  };
  let seedOrdinal = 0;
  context.seed = async (value, commandOptions = {}) => {
    const path = context.tempPath(`seed-${String(seedOrdinal += 1).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    return context.seedFile(path, commandOptions);
  };

  context.startProcess = (role, script, roleOptions = {}) => startRole(context, role, script, normalizeOptions(roleOptions));
  const startHttpRole = async (role, script, roleOptions = {}) => {
    const normalized = normalizeOptions(roleOptions);
    const port = normalized.port ?? await freePort();
    const record = await startRole(context, role, script, {
      ...normalized,
      env: { PORT: port, ...normalized.env },
    });
    record.port = port;
    record.baseUrl = `http://127.0.0.1:${port}`;
    try {
      await context.waitFor(async () => {
        const response = await context.request(record.baseUrl, normalized.healthPath ?? "/healthz", { timeoutMs: 1_000 }).catch(error => {
          // Connection refusal is expected while this owned process is starting.
          // Do not turn author/transport errors into a candidate health timeout.
          if (error?.origin === undefined && error?.cause?.code === 'ECONNREFUSED') return undefined;
          throw error;
        });
        return response?.status === 200;
      }, {
        timeoutMs: normalized.healthTimeoutMs ?? 30_000,
        intervalMs: 50,
        label: "API health",
        processes: [record],
      });
    } catch (cause) {
      assertCandidateError(cause);
      throw new CandidateResponseError(`API did not become healthy; logs: ${record.logs}`, { cause, record });
    }
    return record;
  };
  context.startDev = (roleOptions = {}) => startHttpRole("dev", "dev", roleOptions);
  context.startApi = (roleOptions = {}) => startHttpRole("api", "start:api", roleOptions);
  context.startWorker = (roleOptions = {}) => startRole(context, "worker", "start:worker", normalizeOptions(roleOptions));
  context.startDispatcher = (roleOptions = {}) => {
    const normalized = normalizeOptions(roleOptions);
    return startRole(context, "dispatcher", "start:dispatcher", {
      ...normalized,
      env: { WEBHOOK_URL: normalized.webhookUrl, ...normalized.env },
    });
  };
  context.stop = async (record, signal = "SIGTERM") => { await stopOwnedProcess(record, signal); return record; };
  context.kill = async (record) => { await stopOwnedProcess(record, "SIGKILL", 0); return record; };

  context.waitFor = async (predicate, waitOptions = {}) => {
    const timeoutMs = waitOptions.timeoutMs ?? 30_000;
    const intervalMs = waitOptions.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() <= deadline) {
      for (const record of waitOptions.processes ?? []) {
        if (!record.stopped && record.child.exitCode !== null) {
          throw new CandidateResponseError(`${record.role} exited before ${waitOptions.label ?? "condition"}; logs: ${record.logs}`, record);
        }
      }
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        const causes = new Set();
        for (let cause = error; cause && !causes.has(cause); cause = cause.cause) {
          causes.add(cause);
          if (["evaluator", "infrastructure"].includes(cause.origin)) throw error;
        }
        if (error?.origin !== 'candidate' && !Number.isInteger(error?.response?.status)) throw error;
        lastError = error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
    }
    throw new CandidateResponseError(
      `timed out waiting for ${waitOptions.label ?? "condition"}${lastError ? `: ${lastError.message ?? String(lastError)}` : ""}`,
      lastError ? { cause: lastError } : undefined,
    );
  };

  context.concurrent = async (values, limit, operation) => {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("concurrency limit must be a positive integer");
    const items = Array.from(values);
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await operation(items[index], index);
      }
    }));
    return results;
  };

  context.request = async (baseUrl, path, requestOptions = {}) => {
    publicContract?.request(path, requestOptions);
    const headers = { ...(requestOptions.headers ?? {}) };
    let body = requestOptions.raw;
    if (Object.hasOwn(requestOptions, "json")) {
      headers["content-type"] ??= "application/json";
      body = JSON.stringify(requestOptions.json);
    }
    const startedAt = performance.now();
    const timeoutMs = requestOptions.timeoutMs ?? 10_000;
    const url = new URL(path, baseUrl);
    const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let response, buffer;
    try {
      response = await fetch(url, {
      method: requestOptions.method ?? "GET",
      headers,
      body,
      redirect: "manual",
      signal,
      });
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      // Only our request deadline to a registered, live candidate API is a
      // submission observation. DNS, external receivers, author mistakes and
      // unrelated fetch failures retain their original attribution.
      const ownedApi = context.processes.some(record => ['api', 'dev'].includes(record.role)
        && !record.stopped && record.child.exitCode === null && record.baseUrl === url.origin);
      if (ownedApi && signal?.aborted && cause === signal.reason && cause.name === 'TimeoutError') {
        throw new CandidateResponseError(`Candidate API did not answer ${requestOptions.method ?? 'GET'} ${url.pathname} within ${timeoutMs} ms`, {
          cause, timeoutMs, method: requestOptions.method ?? 'GET', path: url.pathname,
        });
      }
      throw cause;
    }
    let text = buffer.toString("utf8");
    let json;
    try { json = JSON.parse(text); } catch {}
    const adaptedJson = runtimeConfig.adaptCompatibilityResponse(context.compatibilityAdapter, {
      method: requestOptions.method ?? "GET",
      path,
      status: response.status,
      json,
    });
    if (adaptedJson !== json) {
      json = adaptedJson;
      text = JSON.stringify(json);
      buffer = Buffer.from(text);
    }
    return {
      status: response.status,
      headers: response.headers,
      text: requestOptions.binary ? undefined : text,
      body: requestOptions.binary ? buffer : undefined,
      json,
      durationMs: performance.now() - startedAt,
    };
  };
  context.mutate = (baseUrl, path, key, json = {}, mutationOptions = {}) => {
    if (typeof mutationOptions === "string") mutationOptions = { method: mutationOptions };
    return context.request(baseUrl, path, {
      ...mutationOptions,
      method: mutationOptions.method ?? "POST",
      headers: {
        "idempotency-key": key,
        ...(mutationOptions.admin ? { authorization: `Bearer ${context.adminToken}` } : {}),
        ...(mutationOptions.headers ?? {}),
      },
      json,
    });
  };
  context.snapshot = async (baseUrl, snapshotOptions = {}) => {
    const response = await context.request(baseUrl, runtimeConfig.snapshotPath, {
      headers: { authorization: `Bearer ${snapshotOptions.adminToken ?? context.adminToken}` },
      timeoutMs: snapshotOptions.timeoutMs,
    });
    if (response.status !== 200 || !response.json) {
      throw new CandidateResponseError(`verification snapshot returned ${response.status}: ${response.text}`, response);
    }
    return response.json;
  };
  context.receiver = (receiverOptions = {}) => startReceiver(context, receiverOptions);
  context.responseShield = (upstreamBaseUrl) => startResponseShield(context, upstreamBaseUrl);
  context.barrier = (barrierOptions = {}) => startBarrier(context, barrierOptions);

  context.resetDatabase = async () => {
    if (!context.manageDatabase) throw new EvaluationInfrastructureError("EVALUATOR_DATABASE_UNMANAGED", "cannot reset an unmanaged database");
    for (const record of context.processes.splice(0).reverse()) await stopOwnedProcess(record);
    for (const record of context.servers.splice(0).reverse()) await closeServer(record);
    await dropDatabase(context);
    await rm(context.managedDataRoot, { recursive: true, force: true });
    await mkdir(context.managedDataRoot, { recursive: true });
    context.databaseName = databaseName(context.caseId, runtimeConfig.databasePrefix);
    context.databaseUrl = databaseUrl(context.postgresAdminUrl, context.databaseName);
    await createDatabase(context);
  };

  context.teardown = async () => {
    if (context.teardownComplete) return;
    const failures = [];
    for (const [records, dispose] of [[context.disposers, fn => fn()], [context.processes, stopOwnedProcess], [context.servers, closeServer]]) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        try { await dispose(records[index]); records.splice(index, 1); }
        catch (error) { failures.push(error); }
      }
    }
    try { await dropDatabase(context); } catch (error) { failures.push(error); }
    // Keep failed cleanup resources and seed files available for diagnosis/retry.
    if (failures.length === 0) {
      try { await rm(context.temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new EvaluationInfrastructureError(
        "EVALUATOR_TEARDOWN_FAILED",
        `isolated case teardown failed: ${failures.map((error) => error.message ?? String(error)).join("; ")}`,
        { cause: new AggregateError(failures) },
      );
    }
    context.teardownComplete = true;
  };
  return context;
}

async function withCaseContext(runtimeConfig, options, operation) {
  const context = await createCaseContext(runtimeConfig, options);
  let operationError;
  let operationResult;
  try {
    await context.setup();
    operationResult = await operation(context);
    return operationResult;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await context.teardown();
    } catch (cleanupError) {
      if (operationError) {
        if (typeof operationError === "object" && operationError !== null && operationError.cleanupError === undefined) {
          operationError.cleanupError = cleanupError;
        }
      } else {
        cleanupError.operationResult = operationResult;
        throw cleanupError;
      }
    }
  }
}

function requiredFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

function requiredSlug(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(value)) throw new TypeError(`${label} must be a lowercase slug`);
  return value;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new TypeError(`${label} must be an absolute HTTP path`);
  return value;
}
