#!/usr/bin/env bash
# Everything after `docker compose up`: A–E, the System One additions, logs. One summary line per step; exits 1
# when a step did (a step's own FAIL lines are printed under its line; its whole output is in evidence/).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
cd "$W/scripts"
step() { # step NAME EVIDENCE-FILE command…
  local name="$1" out="$W/evidence/$2"; shift 2
  "$@" > "$out" 2>&1; local rc=$?
  printf '%-28s exit=%s  %s\n' "$name" "$rc" "$(grep -E '^[0-9]+/[0-9]+ passed' "$out" | tail -1)"
  grep -E '^FAIL' "$out" || true
  [ "$rc" -eq 0 ] || failed=$((failed + 1))
}
failed=0
cp "$W/logs/03-up.log" "$W/evidence/up.log"  # the stack is already up (03-up.sh ran right after the build)
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$NOAH/api/bootstrap")" = 200 ] && break; sleep 2; done
step 05-pi-setup-logs      A1-pi-setup.log              ./05-pi-setup-logs.sh
step 20-boot-checks        A-boot-checks.log            ./20-boot-checks.sh
step 10-accounts           accounts.log                 node 10-accounts.mjs
step 04-fake-llm           fake-llm-setup.log           ./04-fake-llm.sh
step 21-admin-proxy        A-B1-admin-proxy.log         node 21-admin-proxy.mjs
step 24-llm-no-falcon-tier   A-llm-without-falcon-tier.log node 24-llm-without-falcon-tier.mjs
step 22-admin-proxy-extra  B1-admin-proxy-extra.log     node 22-admin-proxy-extra.mjs
step 23-admin-ui-assets    A-admin-ui-assets.log        node 23-admin-ui-assets.mjs
step 30-documents          C-documents.log              node 30-documents.mjs
step 31-documents-extra    C-documents-extra.log        node 31-documents-extra.mjs
step 32-second-user-own    C-second-user-own-avatar.log node 32-second-user-own-avatar.mjs
step 50-subagent           E-subagent.log               node 50-subagent.mjs
step 55-systemone          S1-systemone.log             node 55-systemone.mjs
step 40-same-origin        D-same-origin.log            ./40-same-origin.sh
step 60-security-check     A-security-check.log         ./60-security-check.sh
step 65-shell-step-verdicts A-shell-steps.log           node 65-shell-step-verdicts.mjs
for s in noah-almighty gateway sandboxd mcp-broker egress-proxy; do dc logs --no-log-prefix "$s" > "$W/evidence/logs-$s.log" 2>&1; done
{ dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}'; dind docker ps -a --filter label=pi-gateway.sandbox=1 --format '{{.Names}}\t{{.Image}}\t{{.Status}}'; } > "$W/evidence/final-dind-state.txt" 2>&1
[ "$failed" -eq 0 ]
