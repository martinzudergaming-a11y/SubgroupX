# oiia — single-image deploy. The server runs via tsx (TypeScript, ESM) and
# serves the built web app from web/dist on one origin. E2B handles code-exec
# sandboxing remotely, so this container stays light.

# --- build stage: install deps + build the web bundle ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# pi-ai's Responses terminal fix is carried as a bounded patch with an upstream issue/PR. It must exist before
# npm ci runs the root postinstall; otherwise the image would silently restore the EOF wait.
COPY scripts/apply-pi-responses-terminal-patch.mjs ./scripts/
RUN npm ci --strict-allow-scripts --no-audit --no-fund
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --strict-allow-scripts --no-audit --no-fund
COPY . .
# Build version (git SHA + epoch, from deploy.sh) baked into the bundle so an open
# tab can detect it's stale; the runtime server reports the same value over `hello`.
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION
# Engineering notes are available to authenticated users. A restricted deployment can compile the
# route and article bytes out with AGENT_WEB_INTERNAL_BLOG=0.
ARG AGENT_WEB_INTERNAL_BLOG=1
ENV AGENT_WEB_INTERNAL_BLOG=$AGENT_WEB_INTERNAL_BLOG
RUN npm run build:web

# --- runtime stage: server + built assets only (no web/node_modules) ---
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=$BUILD_VERSION
WORKDIR /app
# The LOCAL sandbox runs the agent's bash inside THIS image (E2B sessions use the
# full template), confined per-session with bubblewrap (#40). Everything installed
# under /usr here is bind-mounted read-only into that confined sandbox, so it must
# carry the toolchain the agent + user expect:
#  - bubblewrap: the OS-level isolation wrapper itself (namespaces + workspace bind).
#  - python3 + uv/uvx: the system prompt's "use uv / run Python" guidance.
#  - a baseline CLI kit (file, busybox, ripgrep, jq, tree, hexdump/strings, archivers)
#    so a fresh local session isn't missing basics like `file`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bubblewrap \
       python3 python3-venv ca-certificates curl wget \
       file busybox ripgrep jq tree unzip zip xz-utils gawk bsdmainutils binutils \
       vim nano less procps git \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version && uvx --version \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/examples ./examples
COPY --from=build /app/scripts/audit-operator-upstream.mts ./scripts/audit-operator-upstream.mts
COPY --from=build /app/scripts/agent-web-connector.mjs ./scripts/agent-web-connector.mjs
COPY --from=build /app/scripts/install-agent-web-connector.sh ./scripts/install-agent-web-connector.sh
COPY --from=build /app/package.json /app/tsconfig.json ./
# Data dir (sqlite DB, workspaces, secrets.json) is provided as a mounted volume.
ENV AGENT_WEB_DATA_DIR=/data
ENV PORT=4317
EXPOSE 4317
# Run node DIRECTLY (not `npm start` → npm → sh → node) so the Node process is PID 1 and the
# graceful-shutdown SIGTERM handler (server/src/index.ts) actually receives `docker stop`'s SIGTERM
# — an npm/sh wrapper swallows it, and the turn-drain would never run. `node --import tsx` runs the
# TS entry in-process (tsx 4 loader), no child fork, so signals reach the app.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
