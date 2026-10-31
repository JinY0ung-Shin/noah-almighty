#!/bin/sh
# One-shot `pi-setup` compose service (docker-compose.yml): registers Noah's MCP servers with the
# bundled pi-gateway's broker and applies Noah's instance settings (system prompt `noah`, pi's
# request_admin / present_file built-ins off) through scripts/pi-register-mcp.mjs, which is idempotent —
# every `docker compose up` re-runs this and changes nothing that is already right.
#
# Runs as pi-gateway's uid 10001, the owner of $PI_GATEWAY_SECRETS/gateway/admin_api_key (0400), which
# compose mounts at /run/secrets/pi_gateway_admin_api_key. The key reaches the script through its
# environment only (never argv), and nothing here prints it.
set -eu

key_file=/run/secrets/pi_gateway_admin_api_key
if [ ! -r "$key_file" ]; then
  echo "pi-setup: cannot read $key_file (pi-gateway's admin_api_key; run sudo docker/pi/setup-host.sh on the host)" >&2
  exit 1
fi
PI_GATEWAY_ADMIN_KEY="$(cat "$key_file")"
if [ -z "$PI_GATEWAY_ADMIN_KEY" ]; then
  echo "pi-setup: pi-gateway's admin_api_key is empty, so its admin API is off and Noah cannot register its MCP servers" >&2
  exit 1
fi
export PI_GATEWAY_ADMIN_KEY

: "${PI_GATEWAY_URL:?PI_GATEWAY_URL is required}"
: "${NOAH_MCP_PUBLIC_URL:?NOAH_MCP_PUBLIC_URL is required}"
exec node scripts/pi-register-mcp.mjs --gateway "$PI_GATEWAY_URL" --noah-url "$NOAH_MCP_PUBLIC_URL" --configure-instance
