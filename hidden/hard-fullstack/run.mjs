import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runCase } from "./runner.mjs";

const options = parseArgs(process.argv.slice(2));
const taskAssets = options.taskAssets ? resolve(options.taskAssets) : null;
const contracts = JSON.parse(await readFile(taskAssets ? new URL("contract.json", pathToFileURL(`${taskAssets}/`)) : new URL("contracts.json", import.meta.url), "utf8"));
const contract = taskAssets ? contracts : contracts.tasks[options.task];
if (!contract) throw new Error(`unsupported hard task: ${options.task}`);
const adapter = taskAssets ? (await import(pathToFileURL(`${taskAssets}/adapter.mjs`))).default : undefined;

const result = await runCase({
  ...options,
  contract,
  adapter,
  workspace: process.env.WORKSPACE ?? "/workspace",
  allowNonScoring: process.env.BENCH_ALLOW_NON_SCORING === "1",
});
console.log(JSON.stringify(result));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--task", "--case", "--snapshot", "--task-assets"].includes(flag) || !value) throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    result[flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  if (!result.task || !/^H-(?:0[1-9]|1[0-3])$/u.test(result.case ?? "")) throw new Error("--task and --case H-01..H-13 are required");
  return result;
}
