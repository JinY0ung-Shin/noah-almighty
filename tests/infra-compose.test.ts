// Static contract of the combined Noah + pi-gateway compose stack (docker-compose.yml `include:`
// of pi-gateway's own compose file + docker/pi/compose.override.yml, README "Deployment"). Nothing
// here talks to Docker: `docker compose config` and the dind boot test run at release verification
// (docs/architecture/build-run-verify.md). The pi-gateway side is PINNED below at the commit the
// README names; re-check these lists when the pin moves.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** pi-gateway's compose (pinned commit): its services, its networks, and every `${VAR}` it reads. */
const PI_SERVICES = ["sandbox-image", "egress-proxy", "sandboxd", "mcp-broker", "gateway"];
const PI_NETWORKS = ["edge", "control", "broker-egress", "proxy-egress"];
const PI_COMPOSE_VARIABLES = [
  "APT_MIRROR_URL",
  "APT_SECURITY_MIRROR_URL",
  "AUTH_DISABLED",
  "DOCKER_GID",
  "GATEWAY_BIND_ADDR",
  "GATEWAY_PORT",
  "GOPROXY",
  "LOG_LEVEL",
  "MAX_CONCURRENT_TURNS",
  "MAX_CONCURRENT_TURNS_PER_USER",
  "MCP_METADATA_KEYS",
  "NODE_EXTRA_CA_CERTS",
  "NON_STREAM_TIMEOUT_SECONDS",
  "NPM_CONFIG_REGISTRY",
  "PIP_INDEX_URL",
  "PI_GATEWAY_HOME",
  "PI_GATEWAY_SECRETS",
  "PI_GATEWAY_VERSION",
  "PROMPT_LANGUAGE",
  "SANDBOX_CPUS",
  "SANDBOX_EGRESS_ALLOW",
  "SANDBOX_IDLE_SECONDS",
  "SANDBOX_IMAGE",
  "SANDBOX_MEMORY",
  "SANDBOX_PIDS_LIMIT",
  "SANDBOX_RUNTIME",
  "SESSION_IDLE_SECONDS",
  "SSE_KEEPALIVE_SECONDS",
  "TRUST_PROXY",
  "TURN_QUEUE_TIMEOUT_SECONDS",
];
/**
 * Keys Noah's .env may set that pi's compose ALSO reads. Compose lets the including project's
 * environment win inside an included file, so each must mean the same thing on both sides.
 */
const SHARED_KEYS = ["LOG_LEVEL", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_REGISTRY", "PIP_INDEX_URL", "PI_GATEWAY_HOME", "PI_GATEWAY_SECRETS"];

/**
 * The block under `key` that starts at exactly `indent` spaces, up to the next line at that indent
 * or less. Enough YAML for these files (no flow maps spanning lines, no anchors inside blocks).
 */
function block(text: string, key: string, indent: number): string {
  const lines = text.split("\n");
  const head = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line === head || line.startsWith(`${head} `));
  expect(start, `${key} at indent ${indent}`).toBeGreaterThan(-1);
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    const lead = line.length - line.trimStart().length;
    if (line.trim() && !line.trimStart().startsWith("#") && lead <= indent) break;
    out.push(line);
  }
  return out.join("\n");
}

const compose = read("docker-compose.yml");
const override = read("docker/pi/compose.override.yml");
const services = block(compose, "services", 0);
const noah = block(services, "noah-almighty", 2);
const piSetup = block(services, "pi-setup", 2);
const piSandbox = block(services, "pi-sandbox-image", 2);

