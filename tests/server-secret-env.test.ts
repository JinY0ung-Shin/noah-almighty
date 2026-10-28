import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ONLY_SECRET_ENV_NAMES, scrubServerOnlySecretEnv } from "../src/server/secretPolicy.js";
import { agentSubprocessEnv } from "../src/server/agent/runPlan.js";

// #71: server-only secrets never reach a process the server starts, and the
// server process itself is non-dumpable in the image.
describe("server-only secret env", () => {
  it("scrubs every server-only secret in place and keeps the rest", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "model" };
    for (const name of SERVER_ONLY_SECRET_ENV_NAMES) env[name] = "secret";
    scrubServerOnlySecretEnv(env);
    for (const name of SERVER_ONLY_SECRET_ENV_NAMES) expect(env).not.toHaveProperty(name);
    expect(env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "model" });
  });

  it("keeps them out of the agent subprocess env even from an unscrubbed base", () => {
    const base: Record<string, string | undefined> = { SESSION_SECRET: "s", HOME: "/home/node" };
    const env = agentSubprocessEnv(base, "/data/agent-sessions");
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env.HOME).toBe("/home/node");
  });

  it("the server drops them from process.env right after loading the config", () => {
    const index = fs.readFileSync(path.join(__dirname, "../src/server/index.ts"), "utf8");
    const services = index.indexOf("const services = createServices();");
    const scrub = index.indexOf("scrubServerOnlySecretEnv(process.env);");
    expect(services).toBeGreaterThan(-1);
    expect(scrub).toBeGreaterThan(services);
    // Before anything else starts processes (deck probes, listen).
    expect(scrub).toBeLessThan(index.indexOf("probeDeckRendering();"));
  });

  it("the image makes node and its PID-1 tini execute-only before dropping to the node user", () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
    const chmod = dockerfile.indexOf("RUN chmod 0711 /usr/local/bin/node /usr/bin/tini");
    expect(chmod).toBeGreaterThan(-1);
    expect(chmod).toBeLessThan(dockerfile.lastIndexOf("USER node"));
    // Started via the entrypoint shell's exec — a runtime-started PID 1 is not protected.
    expect(dockerfile).toContain('ENTRYPOINT ["docker-entrypoint.sh", "/usr/bin/tini", "--"]');
  });

  it("compose keeps Docker's readable init off the base service, on for the root egress image", () => {
    const base = fs.readFileSync(path.join(__dirname, "../docker-compose.yml"), "utf8");
    const app = base.slice(base.indexOf("  noah-almighty:"), base.indexOf("\nvolumes:"));
    expect(app).toMatch(/^\s+init: false$/m);
    const egress = fs.readFileSync(path.join(__dirname, "../docker-compose.egress.yml"), "utf8");
    const egressApp = egress.slice(egress.indexOf("  noah-almighty:"), egress.indexOf("  egress-proxy:"));
    expect(egressApp).toMatch(/^\s+init: true$/m);
  });
});
