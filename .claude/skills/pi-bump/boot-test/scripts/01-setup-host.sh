#!/usr/bin/env bash
# Runs Noah's docker/pi/setup-host.sh inside the dind (root there). Output goes to a log; lines carrying
# freshly generated key values are filtered out of what is kept and shown. stdin is closed: pi's setup-host
# asks for a git token with `read`.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
docker exec -w "$W/noah-almighty" "$DIND" bash docker/pi/setup-host.sh </dev/null > "$W/logs/01-setup-host.raw.log" 2>&1
rc=$?
grep -vE '^\s*(admin_api_key|api_key):' "$W/logs/01-setup-host.raw.log" > "$W/logs/01-setup-host.log" || true
rm -f "$W/logs/01-setup-host.raw.log"
cat "$W/logs/01-setup-host.log"
[ "$rc" -eq 0 ] || echo "setup-host exit $rc"
exit "$rc"
