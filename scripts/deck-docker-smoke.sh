#!/usr/bin/env bash
# Deck converter Docker smoke — dev/CI only, never part of the image.
#
# Drives a BUILT Noah image the way production runs it. Every conversion runs inside one
# container started with --network none --cap-drop ALL --security-opt no-new-privileges:true
# -u node (plus --init, like compose's `init: true`). Steps:
#   (a) the image's /tmp holds no noah-pptx*/playwright*/deck-* leftovers, and the build-time
#       self-test record says "pass"
#   (b) deck.sh probe --json reports converter: true
#   (c) deck.sh selftest --fail-on-drift (golden drift is FATAL here, unlike the image build's
#       default)
#   (d) a copy of every examples/<deck>/ builds in both profiles with --strict
#   (e) two concurrent checks of one deck: exactly one exits 5 "already running"
#   (f) SIGKILL deck.mjs mid-build: no Chromium/Python left after 10 s, the re-run is not
#       refused (kernel-released lock) and no converter run dir is left in /tmp (startup sweep)
#   (g) Open XML SDK validation (Microsoft365) of every produced .pptx: 0 errors
#   (h) server boot: /api/bootstrap 200 + the "deck toolchain probe" log line (converter true)
#   (i) with --baseline-image: upgrade rehearsal — the new image boots on a data volume the
#       baseline created, and the account made there still logs in
#   (j) summary table
# Mechanics and the release recipe: docs/architecture/pptx-converter.md,
# docs/architecture/build-run-verify.md.

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deck-docker-smoke.sh [--image IMG] [--build] [--baseline-image IMG]
                                    [--validator-dll PATH] [--require-validator] [--keep DIR]

  --image IMG           image under test (default: noah-almighty:deck-verify)
  --build               docker build IMG from this checkout first (mirror/proxy/CA build args are
                        forwarded from the environment when set)
  --baseline-image IMG  also run the upgrade rehearsal (i) from IMG (a fresh build of main)
  --validator-dll PATH  a built Validator.dll (scripts/openxml-validator); default: build it with
                        the .NET SDK image (DOTNET_IMAGE, default mcr.microsoft.com/dotnet/sdk:8.0)
  --require-validator   FAIL step (g) instead of skipping it when the validator is unavailable
  --keep DIR            keep decks, JSON reports and logs in DIR (default: a temp dir, removed)

Exit: 0 every step passed (SKIP only for (g) without --require-validator and (i) without a
baseline), 1 a step failed, 2 usage error or missing prerequisite.
EOF
}

IMAGE="noah-almighty:deck-verify"
BUILD=0
BASELINE=""
VALIDATOR_DLL=""
REQUIRE_VALIDATOR=0
KEEP=""
DOTNET_IMAGE="${DOTNET_IMAGE:-mcr.microsoft.com/dotnet/sdk:8.0}"

need_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    echo "deck-docker-smoke: $1 needs a value" >&2
    usage >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image) need_value "$@"; IMAGE="$2"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --baseline-image) need_value "$@"; BASELINE="$2"; shift 2 ;;
    --validator-dll) need_value "$@"; VALIDATOR_DLL="$2"; shift 2 ;;
    --require-validator) REQUIRE_VALIDATOR=1; shift ;;
    --keep) need_value "$@"; KEEP="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "deck-docker-smoke: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- paths inside the image (fixed by the Dockerfile; plan I1) ---------------------------------
SKILL=/app/default-skills/skills/pptx
DECK_SH="$SKILL/scripts/deck.sh"
RECORD=/usr/local/share/noah-almighty/deck-selftest.json
PORT_IN_IMAGE=48787
# Every conversion container: exactly the production-hardening flags the plan requires.
CONV_FLAGS=(--network none --cap-drop ALL --security-opt no-new-privileges:true -u node --init)
# /tmp entries the converter (or Playwright) must never leave behind.
LEAK_RE='^(noah-pptx|playwright|deck-)'

# ---- prerequisites ------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "deck-docker-smoke: docker is not installed" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "deck-docker-smoke: the docker daemon is not reachable" >&2
  exit 2
fi
if [ -n "$VALIDATOR_DLL" ] && [ ! -f "$VALIDATOR_DLL" ]; then
  echo "deck-docker-smoke: --validator-dll $VALIDATOR_DLL does not exist" >&2
  exit 2
fi

