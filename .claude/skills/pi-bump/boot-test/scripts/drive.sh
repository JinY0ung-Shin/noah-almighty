#!/usr/bin/env bash
# The boot test of ONE run directory (made by ../prepare.sh; this file runs from <run-dir>/scripts/).
#
#   drive.sh          everything, in order (about 8 minutes with a cold build)
#   drive.sh build    00 dind → 01 setup-host → 02 build → 03 up            (about 4 minutes cold)
#   drive.sh checks   run-all → the extras → the final state               (about 3 minutes; needs `build`)
#
# Every step prints ONE line (`<step> exit=<rc>  <n>/<m> passed`) and its FAIL lines under it; a step's whole
# output is in <run-dir>/evidence/. What is printed here is also appended to <run-dir>/logs/drive.log. The last
# line is `== done: …`, and the exit status is 1 when any step failed. Teardown is separate: 99-teardown.sh.
#
# NOT part of this run — by hand, each says when in its own header:
#   89-plugin-timer.mjs      waits an hour for the gateway's own marketplace refresh
#   91-validator-matrix.mjs  compares pi-ai's argument validator between two gateway images
#   70-, 72- (with 73-, 74-) the tracing service's static state and its stop/start/image-swap behaviour
set -uo pipefail
cd "$(dirname "$0")"
. ./lib.sh
STAGE=${1:-all}
case "$STAGE" in all | build | checks) ;; *) echo "usage: drive.sh [all|build|checks]" >&2; exit 2 ;; esac
mkdir -p "$W/logs" "$W/evidence"

failed=0
# extra NAME EVIDENCE-FILE command…   (the same line shape as run-all.sh's step)
extra() {
  local name="$1" out="$W/evidence/$2"; shift 2
  "$@" > "$out" 2>&1; local rc=$?
  printf '%-28s exit=%s  %s\n' "$name" "$rc" "$(grep -E '^[0-9]+/[0-9]+ passed' "$out" | tail -1)"
  grep -E '^FAIL' "$out" || true
  [ "$rc" -eq 0 ] || failed=$((failed + 1))
}
# setup TITLE LINES command…   (a stage that only has to succeed: its last LINES lines are shown)
setup() {
  local title="$1" lines="$2"; shift 2
  echo "== $title"
  "$@" 2>&1 | tail -n "$lines" | cut -c1-200
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || { echo "$title: exit=$rc"; failed=$((failed + 1)); }
  return "$rc"
}

build_stage() {
  setup "00 dind" 4 ./00-dind-up.sh || return 1
  setup "01 setup-host" 6 ./01-setup-host.sh || return 1
  echo "== 02 build"
  ./02-build.sh || { failed=$((failed + 1)); tail -n 30 "$W/logs/02-build.log" | cut -c1-240; return 1; }
  tail -n 3 "$W/logs/02-build.log" | cut -c1-200
  setup "03 up" 12 ./03-up.sh || return 1
}

checks_stage() {
  echo "== run-all"
  ./run-all.sh 2>&1 || failed=$((failed + 1))
  echo "== extra"
  extra 71-tracing-turn          T-turn.log                    node 71-tracing-turn.mjs
  extra 75-trace-stats           T9-trace-stats.log            node 75-trace-stats.mjs
  extra 25-admin-ui-real         A-admin-ui-real-gateway.log   node 25-admin-ui-real-gateway.mjs
  extra 85-workspace-files       W-workspace-files.log         node 85-workspace-files.mjs
  setup "06 mcp fixture" 8 ./06-mcp-fixture.sh
  extra 86-mcp-files             F-mcp-files.log               node 86-mcp-files.mjs
  extra 87-mcp-file-args         G-mcp-file-args.log           node 87-mcp-file-args.mjs
  setup "07 git fixture" 3 ./07-git-fixture.sh
  extra 88-plugin-refresh        P-plugin-refresh.log          node 88-plugin-refresh.mjs
  # Guards for behaviour earlier bumps brought (argument validation, grep's glob, the tool call limit).
  extra 90-pi-validation         V-pi-validation.log           node 90-pi-validation.mjs
  extra 92-grep-glob             V-grep-glob.log               node 92-grep-glob.mjs
  extra 93-tool-call-limit       L-tool-call-limit.log         node 93-tool-call-limit.mjs
  extra 80-context-usage         X-context-usage.log           node 80-context-usage.mjs
  # A new bump's ONE quick check goes here, as the next free number below 95 (SKILL.md "Adding a check").
  echo "== final state"
  extra 95-final-state           final-state.txt               ./95-final-state.sh
  grep -E 'error-level=|MiB' "$W/evidence/final-state.txt" | sed 's/^/  /'
}

main() {
  echo "== run directory: $W (Noah $NOAH_COMMIT, pi $PI_COMMIT) — stage: $STAGE — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$STAGE" != checks ]; then
    build_stage || { echo "== done: the build stage FAILED — nothing was checked"; return 1; }
  fi
  if [ "$STAGE" != build ]; then
    checks_stage
  fi
  if [ "$failed" -eq 0 ]; then echo "== done: every step passed (stage: $STAGE)"; else echo "== done: $failed step(s) FAILED (stage: $STAGE)"; fi
  [ "$failed" -eq 0 ]
}
main 2>&1 | tee -a "$W/logs/drive.log"
exit "${PIPESTATUS[0]}"
