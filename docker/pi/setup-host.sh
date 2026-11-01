#!/usr/bin/env bash
# Host preparation for the bundled pi-gateway, in ONE command. Run it before the first `docker compose up`,
# and again whenever pi's service key changes:
#
#   sudo docker/pi/setup-host.sh
#
# PI_GATEWAY_HOME (required), PI_GATEWAY_SECRETS and PI_GATEWAY_DIR come from Noah's .env — the same values
# compose reads — unless set in the environment (`sudo PI_GATEWAY_HOME=… docker/pi/setup-host.sh`).
#
# What it does
#   runs    pi-gateway's own scripts/setup-host.sh from PI_GATEWAY_DIR (default: the vendor/pi-gateway
#           submodule) with the same PI_GATEWAY_HOME/PI_GATEWAY_SECRETS: data root, workspaces, plugins,
#           pi's secret files and pi's .env (it keeps whatever already exists)
#   checks  $PI_GATEWAY_HOME/workspaces   uid 1000, the uid Noah's container runs as (it bind-mounts it)
#   copies  $PI_GATEWAY_SECRETS/gateway/api_key → $PI_GATEWAY_SECRETS/noah/pi_gateway_api_key
#           uid 1000, 0400 — pi-gateway keeps one copy of a secret per service, owned by that service's uid,
#           and Noah is one more service. Re-running replaces a stale copy (the gateway's file is the source).
#   checks  $PI_GATEWAY_SECRETS/gateway/admin_api_key is set (the one-shot `pi-setup` service reads it)
#   adds    PI_GATEWAY_HOME, PI_GATEWAY_SECRETS to Noah's .env (only when missing)
# Values are never printed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO/.env"
NOAH_UID=1000

# env_value KEY: the last KEY=value line of Noah's .env, surrounding quotes dropped. Never `source`d: the file
# holds secrets and is compose syntax, not shell.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  local value
  value="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1)" || true
  value="${value#*=}"
  case "$value" in \"*\") value="${value:1:${#value}-2}" ;; \'*\') value="${value:1:${#value}-2}" ;; esac
  printf '%s' "$value"
}

PI_GATEWAY_HOME="${PI_GATEWAY_HOME:-$(env_value PI_GATEWAY_HOME)}"
PI_GATEWAY_SECRETS="${PI_GATEWAY_SECRETS:-$(env_value PI_GATEWAY_SECRETS)}"
PI_GATEWAY_DIR="${PI_GATEWAY_DIR:-$(env_value PI_GATEWAY_DIR)}"
PI_GATEWAY_DIR="${PI_GATEWAY_DIR:-./vendor/pi-gateway}"
case "$PI_GATEWAY_DIR" in /*) ;; *) PI_GATEWAY_DIR="$REPO/$PI_GATEWAY_DIR" ;; esac

: "${PI_GATEWAY_HOME:?set PI_GATEWAY_HOME in $ENV_FILE (the pi-gateway data root, e.g. /srv/pi-gateway)}"
case "$PI_GATEWAY_HOME" in /*) ;; *) echo "PI_GATEWAY_HOME must be absolute" >&2; exit 1 ;; esac
SECRETS="${PI_GATEWAY_SECRETS:-$PI_GATEWAY_HOME/secrets}"
case "$SECRETS" in /*) ;; *) echo "PI_GATEWAY_SECRETS must be absolute" >&2; exit 1 ;; esac

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (the secret copy must be owned by uid $NOAH_UID inside a root-only directory)" >&2
  exit 1
fi

fail() { echo "error: $*" >&2; exit 1; }

PI_SETUP="$PI_GATEWAY_DIR/scripts/setup-host.sh"
[ -f "$PI_SETUP" ] || fail "$PI_SETUP not found — run git submodule update --init (or fix PI_GATEWAY_DIR)"
echo "== pi-gateway ($PI_SETUP)"
PI_GATEWAY_HOME="$PI_GATEWAY_HOME" PI_GATEWAY_SECRETS="$SECRETS" bash "$PI_SETUP"
echo
echo "== noah"

WS="$PI_GATEWAY_HOME/workspaces"
[ -d "$WS" ] || fail "$WS does not exist after pi-gateway's setup-host.sh"
[ "$(stat -c %u "$WS")" = "$NOAH_UID" ] || fail "$WS is not owned by uid $NOAH_UID (pi's sandbox uid = Noah's uid)"
echo "ok     $WS (uid $NOAH_UID)"

API_KEY="$SECRETS/gateway/api_key"
[ -s "$API_KEY" ] || fail "$API_KEY is missing or empty after pi-gateway's setup-host.sh"
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
