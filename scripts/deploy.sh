#!/usr/bin/env bash
# Deploy (or upgrade) Noah + its pi-gateway on THIS host, in the order README.md "Upgrade" requires:
#
#   scripts/deploy.sh              pull main, prepare the host, build and start, check
#   scripts/deploy.sh --backup     … and first back up Noah's data volume, the memory service's and process mining's
#   scripts/deploy.sh --no-pull    deploy the checkout as it is (no git pull)
#
# Run it from a user in the docker group; the host preparation step asks for sudo (it writes root-only
# secret files). Every step stops the script on failure, before the next one runs.
#
# Steps
#   1 preflight   docker + compose ≥ 2.24, Noah's .env with SESSION_SECRET and PI_GATEWAY_HOME, a clean
#                 checkout on main (a local edit would be deployed silently otherwise)
#   2 pull        git pull --ff-only origin main, then the pi-gateway submodule at the commit main pins
#   3 backup      (--backup only) stops Noah, the memory service and pi's mining service, tars their three
#                 volumes into $BACKUP_DIR/<stamp>/ (default ./backups), and leaves them stopped — step 5
#                 starts them again
#   4 host        sudo docker/pi/setup-host.sh — on EVERY deploy: a release can add a secret file compose
#                 mounts (the memory service's key is one), and without it `up` never creates Noah
#   5 up          docker compose up -d --build
#   6 wait        every long-running service healthy (or running, when it has no health check), every
#                 one-shot service exited 0 — at most $DEPLOY_WAIT_SECONDS (default 600)
#   7 checks      Noah's copy of the memory key is mounted and not empty; pi's MCP page has NO entry pointing at the memory
#                 service (Noah's server must be its only caller); SANDBOX_EGRESS_ALLOW names neither Noah
#                 nor the memory service
#
# What it does NOT do by itself: back up the memory service's volume. Every personal brain lives there (notes
# and their history, nowhere else) — pass --backup, or keep that volume in your own backups.
# Values from .env and the secret files are never printed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
ENV_FILE="$REPO/.env"
NOAH_SERVICE=noah-almighty
MEMORY_SERVICE=memory
MINING_SERVICE=mining
WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-600}"

DO_PULL=1
DO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --backup) DO_BACKUP=1 ;;
    --no-pull) DO_PULL=0 ;;
    -h | --help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok     %s\n' "$*"; }
