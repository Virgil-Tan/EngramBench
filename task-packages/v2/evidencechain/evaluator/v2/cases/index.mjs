import { CONTRACT_CASES } from "./contract.mjs";
import { DATA_CASES } from "./data.mjs";
import { LAYER_CASES } from "./layer.mjs";
import { OPERATE_CASES } from "./operate.mjs";
import { RECOVERY_CASES } from "./recovery.mjs";

export const CASES = Object.freeze([
  ...CONTRACT_CASES,
  ...DATA_CASES,
  ...RECOVERY_CASES,
  ...LAYER_CASES,
  ...OPERATE_CASES,
]);

export default CASES;
