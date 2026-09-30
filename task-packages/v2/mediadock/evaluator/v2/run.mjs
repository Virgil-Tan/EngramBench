#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  const implementations = new Map(CASES.map((entry) => [entry.id, entry]));
  const mappings = new Map(contractMap.cases.map((entry) => [entry.caseId, entry]));
  const submissionDigest = options.submissionDigest ?? await digestTree(workspace, { ignore: new Set([".git", "node_modules", "dist"]) });
  const evaluatorDigest = await digestTree(root, { ignore: new Set(["node_modules"]) });
  const evaluationSeedDigest = sha256(options.evaluationSeed);
  const cases = [];
  await mkdir(dirname(resultPath), { recursive: true });

  for (const definition of selected) {
    const outcome = await executeCase({
      definition,
      implementation: implementations.get(definition.id),
      withContext: withCaseContext,
      contextOptions: {
        workspace,
        evaluationSeed: options.evaluationSeed,
        ...(options.baseTime === undefined ? {} : { baseTime: options.baseTime }),
        postgresAdminUrl: options.postgresAdminUrl,
      },
      failureCodePrefix: mappings.get(definition.id).privateFailureCodePrefix,
    });
    cases.push(outcome);
    process.stdout.write(`${JSON.stringify({ event: "case.completed", id: outcome.id, status: outcome.status, durationMs: outcome.durationMs })}\n`);
    await writeJson(resultPath, { schemaVersion: 2, taskId: manifest.taskId, complete: false, submissionDigest, evaluatorDigest, evaluationSeedDigest, completedCaseCount: cases.length, selectedCaseCount: selected.length, cases });
  }

  const complete = selected.length === manifest.cases.length;
  const scored = complete
    ? scoreEvaluation(manifest, contractMap, { cases })
    : { verdict: "partial", formalEligible: false, rawScore: null, score: null, dimensions: {}, hardCapsApplied: [] };
  const result = { schemaVersion: 2, taskId: manifest.taskId, submissionDigest, evaluatorDigest, evaluationSeedDigest, completedAt: new Date().toISOString(), complete, ...scored, cases: scored.cases ?? cases };
  await writeJson(resultPath, result);
  return result;
}

export function parseArgs(argv) {
  const options = { caseIds: [] };
  const flags = new Set(["--workspace", "--submission", "--result", "--seed", "--base-time", "--submission-digest", "--case", "--postgres-admin-url"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flags.has(flag) || value === undefined) throw new Error(`unknown or valueless argument: ${flag}`);
    index += 1;
    if (flag === "--workspace" || flag === "--submission") options.workspace = value;
    else if (flag === "--result") options.result = value;
    else if (flag === "--seed") options.evaluationSeed = value;
    else if (flag === "--base-time") options.baseTime = value;
    else if (flag === "--submission-digest") options.submissionDigest = value;
    else if (flag === "--case") options.caseIds.push(...value.split(",").filter(Boolean));
    else if (flag === "--postgres-admin-url") options.postgresAdminUrl = value;
  }
  if (!options.workspace || !options.result || !options.evaluationSeed) throw new Error("--workspace/--submission, --result, and --seed are required");
  return options;
}

export function selectCases(manifest, requested = []) {
  if (requested.length === 0) return [...manifest.cases];
  const ids = new Set(requested);
  const unknown = [...ids].filter((id) => !manifest.cases.some((entry) => entry.id === id));
  if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
  return manifest.cases.filter(({ id }) => ids.has(id));
}

export async function digestTree(directory, { ignore = new Set() } = {}) {
  const paths = [];
  await collect(directory, directory, ignore, paths);
  const digest = createHash("sha256");
  for (const path of paths.sort()) digest.update(path).update("\0").update(await readFile(resolve(directory, path))).update("\0");
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
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvaluation(parseArgs(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify({ event: "evaluation.completed", verdict: result.verdict, score: result.score })}\n`);
    if (!["accepted", "diagnostic", "partial"].includes(result.verdict)) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
