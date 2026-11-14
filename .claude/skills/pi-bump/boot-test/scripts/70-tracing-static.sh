#!/usr/bin/env bash
# NOT in the default run (drive.sh): run it by hand when a bump touches the tracing service or its wiring. It
# prints what it sees for reading, without a pass count (about 30 s). Last run at pi 02a023e.
# It reads evidence/T1-compose-config.yml — the rendered config: `dc config > "$W/evidence/T1-compose-config.yml"`
# (rendered here when the file is missing).
#
# T1–T3: the merged jaeger service, its running state, and who can reach it.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
J=noah-almighty-jaeger-1
[ -f "$W/evidence/T1-compose-config.yml" ] || dc config > "$W/evidence/T1-compose-config.yml" 2>/dev/null
echo "===== T1: docker compose config (rendered before the build, NOAH_PI_JAEGER_IMAGE unset: $(grep -c '^NOAH_PI_JAEGER_IMAGE' "$W/noah-almighty/.env") lines in .env)"
awk '/^  jaeger:/{p=1;print;next} p&&/^  [a-z]/{exit} p{print}' "$W/evidence/T1-compose-config.yml" | sed "s#$W#<W>#g"
echo "--- 'ports' keys inside the jaeger block: $(awk '/^  jaeger:/{p=1;next} p&&/^  [a-z]/{exit} p{print}' "$W/evidence/T1-compose-config.yml" | grep -c 'ports:')"
echo "--- JAEGER_HOST on services:"; grep -n 'JAEGER_HOST' "$W/evidence/T1-compose-config.yml"
echo "--- control network / jaeger-data volume in the config:"; awk '/^networks:/{p=1} p' "$W/evidence/T1-compose-config.yml" | grep -A4 -E '^  control:|^  jaeger-data:'

echo; echo "===== T2: running state"
dind docker inspect -f 'state={{.State.Status}} restarts={{.RestartCount}} image={{.Config.Image}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} securityopt={{.HostConfig.SecurityOpt}} portbindings={{.HostConfig.PortBindings}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}}({{$v.IPAddress}}) {{end}}' $J
dind docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' $J | sed "s#$W#<W>#g"
echo "--- docker ps (name | ports) for every running container in the dind:"
dind docker ps --format '{{.Names}} | ports=[{{.Ports}}]'
echo "--- volume:"; dind docker volume ls --format '{{.Name}}' | grep jaeger
echo "--- anything listening for jaeger on the dind host (ss in the dind netns, ports 4317/4318/16686/14268):"
dind sh -c 'ss -ltnH 2>/dev/null || netstat -ltn' | grep -E ':(4317|4318|16686|14268)\b' || echo "none"
echo "--- from the host through the dind address (expect refused):"
for p in 4318 16686; do curl -s -o /dev/null -m 3 -w "host -> 10.217.0.2:$p HTTP %{http_code} (curl exit %{exitcode})\n" "http://10.217.0.2:$p/" ; done

echo; echo "===== T3: reachability"
JIP=$(dind docker inspect -f '{{(index .NetworkSettings.Networks "noah-almighty_control").IPAddress}}' $J)
echo "jaeger control-network address: $JIP"
PROBE='const t=process.argv.slice(1);(async()=>{for(const u of t){try{const r=await fetch(u,{signal:AbortSignal.timeout(4000),method:u.includes("4318")?"POST":"GET",headers:{"content-type":"application/json"},body:u.includes("4318")?"{}":undefined});console.log(u,"-> HTTP",r.status,(await r.text()).slice(0,80).replace(/\s+/g," "))}catch(e){console.log(u,"-> FAIL",e.cause?.code??e.name,(e.cause?.message??e.message).slice(0,60))}}})()'
for svc in gateway sandboxd mcp-broker; do
  echo "--- from $svc:"; dc exec -T $svc node -e "$PROBE" http://jaeger:4318/v1/traces http://jaeger:16686/api/v3/services
done
echo "--- from noah-almighty (by name, then by jaeger's control address):"
dc exec -T noah-almighty node -e "$PROBE" http://jaeger:4318/v1/traces http://jaeger:16686/api/v3/services "http://$JIP:4318/v1/traces" "http://$JIP:16686/api/v3/services"
dc exec -T noah-almighty sh -c 'getent hosts jaeger || echo "getent hosts jaeger: not found (exit $?)"'
echo "--- from egress-proxy's networks (information): $(dind docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' noah-almighty-egress-proxy-1)"
SBX=$(dind docker ps --filter label=pi-gateway.sandbox=1 --format '{{.Names}}' | head -1)
echo "--- from inside a user sandbox ($SBX, network=$(dind docker inspect -f '{{.HostConfig.NetworkMode}}' "$SBX")):"
dind docker exec "$SBX" bash -c "getent hosts jaeger || echo 'getent hosts jaeger: not found'; ip -4 addr 2>/dev/null | grep -c 'inet ' | sed 's/^/interfaces with an IPv4 address: /'; for u in http://jaeger:4318/v1/traces http://jaeger:16686/ http://$JIP:4318/v1/traces http://$JIP:16686/; do curl -s -o /dev/null -m 4 -w \"direct \$u -> HTTP %{http_code} (curl exit %{exitcode})\n\" \"\$u\"; done; for hp in jaeger:4318 jaeger:16686 $JIP:4318 $JIP:16686; do echo \"via egress proxy CONNECT \$hp -> \$(curl -s -o /dev/null -p -x http://127.0.0.1:3128 --noproxy '' -w '%{http_connect}' --max-time 4 https://\$hp/ 2>/dev/null)\"; done"
echo "--- pi's security-check with jaeger as the internal target (third invocation):"
dc exec -T sandboxd node --input-type=module - --internal jaeger:4318 --internal jaeger:16686 --internal "$JIP:4318" --internal "$JIP:16686" < "$W/noah-almighty/vendor/pi-gateway/scripts/security-check/run.mjs" > "$W/evidence/T3-security-report-jaeger.md" 2> "$W/evidence/T3-security-err-jaeger.txt"
echo "exit=$? $(cat "$W/evidence/T3-security-err-jaeger.txt")"; grep -E 'jaeger|'"$JIP" "$W/evidence/T3-security-report-jaeger.md" | cut -c1-330
