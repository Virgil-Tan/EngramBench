FROM docker.m.daocloud.io/library/node:22-bookworm AS node

FROM docker.m.daocloud.io/library/postgres:16-bookworm

COPY --from=node /usr/local/ /usr/local/
RUN rm -f /etc/apt/sources.list.d/pgdg.list \
    && sed -i \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium curl g++ git make procps python3 \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/frontal-benchmark-fullstack-entrypoint
RUN chmod 0755 /usr/local/bin/frontal-benchmark-fullstack-entrypoint

ENV PGDATA=/tmp/frontal-benchmark-pgdata \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium
ENTRYPOINT ["/usr/local/bin/frontal-benchmark-fullstack-entrypoint"]
CMD ["sh", "-lc", "while :; do sleep 3600; done"]
