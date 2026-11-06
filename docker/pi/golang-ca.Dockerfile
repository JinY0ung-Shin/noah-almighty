# Build-only: pi-gateway's Go builder image plus Noah's corporate CA (CA_CERT_FILE), so pi's
# `egress-proxy` build (`go mod download && go mod verify`) can reach an HTTPS GOPROXY behind an
# intercepting proxy. docker/pi/compose.override.yml hands this image to pi's Dockerfile through its own
# GO_IMAGE build arg, so pi's Dockerfile and compose file stay untouched.
#
# GO_BASE_IMAGE must stay the GO_IMAGE default of the pinned pi Dockerfile
# (vendor/pi-gateway/Dockerfile) — tests/docker-extra-ca.test.ts fails when a pi bump moves it.
# TLS and Go checksum-database verification stay ON: never GOSUMDB=off.
ARG GO_BASE_IMAGE=golang:1.25-alpine
FROM ${GO_BASE_IMAGE}
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
COPY docker/install-extra-ca.sh /tmp/install-extra-ca.sh
RUN sh /tmp/install-extra-ca.sh /tmp/extra-ca.crt noah-extra-ca \
  && rm -f /tmp/extra-ca.crt /tmp/install-extra-ca.sh