if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP" || exit 2
  OUT="$(cd "$KEEP" && pwd)"
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/deck-smoke.XXXXXX")" || exit 2
fi
LOGS="$OUT/logs"
mkdir -p "$LOGS"

RUN_ID="$$-$RANDOM"
C_SMOKE="deck-smoke-$RUN_ID"
C_BOOT="deck-smoke-boot-$RUN_ID"
C_BASE="deck-smoke-base-$RUN_ID"
C_UPG="deck-smoke-upgrade-$RUN_ID"
VOL="deck-smoke-data-$RUN_ID"

# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup() {
  docker rm -f "$C_SMOKE" "$C_BOOT" "$C_BASE" "$C_UPG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  if [ -z "$KEEP" ]; then
    rm -rf "$OUT"
  fi
}
trap cleanup EXIT
trap 'echo "deck-docker-smoke: interrupted" >&2; exit 130' INT TERM

# ---- helpers ------------------------------------------------------------------------------------
R_STEP=()
R_STATUS=()
R_DETAIL=()
record() { # <step> <PASS|FAIL|SKIP> <detail>
  R_STEP+=("$1")
  R_STATUS+=("$2")
  R_DETAIL+=("$3")
  printf '  -> %-18s %-4s  %s\n' "$1" "$2" "$3"
}
say() { printf '\n== %s\n' "$*"; }
tail_of() { # <file> — the last lines of a log, indented, for failure details
  [ -f "$1" ] && tail -n 8 "$1" | sed 's/^/     | /'
}
tmo() { # <seconds> <cmd...> — host-side safety net; the converter enforces its own budgets
  local s="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi
}

# jget <json file on the host> <JS expression over `j`> — evaluated by the IMAGE's node (so the
# host needs no jq/node); prints "" for undefined/null and exits 3 on unparseable JSON.
JGET_JS='let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>{s+=d});process.stdin.on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){process.exit(3)}let v;try{v=new Function("j","return ("+process.argv[1]+")")(j)}catch(e){v=undefined}process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))})'
jget() {
  docker exec -i "$C_SMOKE" node -e "$JGET_JS" "$2" <"$1" 2>/dev/null
}

# wait_bootstrap <container> <seconds> — 0 once GET /api/bootstrap answers 200
wait_bootstrap() {
  local c="$1" limit="$2" i=0 code
  while [ "$i" -lt "$limit" ]; do
    code="$(docker exec "$c" curl -s -o /dev/null -w '%{http_code}' --noproxy '*' \
      "http://localhost:$PORT_IN_IMAGE/api/bootstrap" 2>/dev/null)"
    [ "$code" = "200" ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ] || return 1
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# post_json <container> <path> <json> — prints the HTTP status
post_json() {
  docker exec "$1" curl -s -o /dev/null -w '%{http_code}' --noproxy '*' \
    -H 'Content-Type: application/json' -d "$3" "http://localhost:$PORT_IN_IMAGE$2" 2>/dev/null
}

# probe_log_line <container> — the boot log's "deck toolchain probe" JSON line (pino, production)
probe_log_line() {
  docker logs "$1" 2>&1 | grep -F '"msg":"deck toolchain probe"' | head -n 1
}

# ---- build (optional) ---------------------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
  say "build $IMAGE from $ROOT"
  build_args=()
  for v in APT_MIRROR_HOST NPM_CONFIG_REGISTRY PIP_INDEX_URL PIP_TRUSTED_HOST CA_CERT_FILE \
    HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    if [ -n "${!v:-}" ]; then build_args+=(--build-arg "$v"); fi
  done
  docker build --progress=plain ${build_args[@]+"${build_args[@]}"} -t "$IMAGE" "$ROOT" \
    >"$LOGS/image-build.log" 2>&1
  brc=$?
  selftest_line="$(grep -o 'deck converter selftest: [A-Z]*[^"]*' "$LOGS/image-build.log" | tail -n 1)"
  if [ "$brc" -eq 0 ]; then
    record build PASS "${selftest_line:-built (no selftest line found in the build log)}"
  else
    record build FAIL "docker build exited $brc (log: $LOGS/image-build.log)"
    tail_of "$LOGS/image-build.log"
  fi
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "deck-docker-smoke: image $IMAGE not found (build it, or pass --build)" >&2
  exit 2
fi

# ---- (a) image /tmp hygiene + the build-time record ---------------------------------------------
say "(a) image /tmp hygiene and the build-time self-test record"
tmp_listing="$(docker run --rm --network none "$IMAGE" sh -c 'ls -A /tmp')"
leaks="$(printf '%s\n' "$tmp_listing" | grep -E "$LEAK_RE" | tr '\n' ' ')"

