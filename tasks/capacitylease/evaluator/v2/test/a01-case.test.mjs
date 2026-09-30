import assert from "node:assert/strict";
import test from "node:test";

import { A_CASES } from "../cases/a.mjs";
import { executeCase } from "../lib/execution.mjs";

const definition = { id: "A-01", dimension: "A", weight: 2 };
const implementation = A_CASES.find(({ id }) => id === definition.id);

test("real A-01 case passes only when all published commands and roles work", async () => {
  const context = fakeContext();
  const outcome = await executeCase({
    definition,
    implementation,
    withContext: async (_options, operation) => operation(context),
    contextOptions: {},
    failureCodePrefix: "CL_A01_",
  });

  assert.equal(outcome.status, "passed");
  assert.deepEqual(context.started, ["api", "worker", "dispatcher", "dev"]);
  assert.equal(context.processes.every(({ child }) => child.exitCode === 0), true);
});

test("real A-01 case records a missing public command as a candidate failure", async () => {
  const context = fakeContext({ omitScript: "test:perf" });
  const outcome = await executeCase({
    definition,
    implementation,
    withContext: async (_options, operation) => operation(context),
    contextOptions: {},
    failureCodePrefix: "CL_A01_",
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.privateFailureCode, /^CL_A01_/u);
  assert.deepEqual(outcome.hardCapIds, ["BUILD_MIGRATION_OR_BOOT"]);
});

function fakeContext({ omitScript } = {}) {
  const required = [
    "db:migrate", "db:seed", "dev", "build", "start:api", "start:worker", "start:dispatcher",
    "test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:all", "test:perf",
  ];
  const scripts = Object.fromEntries(required.filter((name) => name !== omitScript).map((name) => [name, "command"]));
  const context = {
    started: [],
    processes: [],
    command: async (_binary, args) => args[0] === "pkg"
      ? { exitCode: 0, stdout: JSON.stringify(scripts), stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" },
    migrate: async () => ({ exitCode: 0 }),
    npm: async () => ({ exitCode: 0 }),
    receiver: async () => ({ url: "http://127.0.0.1:4000/events" }),
    request: async () => ({ status: 200, json: {} }),
  };
  const start = async (role) => {
    const process = {
      role,
      pid: context.processes.length + 1,
      baseUrl: "http://127.0.0.1:3000",
      child: { exitCode: null, signalCode: null },
    };
    process.exited = Promise.resolve([0, null]);
    context.started.push(role);
    context.processes.push(process);
    return process;
  };
  context.startApi = () => start("api");
  context.startWorker = () => start("worker");
  context.startDispatcher = () => start("dispatcher");
  context.startDev = () => start("dev");
  context.stop = async (process) => { process.child.exitCode = 0; };
  return context;
}
