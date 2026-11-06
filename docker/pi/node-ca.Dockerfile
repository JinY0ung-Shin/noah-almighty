# Build-only: pi-gateway's Node base image plus Noah's corporate CA (CA_CERT_FILE) for Node, so pi's
# gateway / sandboxd / mcp-broker builds (`npm ci`) verify an HTTPS npm mirror behind an intercepting
# proxy (#77). docker/pi/compose.override.yml hands this image to pi's Dockerfile through its own
# NODE_IMAGE build arg, so pi's Dockerfile and compose file stay untouched.
#
# Node never reads the system trust store, so NODE_EXTRA_CA_CERTS points at a file of Node's own roots
# plus CA_CERT_FILE (docker/pi/node-ca-bundle.cjs). It is inherited by pi's runtime images: the gateway
# and the broker override it from pi's compose (their own NODE_EXTRA_CA_CERTS mount, or empty = unset),
# and for sandboxd it only re-adds roots it already trusts plus the operator's CA.
#
# NODE_BASE_IMAGE must stay the NODE_IMAGE default of the pinned pi Dockerfile
# (vendor/pi-gateway/Dockerfile) — tests/docker-extra-ca.test.ts fails when a pi bump moves it.
ARG NODE_BASE_IMAGE=node:22-bookworm-slim
FROM ${NODE_BASE_IMAGE}
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
COPY docker/pi/node-ca-bundle.cjs /tmp/node-ca-bundle.cjs
RUN node /tmp/node-ca-bundle.cjs /tmp/extra-ca.crt /etc/noah-node-ca.pem \
  && rm -f /tmp/extra-ca.crt /tmp/node-ca-bundle.cjs
ENV NODE_EXTRA_CA_CERTS=/etc/noah-node-ca.pem
