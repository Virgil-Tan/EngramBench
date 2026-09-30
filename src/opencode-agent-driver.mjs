import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BenchError } from "./errors.mjs";
import { writeJsonAtomic } from "./files.mjs";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function createOpenCodeAgentDriver({
  workspacePath,
  commandWorkspacePath = workspacePath,
  workspaceId,
  stateDir,
  model,
  variant,
  command = "opencode",
  env = {},
  uid,
  gid,
  processRunner = runProcess,
}) {
  required(workspacePath, "workspacePath");
  required(workspaceId, "workspaceId");
  required(stateDir, "stateDir");
  required(model, "model");
  const workspace = { id: workspaceId, path: resolve(workspacePath) };
  required(commandWorkspacePath, "commandWorkspacePath");

  return {
    id: "opencode",

    async open({ runId, sessionId, workspaceRef }) {
      if (workspaceRef && workspaceRef.id !== workspace.id) {
        throw new BenchError("opencode_workspace_mismatch", "OpenCode workspace changed during resume");
      }
      let currentSessionId = sessionId;

      return {
        id: currentSessionId,
        workspace,

        async send({ turnId, phase, message }) {
          const recordPath = join(stateDir, "turns", `${sha256(turnId)}.json`);
          const existing = await readOptionalJson(recordPath);
          if (existing?.turnId !== undefined && existing.turnId !== turnId) {
            throw new BenchError("opencode_turn_collision", `OpenCode turn record collision for ${turnId}`);
          }
          if (existing?.status === "completed") {
            currentSessionId = existing.result.sessionId;
            return existing.result;
          }
          if (existing?.status === "pending" && !currentSessionId) {
            currentSessionId = await findSessionByTitle({
              command,
              processRunner,
              title: `frontal-${runId}`,
              cwd: commandWorkspacePath,
              env,
              uid,
              gid,
            });
          }
          if (existing?.status === "pending" && currentSessionId) {
            const recovered = await recoverTurn({
              command,
              processRunner,
              sessionId: currentSessionId,
              turnId,
              cwd: commandWorkspacePath,
              env,
              uid,
              gid,
            });
            if (recovered) {
              await writeJsonAtomic(recordPath, { turnId, status: "completed", result: recovered });
              return recovered;
            }
          }

          const markedMessage = [
            `<frontal-turn id="${turnId}" phase="${phase}">`,
            message,
            "</frontal-turn>",
          ].join("\n");
          await writeJsonAtomic(recordPath, {
            turnId,
            phase,
            status: "pending",
            sessionId: currentSessionId,
            messageDigest: sha256(markedMessage),
          });

          const result = await runOpenCode({
            command,
            processRunner,
            cwd: commandWorkspacePath,
            model,
            variant,
            sessionId: currentSessionId,
            title: `frontal-${runId}`,
            agent: readOnlyPhase(phase) ? "plan" : "build",
            auto: !readOnlyPhase(phase),
            message: markedMessage,
            env,
            uid,
            gid,
          });
          if (currentSessionId && result.sessionId !== currentSessionId) {
            throw new BenchError("opencode_session_changed", "OpenCode returned a different session ID");
          }
          currentSessionId = result.sessionId;
          await writeJsonAtomic(recordPath, { turnId, status: "completed", result });
          return result;
        },

        async close() {},
      };
    },
  };
}

