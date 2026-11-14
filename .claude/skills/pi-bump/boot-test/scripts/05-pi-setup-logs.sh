#!/usr/bin/env bash
# A: pi-setup's first-run log, then a re-run that must change nothing.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
dc logs --no-log-prefix pi-setup > "$W/evidence/A1-pi-setup-first.log" 2>&1
echo "first run: $(grep -c '^PUT ' "$W/evidence/A1-pi-setup-first.log") PUT lines; $(grep -vc '^PUT ' "$W/evidence/A1-pi-setup-first.log") other lines:"; grep -v '^PUT ' "$W/evidence/A1-pi-setup-first.log"
dc up -d pi-setup >/dev/null 2>&1; sleep 3
dc logs --no-log-prefix pi-setup > "$W/evidence/A1-pi-setup-all.log" 2>&1
n=$(wc -l < "$W/evidence/A1-pi-setup-first.log")
tail -n +$((n+1)) "$W/evidence/A1-pi-setup-all.log" > "$W/evidence/A1-pi-setup-rerun.log"
echo "re-run: $(grep -c '(unchanged)' "$W/evidence/A1-pi-setup-rerun.log") '(unchanged)' lines; other lines:"; grep -v '(unchanged)' "$W/evidence/A1-pi-setup-rerun.log"
