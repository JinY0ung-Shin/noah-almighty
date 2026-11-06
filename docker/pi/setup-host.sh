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
#   copies  it → $PI_GATEWAY_SECRETS/noah/pi_gateway_admin_api_key, uid 1000, 0400, the same way: Noah serves
#           pi's admin panel at /admin to Noah admins and injects this key (re-run after rotating pi's admin key)
#   adds    PI_GATEWAY_HOME, PI_GATEWAY_SECRETS to Noah's .env (only when missing)
#   checks  an EXISTING noah-almighty-data volume's root is uid 1000 (#79) — detection only: it fails with
#           the repair to run (README.md "Upgrade" → "Data volume ownership"), it never changes the volume
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
# copy_for_noah SRC: SRC → $DEST, uid 1000, 0400 (a stale copy is replaced; values are never printed).
copy_for_noah() {
  local src="$1" action
  if [ -f "$DEST" ] && cmp -s "$src" "$DEST"; then
    chown "$NOAH_UID:$NOAH_UID" "$DEST"; chmod 0400 "$DEST"
    echo "keep   $DEST"
  else
    [ -f "$DEST" ] && action=update || action=create
    tmp="$(mktemp "$SECRETS/noah/.tmp.XXXXXX")"
    cat "$src" > "$tmp"
    install -o "$NOAH_UID" -g "$NOAH_UID" -m 0400 "$tmp" "$DEST"
    rm -f "$tmp"
    echo "$action $DEST"
  fi
}
DEST="$SECRETS/noah/pi_gateway_api_key"
copy_for_noah "$API_KEY"
DEST="$SECRETS/noah/pi_gateway_admin_api_key"
copy_for_noah "$SECRETS/gateway/admin_api_key"

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

# Noah's data volume ROOT must belong to uid 1000 (#79). Docker copies the image's /app/data owner into a named
# volume only when it CREATES the volume, so one made by an image older than the non-root node user keeps a
# root-owned root: Noah could then create no new folder in it (backups/, team-brain/, pi-repo-copies/). Noah's
# own boot refuses that state too; this catches it before `up`. Detection only — the repair (a backup first)
# is the operator's. Anything that cannot be determined here (no docker CLI, a remote daemon, no volume yet)
# is reported and skipped.
check_data_volume() {
  local project volume mountpoint owner mode
  if ! command -v docker >/dev/null 2>&1; then
    echo "skip   data volume check (no docker CLI on this host)"
    return 0
  fi
  # `config` prints the project name first; nothing else of its output (which holds .env values) is kept.
  project="$(cd "$REPO" && docker compose config 2>/dev/null | sed -n '1s/^name: *//p')" || true
  if [ -z "$project" ]; then
    echo "skip   data volume check (docker compose config did not resolve the project name)"
    return 0
  fi
  volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
    --filter label=com.docker.compose.volume=noah-almighty-data 2>/dev/null | head -n 1)" || true
  if [ -z "$volume" ]; then
    echo "ok     no noah-almighty-data volume yet (project $project): compose creates it uid $NOAH_UID"
    return 0
  fi
  mountpoint="$(docker volume inspect -f '{{ .Mountpoint }}' "$volume" 2>/dev/null)" || true
  if [ -z "$mountpoint" ] || [ ! -d "$mountpoint" ]; then
    echo "skip   data volume check ($volume is not on this host's filesystem; Noah's boot still checks it)"
    return 0
  fi
  owner="$(stat -c %u "$mountpoint")"
  mode="$(stat -c %a "$mountpoint")"
  if [ "$owner" = "$NOAH_UID" ] && [ $(( 8#$mode & 8#200 )) -ne 0 ]; then
    echo "ok     $volume root (uid $NOAH_UID, mode $mode)"
    return 0
  fi
  echo "error: volume $volume root is uid $owner mode $mode — Noah (uid $NOAH_UID) cannot create folders in it" >&2
  echo "       (backups/, team-brain/, pi-repo-copies/). Back the volume up, then repair its root ONLY:" >&2
  echo "       README.md \"Upgrade\" → \"Data volume ownership\". Then re-run this script." >&2
  exit 1
}

echo
echo "== noah data volume"
check_data_volume

echo
echo "next: docker compose up -d --build   (README.md \"Deployment\")"