docker run -d --name "$C_SMOKE" "${CONV_FLAGS[@]}" "$IMAGE" sleep infinity >/dev/null ||
  {
    echo "deck-docker-smoke: could not start the smoke container from $IMAGE" >&2
    exit 2
  }

docker exec "$C_SMOKE" cat "$RECORD" >"$OUT/deck-selftest-record.json" 2>/dev/null
record_status="$(jget "$OUT/deck-selftest-record.json" 'j.status')"
record_chromium="$(jget "$OUT/deck-selftest-record.json" 'j.chromiumVersion')"
if [ -n "$leaks" ]; then
  record a/tmp FAIL "leftovers in the image's /tmp: $leaks"
else
  record a/tmp PASS "no noah-pptx*/playwright*/deck-* entries"
fi
if [ "$record_status" = "pass" ]; then
  record a/record PASS "$RECORD: pass (Chromium ${record_chromium:-?})"
else
  record a/record FAIL "$RECORD: status '${record_status:-missing or unparseable}' (drift or a legacy image is not accepted here)"
fi

# ---- (b) probe ----------------------------------------------------------------------------------
say "(b) deck.sh probe --json"
docker exec "$C_SMOKE" bash "$DECK_SH" probe --json >"$OUT/probe.json" 2>"$LOGS/probe.log"
rc=$?
converter="$(jget "$OUT/probe.json" 'j.converter')"
if [ "$rc" -eq 0 ] && [ "$converter" = "true" ]; then
  record b/probe PASS "converter true; Chromium $(jget "$OUT/probe.json" 'j.chromium && j.chromium.version') ($(jget "$OUT/probe.json" 'j.chromium && j.chromium.source')); profiles $(jget "$OUT/probe.json" 'j.profiles && j.profiles.join("+")')"
else
  record b/probe FAIL "exit $rc, converter '${converter:-?}', missing: $(jget "$OUT/probe.json" 'j.missing && j.missing.join("; ")')"
  tail_of "$LOGS/probe.log"
fi

# ---- (c) selftest, drift fatal ------------------------------------------------------------------
say "(c) deck.sh selftest --fail-on-drift"
docker exec "$C_SMOKE" mkdir -p /tmp/w
tmo 1200 docker exec "$C_SMOKE" bash "$DECK_SH" selftest --fail-on-drift --keep /tmp/w/selftest --json \
  >"$OUT/selftest.json" 2>"$LOGS/selftest.log"
rc=$?
st_status="$(jget "$OUT/selftest.json" 'j.status')"
st_line="$(grep -o 'deck converter selftest: .*' "$LOGS/selftest.log" | tail -n 1)"
if [ "$rc" -eq 0 ] && [ "$st_status" = "pass" ]; then
  record c/selftest PASS "${st_line:-status pass}"
else
  record c/selftest FAIL "exit $rc, status '${st_status:-?}' ${st_line}"
  tail_of "$LOGS/selftest.log"
fi

# ---- (d) every example deck, both profiles, --strict --------------------------------------------
say "(d) examples/* -> build --strict, both profiles"
mapfile -t EXAMPLES < <(docker exec "$C_SMOKE" sh -c \
  'for d in "$1"/examples/*/; do [ -d "$d/slides" ] && basename "$d"; done; true' sh "$SKILL")
if [ "${#EXAMPLES[@]}" -eq 0 ]; then
  record d/examples FAIL "no $SKILL/examples/<deck>/slides/ in the image"
