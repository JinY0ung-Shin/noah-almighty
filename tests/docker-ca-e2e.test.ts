// OPT-IN (NOAH_DOCKER_CA_E2E=1): real docker builds behind a TLS-inspecting "corporate" npm mirror (#77).
//
//   NOAH_DOCKER_CA_E2E=1 rtk proxy npx vitest run tests/docker-ca-e2e.test.ts
//
// Needs docker (compose v2), openssl, python3 and internet (the mirror proxies registry.npmjs.org), and
// takes several minutes (the deck sandbox installs Chromium). It mints a four-certificate CRLF bundle, a
// mirror certificate signed by its THIRD CA (a server that sends no chain, like an intercepting proxy
// whose root is in the middle of the operator's bundle), and builds through `https://<docker bridge>:<port>/`:
//   - pi's own Dockerfile WITHOUT Noah's builder fails (the negative control);
//   - pi's gateway via compose (FROM pi-node-builder: NODE_IMAGE route, npm ci) succeeds;
//   - the real deck sandbox (its own .dockerignore context, the pi sandbox base whose build PATH has no
//     /usr/sbin, the Playwright npm install) succeeds.
// Images are tagged `ca-e2e` where the stack allows it; the build-only builder images are local tags.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.NOAH_DOCKER_CA_E2E === "1";
const repo = path.resolve(__dirname, "..");
const caInRepo = path.join(repo, "docker/zz-ca-e2e.crt");
const MINUTES = 60_000;

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "0.0.0.0", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const MIRROR = `
import http.server, ssl, sys, urllib.request, urllib.error
UP = "https://registry.npmjs.org"
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        keep = ("accept", "user-agent", "npm-command")
        req = urllib.request.Request(UP + self.path, headers={k: v for k, v in self.headers.items() if k.lower() in keep})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body, status, ctype = r.read(), r.status, r.headers.get("content-type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            body, status, ctype = e.read(), e.code, e.headers.get("content-type", "text/plain")
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
s = http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
c.load_cert_chain(sys.argv[2], sys.argv[3])
s.socket = c.wrap_socket(s.socket, server_side=True)
print("ready", flush=True)
s.serve_forever()
`;

describe.skipIf(!enabled)("CA_CERT_FILE end to end behind a TLS-inspecting npm mirror (#77)", () => {
  let work = "";
  let mirror: ChildProcess | undefined;
  let registry = "";
  let env: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ca-e2e-"));
    const bridge = sh("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).out.trim();
    expect(bridge).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    for (const i of [1, 2, 3, 4]) {
      const r = sh("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-keyout", `ca${i}.key`, "-out", `ca${i}.pem`, "-subj", `/CN=Noah E2E Corp CA ${i}`,
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      ], { cwd: work });
      expect(r.status, r.out).toBe(0);
    }
    fs.writeFileSync(path.join(work, "ext.cnf"), `subjectAltName=IP:${bridge}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    expect(sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=mirror"], { cwd: work }).status).toBe(0);
    expect(sh("openssl", ["x509", "-req", "-in", "srv.csr", "-CA", "ca3.pem", "-CAkey", "ca3.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf"], { cwd: work }).status).toBe(0);
    const bundle = ["# e2e corporate bundle", ...[1, 2, 3, 4].map((i) => fs.readFileSync(path.join(work, `ca${i}.pem`), "utf8").trim())].join("\n");
    fs.writeFileSync(caInRepo, `${bundle.split("\n").join("\r\n")}\r\n`);

    const port = await freePort();
    fs.writeFileSync(path.join(work, "mirror.py"), MIRROR);
    mirror = spawn("python3", [path.join(work, "mirror.py"), String(port), path.join(work, "srv.pem"), path.join(work, "srv.key")], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      mirror!.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      mirror!.on("exit", (code) => reject(new Error(`mirror exited ${code}`)));
    });
    registry = `https://${bridge}:${port}/`;
    env = {
      ...process.env,
      CA_CERT_FILE: "docker/zz-ca-e2e.crt",
      NPM_CONFIG_REGISTRY: registry,
      PI_GATEWAY_VERSION: "ca-e2e",
      NOAH_PI_SANDBOX_TAG: "ca-e2e",
      PI_GATEWAY_HOME: process.env.PI_GATEWAY_HOME ?? work,
      DOCKER_GID: process.env.DOCKER_GID ?? "999",
    };
  }, 5 * MINUTES);

  afterAll(() => {
    mirror?.kill();
    fs.rmSync(caInRepo, { force: true });
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const compose = (...args: string[]) => sh("docker", ["compose", "-p", "noah-ca-e2e", ...args], { cwd: repo, env });

  it("negative control: pi's own Node build does not trust the mirror", () => {
    const r = sh("docker", [
      "build", "--target", "build-deps", "--build-arg", `NPM_CONFIG_REGISTRY=${registry}`,
      path.join(repo, "vendor/pi-gateway"),
    ]);
    expect(r.status).not.toBe(0);
  }, 15 * MINUTES);

  it("pi's gateway builds FROM pi-node-builder and npm ci verifies the mirror", () => {
    const r = compose("build", "--progress=plain", "pi-node-builder", "gateway");
    expect(r.status, r.out.slice(-4000)).toBe(0);
    expect(r.out).toContain("trusted 4 extra certificate(s) for Node");
  }, 20 * MINUTES);

  it("the real deck sandbox builds: context, sbin updater and Playwright npm through the mirror", () => {
    const r = compose("build", "--progress=plain", "pi-sandbox-image");
    expect(r.status, r.out.slice(-4000)).toBe(0);
    expect(r.out).toContain("install-extra-ca: trusted 4 certificate(s)");
  }, 40 * MINUTES);
});