export function createOpenCodeUserAgent({
  stateDir,
  workspacePath,
  model,
  variant,
  scenario,
  command = "opencode",
  env = {},
  uid,
  gid,
  processRunner = runProcess,
}) {
  required(stateDir, "stateDir");
  required(workspacePath, "workspacePath");
  required(model, "model");

  return {
    async next(input) {
      const recordPath = join(stateDir, "decisions", `${sha256(input.operationId)}.json`);
      const existing = await readOptionalJson(recordPath);
      if (existing?.operationId !== undefined && existing.operationId !== input.operationId) {
        throw new BenchError("opencode_user_collision", `User Agent decision collision for ${input.operationId}`);
      }
      if (existing?.status === "completed") return existing.result;
      await writeJsonAtomic(recordPath, {
        operationId: input.operationId,
        phase: input.phase,
        status: "pending",
      });

      let lastError;
      for (let attempt = 1; ; attempt += 1) {
        const prompt = userPrompt({ ...input, ...(scenario === undefined ? {} : { scenario }) }, attempt, lastError);
        const response = await runOpenCode({
          command,
          processRunner,
          cwd: resolve(workspacePath),
          model,
          variant,
          agent: "plan",
          auto: false,
          title: `frontal-user-${input.operationId}`,
          message: prompt,
          env,
          uid,
          gid,
        });
        try {
          const result = parseOpenCodeUserDecision(response.message);
          await writeJsonAtomic(recordPath, {
            operationId: input.operationId,
            phase: input.phase,
            status: "completed",
            result,
          });
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new BenchError("invalid_user_output", `OpenCode User Agent returned invalid JSON: ${lastError}`);
    },
  };
}

async function runOpenCode({
  command,
  processRunner,
  cwd,
  model,
  variant,
  sessionId,
  title,
  agent,
  auto,
  message,
  env,
  uid,
  gid,
}) {
  const args = ["run", "--format", "json", "--model", model, "--agent", agent, "--dir", cwd];
  if (variant) args.push("--variant", variant);
  if (auto) args.push("--auto");
  if (sessionId) args.push("--session", sessionId);
  else if (title) args.push("--title", title);
  args.push(message);

  const output = await processRunner(command, args, {
    cwd,
    env: { ...process.env, ...env },
    uid,
    gid,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
  const parsed = parseJsonLines(output.stdout);
  const observedSessionIds = new Set(parsed.events.map((event) => event?.sessionID).filter(nonBlank));
  if (observedSessionIds.size !== 1) {
    throw new BenchError("opencode_session_missing", "OpenCode output did not contain one stable session ID");
  }
  const observedSessionId = [...observedSessionIds][0];
  if (sessionId && observedSessionId !== sessionId) {
    throw new BenchError("opencode_session_changed", "OpenCode resumed a different session");
  }
  const errors = parsed.events.filter((event) => event?.type === "error");
  if (errors.length > 0) {
    throw new BenchError("opencode_event_error", "OpenCode emitted an error event", errors.at(-1));
  }
  const messageText = parsed.events
    .filter((event) => event?.type === "text" && nonBlank(event?.part?.text))
    .map((event) => event.part.text.trim())
    .join("\n\n")
    .trim();
  if (!messageText) throw new BenchError("opencode_empty_response", "OpenCode returned no final text");
  const finish = parsed.events.filter((event) => event?.type === "step_finish").at(-1)?.part;
  return {
    sessionId: observedSessionId,
    message: messageText,
    usage: finish?.tokens ?? {},
  };
}

async function recoverTurn({ command, processRunner, sessionId, turnId, cwd, env, uid, gid }) {
  const output = await processRunner(command, ["export", sessionId], {
    cwd,
    env: { ...process.env, ...env },
    uid,
    gid,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
  const start = output.stdout.indexOf("{");
  if (start === -1) return undefined;
  let exported;
  try {
    exported = JSON.parse(output.stdout.slice(start));
  } catch {
    return undefined;
  }
  const marker = `<frontal-turn id="${turnId}"`;
  const messages = Array.isArray(exported.messages) ? exported.messages : [];
  const user = messages.find((entry) => entry?.info?.role === "user"
    && entry.parts?.some((part) => part?.type === "text" && part.text?.includes(marker)));
  if (!user) return undefined;
  const assistant = messages
    .filter((entry) => entry?.info?.role === "assistant"
      && entry.info.parentID === user.info.id
      && Number.isFinite(entry.info.time?.completed))
    .at(-1);
  if (!assistant) return undefined;
  const message = assistant.parts
    .filter((part) => part?.type === "text" && nonBlank(part.text))
    .map((part) => part.text.trim())
    .join("\n\n");
  if (!message) return undefined;
  return { sessionId, message, usage: assistant.info.tokens ?? {} };
}

async function findSessionByTitle({ command, processRunner, title, cwd, env, uid, gid }) {
  const output = await processRunner(command, ["session", "list", "--format", "json", "--max-count", "100"], {
    cwd,
    env: { ...process.env, ...env },
    uid,
    gid,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
  let sessions;
  try {
    sessions = JSON.parse(output.stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(sessions)) return undefined;
  const matches = sessions.filter((session) => session?.title === title && resolve(session?.directory ?? "") === resolve(cwd));
  if (matches.length > 1) {
    throw new BenchError("opencode_session_ambiguous", `Multiple OpenCode sessions match ${title}`);
  }
  return nonBlank(matches[0]?.id) ? matches[0].id : undefined;
}

function userPrompt(input, attempt, lastError) {
  const rules = {
    implementation: [
      "每次只推进 Plan 中一个边界清楚的部分。",
      "如果公开需求、测试和固定交付命令尚未全部完成，返回 action=message。",
      "只有 Coding Agent 已完成全部实现并明确跑过固定命令后，才返回 action=deliver。",
    ].join(" "),
    delivery_review: [
      "审查 Coding Agent 的交付说明。若仍有未完成项或固定命令未通过，返回 action=message 推动修复。",
      "只有交付完整时返回 action=accept。",
    ].join(" "),
    test_feedback: "只返回 action=message，要求 Coding Agent 根据权威测试结果总结根因、可复用教训和后续改进；不要要求重新评分。",
  }[input.phase];
  if (!rules) throw new BenchError("invalid_user_phase", `Unsupported User Agent phase ${input.phase}`);
  const transcript = boundedJson(input.transcript, 120_000);
  return [
    "你是推进软件项目的 User Agent，不写代码、不运行工具，只决定下一步动作。Harness 会生成实际消息，你不得编写或转述给 Coding Agent 的具体要求。",
    "只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。",
    '通常使用格式：{"action":"message","message":"..."}、{"action":"deliver","message":"..."}、{"action":"accept"}。',
    `当前阶段：${input.phase}。`,
    "决策前检查完整 conversation。如果最近连续三次都在推动继续开发且没有询问状态，本轮主动询问 Agent 当前阶段、已完成内容、公开验证、剩余工作和是否可以交付。",
    rules,
    input.scenario === undefined ? "" : `推进剧本：${boundedJson(input.scenario, 12_000)}`,
    attempt > 1 ? `上一次输出无效：${lastError}。这次必须严格返回合法 JSON。` : "",
    "对话记录：",
    transcript,
    input.evaluation === undefined ? "" : `权威测试摘要：${boundedJson(input.evaluation, 8_000)}`,
  ].filter(Boolean).join("\n\n");
}

export function parseOpenCodeUserDecision(text) {
  const value = extractJsonObject(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("decision must be a JSON object");
  return value;
}

function extractJsonObject(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let string = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (string) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') string = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("no valid JSON object found");
}

function parseJsonLines(text) {
  const events = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new BenchError("opencode_invalid_jsonl", `OpenCode emitted invalid JSONL: ${error.message}`);
    }
  }
  return { events };
}

async function runProcess(command, args, { cwd, env, uid, gid, maxOutputBytes }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        overflow = true;
        terminate(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        overflow = true;
        terminate(child);
      }
    });
    child.once("error", (error) => {
      rejectPromise(new BenchError("opencode_spawn_failed", `Cannot start OpenCode: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (overflow) {
        rejectPromise(new BenchError("opencode_output_limit", "OpenCode exceeded its output limit"));
      } else if (code !== 0) {
        rejectPromise(new BenchError("opencode_failed", `OpenCode exited with ${code ?? signal}`, {
          stdout: stdout.slice(-4_000),
          stderr: stderr.slice(-4_000),
        }));
      } else resolvePromise({ stdout, stderr });
    });
  });
}

function terminate(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2_000).unref();
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new BenchError("opencode_state_invalid", `Cannot read OpenCode state: ${error.message}`);
  }
}

function readOnlyPhase(phase) {
  return ["plan_handoff", "test_feedback"].includes(phase);
}

function boundedJson(value, limit) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value, label) {
  if (!nonBlank(value)) throw new TypeError(`${label} is required`);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}
