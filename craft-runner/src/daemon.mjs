#!/usr/bin/env node
// craft-runner process entry. Runs as root inside the network-none runner container with
// cap_drop ALL + SETUID SETGID CHOWN FOWNER DAC_OVERRIDE KILL and no-new-privileges (docker-compose.yml).

import { APPS } from "./apps.mjs";
import { loadConfig } from "./config.mjs";
import { createRunner } from "./runner.mjs";

const log = (m) => process.stderr.write(`${new Date().toISOString()} craft-runner ${m}\n`);
const config = loadConfig(process.env);

if (config.secretProblem) {
  // Fail closed WITHOUT a restart loop: no socket is opened, Noah sees the runner as unreachable.
  log(`${config.secretProblem}; the control socket stays closed and Craft apps are unavailable`);
  setInterval(() => {}, 1 << 30);
} else {
  const runner = createRunner({
    exchangeDir: config.exchangeDir,
    tmpRoot: config.tmpRoot,
    secret: config.secret,
    maxProcs: config.maxProcs,
    limits: config.limits,
    apps: APPS,
    privileged: process.getuid?.() === 0,
    log,
  });
  if (process.getuid?.() !== 0) log("not running as root: session uid isolation is OFF (development only)");
  const shutdown = async (sig) => {
    log(`${sig}: stopping`);
    try {
      await runner.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  runner.start().catch((err) => {
    log(`boot failed: ${err.stack ?? err}`);
    process.exit(1);
  });
}
