import { readFile } from "node:fs/promises";
import { validator } from "./runtime.mjs";
import { readSeedJsonFile } from "./seed-reader.mjs";

const contract = JSON.parse(await readFile(new URL("./contract.json", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file") throw new Error("Usage: npm run db:seed -- --file <path>");
async function validateInput() {
  const valid = validator(contract)(contract.seed.schema);
  if (!valid(await readSeedJsonFile(args[1]))) throw new Error(`INVALID_SEED: ${JSON.stringify(valid.errors)}`);
}
await validateInput();
// This validates the wire shape only. The implementation MUST validate references,
// digests, revisions, duplicates and commit the entire import transactionally.
const command = contract.seed.command?.[2] ?? 'db:seed';
process.argv = [process.argv[0], process.argv[1], command, ...args];
await import("../dist/lifecycle.js");
