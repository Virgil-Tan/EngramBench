#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const taskRoot = resolve(evaluatorRoot, "..");
const repositoryRoot = resolve(process.env.FRONTAL_V2_RUNTIME_ROOT ?? join(evaluatorRoot, "../../../.."));
const runtimeUrl = pathToFileURL(join(repositoryRoot, "src/task-package-v2-evaluator.mjs"));
const { runV2EvaluatorProcess } = await import(runtimeUrl.href);
await runV2EvaluatorProcess({
  argv: process.argv.slice(2),
  taskRoot,
  repositoryRoot,
});
