// Writes the NODE_EXTRA_CA_CERTS file of Noah's pi Node builder (docker/pi/node-ca.Dockerfile, #77):
// Node's own bundled roots plus every certificate in CA_CERT_FILE (one certificate or a PEM bundle).
//
//   node node-ca-bundle.cjs <pem-file> <out-file>
//
// Node never reads the system trust store, and pi's Node base image (node:22-bookworm-slim) has no
// ca-certificates package, so this file is what lets `npm ci` verify an HTTPS mirror behind a corporate
// CA — TLS verification stays ON (never strict-ssl=false / NODE_TLS_REJECT_UNAUTHORIZED=0). The roots
// keep the file a valid, non-empty PEM when no CA is configured (the placeholder), so the image-wide
// NODE_EXTRA_CA_CERTS never makes Node warn about an empty or missing file. Every block must parse as an
// X.509 certificate, or the build fails.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const tls = require("node:tls");

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: node node-ca-bundle.cjs <pem-file> <out-file>");
  process.exit(2);
}

const text = fs.readFileSync(src, "utf8").replace(/\r/g, "");
const blocks = [];
const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
for (const match of text.matchAll(pattern)) {
  const pem = match[0]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  try {
    new crypto.X509Certificate(pem);
  } catch (error) {
    console.error(`node-ca-bundle: certificate #${blocks.length + 1} in ${src} does not parse: ${error.message}`);
    process.exit(1);
  }
  blocks.push(`${pem}\n`);
}
if (blocks.length === 0 && text.includes("-----BEGIN CERTIFICATE-----")) {
  console.error(`node-ca-bundle: ${src} has a BEGIN CERTIFICATE marker but no complete certificate block`);
  process.exit(1);
}

fs.writeFileSync(out, [...tls.rootCertificates.map((pem) => `${pem}\n`), ...blocks].join(""), { mode: 0o644 });
console.log(
  blocks.length
    ? `node-ca-bundle: trusted ${blocks.length} extra certificate(s) for Node`
    : "node-ca-bundle: no extra CA certificate configured; Node's own roots only",
);
