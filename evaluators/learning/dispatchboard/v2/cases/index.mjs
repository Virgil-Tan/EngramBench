import { A_CASES } from "./a.mjs";
import { B_CASES } from "./b.mjs";
import { C_CASES } from "./c.mjs";
import { D_CASES } from "./d.mjs";
import { E_CASES } from "./e.mjs";

const definitions = [
  ...A_CASES,
  ...B_CASES,
  ...C_CASES,
  ...D_CASES,
  ...E_CASES,
];

export const CASES = Object.freeze(definitions.map((entry) => Object.freeze({
  taskId: "dispatchboard",
  ...entry,
})));

export default CASES;
