# 전체 아바타의 서버 외부 통신 차단

`docker-compose.egress.yml`은 기존 Compose에 추가하는 선택적 배포 구성입니다.
모든 로컬 아바타·그룹 에이전트·예약 작업·서버 MCP·Bash/curl/Python에
같은 정책을 적용합니다. 사용자 PC의 브라우저 도구는 변경하지 않습니다.
관리자 → 가입·접근 → 외부 통신 차단에서 공통 목록을 관리합니다.
아바타별 정책은 제공하지 않습니다.

## 관리자 화면 사용

1. 시스템 관리자 계정으로 로그인하고 **관리자 → 가입·접근**을 엽니다.
2. **외부 통신 차단**에서 현재 적용된 목록과 서비스 상태를 확인합니다.
3. 도메인을 입력하고 **하위 도메인도 포함** 여부를 선택한 뒤 **목록에 추가**합니다.
   각 행의 **삭제**로 차단을 해제할 도메인을 제거할 수 있습니다.
4. **저장하고 적용**을 누릅니다. 성공 안내가 나타나야 실제 적용이 완료된 것입니다.
   입력만 하거나 목록에서 삭제만 한 상태는 아직 적용되지 않은 초안입니다.
5. 전체 삭제 후 적용하면 도메인 차단이 해제되지만, 직접 IP·DNS·SSH 연결 차단은 유지됩니다.

일반 사용자와 로그아웃한 세션은 조회·수정할 수 없습니다. 관리자가 다른 탭으로
이동해도 초안은 유지됩니다. 다른 관리자가 먼저 저장하면 덮어쓰기를 거부하고 최신
목록을 불러오도록 안내합니다. 적용 오류/통신 단절 시에는 초안을 보존하고 **현재 목록
불러오기**로 실제 상태를 다시 확인하게 합니다. 초안이 있으면 버리기 전에 확인합니다.
실패를 성공으로 표시하지 않습니다. 변경/적용 실패는 관리자 감사 로그에 남습니다.

목록은 최대 500개입니다. 대소문자·말미 점·`*.` 입력을 정규화하며 상위 도메인
규칙에 포함되는 중복 규칙을 합칩니다. 영문 ASCII/punycode 도메인을 사용합니다.
도메인 관리 화면에서 IP·URL 경로·임의 Squid 설정을 입력할 수 없습니다.
서비스가 배포되지 않은 환경에서는 설치가 필요하다는 안내가 나오고 저장 버튼은
표시되지 않습니다. 화면에서 방화벽 자체를 끄거나 관리 서비스 주소를 변경하지 않습니다.

## 동작과 범위

```text
Noah 서버/아바타 → TCP 3128 → Squid → 허용 도메인
관리자 화면 → Noah 관리자 API → TCP 3129 정책 서비스 → 목록 적용
                  그 외 직접 연결 / 외부 DNS → 차단
사용자 PC 브라우저 → 기존 네트워크 (이 정책의 적용 대상 아님)
```

컨테이너 진입점이 앱 실행 전에 네트워크 네임스페이스에 IPv4/IPv6 OUTPUT 규칙을
설정합니다. 실패하면 앱을 실행하지 않습니다. 이후 UID 1000(node)으로 전환하고
모든 capability의 effective/permitted/bounding/ambient 집합을 비우며
`no-new-privileges`를 설정합니다. 아바타가 환경변수를 지우거나 다른 HTTP 클라이언트를
실행해도 직접 접속은 열리지 않습니다. 컨테이너 재시작 때도 같은 순서를 거칩니다.
호스트의 방화벽 체인을 수정하지 않으므로 Docker의 DOCKER-USER와 containerd의 CNI
체인 차이에 의존하지 않습니다.

허용되는 연결은 프록시 IP의 TCP 3128/3129, 앱 자신의 loopback, 외부에서 들어온 연결의
응답입니다. DNS 53번은 차단하며 Docker의 내장 DNS 주소도 직접 접속할 수 없습니다.
목적지 이름은 Squid가 해석합니다. 앱의 기존 포트 공개와 건강 확인은 유지됩니다.
Squid와 정책 서비스 포트는 호스트에 공개하지 않습니다. 초기 설정 디렉터리는
프록시에만 읽기 전용으로 마운트합니다. 이 네트워크에는 신뢰할 수 없는 다른
컨테이너를 연결하지 마세요.

