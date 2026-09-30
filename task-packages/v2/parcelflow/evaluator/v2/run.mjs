#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CASES } from "./cases/index.mjs";
import { executeCase, validateCaseRegistry } from "./lib/execution.mjs";
import { withCaseContext } from "./lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "./lib/scoring.mjs";

const root = dirname(fileURLToPath(import.meta.url));

export async function runEvaluation(options) {
  const manifest = await readJson(resolve(root, "manifest.v2.json"));
  const contractMap = await readJson(resolve(root, "contract-map.v2.json"));
  validateManifest(manifest, contractMap);
  validateCaseRegistry(manifest, CASES);
  const workspace = resolve(options.workspace);
  const resultPath = resolve(options.result);
  const selected = selectCases(manifest, options.caseIds);
  const implementations = new Map(CASES.map((item) => [item.id, item]));
  const mappings = new Map(contractMap.cases.map((item) => [item.caseId, item]));
  const submissionDigest = options.submissionDigest ?? await digestTree(workspace, { ignore: new Set([".git", "node_modules", "dist"]) });
  const evaluatorDigest = await digestTree(root, { ignore: new Set(["node_modules"]) });
  const evaluationSeedDigest = sha256(options.evaluationSeed);
  const cases = [];
  await mkdir(dirname(resultPath), { recursive: true });
  for (const definition of selected) {
    const result = await executeCase({
      definition,
      implementation: implementations.get(definition.id),
      withContext: withCaseContext,
      contextOptions: {
        workspace,
        v1Workspace: options.v1Workspace ? resolve(options.v1Workspace) : undefined,
        evaluationSeed: options.evaluationSeed,
        ...(options.baseTime === undefined ? {} : { baseTime: options.baseTime }),
        postgresAdminUrl: options.postgresAdminUrl,
      },
      failureCodePrefix: mappings.get(definition.id).privateFailureCodePrefix,
    });
    cases.push(result);
    process.stdout.write(`${JSON.stringify({ event: "case.completed", id: result.id, status: result.status, durationMs: result.durationMs })}\n`);
    await writeJson(resultPath, {
      schemaVersion: 2,
      taskId: manifest.taskId,
      submissionDigest,
      evaluatorDigest,
      evaluationSeedDigest,
      complete: false,
      completedCaseCount: cases.length,
      selectedCaseCount: selected.length,
      cases,
    });
  }
  const complete = selected.length === manifest.cases.length;
  const scored = complete
    ? scoreEvaluation(manifest, contractMap, { cases })
    : { verdict: "partial", score: null, rawScore: null, maxScore: 100, dimensions: {}, hardCapsApplied: [] };
  const result = {
    schemaVersion: 2,
    taskId: manifest.taskId,
    submissionDigest,
    evaluatorDigest,
    evaluationSeedDigest,
    completedAt: new Date().toISOString(),
    complete,
    ...scored,
    cases: scored.cases ?? cases,
  };
  await writeJson(resultPath, result);
  return result;
}

export function parseArgs(argv) {
  const options = { caseIds: [] };
  const allowed = new Set(["--workspace", "--submission", "--result", "--seed", "--base-time", "--v1-workspace", "--submission-digest", "--case", "--postgres-admin-url"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value) throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    index += 1;
    if (flag === "--workspace" || flag === "--submission") options.workspace = value;
    else if (flag === "--result") options.result = value;
    else if (flag === "--seed") options.evaluationSeed = value;
    else if (flag === "--base-time") options.baseTime = value;
    else if (flag === "--v1-workspace") options.v1Workspace = value;
    else if (flag === "--submission-digest") options.submissionDigest = value;
    else if (flag === "--case") options.caseIds.push(...value.split(",").filter(Boolean));
    else if (flag === "--postgres-admin-url") options.postgresAdminUrl = value;
  }
  if (!options.workspace || !options.result || !options.evaluationSeed) throw new Error("--workspace/--submission, --result, and --seed are required");
  return options;
}

export function selectCases(manifest, caseIds = []) {
  if (caseIds.length === 0) return [...manifest.cases];
  const requested = new Set(caseIds);
  const selected = manifest.cases.filter(({ id }) => requested.has(id));
  const missing = [...requested].filter((id) => !selected.some((item) => item.id === id));
  if (missing.length) throw new Error(`unknown case ids: ${missing.join(", ")}`);
  return selected;
}

export async function digestTree(directory, { ignore = new Set() } = {}) {
  const digest = createHash("sha256");
  const paths = [];
  await collect(directory, directory, ignore, paths);
  for (const path of paths.sort()) {
    digest.update(path).update("\0");
    digest.update(await readFile(resolve(directory, path))).update("\0");
  }
  return digest.digest("hex");
}

async function collect(rootDirectory, directory, ignore, paths) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(rootDirectory, absolute, ignore, paths);
    else if (entry.isFile() && (await stat(absolute)).size <= 512 * 1024 * 1024) paths.push(relative(rootDirectory, absolute));
  }
}

function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runEvaluation(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ event: "evaluation.completed", verdict: result.verdict, score: result.score })}\n`);
}
