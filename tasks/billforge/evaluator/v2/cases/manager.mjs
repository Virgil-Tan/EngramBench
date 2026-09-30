import { diagnostics } from "./helpers.mjs";

const ADJUST01 = {
  id: "ADJUST-01",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-ADJUST01-WIRE", blockedBy: "SPEC-GAP-BF-01" },
      { assertionId: "BF-ADJUST01-SNAPSHOT", blockedBy: "SPEC-GAP-BF-02" },
    ]);
  },
};

const ADJUST02 = {
  id: "ADJUST-02",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-ADJUST02-WIRE", blockedBy: "SPEC-GAP-BF-01" },
      { assertionId: "BF-ADJUST02-EVENT", blockedBy: "SPEC-GAP-BF-02" },
    ]);
  },
};

const ADJUST03 = {
  id: "ADJUST-03",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-ADJUST03-WIRE", blockedBy: "SPEC-GAP-BF-01" },
      { assertionId: "BF-ADJUST03-SNAPSHOT", blockedBy: "SPEC-GAP-BF-02" },
      { assertionId: "BF-ADJUST03-PROVIDER", blockedBy: "SPEC-GAP-BF-06" },
    ]);
  },
};

const COMPAT04 = {
  id: "COMPAT-04",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-COMPAT04-WIRE", blockedBy: "SPEC-GAP-BF-01" },
      { assertionId: "BF-COMPAT04-CROSSLAYER", blockedBy: "SPEC-GAP-BF-02" },
    ]);
  },
};

const ADJUST04 = {
  id: "ADJUST-04",
  async run(_ctx) {
    return diagnostics([
      { assertionId: "BF-ADJUST04-WIRE", blockedBy: "SPEC-GAP-BF-01" },
      { assertionId: "BF-ADJUST04-SNAPSHOT", blockedBy: "SPEC-GAP-BF-02" },
    ]);
  },
};

export const MANAGER_D_CASES = Object.freeze([ADJUST01, ADJUST02, ADJUST03]);
export const MANAGER_E_CASES = Object.freeze([ADJUST04]);
export const MANAGER_COMPAT_CASES = Object.freeze([COMPAT04]);
