#!/usr/bin/env bash
# (Re)deploy oiia by PULLING the CI-built image from GHCR — no on-host build.
#
#   SERVER=app-host.example.invalid SSH_KEY=/path/to/key ./scripts/deploy.sh [TAG]
#
# The image is built off-host by .github/workflows/build.yml (on push to main) and
# pushed to ghcr.io/n-wn/agent-web:<sha> + :latest. Pulling a prebuilt image keeps build
# load off the application host and limits downtime to the container replacement.
#
# TAG defaults to "latest"; pass a commit SHA to roll back, e.g. `./scripts/deploy.sh <sha>`.
# PREREQUISITE: the box must be logged in to GHCR once (private package):
#   echo "<read:packages PAT>" | docker login ghcr.io -u <user> --password-stdin
# secrets.json is uploaded to the data volume separately and is NEVER baked into the image.
set -euo pipefail

SERVER="${SERVER:?set SERVER=<host>}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:?set SSH_KEY=<path to private key>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/oiia}"
# Upgrade compatibility only: a host deployed before the rename may still have its live data here.
# Keep that bind source in place for stopped-container rollback; expose the new path through a symlink.
LEGACY_REMOTE_DIR="${LEGACY_REMOTE_DIR:-/opt/o11n}"
PORT="${PORT:-80}"
IMAGE="${IMAGE:-ghcr.io/n-wn/agent-web}"
TAG="${1:-latest}"
# Deployment-specific hosts, contacts, redirects, admin identities, and provider settings are
# loaded by the app from the mounted secrets.json. Do not add them as source defaults or CLI args.
OPTIONAL_DOCKER_NETWORK="${AGENT_WEB_DOCKER_NETWORK:-}"
if [ -n "$OPTIONAL_DOCKER_NETWORK" ] && [[ ! "$OPTIONAL_DOCKER_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  echo "FATAL: AGENT_WEB_DOCKER_NETWORK contains unsupported characters" >&2
  exit 1
fi

SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ deploying ${IMAGE}:${TAG}"

echo "→ ensuring remote data dir"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" "
  set -e
  if [ \"$REMOTE_DIR\" = /opt/oiia ] && [ ! -e \"$REMOTE_DIR\" ] && [ -d \"$LEGACY_REMOTE_DIR\" ]; then
    echo '  linking /opt/oiia to the pre-rename data root (rollback-compatible)'
    ln -s \"$LEGACY_REMOTE_DIR\" \"$REMOTE_DIR\"
  fi
  mkdir -p \"$REMOTE_DIR/data\"
"

# Deployment secrets are SACRED: a bare deploy NEVER touches them. Upload is explicit so a
# reduced local development file cannot silently replace the complete remote configuration.
# Upload is now OPT-IN (UPLOAD_SECRETS=1), reads a DEDICATED file (never the dev-boot file
# data/secrets.dev.json), backs up the remote first, and refuses a partial file.
if [ "${UPLOAD_SECRETS:-}" = "1" ]; then
  SRC="${SECRETS_FILE:-$HERE/data/secrets.prod.json}"
  [ -f "$SRC" ] || { echo "FATAL: UPLOAD_SECRETS=1 but $SRC not found" >&2; exit 1; }
  # Refuse to upload a partial/dev file: require the keys a shared deployment cannot run without.
  for k in AGENT_WEB_SECRET AGENT_WEB_KEY_SECRET; do
    grep -q "\"$k\"" "$SRC" || { echo "FATAL: $SRC missing $k — refusing to clobber prod secrets" >&2; exit 1; }
  done
  echo "→ backing up remote secrets.json then uploading $SRC"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" \
    "[ -f \"$REMOTE_DIR/data/secrets.json\" ] && cp -a \"$REMOTE_DIR/data/secrets.json\" \"$REMOTE_DIR/data/secrets.json.bak-\$(date -u +%Y%m%dT%H%M%SZ)\" || true"
  scp "${SSH_OPTS[@]}" "$SRC" "$SSH_USER@$SERVER:$REMOTE_DIR/data/secrets.json"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" "chmod 600 \"$REMOTE_DIR/data/secrets.json\""
else
  echo "→ leaving remote secrets.json untouched (set UPLOAD_SECRETS=1 SECRETS_FILE=… to update)"
fi

echo "→ pulling image + restarting container"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" "
  set -e
  # Pull BEFORE removing the running container so downtime is just the swap, not the pull.
  # If this fails with 'denied'/'unauthorized', the box needs: docker login ghcr.io.
  docker pull \"${IMAGE}:${TAG}\"
  # Publish the image's baked web bundle as the current frontend release (atomic \`current\` symlink
  # swap), so a full deploy ships a runtime + its MATCHING frontend. UI-only iterations between full
  # deploys use scripts/deploy-web.sh (no restart). The runtime serves /web-dist/current. (#197 P1)
  REL=\"img-${TAG}-\$(date -u +%s)-\$\$-\${RANDOM}\"
  mkdir -p \"$REMOTE_DIR/web-dist/releases/\$REL\"
  cid=\$(docker create \"${IMAGE}:${TAG}\")
  docker cp \"\$cid:/app/web/dist/.\" \"$REMOTE_DIR/web-dist/releases/\$REL/\"
  docker rm \"\$cid\" >/dev/null
  # The image bundle carries no version.txt (only deploy-web.sh writes one) — bake it here from the
  # image's BUILD_VERSION so /version.txt serves the real version, matching the client's __APP_VERSION__.
  # (The server also serves /version.txt authoritatively from servedAppVersion(); this keeps the file
  # correct too, so servedAppVersion's file-read path agrees instead of falling back.)
  imgver=\$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \"${IMAGE}:${TAG}\" | sed -n 's/^BUILD_VERSION=//p' | head -1 | tr -d '\\r\\n')
  [ -n \"\$imgver\" ] && printf '%s' \"\$imgver\" > \"$REMOTE_DIR/web-dist/releases/\$REL/version.txt\"
  # Recreating a container drops every operator-managed network attachment. Preserve the old web
  # container's non-default networks before it is stopped/removed, then reattach the replacement
  # below. Reverse proxies/service meshes can therefore keep resolving the stable oiia name even
  # when AGENT_WEB_DOCKER_NETWORK was not repeated in the deploy shell.
  PRESERVED_DOCKER_NETWORKS=\$(
    docker inspect -f '{{range \$name, \$config := .NetworkSettings.Networks}}{{println \$name}}{{end}}' oiia 2>/dev/null \
      | grep -Ev '^(bridge|host|none)\$' || true
  )
  # Do NOT publish the new SPA yet. In split mode the matching runtime/API must pass readiness first;
  # otherwise an aborted deploy would leave the old server permanently serving an incompatible UI.
  # One-time compatibility guard: tear down PRE-RENAME containers before starting the oiia* ones,
  # so a new container can never run alongside a retired-name container sharing one data directory
  # (dual SQLite writer + dual scheduler). No-op once the box is already on oiia*.
  docker stop --time=60 o11n o11n-runtime 2>/dev/null || true
  docker rm -f o11n o11n-runtime 2>/dev/null || true
  # Resource caps leave host headroom and make the app a preferred kernel-OOM victim ahead of
  # the remote-access service; --restart then recovers it. (No arrays in the remote login shell.)
  if [ \"${AGENT_WEB_SPLIT:-}\" = \"1\" ]; then
    # ── #197 split: runtime + web as TWO containers sharing a Unix-socket volume ──
    # Web can then be redeployed WITHOUT draining/interrupting in-flight agent turns (they live in the
    # runtime process). Only a RUNTIME upgrade drains. AGENT_WEB_RUNTIME_SOCKET gates the split code.
    echo '→ split mode: runtime + web'
    mkdir -p \"$REMOTE_DIR/runtime-sock\" && chmod 770 \"$REMOTE_DIR/runtime-sock\"
    # Runtime FIRST: graceful drain of its in-flight turns, then recreate. It owns sessions, scheduler,
    # recovery, connectors, sandboxes; no public port. Override the image CMD → runtime entrypoint.
    # Keep the OLD runtime container around (stopped, renamed) until the new one passes readiness:
    # if the new runtime never comes up we can restart the previous one instead of leaving the web
    # tier pointed at a dead socket (the old abort path claimed \"web left untouched\" while the old
    # runtime was already destroyed — that was a hard outage, not a rollback).
    docker rm -f oiia-runtime-prev 2>/dev/null || true
    docker stop --time=60 oiia-runtime 2>/dev/null || true
    docker rename oiia-runtime oiia-runtime-prev 2>/dev/null || true
    docker run -d --name oiia-runtime --restart unless-stopped \
      --memory=3g --memory-swap=3500m --memory-reservation=1536m --oom-score-adj=250 \
      -e AGENT_WEB_RUNTIME_SOCKET=/run/agent-runtime/runtime.sock \
      -e AGENT_WEB_TRUST_PROXY=1 \
      -v \"$REMOTE_DIR/runtime-sock:/run/agent-runtime\" -v \"$REMOTE_DIR/data:/data\" \
      \"${IMAGE}:${TAG}\" node --import tsx server/src/runtime-entrypoint.ts
    # Wait for the runtime to be serving on the socket (it listens once recovery has run), then ABORT
    # the deploy if it never came up — otherwise we'd start a web container pointed at a dead socket.
    # (A bare \`curl && echo\` would be ABSORBED by set -e since curl isn't the final &&-clause, so use
    # an explicit \`|| exit 1\` guard — and leave the old oiia web container running as the rollback.)
    for i in \$(seq 1 30); do
      curl -fsS --unix-socket \"$REMOTE_DIR/runtime-sock/runtime.sock\" http://x/runtime/hello >/dev/null 2>&1 && break
      sleep 1
    done
    curl -fsS --unix-socket \"$REMOTE_DIR/runtime-sock/runtime.sock\" http://x/runtime/hello >/dev/null 2>&1 || {
      echo 'FATAL: new oiia-runtime not ready within 30s — rolling back to the previous runtime.' >&2
      docker logs --tail 50 oiia-runtime >&2 2>/dev/null || true
      docker rm -f oiia-runtime 2>/dev/null || true
      docker rename oiia-runtime-prev oiia-runtime 2>/dev/null || true
      docker start oiia-runtime 2>/dev/null || echo 'WARNING: previous runtime could not be restarted' >&2
      exit 1
    }
    echo '✓ runtime hello ok'
    docker rm -f oiia-runtime-prev 2>/dev/null || true
    # Web SECOND: short stop (it must NOT drain the runtime). Points at the socket + the data dir + web-dist.
    docker stop --time=10 oiia 2>/dev/null || true
    ln -sfn \"releases/\$REL\" \"$REMOTE_DIR/web-dist/current.tmp\" && mv -Tf \"$REMOTE_DIR/web-dist/current.tmp\" \"$REMOTE_DIR/web-dist/current\"
    ls -1dt \"$REMOTE_DIR\"/web-dist/releases/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
    docker rm -f oiia 2>/dev/null || true
    docker run -d --name oiia --restart unless-stopped \
      --memory=3g --memory-swap=3500m --memory-reservation=1536m --oom-score-adj=250 \
      -p \"$PORT:4317\" \
      -e AGENT_WEB_RUNTIME_SOCKET=/run/agent-runtime/runtime.sock \
      -e AGENT_WEB_TRUST_PROXY=1 \
      -e AGENT_WEB_WEB_DIST=/web-dist/current \
      -v \"$REMOTE_DIR/runtime-sock:/run/agent-runtime\" \
      -v \"$REMOTE_DIR/data:/data\" -v \"$REMOTE_DIR/web-dist:/web-dist\" \"${IMAGE}:${TAG}\"
  else
    # ── monolith (default): single container, byte-identical to before ──
    # CRITICAL (rollback safety): if a prior split deploy left an oiia-runtime container running, it
    # owns the SAME data dir (SQLite WAL) + the scheduler. Starting the monolith alongside it = TWO
    # writers + TWO schedulers (double automation fires, recovery races). So tear the runtime down
    # FIRST (graceful drain) before bringing the monolith up. No-op when there's no split runtime.
    docker stop --time=60 oiia-runtime 2>/dev/null || true
    docker rm -f oiia-runtime 2>/dev/null || true
    # Graceful stop: SIGTERM + up to 60s for the app to DRAIN in-flight agent turns BEFORE removal.
    docker stop --time=60 oiia 2>/dev/null || true
    ln -sfn \"releases/\$REL\" \"$REMOTE_DIR/web-dist/current.tmp\" && mv -Tf \"$REMOTE_DIR/web-dist/current.tmp\" \"$REMOTE_DIR/web-dist/current\"
    ls -1dt \"$REMOTE_DIR\"/web-dist/releases/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
    docker rm -f oiia 2>/dev/null || true
    docker run -d --name oiia --restart unless-stopped \
      --memory=3g --memory-swap=3500m --memory-reservation=1536m --oom-score-adj=250 \
      -p \"$PORT:4317\" -e AGENT_WEB_TRUST_PROXY=1 \
      -e AGENT_WEB_WEB_DIST=/web-dist/current \
      -v \"$REMOTE_DIR/data:/data\" -v \"$REMOTE_DIR/web-dist:/web-dist\" \"${IMAGE}:${TAG}\"
  fi
  # Restore every prior operator-managed network and attach an explicitly requested new one. Docker
  # network names cannot contain whitespace; sort -u avoids duplicate connects when the explicit
  # network was already preserved. Names stay deployment state, never source defaults.
  printf '%s\\n%s\\n' \"\$PRESERVED_DOCKER_NETWORKS\" \"$OPTIONAL_DOCKER_NETWORK\" \
    | sed '/^\$/d' | sort -u \
    | while read -r network; do
        docker network inspect \"\$network\" >/dev/null 2>&1 || {
          echo \"WARNING: preserved Docker network no longer exists: \$network\" >&2
          continue
        }
        if ! docker network connect \"\$network\" oiia 2>/dev/null; then
          # docker network connect also fails when the container is already attached (e.g. bridge).
          # Accept that idempotent case, but fail the deploy if the required attachment is absent.
          docker inspect -f '{{range \$name, \$config := .NetworkSettings.Networks}}{{println \$name}}{{end}}' oiia \
            | grep -qxF \"\$network\" || {
              echo \"FATAL: could not attach oiia to required Docker network: \$network\" >&2
              exit 1
            }
        fi
      done
  sleep 4
  docker ps --filter name=oiia --format '{{.Names}} {{.Status}}'
  curl -fsS http://localhost:$PORT/healthz && echo
  # Reclaim superseded image tags now that the deploy is healthy. A plain 'image prune' only
  # removes DANGLING (untagged) images while every GHCR pull is sha-TAGGED. Instead, keep any
  # app image a container still references and a bounded set of recent rollback tags.
  # Deeper rollbacks re-pull from GHCR, which stays the source of truth.
  echo '→ pruning stale images (post-deploy)'
  REFED=\$(docker ps -a --format '{{.Image}}')
  docker images '$IMAGE' --format '{{.CreatedAt}} {{.Repository}}:{{.Tag}}' | sort -r | awk '{print \$NF}' \
    | grep -v ':latest\$' | tail -n +3 \
    | while read -r img; do printf '%s\n' \"\$REFED\" | grep -qxF \"\$img\" || docker rmi \"\$img\" >/dev/null 2>&1 || true; done
  docker image prune -f --filter until=168h || true
  docker container prune -f --filter until=24h || true
  echo -n '→ disk: '; df -h / | tail -1 | awk '{print \$3\" used / \"\$2\" (\"\$5\")\"}'
"
echo "✓ deployed ${IMAGE}:${TAG} → http://$SERVER:$PORT/"
