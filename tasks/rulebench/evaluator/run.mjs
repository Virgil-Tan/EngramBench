import { readFile } from "node:fs/promises";

import { runCase } from "../framework/runner.mjs";
import adapter from "./adapter.mjs";

const options = parse(process.argv.slice(2));
const contract = JSON.parse(await readFile(new URL("contract.json", import.meta.url), "utf8"));
const result = await runCase({
  ...options,
  task: "rulebench",
  adapter,
  contract,
  workspace: process.env.WORKSPACE ?? "/workspace",
  allowNonScoring: process.env.BENCH_ALLOW_NON_SCORING === "1",
});
console.log(JSON.stringify(result));

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--case", "--snapshot"].includes(flag) || !value) throw new Error(`invalid argument: ${flag ?? "<missing>"}`);
    options[flag.slice(2)] = value;
  }
  if (!/^H-(?:0[1-9]|1[0-3])$/u.test(options.case ?? "")) throw new Error("--case H-01..H-13 is required");
  return options;
}
