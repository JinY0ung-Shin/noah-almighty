# source this: helpers for the boot test (everything runs inside the private dind).
# The run directory is where THIS COPY of the scripts lives — <run-dir>/scripts/, made by ../prepare.sh.
# Nothing here runs from the skill folder itself: there is no run.env there.
W=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[ -f "$W/run.env" ] || { echo "no $W/run.env — run the copy that prepare.sh put in a run directory, not the skill folder's" >&2; exit 2; }
. "$W/run.env"   # REPO_ROOT, NOAH_COMMIT, PI_COMMIT, E2E_PASSWORD
DIND=noahcompose-dind
DIND_IP=10.217.0.2
FAKE_IP=10.217.0.10
NOAH=http://$DIND_IP:48787
FAKE=http://$FAKE_IP:18091
dind() { docker exec "$DIND" "$@"; }
dc() { docker exec -i -w "$W/noah-almighty" "$DIND" docker compose "$@"; }
