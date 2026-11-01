# Noah's deck-capable pi-gateway sandbox image.
#
# A DERIVED image of pi-gateway's sandbox (~/pi-gateway/docs/OPERATIONS.md §5 "sandbox에 도구 추가하기"):
# it adds exactly the agent-facing toolchain the bundled `pptx` skill's HTML→editable-PPTX converter
# needs, mirroring the main Noah Dockerfile's deck layers (docs/architecture/pptx-converter.md "Docker
# packaging"), so `bash <skill>/scripts/deck.sh check|build|probe` runs INSIDE a pi sandbox:
#   Chromium headless shell + fontconfig, playwright-core (the same pin as package.json), the pinned
#   Python set (converter/requirements.txt), the vendored deck fonts + fonts-nanum, poppler-utils
#   (pdftotext/pdftoppm), uv/uvx, an optional corporate CA, and the build-time self-test record the
#   converter's probe reports. LibreOffice is NOT here: its approximate previews stay on the Noah side.
#
# The skill tree itself is NOT baked in — Noah supplies it at runtime (docker/pi-sandbox/README.md). Build
# from the Noah repository root (the ignore file next to this Dockerfile trims the context):
#
#   docker build -f docker/pi-sandbox/Dockerfile -t noahpi/sandbox:e2e .
#
# The sandbox runs with NO network, a read-only rootfs, /tmp = 256 MiB tmpfs, 1 GiB memory, 1 CPU and
# 256 pids (sandboxd's spec.ts), so everything is baked here; nothing is downloaded at runtime.
# Rules of a derived image (pi-gateway OPERATIONS.md §5): final USER 1000:1000; sbx-run, sbx-fs,
# sbx-proxy-bridge and /usr/local/lib/pi-sbx untouched; no setuid/setgid bits; no secrets.
#
# No `# syntax=` line on purpose (same reason as the main Dockerfile: a closed network cannot pull the
# frontend); the built-in BuildKit frontend supports RUN --mount.

ARG SANDBOX_BASE_IMAGE=pi-gateway/sandbox:latest
FROM ${SANDBOX_BASE_IMAGE}

USER root

# Optional mirrors (empty = upstream). apt follows whatever the BASE image's debian.sources was built
# with (pi-gateway's APT_MIRROR_URL build args); these cover the PyPI and npm installs below.
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
ARG NPM_CONFIG_REGISTRY=

# Trust an optional corporate proxy CA (same contract as the main Dockerfile's CA_CERT_FILE): folded
# into the system bundle so git/curl (and pip/npm at build time) work through an intercepting proxy.
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
RUN if grep -q "BEGIN CERTIFICATE" /tmp/extra-ca.crt; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/extra-proxy-ca.crt; \
      update-ca-certificates; \
    else \
      echo "No extra CA certificate configured; skipping trust-store update."; \
    fi \
  && rm -f /tmp/extra-ca.crt

# Chromium headless shell (driven at /usr/lib/chromium/chromium-headless-shell, bypassing Debian's
# /usr/bin wrapper), fontconfig (fc-cache), fonts-nanum (Hangul fallback), poppler-utils (pdftotext /
# pdftoppm). The base is Debian trixie (python:3.12-slim-trixie), so this is trixie's Chromium: golden
# drift against the bookworm-built goldens is RECORDED by the self-test below, never fatal by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium-headless-shell \
       fontconfig \
       fonts-nanum \
       poppler-utils \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* \
  && /usr/lib/chromium/chromium-headless-shell --version \
  && command -v fc-cache pdftotext pdftoppm

# uv/uvx — the same pinned prebuilt release binary as the main Dockerfile.
ARG TARGETARCH
ARG UV_VERSION=0.8.17
RUN case "$TARGETARCH" in \
      amd64|"") UV_TARGET=x86_64-unknown-linux-musl ;; \
      arm64)    UV_TARGET=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz" \
       | tar -xz -C /usr/local/bin --strip-components=1 "uv-${UV_TARGET}/uv" "uv-${UV_TARGET}/uvx" \
  && chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx \
  && uv --version && uvx --version

# The converter's pinned Python set, into the base image's /usr/local Python 3.12 (system site-packages,
# root-owned; no PEP 668 marker on the python image). pip byte-compiles at install, so the read-only
# rootfs never needs a __pycache__ write. The mirror must carry every pin for CPython 3.12.
COPY default-skills/skills/pptx/converter/requirements.txt /tmp/deck-requirements.txt
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip3 install --no-cache-dir --root-user-action=ignore --index-url "$PIP_INDEX_URL" ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} -r /tmp/deck-requirements.txt; \
    else \
      pip3 install --no-cache-dir --root-user-action=ignore -r /tmp/deck-requirements.txt; \
    fi \
  && rm -f /tmp/deck-requirements.txt \
  && python3 -c "import pptx, lxml, PIL, fontTools, defusedxml, openpyxl, xlsxwriter"

