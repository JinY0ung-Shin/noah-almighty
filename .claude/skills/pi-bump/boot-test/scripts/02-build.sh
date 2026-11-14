#!/usr/bin/env bash
# `docker compose build` of the exported tree inside the dind (about 3 minutes cold on the box it was written on).
# The whole build output is logs/02-build.log; one line with the exit status and the seconds is printed.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
start=$(date +%s)
docker exec -w "$W/noah-almighty" "$DIND" docker compose --progress plain build > "$W/logs/02-build.log" 2>&1
rc=$?
end=$(date +%s)
echo "build exit=$rc seconds=$((end-start))" | tee "$W/logs/02-build.time"
exit $rc
