import { disputeScenario, reserveRaceScenario, settlementScenario } from "./current-system.mjs";
import { guarded } from "./helpers.mjs";

export const MANAGER_D_CASES = Object.freeze([
  { id: "ADJUST-01", run: ctx => guarded(["REFUND_OR_RESERVE_BOUND"], () => disputeScenario(ctx)) },
  { id: "ADJUST-02", run: ctx => guarded(["MONEY_OR_LEDGER_INVARIANT", "REFUND_OR_RESERVE_BOUND"], () => disputeScenario(ctx, { resolution: true, browser: true })) },
  { id: "ADJUST-03", run: ctx => guarded(["REFUND_OR_RESERVE_BOUND"], () => reserveRaceScenario(ctx, { browser: true })) },
]);
export const MANAGER_E_CASES = Object.freeze([
  { id: "ADJUST-04", run: ctx => guarded(["SETTLEMENT_IMMUTABILITY_OR_RECOVERY", "MONEY_OR_LEDGER_INVARIANT"], () => settlementScenario(ctx, { adjustment: true })) },
]);
export const MANAGER_COMPAT_CASES = Object.freeze([
  { id: "COMPAT-04", run: ctx => guarded(["SETTLEMENT_IMMUTABILITY_OR_RECOVERY", "MONEY_OR_LEDGER_INVARIANT"], () => settlementScenario(ctx, { adjustment: true, browser: true })) },
]);
