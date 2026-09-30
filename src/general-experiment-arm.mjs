import { BenchError } from "./errors.mjs";

const PROFILES = Object.freeze({
  baseline: Object.freeze({ arm: "baseline", runtimeGuideEnabled: false, mode: "none", supported: true }),
  treatment: Object.freeze({ arm: "treatment", runtimeGuideEnabled: true, mode: "composer", supported: true }),
  ablation_selector_direct: Object.freeze({
    arm: "ablation_selector_direct",
    runtimeGuideEnabled: true,
    mode: "selector_direct",
    supported: false,
  }),
  ablation_native_skills: Object.freeze({
    arm: "ablation_native_skills",
    runtimeGuideEnabled: false,
    mode: "native_skills",
    supported: true,
  }),
});

export function resolveGeneralExperiment(env = process.env) {
  const requestedEnabled = optionalBoolean(env.FRONTAL_RUNTIME_GUIDE_ENABLED);
  const arm = env.FRONTAL_EXPERIMENT_ARM?.trim()
    || (requestedEnabled === false ? "baseline" : "treatment");
  const profile = PROFILES[arm];
  if (!profile) {
    throw new BenchError(
      "experiment_arm_invalid",
      `FRONTAL_EXPERIMENT_ARM must be one of: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  if (requestedEnabled !== undefined && requestedEnabled !== profile.runtimeGuideEnabled) {
    throw new BenchError(
      "experiment_arm_conflict",
      `FRONTAL_RUNTIME_GUIDE_ENABLED=${requestedEnabled} conflicts with ${arm}`,
    );
  }
  return { ...profile };
}

export function assertExperimentSupported(profile) {
  if (!profile.supported) {
    throw new BenchError(
      "experiment_arm_unsupported",
      `${profile.arm} has no executable Harness implementation`,
    );
  }
}

export function generalExperimentContainerEnv(profile) {
  return {
    FRONTAL_EXPERIMENT_ARM: profile.arm,
    FRONTAL_RUNTIME_GUIDE_ENABLED: String(profile.runtimeGuideEnabled),
  };
}

export function assertTreatmentM5Ready(profile, status) {
  if (profile.arm !== "treatment") return;
  const adapter = status?.codexAdapter;
  if (!profile.runtimeGuideEnabled
    || status?.ok !== true
    || status.backend?.ok !== true
    || adapter?.installed !== true
    || adapter.enabled !== true
    || adapter.codexSkills?.ok !== true) {
    throw new BenchError(
      "treatment_m5_unavailable",
      "Treatment cannot expose the MemoraX Runtime Guide before task execution",
      status,
    );
  }
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true"].includes(normalized)) return true;
  if (["0", "false"].includes(normalized)) return false;
  throw new BenchError(
    "runtime_guide_flag_invalid",
    "FRONTAL_RUNTIME_GUIDE_ENABLED must be true or false",
  );
}
