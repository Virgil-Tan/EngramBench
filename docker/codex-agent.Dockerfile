# Minimal baseline/native-skills image; no memory service or Guide dependency.
ARG BASE_IMAGE=engrambench-fullstack:local
FROM ${BASE_IMAGE}
ARG CODEX_NPM_SPEC=@openai/codex@0.144.1
RUN npm install -g "$CODEX_NPM_SPEC" && codex --version
