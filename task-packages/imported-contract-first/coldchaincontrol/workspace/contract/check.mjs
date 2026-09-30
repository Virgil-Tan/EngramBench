import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { lstat, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPublicOpenApi, contains, validator } from "./runtime.mjs";

export async function checkSource(workspace, author) {
  const authorLock = await readFile(join(author, "protected.json"), "utf8");
  assert.equal(await readFile(join(workspace, "contract/protected.json"), "utf8"), authorLock, "Restore author-owned protected.json");
  const lock = JSON.parse(authorLock);
  for (const [path, expected] of Object.entries(lock.files)) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."), "Unsafe protected file path");
    const file = join(workspace, path);
    assert((await lstat(file)).isFile(), `Protected file must be a regular file: ${path}`);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), expected, `Restore author-owned file: ${path}`);
  }
  const pkg = JSON.parse(await readFile(join(workspace, "package.json")));
  // Commands are an external interface; their implementation is not ours to fix.
  for (const name of lock.requiredScripts) assert(typeof pkg.scripts?.[name] === "string" && pkg.scripts[name].trim(), `Missing public npm script: ${name}`);
  const contract = JSON.parse(await readFile(join(author, "contract.json")));
  const compile = validator(contract);
  const validSeed = compile(contract.seed.schema);
  assert(validSeed(contract.seed.example), `Invalid AUTHOR seed fixture: ${JSON.stringify(validSeed.errors)}`);
  for (const op of contract.operations) {
    if (op.request) compile(op.request);
    if (op.response) compile(op.response);
  }
  return contract;
}

export async function probe(contract, baseUrl, environment = process.env) {
  const compile = validator(contract);
  const findings = [];
  const captured = Object.create(null);
  const lookup = (name) => {
    if (Object.hasOwn(captured, name)) return captured[name];
    assert(Object.hasOwn(environment, name) && environment[name] !== undefined, `Missing public probe variable: ${name}`);
    return environment[name];
  };
  const expand = (value, url = false) => {
    if (typeof value === "string") {
      const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (exact && !url) return lookup(exact[1]);
      return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
        const replacement = lookup(name);
        assert(["string", "number", "boolean"].includes(typeof replacement), `Non-scalar probe variable: ${name}`);
        return url ? encodeURIComponent(String(replacement)) : String(replacement);
      });
    }
    if (Array.isArray(value)) return value.map((entry) => expand(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
  };
  for (const item of contract.smoke) {
    const operation = contract.operations.find((op) => op.id === item.operationId);
    assert(operation, `Unknown public probe operation: ${item.operationId}`);
    try {
      const headers = expand(item.headers ?? {});
      const input = expand(item.body);
      const rawBody = input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input);
      if (rawBody !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      const response = await fetch(new URL(expand(item.path ?? operation.path, true), baseUrl), { method: operation.method, headers, body: rawBody });
      const text = await response.text();
      const schema = response.ok ? operation.response : operation.errors?.[response.status] ?? contract.schemas.Error;
      const requiresJson = operation.path === "/openapi.json" || (!response.ok && schema) || (schema && schema.type !== "string") || (item.expectBody !== undefined && typeof item.expectBody !== "string");
      // Health routes without a published body contract may return text/empty.
      let body = text;
      if (requiresJson) body = JSON.parse(text);
      else if (operation.path !== "/" && response.headers.get("content-type")?.includes("json") && text) body = JSON.parse(text);
      assert.equal(response.status, item.expectStatus, `${operation.id}: HTTP status`);
      if (item.expectBody !== undefined) assert(contains(body, expand(item.expectBody)), `${operation.id}: published example mismatch`);
      if (schema) {
        const valid = compile(schema);
        assert(valid(body), `${operation.id}: ${JSON.stringify(valid.errors)}`);
      }
      if (operation.path === "/openapi.json" && response.ok) {
        assertPublicOpenApi(body, contract);
      }
      const values = Object.entries(item.capture ?? {}).map(([name, pointer]) => {
        assert(!Object.hasOwn(captured, name) && !Object.hasOwn(environment, name), `Duplicate probe variable: ${name}`);
        assert(typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")), `Invalid capture JSON pointer: ${pointer}`);
        let value = body;
        for (const segment of pointer === "" ? [] : pointer.slice(1).split("/")) {
          const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
          assert(value !== null && typeof value === "object" && Object.hasOwn(value, key), `${operation.id}: missing capture ${pointer}`);
          value = value[key];
        }
        return [name, value];
      });
      Object.assign(captured, Object.fromEntries(values));
      findings.push({ operationId: operation.id, passed: true });
    } catch (error) { findings.push({ operationId: operation.id, passed: false, message: error.message }); }
  }
  return { passed: findings.every((item) => item.passed), findings };
}

async function availablePort() {
  const socket = createServer();
  await new Promise((done, fail) => { socket.once("error", fail); socket.listen(0, "127.0.0.1", done); });
  const { port } = socket.address();
  await new Promise((done, fail) => socket.close((error) => error ? fail(error) : done()));
  return port;
}

async function waitForListener(port, failure) {
  // Readiness polling, not a task/turn deadline. A role exit fails immediately.
  while (true) {
    if (failure()) throw failure();
    const listening = await new Promise((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); done(true); });
      socket.once("error", () => { socket.destroy(); done(false); });
    });
    if (listening) return;
    await delay(100);
  }
}