정책 서비스는 Noah 컨테이너 밖에서 Squid를 실행·종료하고 별도 볼륨에 목록을
저장합니다. 관리 API는 요청자의 로그인 세션만 전달하며, 서비스가 Noah의 고정된
인증 콜백으로 **매 요청마다 현재 관리자 권한**을 다시 확인합니다. 아바타 환경에
장기 관리 토큰이나 쓰기 가능한 정책 볼륨을 넣지 않습니다. 인증 콜백이 실패해도
이미 적용된 프록시는 유지되지만, 목록 조회·변경은 거부합니다.

저장은 목록 검증 → Squid 설정 검사 → 기존 프로세스/터널 종료 → 영속 저장 → 새
프로세스 기동 확인 순서로 수행합니다. 실패 시 이전 목록으로 복구를 시도합니다.
복구도 실패하면 외부 통신은 차단된 상태로 남고 서비스 오류가 표시됩니다.
목록 변경은 직렬화하며 revision으로 동시 수정 충돌을 확인합니다.

- HTTP URL과 HTTPS CONNECT의 목적지 **도메인**을 차단합니다. HTTPS 경로·쿼리는
  복호화하지 않으므로 `https://example.com/private`만 선택해서 차단하지는 않습니다.
- IP 주소를 직접 적은 프록시 요청도 거부합니다. 사내 HTTP API도 도메인으로 지정하세요.
- 기본 포트는 80/443이며 undici의 HTTP 요청도 CONNECT를 사용하므로 두 포트 모두
  터널을 허용합니다. 사내 서비스가 8080/8443 등을 사용하면
  `squid.conf`의 `safe_ports`와 필요한 경우 `tunnel_ports`를 운영자가 수정하고 이미지를
  다시 빌드해야 합니다. CONNECT에 임의 포트를 열면 SSH 등 터널 경로가 생깁니다.
- 모델 API, Git HTTPS, Confluence, 외부 아바타 게이트웨이 연결도 정책 대상입니다.
  대상 도메인을 차단 목록에 넣으면 관련 기능이 실패합니다.
- **직접 SSH/hex-ssh, 기타 TCP/UDP, 직접 내부 서비스 접속도 차단됩니다.**
  STT 모듈은 의도적으로 프록시를 사용하지 않으므로 현재 이 모드에서는 별도 호스트의
  STT 연결이 동작하지 않습니다. 이 구성은 직접 연결 예외를 제공하지 않습니다.
- Node의 기본 fetch에는 이미지의 undici preload를 적용합니다. 전용 연결 구현으로
  프록시를 무시하는 SDK/플러그인은 연결에 실패합니다. 주요 모델/API는 배포 후 점검하세요.
- 다른 서버에서 실행되는 외부 아바타나 원격 작업이 **그 서버에서 새로 보내는 요청**은
  이 정책으로 통제하지 못합니다.
- 도메인 차단 목록은 동일 서비스의 모든 별칭, 허용 사이트를 통한 중계, 허용된
  HTTPS 터널 내부의 프로토콜을 식별하지 못합니다. TLS 내부 검사는 하지 않습니다.
  그런 범위까지 통제하려면 허용 목록과 별도 게이트웨이 정책이 필요합니다.

## 최초 차단 목록과 인증 콜백 준비

배포 호스트에서 `docker/egress/policy`를 운영 전용 디렉터리에 복사하고
`NOAH_EGRESS_POLICY_DIR`를 그 절대 경로로 지정하는 것을 권장합니다.
두 파일은 프록시의 `proxy` 사용자에게 읽기 권한이 있어야 합니다.
아바타 작업 디렉터리, Git 작업 저장소, 앱 데이터 볼륨에는 이 디렉터리를 두지 마세요.

