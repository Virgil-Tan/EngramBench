import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConversationHarness } from "../src/conversation-harness.mjs";

test("runs the same complete lifecycle through an arbitrary Agent Driver", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  const harness = fixture({ events, driverId: "opencode", passed: true });

  const result = await runConversationHarness({
    ...harness,
    statePath: join(root, "state.json"),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.agentDriverId, "opencode");
  assert.equal(result.checkpointEligible, true);
  assert.equal(result.checkpointSource.submissionId, "submission-1");
  assert.deepEqual(
    result.turns.map(({ phase }) => phase),
    ["plan_handoff", "implementation", "delivery", "delivery_review", "test_feedback", "skill_evolution"],
  );
  assert.match(result.turns[0].message, /<task-readme>[\s\S]*Build the public project/u);
  assert.match(result.turns[0].message, /<execution-plan>[\s\S]*Use the frozen stages/u);
  assert.equal(result.planDigest, harness.task.planDigest);
  assert.equal(harness.userAgent.calls.includes("planning"), false);
  assert.match(result.turns[4].message, /"passed": true/u);
  assert.deepEqual(events, [
    "supports:opencode:owner-1",
    "open:opencode:owner-1",
    "agent:plan_handoff",
    "agent:implementation",
    "agent:delivery",
    "agent:delivery_review",
    "freeze",
    "hidden-tests",
    "agent:test_feedback",
    "evolution:owner-1",
    "agent:skill_evolution",
    "close:completed",
  ]);
});

test("failed hidden tests still reach feedback and Skill Evolution", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  const result = await runConversationHarness({
    ...fixture({ events, driverId: "codex", passed: false }),
    statePath: join(root, "state.json"),
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.taskOutcome, "failed");
  assert.equal(result.checkpointEligible, false);
  assert.equal(result.evolution.status, "completed");
  assert.equal(events.includes("agent:test_feedback"), true);
  assert.equal(events.includes("agent:skill_evolution"), true);
});