async function run(command, args, cwd, environment) {
  const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "inherit", "inherit"] });
  await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => code === 0 ? done() : fail(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`)));
  });
}

export async function checkLive(workspace, author, environment = process.env) {
  const contract = await checkSource(workspace, author);
  // Always an isolated checkout + database when invoked by the official gate.
  try {
    for (const key of ["DATABASE_URL", "ADMIN_TOKEN"]) assert(environment[key], `Missing environment: ${key}`);
    await run("npm", ["ci", "--no-audit", "--no-fund"], workspace, environment);
  } catch (error) { error.preparationFailed = true; throw error; }
  await run("npm", ["run", "build"], workspace, environment);
  for (let i = 0; i < 2; i++) await run("npm", ["run", "db:migrate"], workspace, environment);
  for (let i = 0; i < 2; i++) await run("npm", ["run", "db:seed", "--", "--file", join(author, "seed.example.json")], workspace, environment);
  const children = [];
  let roleFailure;
  try {
    const port = await availablePort();
    for (const role of ["start:worker", "start:dispatcher", "start:api"]) {
      const child = spawn("npm", ["run", role], { cwd: workspace, env: { ...environment, ...(role === "start:api" && { PORT: String(port) }) }, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"] });
      children.push(child);
      child.once("error", (error) => { roleFailure = error; });
      child.once("exit", (code, signal) => { roleFailure = new Error(`${role} exited before public checks finished (${code ?? signal})`); });
    }
    await waitForListener(port, () => roleFailure);
    const result = await probe(contract, `http://127.0.0.1:${port}`, environment);
    // Detect modifications performed by build/migrate/seed/roles as well.
    await checkSource(workspace, author);
    if (roleFailure) result.findings.push({ operationId: "production-roles", passed: false, message: roleFailure.message });
    result.passed = result.findings.every((item) => item.passed);
    return result;
  } finally {
    for (const child of children) if (child.pid) {
      try {
        // Each detached child leads a fresh group owned solely by this check.
        // Never signal the caller's/shared process group.
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else if (child.exitCode === null) child.kill("SIGTERM");
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode ? undefined : new Promise((done) => child.once("exit", done))));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const workspace = resolve(option("--workspace", "."));
  const author = resolve(option("--author", join(workspace, "contract")));
  try {
    const result = args.includes("--live") ? await checkLive(workspace, author) : (await checkSource(workspace, author), { passed: true, mode: "source-only" });
    console.log(JSON.stringify({ kind: "frontal-public-contract-result", ...result }));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ kind: "frontal-public-contract-result", passed: false, ...(error.preparationFailed && { preparationFailed: true }), message: error.message }));
    process.exitCode = 1;
  }
}