`blocked-domains.txt`는 **정책 볼륨이 비어 있는 최초 실행에만** 읽는 초기값입니다.
이후 관리자 화면에서 적용한 목록은 `noah-egress-policy` 볼륨의 `policy.json`에
보관하며 재시작·컨테이너 재생성 시 이 값이 우선합니다. 초기 파일을 바꿔도 관리자
목록을 덮어쓰지 않습니다. 실제 목록을 백업하려면 이 별도 볼륨도 백업하세요.

초기 `blocked-domains.txt` 예시:

```text
# apex와 모든 하위 도메인을 차단
.example.com
.upload.example.org
# 정확한 호스트만 차단
api.example.net
```

한 줄에 소문자 ASCII/punycode 도메인 하나를 적습니다. `https://`, 경로, 포트,
`*.example.com` 문법은 사용하지 않습니다. `.example.com`이 apex와 하위 도메인을
포함합니다. 기본 파일은 예약된 `.blocked.example`만 포함하며 실제 사이트를 차단하지
않습니다. 목록은 관리자 화면에만 표시하며 시스템 프롬프트에 포함하지 않습니다.

인증 콜백의 기본값은
`http://noah-almighty:${PORT:-48787}/api/admin/egress/authorize`입니다.
Noah를 자체 HTTPS 모드로 실행하거나 이름/포트를 다르게 운영하면 Compose 환경의
`NOAH_EGRESS_AUTH_URL`을 프록시에서 도달 가능한 Noah의 정확한 인증 콜백 URL로
지정하세요. HTTPS 인증서의 호스트 이름과 일치해야 하며 `CA_CERT_FILE` 빌드 인자로
프록시 이미지에도 사내 CA를 설치할 수 있습니다. 인증서 검증을 끄지 않습니다.
콜백은 리다이렉트와 HTTP_PROXY를 따르지 않으며 다른 호스트로 세션을 전달하지 않습니다.
`NOAH_EGRESS_AUTH_URL`은 세션을 받는 신뢰 대상이므로 배포 관리자만 변경해야 합니다.

사내 HTTP 프록시를 거쳐야 하는 환경에서는 같은 디렉터리의 `upstream.conf`를 편집합니다.

```squidconf
cache_peer proxy.corp.example parent 8080 0 no-query default
never_direct allow all
```

상위 프록시 주소를 앱의 예외 연결로 열지 않습니다. 앱은 항상 Squid만 거칩니다.
기존 `.env`의 HTTP_PROXY/HTTPS_PROXY/NO_PROXY/ALL_PROXY는 진입점에서 덮어씁니다.
기존 `NODE_OPTIONS`도 전용 preload로 대체합니다. 추가 Node 옵션이 필요하면 신뢰된
이미지의 진입점을 수정하세요. 프록시가 TLS를 검사하는 사내 환경은 기존 Noah 이미지의
CA 빌드 옵션을 계속 사용합니다. 표준 HTTP CONNECT parent 자체에는 TLS 복호화가 없습니다.

## Docker 배포

저장소 루트에서 실행합니다. **기존 배포의 Compose 프로젝트 이름을 그대로 유지**하세요.
프로젝트 이름이 바뀌면 다른 데이터 볼륨을 만들어 빈 시스템처럼 보일 수 있습니다.
`SESSION_SECRET`, 데이터 볼륨, 앱 포트와 TLS 마운트는 기존 구성을 유지합니다.

```sh
# 기존 배포에서 사용하는 프로젝트 이름으로 설정
export COMPOSE_PROJECT_NAME=avatar-chat
export NOAH_EGRESS_POLICY_DIR=/srv/noah-egress-policy

# 일반 이미지 먼저 빌드. 기존 사내 미러/CA 빌드 인자를 그대로 사용합니다.
docker compose -f docker-compose.yml build noah-almighty
docker tag "${COMPOSE_PROJECT_NAME}-noah-almighty" noah-almighty:egress-base

docker compose -f docker-compose.yml -f docker-compose.egress.yml build
docker compose -f docker-compose.yml -f docker-compose.egress.yml config --quiet
# 구문 오류/권한 오류가 있으면 여기서 멈추고 수정합니다.
docker compose -f docker-compose.yml -f docker-compose.egress.yml run --rm --no-deps egress-proxy python3 /usr/local/lib/noah-egress-controller.py --check
docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d
```

