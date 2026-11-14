#!/usr/bin/env bash
# prepare.sh <run-dir>
#
# Makes ONE self-contained run directory for the combined-stack boot test, OUTSIDE the repository:
#
#   <run-dir>/scripts/        a copy of ./scripts — every step runs from this copy and finds the run directory
#                             from its own location, so nothing here holds a path
#   <run-dir>/fixtures/       a copy of ./fixtures
#   <run-dir>/noah-almighty/  the tree under test: `git archive` of this checkout's HEAD, with vendor/pi-gateway
#                             exported at the commit the submodule is CHECKED OUT at (not the one HEAD pins), and
#                             a throwaway .env
#   <run-dir>/run.env         where this checkout is (for Playwright out of its node_modules), the two commits,
#                             the password of the accounts the run creates
#   <run-dir>/tested-state.txt  what was exported, for the bump note
#   <run-dir>/logs/, evidence/  filled by the run
#
# It builds and starts nothing. Next: <run-dir>/scripts/drive.sh (see ../SKILL.md).
set -euo pipefail

die() { echo "prepare.sh: $*" >&2; exit 1; }
[ $# -eq 1 ] || die "usage: prepare.sh <run-dir>   (a directory that does not exist yet, outside the repository)"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(git -C "$HERE" rev-parse --show-toplevel) || die "not inside a git checkout"
PI_DIR=$REPO_ROOT/vendor/pi-gateway

for tool in git docker node tar openssl curl; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
docker info >/dev/null 2>&1 || die "the docker daemon does not answer"

# ---- the run directory: new, absolute, outside the repository, no whitespace (it is a docker -v source and a
#      sourced env value)
case "$1" in *[[:space:]]*) die "the run directory may not contain whitespace: $1" ;; esac
[ ! -e "$1" ] || die "$1 already exists — a run directory is made once; pick a new name"
W=$(realpath -m "$1")
case "$W" in *[[:space:]]*) die "the run directory may not contain whitespace: $W" ;; esac
case "$REPO_ROOT" in *[[:space:]]*) die "the repository path may not contain whitespace: $REPO_ROOT" ;; esac
case "$W/" in "$REPO_ROOT"/*) die "the run directory must be OUTSIDE the repository ($REPO_ROOT)" ;; esac
mkdir -p "$(dirname "$W")"

# ---- one run at a time: the docker names are fixed
left=$({ docker ps -a --format '{{.Names}}'; docker volume ls -q; docker network ls --format '{{.Name}}'; } | grep '^noahcompose-' | sort -u || true)
[ -z "$left" ] || die "an earlier run is still there — tear it down first with ITS scripts/99-teardown.sh: $(echo $left)"

# ---- what will be tested
NOAH_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
[ -e "$PI_DIR/.git" ] || die "vendor/pi-gateway is not checked out (git submodule update --init)"
PI_COMMIT=$(git -C "$PI_DIR" rev-parse HEAD)
PI_PINNED=$(git -C "$REPO_ROOT" rev-parse HEAD:vendor/pi-gateway)
NOT_EXPORTED=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- . ':!vendor/pi-gateway' || true)
PI_DIRTY=$(git -C "$PI_DIR" status --porcelain --untracked-files=no || true)
PI_REMOTE=$(git -C "$PI_DIR" branch -r --contains "$PI_COMMIT" 2>/dev/null | grep -v -- '->' | head -n 1 | tr -d ' ' || true)

# ---- the directory
mkdir "$W"
mkdir "$W/scripts" "$W/fixtures" "$W/logs" "$W/evidence" "$W/noah-almighty"
cp -a "$HERE/scripts/." "$W/scripts/"
cp -a "$HERE/fixtures/." "$W/fixtures/"
git -C "$REPO_ROOT" archive "$NOAH_COMMIT" | tar -x -C "$W/noah-almighty"
mkdir -p "$W/noah-almighty/vendor/pi-gateway"
git -C "$PI_DIR" archive "$PI_COMMIT" | tar -x -C "$W/noah-almighty/vendor/pi-gateway"
[ -f "$W/noah-almighty/docker-compose.yml" ] && [ -f "$W/noah-almighty/vendor/pi-gateway/docker-compose.yml" ] || die "the export is incomplete (no docker-compose.yml in the tree or in vendor/pi-gateway)"

# ---- the stack's .env (DOCKER_GID is added by 00-dind-up.sh: it is the DIND socket's gid) and the run's own env
(
  umask 077
  {
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "PI_GATEWAY_HOME=$W/home"
    echo "PI_GATEWAY_SECRETS=$W/secrets"
  } > "$W/noah-almighty/.env"
  {
    echo "REPO_ROOT=$REPO_ROOT"
    echo "NOAH_COMMIT=$NOAH_COMMIT"
    echo "PI_COMMIT=$PI_COMMIT"
    echo "E2E_PASSWORD=e2e-$(openssl rand -hex 12)"
  } > "$W/run.env"
)

{
  echo "prepared:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Noah:         $NOAH_COMMIT (tree $(git -C "$REPO_ROOT" rev-parse "$NOAH_COMMIT^{tree}"))  $(git -C "$REPO_ROOT" log -1 --format=%s "$NOAH_COMMIT" | cut -c1-100)"
  echo "pi-gateway:   $PI_COMMIT (tree $(git -C "$PI_DIR" rev-parse "$PI_COMMIT^{tree}"))  $(git -C "$PI_DIR" log -1 --format=%s "$PI_COMMIT" | cut -c1-100)"
  if [ "$PI_COMMIT" = "$PI_PINNED" ]; then echo "              = the commit Noah's HEAD pins"; else echo "              Noah's HEAD pins $PI_PINNED — the submodule checkout was exported (a bump under test)"; fi
  if [ -n "$PI_REMOTE" ]; then echo "              on $PI_REMOTE"; else echo "              NOT on any remote branch of the submodule — a bump must move to a PUSHED commit"; fi
  if [ -n "$PI_DIRTY" ]; then echo "pi changes NOT exported (uncommitted in the submodule):"; echo "$PI_DIRTY" | sed 's/^/  /'; fi
  if [ -n "$NOT_EXPORTED" ]; then echo "Noah changes NOT exported (tracked files that differ from HEAD in the working tree):"; echo "$NOT_EXPORTED" | sed 's/^/  /'; else echo "working tree: no tracked change besides the submodule pointer (the export IS the tree)"; fi
} > "$W/tested-state.txt"
cp "$W/tested-state.txt" "$W/evidence/tested-state.txt"

cat "$W/tested-state.txt"
echo
node -e 'require(process.argv[1] + "/node_modules/playwright")' "$REPO_ROOT" 2>/dev/null ||
  echo "warning: Playwright is not installed in $REPO_ROOT/node_modules (npm ci) — the three browser checks (25-, 88-, 93-) will fail"
echo "run directory ready: $W"
echo "next:  $W/scripts/drive.sh build    then    $W/scripts/drive.sh checks    (or drive.sh for both)"
echo "after: $W/scripts/99-teardown.sh"
