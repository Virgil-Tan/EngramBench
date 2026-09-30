FROM node:22-bookworm@sha256:d92113e87fd65d854dab5ca8b111a4df3f54e2feac57491896f4875124973fd4 AS node

FROM postgres:16-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8

COPY --from=node /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      g++ \
      git \
      make \
      procps \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/frontal-benchmark-fullstack-entrypoint
RUN chmod 0755 /usr/local/bin/frontal-benchmark-fullstack-entrypoint

ENV PGDATA=/tmp/frontal-benchmark-pgdata \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium

ENTRYPOINT ["/usr/local/bin/frontal-benchmark-fullstack-entrypoint"]
CMD ["sh", "-lc", "while :; do sleep 3600; done"]
