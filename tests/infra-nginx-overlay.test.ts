// Domain name + HTTPS in front of Noah: the optional nginx overlay (docker-compose.nginx.yml,
// docker/nginx/noah.conf.template, README "Domain name and HTTPS") and the server half it relies on
// (NOAH_TRUSTED_PROXY_CIDRS, src/server/trustedProxies.ts). The compose/template half is a static
// contract — nothing here talks to Docker; the live check (real nginx + Noah image) is described in
// docs/architecture/build-run-verify.md.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { applyTrustedProxies, parseTrustedProxyCidrs } from "../src/server/trustedProxies.js";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** What a route sees as the client's address, with `cidrs` trusted. */
async function seenAddress(cidrs: string[] | undefined, forwardedFor?: string): Promise<{ ip: string; protocol: string }> {
  const app = express();
  applyTrustedProxies(app, cidrs);
  app.get("/ip", (req, res) => {
    res.json({ ip: req.ip, protocol: req.protocol });
  });
  const call = request(app).get("/ip").set("X-Forwarded-Proto", "https");
  if (forwardedFor) call.set("X-Forwarded-For", forwardedFor);
  return (await call).body as { ip: string; protocol: string };
}

const LOOPBACK = ["127.0.0.0/8", "::1"];
const isLoopback = (ip: string): boolean => /^(::ffff:)?127\.|^::1$/.test(ip);

describe("NOAH_TRUSTED_PROXY_CIDRS — whose forwarded headers Noah believes", () => {
  it("believes nobody by default: the address is the TCP peer, whatever the headers claim", async () => {
    for (const cidrs of [undefined, []]) {
      const seen = await seenAddress(cidrs, "203.0.113.9");
      expect(isLoopback(seen.ip), seen.ip).toBe(true);
      expect(seen.protocol).toBe("http");
    }
  });

  it("takes the address a LISTED proxy forwards, and its scheme", async () => {
    expect(await seenAddress(LOOPBACK, "203.0.113.9")).toEqual({ ip: "203.0.113.9", protocol: "https" });
  });

  it("ignores the headers of a peer that is not listed — a client cannot pick its own address", async () => {
    const seen = await seenAddress(["192.0.2.1/32"], "203.0.113.9");
    expect(isLoopback(seen.ip), seen.ip).toBe(true);
    expect(seen.protocol).toBe("http");
  });

  it("stops at the first address a listed proxy did not vouch for (a forged entry further left is not believed)", async () => {
    expect((await seenAddress(LOOPBACK, "198.51.100.1, 203.0.113.9")).ip).toBe("203.0.113.9");
  });

  it("parses like the /mcp allowlist and names its own key when a value is wrong", () => {
    expect(parseTrustedProxyCidrs("")).toEqual([]);
    expect(parseTrustedProxyCidrs(undefined)).toEqual([]);
    expect(parseTrustedProxyCidrs("172.16.249.10/32, fd00::/8")).toEqual(["172.16.249.10/32", "fd00::/8"]);
    for (const bad of ["172.16.249.10/33", "nginx", "true", "1"]) {
      expect(() => parseTrustedProxyCidrs(bad), bad).toThrow("NOAH_TRUSTED_PROXY_CIDRS");
    }
  });

  describe("loadConfig", () => {
    const saved = process.env.NOAH_TRUSTED_PROXY_CIDRS;
    afterEach(() => {
      if (saved === undefined) delete process.env.NOAH_TRUSTED_PROXY_CIDRS;
      else process.env.NOAH_TRUSTED_PROXY_CIDRS = saved;
    });

    it("reads the list from the environment, and a typo stops the boot", () => {
      const base = { agentRuntime: "local" as const, sessionSecret: "x", dataDir: "/tmp/unused" };
      delete process.env.NOAH_TRUSTED_PROXY_CIDRS;
      expect(loadConfig(base).trustedProxyCidrs).toEqual([]);
      process.env.NOAH_TRUSTED_PROXY_CIDRS = "172.16.249.10/32";
      expect(loadConfig(base).trustedProxyCidrs).toEqual(["172.16.249.10/32"]);
      process.env.NOAH_TRUSTED_PROXY_CIDRS = "172.16.249.10/99";
      expect(() => loadConfig(base)).toThrow("NOAH_TRUSTED_PROXY_CIDRS");
    });
  });
});

