import { LOAD_CASES } from "./load.mjs";
import { MIGRATE_CASES } from "./migrate.mjs";
import { PLAN_CASES } from "./plan.mjs";
import { RACE_CASES } from "./race.mjs";
import { SLOT_CASES } from "./slot.mjs";

export const CASES = Object.freeze([
  ...SLOT_CASES,
  ...PLAN_CASES,
  ...RACE_CASES,
  ...MIGRATE_CASES,
  ...LOAD_CASES,
]);

export default CASES;