describe("docker-compose.yml — pi-gateway is included from its submodule, never copied", () => {
  it("includes pi's own compose from PI_GATEWAY_DIR with Noah's override merged on top", () => {
    const include = block(compose, "include", 0);
    expect(include).toContain("- ${PI_GATEWAY_DIR:-./vendor/pi-gateway}/docker-compose.yml");
    expect(include).toContain("- docker/pi/compose.override.yml");
    expect(include.indexOf("docker-compose.yml")).toBeLessThan(include.indexOf("compose.override.yml"));
    // No pi-gateway source in this repository's own tree, and none of the submodule in the Noah image.
    expect(fs.existsSync(path.join(ROOT, "apps/gateway"))).toBe(false);
    expect(read(".dockerignore").split("\n")).toContain("vendor/pi-gateway/");
  });

  it("defines no service or network whose name pi's compose already uses", () => {
    const own = [...services.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
    expect(own.sort()).toEqual(["noah-almighty", "pi-sandbox-image", "pi-setup"]);
    for (const name of own) expect(PI_SERVICES).not.toContain(name);
    // The optional egress overlay is merged by `-f` AFTER the include: a same-named service there
    // would silently rewrite pi's (verified with `docker compose config`).
    const egress = read("docker-compose.egress.yml");
    const egressServices = [...block(egress, "services", 0).matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
    for (const name of egressServices.filter((n) => n !== "noah-almighty")) {
      expect(PI_SERVICES, `docker-compose.egress.yml service ${name}`).not.toContain(name);
    }
  });

  it("keeps Noah's .env keys that pi also reads to the documented shared set", () => {
    const env = read(".env.example");
    const keys = new Set([...env.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const overlap = PI_COMPOSE_VARIABLES.filter((name) => keys.has(name));
    expect(overlap.sort()).toEqual([...SHARED_KEYS].sort());
    // ...and .env.example says so.
    for (const name of SHARED_KEYS) expect(env).toContain(name);
    expect(env).toMatch(/win[s]? (over|for) pi-gateway/i);
  });
});

describe("docker-compose.yml — the Noah service", () => {
  const environment = block(noah, "environment", 4);

  it("fixes the pi wiring in environment (which wins over the .env env_file)", () => {
    expect(noah).toMatch(/^ {6}- \.env$/m);
    expect(environment).toContain("<<: *pi-addresses");
    expect(environment).toMatch(/^ {6}AGENT_RUNTIME: pi$/m);
    expect(environment).toMatch(/^ {6}PI_GATEWAY_API_KEY_FILE: \/run\/secrets\/pi_gateway_api_key$/m);
    expect(environment).toMatch(/^ {6}PI_WORKSPACES_DIR: \/srv\/pi-workspaces$/m);
    expect(environment).toMatch(/^ {6}PI_DECK_SANDBOX: "true"$/m);
    const addresses = block(compose, "x-pi-addresses", 0);
    expect(addresses).toMatch(/^ {2}PI_GATEWAY_URL: http:\/\/gateway:8080$/m);
    expect(addresses).toMatch(/^ {2}NOAH_MCP_PUBLIC_URL: \$\{NOAH_MCP_PUBLIC_URL:-http:\/\/noah-almighty:\$\{PORT:-48787\}\}$/m);
    // The service key never comes from .env in this stack.
    expect(compose).not.toMatch(/PI_GATEWAY_API_KEY:/);
  });

  it("admits only the broker's pinned address to /mcp by default", () => {
    expect(environment).toContain(
      "NOAH_MCP_ALLOWED_CIDRS: ${NOAH_MCP_ALLOWED_CIDRS:-${NOAH_MCP_BROKER_IP:-172.30.248.10}/32}",
    );
    const broker = block(block(override, "services", 0), "mcp-broker", 2);
    expect(broker).toContain("ipv4_address: ${NOAH_MCP_BROKER_IP:-172.30.248.10}");
    const net = block(block(override, "networks", 0), "noah-mcp", 2);
    expect(net).toMatch(/^ {4}internal: true$/m);
    expect(net).toContain("- subnet: ${NOAH_MCP_SUBNET:-172.30.248.0/24}");
  });

  it("joins its own network, pi's gateway network and noah-mcp — nothing a sandbox is on", () => {
    const networks = block(noah, "networks", 4);
    const joined = [...networks.matchAll(/^ {6}([a-z][\w-]*):/gm)].map((m) => m[1]);
    expect(joined).toEqual(["default", "edge", "noah-mcp"]);
    expect(networks).toContain("- ${NOAH_MCP_HOST_ALIAS:-noah-almighty}");
    // Sandboxes are network_mode none (pi's sandboxd); the only pi-side network the broker gains
    // is noah-mcp, and no sandbox-facing network (proxy-egress, control) is touched.
    expect(override).not.toMatch(/proxy-egress|control/);
    expect(noah).not.toMatch(/proxy-egress|broker-egress|control/);
  });

  it("bind-mounts pi's workspaces (required) and the shared CA host file", () => {
    const volumes = block(noah, "volumes", 4);
    expect(volumes).toContain("- noah-almighty-data:/app/data");
    expect(volumes).toContain(
      "source: ${PI_GATEWAY_HOME:?PI_GATEWAY_HOME is required in .env (same value as pi-gateway's .env)}/workspaces",
    );
    expect(volumes).toContain("target: /srv/pi-workspaces");
    expect(volumes).toContain("source: ${NODE_EXTRA_CA_CERTS:-/dev/null}");
    expect(volumes).toContain("target: /etc/noah-almighty/extra-ca.pem");
    expect(volumes.match(/create_host_path: false/g)).toHaveLength(2);
    expect(environment).toContain("NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:+/etc/noah-almighty/extra-ca.pem}");
  });

  it("reads pi's service key from Noah's own 0400 copy and starts after pi-setup", () => {
    expect(noah).toContain("- source: pi_gateway_api_key");
    const secrets = block(compose, "secrets", 0);
    expect(secrets).toContain(
      "file: ${PI_GATEWAY_SECRETS:-${PI_GATEWAY_HOME}/secrets}/noah/pi_gateway_api_key",
    );
    expect(block(noah, "depends_on", 4)).toMatch(/pi-setup:\n {8}condition: service_completed_successfully/);
  });

  it("keeps compose init off (#71) and the data volume name unchanged", () => {
    expect(noah).toMatch(/^ {4}init: false$/m);
    // No top-level `name:` — the project (and so the volume) name stays the directory name.
    expect(compose).not.toMatch(/^name:/m);
    expect(block(compose, "volumes", 0)).toMatch(/^ {2}noah-almighty-data:$/m);
  });
});

describe("docker-compose.yml — pi-setup and the sandbox image", () => {
  it("runs pi-setup once, as pi's gateway uid, from Noah's own image, after the gateway is healthy", () => {
    expect(piSetup).toContain("dockerfile_inline: FROM noah");
    expect(piSetup).toContain("noah: service:noah-almighty");
    expect(piSetup).toMatch(/^ {4}user: "10001:10001"$/m);
    expect(piSetup).toContain('command: ["sh", "docker/pi/pi-setup.sh"]');
    expect(piSetup).toMatch(/^ {4}environment: \*pi-addresses$/m);
    expect(piSetup).toMatch(/gateway:\n {8}condition: service_healthy/);
    expect(piSetup).toMatch(/^ {4}restart: "no"$/m);
    expect(piSetup).toMatch(/^ {4}read_only: true$/m);
    expect(piSetup).toMatch(/^ {6}- ALL$/m);
    expect(piSetup).toContain("- no-new-privileges:true");
    expect(piSetup).not.toMatch(/ports:|env_file:/);
    expect(block(piSetup, "networks", 4)).toBe("    networks:\n      - edge");
    expect(block(compose, "secrets", 0)).toContain(
      "file: ${PI_GATEWAY_SECRETS:-${PI_GATEWAY_HOME}/secrets}/gateway/admin_api_key",
    );
  });

  it("builds the sandbox image FROM pi's own sandbox build and points sandboxd at it", () => {
    const tag = "noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG:-latest}";
    expect(piSandbox).toContain(`image: ${tag}`);
    expect(piSandbox).toContain("pi-sandbox-base: service:sandbox-image");
    expect(piSandbox).toMatch(/^ {4}network_mode: none$/m);
    const sandboxd = block(block(override, "services", 0), "sandboxd", 2);
    expect(sandboxd).toContain(`SANDBOX_IMAGE: ${tag}`);
    expect(sandboxd).toMatch(/pi-sandbox-image:\n {8}condition: service_completed_successfully/);
    // pi's own image keeps pi's own tag.
    const code = (text: string): string => text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code(compose) + code(override)).not.toContain("pi-gateway/sandbox");
  });
});

describe("docker/pi scripts", () => {
  it("parse and are executable", () => {
    execFileSync("bash", ["-n", "docker/pi/setup-host.sh"], { cwd: ROOT });
    execFileSync("sh", ["-n", "docker/pi/pi-setup.sh"], { cwd: ROOT });
    for (const file of ["docker/pi/setup-host.sh", "docker/pi/pi-setup.sh"]) {
      expect(fs.statSync(path.join(ROOT, file)).mode & 0o111, file).not.toBe(0);
    }
  });

  it("pi-setup hands the admin key to the registration script through the environment only", () => {
    const script = read("docker/pi/pi-setup.sh");
    expect(script).toContain("key_file=/run/secrets/pi_gateway_admin_api_key");
    expect(script).toContain('PI_GATEWAY_ADMIN_KEY="$(cat "$key_file")"');
    expect(script).toContain("export PI_GATEWAY_ADMIN_KEY");
    expect(script).toContain(
      'exec node scripts/pi-register-mcp.mjs --gateway "$PI_GATEWAY_URL" --noah-url "$NOAH_MCP_PUBLIC_URL" --configure-instance',
    );
    expect(script).not.toMatch(/echo[^\n]*\$PI_GATEWAY_ADMIN_KEY/);
    // The image carries the script (the root .dockerignore must not drop docker/pi).
    expect(read(".dockerignore").split("\n")).not.toContain("docker/pi/");
  });

  it("setup-host copies pi's service key for uid 1000 at 0400 without printing it", () => {
    const script = read("docker/pi/setup-host.sh");
    expect(script).toContain('API_KEY="$SECRETS/gateway/api_key"');
    expect(script).toContain('DEST="$SECRETS/noah/pi_gateway_api_key"');
    expect(script).toContain('install -o "$NOAH_UID" -g "$NOAH_UID" -m 0400 "$tmp" "$DEST"');
    expect(script).toContain("NOAH_UID=1000");
    expect(script).not.toMatch(/echo[^\n]*\$\(cat/);
  });
});

describe(".env.example — bundled pi-gateway", () => {
  const env = read(".env.example");
  const documented = (name: string): boolean => new RegExp(`^#?\\s*${name}=`, "m").test(env);

  it("documents every knob the stack reads", () => {
    for (const name of [
      "PI_GATEWAY_DIR",
      "PI_GATEWAY_HOME",
      "PI_GATEWAY_SECRETS",
      "PI_MODEL_MAP",
      "NOAH_MCP_SUBNET",
      "NOAH_MCP_BROKER_IP",
      "NOAH_MCP_PUBLIC_URL",
      "NOAH_MCP_HOST_ALIAS",
      "NOAH_PI_SANDBOX_TAG",
      "NOAH_PI_SESSION_IDLE_SECONDS",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(documented(name), name).toBe(true);
    }
    // PI_GATEWAY_HOME is required, so it is set (not commented) in the example.
    expect(env).toMatch(/^PI_GATEWAY_HOME=\/srv\/pi-gateway$/m);
  });
});
