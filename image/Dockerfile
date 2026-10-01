# syntax=docker/dockerfile:1
#
# Runtime for the obsidian-headless-sync chart: Node, git, git-lfs, ssh, and
# this repo's init / sync supervisor / keeper scripts.
#
# The published image does NOT contain the Obsidian headless client. That
# package is not openly licensed, so the chart installs the version pinned in
# ob/package-lock.json onto the data volume at pod start. To build a private
# image with the client baked in instead, pass --build-arg BUNDLE_OB=true and
# set `obsidian.installClient: false` in the chart values. Do not publish an
# image built that way.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git git-lfs openssh-client tini \
 && rm -rf /var/lib/apt/lists/*

COPY app/ /app/
COPY ob/ /app/ob/

ARG BUNDLE_OB=false
RUN if [ "$BUNDLE_OB" = "true" ]; then \
      mkdir -p /opt/ob && cp /app/ob/package.json /app/ob/package-lock.json /opt/ob/ \
      && cd /opt/ob && npm ci --omit=dev --no-audit --no-fund \
      && ln -s /opt/ob/node_modules/.bin/ob /usr/local/bin/ob; \
    fi

ENV HOME=/tmp/home \
    XDG_CONFIG_HOME=/data/config \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    OBSIDIAN_HEADLESS_CONFIG=/etc/obsidian-headless/config.json

# The node image's unprivileged user.
USER 1000:1000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bin/keeper.mjs"]

ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/nprodromou/obsidian-headless-chart" \
      org.opencontainers.image.description="Runtime for the obsidian-headless-sync Helm chart. Does not include the Obsidian client." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