describe("docker-compose.nginx.yml — the overlay", () => {
  const overlay = read("docker-compose.nginx.yml");
  const base = read("docker-compose.yml");
  const piOverride = read("docker/pi/compose.override.yml");

  it("takes Noah's port off the host's public interfaces", () => {
    expect(overlay).toMatch(/ports: !override\n\s+- "127\.0\.0\.1:\$\{PORT:-48787\}:\$\{PORT:-48787\}"/);
  });

  it("fixes what an HTTPS front needs in Noah's environment: Secure cookies, no native TLS, nginx alone trusted", () => {
    expect(overlay).toContain('SECURE_COOKIES: "true"');
    expect(overlay).toContain('TLS_CERT_FILE: ""');
    expect(overlay).toContain('TLS_KEY_FILE: ""');
    expect(overlay).toContain("NOAH_TRUSTED_PROXY_CIDRS: ${NOAH_TRUSTED_PROXY_CIDRS:-${NOAH_NGINX_IP:-172.16.249.10}/32}");
  });

  it("pins nginx to the one address Noah trusts, on a network of its own outside pi's and Docker's ranges", () => {
    expect(overlay).toContain("ipv4_address: ${NOAH_NGINX_IP:-172.16.249.10}");
    expect(overlay).toContain("- subnet: ${NOAH_NGINX_SUBNET:-172.16.249.0/24}");
    // Not the broker's network, and not internal (an internal-only container cannot publish 80/443).
    expect(piOverride).toContain("${NOAH_MCP_SUBNET:-172.16.248.0/24}");
    expect(overlay).not.toMatch(/^\s+internal: true/m);
    expect(overlay).not.toContain("noah-mcp:");
  });

  it("leaves pi's wiring alone and uses no name the base stack already has", () => {
    expect(overlay).not.toMatch(/^\s+NOAH_MCP_(PUBLIC_URL|HOST_ALIAS|ALLOWED_CIDRS):/m);
    expect(base).not.toContain("noah-nginx");
    expect(base).not.toContain("noah-front");
    expect(piOverride).not.toContain("noah-front");
  });

  it("requires the domain name, and lets a closed network name its own nginx image", () => {
    expect(overlay).toContain("NOAH_SERVER_NAME: ${NOAH_SERVER_NAME:?");
    expect(overlay).toContain("image: ${NOAH_NGINX_IMAGE:-nginx:stable-alpine}");
  });

  it("renders the template with Noah's variables only and mounts the certificate folder read-only", () => {
    // `$$` is compose's escape for a literal `$`.
    expect(overlay).toContain('NGINX_ENVSUBST_FILTER: "^(NOAH_|NGINX_LOCAL_RESOLVERS$$)"');
    expect(overlay).toContain('NGINX_ENTRYPOINT_LOCAL_RESOLVERS: "1"');
    expect(overlay).toContain("./docker/nginx/noah.conf.template:/etc/nginx/templates/default.conf.template:ro");
    expect(overlay).toContain("./docker/tls:/etc/nginx/tls:ro");
  });

  it("runs nginx read-only with every capability dropped but the ones it starts with", () => {
    expect(overlay).toContain("read_only: true");
    expect(overlay).toMatch(/cap_drop:\n\s+- ALL/);
    expect(overlay).toContain("no-new-privileges:true");
    const added = [...overlay.matchAll(/^\s+- ([A-Z_]+)$/gm)].map((match) => match[1]).filter((name) => name !== "ALL");
    expect(added.sort()).toEqual(["CHOWN", "DAC_READ_SEARCH", "NET_BIND_SERVICE", "SETGID", "SETUID"]);
  });
});

