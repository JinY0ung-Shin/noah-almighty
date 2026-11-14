#!/usr/bin/env bash
# Scripted fake LLM as a SIBLING container on noahcompose-net (fixed ip), then pi's LLM settings via the
# gateway's edge address with pi's admin key (read inside the dind, never printed).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
docker rm -f noahcompose-fake-llm >/dev/null 2>&1 || true
docker run -d --name noahcompose-fake-llm --network noahcompose-net --ip "$FAKE_IP" \
  -v "$W/scripts/fake-llm.mjs:/fake-llm.mjs:ro" node:22-bookworm-slim node /fake-llm.mjs --host 0.0.0.0 --port 18091
sleep 2
curl -fsS "$FAKE/_fake/state"; echo
GW_IP=$(dind docker inspect -f '{{(index .NetworkSettings.Networks "noah-almighty_edge").IPAddress}}' noah-almighty-gateway-1)
echo "gateway edge ip: $GW_IP"
BODY='{"defaultModel":"fake-model","tiers":{"falcon":"fake-model"},"servers":[{"id":"fake","api":"openai-completions","baseUrl":"http://'"$FAKE_IP"':18091/v1","apiKey":"","models":[{"id":"fake-model","contextWindow":131072,"maxTokens":4096,"input":["text","image"]}]}]}'
dind sh -c 'curl -sS -o /tmp/llm.out -w "PUT /admin/api/llm -> %{http_code}\n" -X PUT -H "authorization: Bearer $(cat '"$W"'/secrets/gateway/admin_api_key)" -H "content-type: application/json" --data "$1" http://'"$GW_IP"':8080/admin/api/llm; cat /tmp/llm.out; echo' _ "$BODY"