# playwright-core, the SAME pin as Noah's package.json (tests/pi-sandbox-image.test.ts keeps them equal).
# The converter resolves it with createRequire(import.meta.url) from the skill's own directory. The skill
# lives OUTSIDE any node_modules tree here (under /workspace or /opt/plugins), so it is found through
# Node's GLOBAL folders instead: /usr/local/lib/node_modules is on the base image's NODE_PATH, and the
# /usr/local/lib/node link is Node's built-in global folder (<prefix>/lib/node), which still resolves when
# a caller drops NODE_PATH from the environment. No deck.sh change is needed. Playwright never downloads a
# browser. --prefix overrides the base image's NPM_CONFIG_PREFIX (/workspace/.home/.npm-global).
ARG PLAYWRIGHT_CORE_VERSION=1.61.1
RUN NPM_CONFIG_CACHE=/tmp/npm-cache npm install -g --prefix /usr/local --no-fund --no-audit \
      "playwright-core@${PLAYWRIGHT_CORE_VERSION}" \
  && rm -rf /tmp/npm-cache /root/.npm \
  && mkdir -p /usr/local/lib/node \
  && ln -s ../node_modules/playwright-core /usr/local/lib/node/playwright-core \
  && cd / && env -u NODE_PATH node -e "process.stdout.write(require('playwright-core/package.json').version + '\n')" \
       | grep -qx "${PLAYWRIGHT_CORE_VERSION}"

# The vendored deck fonts, registered with fontconfig exactly like the main image (same faces, same
# 맑은 고딕 aliases; NotoSansKR-VF is not copied, the main image's conf rejects it). The converter itself
# loads its fonts KIT-relative through @font-face from the runtime skill copy.
COPY default-skills/skills/pptx/converter/fonts/Pretendard-Regular.ttf \
     default-skills/skills/pptx/converter/fonts/Pretendard-SemiBold.ttf \
     default-skills/skills/pptx/converter/fonts/Pretendard-Bold.ttf \
     default-skills/skills/pptx/converter/fonts/Pretendard-ExtraBold.ttf \
     default-skills/skills/pptx/converter/fonts/Pretendard-OFL.txt \
     default-skills/skills/pptx/converter/fonts/GothicA1-Regular.ttf \
     default-skills/skills/pptx/converter/fonts/GothicA1-Bold.ttf \
     default-skills/skills/pptx/converter/fonts/GothicA1-OFL.txt \
     default-skills/skills/pptx/converter/fonts/selawk.ttf \
     default-skills/skills/pptx/converter/fonts/selawkb.ttf \
     default-skills/skills/pptx/converter/fonts/Selawik-OFL.txt \
     default-skills/skills/pptx/converter/fonts/README.md \
     /usr/local/share/fonts/noah-deck/
COPY docker/pi-sandbox/60-noah-deck-fonts.conf /etc/fonts/conf.d/
RUN fc-cache -f >/dev/null && fc-list | grep -q Pretendard && fc-list | grep -qi nanum

# The build-time self-test, run from a READ-ONLY bind mount of the skill tree (nothing of it lands in the
# image), as root with TMPDIR/HOME = a throwaway dir removed in the same RUN, exactly like the main
# Dockerfile. It writes the record `deck.sh probe` reads at its default path, so the probe needs no env.
# DECK_CONVERTER_STRICT_GOLDEN=1 turns golden drift into a build failure.
ARG DECK_CONVERTER_STRICT_GOLDEN=0
RUN --mount=type=bind,source=default-skills/skills/pptx,target=/mnt/noah-pptx-skill \
  mkdir -p /usr/local/share/noah-almighty \
  && T="$(mktemp -d)" \
  && { TMPDIR="$T" HOME="$T" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 \
         node /mnt/noah-pptx-skill/converter/tools/deck.mjs selftest \
           --record /usr/local/share/noah-almighty/deck-selftest.json \
           $( [ "$DECK_CONVERTER_STRICT_GOLDEN" = "1" ] && echo --fail-on-drift ); rc=$?; } \
  ; rm -rf "$T"; [ "$rc" -eq 0 ] \
  && cat /usr/local/share/noah-almighty/deck-selftest.json \
  && ! ls -A /tmp | grep -Eq '^(noah-pptx|playwright|deck-)'

# Hygiene for a read-only, unprivileged runtime: no setuid/setgid bits (the derived-image rule; also
# covers anything apt brought in), nothing left in /tmp or root's caches, the pi-sbx helpers untouched.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
  && rm -rf /root/.cache /root/.npm /tmp/* /var/tmp/* \
  && test -x /usr/local/bin/sbx-run && test -x /usr/local/bin/sbx-proxy-bridge \
  && test -x /usr/local/bin/sbx-fs && test -f /usr/local/lib/pi-sbx/sbx_fs.py

# One conversion at a time PER SANDBOX. The converter's slots are abstract UNIX sockets, i.e. per network
# namespace, and every pi sandbox has its own (network none) — so the main image's host-wide default of 2
# becomes "2 per user" here. Two at once measured 781 MiB of the 1 GiB limit and 202 of the 256 pids
# (README "Measured"), too little headroom for the agent's own commands; a second build waits for the slot
# (NOAH_PPTX_SLOT_WAIT_SECONDS, default 150 s) instead. `deck.sh probe` reports the value.
ARG DECK_MAX_CONCURRENT=1
ENV NOAH_PPTX_MAX_CONCURRENT=${DECK_MAX_CONCURRENT}

USER 1000:1000
WORKDIR /workspace
CMD ["/usr/local/bin/sbx-proxy-bridge"]
