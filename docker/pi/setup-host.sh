#!/usr/bin/env bash
# Noah's half of the host preparation for the bundled pi-gateway. Run it AFTER pi-gateway's own
# scripts/setup-host.sh (which creates the data root, the workspaces dir and pi's secret files), and again
# whenever pi's service key changes:
#
#   sudo PI_GATEWAY_HOME=/srv/pi-gateway docker/pi/setup-host.sh
#
# What it does
#   checks  $PI_GATEWAY_HOME/workspaces   uid 1000, the uid Noah's container runs as (it bind-mounts it)
#   copies  $PI_GATEWAY_SECRETS/gateway/api_key → $PI_GATEWAY_SECRETS/noah/pi_gateway_api_key
#           uid 1000, 0400 — pi-gateway keeps one copy of a secret per service, owned by that service's uid,
#           and Noah is one more service. Re-running replaces a stale copy (the gateway's file is the source).
#   checks  $PI_GATEWAY_SECRETS/gateway/admin_api_key is set (the one-shot `pi-setup` service reads it)
#   adds    PI_GATEWAY_HOME, PI_GATEWAY_SECRETS to Noah's .env (only when missing)
# Values are never printed.
set -euo pipefail

: "${PI_GATEWAY_HOME:?set PI_GATEWAY_HOME to the absolute path used by the setup-host.sh of pi-gateway}"
case "$PI_GATEWAY_HOME" in /*) ;; *) echo "PI_GATEWAY_HOME must be absolute" >&2; exit 1 ;; esac
SECRETS="${PI_GATEWAY_SECRETS:-$PI_GATEWAY_HOME/secrets}"
case "$SECRETS" in /*) ;; *) echo "PI_GATEWAY_SECRETS must be absolute" >&2; exit 1 ;; esac
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/.env"
NOAH_UID=1000

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (the secret copy must be owned by uid $NOAH_UID inside a root-only directory)" >&2
  exit 1
fi

fail() { echo "error: $*" >&2; exit 1; }

WS="$PI_GATEWAY_HOME/workspaces"
[ -d "$WS" ] || fail "$WS does not exist — run pi-gateway's scripts/setup-host.sh first"
[ "$(stat -c %u "$WS")" = "$NOAH_UID" ] || fail "$WS is not owned by uid $NOAH_UID (pi's sandbox uid = Noah's uid)"
echo "ok     $WS (uid $NOAH_UID)"

API_KEY="$SECRETS/gateway/api_key"
[ -s "$API_KEY" ] || fail "$API_KEY is missing or empty — run pi-gateway's scripts/setup-host.sh first"
[ -s "$SECRETS/gateway/admin_api_key" ] \
  || fail "$SECRETS/gateway/admin_api_key is empty — Noah's pi-setup service needs pi's admin API to register its MCP servers"

install -d -o 0 -g 0 -m 0700 "$SECRETS/noah"
DEST="$SECRETS/noah/pi_gateway_api_key"
if [ -f "$DEST" ] && cmp -s "$API_KEY" "$DEST"; then
  chown "$NOAH_UID:$NOAH_UID" "$DEST"; chmod 0400 "$DEST"
  echo "keep   $DEST"
else
  [ -f "$DEST" ] && action=update || action=create
  tmp="$(mktemp "$SECRETS/noah/.tmp.XXXXXX")"
  cat "$API_KEY" > "$tmp"
  install -o "$NOAH_UID" -g "$NOAH_UID" -m 0400 "$tmp" "$DEST"
  rm -f "$tmp"
  echo "$action $DEST"
fi

touch "$ENV_FILE"
add_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    echo "keep   $key in $ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "add    $key=$value to $ENV_FILE"
  fi
}
add_env PI_GATEWAY_HOME "$PI_GATEWAY_HOME"
add_env PI_GATEWAY_SECRETS "$SECRETS"

echo
echo "next: docker compose up -d --build   (README.md \"Deployment\")"
