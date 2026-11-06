// docker/install-extra-ca.sh (CA_CERT_FILE at image build time) and the pi Go-builder wiring (#76).
// The script runs for real under /bin/sh against a temp trust store; update-ca-certificates is
// replaced by a stub (EXTRA_CA_UPDATE) that concatenates the .crt files the way Debian/Alpine do.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "..");
const script = path.join(repo, "docker/install-extra-ca.sh");

/** A PEM-shaped block; the script never parses DER, so a fake body is enough. */
function fakeCert(tag: string): string {
  return [
    "-----BEGIN CERTIFICATE-----",
    `MIIB${tag}AAAAfirstlineuniquetothiscertificate${tag}`,
    `secondline${tag}`,
    "-----END CERTIFICATE-----",
  ].join("\n");
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(pem: string, opts: { dropOne?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-extra-ca-"));
  tmpDirs.push(root);
  const dir = path.join(root, "anchors");
  const bundle = path.join(root, "ca-certificates.crt");
  const src = path.join(root, "extra-ca.crt");
  fs.writeFileSync(src, pem);
  fs.writeFileSync(bundle, "existing roots\n");
  // Stub updater: append every anchor (optionally skipping the second, like a rejected cert).
  const updater = path.join(root, "update");
  fs.writeFileSync(
    updater,
    `#!/bin/sh\nfor f in "${dir}"/*.crt; do\n` +
      (opts.dropOne ? `  case "$f" in *-02.crt) continue;; esac\n` : "") +
      `  cat "$f" >> "${bundle}"\ndone\necho stub-updated\n`,
    { mode: 0o755 },
  );
  const result = spawnSync("sh", [script, src, "corp-ca"], {
    encoding: "utf8",
    env: { ...process.env, EXTRA_CA_DIR: dir, EXTRA_CA_BUNDLE: bundle, EXTRA_CA_UPDATE: updater },
  });
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  return { ...result, dir, files };
}

describe("docker/install-extra-ca.sh", () => {
  it("splits a CRLF bundle with a comment into one .crt per certificate and trusts them all", () => {
    const pem = ["# corporate bundle", fakeCert("A"), fakeCert("B"), fakeCert("C"), ""].join("\r\n");
    const out = run(pem);
    expect(out.status, out.stderr).toBe(0);
    expect(out.files).toEqual(["corp-ca-01.crt", "corp-ca-02.crt", "corp-ca-03.crt"]);
    const second = fs.readFileSync(path.join(out.dir, "corp-ca-02.crt"), "utf8");
    expect(second).toBe(`${fakeCert("B")}\n`);
    expect(second).not.toContain("\r");
    expect(out.stdout).toContain("trusted 3 certificate(s)");
  });

  it("accepts a single certificate and indented PEM", () => {
    const out = run(`  ${fakeCert("Z").split("\n").join("\n  ")}\n`);
    expect(out.status, out.stderr).toBe(0);
    expect(out.files).toEqual(["corp-ca-01.crt"]);
  });

  it("is a no-op for the placeholder file", () => {
    const placeholder = fs.readFileSync(path.join(repo, "docker/extra-ca.crt.example"), "utf8");
    const out = run(placeholder);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("No extra CA certificate configured");
    expect(out.files).toEqual([]);
  });

  it("fails the build when a certificate does not reach the trust store", () => {
    const out = run([fakeCert("A"), fakeCert("B")].join("\n"), { dropOne: true });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("corp-ca-02.crt was NOT added");
  });

  it("fails on a BEGIN marker without any complete block", () => {
    const out = run("-----BEGIN CERTIFICATE----- inline garbage\n");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("no complete certificate block");
  });
});

describe("CA_CERT_FILE wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");

  it("every image that takes CA_CERT_FILE installs it through the shared script", () => {
    for (const file of [
      "Dockerfile",
      "docker/pi-sandbox/Dockerfile",
      "docker/egress/proxy.Dockerfile",
      "docker/pi/golang-ca.Dockerfile",
    ]) {
      const text = read(file);
      expect(text, file).toContain("ARG CA_CERT_FILE=docker/extra-ca.crt.example");
      expect(text, file).toMatch(/RUN sh \/tmp\/install-extra-ca\.sh \/tmp\/extra-ca\.crt [\w-]+/);
      // The pre-#76 inline copy registered only the first certificate of a bundle.
      expect(text, file).not.toMatch(/cp \/tmp\/extra-ca\.crt /);
    }
  });

  it("the Go builder's base image tracks the pinned pi Dockerfile's GO_IMAGE default", () => {
    const piGo = /^ARG GO_IMAGE=(\S+)$/m.exec(read("vendor/pi-gateway/Dockerfile"))?.[1];
    const ours = /^ARG GO_BASE_IMAGE=(\S+)$/m.exec(read("docker/pi/golang-ca.Dockerfile"))?.[1];
    expect(piGo).toBeTruthy();
    expect(ours).toBe(piGo);
    // pi's egress-proxy stage still builds FROM that arg (what the override relies on).
    expect(read("vendor/pi-gateway/Dockerfile")).toMatch(/^FROM \$\{GO_IMAGE\} AS egress-proxy-build$/m);
  });

  it("the pi override hands egress-proxy the CA-trusting builder", () => {
    const override = read("docker/pi/compose.override.yml");
    expect(override).toMatch(/egress-proxy:\n\s+build:\n\s+args:\n\s+GO_IMAGE: pi-go-builder\n\s+additional_contexts:\n\s+pi-go-builder: service:pi-go-builder/);
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/pi-go-builder:\n(?:.*\n)*?\s+dockerfile: docker\/pi\/golang-ca\.Dockerfile/);
    expect(compose).toMatch(/pi-go-builder:\n(?:.*\n)*?\s+CA_CERT_FILE: \$\{CA_CERT_FILE:-docker\/extra-ca\.crt\.example\}/);
  });
});
