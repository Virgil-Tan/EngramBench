import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { runCodexWithRetry } from "./codex.mjs";
import { BenchError } from "./errors.mjs";
import { taskContainerOptions } from "./environments.mjs";
import { writeJsonAtomic } from "./files.mjs";

export async function runHiddenTests({
  runtime,
  image,
  task,
  snapshotPath,
  v1SnapshotPath,
  scoreRoot,
  timeoutMs,
  evaluatorNodeModulesPath,
  seed,
}) {
  const results = [];
  for (const test of task.hiddenTests) {
    const testRoot = await mkdtemp(join(scoreRoot, `.hidden-test-${safe(task.id)}-${safe(test.id)}-`));
    const workspace = join(testRoot, "workspace");
    const scratch = join(testRoot, "scratch");
    let container;
    try {
      await cp(snapshotPath, workspace, { recursive: true, preserveTimestamps: true });
      await mkdir(scratch, { mode: 0o700 });
      const mounts = [{ source: scratch, target: "/bench" }];
      if (evaluatorNodeModulesPath) {
        mounts.push({
          source: evaluatorNodeModulesPath,
          target: "/opt/frontal-benchmark-evaluator/node_modules",
          readonly: true,
        });
      }
      if (test.assetsPath) {
        const assets = join(testRoot, "assets");
        if (test.frameworkAssetsPath) {
          await mkdir(assets);
          await cp(test.frameworkAssetsPath, join(assets, "framework"), { recursive: true, preserveTimestamps: true });
          await cp(test.assetsPath, join(assets, "task"), { recursive: true, preserveTimestamps: true });
        } else {
          await cp(test.assetsPath, assets, { recursive: true, preserveTimestamps: true });
        }
        mounts.push({ source: assets, target: `/hidden/${test.id}`, readonly: true });
      }
      if (v1SnapshotPath) mounts.push({ source: v1SnapshotPath, target: "/snapshots/v1", readonly: true });
      const nonce = basename(testRoot).slice(-6);
      container = await runtime.createSession({
        name: `frontal-bench-test-${nonce}-${safe(task.id)}-${safe(test.id)}`,
        image,
        mounts,
        ...taskContainerOptions(task, {
          BENCH_HIDDEN_ROOT: "/hidden",
          ...(seed ? { BENCH_PRIVATE_SEED: deriveHiddenTestSeed(seed, test.id) } : {}),
          ...(v1SnapshotPath ? { BENCH_V1_SNAPSHOT: "/snapshots/v1" } : {}),
        }),
      });
      // Copy through the host process so protected files are materialized as plaintext.
      await container.copyTo(workspace, "/workspace", { timeoutMs });
      // A snapshot may contain a host-side or partial node_modules tree.  Let the
      // target environment install its own dependency graph from the frozen lockfile.
      if ((task.snapshotExcludes ?? []).includes("node_modules")) {
        await container.exec("rm", ["-rf", "/workspace/node_modules"], { timeoutMs: 60_000 });
      }
      for (const [command, ...args] of task.setup) {
        await container.exec(command, args, { timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
      }
      const [command, ...args] = test.command;
      const startedAt = Date.now();
      try {
        const result = await container.exec(command, args, {
          timeoutMs: test.timeoutMs ?? timeoutMs,
          allowFailure: true,
          maxOutputBytes: 2 * 1024 * 1024,
        });
        results.push({
          id: test.id,
          passed: result.exitCode === 0,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          stdout: bounded(result.stdout),
          stderr: bounded(result.stderr),
        });
      } catch (error) {
        results.push({
          id: test.id,
          passed: false,
          durationMs: Date.now() - startedAt,
          error: error.code ?? "test_infrastructure_failure",
          stderr: bounded(error.message),
        });
      }
    } finally {
      try {
        if (container) await container.close();
      } finally {
        await makeDirectoriesOwnerWritable(testRoot);
        await rm(testRoot, { recursive: true, force: true });
      }
    }
    const startupFailure = results.at(-1);
    if (startupFailure && isSharedStartupFailure(startupFailure)) {
      for (const blocked of task.hiddenTests.slice(results.length)) {
        results.push({
          id: blocked.id,
          passed: false,
          blocked: true,
          blockedBy: startupFailure.id,
          durationMs: 0,
          error: "blocked_by_common_startup_failure",
        });
      }
      break;
    }
  }
  await writeJsonAtomic(join(scoreRoot, "tests.json"), { schemaVersion: 1, results });
  return results;
}

async function makeDirectoriesOwnerWritable(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(path, (metadata.mode & 0o777) | 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesOwnerWritable(join(path, entry.name));
    }
  }
}

export function deriveHiddenTestSeed(seed, testId) {
  return createHash("sha256").update(seed).update("\0").update(testId).digest("hex");
}

export function isSharedStartupFailure(result) {
  if (result?.passed === true) return false;
  const text = [result?.stdout, result?.stderr, result?.error].filter(Boolean).join("\n");
  return /application did not become ready at \S+ within \d+ seconds/iu.test(text)
    || /application exited before readiness/iu.test(text)
    || /published readiness contract is not implemented/iu.test(text)
    || /missing package script required by evaluator:/iu.test(text);
}

export async function runJudge({
  runtime,
  image,
  model,
  effort,
  task,
  persona,
  checklist,
  snapshotPath,
  scoreRoot,
  judgeCodexHome,
  transcript,
  finalMessage,
  diff,
  tests,
  timeoutMs,
}) {
  const schemaPath = join(scoreRoot, "judge-output-schema.json");
  const outputPath = join(scoreRoot, "judge-output.json");
  await writeFile(schemaPath, `${JSON.stringify(judgeSchema(checklist), null, 2)}\n`, { mode: 0o600 });
  const prompt = judgePrompt({ task, persona, checklist, transcript, finalMessage, diff, tests });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptHome = await mkdtemp(join(scoreRoot, ".judge-home-"));
    await cp(judgeCodexHome, attemptHome, { recursive: true, preserveTimestamps: true });
    const container = await runtime.createSession({
      name: `frontal-bench-judge-${safe(task.id)}-${Date.now()}-${attempt + 1}`,
      image,
      mounts: [
        { source: scoreRoot, target: "/bench" },
        { source: attemptHome, target: "/state/codex" },
      ],
      env: { CODEX_HOME: "/state/codex" },
    });
    try {
      await rm(outputPath, { force: true });
      await container.copyTo(snapshotPath, "/workspace", { timeoutMs });
      await runCodexWithRetry(() => container.exec("codex", [
        "exec", "--json", "--color", "never",
        "--output-last-message", "/bench/judge-output.json",
        "--output-schema", "/bench/judge-output-schema.json",
        "--model", model,
        "--config", `model_reasoning_effort=\"${effort}\"`,
        "--config", "approval_policy=\"never\"",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--cd", "/workspace",
        "-",
      ], { input: prompt, timeoutMs, maxOutputBytes: 32 * 1024 * 1024 }));
      break;
    } catch (error) {
      if (attempt > 0 || !invalidUtf8StreamFailure(error)) throw error;
    } finally {
      await container.close();
      await rm(attemptHome, { recursive: true, force: true });
    }
  }
  const judgement = JSON.parse(await readFile(outputPath, "utf8"));
  validateJudgement(judgement, checklist);
  const score = calculateScore(checklist, judgement, tests);
  await writeJsonAtomic(join(scoreRoot, "score.json"), { schemaVersion: 1, judgement, score });
  return { judgement, score };
}

