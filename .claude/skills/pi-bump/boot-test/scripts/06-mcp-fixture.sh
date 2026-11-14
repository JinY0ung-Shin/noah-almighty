#!/usr/bin/env bash
# The file-returning MCP fixture as a SIBLING container on noahcompose-net (fixed ip), registered in pi's broker
# as `filefix` through the gateway's edge address with pi's admin key (read inside the dind, never printed).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
FIX_IP=10.217.0.11
docker rm -f noahcompose-mcp-fixture >/dev/null 2>&1 || true
docker run -d --name noahcompose-mcp-fixture --network noahcompose-net --ip "$FIX_IP" \
  -v "$W/scripts/mcp-fixture.mjs:/mcp-fixture.mjs:ro" node:22-bookworm-slim node /mcp-fixture.mjs
sleep 2
curl -fsS "http://$FIX_IP:18092/_calls"; echo
GW_IP=$(dind docker inspect -f '{{(index .NetworkSettings.Networks "noah-almighty_edge").IPAddress}}' noah-almighty-gateway-1)
BODY='{"config":{"runIn":"broker","displayName":"File fixture","description":"Test files as binary resources.","transport":{"type":"http","url":"http://'"$FIX_IP"':18092/mcp"},"timeoutSec":120}}'
dind sh -c 'K=$(cat '"$W"'/secrets/gateway/admin_api_key); curl -sS -o /tmp/fx.out -w "PUT /admin/api/mcp/servers/filefix -> %{http_code}\n" -X PUT -H "authorization: Bearer $K" -H "content-type: application/json" --data "$1" http://'"$GW_IP"':8080/admin/api/mcp/servers/filefix; head -c 600 /tmp/fx.out; echo; curl -sS -o /tmp/fx.out -w "POST …/filefix/test -> %{http_code}\n" -X POST -H "authorization: Bearer $K" -H "content-type: application/json" --data "{}" http://'"$GW_IP"':8080/admin/api/mcp/servers/filefix/test; head -c 600 /tmp/fx.out; echo' _ "$BODY"
