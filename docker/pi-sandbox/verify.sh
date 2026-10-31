#!/usr/bin/env bash
# Verify a built noahpi sandbox image under the constraints pi-gateway's sandboxd applies
# (~/pi-gateway/apps/sandboxd/src/spec.ts): read-only rootfs, cap-drop ALL, no-new-privileges, network
# none, /tmp = rw,exec,nosuid,nodev tmpfs of 256 MiB, memory = memory+swap = 1 GiB, 1 CPU, 256 pids,
# 64 MiB shm, private IPC, --init, uid 1000:1000, the workspace bind-mounted at /workspace and
# HOME=/workspace/.home. Dev/CI only — never part of the image.
#
# Every scenario runs in a FRESH container so the cgroup's memory.peak / pids.peak belong to that
# scenario alone; /tmp usage is sampled every 250 ms. The skill tree is copied the way Noah will place it
# at runtime: <workspace>/.noah/skills/pptx (read-write), plus one run from a read-only /opt/plugins
# mount (the plugin-marketplace layout of design N5). The container's main process is `sleep infinity`
# instead of sbx-proxy-bridge (no egress proxy socket here; the sandbox has no network either way).
#
# Usage: docker/pi-sandbox/verify.sh [--image IMG] [--keep DIR] [--runsc] [--quick] [--only RE]
#   --image IMG  image under test (default noahpi/sandbox:e2e)
#   --keep DIR   keep the workspace (decks, reports, logs) in DIR instead of a removed temp dir
#   --runsc      also run one build under the gVisor runtime (SANDBOX_RUNTIME=runsc)
#   --quick      probe + selftest + one example only
#   --only RE    run only the scenarios whose name matches the bash regex RE
# Exit 0 when every scenario exited 0 and none was OOM-killed.
set -uo pipefail

IMAGE=noahpi/sandbox:e2e
KEEP=""
ONLY=""
RUNSC=0
QUICK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --runsc) RUNSC=1; shift ;;
    --quick) QUICK=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "verify: unknown argument $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL_SRC="$ROOT/default-skills/skills/pptx"
[ -f "$SKILL_SRC/scripts/deck.sh" ] || { echo "verify: no pptx skill at $SKILL_SRC" >&2; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "verify: image $IMAGE not found" >&2; exit 2; }