function invalidUtf8StreamFailure(error) {
  if (error?.code !== "process_failed") return false;
  return [error.message, error.details?.stdout, error.details?.stderr]
    .some((value) => typeof value === "string" && value.includes("stream did not contain valid UTF-8"));
}

export function calculateScore(checklist, judgement, tests) {
  const testsById = new Map(tests.map((test) => [test.id, test]));
  const judgementById = new Map(judgement.items.map((item) => [item.itemId, item]));
  let earned = 0;
  let possible = 0;
  const categories = {
    correctness: { earned: 0, possible: 0 },
    persona: { earned: 0, possible: 0 },
  };
  const items = checklist.items.map((item) => {
    const gateFailures = (item.testGates ?? []).filter((testId) => testsById.get(testId)?.passed !== true);
    const judged = judgementById.get(item.id);
    const fraction = gateFailures.length > 0 ? 0 : judged.fraction;
    possible += item.weight;
    earned += item.weight * fraction;
    categories[item.category].possible += item.weight;
    categories[item.category].earned += item.weight * fraction;
    return {
      itemId: item.id,
      category: item.category,
      weight: item.weight,
      fraction,
      points: item.weight * fraction,
      gateFailures,
      evidence: judged.evidence,
      reason: judged.reason,
    };
  });
  return {
    total: possible === 0 ? 0 : Math.round((earned / possible) * 10_000) / 100,
    categories: Object.fromEntries(Object.entries(categories).map(([name, value]) => [
      name,
      value.possible === 0 ? null : Math.round((value.earned / value.possible) * 10_000) / 100,
    ])),
    earnedWeight: earned,
    possibleWeight: possible,
    items,
  };
}

