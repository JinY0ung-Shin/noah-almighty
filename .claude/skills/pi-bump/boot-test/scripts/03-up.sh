#!/usr/bin/env bash
# `docker compose up -d` of the exported tree inside the dind; exits with compose's status.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
dc up -d > "$W/logs/03-up.log" 2>&1; rc=$?
echo "up exit=$rc"
tail -n 25 "$W/logs/03-up.log"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
exit "$rc"
