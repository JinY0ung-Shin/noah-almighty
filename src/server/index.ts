// MUST be first: loads .env into process.env before any module below reads it
// at evaluation time (auth's SECURE_COOKIES, logger's LOG_LEVEL).
import "./loadEnv.js";
import { createApp, createServices } from "./app.js";
import { createAppServer } from "./appServer.js";
import logger from "./logger.js";
import { startAvatarTaskDispatcher } from "./avatarTaskRunner.js";
import { startRoutineScheduler } from "./scheduler.js";
import { startBotTaskDispatcher } from "./botTaskRunner.js";
import { cancelAllRuns } from "./agent/runRegistry.js";
import { applyCustomGithubCa } from "./tlsCa.js";
import {
  deckToolchainLogFields,
  probeDeckRendering,
  probeDeckToolchain,
} from "./deckRender.js";

const services = createServices();
// Trust an on-prem GitHub's internal CA (GITHUB_CA_CERT) for Node fetch and git
// before anything reaches out over HTTPS. create_repo also passes it to gh.
applyCustomGithubCa(services.config, logger);
// Probe the PPTX toolchain now (memoized) so the synchronous spawnSync cost is
// paid at boot rather than on the first chat turn — the result can't change
// without a container rebuild. Two halves: the legacy LibreOffice/python-pptx
// check, then the pptx skill's converter (`deck.mjs probe --json`, 10 s cap,
// allowlisted env; an unreadable result is re-probed in the background).
probeDeckRendering();
const deckToolchain = probeDeckToolchain(services.config);
logger.info(deckToolchainLogFields(deckToolchain), "deck toolchain probe");
if (deckToolchain.selftest === "drift") {
  logger.warn(
    { chromiumVersion: deckToolchain.chromiumVersion ?? null },
    "deck converter golden drift recorded at image build (README.md#deck-converter-golden-drift)",
  );
}
const app = createApp(services);

const { server, protocol } = createAppServer(app, services.config);
server.listen(services.config.port, () => {
  logger.info({ port: services.config.port, protocol }, "noah-almighty listening");
  logger.info(
    { dataDir: services.config.dataDir, agentRuntime: services.config.agentRuntime },
    "server started",
  );
});

// Fire owner-scheduled routine jobs in the background.
const stopScheduler = startRoutineScheduler(services);
const stopAvatarTaskDispatcher = startAvatarTaskDispatcher(services);
// Delegated bot tasks (내 봇): fail whatever this restart interrupted, then
// drain any backlog the owner queued before the process went down.
const stopBotTaskDispatcher = startBotTaskDispatcher(services);

// A rejected promise from an async Express 4 route handler is NOT routed to the
// error middleware — it surfaces here. Log and CONTINUE: a single bad request
// must never take the whole server down. The per-route try/catch handles the
// common cases; this is the backstop for anything that slips past (e.g. a throw
// before a handler enters its try block).
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection (continuing)");
});

// An uncaught synchronous exception leaves undefined state — log and exit so the
// container restarts cleanly rather than limping along corrupted.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — exiting");
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  stopScheduler();
  stopAvatarTaskDispatcher();
  stopBotTaskDispatcher();
  // Abort in-flight chat runs so their cancel path persists the streamed partial
  // and ends the SSE responses (otherwise open streams would block server.close
  // until the timeout and the watched turn would be lost).
  cancelAllRuns();
  server.close(() => {
    try {
      services.store.close();
    } catch (err) {
      logger.error({ err }, "error closing store during shutdown");
    }
    logger.info("shutdown complete");
    process.exit(0);
  });
  // Hard cap: don't wait forever if a connection won't drain.
  setTimeout(() => {
    logger.warn("forced exit after shutdown timeout");
    process.exit(0);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