warn() { printf 'warn   %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# env_value FILE KEY: the last KEY=value line, surrounding quotes dropped (never `source`d: compose syntax, secrets).
env_value() {
  [ -f "$1" ] || return 0
  local value
  value="$(grep -E "^$2=" "$1" | tail -n 1)" || true
  value="${value#*=}"
  case "$value" in \"*\") value="${value:1:${#value}-2}" ;; \'*\') value="${value:1:${#value}-2}" ;; esac
  printf '%s' "$value"
}

# ---- 1 preflight --------------------------------------------------------------------------------
step "1/7 preflight"
command -v docker >/dev/null 2>&1 || fail "docker CLI not found"
docker info >/dev/null 2>&1 || fail "cannot talk to the Docker daemon (is this user in the docker group?)"
compose_version="$(docker compose version --short 2>/dev/null)" || fail "the docker compose plugin is missing"
compose_major="${compose_version%%.*}"
compose_rest="${compose_version#*.}"
compose_minor="${compose_rest%%.*}"
if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 24 ]; }; then
  fail "docker compose $compose_version is too old (need ≥ 2.24 for include with an override list)"
fi
ok "docker compose $compose_version"

[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — cp .env.example .env and fill it in (README.md \"First boot\")"
[ -n "$(env_value "$ENV_FILE" SESSION_SECRET)" ] || fail "SESSION_SECRET is not set in $ENV_FILE"
PI_GATEWAY_HOME="$(env_value "$ENV_FILE" PI_GATEWAY_HOME)"
[ -n "$PI_GATEWAY_HOME" ] || fail "PI_GATEWAY_HOME is not set in $ENV_FILE (pi's data root, e.g. /srv/pi-gateway)"
PI_GATEWAY_DIR="$(env_value "$ENV_FILE" PI_GATEWAY_DIR)"
PI_GATEWAY_DIR="${PI_GATEWAY_DIR:-./vendor/pi-gateway}"
case "$PI_GATEWAY_DIR" in /*) ;; *) PI_GATEWAY_DIR="$REPO/${PI_GATEWAY_DIR#./}" ;; esac
PI_GATEWAY_DIR="${PI_GATEWAY_DIR%/}"
ok ".env (SESSION_SECRET, PI_GATEWAY_HOME set)"

if [ "$DO_PULL" -eq 1 ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] || fail "the checkout is on '$branch', not main (switch, or deploy it as it is with --no-pull)"
  # A local edit would ride along unseen; the submodule is compared separately below.
  dirty="$(git status --porcelain --ignore-submodules=all)"
  [ -z "$dirty" ] || fail "the checkout has local changes — commit, stash or discard them first:
$dirty"
  ok "clean checkout on main"
fi

# ---- 2 pull -------------------------------------------------------------------------------------
step "2/7 code"
before="$(git rev-parse --short HEAD)"
if [ "$DO_PULL" -eq 1 ]; then
  git pull --ff-only origin main
else
  warn "--no-pull: deploying the checkout as it is"
fi
if [ "$PI_GATEWAY_DIR" = "$REPO/vendor/pi-gateway" ]; then
  git submodule update --init vendor/pi-gateway
  ok "pi-gateway at $(git -C vendor/pi-gateway rev-parse --short HEAD) (the commit main pins)"
else
  warn "PI_GATEWAY_DIR=$PI_GATEWAY_DIR: that checkout is yours to keep at the pinned commit ($(git ls-tree HEAD vendor/pi-gateway | awk '{print substr($3,1,7)}'))"
fi
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then ok "Noah at $after (unchanged)"; else ok "Noah $before → $after"; fi

# ---- 3 backup -----------------------------------------------------------------------------------
PROJECT="$(docker compose config 2>/dev/null | sed -n '1s/^name: *//p')" || true
[ -n "$PROJECT" ] || fail "docker compose config did not resolve the project (check $ENV_FILE and the submodule)"

# volume_of SERVICE-VOLUME-KEY: this project's volume for a compose volume key ('' when it does not exist yet).
volume_of() {
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.volume=$1" 2>/dev/null | head -n 1
}

step "3/7 backup"
if [ "$DO_BACKUP" -eq 1 ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="${BACKUP_DIR:-$REPO/backups}/$stamp"
  # The image that runs tar: Noah's own (present on any host that ran this stack before; it has tar).
  tar_image="$(docker compose images -q "$NOAH_SERVICE" 2>/dev/null | head -n 1)" || true
  volumes=()
  for key in noah-almighty-data memory-data mining-data; do
    v="$(volume_of "$key")"
    if [ -n "$v" ]; then volumes+=("$key=$v"); else warn "no $key volume yet (first boot?): nothing to back up"; fi
  done
  if [ "${#volumes[@]}" -gt 0 ]; then
    [ -n "$tar_image" ] || fail "no Noah image to run the backup with — deploy once without --backup"
    mkdir -p "$dest"
    # Stopped first, so SQLite and the memory service's files are copied at rest; step 5 starts them again.
    # mining-data is pi's process mining (the run history, the tasks and the processes, one SQLite file): its
    # writer is the mining service — a run in progress ends 실패 and the next run goes on from where it stopped.
    # The gateway opens that file too, but writes it only for an admin's press on the panel, which is behind
    # Noah, so the gateway keeps running. (A pi checkout from before its mining service has no such service.)
    stop_services=("$NOAH_SERVICE" "$MEMORY_SERVICE")
    if docker compose config --services 2>/dev/null | grep -qx "$MINING_SERVICE"; then stop_services+=("$MINING_SERVICE"); fi
    docker compose stop "${stop_services[@]}"
    for pair in "${volumes[@]}"; do
      key="${pair%%=*}"
      v="${pair#*=}"
      # Read as root (the volumes belong to the services' uids); the archive is handed to the user who ran this.
      docker run --rm --network none --user 0 -v "$v:/v:ro" -v "$dest:/b" --entrypoint sh "$tar_image" \
        -c 'tar -C /v -czf "/b/$1.tar.gz" . && chown "$2" "/b/$1.tar.gz"' sh "$key" "$(id -u):$(id -g)"
      ok "$v → $dest/$key.tar.gz ($(du -h "$dest/$key.tar.gz" | cut -f1))"
    done
    echo "       restore: docker compose stop <service>, then untar into the volume (README.md \"Upgrade\")"
  fi
else
  ok "skipped (pass --backup to back up Noah's data, the memory service and process mining first)"
fi

# ---- 4 host -------------------------------------------------------------------------------------
step "4/7 host preparation (sudo docker/pi/setup-host.sh)"
if [ "$(id -u)" -eq 0 ]; then
  docker/pi/setup-host.sh
else
  sudo docker/pi/setup-host.sh
fi

# ---- 5 up ---------------------------------------------------------------------------------------
step "5/7 docker compose up -d --build"
docker compose up -d --build

# ---- 6 wait -------------------------------------------------------------------------------------
step "6/7 waiting for the stack (at most ${WAIT_SECONDS}s)"
# A one-shot service is one compose shows as exited; every other one must be running, and healthy when it has a check.
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  pending=""
  broken=""
  while IFS='|' read -r service state health code; do
    [ -n "$service" ] || continue
    case "$state" in
      exited) [ "$code" = 0 ] || broken="$broken $service(exit $code)" ;;
      running) [ -z "$health" ] || [ "$health" = healthy ] || pending="$pending $service($health)" ;;
      *) pending="$pending $service($state)" ;;
    esac
  done < <(docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}')
  [ -z "$broken" ] || { docker compose ps -a; fail "a one-shot service failed:$broken — docker compose logs <service>"; }
  [ -n "$pending" ] || break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    docker compose ps -a
    fail "still not ready after ${WAIT_SECONDS}s:$pending — docker compose logs <service>"
  fi
  sleep 5
done
docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' | awk -F'|' '{ printf "       %-18s %-8s %s\n", $1, $2, $3 }'
ok "every service is up (one-shot services exited 0)"
echo "       pi-setup said:"
docker compose logs --no-log-prefix pi-setup 2>/dev/null | tail -n 5 | sed 's/^/         /'

# ---- 7 checks -----------------------------------------------------------------------------------
step "7/7 checks"
problems=0

# Noah's copy of the memory key, as the running container sees it (compose mounts it; an EMPTY file would
# start the stack and leave every moved brain unreadable).
if docker compose exec -T "$NOAH_SERVICE" sh -c 'test -s "$PI_MEMORY_API_KEY_FILE"' 2>/dev/null; then
  ok "Noah's copy of the memory service key is mounted and not empty"
else
  warn "Noah's copy of the memory service key is missing or empty in the container — re-run sudo docker/pi/setup-host.sh"
  problems=$((problems + 1))
fi

# pi's MCP page, read from inside Noah's container with the admin key compose mounted there (never printed).
mcp_check="$(docker compose exec -T "$NOAH_SERVICE" node -e '
  const fs = require("node:fs");
  const key = fs.readFileSync(process.env.PI_GATEWAY_ADMIN_API_KEY_FILE, "utf8").trim();
  fetch(`${process.env.PI_GATEWAY_URL}/admin/api/mcp/servers`, { headers: { authorization: `Bearer ${key}` } })
    .then(async (res) => {
      if (!res.ok) { console.log(`unreadable ${res.status}`); return; }
      const servers = ((await res.json()).servers ?? []).map((s) => s.config ?? {});
      const memory = servers.filter((c) => c.id === "memory" || /\/\/memory(:|\/|$)/.test(c.transport?.url ?? ""));
      console.log(memory.length ? `registered ${memory.map((c) => c.id).join(",")}` : `clean ${servers.length}`);
    })
    .catch((error) => console.log(`unreadable ${error.message}`));
' 2>&1)" || mcp_check="unreadable $mcp_check"
case "$mcp_check" in
  clean*) ok "pi's MCP page: ${mcp_check#clean } servers, none of them the memory service" ;;
  registered*)
    warn "pi's MCP page registers the memory service (${mcp_check#registered }) — every pi session then has UNGATED"
    warn "  memory tools. Delete that entry on pi's admin page (/admin → MCP); Noah's server must be its only caller."
    problems=$((problems + 1)) ;;
  *) warn "could not read pi's MCP page (${mcp_check}) — check it by hand: /admin → MCP, no memory entry"; problems=$((problems + 1)) ;;
