#!/usr/bin/env bash
# Tear everything named noahcompose-* down. The dind (root) first deletes the run's own key material and
# sandbox data under the work dir (secrets/, home/ — files owned by root / uid 10001) and hands the rest of the
# work dir back to the user running this; scripts, logs, evidence, fixtures and the exported tree stay.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
docker rm -f noahcompose-fake-llm noahcompose-mcp-fixture noahcompose-git-fixture
dc down -v --remove-orphans > "$W/logs/99-down.log" 2>&1; echo "compose down exit=$?"
dind sh -c 'ids=$(docker ps -aq); [ -z "$ids" ] || docker rm -f $ids >/dev/null; echo "containers left in the dind: $(docker ps -aq | wc -l)"'
dind sh -c "rm -rf '$W/secrets' '$W/home' && chown -R $(id -u):$(id -g) '$W' && echo 'removed secrets/ and home/, chowned the work dir'"
docker rm -f -v noahcompose-dind
docker volume rm noahcompose-dind-data
docker network rm noahcompose-net
echo "== anything named noahcompose-* left?"
docker ps -a --format '{{.Names}}' | grep noahcompose || echo "containers: none"
docker volume ls -q | grep noahcompose || echo "volumes: none"
docker network ls --format '{{.Name}}' | grep noahcompose || echo "networks: none"
