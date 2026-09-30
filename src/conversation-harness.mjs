import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { BenchError, asFailure } from "./errors.mjs";
import { writeJsonAtomic } from "./files.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const TERMINAL_STATUSES = new Set(["passed", "rejected"]);
const SUCCESSFUL_EVOLUTION = new Set(["completed", "completed_with_pending_work", "deferred"]);

/**
 * Runs one README-driven project conversation without knowing which coding
 * agent, user model, evaluator, or Skill Evolution implementation is used.
 */
export async function runConversationHarness({
  task: rawTask,
  owner: rawOwner,
  runId,
  statePath,
  agentDriver,
  userAgent,
  evaluator,
  publicContractCheck,
  handoffContext = "",
  pauseBeforeEvaluation = false,
  evolution,
  resume = false,
  now = () => new Date().toISOString(),
}) {
  const task = validateConversationTask(rawTask);
  const owner = validateOwner(rawOwner);
  identifier(runId, "runId");
  nonEmpty(statePath, "statePath");
  validateAdapters({ agentDriver, userAgent, evaluator, evolution });
  if (typeof handoffContext !== "string" || typeof pauseBeforeEvaluation !== "boolean") fail("Invalid handoff/evaluation pause options");
  if (pauseBeforeEvaluation && typeof publicContractCheck !== "function") fail("An evaluation pause requires the author public contract check");

  const taskDigest = digest(task);
  let state = await loadOptionalState(statePath);
  if (state && !resume) throw new BenchError("conversation_exists", `Conversation run ${runId} already exists`);
  if (!state && resume) throw new BenchError("conversation_resume_missing", `Conversation run ${runId} does not exist`);
  if (state) validateStoredState(state, { task, owner, runId, taskDigest, agentDriver });
  if (state && (state.handoffContext ?? "") !== handoffContext) fail("Stored handoff context differs from this run");
  if (state && TERMINAL_STATUSES.has(state.status)) return cloneJson(state, "state");

  if (!state || state.phase !== "finished") {
    const supported = await evolution.supports({
      agentDriverId: agentDriver.id,
      owner: cloneJson(owner, "owner"),
      task: cloneJson(task, "task"),
    });
    if (supported !== true) {
      throw new BenchError(
        "agent_evolution_unsupported",
        `Agent Driver ${agentDriver.id} does not support the required Session Skill Evolution`,
      );
    }
  }

  if (!state) {
    state = {
      schemaVersion: 1,
      kind: "conversation-harness-run",
      runId,
      taskId: task.id,
      taskDigest,
      planDigest: task.planDigest,
      ...(handoffContext ? { handoffContext } : {}),
      ownerId: owner.id,
      agentDriverId: agentDriver.id,
      status: "running",
      phase: "plan_handoff",
      nextDecision: 1,
      nextTurn: 1,
      turns: [],
      startedAt: now(),
      updatedAt: now(),
    };
    await saveState(statePath, state, now);
  }

  state.status = "running";
  delete state.failure;
  delete state.finishedAt;
  await saveState(statePath, state, now);

  let session;
  let closeAttempted = false;
  try {
    session = await agentDriver.open({
      owner: cloneJson(owner, "owner"),
      task: cloneJson(task, "task"),
      runId,
      sessionId: state.sessionId,
      workspaceRef: state.workspaceRef,
      turnIndex: state.turns.filter(({ status }) => status === "completed").length,
    });
    validateSession(session);
    const workspaceRef = cloneJson(session.workspace, "Agent Driver session.workspace");
    object(workspaceRef, "Agent Driver session.workspace");
    nonEmpty(workspaceRef.id, "Agent Driver session.workspace.id");
    if (state.workspaceRef?.id && state.workspaceRef.id !== workspaceRef.id) {
      throw new BenchError("agent_workspace_changed", "Agent Driver changed workspace during one conversation");
    }
    state.workspaceRef = workspaceRef;
    if (nonBlank(session.id)) {
      assertStableSession(state, session.id);
      state.sessionId = session.id;
      await saveState(statePath, state, now);
    }

    const context = {
      task,
      owner,
      runId,
      state,
      statePath,
      session,
      userAgent,
      evaluator,
      publicContractCheck,
      handoffContext,
      pauseBeforeEvaluation,
      evolution,
      now,
    };
    const pending = state.turns.filter(({ status }) => status === "pending");
    if (pending.length > 1) throw new BenchError("conversation_state_invalid", "Conversation has multiple pending turns");
    if (pending[0] && pending[0].phase !== "skill_evolution") {
      await completeTurn(context, pending[0]);
    }

    const paused = await advanceConversation(context);
    closeAttempted = true;
    await session.close({ reason: paused ? "awaiting_evaluation" : "completed" });

    if (paused) {
      state.status = "awaiting_evaluation";
      state.checkpointEligible = false;
      state.pausedAt = now();
      await saveState(statePath, state, now);
      return cloneJson(state, "state");
    }
    delete state.pausedAt;

    state.status = state.evaluation.passed ? "passed" : "rejected";
    state.taskOutcome = state.evaluation.passed ? "passed" : "failed";
    state.checkpointEligible = state.evaluation.passed && state.evolution.status === "completed";
    if (state.checkpointEligible) {
      state.checkpointSource = {
        submissionId: state.submission.id,
        ...(state.submission.digest === undefined ? {} : { digest: state.submission.digest }),
      };
    } else delete state.checkpointSource;
    state.phase = "finished";
    state.finishedAt = now();
    await saveState(statePath, state, now);
    return cloneJson(state, "state");
  } catch (error) {
    let cleanupFailure;
    if (session && !closeAttempted) {
      closeAttempted = true;
      try {
        await session.close({ reason: "failed" });
      } catch (closeError) {
        cleanupFailure = asFailure(closeError, "agent_close_failed");
      }
    }
    state.status = "failed";
    state.failure = {
      ...asFailure(error, "conversation_failed"),
      ...(cleanupFailure ? { cleanup: cleanupFailure } : {}),
    };
    state.finishedAt = now();
    await saveState(statePath, state, now);
    throw error;
  }
}

