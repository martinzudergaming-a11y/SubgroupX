#!/usr/bin/env bash
# Playwright webServer entrypoint: build the web bundle ONLY when it's stale, then start
# the app server against a throwaway data dir. The unconditional `npm run build` used to
# tax every e2e invocation (~15-20s of npm+vite) even when web/ hadn't changed.
set -euo pipefail
cd "$(dirname "$0")/.."

blog_mode="${AGENT_WEB_INTERNAL_BLOG:-1}"
blog_marker="web/dist/.internal-blog-mode"

if [ "${PW_FORCE_BUILD:-0}" = "1" ] || [ ! -f web/dist/index.html ]; then
  build_reason="forced or no dist"
elif [ "$(cat "$blog_marker" 2>/dev/null || printf 'unknown')" != "$blog_mode" ]; then
  # An enabled Blog review build must never be silently reused by the normal suite (or vice versa).
  # Source mtimes cannot detect a build-time flag change, so carry one tiny untracked provenance bit.
  build_reason="internal-blog mode changed"
else
  # Stale check: any source/config file newer than the built index.html triggers a rebuild.
  newer=$(find web/src web/index.html web/package.json web/vite.config.ts web/tsconfig.json -newer web/dist/index.html -print -quit 2>/dev/null || true)
  if [ -n "$newer" ]; then
    build_reason="$newer changed"
  else
    build_reason=""
  fi
fi

if [ -n "$build_reason" ]; then
  echo "[e2e-server] building web ($build_reason; internal-blog=$blog_mode)"
  (cd web && npm run build)
  printf '%s' "$blog_mode" > "$blog_marker"
else
  echo "[e2e-server] web/dist is fresh — skipping build (internal-blog=$blog_mode)"
fi

# Scope the throwaway data dir to the PORT. It used to be one fixed path wiped on every start, so
# two servers — a second worktree, a capture script on another port — silently destroyed each
# other's accounts and sessions mid-run, and the resulting failures looked like product bugs.
PORT="${PORT:-4319}"
DATA_DIR="/tmp/agentweb-pw-${PORT}"
rm -rf "$DATA_DIR"
PORT="$PORT" \
AGENT_WEB_DATA_DIR="$DATA_DIR" \
AGENT_WEB_SECRET=pw-secret \
AGENT_WEB_KEY_SECRET=pw-secret \
AGENT_WEB_SSH_EXECUTOR=1 \
AGENT_WEB_ALLOW_UNCONFINED_LOCAL=1 \
AGENT_WEB_ADMIN_EMAILS=admin@e2e.dev,admin2@e2e.dev,admin3@e2e.dev \
AGENT_WEB_ALLOWED_EMAIL_DOMAINS='*' \
AGENT_WEB_MCP='[{"id":"demo","command":"node","args":["examples/mcp-demo-server.mjs"]}]' \
exec npx tsx server/src/index.ts