fi
for ex in ${EXAMPLES[@]+"${EXAMPLES[@]}"}; do
  docker exec "$C_SMOKE" cp -r "$SKILL/examples/$ex" "/tmp/w/$ex"
  for profile in embedded malgun; do
    tmo 700 docker exec "$C_SMOKE" bash "$DECK_SH" build "/tmp/w/$ex" --profile "$profile" --strict --json \
      >"$OUT/build-$ex-$profile.json" 2>"$LOGS/build-$ex-$profile.log"
    rc=$?
    ok="$(jget "$OUT/build-$ex-$profile.json" 'j.ok')"
    if [ "$rc" -eq 0 ] && [ "$ok" = "true" ]; then
      record "d/$ex/$profile" PASS "$(jget "$OUT/build-$ex-$profile.json" 'j.slideCount') slides, $(jget "$OUT/build-$ex-$profile.json" 'j.pptx && (j.pptx.bytes < 1048576 ? Math.max(1, Math.round(j.pptx.bytes/1024)) + " KB" : (j.pptx.bytes/1048576).toFixed(1) + " MB")'), $(jget "$OUT/build-$ex-$profile.json" 'j.preview && j.preview.slides') previews, $(jget "$OUT/build-$ex-$profile.json" 'j.timingsMs && (j.timingsMs.total/1000).toFixed(1)') s"
    else
      record "d/$ex/$profile" FAIL "exit $rc: $(jget "$OUT/build-$ex-$profile.json" 'j.failure && (j.failure.class + ": " + j.failure.message)')"
      tail_of "$LOGS/build-$ex-$profile.log"
    fi
  done
done
FIRST_EXAMPLE="${EXAMPLES[0]:-}"

# ---- (e) per-deck lock --------------------------------------------------------------------------
say "(e) two concurrent checks of one deck"
if [ -z "$FIRST_EXAMPLE" ]; then
  record e/lock FAIL "no example deck to lock"
else
  lockdeck="/tmp/lock/$FIRST_EXAMPLE"
  docker exec "$C_SMOKE" sh -c 'mkdir -p /tmp/lock && cp -r "$1" "$2"' sh "$SKILL/examples/$FIRST_EXAMPLE" "$lockdeck"
  (
    tmo 700 docker exec "$C_SMOKE" bash "$DECK_SH" check "$lockdeck" --profile both >"$LOGS/lock-1.log" 2>&1
    echo $? >"$OUT/lock-1.rc"
  ) &
  lock_pid1=$!
  # Start the second run once the first holds the deck lock (its .build/run.json appears), or
  # after 2 s at the latest — a both-profile check runs for several seconds either way.
  docker exec "$C_SMOKE" sh -c \
    'i=0; while [ "$i" -lt 40 ] && [ ! -e "$1/.build/run.json" ]; do sleep 0.05; i=$((i+1)); done' sh "$lockdeck"
  (
    tmo 700 docker exec "$C_SMOKE" bash "$DECK_SH" check "$lockdeck" --profile both >"$LOGS/lock-2.log" 2>&1
    echo $? >"$OUT/lock-2.rc"
  ) &
  lock_pid2=$!
  wait "$lock_pid1" "$lock_pid2"
  rc1="$(cat "$OUT/lock-1.rc" 2>/dev/null)"
  rc2="$(cat "$OUT/lock-2.rc" 2>/dev/null)"
  busy=0
  done_ok=0
  busy_msg=0
  lock_rcs=("$rc1" "$rc2")
  for i in 0 1; do
    if [ "${lock_rcs[$i]}" = "5" ]; then
      busy=$((busy + 1))
      grep -q 'already running' "$LOGS/lock-$((i + 1)).log" && busy_msg=1
    elif [ "${lock_rcs[$i]}" = "0" ]; then
      done_ok=$((done_ok + 1))
    fi
  done
  if [ "$busy" -eq 1 ] && [ "$done_ok" -eq 1 ] && [ "$busy_msg" -eq 1 ]; then
    record e/lock PASS "exits $rc1/$rc2: one run refused with \"already running\""
  else
    record e/lock FAIL "exits $rc1/$rc2 (want exactly one 0 and one 5 saying \"already running\")"
    tail_of "$LOGS/lock-1.log"
    tail_of "$LOGS/lock-2.log"
  fi
fi

# ---- (f) cancellation ---------------------------------------------------------------------------
say "(f) SIGKILL deck.mjs mid-build"
if [ -z "$FIRST_EXAMPLE" ]; then
  record f/cancel FAIL "no example deck to build"
