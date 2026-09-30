import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CommandError,
  createCaseContext,
  withCaseContext,
} from "../lib/runtime.mjs";

async function writeCandidate(workspace) {
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      "db:migrate": "node command.mjs migrate",
      "db:seed": "node command.mjs seed",
      dev: "node server.mjs",
      "start:api": "node server.mjs",
      "start:worker": "node daemon.mjs worker",
      "start:dispatcher": "node daemon.mjs dispatcher",
    },
  }));
  await writeFile(join(workspace, "command.mjs"), `
    import { appendFile } from "node:fs/promises";
    await appendFile(process.env.MANAGED_DATA_ROOT + "/commands", JSON.stringify({ args: process.argv.slice(2), databaseUrl: process.env.DATABASE_URL }) + "\\n");
  `);
  await writeFile(join(workspace, "server.mjs"), `
    import { createServer } from "node:http";
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      } else if (request.url === "/api/v1/verification-snapshot") {
        response.writeHead(request.headers.authorization === "Bearer " + process.env.ADMIN_TOKEN ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify({ asOf: "2035-01-01T00:00:00.000Z", resources: {}, work: [], events: [] }));
      } else {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ method: request.method, body: body ? JSON.parse(body) : null, key: request.headers["idempotency-key"] }));
      }
    });
    server.listen(Number(process.env.PORT), "127.0.0.1");
  `);
  await writeFile(join(workspace, "daemon.mjs"), `setInterval(() => {}, 1_000); console.log(process.argv[2] + " ready");`);
}

test("case context runs npm/public HTTP roles and tears down owned process groups", async () => {
  let records;
  await withCaseContext({
    caseId: "runtime-lifecycle",
    workspace: process.cwd(),
    evaluationSeed: "runtime-test",
    baseTime: "2035-01-01T00:00:00.000Z",
    manageDatabase: false,
  }, async (ctx) => {
    const workspace = ctx.tempPath("candidate");
    await writeCandidate(workspace);
    ctx.workspace = workspace;
    await mkdir(ctx.managedDataRoot, { recursive: true });

    assert.equal((await ctx.migrate()).exitCode, 0);
    assert.equal((await ctx.seed({ schemaVersion: 1 })).exitCode, 0);

    const api = await ctx.startApi();
    const dev = await ctx.startDev();
    const worker = await ctx.startWorker();
    const dispatcher = await ctx.startDispatcher({ webhookUrl: "http://127.0.0.1:1/events" });
    records = [api, dev, worker, dispatcher];

    const response = await ctx.mutate(api.baseUrl, "/api/v1/capacity-leases", "idem-1", { units: 2 });
    assert.equal(response.status, 201);
    assert.deepEqual(response.json, { method: "POST", body: { units: 2 }, key: "idem-1" });
    assert.deepEqual(await ctx.snapshot(api.baseUrl), {
      asOf: "2035-01-01T00:00:00.000Z",
      resources: {},
      work: [],
      events: [],
    });
    assert.equal(records.every((record) => record.child.exitCode === null), true);
  });

  await Promise.all(records.map((record) => record.exited));
  assert.equal(records.every((record) => record.child.exitCode !== null || record.child.signalCode !== null), true);
});

test("normal stop records when a Candidate process requires SIGKILL", async () => {
  const ctx = await createCaseContext({
    caseId: "forced-stop",
    workspace: process.cwd(),
    evaluationSeed: "forced-stop-test",
    baseTime: "2035-01-01T00:00:00.000Z",
    manageDatabase: false,
  });
  try {
    const workspace = ctx.tempPath("candidate");
    await writeCandidate(workspace);
    await writeFile(join(workspace, "daemon.mjs"), `
      process.on("SIGTERM", () => {});
      console.log("signal handler ready");
      setInterval(() => {}, 1_000);
    `);
    ctx.workspace = workspace;
    const worker = await ctx.startWorker();
    await ctx.waitFor(() => worker.stdout.includes("signal handler ready"), { label: "signal handler" });
    await ctx.stop(worker);
    assert.equal(worker.forcedKill, true);
  } finally {
    await ctx.teardown();
  }
});

