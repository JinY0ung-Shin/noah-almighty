#!/usr/bin/env bash
# Live check of the login through Keycloak (docs/architecture/login-keycloak.md "Verify"), from nothing:
#
#   scripts/keycloak-login-check/run.sh            # build Noah from this checkout, run both phases, tear down
#   KEEP=1 scripts/keycloak-login-check/run.sh     # leave the stack up afterwards (docker compose -p … down -v)
#
# A private compose project with the real keycloak / keycloak-db / noah-nginx definitions and Noah on the
# `local` runtime. Phase 1: the install BEFORE Keycloak (built-in login) leaves accounts behind. Phase 2: the
# same data with Keycloak turned on — including pi's admin API through Noah's /admin relay, which pi lets in
# on the PERSON's token. Needs docker with compose and openssl; publishes nothing on the host.
# CHECK_PI_DIR builds pi's gateway from another checkout than vendor/pi-gateway.
# NOAH_NGINX_SUBNET / NOAH_NGINX_IP move the stack's front network when 172.16.239.0/24 is taken.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROJECT="${CHECK_PROJECT:-noah-keycloak-login-check}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/noah-keycloak-login-check.XXXXXX")"
export NOAH_SERVER_NAME=noah.rig.test PI_GATEWAY_HOME="$WORK" PI_GATEWAY_SECRETS="$WORK/secrets"
export NOAH_NGINX_SUBNET="${NOAH_NGINX_SUBNET:-172.16.239.0/24}" NOAH_NGINX_IP="${NOAH_NGINX_IP:-172.16.239.10}"
compose() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" "$@"; }
cleanup() {
  if [ "${KEEP:-}" = 1 ]; then echo "kept: docker compose -p $PROJECT down -v   (files in $WORK)"; return; fi
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The files docker/pi/setup-host.sh and the operator provide on a real host.
mkdir -p "$WORK/secrets/keycloak" "$WORK/secrets/noah" "$WORK/tls"
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
db_password="$(rand)"; client_secret="$(rand)"
printf '%s\n' "$db_password" > "$WORK/secrets/keycloak/db_password"
printf 'KC_DB_PASSWORD=%s\nKC_BOOTSTRAP_ADMIN_USERNAME=keycloak-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=%s\nNOAH_KEYCLOAK_CLIENT_SECRET=%s\n' \
  "$db_password" "$(rand)" "$client_secret" > "$WORK/secrets/keycloak/keycloak.env"
printf '%s\n' "$client_secret" > "$WORK/secrets/noah/keycloak_client_secret"
# pi's gateway: its keys as plain environment (this stack only), Noah's copies as files. Noah's copy of the
# ADMIN key is wrong on purpose (compose.template.yml).
pi_api_key="$(rand)"; pi_admin_key="$(rand)"
printf 'API_KEY=%s\nADMIN_API_KEY=%s\nSANDBOXD_JWT_SECRET=%s\nBROKER_JWT_SECRET=%s\nMEMORY_API_KEY=%s\n' \
  "$pi_api_key" "$pi_admin_key" "$(rand)" "$(rand)" "$(rand)" > "$WORK/secrets/gateway.env"
printf '%s\n' "$pi_api_key" > "$WORK/secrets/noah/pi_gateway_api_key"
printf '%s\n' "$(rand)" > "$WORK/secrets/noah/pi_gateway_admin_api_key_wrong"
chmod 644 "$WORK/secrets/noah/pi_gateway_api_key" "$WORK/secrets/noah/pi_gateway_admin_api_key_wrong"
chmod 644 "$WORK/secrets/keycloak/db_password" "$WORK/secrets/keycloak/keycloak.env" "$WORK/secrets/noah/keycloak_client_secret"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$NOAH_SERVER_NAME" -addext "subjectAltName=DNS:$NOAH_SERVER_NAME" \
  -keyout "$WORK/tls/privkey.pem" -out "$WORK/tls/fullchain.pem" 2>/dev/null
chmod 644 "$WORK/tls/"*.pem
sed "s#@REPO@#$REPO#g; s#@WORK@#$WORK#g" "$HERE/compose.template.yml" > "$WORK/compose.yml"

echo "== build Noah from $REPO"
docker build -q -t noah-keycloak-login-check:latest "$REPO" >/dev/null
PI_DIR="${CHECK_PI_DIR:-$REPO/vendor/pi-gateway}"
echo "== build pi's gateway from $PI_DIR"
docker build -q --target gateway -t noah-keycloak-login-check-gateway:latest "$PI_DIR" >/dev/null
compose down -v >/dev/null 2>&1 || true

drive() {
  docker run --rm --network "${PROJECT}_noah-front" --network "${PROJECT}_noah-auth" -e IDS="${IDS:-}" -e SECRET="$client_secret" \
    -e PI_ADMIN_KEY="$pi_admin_key" \
    -v "$HERE:/check:ro" --entrypoint node noah-keycloak-login-check:latest "/check/$1" 2>&1 | grep -v 'Warning\|trace-warnings'
}
wait_noah() {
  for _ in $(seq 1 60); do compose logs noah-almighty 2>&1 | grep -q 'server started' && return 0; sleep 1; done
  compose logs noah-almighty | tail -n 20; echo "Noah did not start" >&2; exit 1
}
wait_keycloak() {
  local id; id="$(compose ps -q keycloak)"
  for _ in $(seq 1 80); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ] && return 0; sleep 3; done
  compose logs keycloak | tail -n 20; echo "Keycloak did not become healthy" >&2; exit 1
}

echo "== phase 1: the built-in login (no Keycloak values)"
CHECK_KC_PUBLIC='' CHECK_KC_INTERNAL='' CHECK_KC_SECRET_FILE='' compose up -d >/dev/null 2>&1
wait_noah
wait_keycloak
out="$(drive phase1-builtin.mjs)" || { echo "$out"; exit 1; }
echo "$out" | grep -v '^IDS '
IDS="$(echo "$out" | sed -n 's/^IDS //p')"

echo "== phase 2: Keycloak on, same data"
CHECK_KC_PUBLIC="https://$NOAH_SERVER_NAME/sso" CHECK_KC_INTERNAL=http://keycloak:8080/sso \
  CHECK_KC_SECRET_FILE=/run/secrets/keycloak_client_secret_noah compose up -d noah-almighty >/dev/null 2>&1
sleep 2; wait_noah
drive phase2-keycloak.mjs
errors="$(compose logs noah-almighty 2>&1 | grep -c '"level":50' || true)"
echo "Noah error-level log lines: $errors"
[ "$errors" = 0 ]