else
  canceldeck="/tmp/cancel/$FIRST_EXAMPLE"
  docker exec "$C_SMOKE" sh -c 'mkdir -p /tmp/cancel && cp -r "$1" "$2"' sh "$SKILL/examples/$FIRST_EXAMPLE" "$canceldeck"
  (
    tmo 700 docker exec "$C_SMOKE" bash "$DECK_SH" build "$canceldeck" >"$LOGS/cancel-build.log" 2>&1
    echo $? >"$OUT/cancel.rc"
  ) &
  cancel_pid=$!
  # The brackets keep pgrep from matching this very sh -c command line.
  if docker exec "$C_SMOKE" sh -c \
    'i=0; while [ "$i" -lt 600 ]; do pgrep -f "[c]hromium" >/dev/null && exit 0; sleep 0.1; i=$((i+1)); done; exit 1'; then
    docker exec "$C_SMOKE" pkill -KILL -f 'deck[.]mjs'
    wait "$cancel_pid"
    sleep 10
    stray="$(docker exec "$C_SMOKE" pgrep -a -f '[c]hromium|[p]ython3' | cut -c1-160)"
    if [ -n "$stray" ]; then
      record f/cancel FAIL "processes left 10 s after SIGKILL: $(printf '%s' "$stray" | tr '\n' ';')"
    else
      record f/cancel PASS "no Chromium/Python left 10 s after SIGKILL (build exit $(cat "$OUT/cancel.rc" 2>/dev/null))"
    fi
    tmo 700 docker exec "$C_SMOKE" bash "$DECK_SH" check "$canceldeck" >"$LOGS/cancel-rerun.log" 2>&1
    rerun_rc=$?
    run_dirs="$(docker exec "$C_SMOKE" sh -c 'ls -A /tmp' | grep -E "$LEAK_RE" | tr '\n' ' ')"
    if [ "$rerun_rc" -eq 0 ] && [ -z "$run_dirs" ]; then
      record f/rerun PASS "re-run exit 0; /tmp clean after the startup sweep"
    else
      record f/rerun FAIL "re-run exit $rerun_rc; /tmp leftovers: ${run_dirs:-none}"
      tail_of "$LOGS/cancel-rerun.log"
    fi
  else
    wait "$cancel_pid"
    record f/cancel FAIL "Chromium never started within 60 s (build exit $(cat "$OUT/cancel.rc" 2>/dev/null))"
    tail_of "$LOGS/cancel-build.log"
  fi
fi

# ---- (g) Open XML SDK validation ----------------------------------------------------------------
say "(g) Open XML SDK validation of every produced .pptx"
rm -rf "$OUT/w"
docker cp "$C_SMOKE:/tmp/w" "$OUT/w" >/dev/null 2>&1
mapfile -t DECKS < <(cd "$OUT/w" 2>/dev/null && find . -name '*.pptx' -not -path '*/.build/*' | sed 's|^\./||' | sort)
validator_skip() { # <reason>
  if [ "$REQUIRE_VALIDATOR" -eq 1 ]; then
    record g/openxml FAIL "$1 (--require-validator)"
  else
    echo "WARNING: skipping the Open XML SDK validation: $1" >&2
    record g/openxml SKIP "$1"
  fi
}
dll=""
if [ -n "$VALIDATOR_DLL" ]; then
  dll="$(cd "$(dirname "$VALIDATOR_DLL")" && pwd)/$(basename "$VALIDATOR_DLL")"
else
  vsrc="$OUT/validator"
  rm -rf "$vsrc"
  mkdir -p "$vsrc"
  cp "$ROOT/scripts/openxml-validator/Program.cs" "$ROOT/scripts/openxml-validator/Validator.csproj" "$vsrc/"
  if tmo 900 docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    -e DOTNET_NOLOGO=1 -v "$vsrc:/src" -w /src "$DOTNET_IMAGE" dotnet publish -c Release -o /src/out \
    >"$LOGS/validator-build.log" 2>&1 && [ -f "$vsrc/out/Validator.dll" ]; then
    dll="$vsrc/out/Validator.dll"
  fi
fi
if [ "${#DECKS[@]}" -eq 0 ]; then
  record g/openxml FAIL "no .pptx was produced to validate"
elif [ -z "$dll" ]; then
  validator_skip "could not build the validator with $DOTNET_IMAGE (log: $LOGS/validator-build.log)"
else
  work_paths=()
  for d in "${DECKS[@]}"; do work_paths+=("/work/$d"); done
  tmo 900 docker run --rm --network none -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    -e DOTNET_NOLOGO=1 -v "$(dirname "$dll"):/validator:ro" -v "$OUT/w:/work:ro" "$DOTNET_IMAGE" \
    dotnet "/validator/$(basename "$dll")" "${work_paths[@]}" >"$LOGS/validator.log" 2>&1
  vrc=$?
  clean="$(grep -c ': 0 error(s)$' "$LOGS/validator.log")"
  if [ "$vrc" -eq 0 ] && [ "$clean" -eq "${#DECKS[@]}" ]; then
    record g/openxml PASS "${#DECKS[@]} decks, 0 errors (Microsoft365)"
  elif [ "$vrc" -eq 1 ] || [ "$vrc" -eq 2 ]; then
    record g/openxml FAIL "validator exit $vrc: $(grep -E '^FILE ' "$LOGS/validator.log" | grep -v ': 0 error(s)$' | sed 's|/work/||' | tr '\n' ';')"
  else
    validator_skip "the validator did not run (exit $vrc; log: $LOGS/validator.log)"
  fi
