import { LOAD_CASES } from "./load.mjs";
import { MIGRATE_CASES } from "./migrate.mjs";
import { RACE_CASES } from "./race.mjs";
import { REV_CASES } from "./rev.mjs";
import { TRAIN_CASES } from "./train.mjs";

export const CASES=Object.freeze([
  ...REV_CASES,
  ...TRAIN_CASES,
  ...RACE_CASES,
  ...MIGRATE_CASES,
  ...LOAD_CASES,
]);

export default CASES;
