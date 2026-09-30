import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, fork } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { contains, validator, expand, requestPath } from "./runtime.mjs";

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
  for (const [name, command] of Object.entries(lock.scripts)) assert.equal(pkg.scripts?.[name], command, `Restore published npm script: ${name}`);
  assert.equal(pkg.type, "module", "package.json type must remain module");
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
  const compile = validator(contract), findings = [], variables = { ...environment };
  for (const item of contract.smoke) {
    const operation = contract.operations.find(op => op.id === item.operationId);
    assert(operation, `Unknown public probe operation: ${item.operationId}`);
    try {
      const example = expand(item, variables), headers = example.headers ?? {};
      const rawBody = example.body === undefined ? undefined : typeof example.body === 'string' && operation.request?.contentMediaType === 'application/octet-stream' ? example.body : JSON.stringify(example.body);
      if (rawBody !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = operation.request?.contentMediaType ?? 'application/json';
      const response = await fetch(new URL(requestPath(operation, example), baseUrl), { method: operation.method, headers, body: rawBody });
      const text = await response.text();
      const noBody = operation.method === 'HEAD' || [204, 304].includes(response.status);
      const schema = (operation.successStatuses ?? [operation.status ?? 200]).includes(response.status) ? operation.successResponses?.[response.status]?.response ?? operation.response : operation.errors?.[response.status] ?? contract.schemas.Error;
      const raw = schema?.contentMediaType && schema.contentMediaType !== 'application/json';
      if (!noBody) {
        const expectedMedia = schema?.contentMediaType ?? (operation.path === '/' && response.ok ? 'text/html' : 'application/json');
        assert.equal((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), expectedMedia, `${operation.id}: response Content-Type`);
      }
      const body = noBody ? undefined : raw || (operation.path === '/' && response.ok) ? text : JSON.parse(text);
      assert.equal(response.status, example.expectStatus ?? operation.status ?? 200, `${operation.id}: HTTP status`);
      if (example.expectBody !== undefined) assert(contains(body, example.expectBody), `${operation.id}: published example mismatch`);
      if (schema && !noBody && !raw) {
        const valid = compile(schema);
        assert(valid(body), `${operation.id}: ${JSON.stringify(valid.errors)}`);
      }
      for (const requirement of example.expectContains ?? []) {
        const rows = requirement.path.reduce((value, key) => value?.[key], body);
        assert(Array.isArray(rows), `${operation.id}: expected array at ${requirement.path.join('.')}`);
        assert.equal(rows.filter(row => contains(row, requirement.match)).length, requirement.count ?? 1, `${operation.id}: nonempty record identity mismatch`);
      }
      for (const [name, path] of Object.entries(item.capture ?? {})) {
        const value = path.reduce((current, key) => current?.[key], body);
        assert.notEqual(value, undefined, `${operation.id}: missing capture ${name}`);
        variables[name] = value;
      }
      if (operation.path === '/openapi.json' && response.ok) {
        assert.match(body.openapi, /^3\.1\./);
        for (const op of contract.operations) {
          const path = op.path.replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, '/{$1}');
          assert(body.paths?.[path]?.[op.method.toLowerCase()], `OpenAPI missing ${op.method} ${path}`);
        }
      }
      findings.push({ operationId: operation.id, passed: true });
    } catch (error) { findings.push({ operationId: operation.id, passed: false, message: error.message }); }
  }
  return { passed: findings.every(item => item.passed), findings };
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
  const seedCommand = expand(contract.seed.command ?? ['npm', 'run', 'db:seed', '--', '--file', '${SEED_PATH}'], { SEED_PATH: join(author, 'seed.example.json') });
  for (let i = 0; i < (contract.seed.replay === false ? 1 : 2); i++) await run(seedCommand[0], seedCommand.slice(1), workspace, environment);
  const children = [];
  let roleFailure;
  try {
    for (const role of ["start:worker", "start:dispatcher"].filter(role => contract.commands.some(command => command.startsWith(`npm run ${role}`)))) {
      const child = spawn(process.execPath, [join(workspace, "dist/lifecycle.js"), role], { cwd: workspace, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"] });
      children.push(child);
      child.once("error", (error) => { roleFailure = error; });
      child.once("exit", (code, signal) => { roleFailure = new Error(`${role} exited before public checks finished (${code ?? signal})`); });
    }
    const api = fork(join(workspace, "contract/server.mjs"), [], { cwd: workspace, env: { ...environment, PORT: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(api);
    const port = await new Promise((done, fail) => {
      api.once("error", fail);
      api.once("exit", (code) => fail(new Error(`API exited before listen (${code})`)));
      api.on("message", (message) => { if (message.kind === "public-api-listening") done(message.port); });
    });
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
