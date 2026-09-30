import { STANDARD_TASKS } from "./adapters/standard-tasks.mjs";
import { MID_TRANSFER_TASKS } from "./adapters/mid-transfer-tasks.mjs";

const LOADERS = {
  ledgerbridge: () => import("./adapters/ledgerbridge.mjs"),
  metersettle: () => import("./adapters/metersettle.mjs"),
  clinicgrid: () => import("./adapters/clinicgrid.mjs"),
  dockchain: () => import("./adapters/dockchain.mjs"),
  queueforge: () => import("./adapters/queueforge.mjs"),
  incidentrelay: () => import("./adapters/incidentrelay.mjs"),
};

export async function loadAdapter(taskId) {
  if (MID_TRANSFER_TASKS[taskId]) return MID_TRANSFER_TASKS[taskId];
  if (STANDARD_TASKS[taskId]) return STANDARD_TASKS[taskId];
  const load = LOADERS[taskId];
  if (!load) throw new Error(`missing Harness adapter for ${taskId}`);
  return (await load()).default;
}
