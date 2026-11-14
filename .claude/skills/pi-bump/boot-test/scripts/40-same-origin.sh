#!/usr/bin/env bash
# D: the same-origin gate through the published port, and the TRUSTED_ORIGINS recovery.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
USERNAME=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).owner.username)' "$W/evidence/state.json")
COOKIE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).owner.cookie)' "$W/evidence/state.json")
BODY="{\"username\":\"$USERNAME\",\"password\":\"$E2E_PASSWORD\"}"
# login NAME [curl header args…] → "NAME → HTTP <code> <first 160 chars of the body, the user object cut to its username>"
login() {
  local name="$1"; shift
  local out code
  out=$(curl -sS -o /tmp/noahcompose-login.out -w '%{http_code}' -X POST -H 'content-type: application/json' "$@" --data "$BODY" "$NOAH/api/auth/login")
  code=$out
  printf '%s → HTTP %s  %s\n' "$name" "$code" "$(node -e 'const t=require("fs").readFileSync("/tmp/noahcompose-login.out","utf8");try{const j=JSON.parse(t);console.log(j.user?`{user:{username:${JSON.stringify(j.user.username)},roles:${JSON.stringify(j.user.roles)}}}`:JSON.stringify(j))}catch{console.log(t.slice(0,160))}')"
  rm -f /tmp/noahcompose-login.out
}
wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$NOAH/api/bootstrap")" = 200 ] && return 0
    sleep 2
  done
  echo "Noah did not come back"; return 1
}
noah_log() { dc logs --no-log-prefix --since "$1" noah-almighty 2>&1; }

echo "== Noah's address as called: $NOAH"
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
login "(i)   no Origin, no Sec-Fetch-Site"
login "(ii)  Origin = the address called" -H "Origin: $NOAH"
login "(iii) Origin: https://evil.example" -H 'Origin: https://evil.example'
login "(extra) Sec-Fetch-Site: cross-site, own Origin" -H "Origin: $NOAH" -H 'Sec-Fetch-Site: cross-site'
login "(extra) Sec-Fetch-Site: same-site, own Origin" -H "Origin: $NOAH" -H 'Sec-Fetch-Site: same-site'
login "(extra) Sec-Fetch-Site: same-origin (a browser on this origin)" -H "Origin: $NOAH" -H 'Sec-Fetch-Site: same-origin'
login "(extra) Sec-Fetch-Site: none" -H 'Sec-Fetch-Site: none'
echo "== another cookie-authenticated mutation (PATCH /api/me with the owner's session, body {})"
curl -sS -o /dev/null -w 'PATCH /api/me, Origin evil → HTTP %{http_code}\n' -X PATCH -H 'content-type: application/json' -H "Cookie: $COOKIE" -H 'Origin: https://evil.example' --data '{}' "$NOAH/api/me"
curl -sS -o /dev/null -w 'PATCH /api/me, own Origin → HTTP %{http_code}\n' -X PATCH -H 'content-type: application/json' -H "Cookie: $COOKIE" -H "Origin: $NOAH" --data '{}' "$NOAH/api/me"
echo "== a GET is never refused"
curl -sS -o /dev/null -w 'GET /api/bootstrap, Origin evil → HTTP %{http_code}\n' -H 'Origin: https://evil.example' "$NOAH/api/bootstrap"
curl -sS -o /dev/null -w 'GET /api/me (session), Origin evil + Sec-Fetch-Site cross-site → HTTP %{http_code}\n' -H "Cookie: $COOKIE" -H 'Origin: https://evil.example' -H 'Sec-Fetch-Site: cross-site' "$NOAH/api/me"
curl -sS -o /dev/null -w 'GET /api/conversations (session), Origin evil → HTTP %{http_code}\n' -H "Cookie: $COOKIE" -H 'Origin: https://evil.example' "$NOAH/api/conversations"
curl -sS -o /dev/null -w 'HEAD /api/bootstrap, Origin evil → HTTP %{http_code}\n' -I -H 'Origin: https://evil.example' "$NOAH/api/bootstrap"
echo "== Noah log: the refusal warning(s)"
noah_log "$T0" | grep 'refused a state-changing request' | tee "$W/evidence/D-refusal-log.jsonl" | node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{try{const j=JSON.parse(l);console.log(JSON.stringify({level:j.level,method:j.method,path:j.path,reason:j.reason,origin:j.origin,secFetchSite:j.secFetchSite,ownOrigin:j.ownOrigin,host:j.host,forwardedHost:j.forwardedHost,msg:String(j.msg).slice(0,60)+"…"}))}catch{console.log(l.slice(0,400))}})'

echo
echo "== (iv) TRUSTED_ORIGINS=https://evil.example, recreate noah-almighty"
echo 'TRUSTED_ORIGINS=https://evil.example' >> "$W/noah-almighty/.env"
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d noah-almighty > "$W/logs/40-up-trusted.log" 2>&1; echo "up exit=$?"; grep -E 'noah-almighty-noah-almighty-1 (Recreate|Recreated|Started)' "$W/logs/40-up-trusted.log" | sort -u
wait_healthy
dc exec -T noah-almighty sh -c 'echo "in container: TRUSTED_ORIGINS=$TRUSTED_ORIGINS"'
noah_log "$T1" | grep -i 'TRUSTED_ORIGINS' | cut -c1-300
login "(iv)  Origin: https://evil.example, now trusted" -H 'Origin: https://evil.example'
login "(iv+) Origin: https://evil.example + Sec-Fetch-Site: cross-site, trusted" -H 'Origin: https://evil.example' -H 'Sec-Fetch-Site: cross-site'
login "(iv control) Origin: https://other.example (not listed)" -H 'Origin: https://other.example'

echo
echo "== remove TRUSTED_ORIGINS again, recreate"
sed -i '/^TRUSTED_ORIGINS=/d' "$W/noah-almighty/.env"
grep -c '^TRUSTED_ORIGINS=' "$W/noah-almighty/.env" | sed 's/^/TRUSTED_ORIGINS lines left in .env: /'
dc up -d noah-almighty > "$W/logs/40-up-untrusted.log" 2>&1; echo "up exit=$?"
wait_healthy
dc exec -T noah-almighty sh -c 'echo "in container: TRUSTED_ORIGINS=[${TRUSTED_ORIGINS:-}]"'
login "(after removal) Origin: https://evil.example" -H 'Origin: https://evil.example'
login "(after removal) no Origin" 
dc ps --format '{{.Service}} {{.Status}}'