describe("docker/nginx/noah.conf.template — what Noah needs from the proxy", () => {
  const template = read("docker/nginx/noah.conf.template");
  /** The file without its comments: the directives nginx actually reads. */
  const directives = template
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  const has = (directive: string): boolean => directives.includes(directive);

  it("hands Noah the browser's own host and scheme (the same-origin gate compares them with Origin)", () => {
    for (const line of ["proxy_set_header Host              $host;", "proxy_set_header X-Forwarded-Host  $host;", "proxy_set_header X-Forwarded-Proto $scheme;"]) {
      expect(has(line), line).toBe(true);
    }
  });

  it("OVERWRITES X-Forwarded-For with the peer nginx saw — never appends to what the client sent", () => {
    expect(has("proxy_set_header X-Forwarded-For   $remote_addr;")).toBe(true);
    expect(template).not.toContain("$proxy_add_x_forwarded_for");
    expect(template).not.toContain("$http_x_forwarded_for");
  });

  it("streams in both directions, waits as long as the operator says and adds no body limit of its own", () => {
    for (const line of [
      "proxy_buffering         off;",
      "proxy_request_buffering off;",
      "proxy_http_version 1.1;",
      "proxy_read_timeout      ${NOAH_PROXY_READ_TIMEOUT};",
      "proxy_send_timeout      ${NOAH_PROXY_READ_TIMEOUT};",
      "client_max_body_size    0;",
    ]) {
      expect(has(line), line).toBe(true);
    }
  });

  it("finds Noah by name on every request, so a recreated Noah container needs no nginx restart", () => {
    expect(has("resolver ${NGINX_LOCAL_RESOLVERS} valid=10s ipv6=off;")).toBe(true);
    expect(has("set $noah_upstream http://${NOAH_UPSTREAM};")).toBe(true);
    expect(has("proxy_pass $noah_upstream;")).toBe(true);
  });

  it("sends plain http and every other host name to the one domain name, keeping the method (308)", () => {
    const redirects = directives.filter((line) => line.startsWith("return 308 "));
    expect(redirects).toEqual([
      "return 308 https://${NOAH_SERVER_NAME}$request_uri;",
      "return 308 https://${NOAH_SERVER_NAME}$request_uri;",
    ]);
    expect(has("listen 80 default_server;")).toBe(true);
    expect(has("listen 443 ssl default_server;")).toBe(true);
    expect(has("server_name ${NOAH_SERVER_NAME};")).toBe(true);
  });

  it("keeps /mcp off the front door", () => {
    expect(has("location = /mcp { return 404; }")).toBe(true);
    expect(has("location ^~ /mcp/ { return 404; }")).toBe(true);
  });

  it("uses only variables the overlay sets (anything else would reach nginx unrendered)", () => {
    const overlay = read("docker-compose.nginx.yml");
    const used = new Set([...template.matchAll(/\$\{([A-Z_]+)\}/g)].map((match) => match[1]));
    for (const name of used) {
      if (name === "NGINX_LOCAL_RESOLVERS") continue; // exported by the image's entrypoint
      expect(name.startsWith("NOAH_"), name).toBe(true);
      expect(overlay, name).toMatch(new RegExp(`^\\s+${name}: `, "m"));
    }
  });
});

describe("the overlay's surroundings", () => {
  it(".env.example documents every knob the overlay reads", () => {
    const env = read(".env.example");
    const overlay = read("docker-compose.nginx.yml");
    const read_ = new Set([...overlay.matchAll(/\$\{([A-Z_]+)[:?}]/g)].map((match) => match[1]));
    read_.delete("PORT");
    expect([...read_].sort()).toEqual([
      "NOAH_NGINX_IMAGE",
      "NOAH_NGINX_IP",
      "NOAH_NGINX_READ_TIMEOUT",
      "NOAH_NGINX_SUBNET",
      "NOAH_NGINX_TLS_CERT",
      "NOAH_NGINX_TLS_KEY",
      "NOAH_SERVER_NAME",
      "NOAH_TRUSTED_PROXY_CIDRS",
    ]);
    for (const name of read_) {
      expect(new RegExp(`^#?\\s*${name}=`, "m").test(env), name).toBe(true);
    }
  });

  it("keeps the nginx config out of the Noah image (it is bind-mounted into nginx, never read by Noah)", () => {
    expect(read(".dockerignore")).toMatch(/^docker\/nginx\/$/m);
  });

  it("does not reuse pi-gateway's TRUST_PROXY key (Noah's .env wins inside pi's compose file)", () => {
    const sources = ["src/server/trustedProxies.ts", "src/server/config.ts", "docker-compose.nginx.yml"].map(read).join("\n");
    expect(sources).not.toMatch(/env\("TRUST_PROXY"\)|^\s+TRUST_PROXY:/m);
  });
});
