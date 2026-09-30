#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CASES } from "./cases/index.mjs";
import { executeCase, validateCaseRegistry } from "./lib/execution.mjs";
import { withCaseContext } from "./lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "./lib/scoring.mjs";
const root = dirname(fileURLToPath(import.meta.url));
export async function runEvaluation(options) {
  const manifest = await readJson(resolve(root, "manifest.v2.json")),
    map = await readJson(resolve(root, "contract-map.v2.json"));
  validateManifest(manifest, map);
  validateCaseRegistry(manifest, CASES);
  const workspace = resolve(options.workspace),
    resultPath = resolve(options.result),
    selected = selectCases(manifest, options.caseIds),
    implementations = new Map(CASES.map((item) => [item.id, item])),
    mappings = new Map(map.cases.map((item) => [item.caseId, item])),
    submissionDigest =
      options.submissionDigest ??
      (await digestTree(workspace, {
        ignore: new Set([".git", "node_modules", "dist"]),
      })),
    evaluatorDigest = await digestTree(root, {
      ignore: new Set(["node_modules"]),
    }),
    evaluationSeedDigest = sha256(options.evaluationSeed),
    cases = [];
  await mkdir(dirname(resultPath), { recursive: true });
  for (const definition of selected) {
    const outcome = await executeCase({
      definition,
      implementation: implementations.get(definition.id),
      withContext: withCaseContext,
      contextOptions: {
        workspace, evaluationSeed: options.evaluationSeed,
        ...(options.baseTime === undefined ? {} : { baseTime: options.baseTime }),
        postgresAdminUrl: options.postgresAdminUrl,
      },
      failureCodePrefix: mappings.get(definition.id).privateFailureCodePrefix,
    });
    cases.push(outcome);
    process.stdout.write(
      `${JSON.stringify({ event: "case.completed", id: outcome.id, status: outcome.status, durationMs: outcome.durationMs })}\n`,
    );
    await writeJson(resultPath, {
      schemaVersion: 2,
      taskId: manifest.taskId,
      complete: false,
      completedCaseCount: cases.length,
      selectedCaseCount: selected.length,
      submissionDigest,
      evaluatorDigest,
      evaluationSeedDigest,
      cases,
    });
  }
  const complete = selected.length === manifest.cases.length,
    scored = complete
      ? scoreEvaluation(manifest, map, { cases })
      : {
          verdict: "partial",
          score: null,
          rawScore: null,
          maxScore: manifest.maxScore,
          formalEligible: false,
          evaluationMode: "partial",
          dimensions: {},
          hardCapsApplied: [],
        },
    factor = Number(process.env.BENCH_PERF_SCALE ?? "1"),
    smoke =
      selected.some(({ id }) => ["E-02", "E-03", "E-04"].includes(id)) &&
      factor !== 1,
    result = {
      schemaVersion: 2,
      taskId: manifest.taskId,
      submissionDigest,
      evaluatorDigest,
      evaluationSeedDigest,
      completedAt: new Date().toISOString(),
      complete,
      ...scored,
      ...(smoke
        ? {
            verdict: "smoke",
            score: null,
            formalEligible: false,
            evaluationMode: "smoke",
            performanceScale: factor,
          }
        : {}),
      cases: scored.cases ?? cases,
    };
  await writeJson(resultPath, result);
  return result;
}
export function parseArgs(argv) {
  const options = { caseIds: [] },
    allowed = new Set([
      "--workspace",
      "--submission",
      "--result",
      "--seed",
      "--base-time",
      "--submission-digest",
      "--case",
      "--postgres-admin-url",
    ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index],
      value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined)
      throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    index += 1;
    if (flag === "--workspace" || flag === "--submission")
      options.workspace = value;
    else if (flag === "--result") options.result = value;
    else if (flag === "--seed") options.evaluationSeed = value;
    else if (flag === "--base-time") options.baseTime = value;
    else if (flag === "--submission-digest") options.submissionDigest = value;
    else if (flag === "--case")
      options.caseIds.push(...value.split(",").filter(Boolean));
    else if (flag === "--postgres-admin-url") options.postgresAdminUrl = value;
  }
  if (!options.workspace || !options.result || !options.evaluationSeed)
    throw new Error(
      "--workspace/--submission, --result, and --seed are required",
    );
  return options;
}
export function selectCases(manifest, ids = []) {
  if (ids.length === 0) return [...manifest.cases];
  const wanted = new Set(ids),
    selected = manifest.cases.filter(({ id }) => wanted.has(id)),
    missing = [...wanted].filter(
      (id) => !selected.some((item) => item.id === id),
    );
  if (missing.length)
    throw new Error(`unknown case ids: ${missing.join(", ")}`);
  return selected;
}
export async function digestTree(directory, { ignore = new Set() } = {}) {
  const digest = createHash("sha256"),
    paths = [];
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
    if (entry.isDirectory())
      await collect(rootDirectory, absolute, ignore, paths);
    else if (entry.isFile() && (await stat(absolute)).size <= 512 * 1024 * 1024)
      paths.push(relative(rootDirectory, absolute));
  }
}
function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEvaluation(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: "evaluation.completed", verdict: result.verdict, score: result.score })}\n`,
      );
      if (
        !["accepted", "diagnostic", "partial", "smoke"].includes(result.verdict)
      )
        process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
