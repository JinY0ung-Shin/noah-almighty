FROM node:22-bookworm-slim AS base

# Optional corporate-mirror build args (empty = use upstream defaults).
# Pass them via docker compose build args or --build-arg.
# Example:
#   APT_MIRROR_HOST=mirror.example.internal/repository/proxy-apt-deb.debian.org
#   NPM_CONFIG_REGISTRY=http://mirror.example.internal/repository/proxy-npm-registry.npmjs.org/
ARG APT_MIRROR_HOST=
ARG NPM_CONFIG_REGISTRY=

# No openssh-client: remote SSH goes through the hex-ssh MCP server, which is
# ssh2-based (pure JS) and needs no system `ssh` binary. python3-cryptography /
# python3-paramiko back app-managed SSH key generation + known_hosts
# registration (the image has no ssh-keygen/ssh-keyscan); installed via apt to
# avoid PEP 668 pip restrictions on Debian and to resolve through the apt mirror.
#
# libreoffice-impress + poppler-utils back the server's APPROXIMATE document
# previews (share_file): soffice --headless converts pptx/docx/xlsx->pdf, then
# pdftoppm renders pdf->png, with fonts-nanum supplying Korean fonts so Hangul
# renders in headless conversions. fontconfig's fc-cache registers the deck fonts
# below. git backs every server-side repository operation, gh the create_repo tool.
#
# No agent runs in this container any more: every turn runs on pi-gateway, whose
# per-user sandboxes (docker/pi-sandbox) carry the agent's shell toolchain —
# Chromium + the pinned Python set for decks, uv, ripgrep. So none of that is here.
#
# Build speed: apt and npm downloads go through BuildKit cache mounts
# (RUN --mount=type=cache), so a rebuilt layer reuses the packages fetched last
# time instead of pulling them through the mirror again. Mounted dirs never land
# in the image. No `# syntax=` line on purpose: it would make BuildKit pull the
# dockerfile frontend from Docker Hub, which a closed network cannot reach — the
# built-in frontend (Docker 23+) supports --mount and COPY --exclude.
# Each apt RUN parks the base image's docker-clean (which deletes downloaded .debs)
# for its own duration so the .debs stay in the cache mount, then restores it, so
# images built FROM this one (docker/egress/app.Dockerfile) keep the stock behaviour.
COPY docker/apt_mirror_sources.sh /usr/local/bin/apt_mirror_sources.sh
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  mv /etc/apt/apt.conf.d/docker-clean /etc/apt/docker-clean.parked \
  && sh /usr/local/bin/apt_mirror_sources.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    fontconfig \
    fonts-nanum \
    git \
    gh \
    libreoffice-impress \
    poppler-utils \
    python3 \
    python3-cryptography \
    python3-paramiko \
    tini \
  && mv /etc/apt/docker-clean.parked /etc/apt/apt.conf.d/docker-clean \
  && rm -f /usr/local/bin/apt_mirror_sources.sh \
  && soffice --version \
  && command -v pdftoppm fc-cache \
  && python3 -c "import cryptography, paramiko"

# Trust an optional corporate proxy CA so git/curl/node can clone over HTTPS
# through an intercepting proxy. Folding it into the system bundle covers git
# (libcurl), curl, and node, so no per-tool env is needed.
#
# CA_CERT_FILE is the path (relative to the build context) of the cert to trust.
# Override it at build time to point at your own CA:
#   docker build --build-arg CA_CERT_FILE=docker/tls-fullchain.crt .
# or in compose via the `args:` block. It must resolve to a file inside the
# build context (Docker COPY can't read paths outside it). The default is a
# placeholder so builds that do not need a custom CA still work.
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
RUN if grep -q "BEGIN CERTIFICATE" /tmp/extra-ca.crt; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/extra-proxy-ca.crt; \
      update-ca-certificates; \
    else \
      echo "No extra CA certificate configured; skipping trust-store update."; \
    fi \
  && rm -f /tmp/extra-ca.crt

WORKDIR /app

# Install the hex-ssh MCP server (remote-server access tools) into the IMAGE at
# build time, so the avatar never has to `npx`-download it at runtime — that
# fails on a closed corporate network where the public npm registry is
# unreachable. The build-time mirror (NPM_CONFIG_REGISTRY) IS reachable, so we
# install through it here, then expose the package's bin under the fixed name
# `hex-ssh-mcp` (the actual bin key in package.json is resolved at build time, so
# Noah's hex-ssh relay can spawn a stable command). Kept in its own layer, BEFORE the app's
# package.json, so a dependency change does not re-download it and an upstream
# version bump only rebuilds this step. Pinned for reproducibility.
ARG HEX_SSH_MCP_VERSION=1.9.2
RUN --mount=type=cache,target=/root/.npm \
  if [ -n "$NPM_CONFIG_REGISTRY" ]; then \
      printf 'registry=%s\nstrict-ssl=false\n' "$NPM_CONFIG_REGISTRY" > /root/.npmrc; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install -g "@levnikolaevich/hex-ssh-mcp@${HEX_SSH_MCP_VERSION}"; \
    else \
      npm install -g "@levnikolaevich/hex-ssh-mcp@${HEX_SSH_MCP_VERSION}"; \
    fi \
  && rm -f /root/.npmrc \
  && PKG_DIR="$(npm root -g)/@levnikolaevich/hex-ssh-mcp" \
  && BIN_REL="$(node -e "const b=require('$PKG_DIR/package.json').bin; process.stdout.write(typeof b==='string'?b:Object.values(b)[0])")" \
  # Point the fixed name `hex-ssh-mcp` at the package's real bin. Use `ln -sf`
  # (which replaces the link itself), NOT `> file` — npm's global install already
  # created a /usr/local/bin symlink for this bin, and a `>` redirect would
  # follow it and clobber the package's own server file. The bin's own shebang
  # (#!/usr/bin/env node) makes it directly executable, so no wrapper is needed.
  && ln -sf "$PKG_DIR/$BIN_REL" /usr/local/bin/hex-ssh-mcp \
  && test -f "$PKG_DIR/$BIN_REL" \
  && echo "hex-ssh-mcp -> $PKG_DIR/$BIN_REL"

