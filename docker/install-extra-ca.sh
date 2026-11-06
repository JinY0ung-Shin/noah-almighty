#!/bin/sh
# Trust an optional corporate CA at image BUILD time (Debian and Alpine).
#
#   sh docker/install-extra-ca.sh <pem-file> <name-prefix>
#
# <pem-file> is CA_CERT_FILE as copied into the build (one certificate or a PEM bundle of several);
# the placeholder docker/extra-ca.crt.example holds no certificate and is a no-op. Every certificate is
# written to its OWN <name-prefix>-NN.crt: update-ca-certificates registers one certificate per .crt
# file and merely WARNS ("does not contain exactly one certificate or CRL: skipping") on a bundle,
# exiting 0 — so a bundle copied as one file silently left the image without the corporate CA.
# After the update every certificate is checked in the system bundle; a missing one FAILS the build.
#
# TLS and checksum verification stay ON everywhere: this script is the fix for "x509: certificate
# signed by unknown authority", never GOSUMDB=off or pip --trusted-host.
#
# Test seams (tests/docker-extra-ca.test.ts): EXTRA_CA_DIR, EXTRA_CA_BUNDLE, EXTRA_CA_UPDATE.
set -eu

src=${1:?usage: install-extra-ca.sh <pem-file> <name-prefix>}
prefix=${2:?usage: install-extra-ca.sh <pem-file> <name-prefix>}
dir=${EXTRA_CA_DIR:-/usr/local/share/ca-certificates}
bundle=${EXTRA_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}
update=${EXTRA_CA_UPDATE:-update-ca-certificates}

if ! grep -q -- "-----BEGIN CERTIFICATE-----" "$src"; then
  echo "No extra CA certificate configured; skipping trust-store update."
  exit 0
fi

mkdir -p "$dir"
# CRLF- and indent-safe split: one file per BEGIN…END block; anything outside a block (comments, keys) is dropped.
count=$(tr -d '\r' < "$src" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | awk -v dir="$dir" -v prefix="$prefix" '
  /^-----BEGIN CERTIFICATE-----$/ { n++; out = sprintf("%s/%s-%02d.crt", dir, prefix, n); inside = 1 }
  inside { print > out }
  /^-----END CERTIFICATE-----$/ { if (inside) close(out); inside = 0 }
  END { print n + 0 }')
if [ "$count" -eq 0 ]; then
  echo "install-extra-ca: $src has a BEGIN CERTIFICATE marker but no complete certificate block" >&2
  exit 1
fi

"$update"

# Each certificate's first base64 line must now be in the system bundle (what Go, git, curl, pip and
# node read). Catches a certificate update-ca-certificates skipped (malformed, truncated) by name.
missing=0
for crt in "$dir/$prefix"-*.crt; do
  first=$(sed -n '2p' "$crt")
  if [ -z "$first" ] || ! grep -qF -- "$first" "$bundle"; then
    echo "install-extra-ca: $(basename "$crt") was NOT added to $bundle" >&2
    missing=$((missing + 1))
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi
echo "install-extra-ca: trusted $count certificate(s) from $(basename "$src")"