test("pending Evolution work blocks a downstream checkpoint", async (t) => {
  const root = await temporaryRoot(t);
  const result = await runConversationHarness({
    ...fixture({
      events: [],
      driverId: "codex",
      passed: true,
      evolutionStatus: "completed_with_pending_work",
    }),
    statePath: join(root, "state.json"),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evolution.status, "completed_with_pending_work");
  assert.equal(result.checkpointEligible, false);
});

test("allows a future transcript-based Evolution Adapter without spoofing a Codex turn", async (t) => {
  const root = await temporaryRoot(t);
  const harness = fixture({ events: [], driverId: "opencode", passed: true });
  harness.evolution.run = async ({ owner, transcript }) => ({
    status: "completed",
    mode: "transcript",
    ownerId: owner.id,
    evidenceTurns: transcript.length,
  });

  const result = await runConversationHarness({
    ...harness,
    statePath: join(root, "state.json"),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evolution.mode, "transcript");
  assert.equal(result.turns.some(({ phase }) => phase === "skill_evolution"), false);
});

test("resumes a pending Agent turn without asking the User Agent twice", async (t) => {
  const root = await temporaryRoot(t);
  const statePath = join(root, "state.json");
  const events = [];
  let failFirstTurn = true;
  const harness = fixture({ events, driverId: "claude-code", passed: true });
  const originalOpen = harness.agentDriver.open;
  harness.agentDriver.open = async (context) => {
    const session = await originalOpen(context);
    const originalSend = session.send;
    session.send = async (turn) => {
      if (failFirstTurn) {
        failFirstTurn = false;
        events.push("agent:plan_handoff:interrupted");
        throw new Error("simulated interruption");
      }
      return await originalSend(turn);
    };
    return session;
  };

  await assert.rejects(
    runConversationHarness({ ...harness, statePath }),
    /simulated interruption/u,
  );
  const interrupted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(interrupted.turns[0].status, "pending");
  assert.equal(interrupted.turns[0].attempts, 1);

  const result = await runConversationHarness({ ...harness, statePath, resume: true });
  assert.equal(result.status, "passed");
  assert.equal(result.turns[0].attempts, 2);
  assert.equal(harness.userAgent.calls.includes("planning"), false);
});

test("supersedes an interrupted Evolution control turn when its task-run request changed", async (t) => {
  const root = await temporaryRoot(t);
  const statePath = join(root, "state.json");
  const harness = fixture({ events: [], driverId: "codex", passed: false });
  let evolutionPrompt = "legacy Evolution request";
  harness.evolution.run = async ({ exchange }) => {
    await exchange(evolutionPrompt);
    return { status: "completed" };
  };
  const originalOpen = harness.agentDriver.open;
  let interruptEvolution = true;
  const sentEvolutionPrompts = [];
  harness.agentDriver.open = async (context) => {
    const session = await originalOpen(context);
    const originalSend = session.send;
    session.send = async (turn) => {
      if (turn.phase === "skill_evolution") {
        sentEvolutionPrompts.push(turn.message);
        if (interruptEvolution) {
          interruptEvolution = false;
          throw new Error("simulated Evolution interruption");
        }
      }
      return await originalSend(turn);
    };
    return session;
  };

  await assert.rejects(runConversationHarness({ ...harness, statePath }), /Evolution interruption/u);
  evolutionPrompt = "task_run_id=run-1 outcome=negative";
  const result = await runConversationHarness({ ...harness, statePath, resume: true });

  const evolutionTurns = result.turns.filter(({ phase }) => phase === "skill_evolution");
  assert.deepEqual(evolutionTurns.map(({ status }) => status), ["superseded", "completed"]);
  assert.equal(evolutionTurns[0].supersededReason, "evolution_request_changed");
  assert.deepEqual(sentEvolutionPrompts, ["legacy Evolution request", evolutionPrompt]);
});

test("reuses the same User Agent operation after an interrupted decision", async (t) => {
  const root = await temporaryRoot(t);
  const statePath = join(root, "state.json");
  const harness = fixture({ events: [], driverId: "codex", passed: true });
  const originalNext = harness.userAgent.next.bind(harness.userAgent);
  const operationIds = [];
  let interrupted = true;
  harness.userAgent.next = async (context) => {
    operationIds.push(context.operationId);
    if (interrupted) {
      interrupted = false;
      throw new Error("simulated user-provider interruption");
    }
    return await originalNext(context);
  };

  await assert.rejects(runConversationHarness({ ...harness, statePath }), /user-provider interruption/u);
  const result = await runConversationHarness({ ...harness, statePath, resume: true });

  assert.equal(result.status, "passed");
  assert.equal(operationIds[0], operationIds[1]);
});

test("does not impose a development-turn limit", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  const harness = fixture({ events, driverId: "codex", passed: true });
  const originalNext = harness.userAgent.next.bind(harness.userAgent);
  let extraTurns = 130;
  harness.userAgent.next = async (context) => context.phase === "implementation" && extraTurns-- > 0
    ? { action: "status_check", message: "请继续根据当前状态推进。" }
    : await originalNext(context);

  const result = await runConversationHarness({
    ...harness,
    statePath: join(root, "state.json"),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.turns.filter(({ phase }) => phase === "implementation").length, 131);
  assert.equal(events.includes("hidden-tests"), true);
});

test("rejects an unsupported Agent before creating run state", async (t) => {
  const root = await temporaryRoot(t);
  const statePath = join(root, "state.json");
  let opened = false;
  const harness = fixture({ events: [], driverId: "pi", passed: true });
  harness.agentDriver.open = async () => {
    opened = true;
    throw new Error("must not open");
  };
  harness.evolution.supports = async () => false;

  await assert.rejects(
    runConversationHarness({ ...harness, statePath }),
    (error) => error.code === "agent_evolution_unsupported",
  );
  assert.equal(opened, false);
  await assert.rejects(readFile(statePath), (error) => error.code === "ENOENT");
});

test("rejects a mismatched frozen Plan digest before opening adapters", async (t) => {
  const root = await temporaryRoot(t);
  const statePath = join(root, "state.json");
  const harness = fixture({ events: [], driverId: "opencode", passed: true });
  harness.task.planDigest = "0".repeat(64);
  let opened = false;
  harness.agentDriver.open = async () => {
    opened = true;
    throw new Error("must not open");
  };

  await assert.rejects(
    runConversationHarness({ ...harness, statePath }),
    /task\.planDigest does not match task\.executionPlan/u,
  );
  assert.equal(opened, false);
  await assert.rejects(readFile(statePath), (error) => error.code === "ENOENT");
});

test("paired runs receive the exact same frozen Plan handoff", async (t) => {
  const root = await temporaryRoot(t);
  const left = fixture({ events: [], driverId: "opencode", passed: true });
  const right = fixture({ events: [], driverId: "opencode", passed: true });
  right.runId = "run-2";

  const [control, treatment] = await Promise.all([
    runConversationHarness({ ...left, statePath: join(root, "control.json") }),
    runConversationHarness({ ...right, statePath: join(root, "treatment.json") }),
  ]);

  assert.equal(control.planDigest, treatment.planDigest);
  assert.equal(control.turns[0].message, treatment.turns[0].message);
  assert.deepEqual(left.userAgent.calls, right.userAgent.calls);
  assert.equal(left.userAgent.calls.includes("planning"), false);
});

function fixture({ events, driverId, passed, evolutionStatus = "completed" }) {
  const userDecisions = {
    implementation: [
      { action: "message", message: "请实现计划的第一部分。" },
      { action: "deliver", message: "请完成最终检查并正式交付。" },
    ],
    delivery_review: [
      { action: "message", message: "交付说明还不完整，请补充最终验证和剩余风险。" },
      { action: "accept" },
    ],
    test_feedback: [{ action: "message", message: "自动化验证已完成，请只确认收到结果。" }],
  };
  const calls = [];
  const userAgent = {
    calls,
    async next({ phase }) {
      calls.push(phase);
      const decision = userDecisions[phase]?.shift();
      if (!decision) throw new Error(`unexpected user phase ${phase}`);
      return decision;
    },
  };
  const agentDriver = {
    id: driverId,
    async open({ owner, sessionId }) {
      events.push(`open:${driverId}:${owner.id}`);
      const id = sessionId ?? `${driverId}-session`;
      return {
        id,
        workspace: { id: `${driverId}-workspace`, path: "/workspace" },
        async send({ phase, message }) {
          events.push(`agent:${phase}`);
          return {
            sessionId: id,
            message: phase === "plan_handoff" ? "Frozen Plan acknowledged" : `Completed ${phase}`,
            echoedCharacters: message.length,
          };
        },
        async close({ reason }) {
          events.push(`close:${reason}`);
        },
      };
    },
  };
  const evaluator = {
    async freeze({ workspace }) {
      assert.equal(workspace.id, `${driverId}-workspace`);
      events.push("freeze");
      return { id: "submission-1", digest: "a".repeat(64) };
    },
    async run() {
      events.push("hidden-tests");
      return {
        passed,
        feedback: { passed: passed ? 7 : 4, total: 7, failures: passed ? [] : ["observable contract mismatch"] },
        reportDigest: "b".repeat(64),
      };
    },
  };
  const evolution = {
    async supports({ agentDriverId, owner }) {
      events.push(`supports:${agentDriverId}:${owner.id}`);
      return true;
    },
    async run({ owner, exchange }) {
      events.push(`evolution:${owner.id}`);
      await exchange("请在当前 Session 执行 Skill Evolution，并等待到终态。");
      return { status: evolutionStatus, skillRefs: ["skill-1"] };
    },
  };
  return {
    task: {
      schemaVersion: 1,
      id: "example-task",
      readme: "Build the public project according to this contract.",
      executionPlan: "Use the frozen stages and do not replace them.",
      planDigest: sha256("Use the frozen stages and do not replace them."),
    },
    owner: { id: "owner-1" },
    runId: "run-1",
    agentDriver,
    userAgent,
    evaluator,
    evolution,
  };
}

for (const handoffContext of ["", "Read MIGRATION.md and reuse legacy/."]) test(`${handoffContext ? "migration" : "from-scratch development"} freezes after public checks without testing, scoring or evolving, and can resume that submission`, async (t) => {
  const root = await temporaryRoot(t), statePath = join(root, "migration.json"), events = [];
  const harness = fixture({ events, driverId: "codex", passed: true });
  const options = {
    ...harness, statePath, handoffContext,
    publicContractCheck: async () => {
      events.push("public-check");
      return { passed: true, summary: "Public only", workspaceDigest: "a".repeat(64) };
    },
  };
  const paused = await runConversationHarness({ ...options, pauseBeforeEvaluation: true });
  assert.equal(paused.status, "awaiting_evaluation");
  assert.equal(paused.phase, "testing");
  assert.equal(paused.submission.id, "submission-1");
  assert.equal(paused.evaluation, undefined);
  assert.equal(paused.taskOutcome, undefined);
  assert.equal(paused.evolution, undefined);
  assert.equal(paused.finishedAt, undefined);
  assert.equal(paused.checkpointEligible, false);
  if (handoffContext) assert.match(paused.turns[0].message, /Read MIGRATION.md and reuse legacy/);
  else {
    assert.doesNotMatch(paused.turns[0].message, /MIGRATION|legacy\//);
    assert.match(paused.turns[0].message, /Use the frozen Execution Plan/);
  }
  assert(!events.includes("hidden-tests"));
  assert(!events.includes("agent:test_feedback"));
  assert(!events.includes("evolution:owner-1"));
  assert(events.indexOf("public-check") < events.indexOf("freeze"));
  const completed = await runConversationHarness({ ...options, resume: true });
  assert.equal(completed.status, "passed");
  assert.equal(completed.submission.id, paused.submission.id);
  assert.equal(events.filter(item => item === "freeze").length, 1);
  assert.equal(events.filter(item => item === "public-check").length, 1);
  assert.equal(events.filter(item => item === "hidden-tests").length, 1);
});

test("migration pause cannot skip the public gate or change the original handoff on resume", async (t) => {
  const root = await temporaryRoot(t), statePath = join(root, "migration.json");
  const harness = fixture({ events: [], driverId: "codex", passed: false });
  await assert.rejects(runConversationHarness({ ...harness, statePath, pauseBeforeEvaluation: true }), /author public contract/);
  const options = { ...harness, statePath, pauseBeforeEvaluation: true, handoffContext: "reuse legacy", publicContractCheck: async () => ({ passed: true, summary: "public", workspaceDigest: "a".repeat(64) }) };
  await runConversationHarness(options);
  await assert.rejects(runConversationHarness({ ...options, resume: true, handoffContext: "rewrite everything" }), /handoff context differs/);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("public gate diagnostics return to the same agent before freeze, then recheck", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  const harness = fixture({ events, driverId: "codex", passed: true });
  const originalNext = harness.userAgent.next;
  let reviewCalls = 0;
  harness.userAgent.next = async (input) => {
    if (input.phase === "delivery_review" && ++reviewCalls > 2) return { action: "accept" };
    return originalNext(input);
  };
  let checks = 0;
  const result = await runConversationHarness({
    ...harness, statePath: join(root, "state.json"),
    publicContractCheck: async () => {
      events.push("public-check");
      return { passed: ++checks > 1, summary: checks === 1 ? "Published snapshot envelope is missing resources." : "passed", workspaceDigest: "a".repeat(64) };
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(checks, 2);
  assert.equal(result.publicContractChecks.length, 2);
  const repair = result.turns.find((turn) => turn.message.includes("Published snapshot envelope"));
  assert(repair);
  assert.match(repair.message, /not hidden-test feedback/);
  assert.equal(result.sessionId, "codex-session");
  const first = events.indexOf("public-check");
  assert.deepEqual(events.slice(first, first + 4), ["public-check", "agent:delivery_review", "public-check", "freeze"]);
});

test("public gate infrastructure exception never starts hidden tests or a repair turn", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  await assert.rejects(runConversationHarness({
    ...fixture({ events, driverId: "codex", passed: true }), statePath: join(root, "state.json"),
    publicContractCheck: async () => { throw new Error("Docker is unavailable"); },
  }), /Docker is unavailable/);
  assert(!events.includes("freeze"));
  assert(!events.includes("hidden-tests"));
  assert.equal(events.filter((item) => item === "agent:delivery_review").length, 1);
});

test("a changed frozen source cannot proceed to hidden evaluation", async (t) => {
  const root = await temporaryRoot(t);
  const events = [];
  await assert.rejects(runConversationHarness({
    ...fixture({ events, driverId: "codex", passed: true }), statePath: join(root, "state.json"),
    publicContractCheck: async () => ({ passed: true, summary: "passed", workspaceDigest: "c".repeat(64) }),
  }), /differs from the source/);
  assert(events.includes("freeze"));
  assert(!events.includes("hidden-tests"));
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "conversation-harness-test-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}
