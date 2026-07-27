#!/usr/bin/env bash
# Frontend-ONLY deploy (#197 Phase 1): build web/dist and publish it into the runtime's WEB_DIST
# volume WITHOUT restarting the oiia container — so a UI change never drains/interrupts a running
# agent turn. express.static serves content-hashed /assets (immutable) and a no-cache index.html, so
# clients pick up the new bundle on the next load.
#
# Zero-downtime swap: each deploy lands in releases/<ts>/ and we atomically repoint the `current`
# symlink (a single rename), so no request ever sees a half-written dist or a missing hashed asset.
# The runtime's AGENT_WEB_WEB_DIST points at <volume>/current (see deploy.sh).
#
#   SERVER=<host> SSH_KEY=<key> ./scripts/deploy-web.sh
# New machine reachable only via a jump host? Set SSH_JUMP=root@<jump> (uses ssh -J).
set -euo pipefail

SERVER="${SERVER:?set SERVER=<host>}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:?set SSH_KEY=<path to private key>}"
REMOTE_DIR="${REMOTE_DIR:-/opt/oiia/web-dist}"   # host dir mounted into the container at /web-dist
LEGACY_REMOTE_ROOT="${LEGACY_REMOTE_ROOT:-/opt/o11n}" # upgrade compatibility for pre-rename hosts
KEEP="${KEEP:-5}"                                  # releases to retain for rollback
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o IdentityAgent=none \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes)
[ -n "${SSH_JUMP:-}" ] && SSH_OPTS+=(-J "$SSH_JUMP")
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Collision-resistant release id: second-resolution alone lets two deploys in the same second share
# a dir, and the 2nd rsync --delete would then mutate the release `current` already points at.
TS="$(date -u +%Y%m%d-%H%M%S)-$$-${RANDOM}"

echo "→ building web bundle"
# Inject a real (non-"dev") BUILD_VERSION so the bundle's __APP_VERSION__ is meaningful: ws.ts
# suppresses the runtime/frontend version-drift warning when the client reports "dev", which would
# hide an incompatible frontend after a UI-only deploy. Mirrors the Dockerfile's BUILD_VERSION arg.
# Version = <short-sha>-<DDMonYYYY> (e.g. 26f45d3-04Jul2026): the sha keeps it unique + traceable,
# the date is human-readable and day-precise (month as a name, so DD/MM is never ambiguous). LC_ALL=C
# pins English month abbreviations regardless of the deployer's locale.
BUILD_VERSION="${BUILD_VERSION:-$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo web)-$(LC_ALL=C date -u +%d%b%Y)}"
( cd "$HERE" && BUILD_VERSION="$BUILD_VERSION" npm run build:web )
echo "  built bundle version: $BUILD_VERSION"
[ -f "$HERE/web/dist/index.html" ] || { echo "build produced no web/dist/index.html"; exit 1; }
# Marker the runtime reads (config.servedAppVersion) to report THIS bundle's version in the WS
# hello — so a UI-only deploy bumps the version the stale-tab check compares against (the runtime's
# own image version is independent here). Must equal the bundle's baked __APP_VERSION__ → same var.
printf '%s' "$BUILD_VERSION" > "$HERE/web/dist/version.txt"

echo "→ publishing release $TS → $SERVER:$REMOTE_DIR/releases/$TS"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" "
  set -e
  if [ '$REMOTE_DIR' = /opt/oiia/web-dist ] && [ ! -e /opt/oiia ] && [ -d '$LEGACY_REMOTE_ROOT' ]; then
    # Never move a bind source out from under the running runtime during a frontend-only deploy.
    # The compatibility symlink lets new tooling use /opt/oiia while old container HostConfig and
    # rollback still point at the intact pre-rename path.
    echo '  linking /opt/oiia to the pre-rename data root (no runtime restart)'
    ln -s '$LEGACY_REMOTE_ROOT' /opt/oiia
  fi
  mkdir -p '$REMOTE_DIR/releases/$TS'
"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "$HERE/web/dist/" "$SSH_USER@$SERVER:$REMOTE_DIR/releases/$TS/"

echo "→ atomically repointing current → releases/$TS (no restart)"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$SERVER" "
  set -e
  cd '$REMOTE_DIR'
  ln -sfn 'releases/$TS' current.tmp && mv -Tf current.tmp current   # atomic rename swap
  # prune old releases, keeping the newest \$KEEP
  ls -1dt releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
  echo '  current → '\$(readlink current)
"
echo "✓ frontend updated with no runtime restart; clients get the new bundle on next load."
echo "  rollback: ssh … 'ln -sfn releases/<prev> $REMOTE_DIR/current.tmp && mv -Tf $REMOTE_DIR/current.tmp $REMOTE_DIR/current'"
