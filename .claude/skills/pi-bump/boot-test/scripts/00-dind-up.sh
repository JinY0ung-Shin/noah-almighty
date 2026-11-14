#!/usr/bin/env bash
# Private dind for the combined-stack boot test (docs/architecture/build-run-verify.md "Combined-stack boot test").
# The names are fixed (noahcompose-*), so only ONE run can be up on a host daemon at a time.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
if docker inspect "$DIND" >/dev/null 2>&1; then
  echo "a container named $DIND already exists — tear the earlier run down first (its scripts/99-teardown.sh)" >&2
  exit 1
fi
docker network inspect noahcompose-net >/dev/null 2>&1 || docker network create --subnet 10.217.0.0/24 noahcompose-net
docker run -d --name "$DIND" --privileged --network noahcompose-net --ip "$DIND_IP" \
  -e DOCKER_TLS_CERTDIR= -v noahcompose-dind-data:/var/lib/docker -v "$W:$W" docker:29-dind \
  dockerd --host=unix:///var/run/docker.sock --default-address-pool base=10.218.0.0/16,size=24
for _ in $(seq 1 60); do docker exec "$DIND" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$DIND" docker version --format 'engine {{.Server.Version}}'
docker exec "$DIND" docker compose version
docker exec "$DIND" apk add --no-cache bash curl >/dev/null
# DOCKER_GID for the stack is the gid of the DIND's socket (not the host's): written into the exported tree's .env.
GID_IN_DIND=$(docker exec "$DIND" stat -c %g /var/run/docker.sock)
sed -i '/^DOCKER_GID=/d' "$W/noah-almighty/.env"
echo "DOCKER_GID=$GID_IN_DIND" >> "$W/noah-almighty/.env"
docker exec "$DIND" sh -c 'bash --version | head -1; curl --version | head -1; openssl version; stat -c "sock gid %g" /var/run/docker.sock'
