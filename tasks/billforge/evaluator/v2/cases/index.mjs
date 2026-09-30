import { BILL_CASES } from "./bill.mjs";
import { PAY_CASES } from "./pay.mjs";
import { RACE_CASES } from "./race.mjs";
import { MANAGER_COMPAT_CASES, MANAGER_D_CASES, MANAGER_E_CASES } from "./manager.mjs";
import { COMPAT_CASES } from "./compat.mjs";

export const CASES = Object.freeze([
  ...BILL_CASES,
  ...PAY_CASES,
  ...RACE_CASES,
  ...MANAGER_D_CASES,
  ...MANAGER_E_CASES,
  ...COMPAT_CASES,
  ...MANAGER_COMPAT_CASES,
]);

export default CASES;