# Always use npm install (not npm ci) so the build doesn't fail when the lock
# file drifts out of sync with package.json, and so a corporate mirror can
# resolve slightly different dependency versions than the lock file expects.
# When a custom NPM_CONFIG_REGISTRY is provided we also set strict-ssl=false
# for HTTP mirrors with self-signed certs and NODE_TLS_REJECT_UNAUTHORIZED=0
# for node-gyp header downloads. The npm cache (tarballs + prebuilt native
# binaries) and node-gyp's header cache are BuildKit cache mounts, so a
# dependency change re-fetches only what changed and none of it bloats the layer.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/node-gyp \
  if [ -n "$NPM_CONFIG_REGISTRY" ]; then \
      printf 'registry=%s\nstrict-ssl=false\n' "$NPM_CONFIG_REGISTRY" > .npmrc; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install; \
    else \
      npm install; \
    fi \
  && rm -f .npmrc

# The pptx skill's vendored OFL fonts, registered with fontconfig for LibreOffice's
# approximate previews of decks edited after conversion
# (docker/fontconfig/60-noah-deck-fonts.conf: Pretendard, Gothic A1, Selawik — never the
# NotoSansKR variable font — plus a 맑은 고딕/Malgun Gothic alias). The decks themselves are
# built inside the user's pi sandbox. This layer depends only on the pptx skill tree and the
# fontconfig file, so it sits BEFORE the app COPY: an ordinary code change reuses it. The
# final `COPY . .` excludes default-skills/skills/pptx so the tree is not duplicated into a
# second layer (read-only at runtime; Noah copies it into each sandbox).
COPY docker/fontconfig/60-noah-deck-fonts.conf /etc/fonts/conf.d/
COPY default-skills/skills/pptx ./default-skills/skills/pptx
RUN fc-cache -f >/dev/null && fc-list | grep -q Pretendard

# The pptx skill tree is already in place (font layer above).
COPY --exclude=default-skills/skills/pptx . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=48787
ENV APP_DATA_DIR=/app/data
EXPOSE 48787

# Probe http first, then https with -k: the app serves exactly ONE of the two
# (TLS_CERT_FILE/TLS_KEY_FILE), and in https mode the cert names the deploy
# host — not localhost — so chain verification can't be part of the probe.
# Exec form behind `env -u`: Docker starts the probe with the container's full
# environment, so the server-only secret is dropped before the shell and curl
# start — the probe processes are readable to the node uid (#71).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["env", "-u", "SESSION_SECRET", "sh", "-c", \
    "curl -f --noproxy '*' \"http://localhost:${PORT:-48787}/api/bootstrap\" || curl -fk --noproxy '*' \"https://localhost:${PORT:-48787}/api/bootstrap\" || exit 1"]

# Drop root privileges: the node:22 base image ships a `node` user (uid 1000).
# The `node` user only ever WRITES under APP_DATA_DIR (default /app/data): the
# SQLite DB, avatar images, chat media, per-conversation
# workspaces, ssh known_hosts, and any cloned repos. The rest of /app (dist,
# node_modules, default-skills) is read-only at runtime, so we only
# chown the data dir — `chown -R /app` would needlessly re-stamp tens of
# thousands of node_modules files and duplicate them into a new image layer.
# HOME-based tool caches (gh/git/python, LibreOffice profiles) land under /home/node,
# which the base image already owns as node:node.
#
# APP_DATA_DIR is typically a named volume mounted at runtime. The directory is
# created here so the volume mount point has the right owner even before a
# volume is attached.
RUN mkdir -p /app/data && chown node:node /app/data

# node and tini are EXECUTE-ONLY (#71): a process whose executable its uid
# cannot read is marked non-dumpable by the kernel, so its /proc/<pid>/environ
# and memory are unreadable to every other process the server starts (hex-ssh,
# relayed MCP servers, git, LibreOffice) — they run as the same `node` uid. Executing them is unaffected; only reading the
# file is denied. tini matters because PID 1 holds the container's FULL
# environment (SESSION_SECRET included): it is this image's ENTRYPOINT instead
# of compose `init: true`, whose docker-init binary is readable. The server
# also drops its server-only secrets from process.env at boot
# (scrubServerOnlySecretEnv), so the processes it starts never inherit them.
RUN chmod 0711 /usr/local/bin/node /usr/bin/tini

USER node

# tini reaps zombies and forwards signals (graceful shutdown). It is started by
# the node image's docker-entrypoint.sh (`exec "$@"`), NOT directly by the
# container runtime: only an exec from an already-unprivileged process applies
# the execute-only protection above (verified — a runtime-started tini as PID 1
# kept a readable environment).
ENTRYPOINT ["docker-entrypoint.sh", "/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