`172.30.247.0/24`가 호스트/사내 대역과 겹치면 배포 전에 `NOAH_EGRESS_SUBNET`과
`NOAH_EGRESS_PROXY_IP`를 함께 변경하세요. 프록시 IP는 해당 서브넷의 사용 가능한
고정 IPv4여야 합니다. 환경변수는 Compose를 실행하는 셸 또는 배포용 `.env`에 둡니다.
이미 운영 중인 Compose 네트워크의 서브넷은 `up`만으로 바뀌지 않을 수 있습니다.
그 경우 작업을 중지한 유지보수 시간에 기존 `compose down` 후 위 `up`을 실행합니다.
**`down -v`는 데이터 삭제이므로 사용하지 않습니다.**

폐쇄망에서는 연결 가능한 빌드 머신에서 두 최종 이미지를 만들고 `docker save` /
배포 호스트의 `docker load`로 옮깁니다. 앱 이미지의 소스·미러·CA가 현재 배포와
일치해야 합니다. 가져온 이미지로는 `up -d --no-build`를 사용하세요.

## containerd / nerdctl

Linux의 **rootful containerd + nerdctl + CNI**를 대상으로 합니다. rootless,
host network, privileged, Kubernetes Pod 배포는 이 Compose 구성의 지원 대상이
아닙니다. rootless/커널 제한으로 iptables 또는 ip6tables 초기화가 실패하면
차단 없이 실행하는 대신 앱이 시작되지 않습니다.

동일한 두 이미지를 containerd 네임스페이스에 빌드하거나 로드한 뒤 사용합니다.
빌드에는 BuildKit이 필요합니다. 운영 환경의 nerdctl 버전에서 `cap_add`, `cap_drop`,
`security_opt`, 고정 IPv4, Compose merge가 적용되는지 아래 테스트로 확인하세요.

```sh
nerdctl build -t noah-almighty:egress-base .
nerdctl compose -f docker-compose.yml -f docker-compose.egress.yml build
nerdctl compose -f docker-compose.yml -f docker-compose.egress.yml config
nerdctl compose -f docker-compose.yml -f docker-compose.egress.yml run --rm --no-deps egress-proxy python3 /usr/local/lib/noah-egress-controller.py --check
nerdctl compose -f docker-compose.yml -f docker-compose.egress.yml up -d
```

실행 시 일관된 containerd namespace와 Compose 프로젝트 이름을 사용합니다.
기존 Docker named volume이 containerd로 자동 이전되지는 않습니다. 런타임 이전이
필요한 경우 기존 DB/파일 볼륨 이관을 별도로 수행해야 합니다.

## 검증

실제 커널 방화벽과 Squid를 검증하는 독립 테스트가 있습니다. 배포 데이터나 외부 인터넷
없이 임시 네트워크와 fixture 컨테이너만 사용하고 종료 때 제거합니다. 테스트 대역
`172.30.246.0/24`, `fd00:30:246::/64`가 사용 중이면 스크립트의 테스트 대역을 변경하세요.

```sh
python3 scripts/test-egress.py
# containerd 호스트에서 동일 검증
python3 scripts/test-egress.py --runtime nerdctl
# 관리자 권한/롤백 회귀 테스트 (컨테이너 없이 실행)
python3 tests/egress_controller_test.py
npx vitest run tests/egress-admin.test.ts tests/svelte-admin-egress.test.ts
```

검증 대상: 허용 HTTP/CONNECT, 차단 도메인/apex/하위 도메인/대소문자/말미 점,
IP 리터럴, 리다이렉트, curl의 프록시 해제, Node fetch 프록시 사용, 직접 IPv4/IPv6,
외부/내장 DNS, loopback, 권한 제거, 재시작, 프록시 장애와 초기화 실패 시 차단 유지,
관리자 세션 확인/거부, 적용 후 실제 차단, 기존 터널 종료, 동시 변경 충돌,
전체 해제, 재시작 후 목록 보존. Python 단위 테스트는 기동 실패 시 영속 목록과
revision의 롤백도 검증합니다.
HTTPS CONNECT 터널 테스트는 터널 안에 HTTP fixture 바이트를 보내는 방식이며
공개 사이트의 TLS 인증서/사내 CA 검증을 대신하지 않습니다.

