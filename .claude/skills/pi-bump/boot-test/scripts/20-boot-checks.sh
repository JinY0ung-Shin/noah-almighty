#!/usr/bin/env bash
# A: documented boot checks that need no account (bootstrap, /mcp source check, Noah → pi /v1/models).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
echo "== /api/bootstrap (published port, from the host)"
curl -sS -w '\nHTTP %{http_code}\n' "$NOAH/api/bootstrap" | cut -c1-400
echo "== POST /mcp/repo from mcp-broker (expect 401)"
dc exec -T mcp-broker node -e 'fetch("http://noah-almighty:48787/mcp/repo",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(async r=>console.log("HTTP",r.status,(await r.text()).slice(0,200))).catch(e=>console.log("ERR",e.cause?.code??e.message))'
echo "== POST /mcp/repo from gateway (expect 403)"
dc exec -T gateway node -e 'fetch("http://noah-almighty:48787/mcp/repo",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(async r=>console.log("HTTP",r.status,(await r.text()).slice(0,200))).catch(e=>console.log("ERR",e.cause?.code??e.message))'
echo "== POST /mcp/repo from the published port (expect 403)"
curl -sS -X POST -H 'content-type: application/json' -d '{}' -w '\nHTTP %{http_code}\n' "$NOAH/mcp/repo" | cut -c1-300
echo "== Noah → GET http://gateway:8080/v1/models with the mounted key (expect 200)"
dc exec -T noah-almighty sh -c 'curl -sS -o /tmp/models.json -w "HTTP %{http_code}\n" -H "authorization: Bearer $(cat /run/secrets/pi_gateway_api_key)" http://gateway:8080/v1/models; head -c 600 /tmp/models.json; echo; ls -ln /run/secrets/'
echo "== same call without the key (control, expect 401)"
dc exec -T noah-almighty sh -c 'curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://gateway:8080/v1/models'