test("command captures output, reports failures, and supports allowFailure", async () => {
  const ctx = await createCaseContext({
    caseId: "command",
    workspace: process.cwd(),
    evaluationSeed: "command-test",
    baseTime: "2035-01-01T00:00:00.000Z",
    manageDatabase: false,
  });
  try {
    const ok = await ctx.command(process.execPath, ["-e", "console.log('visible-output')"]);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /visible-output/u);

    const bound = ctx.forWorkspace(ctx.temporary);
    const location = await bound.command(process.execPath, ["-e", "console.log(process.cwd())"]);
    assert.equal(await realpath(location.stdout.trim()), await realpath(ctx.temporary));

    const allowed = await ctx.command(process.execPath, ["-e", "console.error('expected-failure'); process.exit(7)"], { allowFailure: true });
    assert.equal(allowed.exitCode, 7);
    assert.match(allowed.stderr, /expected-failure/u);

    await assert.rejects(
      ctx.command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { allowFailure: true, timeoutMs: 20 }),
      (error) => error instanceof CommandError && error.result.timedOut === true,
    );

    await assert.rejects(
      ctx.command(process.execPath, ["-e", "process.exit(9)"]),
      (error) => error instanceof CommandError && error.result.exitCode === 9,
    );

    let leakedPid;
    await assert.rejects(
      ctx.command(process.execPath, ["-e", `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        console.log(child.pid);
        child.unref();
      `]),
      (error) => {
        leakedPid = Number(error.result.stdout.trim());
        return error instanceof CommandError && error.result.leakedProcessGroup === true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    let running = true;
    try { process.kill(leakedPid, 0); } catch { running = false; }
    if (running && process.platform === "linux") {
      const stat = await readFile(`/proc/${leakedPid}/stat`, "utf8").catch(() => "");
      running = stat !== "" && stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    assert.equal(running, false, "leaked command descendant is still running");
  } finally {
    await ctx.teardown();
  }
});

test("receiver, response shield, and recovery barrier expose only HTTP seams", async () => {
  await withCaseContext({
    caseId: "http-controls",
    workspace: process.cwd(),
    evaluationSeed: "http-controls",
    baseTime: "2035-01-01T00:00:00.000Z",
    manageDatabase: false,
  }, async (ctx) => {
    const receiver = await ctx.receiver({
      path: "/custom-events",
      behavior: (entry) => ({ status: entry.json?.retry ? 500 : 202, json: { accepted: true } }),
    });
    const delivered = await ctx.request(receiver.baseUrl, "/custom-events", { method: "POST", json: { retry: false } });
    assert.equal(delivered.status, 202);
    assert.deepEqual(delivered.json, { accepted: true });
    assert.equal(receiver.ledger.length, 1);
    assert.deepEqual(receiver.ledger[0].json, { retry: false });

    const shield = await ctx.responseShield(receiver.baseUrl);
    shield.dropNextMutation();
    await assert.rejects(ctx.request(shield.baseUrl, "/custom-events", { method: "POST", json: { committed: true } }));
    await ctx.waitFor(() => shield.captures.length === 1, { label: "shield capture" });
    assert.equal(shield.captures[0].response.status, 202);

    const barrier = await ctx.barrier({
      path: "/recovery",
      hold: (payload) => payload.point === "worker.before-commit",
    });
    const payload = {
      schemaVersion: 1,
      processRole: "worker",
      point: "worker.before-commit",
      workId: ctx.uuid("work"),
      aggregateId: ctx.uuid("aggregate"),
      attempt: 1,
      leaseTokenHash: "a".repeat(64),
    };
    const pending = ctx.request(barrier.baseUrl, "/recovery", {
      method: "POST",
      headers: { "x-test-barrier-token": barrier.token },
      json: payload,
    });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.before-commit");
    assert.equal(held.released, false);
    barrier.release(held);
    assert.equal((await pending).status, 204);
  });
});

test("concurrent limits active work and preserves result order", async () => {
  const ctx = await createCaseContext({
    caseId: "concurrent",
    workspace: process.cwd(),
    evaluationSeed: "concurrent-test",
    baseTime: "2035-01-01T00:00:00.000Z",
    manageDatabase: false,
  });
  let active = 0;
  let peak = 0;
  try {
    const results = await ctx.concurrent([3, 1, 2, 0], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value * 3));
      active -= 1;
      return value * 10;
    });
    assert.deepEqual(results, [30, 10, 20, 0]);
    assert.equal(peak, 2);
  } finally {
    await ctx.teardown();
  }
});