export function validateConversationTask(value) {
  object(value, "task");
  exactKeys(
    value,
    ["schemaVersion", "id", "readme", "executionPlan", "planDigest"],
    ["metadata"],
    "task",
  );
  if (value.schemaVersion !== 1) fail("task.schemaVersion must be 1");
  const id = identifier(value.id, "task.id");
  const readme = nonEmpty(value.readme, "task.readme");
  if (!nonBlank(value.executionPlan)) fail("task.executionPlan must be a non-empty string");
  const executionPlan = value.executionPlan;
  if (!/^[a-f0-9]{64}$/u.test(value.planDigest)) fail("task.planDigest must be a lowercase SHA-256");
  if (sha256Text(executionPlan) !== value.planDigest) {
    fail("task.planDigest does not match task.executionPlan");
  }
  const planDigest = value.planDigest;
  const metadata = value.metadata === undefined ? undefined : cloneJson(value.metadata, "task.metadata");
  return {
    schemaVersion: 1,
    id,
    readme,
    executionPlan,
    planDigest,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

async function advanceConversation(context) {
  const { task, state, evaluator, publicContractCheck, evolution, owner, runId, now, statePath } = context;
  for (;;) {
    if (state.phase === "plan_handoff") {
      const message = [
        "Use the frozen Execution Plan below. Do not generate, replace, modify, or reorder it.",
        "Read the authoritative README completely. If the Plan conflicts with the README, the README is authoritative.",
        "Acknowledge the fixed Plan and identify the first stage. Do not modify files during this handoff turn.",
        ...(context.handoffContext ? [context.handoffContext] : []),
        "",
        "<task-readme>",
        task.readme,
        "</task-readme>",
        "",
        "<execution-plan>",
        task.executionPlan,
        "</execution-plan>",
      ].join("\n");
      await exchange(context, { phase: "plan_handoff", message, nextPhase: "implementing" });
      continue;
    }

    if (state.phase === "implementing") {
      const userDecision = await nextUser(context, "implementation");
      const decision = userDecision.result;
      if (decision.action === "deliver") {
        nonEmpty(decision.message, "userAgent delivery message");
        state.deliveryRequestedAt = now();
        await exchange(context, {
          phase: "delivery",
          message: decision.message,
          nextPhase: "delivery_review",
          userDecision,
        });
        continue;
      }
      nonEmpty(decision.message, "userAgent implementation message");
      await exchange(context, {
        phase: "implementation",
        message: decision.message,
        nextPhase: "implementing",
        userDecision,
      });
      continue;
    }

    if (state.phase === "delivery_review") {
      const userDecision = await nextUser(context, "delivery_review");
      const decision = userDecision.result;
      if (decision.action === "accept") {
        consumeUserDecision(state, userDecision);
        state.deliveryAcceptedAt = now();
        state.phase = "freezing";
        await saveState(statePath, state, now);
        continue;
      }
      nonEmpty(decision.message, "userAgent delivery review message");
      await exchange(context, {
        phase: "delivery_review",
        message: decision.message,
        nextPhase: "delivery_review",
        userDecision,
      });
      continue;
    }

    if (state.phase === "freezing") {
      if (publicContractCheck) {
        const check = cloneJson(await publicContractCheck({
          operationId: `${runId}:public-contract:${state.nextTurn}`,
          workspace: cloneJson(state.workspaceRef, "workspace reference"),
        }), "public contract check result");
        if (typeof check.passed !== "boolean" || !nonBlank(check.summary)) fail("Invalid public contract check result");
        if (check.passed && !/^[a-f0-9]{64}$/u.test(check.workspaceDigest ?? "")) fail("A passed public contract check requires its source digest");
        state.publicContractChecks ??= [];
        state.publicContractChecks.push({ ...check, checkedAt: now() });
        await saveState(statePath, state, now);
        if (!check.passed) {
          await exchange(context, {
            phase: "delivery_review",
            message: [
              "The author-provided PUBLIC integration check did not pass. This is not hidden-test feedback.",
              "Check the README and public contract, repair the reported integration failures, then rerun public verification. The full README remains required; do not edit the author checker.",
              check.summary,
            ].join("\n\n"),
            nextPhase: "delivery_review",
          });
          continue;
        }
      }
      const submission = cloneJson(await evaluator.freeze({
        operationId: `${runId}:freeze`,
        owner: cloneJson(owner, "owner"),
        task: cloneJson(task, "task"),
        runId,
        workspace: cloneJson(state.workspaceRef, "workspace reference"),
      }), "evaluator.freeze result");
      object(submission, "evaluator.freeze result");
      nonEmpty(submission.id, "evaluator.freeze result.id");
      const checkedDigest = publicContractCheck && state.publicContractChecks?.at(-1)?.workspaceDigest;
      if (checkedDigest && submission.digest !== checkedDigest) {
        throw new BenchError("public_contract_submission_changed", "Submission differs from the source that passed public integration checks; hidden tests were not started");
      }
      state.submission = submission;
      state.phase = "testing";
      await saveState(statePath, state, now);
      continue;
    }

    if (state.phase === "testing") {
      // An unpublished evaluator cannot assign a business score. Deferred runs
      // end here with a checked, frozen submission, without a fake test result.
      if (context.pauseBeforeEvaluation) return true;
      const evaluation = cloneJson(await evaluator.run({
        operationId: `${runId}:hidden-tests`,
        owner: cloneJson(owner, "owner"),
        task: cloneJson(task, "task"),
        runId,
        submission: cloneJson(state.submission, "submission"),
      }), "evaluator.run result");
      validateEvaluation(evaluation);
      state.evaluation = evaluation;
      state.phase = "test_feedback";
      await saveState(statePath, state, now);
      continue;
    }

    if (state.phase === "test_feedback") {
      const userDecision = await nextUser(context, "test_feedback");
      const decision = userDecision.result;
      nonEmpty(decision.message, "userAgent test feedback message");
      const message = [
        decision.message,
        "",
        "Authoritative automated verification result:",
        JSON.stringify(publicEvaluation(state.evaluation), null, 2),
      ].join("\n");
      await exchange(context, {
        phase: "test_feedback",
        message,
        nextPhase: "evolving",
        userDecision,
      });
      continue;
    }

    if (state.phase === "evolving") {
      const result = cloneJson(await evolution.run({
        owner: cloneJson(owner, "owner"),
        task: cloneJson(task, "task"),
        runId,
        sessionId: state.sessionId,
        evaluation: publicEvaluation(state.evaluation),
        transcript: transcript(state),
        exchange: async (message) => {
          nonEmpty(message, "evolution message");
          const turn = await exchange(context, {
            phase: "skill_evolution",
            message,
            nextPhase: "evolving",
          });
          return cloneJson(turn.response, "agent response");
        },
      }), "evolution.run result");
      object(result, "evolution.run result");
      if (!SUCCESSFUL_EVOLUTION.has(result.status)) {
        state.evolution = result;
        await saveState(statePath, state, now);
        throw new BenchError("skill_evolution_failed", `Skill Evolution ended with ${result.status ?? "an invalid status"}`, result);
      }
      state.evolution = result;
      state.phase = "finished";
      await saveState(statePath, state, now);
      return;
    }

    if (state.phase === "finished") return;
    throw new BenchError("conversation_state_invalid", `Unsupported conversation phase ${state.phase}`);
  }
}

async function nextUser(context, phase) {
  const { task, state, statePath, runId, userAgent, now } = context;
  let decision = state.userDecision;
  if (decision && decision.phase !== phase) {
    throw new BenchError("conversation_state_invalid", `Pending User Agent decision belongs to ${decision.phase}, not ${phase}`);
  }
  if (!decision) {
    const number = Number(state.nextDecision ?? 1);
    decision = {
      id: `${runId}.user.${String(number).padStart(4, "0")}`,
      phase,
      status: "pending",
      attempts: 0,
      createdAt: now(),
    };
    state.nextDecision = number + 1;
    state.userDecision = decision;
    await saveState(statePath, state, now);
  }
  if (decision.status === "completed") return decision;
  decision.attempts += 1;
  await saveState(statePath, state, now);
  const result = cloneJson(await userAgent.next({
    operationId: decision.id,
    phase,
    task: cloneJson(task, "task"),
    transcript: transcript(state),
    ...(phase === "test_feedback" ? { evaluation: publicEvaluation(state.evaluation) } : {}),
  }), `userAgent ${phase} result`);
  object(result, `userAgent ${phase} result`);
  if (!nonBlank(result.action)) fail(`userAgent ${phase} result requires action`);
  decision.result = result;
  decision.status = "completed";
  decision.completedAt = now();
  await saveState(statePath, state, now);
  return decision;
}

async function exchange(context, { phase, message, nextPhase, userDecision }) {
  const { state, statePath, runId, now } = context;
  const pending = state.turns.find(({ status }) => status === "pending");
  if (pending) {
    if (pending.phase !== phase) {
      throw new BenchError(
        "conversation_state_invalid",
        `Pending Agent turn belongs to ${pending.phase}, not ${phase}`,
      );
    }
    if (pending.message === message) {
      await completeTurn(context, pending);
      return pending;
    }
    if (phase !== "skill_evolution") {
      throw new BenchError("conversation_state_invalid", "Pending Agent turn payload changed during resume");
    }
    pending.status = "superseded";
    pending.supersededAt = now();
    pending.supersededReason = "evolution_request_changed";
    await saveState(statePath, state, now);
  }
  const number = state.nextTurn;
  const turn = {
    id: `${runId}.${String(number).padStart(4, "0")}`,
    number,
    phase,
    status: "pending",
    message,
    nextPhase,
    attempts: 0,
    createdAt: now(),
  };
  if (userDecision) consumeUserDecision(state, userDecision);
  state.nextTurn += 1;
  state.turns.push(turn);
  await saveState(statePath, state, now);
  await completeTurn(context, turn);
  return turn;
}

async function completeTurn(context, turn) {
  const { state, statePath, session, now } = context;
  turn.attempts += 1;
  delete turn.failure;
  await saveState(statePath, state, now);
  try {
    const response = cloneJson(await session.send({
      turnId: turn.id,
      phase: turn.phase,
      message: turn.message,
    }), "agent response");
    object(response, "agent response");
    nonEmpty(response.message, "agent response.message");
    const observedSessionId = response.sessionId ?? session.id;
    if (!nonBlank(observedSessionId)) {
      throw new BenchError("agent_session_missing", "Agent Driver did not return a session ID");
    }
    assertStableSession(state, observedSessionId);
    state.sessionId = observedSessionId;
    turn.response = response;
    turn.status = "completed";
    turn.completedAt = now();
    state.phase = turn.nextPhase;
    await saveState(statePath, state, now);
  } catch (error) {
    turn.failure = asFailure(error, "agent_turn_failed");
    await saveState(statePath, state, now);
    throw error;
  }
}

function validateAdapters({ agentDriver, userAgent, evaluator, evolution }) {
  object(agentDriver, "agentDriver");
  identifier(agentDriver.id, "agentDriver.id");
  if (typeof agentDriver.open !== "function") fail("agentDriver.open must be a function");
  object(userAgent, "userAgent");
  if (typeof userAgent.next !== "function") fail("userAgent.next must be a function");
  object(evaluator, "evaluator");
  if (typeof evaluator.freeze !== "function" || typeof evaluator.run !== "function") {
    fail("evaluator.freeze and evaluator.run must be functions");
  }
  object(evolution, "evolution");
  if (typeof evolution.supports !== "function" || typeof evolution.run !== "function") {
    fail("evolution.supports and evolution.run must be functions");
  }
}

function validateSession(session) {
  object(session, "Agent Driver session");
  if (typeof session.send !== "function") fail("Agent Driver session.send must be a function");
  if (typeof session.close !== "function") fail("Agent Driver session.close must be a function");
  object(session.workspace, "Agent Driver session.workspace");
}

function validateEvaluation(value) {
  object(value, "evaluation");
  if (typeof value.passed !== "boolean") fail("evaluation.passed must be boolean");
  if (!Object.hasOwn(value, "feedback")) fail("evaluation.feedback is required");
  cloneJson(value.feedback, "evaluation.feedback");
  if (value.reportDigest !== undefined && !/^[a-f0-9]{64}$/u.test(value.reportDigest)) {
    fail("evaluation.reportDigest must be a lowercase SHA-256");
  }
}

function publicEvaluation(value) {
  return cloneJson({
    passed: value.passed,
    feedback: value.feedback,
    ...(value.reportDigest === undefined ? {} : { reportDigest: value.reportDigest }),
  }, "public evaluation");
}

function transcript(state) {
  const messages = [];
  for (const turn of state.turns) {
    messages.push({ role: "user", phase: turn.phase, content: turn.message });
    if (turn.status === "completed") {
      messages.push({ role: "assistant", phase: turn.phase, content: turn.response.message });
    }
  }
  return messages;
}

function consumeUserDecision(state, decision) {
  if (state.userDecision?.id !== decision.id) {
    throw new BenchError("conversation_state_invalid", "User Agent decision does not match the pending decision");
  }
  delete state.userDecision;
}

function validateOwner(value) {
  object(value, "owner");
  exactKeys(value, ["id"], ["metadata"], "owner");
  const id = nonEmpty(value.id, "owner.id");
  if (id.length > 256 || /[\0\r\n]/u.test(id)) fail("owner.id contains unsupported characters");
  const metadata = value.metadata === undefined ? undefined : cloneJson(value.metadata, "owner.metadata");
  return { id, ...(metadata === undefined ? {} : { metadata }) };
}

function validateStoredState(state, { task, owner, runId, taskDigest, agentDriver }) {
  object(state, "conversation state");
  const mismatches = [
    ["schemaVersion", state.schemaVersion, 1],
    ["kind", state.kind, "conversation-harness-run"],
    ["runId", state.runId, runId],
    ["taskId", state.taskId, task.id],
    ["taskDigest", state.taskDigest, taskDigest],
    ["planDigest", state.planDigest, task.planDigest],
    ["ownerId", state.ownerId, owner.id],
    ["agentDriverId", state.agentDriverId, agentDriver.id],
    ["turns", Array.isArray(state.turns), true],
  ].filter(([, actual, expected]) => actual !== expected)
    .map(([field]) => field);
  if (mismatches.length > 0) {
    throw new BenchError(
      "conversation_resume_mismatch",
      `Stored conversation does not match this run contract: ${mismatches.join(", ")}`,
    );
  }
}

async function loadOptionalState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new BenchError("conversation_state_read_failed", `Cannot read conversation state: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BenchError("conversation_state_invalid", `Conversation state is invalid JSON: ${error.message}`);
  }
}

async function saveState(path, state, now) {
  state.updatedAt = now();
  await writeJsonAtomic(path, state);
}

function assertStableSession(state, value) {
  nonEmpty(value, "agent session ID");
  if (state.sessionId && state.sessionId !== value) {
    throw new BenchError("agent_session_changed", "Agent Driver changed session ID during one conversation");
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneJson(value, label) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("value is undefined");
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} must be JSON-serializable: ${error.message}`);
  }
}

function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be a lowercase identifier`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function nonEmpty(value, label) {
  if (!nonBlank(value)) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(message) {
  throw new BenchError("invalid_conversation_contract", message);
}
