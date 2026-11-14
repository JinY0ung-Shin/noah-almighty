#!/usr/bin/env bash
# The end of a run: every service's whole log into evidence/, how many error-level and warn lines each holds,
# and what the gateway and the broker weigh — the "no error-level line" and "After the run: gateway N MiB" of a
# bump note. Exits 1 when any service logged at error level.
# (Noah's container is recreated twice by 40-same-origin.sh, so ITS log begins at the last recreate.)
set -uo pipefail
. "$(dirname "$0")/lib.sh"
bad=0
for s in noah-almighty gateway sandboxd mcp-broker egress-proxy jaeger; do
  dc logs --no-log-prefix "$s" > "$W/evidence/logs-final-$s.log" 2>&1
  errors=$(grep -cE '"level":(50|60)|"level":"(error|fatal)"' "$W/evidence/logs-final-$s.log")
  warns=$(grep -cE '"level":40|"level":"warn"' "$W/evidence/logs-final-$s.log")
  printf '%-14s lines=%-5s error-level=%s warn=%s\n' "$s" "$(wc -l < "$W/evidence/logs-final-$s.log")" "$errors" "$warns"
  [ "$errors" -eq 0 ] || bad=1
done
echo "--- warn messages (gateway, Noah):"
grep -hE '"level":40|"level":"warn"' "$W/evidence/logs-final-gateway.log" "$W/evidence/logs-final-noah-almighty.log" | grep -o '"msg":"[^"]\{0,90\}' | sort | uniq -c
echo "--- error-level lines (first 5 per service):"
for s in noah-almighty gateway sandboxd mcp-broker egress-proxy jaeger; do
  grep -E '"level":(50|60)|"level":"(error|fatal)"' "$W/evidence/logs-final-$s.log" | head -5 | cut -c1-400 | sed "s/^/$s: /"
done
echo "--- memory:"
dind docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' | grep -E 'noah-almighty-(gateway|mcp-broker|noah-almighty|sandboxd|jaeger)-1'
echo "--- services:"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
[ "$bad" -eq 0 ] && echo "1/1 passed" || echo "0/1 passed"
exit $bad
