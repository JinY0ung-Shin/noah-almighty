#!/usr/bin/env bash
# A: pi's scripts/security-check/run.mjs, piped into sandboxd (its rootfs is read-only).
#   run 1 (the documented one): --internal noah-almighty:48787 plus each Noah IP
#   run 2 (extra): pi's own default internal targets (gateway, sandboxd, mcp-broker)
set -uo pipefail
. "$(dirname "$0")/lib.sh"
IPS=$(dind docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' noah-almighty-noah-almighty-1)
echo "Noah IPs: $IPS"
ARGS=(--internal noah-almighty:48787)
for ip in $IPS; do ARGS+=(--internal "$ip:48787"); done
dc exec -T sandboxd node --input-type=module - "${ARGS[@]}" < "$W/noah-almighty/vendor/pi-gateway/scripts/security-check/run.mjs" > "$W/evidence/A-security-report-noah.md" 2> "$W/evidence/A-security-err-noah.txt"
echo "run 1 exit=$?  $(cat "$W/evidence/A-security-err-noah.txt")"
grep -m1 '결과:' "$W/evidence/A-security-report-noah.md"
dc exec -T sandboxd node --input-type=module - < "$W/noah-almighty/vendor/pi-gateway/scripts/security-check/run.mjs" > "$W/evidence/A-security-report-pi-defaults.md" 2> "$W/evidence/A-security-err-pi-defaults.txt"
echo "run 2 exit=$?  $(cat "$W/evidence/A-security-err-pi-defaults.txt")"
grep -m1 '결과:' "$W/evidence/A-security-report-pi-defaults.md"
echo "== non-PASS rows (both reports)"
grep -hE '^\|' "$W/evidence/A-security-report-noah.md" "$W/evidence/A-security-report-pi-defaults.md" | grep -vE 'PASS|^\| 영역|^\|---' | cut -c1-260
echo "== sandboxes now"
dind docker ps -a --filter label=pi-gateway.sandbox=1 --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | while IFS=$'\t' read -r name image status; do
  printf '%s\t%s\t%s\tnetwork=%s\n' "$name" "$image" "$status" "$(dind docker inspect -f '{{.HostConfig.NetworkMode}}' "$name")"
done