esac

# The sandbox egress allow-list: neither Noah (the broker calls Noah, never a sandbox) nor the memory service.
allow="$(env_value "$ENV_FILE" SANDBOX_EGRESS_ALLOW)"
[ -n "$allow" ] || allow="$(env_value "$PI_GATEWAY_DIR/.env" SANDBOX_EGRESS_ALLOW)"
if printf '%s' "$allow" | grep -qiE '(^|[,[:space:]])(memory|noah-almighty|gateway)(:|[,[:space:]]|$)'; then
  warn "SANDBOX_EGRESS_ALLOW names a service of this stack — sandboxes could then reach it; remove it"
  problems=$((problems + 1))
else
  ok "SANDBOX_EGRESS_ALLOW names no service of this stack"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "deployed: Noah $(git rev-parse --short HEAD), pi-gateway $(git -C "$PI_GATEWAY_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
else
  echo "deployed with $problems warning(s) above — fix them: personal brains live in the memory service"
fi
cat <<'NEXT'

remember: every personal brain (notes and their history) lives ONLY in the memory service's volume (memory-data).
Nothing copies it anywhere — run this script with --backup, or keep that volume in your own backups.
How full each brain is: 관리자 → 시스템 → 개인 브레인 사용량.
NEXT
[ "$problems" -eq 0 ]
