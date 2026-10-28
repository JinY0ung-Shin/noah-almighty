# craft-runner — runs ArtCraft "Craft" app CLIs as headless MCP servers for Noah (see README.md).
#
# Build context is the REPOSITORY ROOT (docker-compose.yml: context: ., dockerfile: craft-runner/Dockerfile)
# so the image reuses the main service's corporate apt mirror script and proxy-CA handling verbatim.
#   docker build -f craft-runner/Dockerfile -t noah-craft-runner .
#
# Supply-chain rules (README.md › Security model):
#   - Every app is pinned to an exact version AND the sha256 of its release archive, written HERE. The
#     release's own SHA256SUMS.txt must agree with the pin, but it is never trusted on its own.
#   - The build stage has network access, so it only DOWNLOADS, VERIFIES and EXTRACTS. The downloaded
#     binary is NEVER executed during the build (no --version, no ldd, no smoke run). It first runs inside
#     the network-none runner container, where the boot self-test checks it before it is served.
#   - Only the `*-cli` binary is copied into the final image (no GUI binary, desktop files or updater).

# ---------------------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS fetch

ARG APT_MIRROR_HOST=
COPY docker/apt_mirror_sources.sh /usr/local/bin/apt_mirror_sources.sh
RUN sh /usr/local/bin/apt_mirror_sources.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/local/bin/apt_mirror_sources.sh

# Optional corporate proxy CA (same contract as the main Dockerfile's CA_CERT_FILE).
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
RUN if grep -q "BEGIN CERTIFICATE" /tmp/extra-ca.crt; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/extra-proxy-ca.crt; \
      update-ca-certificates; \
    else \
      echo "No extra CA certificate configured; skipping trust-store update."; \
    fi \
  && rm -f /tmp/extra-ca.crt

# Release host. A mirror is safe to use: the sha256 pin below is checked regardless of origin.
ARG CRAFT_RELEASE_BASE=https://github.com/storytold
ARG TARGETARCH

# === PhotoCraft =====================================================================================
# Bump: set the version, copy the linux-x86_64.tar.gz line's hash from that release's SHA256SUMS.txt,
# then re-verify craft-runner/src/apps.mjs (expectedTools, deniedCommands, clamps) — README.md.
ARG PHOTOCRAFT_VERSION=0.16.0
ARG PHOTOCRAFT_SHA256=7c17f3633ebf7dabf27628e2d2637d918c7c2a5b163b8b90347a78acddf63608
WORKDIR /dl/photocraft
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in amd64) ;; *) echo "craft-runner: only linux/amd64 builds are published" >&2; exit 1 ;; esac; \
    v="${PHOTOCRAFT_VERSION}"; a="photocraft-${v}-linux-x86_64.tar.gz"; m="photocraft-${v}-linux-x86_64/bin/photocraft-cli"; \
    curl -fsSL --proto '=https' -o "${a}" "${CRAFT_RELEASE_BASE}/photocraft/releases/download/v${v}/${a}"; \
    curl -fsSL --proto '=https' -o SHA256SUMS.txt "${CRAFT_RELEASE_BASE}/photocraft/releases/download/v${v}/SHA256SUMS.txt"; \
    echo "${PHOTOCRAFT_SHA256}  ${a}" | sha256sum -c -; \
    grep -qx "${PHOTOCRAFT_SHA256}  ${a}" SHA256SUMS.txt; \
    mkdir x; \
    tar -xzf "${a}" -C x --no-same-owner --no-same-permissions "${m}"; \
    test -f "x/${m}"; test ! -L "x/${m}"; \
    install -D -m 0755 "x/${m}" /out/bin/photocraft-cli; \
    rm -rf x "${a}"

# ---------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim

ARG APT_MIRROR_HOST=
COPY docker/apt_mirror_sources.sh /usr/local/bin/apt_mirror_sources.sh
# fontconfig + Nanum (Hangul) for text layers; the cache is built now because the rootfs is read-only
# at runtime (children get a per-session XDG_CACHE_HOME for anything new).
RUN sh /usr/local/bin/apt_mirror_sources.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-nanum \
  && fc-cache -f \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /usr/local/bin/apt_mirror_sources.sh

ARG PHOTOCRAFT_VERSION=0.16.0
LABEL org.noah-almighty.component="craft-runner" \
      org.noah-almighty.photocraft.version="${PHOTOCRAFT_VERSION}"

COPY --from=fetch /out/bin/ /opt/craft/bin/
COPY craft-runner/src/ /opt/craft-runner/src/

ENV NODE_ENV=production \
    CRAFT_EXCHANGE_ROOT=/exchange \
    CRAFT_TMP_ROOT=/tmp/craft

# Root inside the container, but compose drops every capability except
# SETUID SETGID CHOWN FOWNER DAC_OVERRIDE KILL and sets no-new-privileges; app children run as
# per-session uids with no capabilities at all.
USER root
WORKDIR /opt/craft-runner
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "process.exit(require('fs').statSync('/exchange/sock/mcp.sock').isSocket() ? 0 : 1)"]
ENTRYPOINT ["node", "/opt/craft-runner/src/daemon.mjs"]
