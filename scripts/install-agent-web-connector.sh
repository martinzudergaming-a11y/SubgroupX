#!/bin/sh
set -eu

url="${AGENT_WEB_URL:-}"
pair_code="${AGENT_WEB_CONNECTOR_PAIR_CODE:-}"
home_dir="${HOME:-.}"
token_file="${AGENT_WEB_CONNECTOR_TOKEN_FILE:-$home_dir/.agent-web/connector.token}"
root="${AGENT_WEB_CONNECTOR_ROOT:-$home_dir/.agent-web/workspaces}"
name="${AGENT_WEB_CONNECTOR_NAME:-}"

usage() {
  echo "usage: install-agent-web-connector.sh --url URL --pair-code CODE [--token-file PATH] [--root PATH] [--name NAME]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      url="${2:-}"
      shift 2
      ;;
    --pair-code)
      pair_code="${2:-}"
      shift 2
      ;;
    --token-file)
      token_file="${2:-}"
      shift 2
      ;;
    --root)
      root="${2:-}"
      shift 2
      ;;
    --name)
      name="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$url" ] || [ -z "$pair_code" ]; then
  usage
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 2
fi

# The installer + daemon source are fetched over $url and piped straight into a
# shell/node. Over plain http to a non-loopback host a network attacker can swap the
# payload before the pair-code ever matters — i.e. arbitrary code execution here. Refuse
# that by default (https or loopback only); AGENT_WEB_CONNECTOR_ALLOW_INSECURE=1 overrides.
case "$url" in
  https://*) ;;
  http://localhost | http://localhost/* | http://localhost:* ) ;;
  http://127.0.0.1 | http://127.0.0.1/* | http://127.0.0.1:* ) ;;
  *)
    if [ "${AGENT_WEB_CONNECTOR_ALLOW_INSECURE:-}" = "1" ]; then
      echo "warning: fetching the connector bootstrap over an insecure --url ($url); a network attacker could replace it" >&2
    else
      echo "refusing insecure --url '$url': the installer + daemon are fetched over this URL and executed, so plain http to a non-loopback host lets a network attacker run arbitrary code on this machine." >&2
      echo "use an https URL, target localhost/127.0.0.1, or set AGENT_WEB_CONNECTOR_ALLOW_INSECURE=1 to override." >&2
      exit 2
    fi
    ;;
esac

daemon_url="${url%/}/api/connectors/agent-web-connector.mjs"

# Expand a leading ~/ in paths. The command is usually pasted with ~ inside quotes, which
# the shell does NOT expand — so a directory literally named "~" would be created. Be
# foolproof and expand it here ourselves.
case "$root" in
  "~/"*) root="$home_dir/${root#"~/"}" ;;
  "~") root="$home_dir" ;;
esac
case "$token_file" in
  "~/"*) token_file="$home_dir/${token_file#"~/"}" ;;
  "~") token_file="$home_dir" ;;
esac

