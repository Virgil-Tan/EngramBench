# Running EngramBench in containers

The host harness requires Node.js 24+. The task environment provides Node.js 22,
PostgreSQL 16, Chromium, Git, curl, Python, and native Node build tools.

## Build native images

From the repository root, on the machine that will execute the experiment:

```sh
docker build -t engrambench-fullstack:local environments/fullstack-node22-postgres16-chromium
docker build -f docker/codex-agent.Dockerfile -t engrambench-codex:local .
docker image inspect --format '{{.Id}}' engrambench-codex:local
export ENGRAMBENCH_EVALUATOR_IMAGE="$(docker image inspect --format '{{.Id}}' engrambench-fullstack:local)"
```

Use the returned Codex image ID as `agentImage` in your run profile. Keep the
evaluator environment variable set when running public gates or evaluations.
It must be a complete `sha256:` local image ID, not a mutable tag.

The default build targets the Docker host's architecture. Do not compare native
browser/performance results with runs under CPU emulation. The native wrapper
supports x64 and arm64; image-build and live platform validation remain the
experimenter's responsibility.

`docker/codex-agent.Dockerfile` is a minimal baseline/native-skills recipe; it
does not install MemoraX. The historical `general-agent-amd64.Dockerfile` is an
optional MemoraX integration recipe, not required for the benchmark itself.

## Historical pins and reproducibility

`catalog.v1.json` records the original logical environment and context hash.
`evaluator-execution.v1.json` contains historical local image IDs, not public
registry images. A new machine must build its own images. The native wrapper
maps the historical evaluator image references to the explicit
`ENGRAMBENCH_EVALUATOR_IMAGE` override without editing task requirements or
the fixed public contract. With no override it retains the historical mapping.

Record the built evaluator ID, agent image ID, architecture, Dockerfile revision,
resource settings, model versions, and profile alongside results. Rebuilding a
Dockerfile does not guarantee the same image ID or byte-identical packages.
Use one environment revision across compared arms.

## Resources and isolation

The standard catalog allocates 4 CPUs, 8192 MiB RAM, and a 2048 MiB PostgreSQL
tmpfs **per container**. These are environment resources, not model turn caps.
Choose concurrency according to aggregate CPU, RAM, storage, and network capacity.

Development receives only the task workspace and dedicated agent state.
Evaluator cases use fresh containers, disposable PostgreSQL state, and separate
bridge networks. Bridge networking is not an outbound-network block. The
submission and evaluator share a filesystem inside an evaluator container;
this is not a hostile-code security boundary.

The existing frozen-delivery helper in
`work/superhard-v2-alignment-20260908/evaluate.mjs` uses a different, explicit
author-validation profile: **4 CPUs, 65536 MiB RAM, 32768 MiB PostgreSQL tmpfs,
256 database connections**. Its configuration is adjacent in
`evaluation-environment.json`. Identify this revision in results; do not silently
pool it with the standard profile. It does not weaken application-level RSS,
throughput, or business assertions.

`npm run check` validates sources and locks. It does not build images, connect
to model providers, or execute a full submitted application.
