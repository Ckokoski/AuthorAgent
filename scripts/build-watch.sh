#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# AuthorClaw test-build watcher
# ═══════════════════════════════════════════════════════════
# Invoked periodically by authorclaw-build.timer (see scripts/systemd/).
#
# If a `build_now` sentinel file exists in the repo root, rebuild the
# Docker image from the CURRENT working tree and (re)start the standard
# `authorclaw` container on port 3847, then remove the sentinel.
#
# Why a sentinel instead of inotify: this repo lives on Mercury's local
# disk and is exported over NFS to the workstations you edit from. inotify
# does NOT reliably fire on an NFS server for writes made by remote NFS
# clients, but a plain `test -e` on the local disk always sees the file —
# so `touch build_now` from any machine reliably triggers a rebuild here.
#
# The sentinel is consumed at the START of a run so a slow build is not
# re-triggered by the next timer tick. If a build FAILS, `touch build_now`
# again to retry. Build output goes to .build-logs/ (gitignored).
# ═══════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

SENTINEL="$PROJECT_DIR/build_now"
LOG_DIR="$PROJECT_DIR/.build-logs"

# Fast path: nothing to do unless the sentinel is present.
[ -e "$SENTINEL" ] || exit 0

mkdir -p "$LOG_DIR"

# Serialize: never run two builds at once. If a build is already running,
# leave the sentinel in place so a later tick picks it up.
exec 9>"$LOG_DIR/.lock"
flock -n 9 || exit 0

# Re-check after acquiring the lock — a concurrent run may have consumed it.
[ -e "$SENTINEL" ] || exit 0

TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/build-$TS.log"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# Consume the sentinel up front so a long build isn't re-triggered.
rm -f "$SENTINEL"

# Reuse the stable vault key from the repo .env so the persisted
# authorclaw-vault volume stays decryptable across rebuilds. (Without this
# deploy.sh generates a throwaway key and orphans the existing vault.)
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$PROJECT_DIR/.env"
    set +a
fi

{
    echo "═══════════════════════════════════════"
    echo " AuthorClaw test build"
    echo " started : $(date -Is)"
    echo " commit  : $COMMIT"
    echo " tree    : $PROJECT_DIR"
    echo "═══════════════════════════════════════"
} | tee "$LOG_FILE"

STATUS=PASS
if bash "$SCRIPT_DIR/deploy.sh" >>"$LOG_FILE" 2>&1; then
    STATUS=PASS
else
    STATUS=FAIL
fi

# Record container state for at-a-glance diagnosis.
docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" ps >>"$LOG_FILE" 2>&1 || true

{
    echo "═══════════════════════════════════════"
    echo " finished: $(date -Is)"
    echo " result  : $STATUS"
} | tee -a "$LOG_FILE"

# Point latest.log at this run and record a one-line machine-readable status.
ln -sfn "$(basename "$LOG_FILE")" "$LOG_DIR/latest.log"
echo "$(date -Is) commit=$COMMIT result=$STATUS log=$(basename "$LOG_FILE")" \
    > "$LOG_DIR/last-build.status"

# Keep only the 20 most recent build logs.
ls -1t "$LOG_DIR"/build-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f

# Surface failure to systemd so `systemctl status authorclaw-build` is honest.
[ "$STATUS" = PASS ]
