#!/usr/bin/env bash
# The plugin-marketplace git fixture as a SIBLING container on noahcompose-net (fixed ip). It needs node, git and
# git-http-backend in one image ON THE HOST DAEMON: a pi gateway image has all three (only its binaries are used,
# any version does). A host that runs the bundled stack has pi-gateway/gateway:latest; elsewhere name another
# image with GIT_FIXTURE_IMAGE. (The image the dind just built is not visible to the host daemon.)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
GIT_IP=10.217.0.12
GIT_FIXTURE_IMAGE=${GIT_FIXTURE_IMAGE:-pi-gateway/gateway:latest}
docker image inspect "$GIT_FIXTURE_IMAGE" >/dev/null 2>&1 || { echo "no image $GIT_FIXTURE_IMAGE on the host daemon — set GIT_FIXTURE_IMAGE to one with node, git and git-http-backend (88-plugin-refresh.mjs needs this fixture)" >&2; exit 1; }
docker rm -f noahcompose-git-fixture >/dev/null 2>&1 || true
docker run -d --name noahcompose-git-fixture --network noahcompose-net --ip "$GIT_IP" --user 0:0 -e HOME=/tmp \
  -v "$W/scripts/git-fixture.mjs:/git-fixture.mjs:ro" --entrypoint node "$GIT_FIXTURE_IMAGE" /git-fixture.mjs
sleep 2
curl -fsS "http://$GIT_IP:18093/_state"; echo
# The clone pi makes (shallow, smart HTTP), from the host first.
tmp=$(mktemp -d)
git clone -q --depth 1 --no-tags --single-branch "http://$GIT_IP:18093/mk" "$tmp/mk" && echo "host clone ok: $(git -C "$tmp/mk" rev-parse HEAD) $(ls "$tmp/mk/plugins" | tr '\n' ' ')"
rm -rf "$tmp"