function judgeSchema(checklist) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "summary"],
    properties: {
      items: {
        type: "array",
        minItems: checklist.items.length,
        maxItems: checklist.items.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["itemId", "fraction", "evidence", "reason"],
          properties: {
            itemId: { type: "string", enum: checklist.items.map((item) => item.id) },
            fraction: { type: "number", minimum: 0, maximum: 1 },
            evidence: { type: "string", maxLength: 2000 },
            reason: { type: "string", maxLength: 2000 },
          },
        },
      },
      summary: { type: "string", maxLength: 4000 },
    },
  };
}

function judgePrompt({ task, persona, checklist, transcript, finalMessage, diff, tests }) {
  return [
    "You are a blind software benchmark judge. Inspect the read-only workspace and score only the supplied checklist.",
    "Do not infer or discuss experimental groups, memory systems, or how the solution was produced.",
    "Each fraction must be between 0 and 1. Cite concrete visible evidence. Test gates are applied deterministically after your judgement.",
    `Public task:\n${task.publicTask}`,
    `User persona:\n${JSON.stringify(persona.profile, null, 2)}`,
    `Visible task conversation (evolution and tool events excluded):\n${JSON.stringify(transcript)}`,
    `Agent final message:\n${bounded(finalMessage, 16_000)}`,
    `Git diff before evolution:\n${bounded(diff, 80_000)}`,
    `Hidden test summaries:\n${JSON.stringify(tests.map(({ id, passed, exitCode, stdout, stderr }) => ({ id, passed, exitCode, stdout, stderr })))}`,
    `Hidden checklist:\n${JSON.stringify(checklist.items, null, 2)}`,
  ].join("\n\n");
}

function validateJudgement(judgement, checklist) {
  if (!judgement || !Array.isArray(judgement.items)) throw new BenchError("invalid_judge_output", "Judge output has no items");
  const expected = new Set(checklist.items.map((item) => item.id));
  const seen = new Set();
  for (const item of judgement.items) {
    if (!expected.has(item.itemId) || seen.has(item.itemId)) throw new BenchError("invalid_judge_output", "Judge item IDs do not match the checklist");
    if (!Number.isFinite(item.fraction) || item.fraction < 0 || item.fraction > 1) throw new BenchError("invalid_judge_output", `Judge fraction is invalid for ${item.itemId}`);
    if (typeof item.evidence !== "string" || typeof item.reason !== "string") throw new BenchError("invalid_judge_output", `Judge evidence is invalid for ${item.itemId}`);
    seen.add(item.itemId);
  }
  if (seen.size !== expected.size) throw new BenchError("invalid_judge_output", "Judge omitted checklist items");
}

function bounded(value, maximum = 8_000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n...[truncated]`;
}

function safe(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").slice(0, 40);
}
