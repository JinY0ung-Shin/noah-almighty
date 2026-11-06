// CA_CERT_FILE at image build time (#76, #77): docker/install-extra-ca.sh (system trust store),
// docker/pi/node-ca-bundle.cjs (Node's NODE_EXTRA_CA_CERTS file for pi's Node builds), the build-context
// ignore files that must admit both, and the pi Go/Node builder wiring. The scripts run for real; the
// system updater is a stub that concatenates the .crt files the way Debian/Alpine do. A real docker
// build behind a test-CA HTTPS mirror is the opt-in tests/docker-ca-e2e.test.ts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
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

function run(pem: string, opts: { dropOne?: boolean; updater?: "explicit" | "sbin" | "missing" } = {}) {
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
  // "sbin"/"missing": no EXTRA_CA_UPDATE and a PATH without the tool, like pi's sandbox base (#77).
  const mode = opts.updater ?? "explicit";
  const sbin = path.join(root, "sbin");
  fs.mkdirSync(sbin);
  if (mode === "sbin") fs.copyFileSync(updater, path.join(sbin, "update-ca-certificates"));
  fs.chmodSync(path.join(sbin), 0o755);
  if (mode === "sbin") fs.chmodSync(path.join(sbin, "update-ca-certificates"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, EXTRA_CA_DIR: dir, EXTRA_CA_BUNDLE: bundle };
  if (mode === "explicit") env.EXTRA_CA_UPDATE = updater;
  else {
    delete env.EXTRA_CA_UPDATE;
    env.PATH = path.dirname(process.execPath) + ":/usr/bin:/bin";
    env.EXTRA_CA_SBIN_DIRS = sbin;
  }
  const result = spawnSync("sh", [script, src, "corp-ca"], { encoding: "utf8", env });
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

  it("finds update-ca-certificates in an sbin directory that is not on PATH (#77)", () => {
    const out = run([fakeCert("A"), fakeCert("B")].join("\n"), { updater: "sbin" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("stub-updated");
    expect(out.stdout).toContain("trusted 2 certificate(s)");
  });

  it("fails clearly when update-ca-certificates is nowhere", () => {
    const out = run(fakeCert("A"), { updater: "missing" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("update-ca-certificates not found");
  });

  it("fails on a BEGIN marker without any complete block", () => {
    const out = run("-----BEGIN CERTIFICATE----- inline garbage\n");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("no complete certificate block");
  });
});

describe("docker/pi/node-ca-bundle.cjs", () => {
  const bundler = path.join(repo, "docker/pi/node-ca-bundle.cjs");
  // Real certificates without generating any: three of Node's own roots stand in for a corporate bundle.
  const corp = tls.rootCertificates.slice(0, 3);

  function bundle(pem: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-node-ca-"));
    tmpDirs.push(root);
    const src = path.join(root, "extra-ca.crt");
    const out = path.join(root, "node-ca.pem");
    fs.writeFileSync(src, pem);
    const result = spawnSync(process.execPath, [bundler, src, out], { encoding: "utf8" });
    return { ...result, pem: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "" };
  }
  const count = (pem: string) => pem.split("-----BEGIN CERTIFICATE-----").length - 1;

  it("appends every certificate of a CRLF, indented, commented bundle to Node's roots", () => {
    const text = ["# corporate bundle", ...corp.map((c) => c.split("\n").map((l) => `  ${l}`).join("\r\n"))].join("\r\n");
    const out = bundle(text);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("trusted 3 extra certificate(s)");
    expect(count(out.pem)).toBe(tls.rootCertificates.length + 3);
    expect(out.pem.endsWith(`${corp[2]}\n`)).toBe(true);
    expect(out.pem).not.toContain("\r");
  });

  it("writes Node's roots alone for the placeholder, so NODE_EXTRA_CA_CERTS is always a valid file", () => {
    const out = bundle(fs.readFileSync(path.join(repo, "docker/extra-ca.crt.example"), "utf8"));
    expect(out.status, out.stderr).toBe(0);
    expect(count(out.pem)).toBe(tls.rootCertificates.length);
  });

  it("fails the build on a block that is not a certificate", () => {
    const out = bundle(`${corp[0]}\n-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n`);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("certificate #2");
  });
});

/**
 * Whether a .dockerignore admits `file`: Docker's rules — patterns relative to the context root, `*`
 * within one segment, `**` across segments, a pattern also covers everything under a matching
 * directory, `!` re-includes, and the LAST matching line wins.
 */
function admitted(ignoreFile: string, file: string): boolean {
  let included = true;
  for (const raw of fs.readFileSync(path.join(repo, ignoreFile), "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    const pattern = (negate ? line.slice(1) : line).replace(/^\/+/, "").replace(/\/+$/, "");
    const body = pattern
      .split("/")
      .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
      .join("/")
      .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
    if (new RegExp(`^${body}(?:/.*)?$`).test(file)) included = negate;
  }
  return included;
}

describe("build contexts admit the CA inputs (#77)", () => {
  const operatorCas = ["docker/samsungsemi-prx.com.crt", "docker/corp-ca-bundle.pem", "docker/tls-fullchain.crt"];

  it("the deck sandbox's own ignore file admits the installer, the placeholder and an operator CA", () => {
    const ignore = "docker/pi-sandbox/Dockerfile.dockerignore";
    for (const file of ["docker/install-extra-ca.sh", "docker/extra-ca.crt.example", ...operatorCas]) {
      expect(admitted(ignore, file), file).toBe(true);
    }
    // ...and still keeps out what it never needs, private keys included.
    for (const file of ["docker/tls/server.key", "docker/tls/server.pem", "src/server/app.ts", "docker/pi/node-ca-bundle.cjs"]) {
      expect(admitted(ignore, file), file).toBe(false);
    }
    expect(admitted(ignore, "default-skills/skills/pptx/converter/requirements.txt")).toBe(true);
  });

  it("the root ignore file (Noah, pi-go-builder, pi-node-builder, egress proxy) admits them too", () => {
    for (const file of ["docker/install-extra-ca.sh", "docker/pi/node-ca-bundle.cjs", "docker/extra-ca.crt.example", ...operatorCas]) {
      expect(admitted(".dockerignore", file), file).toBe(true);
    }
    expect(admitted(".dockerignore", "docker/tls/server.key")).toBe(false);
  });

  it("no other Dockerfile in docker/ carries its own ignore file that could hide them", () => {
    const own = fs
      .readdirSync(path.join(repo, "docker"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".dockerignore"));
    expect(own).toEqual(["pi-sandbox/Dockerfile.dockerignore"]);
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

  it("Node build steps verify TLS through NODE_EXTRA_CA_CERTS, never by turning it off (#77)", () => {
    for (const file of ["Dockerfile", "docker/pi-sandbox/Dockerfile", "docker/pi/node-ca.Dockerfile"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/^[^#\n]*strict-ssl=false/m);
      expect(text, file).not.toMatch(/^[^#\n]*NODE_TLS_REJECT_UNAUTHORIZED=0/m);
    }
    // Every npm install runs with the system bundle (which holds CA_CERT_FILE) as Node's extra CAs.
    for (const file of ["Dockerfile", "docker/pi-sandbox/Dockerfile"]) {
      const runs = read(file).split(/\n(?=RUN |COPY |ARG |ENV |FROM |WORKDIR |USER )/).filter((step) => /npm install/.test(step) && step.startsWith("RUN "));
      expect(runs.length, file).toBeGreaterThan(0);
      for (const step of runs) expect(step, file).toContain("NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt");
    }
    const node = read("docker/pi/node-ca.Dockerfile");
    expect(node).toMatch(/^RUN node \/tmp\/node-ca-bundle\.cjs \/tmp\/extra-ca\.crt \/etc\/noah-node-ca\.pem/m);
    expect(node).toMatch(/^ENV NODE_EXTRA_CA_CERTS=\/etc\/noah-node-ca\.pem$/m);
  });

  it("the Node builder's base image tracks the pinned pi Dockerfile's NODE_IMAGE default", () => {
    const pi = read("vendor/pi-gateway/Dockerfile");
    const piNode = /^ARG NODE_IMAGE=(\S+)$/m.exec(pi)?.[1];
    expect(piNode).toBeTruthy();
    expect(/^ARG NODE_BASE_IMAGE=(\S+)$/m.exec(read("docker/pi/node-ca.Dockerfile"))?.[1]).toBe(piNode);
    // Every pi Node build stage still starts FROM that arg (what the override relies on).
    expect(pi).toMatch(/^FROM \$\{NODE_IMAGE\} AS base$/m);
  });

  it("the pi override hands gateway, sandboxd and mcp-broker the CA-trusting Node base", () => {
    const override = read("docker/pi/compose.override.yml");
    expect(override).toMatch(/^x-pi-node-builder: &pi-node-builder\n {2}args:\n {4}NODE_IMAGE: pi-node-builder\n {2}additional_contexts:\n {4}pi-node-builder: service:pi-node-builder$/m);
    for (const service of ["gateway", "sandboxd", "mcp-broker"]) {
      const block = new RegExp(`^ {2}${service}:\\n((?: {4}.*\\n|\\n)*)`, "m").exec(override)?.[1] ?? "";
      expect(block, service).toMatch(/^ {4}build: \*pi-node-builder$/m);
    }
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/pi-node-builder:\n(?:.*\n)*?\s+dockerfile: docker\/pi\/node-ca\.Dockerfile/);
    expect(compose).toMatch(/pi-node-builder:\n(?:.*\n)*?\s+CA_CERT_FILE: \$\{CA_CERT_FILE:-docker\/extra-ca\.crt\.example\}/);
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