fi

# ---- (h) server boot ----------------------------------------------------------------------------
say "(h) server boot"
docker run -d --name "$C_BOOT" --network none --init -e SESSION_SECRET=smoke "$IMAGE" >/dev/null
if wait_bootstrap "$C_BOOT" 120; then
  line="$(probe_log_line "$C_BOOT")"
  if printf '%s' "$line" | grep -Fq '"converter":true'; then
    record h/boot PASS "/api/bootstrap 200; deck toolchain probe $(printf '%s' "$line" | grep -o '"mode":"[a-z]*"')"
  else
    record h/boot FAIL "/api/bootstrap 200 but no 'deck toolchain probe' log line with converter true: ${line:-none}"
  fi
else
  record h/boot FAIL "/api/bootstrap never answered 200"
  docker logs "$C_BOOT" >"$LOGS/boot.log" 2>&1
  tail_of "$LOGS/boot.log"
fi
docker logs "$C_BOOT" >"$LOGS/boot.log" 2>&1
docker rm -f "$C_BOOT" >/dev/null 2>&1

# ---- (i) upgrade rehearsal ----------------------------------------------------------------------
say "(i) upgrade rehearsal"
if [ -z "$BASELINE" ]; then
  record i/upgrade SKIP "no --baseline-image given"
elif ! docker image inspect "$BASELINE" >/dev/null 2>&1; then
  record i/upgrade FAIL "baseline image $BASELINE not found"
else
  docker volume create "$VOL" >/dev/null
  docker run -d --name "$C_BASE" --network none --init -e SESSION_SECRET=smoke -v "$VOL:/app/data" "$BASELINE" >/dev/null
  account='{"username":"smoke-admin","password":"smoke-password-1"}'
  if ! wait_bootstrap "$C_BASE" 120; then
    record i/upgrade FAIL "the baseline image never answered /api/bootstrap"
  elif [ "$(post_json "$C_BASE" /api/auth/signup "$account")" != "201" ]; then
    record i/upgrade FAIL "could not create the first account on the baseline"
  else
    docker stop -t 15 "$C_BASE" >/dev/null
    docker logs "$C_BASE" >"$LOGS/upgrade-baseline.log" 2>&1
    docker rm -f "$C_BASE" >/dev/null
    docker run -d --name "$C_UPG" --network none --init -e SESSION_SECRET=smoke -v "$VOL:/app/data" "$IMAGE" >/dev/null
    if ! wait_bootstrap "$C_UPG" 120; then
      record i/upgrade FAIL "the new image never answered /api/bootstrap on the baseline's volume"
    else
      login="$(post_json "$C_UPG" /api/auth/login "$account")"
      line="$(probe_log_line "$C_UPG")"
      if [ "$login" = "200" ] && printf '%s' "$line" | grep -Fq '"converter":true'; then
        record i/upgrade PASS "baseline volume: /api/bootstrap 200, baseline account logs in, converter probe true"
      else
        record i/upgrade FAIL "login $login; probe line: ${line:-none}"
      fi
    fi
    docker logs "$C_UPG" >"$LOGS/upgrade-new.log" 2>&1
  fi
fi

# ---- (j) summary --------------------------------------------------------------------------------
say "(j) summary — $IMAGE"
failed=0
printf '%-20s %-5s %s\n' "STEP" "RESULT" "DETAIL"
for i in "${!R_STEP[@]}"; do
  printf '%-20s %-5s %s\n' "${R_STEP[$i]}" "${R_STATUS[$i]}" "${R_DETAIL[$i]}"
  [ "${R_STATUS[$i]}" = "FAIL" ] && failed=$((failed + 1))
done
if [ -n "$KEEP" ]; then
  echo "outputs kept in $OUT"
fi
if [ "$failed" -gt 0 ]; then
  echo "deck-docker-smoke: $failed step(s) FAILED"
  exit 1
fi
echo "deck-docker-smoke: all steps passed"
exit 0
