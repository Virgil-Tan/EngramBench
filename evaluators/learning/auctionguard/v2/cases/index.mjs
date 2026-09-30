import { BID_CASES } from "./bid.mjs";
import { CLEAR_CASES } from "./clear.mjs";
import { LOAD_CASES } from "./load.mjs";
import { MIGRATE_CASES } from "./migrate.mjs";
import { RACE_CASES } from "./race.mjs";

export const CASES = Object.freeze([
  ...BID_CASES,
  ...CLEAR_CASES,
  ...RACE_CASES,
  ...MIGRATE_CASES,
  ...LOAD_CASES,
]);
