import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BenchError } from "./errors.mjs";
import { runProcess } from "./process.mjs";

const MEMORAX_NODE_IMAGE = "node:24-bookworm@sha256:da4221677e02b54ef6335adfa447578d512ad14f251024fb92ea433c2c102760";
const MEMORAX_NODE_PATH = "/opt/memorax-node24/bin/node";
const PROJECT_NODE_PATH = "/opt/project-node22/bin/node";
const MEMORAX_NODE_DISPATCHER = `#!/bin/sh
case "$PWD/\${1:-}" in
  *memorax-code*|*memorax-cli*|*/.memorax-code/*)
    exec ${MEMORAX_NODE_PATH} "$@"
    ;;
  *)
    exec ${PROJECT_NODE_PATH} "$@"
    ;;
esac
`;

export class OciRuntime {
  constructor({ command = "docker", runRoot, processRunner = runProcess }) {
    this.command = command;
    this.runRoot = runRoot;
    this.processRunner = processRunner;
  }

  async preflight() {
    return await this.processRunner(this.command, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  }

  async prepareAgentImage({ baseImage, tag, codexNpmSpec, frontalTarball, frontalSha256, platform }) {
    const context = await mkdtemp(join(this.runRoot, "image-context-"));
    try {
      const tarballName = "frontal.tgz";
      await cp(frontalTarball, join(context, tarballName));
      const dockerfile = [
        `FROM ${safeImage(baseImage)}`,
        "ARG CODEX_NPM_SPEC",
        "RUN node --version && npm --version",
        "RUN npm install -g \"${CODEX_NPM_SPEC}\"",
        `COPY ${tarballName} /tmp/${tarballName}`,
        `RUN test \"$(node -e 'const fs=require(\"fs\"),c=require(\"crypto\");process.stdout.write(c.createHash(\"sha256\").update(fs.readFileSync(\"/tmp/${tarballName}\")).digest(\"hex\"))')\" = \"${frontalSha256}\"`,
        `RUN npm install -g /tmp/${tarballName} --ignore-scripts && rm /tmp/${tarballName}`,
        "RUN codex --version && frontal --version",
        "",
      ].join("\n");
      await writeFile(join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
      const args = ["build", "--pull=false"];
      if (platform) args.push("--platform", safePlatform(platform));
      args.push("--label", "frontal-benchmark.image=v1",
        "--build-arg", `CODEX_NPM_SPEC=${codexNpmSpec}`,
        "-t", tag, context,
      );
      await this.processRunner(this.command, args, { timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
      return tag;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }

  async prepareMemoraxAgentImage({ baseImage, tag, codexNpmSpec, memoraxTarball, memoraxSha256, platform }) {
    const context = await mkdtemp(join(this.runRoot, "memorax-image-context-"));
    try {
      const tarballName = "memorax-code.tgz";
      const dispatcherName = "memorax-node-dispatcher";
      const artifactSha256 = safeSha256(memoraxSha256);
      await Promise.all([
        cp(memoraxTarball, join(context, tarballName)),
        writeFile(join(context, dispatcherName), MEMORAX_NODE_DISPATCHER, { mode: 0o700 }),
      ]);
      const dockerfile = [
        `FROM ${MEMORAX_NODE_IMAGE} AS memorax-node`,
        `FROM ${safeImage(baseImage)}`,
        "ARG CODEX_NPM_SPEC",
        `RUN install -d /opt/project-node22/bin /opt/memorax-node24/bin && mv /usr/local/bin/node ${PROJECT_NODE_PATH}`,
        `COPY --from=memorax-node /usr/local/bin/node ${MEMORAX_NODE_PATH}`,
        `COPY ${dispatcherName} /usr/local/bin/node`,
        "RUN chmod 0755 /usr/local/bin/node",
        `RUN test "$(node -p 'process.versions.node.split(".")[0]')" = "22" && test "$(${MEMORAX_NODE_PATH} -p 'process.versions.node.split(".")[0]')" = "24" && npm --version`,
        "RUN npm_config_prefix=/usr/local npm install -g \"${CODEX_NPM_SPEC}\"",
        `COPY ${tarballName} /tmp/${tarballName}`,
        `RUN test "$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync("/tmp/${tarballName}")).digest("hex"))')" = "${artifactSha256}"`,
        `RUN npm_config_prefix=/usr/local npm_config_engine_strict=false npm install -g /tmp/${tarballName} --ignore-scripts && rm /tmp/${tarballName}`,
        "RUN codex --version && memorax-code --version",
        "RUN test -f /usr/local/lib/node_modules/@lizhao1/memorax-code-internal/lib/memorax-code-codex-adapter/skills/memorax-code-session-evolution/SKILL.md",
        "",
      ].join("\n");
      await writeFile(join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
      const args = ["build", "--pull=false"];
      if (platform) args.push("--platform", safePlatform(platform));
      args.push(
        "--label", "frontal-benchmark.image=v1",
        "--label", `frontal-benchmark.memorax-code-sha256=${artifactSha256}`,
        "--build-arg", `CODEX_NPM_SPEC=${codexNpmSpec}`,
        "-t", safeImage(tag), context,
      );
      await this.processRunner(this.command, args, { timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
      return tag;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }

  async prepareJudgeImage({ baseImage, tag, codexNpmSpec }) {
    const context = await mkdtemp(join(this.runRoot, "judge-context-"));
    try {
      await writeFile(join(context, "Dockerfile"), [
        `FROM ${safeImage(baseImage)}`,
        "ARG CODEX_NPM_SPEC",
        "RUN node --version && npm --version && npm install -g \"${CODEX_NPM_SPEC}\"",
        "RUN codex --version",
        "",
      ].join("\n"), { mode: 0o600 });
      await this.processRunner(this.command, [
        "build", "--pull=false", "--label", "frontal-benchmark.judge-image=v1",
        "--build-arg", `CODEX_NPM_SPEC=${codexNpmSpec}`,
        "-t", tag, context,
      ], { timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
      return tag;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }

  async removeImage(image) {
    return await this.processRunner(this.command, ["image", "rm", "--force", safeImage(image)], { timeoutMs: 60_000 });
  }

  async createSession(options) {
    const name = safeName(options.name);
    const args = ["create", "--name", name, "--label", "frontal-benchmark.container=v1"];
    if (options.platform) args.push("--platform", safePlatform(options.platform));
    if (options.resources) args.push(...resourceArgs(options.resources));
    for (const tmpfs of options.tmpfs ?? []) args.push("--tmpfs", tmpfsMount(tmpfs));
    for (const mount of options.mounts) {
      args.push("--mount", bindMount(mount));
    }
    const network = options.networkPolicy === "ephemeral-bridge" ? safeName(`${name}-network`) : undefined;
    if (options.networkPolicy !== undefined && !network) {
      throw new BenchError("invalid_network_policy", "OCI network policy is invalid");
    }
    let environmentFile = await createEnvironmentFile(this.runRoot, options.env);
    if (environmentFile) args.push("--env-file", environmentFile.path);
    const hostEnv = { ...process.env };
    let containerCreated = false;
    let networkCreated = false;
    if (network) args.push("--network", network);
    args.push("--workdir", options.workdir ?? "/workspace", options.image, "sh", "-lc", "while :; do sleep 3600; done");
    try {
      if (network) {
        await this.processRunner(this.command, [
          "network", "create", "--label", "frontal-benchmark.network=v1", network,
        ], { env: hostEnv, timeoutMs: 30_000 });
        networkCreated = true;
      }
      await this.processRunner(this.command, args, { env: hostEnv, timeoutMs: 60_000 });
      containerCreated = true;
      await removeEnvironmentFile(environmentFile);
      environmentFile = undefined;
      await this.processRunner(this.command, ["start", name], { env: hostEnv, timeoutMs: 30_000 });
      if (options.readiness) await waitForReadiness(this, name, options.readiness, hostEnv);
      return new OciSession({ runtime: this, name, hostEnv, network });
    } catch (error) {
      const cleanupFailures = [];
      if (containerCreated) {
        try {
          await this.processRunner(this.command, ["rm", "-fv", name], { env: hostEnv, timeoutMs: 30_000 });
        } catch (cleanupError) {
          cleanupFailures.push({ resource: "container", message: cleanupError.message });
        }
      }
      if (networkCreated) {
        try {
          await this.processRunner(this.command, ["network", "rm", network], { env: hostEnv, timeoutMs: 30_000 });
        } catch (cleanupError) {
          cleanupFailures.push({ resource: "network", message: cleanupError.message });
        }
      }
      if (cleanupFailures.length > 0) {
        throw new BenchError("session_create_cleanup_failed", error.message, {
          primary: { message: error.message },
          cleanup: cleanupFailures,
        });
      }
      throw error;
    } finally {
      await removeEnvironmentFile(environmentFile);
    }
  }
}

async function waitForReadiness(runtime, name, readiness, hostEnv) {
  const command = readiness?.command;
  const timeoutMs = readiness?.timeoutMs;
  const intervalMs = readiness?.intervalMs;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000
    || !Number.isSafeInteger(intervalMs) || intervalMs < 25 || intervalMs > 5_000) {
    throw new BenchError("invalid_readiness", "OCI readiness probe is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  while (Date.now() < deadline) {
    try {
      lastResult = await runtime.processRunner(runtime.command, ["exec", name, ...command], {
        env: hostEnv,
        allowFailure: true,
        timeoutMs: Math.min(5_000, timeoutMs),
      });
      if (lastResult.exitCode === 0) return;
    } catch (error) {
      lastResult = { error: error.message };
    }
    await delay(intervalMs);
  }
  throw new BenchError("container_not_ready", `Container ${name} did not become ready`, lastResult);
}

class OciSession {
  constructor({ runtime, name, hostEnv, network }) {
    this.runtime = runtime;
    this.name = name;
    this.hostEnv = hostEnv;
    this.network = network;
    this.containerRemoved = false;
    this.networkRemoved = !network;
    this.closed = false;
  }

  async exec(command, args = [], options = {}) {
    if (this.closed) throw new BenchError("container_closed", `Container ${this.name} is closed`);
    const execArgs = ["exec", "-i", "--workdir", options.cwd ?? "/workspace"];
    const environmentFile = await createEnvironmentFile(this.runtime.runRoot, options.env);
    if (environmentFile) execArgs.push("--env-file", environmentFile.path);
    execArgs.push(this.name, command, ...args);
    try {
      return await this.runtime.processRunner(this.runtime.command, execArgs, {
        env: this.hostEnv,
        input: options.input,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        allowFailure: options.allowFailure,
      });
    } finally {
      await removeEnvironmentFile(environmentFile);
    }
  }

  async copyTo(source, target, options = {}) {
    if (this.closed) throw new BenchError("container_closed", `Container ${this.name} is closed`);
    assertContainerPath(target);
    return await this.runtime.processRunner(this.runtime.command, ["cp", `${source}/.`, `${this.name}:${target}`], {
      env: this.hostEnv,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  async copyFrom(source, target, options = {}) {
    if (this.closed) throw new BenchError("container_closed", `Container ${this.name} is closed`);
    assertContainerPath(source);
    return await this.runtime.processRunner(this.runtime.command, ["cp", `${this.name}:${source}/.`, target], {
      env: this.hostEnv,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  async stop(options = {}) {
    if (this.closed) return;
    await this.runtime.processRunner(this.runtime.command, ["stop", "--time", String(options.timeSeconds ?? 10), this.name], {
      env: this.hostEnv,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  async close() {
    if (this.closed) return;
    const failures = [];
    if (!this.containerRemoved) {
      try {
        await this.runtime.processRunner(this.runtime.command, ["rm", "-fv", this.name], {
          env: this.hostEnv,
          timeoutMs: 30_000,
        });
        this.containerRemoved = true;
      } catch (error) {
        failures.push({ resource: "container", message: error.message });
      }
    }
    if (!this.networkRemoved) {
      try {
        await this.runtime.processRunner(this.runtime.command, ["network", "rm", this.network], {
          env: this.hostEnv,
          timeoutMs: 30_000,
        });
        this.networkRemoved = true;
      } catch (error) {
        failures.push({ resource: "network", message: error.message });
      }
    }
    if (failures.length > 0) {
      const summary = failures.map(({ resource, message }) => `${resource}: ${message}`).join("; ");
      throw new BenchError("session_cleanup_failed", `OCI session cleanup failed: ${summary}`, { cleanup: failures });
    }
    this.closed = true;
  }
}

async function createEnvironmentFile(runRoot, environment = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new BenchError("invalid_environment", `Invalid environment variable ${key}`);
    const normalized = String(value);
    if (/[\r\n\0]/u.test(normalized)) throw new BenchError("invalid_environment", `Environment variable ${key} contains an unsupported character`);
    lines.push(`${key}=${normalized}`);
  }
  if (lines.length === 0) return undefined;

  const directory = await mkdtemp(join(runRoot, "container-env-"));
  const path = join(directory, "environment.list");
  try {
    await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function removeEnvironmentFile(environmentFile) {
  if (environmentFile) await rm(environmentFile.directory, { recursive: true, force: true });
}

function assertContainerPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new BenchError("invalid_container_path", "OCI container path must be absolute");
  }
}

function safeImage(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/u.test(value)) {
    throw new BenchError("invalid_image", "OCI image reference is invalid");
  }
  return value;
}

function safeName(value) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").slice(0, 120);
  if (!normalized) throw new BenchError("invalid_container_name", "Container name is empty");
  return normalized;
}

function safePlatform(value) {
  if (!/^linux\/(?:amd64|arm64)$/u.test(value)) throw new BenchError("invalid_platform", "OCI platform is invalid");
  return value;
}

function safeSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new BenchError("invalid_artifact_sha256", "Artifact SHA256 is invalid");
  }
  return value;
}

function resourceArgs({ cpus, memoryMiB }) {
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > 64
    || !Number.isSafeInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 262_144) {
    throw new BenchError("invalid_resources", "OCI resource limits are invalid");
  }
  return ["--cpus", String(cpus), "--memory", `${memoryMiB}m`];
}

function tmpfsMount({ target, sizeMiB }) {
  if (typeof target !== "string" || !target.startsWith("/") || target.includes(",") || target.includes("\0")
    || !Number.isSafeInteger(sizeMiB) || sizeMiB < 16 || sizeMiB > 65_536) {
    throw new BenchError("invalid_tmpfs", "OCI tmpfs mount is invalid");
  }
  return `${target}:rw,nosuid,nodev,size=${sizeMiB}m`;
}

function bindMount({ source, target, readonly = false }) {
  if (!source || !target?.startsWith("/")) throw new BenchError("invalid_mount", "OCI bind mount is invalid");
  if (String(source).includes(",") || target.includes(",")) throw new BenchError("invalid_mount", "OCI bind mount paths cannot contain commas");
  const options = [`type=bind`, `src=${source}`, `dst=${target}`];
  if (readonly) options.push("readonly");
  return options.join(",");
}
