import { readFile } from "node:fs/promises";
import { validator } from "./runtime.mjs";

const contract = JSON.parse(await readFile(new URL("./contract.json", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file") throw new Error("Usage: npm run db:seed -- --file <path>");
const seed = JSON.parse(await readFile(args[1], "utf8"));
const valid = validator(contract)(contract.seed.schema);
if (!valid(seed)) throw new Error(`INVALID_SEED: ${JSON.stringify(valid.errors)}`);
// This validates the wire shape only. The implementation MUST validate references,
// digests, revisions, duplicates and commit the entire import transactionally.
process.argv = [process.argv[0], process.argv[1], "db:seed", ...args];
await import("../dist/lifecycle.js");
