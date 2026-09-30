#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CASES } from "./cases/index.mjs";
import {
  createPrivateCaseState,
  executeCase,
  parsePriorCaseState,
  PRIOR_CASE_STATE_ENV,
  PRIVATE_CASE_STATE_ENV,
  validateCaseRegistry,
} from "./lib/execution.mjs";
import { withCaseContext } from "./lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "./lib/scoring.mjs";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));

export async function runEvaluation(options) {
  const manifest = await readJson(resolve(evaluatorRoot, "manifest.v2.json"));
  const contractMap = await readJson(resolve(evaluatorRoot, "contract-map.v2.json"));
  validateManifest(manifest, contractMap);
  validateCaseRegistry(manifest, CASES);
  const workspace = resolve(options.workspace);
  const resultPath = resolve(options.result);
  const selected = selectCases(manifest, options.caseIds);
  const implementations = new Map(CASES.map((item) => [item.id, item]));
  const mappings = new Map(contractMap.cases.map((item) => [item.caseId, item]));
  const submissionDigest = options.submissionDigest ?? await digestTree(workspace, { ignore: new Set([".git", "dist", "node_modules"]) });
  const evaluatorDigest = await digestTree(evaluatorRoot, { ignore: new Set(["node_modules"]) });
  const evaluationSeedDigest = sha256(options.evaluationSeed);
  const cases = [];
  const inheritedCases = await readInheritedCases();
  const executionOrder = orderCasesForExecution(selected);
  const manifestOrder = new Map(selected.map(({ id }, index) => [id, index]));
  await mkdir(dirname(resultPath), { recursive: true });
  for (const definition of executionOrder) {
    const contextOptions = {
      workspace,
      v1Workspace: options.v1Workspace ? resolve(options.v1Workspace) : undefined,
      evaluationSeed: options.evaluationSeed,
      priorCaseOutcomes: mergePriorCases(inheritedCases, cases.map(publicCaseEvidence)),
    };
    if (options.baseTime) contextOptions.baseTime = options.baseTime;
    const outcome = await executeCase({
      definition,
      implementation: implementations.get(definition.id),
      withContext: withCaseContext,
      contextOptions,
      failureCodePrefix: mappings.get(definition.id).privateFailureCodePrefix,
    });
    cases.push(outcome);
    await writePrivateEvidence(outcome);
    process.stdout.write(`${JSON.stringify({ event: "case.completed", id: outcome.id, status: outcome.status, durationMs: outcome.durationMs })}\n`);
    const orderedCompleted = [...cases].sort((left, right) => manifestOrder.get(left.id) - manifestOrder.get(right.id));
    await writeJson(resultPath, {
      schemaVersion: 2,
      taskId: manifest.taskId,
      complete: false,
      submissionDigest,
      evaluatorDigest,
      evaluationSeedDigest,
      completedCaseCount: cases.length,
      selectedCaseCount: selected.length,
      cases: orderedCompleted,
    });
  }
  cases.sort((left, right) => manifestOrder.get(left.id) - manifestOrder.get(right.id));
  const complete = selected.length === manifest.cases.length;
  const scored = complete ? scoreEvaluation(manifest, contractMap, { cases }) : { verdict: "partial", rawScore: null, score: null, dimensions: {}, hardCapsApplied: [] };
  const evaluation = {
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
  await writeJson(resultPath, evaluation);
  return evaluation;
}

export function orderCasesForExecution(definitions) {
  const closure = definitions.filter(({ id }) => id === "D-08");
  return [...definitions.filter(({ id }) => id !== "D-08"), ...closure];
}

function publicCaseEvidence(outcome) {
  return {
    id: outcome.id,
    status: outcome.status,
    evidenceDigest: outcome.evidenceDigest,
    ...(outcome.status !== "excluded" ? { privateEvidenceSummary: outcome.privateEvidenceSummary } : {}),
    ...(outcome.status === "excluded" ? { reason: outcome.reason } : {}),
    ...(outcome.status === "diagnostic" ? { diagnostics: outcome.diagnostics } : {}),
  };
}

async function readInheritedCases() {
  const path = process.env[PRIOR_CASE_STATE_ENV];
  if (!path) return [];
  const state = parsePriorCaseState(await readFile(path), "permitforge");
  return state.cases.map(({ outcome, evidence }) => ({
    ...outcome,
    privateEvidenceSummary: evidence,
  }));
}

function mergePriorCases(inherited, local) {
  const byId = new Map(inherited.map((item) => [item.id, item]));
  for (const item of local) byId.set(item.id, item);
  return [...byId.values()];
}

async function writePrivateEvidence(outcome) {
  const path = process.env[PRIVATE_CASE_STATE_ENV];
  if (!path || outcome.status === "excluded") return;
  await writeJson(path, createPrivateCaseState("permitforge", outcome.id, outcome.privateEvidenceSummary));
}

export function parseArgs(argv) {
  const parsed = { caseIds: [] };
  const valued = new Set(["--workspace", "--submission", "--result", "--seed", "--base-time", "--v1-workspace", "--submission-digest", "--case"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valued.has(flag) || argv[index + 1] === undefined) throw new Error(`unknown or valueless argument: ${flag}`);
    const value = argv[(index += 1)];
    if (flag === "--case") parsed.caseIds.push(...value.split(",").filter(Boolean));
    else if (["--workspace", "--submission"].includes(flag)) parsed.workspace = value;
    else if (flag === "--result") parsed.result = value;
    else if (flag === "--seed") parsed.evaluationSeed = value;
    else if (flag === "--base-time") parsed.baseTime = value;
    else if (flag === "--v1-workspace") parsed.v1Workspace = value;
    else if (flag === "--submission-digest") parsed.submissionDigest = value;
  }
  if (!parsed.workspace || !parsed.result || !parsed.evaluationSeed) throw new Error("--submission/--workspace, --result, and --seed are required");
  return parsed;
}

export function selectCases(manifest, requested = []) {
  if (!requested.length) return [...manifest.cases];
  const selected = new Set(requested);
  const unknown = [...selected].filter((id) => !manifest.cases.some((entry) => entry.id === id));
  if (unknown.length) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
  return manifest.cases.filter(({ id }) => selected.has(id));
}

export async function digestTree(root, options = {}) {
  const directory = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const entries = [];
  async function visit(path) {
    const information = await stat(path);
    if (information.isDirectory()) {
      for (const name of (await readdir(path)).sort()) if (!options.ignore?.has(name)) await visit(resolve(path, name));
    } else if (information.isFile() && information.size <= 128 * 1024 * 1024) entries.push([relative(directory, path), await readFile(path)]);
  }
  await visit(directory);
  const hash = createHash("sha256");
  for (const [path, body] of entries) hash.update(path).update("\0").update(body).update("\0");
  return hash.digest("hex");
}

function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvaluation(parseArgs(process.argv.slice(2))).then((evaluation) => {
    process.stdout.write(`${JSON.stringify({ event: "evaluation.completed", verdict: evaluation.verdict, score: evaluation.score })}\n`);
    if (!["accepted", "partial"].includes(evaluation.verdict)) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