배포 후에는 실제 허용 모델 API로 대화 한 번, 허용 Git HTTPS 조회, Confluence 조회,
앱 건강 확인 및 브라우저 도구를 점검합니다. 차단 테스트는 운영 목록의 도메인으로
수행합니다. proxy 로그에는 메서드·목적지 도메인·상태가 남고 경로/쿼리는 기록하지 않습니다.
로그는 `compose logs egress-proxy`로 확인합니다. `TCP_DENIED/403`과 단순 연결 실패를
구분하세요. `describe_system`과 시스템 프롬프트에는 bootstrap의 적용 보고와 범위가
표시되지만, 실시간 방화벽 감사 또는 현재 목록 조회 기능은 아닙니다.

## API와 운영 변경

관리 화면은 로그인 세션으로 아래 API를 호출합니다. 개인 아바타 API 키로는 호출할
수 없습니다. 아바타/MCP에 정책 수정 도구를 제공하지 않습니다.

```text
GET /api/admin/egress
→ configured, proxyReady, domains, revision, appliedAt, appliedBy

PUT /api/admin/egress
Content-Type: application/json
X-Noah-Egress-Admin: 1
{ "domains": [".example.com"], "revision": "조회에서 받은 revision" }
→ 실제 적용된 목록/새 revision (성공 시)

GET /api/admin/egress/authorize
→ { "actorId": "현재 관리자 ID" } (정책 서비스의 권한 확인 전용)
```

컨트롤러는 사용자 입력 주소로 접속하지 않습니다. 앱의 `NOAH_EGRESS_CONTROL_URL`은
진입점에서 고정 프록시 IP의 3129번으로 설정됩니다. HTTP(S)만 허용하며 리다이렉트는
따르지 않습니다. API의 409는 다른 관리자의 변경, 401/403은 인증·권한, 503은 설치/
연결/결과 확인 문제입니다. 상태가 불확실하면 GET으로 확인하고 다시 적용하세요.

`upstream.conf`나 Squid 포트 규칙은 여전히 배포 설정입니다. 운영자가 변경한 뒤
프록시 컨테이너를 재시작합니다. 관리자 목록 변경은 화면의 저장·적용만으로 완료되며
수동 재시작이 필요하지 않습니다. 새 정책 적용은 이미 열린 터널까지 종료하므로
진행 중인 요청이 실패할 수 있습니다.

## 정책 해제와 복구

도메인 차단만 해제하려면 관리자 화면에서 목록을 모두 삭제하고 적용합니다.
프록시만 중지하면 앱은 직접 접속으로 전환하지 않고 외부 통신에 실패합니다.
정책을 해제하려면 같은 프로젝트 이름으로 기본 Compose의 일반 이미지를 재배포합니다.
네트워크 설정을 되돌려야 할 때는 유지보수 시간에 전체 stack을 내린 후 다시 올립니다.

```sh
docker compose -f docker-compose.yml -f docker-compose.egress.yml down
docker compose -f docker-compose.yml up -d --build
```

이때도 `-v`는 사용하지 않습니다. `noah-egress-policy` 볼륨도 보존되므로 나중에
차단 모드를 다시 켜면 이전 관리자 목록을 이어서 사용합니다. 호스트 방화벽은 이
기능이 수정하지 않으므로 별도
호스트 규칙 복원은 필요 없습니다. 배포 관리자만 컨테이너 실행 옵션, 이미지,
정책 파일을 수정할 수 있어야 합니다.

참고: [nerdctl Compose 지원](https://github.com/containerd/nerdctl/blob/main/docs/compose.md),
[Squid ACL](https://www.squid-cache.org/Doc/config/acl/).
