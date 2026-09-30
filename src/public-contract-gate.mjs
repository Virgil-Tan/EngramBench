import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BenchError } from "./errors.mjs";
import { copyTree, writeJsonAtomic } from "./files.mjs";
import { digestTaskPackagePath, SUBMISSION_EXCLUDES } from "./task-package-v1.mjs";
import { checkSource } from "../templates/contract-first/check.mjs";

// Optional, public-only gate. No hidden fixtures or scoring data enter this path.
export function createPublicContractGate({ taskPackage, taskRuntime, runtime, repositoryRoot, runRoot }) {
  const author = join(taskPackage.paths.root, "public-contract");
  return async ({ operationId, workspace }) => {
    if (await digestTaskPackagePath(taskPackage.paths.root) !== taskPackage.digests.package) {
      throw new BenchError("public_contract_package_changed", "Task package changed after this experiment loaded it");
    }
    await mkdir(runRoot, { recursive: true });
    const attempt = await mkdtemp(join(runRoot, "attempt-"));
    const copy = join(attempt, "workspace");
    await copyTree(workspace.path, copy, SUBMISSION_EXCLUDES);
    const workspaceDigest = await digestTaskPackagePath(copy);
    const marker = JSON.parse(await readFile(join(taskPackage.paths.root, "contract-first.json")));
    if (marker.kind !== "frontal-contract-first-package" || marker.taskId !== taskPackage.task.id) {
      throw new BenchError("public_contract_author_invalid", "Missing author-owned contract-first package marker");
    }
    const digest = createHash("sha256").update(await readFile(join(author, "contract.json"))).digest("hex");
    if (digest !== marker.publicContractDigest) throw new BenchError("public_contract_author_changed", "Author-owned contract changed after package generation");
    try { await checkSource(copy, author); }
    catch (error) {
      const result = { passed: false, summary: error.message, workspaceDigest, artifactPath: attempt };
      await writeJsonAtomic(join(attempt, "result.json"), result);
      return result;
    }
    const { profile, containerEnv } = taskRuntime;
    // The evaluator wrapper resolves the same task/environment policy as hidden tests.
    // The private checkout is writable; original workspace and author assets are not.
    const container = await runtime.createSession({
      name: `fv2-${taskPackage.task.id}-pc-00-${createHash("sha256").update(`${operationId}:${attempt}`).digest("hex").slice(0, 16)}`,
      image: profile.image, platform: profile.platform, workdir: "/workspace",
      mounts: [
        { source: copy, target: "/workspace", readonly: false },
        { source: author, target: "/public-contract", readonly: true },
        { source: join(repositoryRoot, "node_modules"), target: "/node_modules", readonly: true },
      ],
      tmpfs: profile.runtime.tmpfs, resources: profile.runtime.resources,
      networkPolicy: profile.runtime.networkPolicy, readiness: profile.runtime.readiness,
      env: { ...containerEnv, HOME: "/tmp/frontal-public-contract-home", TZ: "UTC" },
    });
    try {
      // Some public project build/test commands legitimately inspect git metadata.
      await container.exec("git", ["init", "/workspace"], { timeoutMs: null });
      await container.exec("psql", [containerEnv.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atc", "SELECT 1"], { timeoutMs: null });
      const output = await container.exec("node", ["/public-contract/check.mjs", "--workspace", "/workspace", "--author", "/public-contract", "--live"], { timeoutMs: null, allowFailure: true });
      await writeJsonAtomic(join(attempt, "execution.json"), output);
      const reports = output.stdout.split("\n").flatMap((line) => {
        try { const item = JSON.parse(line); return item.kind === "frontal-public-contract-result" ? [item] : []; }
        catch { return []; }
      });
      const report = reports.at(-1);
      if (!report || typeof report.passed !== "boolean" || (report.passed && output.exitCode !== 0)) {
        throw new BenchError("public_contract_check_failed", "Public contract checker did not finish normally; inspect execution.json", { artifactPath: attempt });
      }
      if (report.preparationFailed) throw new BenchError("public_contract_preparation_failed", "Public check dependency/environment preparation failed; inspect execution.json before retrying", { artifactPath: attempt });
      // Keep the actual PUBLIC command failure, not only its generic exit message.
      // Use the existing known-secret replacement pattern; never import hidden diagnostics.
      const secrets = Object.entries(containerEnv)
        .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/iu.test(key) && typeof value === "string" && value)
        .map(([, value]) => value);
      if (URL.canParse(containerEnv.DATABASE_URL)) {
        const password = new URL(containerEnv.DATABASE_URL).password;
        if (password) {
          secrets.push(password);
          try { secrets.push(decodeURIComponent(password)); } catch { /* Keep malformed percent escapes redacted verbatim. */ }
        }
      }
      secrets.sort((left, right) => right.length - left.length);
      const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
      const failureSummary = [
        report.message ?? JSON.stringify(report.findings),
        ...(report.stage ? [`Public check stage: ${report.stage}`] : []),
        ...["stdout", "stderr"].flatMap(stream => typeof report.commandResult?.[stream] === "string" && report.commandResult[stream].trim()
          ? [`Public command ${stream}:\n${report.commandResult[stream]}`] : []),
      ].filter(Boolean).join("\n\n");
      const result = {
        passed: report.passed,
        summary: report.passed ? "Public integration checks passed; this is not complete task acceptance." : redact(failureSummary),
        findings: report.findings ?? [], workspaceDigest, artifactPath: attempt,
      };
      await writeJsonAtomic(join(attempt, "result.json"), result);
      return result;
    } finally { await container.close(); }
  };
}
