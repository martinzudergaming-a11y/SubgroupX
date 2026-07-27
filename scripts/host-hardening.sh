#!/usr/bin/env bash
# One-time (idempotent) resilience hardening for an oiia application host.
#
# A transient memory spike can push a small host into reclaim-stall / OOM. This script adds
# shock absorbers so the application degrades gracefully while remote access stays available:
#
#   1. Configurable swapfile + vm.swappiness=10 — emergency capacity without steady paging.
#   2. sshd OOM protection (systemd)      — the box stays loginable under pressure.
#   3. earlyoom                           — kills the biggest hog *before* a deep
#                                           reclaim stall, never sshd/dockerd/init.
#
# Safe to re-run: every step checks current state first. Run it on the host:
#
#   ssh -i <key> root@<host> 'bash -s' < scripts/host-hardening.sh
#
# Pairs with the container resource caps in scripts/deploy.sh (--memory / --oom-score-adj).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

SWAPFILE=/swapfile
SWAP_GB="${SWAP_GB:-4}"

echo "==> 1/3 swap"
if swapon --show --noheadings 2>/dev/null | grep -q .; then
  echo "    swap already active — leaving as is:"
  swapon --show
else
  echo "    no swap active — creating ${SWAP_GB}G ${SWAPFILE}"
  if [ ! -f "$SWAPFILE" ]; then
    # fallocate can yield a sparse file unsuitable for swap on some FS; fall back to dd.
    fallocate -l "${SWAP_GB}G" "$SWAPFILE" 2>/dev/null \
      || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024)) status=none
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  swapon --show
fi
# Persist across reboots (idempotent fstab entry).
if ! grep -qE "^\s*${SWAPFILE//\//\\/}\s" /etc/fstab; then
  echo "${SWAPFILE} none swap sw 0 0" >>/etc/fstab
  echo "    added ${SWAPFILE} to /etc/fstab"
fi
# Low swappiness: use swap only as an emergency cushion, not for steady-state paging.
rm -f /etc/sysctl.d/99-o11n-swap.conf # pre-rename twin of the file below; same value, stale name
printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-oiia-swap.conf
sysctl -w vm.swappiness=10 >/dev/null
echo "    vm.swappiness=$(cat /proc/sys/vm/swappiness)"

echo "==> 2/3 sshd OOM protection"
SSH_UNIT=ssh.service
systemctl list-unit-files "$SSH_UNIT" >/dev/null 2>&1 || SSH_UNIT=sshd.service
DROPIN="/etc/systemd/system/${SSH_UNIT}.d/10-resilience.conf"
mkdir -p "$(dirname "$DROPIN")"
cat >"$DROPIN" <<'EOF'
# Keep the box loginable under memory pressure: the kernel OOM-killer will sacrifice
# the app/build (positive oom_score) long before sshd, and cgroup v2 reserves a floor.
[Service]
OOMScoreAdjust=-1000
MemoryMin=128M
EOF
systemctl daemon-reload
systemctl try-reload-or-restart "$SSH_UNIT" 2>/dev/null || true
# A reload (SIGHUP) does NOT re-apply OOMScoreAdjust to the already-running listener,
# so set it directly on the live sshd process(es) for immediate protection; children
# forked for new connections inherit it. (systemd persists -1000 across reboots.)
# Cover both the `sshd` listener AND `sshd-session` workers (newer OpenSSH splits the
# per-connection handler into its own process) so a re-run protects existing sessions too.
for p in $(pgrep -x sshd 2>/dev/null) $(pgrep -x sshd-session 2>/dev/null); do
  echo -1000 >"/proc/$p/oom_score_adj" 2>/dev/null || true
done
echo "    ${SSH_UNIT}: OOMScoreAdjust=-1000 MemoryMin=128M (also applied live)"

echo "==> 3/3 earlyoom"
if ! command -v earlyoom >/dev/null 2>&1; then
  echo "    installing earlyoom"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq earlyoom >/dev/null
fi
# Act at mem<5% AND swap<10% free; report hourly. Never kill the infra that keeps the
# box alive + reachable + recoverable (sshd/systemd/dockerd/containerd/init/earlyoom);
# earlyoom then targets the largest remaining RSS — the build or the app, both of which
# auto-recover (docker --restart / a re-deploy). NOTE: no inner quotes around the regex —
# systemd splits $EARLYOOM_ARGS on whitespace without honoring quotes, so quotes would be
# passed literally to earlyoom and break the match. The regex has no spaces, so none needed.
EOA="EARLYOOM_ARGS=\"-r 3600 -m 5 -s 10 --avoid ^(sshd|systemd|dockerd|containerd|init|earlyoom)\$\""
if [ -f /etc/default/earlyoom ]; then
  sed -i '/^EARLYOOM_ARGS=/d' /etc/default/earlyoom
  echo "$EOA" >>/etc/default/earlyoom
else
  echo "$EOA" >/etc/default/earlyoom
fi
# enable for boot, then ALWAYS restart: `enable --now` is a no-op on an already-running
# service (apt's postinst starts earlyoom with stock args), so without an explicit restart
# our /etc/default/earlyoom edits would never take effect.
systemctl enable earlyoom >/dev/null 2>&1 || true
systemctl restart earlyoom

echo
echo "==> done. status:"
free -h
echo "swappiness=$(cat /proc/sys/vm/swappiness)"
systemctl is-active earlyoom 2>/dev/null | sed 's/^/earlyoom: /'
systemctl show "$SSH_UNIT" -p OOMScoreAdjust --value 2>/dev/null | sed 's/^/sshd OOMScoreAdjust=/'