# We `cd` into the install dir before launching the daemon (so its imports resolve), which
# would change what a RELATIVE --root/--token-file points to. Anchor any relative path to
# the directory the user actually ran this from, before that cd.
invoked_from="$(pwd)"
case "$root" in /*) ;; *) root="$invoked_from/$root" ;; esac
case "$token_file" in /*) ;; *) token_file="$invoked_from/$token_file" ;; esac

# The daemon STATICALLY imports "ws" (hard dependency) and dynamically imports node-pty
# (optional — PTY just degrades if it's missing). The old approach piped the daemon into
# `node -` (read from stdin); a stdin script resolves bare imports from the CURRENT
# directory, not from any `npm exec --package` temp dir, so "ws" was never found on a clean
# machine. Instead: download the daemon to a real install dir, install its deps THERE, and
# run node from THERE so module resolution actually finds them. Re-running is idempotent.
install_dir="${AGENT_WEB_CONNECTOR_HOME:-$home_dir/.agent-web/connector}"
mkdir -p "$install_dir"
daemon_file="$install_dir/agent-web-connector.mjs"

# ---------------------------------------------------------------------------
# NETWORK PROBE / MIRROR SWITCH / TEMPORARY NODE RUNTIME
#
# Some networks (notably China) cannot reach registry.npmjs.org / nodejs.org. We
# probe for real (validating response BODIES, not just TCP) and, if blocked, point
# npm and our own Node downloads at registry.npmmirror.com. We may also need to fetch
# a matching Node into the install dir as a TEMPORARY runtime (node-pty wants Node
# 22/24 prebuilds; >=25 has none) without touching PATH or nvm. NODE_BIN / npm are
# then threaded through both `npm install` and the final `exec`.
# ---------------------------------------------------------------------------

# AGENT_WEB_CONNECTOR_MIRROR:
#   auto: probe official endpoints; use CN mirrors if any required probe fails
#   cn:   force CN mirrors; skip probes
#   off:  force official endpoints; skip probes
: "${AGENT_WEB_CONNECTOR_MIRROR:=auto}"
: "${NODE_VERSION:=22.17.0}"

# Probe timeouts: long enough that a slow-but-WORKING TLS handshake (observed: some CDNs need
# 6-8 s) isn't misread as "blocked" — which would wrongly route a non-China user through the CN
# mirror — yet short enough that a genuinely blackholed endpoint (GFW) still falls back quickly
# (~2x connect on the npm+node probes). Override with CURL_CONNECT_TIMEOUT / CURL_MAX_TIME.
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-8}"
CURL_MAX_TIME="${CURL_MAX_TIME:-20}"

# ── Diagnostic phase tracer (issue #265) ────────────────────────────────────
# The setup's network steps — CN-mirror probe, ~50 MB Node download, npm install —
# are otherwise a silent black box: on a slow/blocked network the user just sees a
# frozen terminal and we can't tell from a screenshot WHERE it hung. So every stage
# prints one greppable line to stderr. Legend (printed once, up front):
#   [.] working   [+] done   [x] failed (aborts)
# A frozen screenshot then shows the last "[.] <phase>" with no matching "[+] <phase>"
# right below it → that phase is the stall. The daemon continues the same scheme with
# [o] online / [-] disconnected / [0] timeout once setup hands off (see the .mjs).
PHASE="startup"
phase() { PHASE="$1"; printf '[.] %s%s\n' "$1" "${2:+ — $2}" >&2; }
ok()    { printf '[+] %s%s\n' "${1:-$PHASE}" "${2:+ — $2}" >&2; }

die() {
  printf '[x] %s — %s\n' "${PHASE:-setup}" "$*" >&2
  exit 1
}

printf 'agent-web connector setup — progress legend:  [.] working   [+] done   [x] failed\n' >&2

# Pre-create the workspace root and FAIL FAST if it can't be made — e.g. a typo'd absolute path on
# a read-only volume (the old behavior was the daemon crashing with a raw ENOENT only AFTER the full
# Node + npm download). Creating it here also means the daemon's own mkdir then just succeeds.
phase "workspace" "$root"
mkdir -p "$root" 2>/dev/null || die "cannot create the workspace root '$root' — re-run with a --root you can write to (e.g. --root ~/agent-web/workspaces)."
ok

curl_https() {
  curl -fsSL \
    --proto '=https' \
    --proto-redir '=https' \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$CURL_MAX_TIME" \
    "$1"
}

probe_url_contains() {
  probe_target="$1"
  probe_pattern="$2"
  # mktemp (unpredictable 0600) instead of a predictable $$ name in shared /tmp, so a local
  # attacker can't pre-create a symlink to redirect the probe write.
  probe_tmp="$(mktemp "${TMPDIR:-/tmp}/agent-web-probe.XXXXXX")" || return 1
  if curl_https "$probe_target" >"$probe_tmp" 2>/dev/null && grep -Eq "$probe_pattern" "$probe_tmp"; then
    rm -f "$probe_tmp"
    return 0
  fi
  rm -f "$probe_tmp"
  return 1
}

probe_npm_official() {
  # Probe the actual scoped package, not just TCP or registry ping.
  probe_url_contains \
    "https://registry.npmjs.org/@homebridge%2fnode-pty-prebuilt-multiarch" \
    '"0[.]13[.]1"'
}

probe_node_official() {
  # Probe real release metadata and validate expected release filenames.
  probe_url_contains \
    "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" \
    "node-v$NODE_VERSION-.*[.]tar[.]gz"
}

USE_CN_MIRROR=0
case "$AGENT_WEB_CONNECTOR_MIRROR" in
  cn)
    USE_CN_MIRROR=1
    ;;
  off)
    USE_CN_MIRROR=0
    ;;
  auto)
    USE_CN_MIRROR=0
    phase "probe" "checking npm/Node reachability (≤${CURL_MAX_TIME}s each)"
    if ! probe_npm_official || ! probe_node_official; then
      USE_CN_MIRROR=1
      ok "probe" "official endpoints blocked → China mirror"
    else
      ok "probe" "official endpoints reachable"
    fi
    ;;
  *)
    die "AGENT_WEB_CONNECTOR_MIRROR must be auto, cn, or off"
    ;;
esac

NPM_REGISTRY_OFFICIAL="https://registry.npmjs.org/"
NPM_REGISTRY_CN="https://registry.npmmirror.com/"
NODE_DIST_OFFICIAL="https://nodejs.org/dist"
NODE_DIST_CN="https://npmmirror.com/mirrors/node"

apply_mirror_env() {
  if [ "$USE_CN_MIRROR" = "1" ]; then
    echo "note: public npm/Node endpoints look unreachable; using China mirror (registry.npmmirror.com). Override with AGENT_WEB_CONNECTOR_MIRROR=off." >&2
    export npm_config_registry="$NPM_REGISTRY_CN"

    # Used by this script for temporary Node downloads.
    NODE_DIST_BASE="$NODE_DIST_CN"

    # Used by node-gyp fallback for Node headers. This does NOT control
    # @homebridge/node-pty-prebuilt-multiarch prebuild downloads.
    export npm_config_disturl="$NODE_DIST_CN"
    export NODEJS_ORG_MIRROR="$NODE_DIST_CN"

    # @homebridge/node-pty-prebuilt-multiarch@0.13.1 uses prebuild-install.
    # Correct prebuild-install env var for this scoped package:
    #   npm_config_homebridge_node_pty_prebuilt_multiarch_binary_host_mirror
    #
    # It must point to a prebuild-install-compatible host where this exists:
    #   $host/v0.13.1/node-pty-prebuilt-multiarch-v0.13.1-node-v127-linux-x64.tar.gz
    #
    # No public npmmirror-hosted @homebridge node-pty prebuild mirror is assumed.
    if [ -n "${AGENT_WEB_CONNECTOR_NODE_PTY_MIRROR:-}" ]; then
      export npm_config_homebridge_node_pty_prebuilt_multiarch_binary_host_mirror="${AGENT_WEB_CONNECTOR_NODE_PTY_MIRROR%/}"
    fi
  else
    export npm_config_registry="$NPM_REGISTRY_OFFICIAL"
    NODE_DIST_BASE="$NODE_DIST_OFFICIAL"
  fi
}

node_major_of() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

system_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  sn_major="$(node_major_of "$(command -v node)")" || return 1
  case "$sn_major" in
    22|24) return 0 ;;
    *) return 1 ;;
  esac
}

detect_node_target() {
  case "$(uname -s)" in
    Linux) node_os="linux" ;;
    Darwin) node_os="darwin" ;;
    *) die "unsupported OS for temporary Node: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) die "unsupported CPU for temporary Node: $(uname -m)" ;;
  esac

  node_libc="glibc"
  if [ "$node_os" = "linux" ]; then
    if { ldd --version 2>&1 || true; } | grep -qi musl; then
      node_libc="musl"
    elif ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
      node_libc="musl"
    fi
  fi
}

sha256_check_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  else
    shasum -a 256 -c "$1"
  fi
}

download_file() {
  # A DOWNLOAD must be patient where a PROBE must fail fast: the probe's 5s connect-timeout
  # (CURL_CONNECT_TIMEOUT) exists to switch to the mirror quickly, but reusing it here makes the
  # ~50 MB Node tarball flap on slow/distant TLS (exactly the poor networks this feature targets —
  # observed: a CDN whose TLS handshake takes 6-8 s fails at 5 s but succeeds with a longer one).
  # So give downloads their own generous connect-timeout (override with CURL_DOWNLOAD_CONNECT_TIMEOUT).
  curl -fL \
    --proto '=https' \
    --proto-redir '=https' \
    --connect-timeout "${CURL_DOWNLOAD_CONNECT_TIMEOUT:-30}" \
    --max-time "${CURL_DOWNLOAD_MAX_TIME:-300}" \
    -o "$2" \
    "$1"
}

download_temp_node() {
  # Only needed when we actually have to fetch + unpack a runtime, so the happy path
  # (suitable system Node already present) does not require tar.
  command -v tar >/dev/null 2>&1 || die "tar is required to install the temporary Node runtime (or provide a working system node/npm, or NODE_BIN/NPM_BIN)"

  detect_node_target

  if [ "$node_os" = "linux" ] && [ "$node_libc" = "musl" ]; then
    # Help a system Node's node-pty prebuild search linuxmusl assets if one ever runs.
    export npm_config_libc=musl
    die "Alpine/musl detected: official nodejs.org/npmmirror Node tarballs are glibc; install Node 22 or 24 with apk (apk add nodejs npm) or provide a working system node/npm"
  fi

  node_name="node-v$NODE_VERSION-$node_os-$node_arch"
  node_file="$node_name.tar.gz"
  node_dir="$install_dir/$node_name"

  # Idempotent: reuse an already-downloaded temp Node of the right version.
  if [ -x "$node_dir/bin/node" ] &&
     [ "$("$node_dir/bin/node" -p 'process.versions.node' 2>/dev/null)" = "$NODE_VERSION" ]; then
    NODE_BIN="$node_dir/bin/node"
    NPM_CLI="$node_dir/lib/node_modules/npm/bin/npm-cli.js"
    ok "node-dl" "reused cached v$NODE_VERSION"
    return 0
  fi

  # The ~50 MB tarball over a slow/distant TLS link is the single longest, most-frozen-looking
  # step (issue #265) — announce it as a phase so a stalled screenshot points right here.
  phase "node-dl" "fetching Node v$NODE_VERSION ($node_os-$node_arch), ~50 MB — this can take a few minutes"

  # mktemp -d creates unpredictable 0700 dirs, closing the symlink/race window a predictable
  # $$ name would open if $install_dir were ever group/world-writable (Codex security review).
  # Kept inside $install_dir so the final `mv` is a same-filesystem (atomic) rename.
  tmp_dir="$(mktemp -d "$install_dir/.node-dl.XXXXXX")" || die "failed to create a temp dir under $install_dir"
  extract_dir="$(mktemp -d "$install_dir/.node-x.XXXXXX")" || die "failed to create a temp dir under $install_dir"

  node_url="$NODE_DIST_BASE/v$NODE_VERSION/$node_file"
  sums_url="$NODE_DIST_BASE/v$NODE_VERSION/SHASUMS256.txt"

  download_file "$node_url" "$tmp_dir/$node_file" ||
    die "failed to download $node_url"

  if ! download_file "$sums_url" "$tmp_dir/SHASUMS256.txt"; then
    # If official checksum fetch is blocked but mirror mode was not already on,
    # fall back to npmmirror's checksum file.
    mirror_sums_url="$NODE_DIST_CN/v$NODE_VERSION/SHASUMS256.txt"
    download_file "$mirror_sums_url" "$tmp_dir/SHASUMS256.txt" ||
      die "failed to download SHASUMS256.txt from official or mirror"
  fi

  grep "  $node_file\$" "$tmp_dir/SHASUMS256.txt" >"$tmp_dir/SHASUMS256.selected" ||
    die "checksum entry missing for $node_file"

  (
    cd "$tmp_dir" &&
    sha256_check_file SHASUMS256.selected
  ) || die "checksum verification failed for $node_file"

  tar -xzf "$tmp_dir/$node_file" -C "$extract_dir" ||
    die "failed to extract $node_file"

  rm -rf "$node_dir"
  mv "$extract_dir/$node_name" "$node_dir" ||
    die "failed to install temporary Node into $node_dir"

  rm -rf "$tmp_dir" "$extract_dir"

  NODE_BIN="$node_dir/bin/node"
  NPM_CLI="$node_dir/lib/node_modules/npm/bin/npm-cli.js"
  ok "node-dl" "installed v$NODE_VERSION"
}

setup_node_runtime() {
  # Caller-provided runtime wins (e.g. preinstalled / air-gapped provisioning).
  if [ -n "${NODE_BIN:-}" ] && [ -n "${NPM_BIN:-}" ]; then
    NPM_CLI="${NPM_CLI:-}"
    return 0
  fi

  if system_node_ok; then
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm)"
    NPM_CLI=""
  else
    # node-pty wants Node 22/24 prebuilds; system node is absent or unsuitable.
    download_temp_node
    NPM_BIN=""
  fi
}

# Run npm with the selected runtime (system npm, a temp-Node npm-cli.js, or a
# caller-provided NPM_BIN), making sure lifecycle scripts also see our node first.
npm_cmd() {
  if [ -n "${NPM_CLI:-}" ]; then
    PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$NPM_CLI" "$@"
  else
    PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" "$@"
  fi
}

apply_mirror_env

if [ "${AGENT_WEB_CONNECTOR_NO_NPM:-}" = "1" ]; then
  # NO_NPM: caller pre-provisioned deps; we only need a node to run the daemon. Prefer a
  # caller-provided NODE_BIN, else system node, else a temp Node (no npm required here).
  if [ -z "${NODE_BIN:-}" ]; then
    if command -v node >/dev/null 2>&1; then
      NODE_BIN="$(command -v node)"
    else
      download_temp_node
    fi
  fi
  NPM_BIN="${NPM_BIN:-}"
  NPM_CLI="${NPM_CLI:-}"
else
  setup_node_runtime
fi

# Download the daemon over the (possibly mirror-adjusted, but always https) $url.
phase "daemon-dl" "fetching the connector daemon"
curl -fsSL -o "$daemon_file" -- "$daemon_url" || die "failed to download the connector daemon from $daemon_url"
ok "daemon-dl"

if [ "${AGENT_WEB_CONNECTOR_NO_NPM:-}" != "1" ]; then
  phase "npm" "installing runtime dependencies (ws + node-pty)"
  # package.json is the source of truth for what ends up in node_modules: `npm install`
  # reconciles node_modules to match it, so the deps must be listed here (not passed as
  # one-off `npm install <pkg>` args with --no-save, which prunes anything not listed).
  # Try ws + node-pty first; if the node-pty native build fails (common on a very new Node),
  # fall back to a ws-only manifest so the daemon still runs (PTY just degrades).
  printf '%s\n' '{ "name": "agent-web-connector-runtime", "private": true, "version": "0.0.0", "dependencies": { "ws": "8.18.0", "@homebridge/node-pty-prebuilt-multiarch": "0.13.1" } }' > "$install_dir/package.json"
  if ! ( cd "$install_dir" && npm_cmd install --no-audit --no-fund --loglevel=error ); then
    echo "note: installing the optional terminal dependency (node-pty) failed — retrying without it; everything except the in-browser terminal will work. This is usually a too-new Node; Node 22 or 24 is recommended." >&2
    printf '%s\n' '{ "name": "agent-web-connector-runtime", "private": true, "version": "0.0.0", "dependencies": { "ws": "8.18.0" } }' > "$install_dir/package.json"
    # ws is required — if THIS fails, set -e aborts with npm's own error.
    ( cd "$install_dir" && npm_cmd install --no-audit --no-fund --loglevel=error )
  fi
  ok "npm"
else
  # NO_NPM: the caller pre-provisioned deps. Verify "ws" actually resolves from the install
  # dir before we try to run, so the failure is a clear message instead of a stack trace.
  if ! ( cd "$install_dir" && "$NODE_BIN" -e "import('ws').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1 ); then
    echo "AGENT_WEB_CONNECTOR_NO_NPM=1 but 'ws' is not resolvable from $install_dir." >&2
    echo "Install it there (cd '$install_dir' && npm install ws) or unset AGENT_WEB_CONNECTOR_NO_NPM." >&2
    exit 2
  fi
fi

# A very new Node major usually has no node-pty prebuild; warn but continue (PTY is optional).
# Check the Node we actually selected, not whatever is on PATH.
node_major="$(node_major_of "$NODE_BIN" || echo 0)"
if [ "${node_major:-0}" -ge 25 ] 2>/dev/null; then
  echo "note: Node $node_major is newer than node-pty supports; the terminal feature may be disabled. Node 22 or 24 is recommended for full functionality." >&2
fi

cd "$install_dir"
set -- --url "$url" --pair-code "$pair_code" --token-file "$token_file" --root "$root"
if [ -n "$name" ]; then
  set -- "$@" --name "$name"
fi
ok "setup" "starting the connector daemon →"
exec "$NODE_BIN" "$daemon_file" "$@"