if [ -n "$KEEP" ]; then WS="$KEEP"; mkdir -p "$WS"; else WS="$(mktemp -d)"; trap 'rm -rf "$WS"' EXIT; fi
WS="$(cd "$WS" && pwd)"
rm -rf "$WS/.noah" "$WS/decks" "$WS/results"
mkdir -p "$WS/.home" "$WS/.noah/skills" "$WS/decks" "$WS/results"
cp -r "$SKILL_SRC" "$WS/.noah/skills/pptx"
find "$WS/.noah" -name __pycache__ -prune -exec rm -rf {} +
for d in "$SKILL_SRC"/examples/*/; do cp -r "$d" "$WS/decks/$(basename "$d")"; done
# A 60-slide deck (NOAH_PPTX_MAX_SLIDES) from the layouts example's slides, for the worst case.
mkdir -p "$WS/decks/max60/slides"
cp "$SKILL_SRC/examples/layouts/deck.css" "$WS/decks/max60/deck.css"
[ -d "$SKILL_SRC/examples/layouts/assets" ] && cp -r "$SKILL_SRC/examples/layouts/assets" "$WS/decks/max60/assets"
mapfile -t LAYOUT_SLIDES < <(ls "$SKILL_SRC/examples/layouts/slides/"*.html | sort)
for i in $(seq 1 60); do
  src="${LAYOUT_SLIDES[$(( (i - 1) % ${#LAYOUT_SLIDES[@]} ))]}"
  # The slide-number field must show the slide's real number (the converter's `field` lint).
  sed -E "s|(data-field=\"slidenum\">)[0-9]+<|\\1$i<|" "$src" \
    >"$WS/decks/max60/slides/$(printf '%02d' "$i")-$(basename "$src" | sed 's/^[0-9]*-//')"
done

SKILL=/workspace/.noah/skills/pptx
DECK="bash $SKILL/scripts/deck.sh"
NS="verify-$$-$RANDOM"
SANDBOX_FLAGS=(
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --network none
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,mode=1777
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --shm-size 64m --ipc private
  --init --user 1000:1000 --workdir /workspace --hostname sandbox --log-driver none
  --oom-score-adj 500 -e HOME=/workspace/.home
  --mount "type=bind,source=$WS,target=/workspace,bind-propagation=rprivate"
)

FAILED=0
printf '%-34s %4s %8s %10s %8s %9s %4s\n' scenario rc wall_s mem_peak_MiB pids_pk tmp_pk_MiB oom | tee "$WS/results/summary.txt"

# Peaks come from the container's own cgroup (cgroupns); under gVisor there is none inside, so they are
# read from the host's systemd-driver cgroup instead (which then also counts the gVisor sentry's threads).
cg_read() {
  local v
  if v=$(docker exec "$1" cat "/sys/fs/cgroup/$2" 2>/dev/null); then printf '%s\n' "$v"; return; fi
  cat "/sys/fs/cgroup/system.slice/docker-$1.scope/$2" 2>/dev/null || echo 0
}

# scenario NAME [--runtime R] [--plugins] [--pids N] -- SHELL-COMMAND
scenario() {
  local name="$1"; shift
  local extra=()
  while [ "$1" != "--" ]; do
    case "$1" in
      --runtime) extra+=(--runtime "$2"); shift 2 ;;
      --plugins) extra+=(--mount "type=bind,source=$SKILL_SRC,target=/opt/plugins/noah/skills/pptx,readonly"); shift ;;
      --pids) extra+=(--pids-limit "$2"); shift 2 ;;
      *) echo "verify: scenario $name: bad option $1" >&2; exit 2 ;;
    esac
  done
  shift
  if [ -n "$ONLY" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  local cmd="$1" cid rc t0 t1 sampler
  cid="$(docker run -d "${SANDBOX_FLAGS[@]}" "${extra[@]}" "$IMAGE" sleep infinity)" || { echo "$name: docker run failed"; FAILED=1; return; }
  docker exec "$cid" sh -c 'while :; do df -k /tmp | awk "NR==2{print \$3}"; sleep 0.25; done' >"$WS/results/$name.tmpfs" 2>/dev/null &
  sampler=$!
  t0=$(date +%s.%N)
  docker exec -e NOAH_PPTX_LOCK_NAMESPACE="$NS-$name" "$cid" bash -c "$cmd" >"$WS/results/$name.out" 2>"$WS/results/$name.err"
  rc=$?
  t1=$(date +%s.%N)
  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
  local mem pids oom tmppk
  mem=$(cg_read "$cid" memory.peak)
  pids=$(cg_read "$cid" pids.peak)
  oom=$(cg_read "$cid" memory.events | awk '$1=="oom_kill"{print $2}')
  tmppk=$(sort -n "$WS/results/$name.tmpfs" | tail -1)
  mem="${mem//[^0-9]/}"; pids="${pids//[^0-9]/}"; tmppk="${tmppk//[^0-9]/}"; oom="${oom//[^0-9?]/}"
  docker rm -f "$cid" >/dev/null
  printf '%-34s %4s %8.1f %10.0f %8s %9.1f %4s\n' "$name" "$rc" "$(echo "$t1 - $t0" | bc)" \
    "$(echo "${mem:-0} / 1048576" | bc)" "${pids:-0}" "$(echo "${tmppk:-0} / 1024" | bc -l)" "$oom" | tee -a "$WS/results/summary.txt"
  if [ "$rc" -ne 0 ] || { [ "$oom" != "0" ] && [ "$oom" != "?" ]; }; then FAILED=1; fi
}

scenario probe -- "$DECK probe --json"
scenario probe-no-node-path -- "env -u NODE_PATH $DECK probe --json"
scenario probe-ro-plugins --plugins -- "bash /opt/plugins/noah/skills/pptx/scripts/deck.sh probe --json"
scenario selftest -- "$DECK selftest --json"
scenario business-review.embedded -- "cd /workspace/decks/business-review && $DECK build . --strict --json"
if [ "$QUICK" = 0 ]; then
  for d in business-review handbook layouts talk visual; do
    [ "$d" = business-review ] || scenario "$d.embedded" -- "cd /workspace/decks/$d && $DECK build . --strict --json"
    scenario "$d.malgun" -- "cd /workspace/decks/$d && $DECK build . --profile malgun --strict --json"
  done
  scenario ro-plugins.handbook --plugins -- "cd /workspace/decks/handbook && bash /opt/plugins/noah/skills/pptx/scripts/deck.sh build . --strict --json"
  scenario max60.embedded -- "cd /workspace/decks/max60 && $DECK build . --json"
  # Two builds started at once in ONE sandbox. The image sets NOAH_PPTX_MAX_CONCURRENT=1 (the slots are
  # abstract sockets, i.e. per network namespace = per sandbox), so the second waits for the slot; the
  # "slots2" scenarios override it to the main image's 2 to measure two Chromiums side by side.
  for slots in 1 2; do
    scenario "concurrent.slots$slots.talk+visual" -- "export NOAH_PPTX_MAX_CONCURRENT=$slots; cd /workspace/decks; R=/workspace/results;
      $DECK build talk --json >\$R/c$slots-talk.json 2>\$R/c$slots-talk.err & a=\$!;
      $DECK build visual --json >\$R/c$slots-visual.json 2>\$R/c$slots-visual.err & b=\$!;
      wait \$a; ra=\$?; wait \$b; rb=\$?; echo talk=\$ra visual=\$rb; [ \$ra -eq 0 ] && [ \$rb -eq 0 ]"
    scenario "concurrent.slots$slots.max60+layouts" -- "export NOAH_PPTX_MAX_CONCURRENT=$slots; cd /workspace/decks; R=/workspace/results;
      $DECK build max60 --json >\$R/c$slots-max60.json 2>\$R/c$slots-max60.err & a=\$!;
      $DECK build layouts --json >\$R/c$slots-layouts.json 2>\$R/c$slots-layouts.err & b=\$!;
      wait \$a; ra=\$?; wait \$b; rb=\$?; echo max60=\$ra layouts=\$rb; [ \$ra -eq 0 ] && [ \$rb -eq 0 ]"
  done
fi
if [ "$RUNSC" = 1 ]; then
  # gVisor's sentry threads count against the HOST pids cgroup: 256 kills the sandbox mid-build
  # (host peaks of 340–400 measured for one build; 512 still failed once), so this scenario uses 1024
  # (README "gVisor").
  scenario runsc.business-review --runtime runsc --pids 1024 -- "cd /workspace/decks/business-review && $DECK build . --strict --json"
fi

echo
echo "results: $WS/results"
exit "$FAILED"
