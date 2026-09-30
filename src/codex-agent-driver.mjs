import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CodexSession } from "./codex.mjs";
import { BenchError } from "./errors.mjs";
import { writeJsonAtomic } from "./files.mjs";

export function createCodexAgentDriver({
  container,
  workspacePath,
  workspaceId,
  stateDir,
  scratchHostPath,
  codexHomePath,
  model,
  effort = "medium",
  serviceTier,
}) {
  const workspace = { id: required(workspaceId, "workspaceId"), path: resolve(required(workspacePath, "workspacePath")) };
  required(stateDir, "stateDir");
  required(scratchHostPath, "scratchHostPath");
  required(codexHomePath, "codexHomePath");
  required(model, "model");

  return {
    id: "codex",

    async open({ sessionId, workspaceRef, turnIndex = 0 }) {
      if (workspaceRef && workspaceRef.id !== workspace.id) {
        throw new BenchError("codex_workspace_mismatch", "Codex workspace changed during resume");
      }
      const codex = new CodexSession({
        container,
        model,
        effort,
        serviceTier,
        scratchHostPath,
        sessionId,
        turnIndex,
      });

      return {
        id: sessionId,
        workspace,

        async send({ turnId, phase, message }) {
          const recordPath = join(stateDir, "turns", `${sha256(turnId)}.json`);
          const existing = await readOptionalJson(recordPath);
          if (existing?.turnId !== undefined && existing.turnId !== turnId) {
            throw new BenchError("codex_turn_collision", `Codex turn record collision for ${turnId}`);
          }
          if (existing?.status === "completed") return existing.result;

          if (existing?.status === "pending") {
            const recovered = await recoverCompletedTurn(codexHomePath, turnId);
            if (recovered) {
              codex.sessionId = recovered.sessionId;
              await writeJsonAtomic(recordPath, { turnId, phase, status: "completed", recovered: true, result: recovered });
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
            sessionId: codex.sessionId,
            messageDigest: sha256(markedMessage),
          });
          const response = await codex.send(markedMessage);
          const result = {
            sessionId: response.sessionId,
            message: response.finalMessage,
            usage: response.usage,
            events: response.events,
          };
          await writeJsonAtomic(recordPath, { turnId, phase, status: "completed", result });
          return result;
        },

        async close() {},
      };
    },
  };
}

async function recoverCompletedTurn(codexHomePath, turnId) {
  const files = await listFiles(join(codexHomePath, "sessions"));
  files.sort().reverse();
  for (const path of files) {
    const text = await readFile(path, "utf8");
    let markerSeen = false;
    let finalMessage;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const serialized = JSON.stringify(event);
        if (serialized.includes("frontal-turn") && serialized.includes(turnId)) markerSeen = true;
        if (markerSeen && event?.type === "event_msg" && event.payload?.type === "task_complete"
          && typeof event.payload.last_agent_message === "string" && event.payload.last_agent_message.trim()) {
          finalMessage = event.payload.last_agent_message.trim();
        }
      } catch {
        // Ignore a partially written final JSONL line while the CLI is still active.
      }
    }
    if (!markerSeen) continue;
    if (!finalMessage) return undefined;
    const sessionId = path.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu)?.[1];
    if (!sessionId) continue;
    return { sessionId, message: finalMessage, usage: {}, events: [] };
  }
  return undefined;
}

async function listFiles(root) {
  const result = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return result; throw error; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new BenchError("invalid_configuration", `${label} is required`);
  return value;
}
