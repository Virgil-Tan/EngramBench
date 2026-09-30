FROM docker.m.daocloud.io/library/node:24-bookworm AS memorax-node

FROM frontal-benchmark-fullstack:linux-amd64-v1

ARG CODEX_NPM_SPEC=@openai/codex@0.144.1
COPY --from=memorax-node /usr/local/bin/node /opt/memorax-node24/bin/node
RUN install -d /opt/project-node22/bin \
    && mv /usr/local/bin/node /opt/project-node22/bin/node \
    && printf '%s\n' '#!/bin/sh' \
      'case "$PWD/${1:-}" in' \
      '  *memorax-code*|*memorax-cli*|*/.memorax-code/*) exec /opt/memorax-node24/bin/node "$@" ;;' \
      '  *) exec /opt/project-node22/bin/node "$@" ;;' \
      'esac' > /usr/local/bin/node \
    && chmod 0755 /usr/local/bin/node \
    && npm_config_prefix=/usr/local npm install -g "$CODEX_NPM_SPEC"

ARG MEMORAX_NPM_SPEC=@memorax/memorax-code@0.1.3
RUN npm_config_prefix=/usr/local npm_config_engine_strict=false npm install -g "$MEMORAX_NPM_SPEC" --ignore-scripts \
    && codex --version \
    && memorax-code --version
