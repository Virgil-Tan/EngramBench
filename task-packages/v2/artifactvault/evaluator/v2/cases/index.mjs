import { LOAD_CASES } from "./load.mjs";
import { MIGRATE_CASES } from "./migrate.mjs";
import { RACE_CASES } from "./race.mjs";
import { RELEASE_CASES } from "./release.mjs";
import { STREAM_CASES } from "./stream.mjs";

export const CASES=Object.freeze([
  ...STREAM_CASES,
  ...RELEASE_CASES,
  ...RACE_CASES,
  ...MIGRATE_CASES,
  ...LOAD_CASES,
]);

export default CASES;
