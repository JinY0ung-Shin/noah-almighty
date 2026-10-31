// MUST be first: loads .env into process.env before any module below reads it
// at evaluation time (auth's SECURE_COOKIES, logger's LOG_LEVEL).
import "./loadEnv.js";
import { createApp, createServices } from "./app.js";
import { createAppServer } from "./appServer.js";
import logger from "./logger.js";
import { startAvatarTaskDispatcher } from "./avatarTaskRunner.js";
import { startRoutineScheduler } from "./scheduler.js";
import { retirePersonalAgents } from "./retirePersonalAgents.js";
import { retireExternalAvatars } from "./retireExternalAvatars.js";
import { retireGroupAgents } from "./retireGroupAgents.js";
import { cancelAllRuns } from "./agent/runRegistry.js";
import { applyCustomGithubCa } from "./tlsCa.js";
import { retireCraftApps } from "./retireCraftApps.js";
import { retireGroupKnowledgeRepos } from "./retireGroupKnowledgeRepos.js";
import { retireAgentSessions } from "./retireAgentSessions.js";
import { scrubServerOnlySecretEnv } from "./secretPolicy.js";
import { sweepPiConsultationSandboxes } from "./agent/pi/piRuntime.js";
import { warnRetiredModelMapEnv } from "./agent/pi/modelCatalog.js";
import {
  deckToolchainLogFields,
  probeDeckRendering,
  probeDeckToolchain,
} from "./deckRender.js";

const services = createServices();
// The config has now read every server-only secret (SESSION_SECRET). Drop them
// from process.env so no process this server starts from here on — git,
// converters, MCP relay children — inherits them (#71). The
// image also makes the node binary execute-only, so this process itself is
// non-dumpable and its initial environment unreadable to other processes.
scrubServerOnlySecretEnv(process.env);
// Every retirement below (and the retired-table drops in the store's migrate,
// already run) works behind ONE per-boot gate: the whole DB is backed up to
// <dataDir>/backups/ first and files are MOVED to <dataDir>/retired/<stamp>/,
// never deleted; a failed backup skips them all until a later boot
// (store/retirementBackup.ts). Noah never prunes either folder.
// Purge what the removed 내 봇 feature left in this deployment (bots, their
// threads, bot-bound routines, their files) BEFORE anything can read it: the
// scheduler started below would fire a bot-bound routine as the owner's main
// avatar. A no-op once done; a failed purge throws and stops the boot.
retirePersonalAgents(services);
// Delete what the removed external avatars left (their whole conversation
// history, registry and images — user decision D4) before anything can serve
// it. A no-op once done; a failed purge throws and stops the boot.
retireExternalAvatars(services);
// Delete what the removed group shared agents left (every member's thread with
// them, their files and CLI transcripts, the agent table — decision D4) before
// anything can serve it. Groups stay. A no-op once
// done; a failed purge throws and stops the boot.
retireGroupAgents(services);
// The removed Craft apps left only a retry queue on disk; quarantine it (best effort).
retireCraftApps(services);
// The retired group knowledge repositories left Noah's clones on disk
// (<dataDir>/group-knowledge); quarantine the whole folder once (best effort; a
// marker ends it). The remote repositories are never touched.
retireGroupKnowledgeRepos(services);
// The removed Claude Agent SDK runner's CLI transcripts (<dataDir>/agent-sessions):
// quarantine the whole folder once, after the retirements above took their own
// transcripts out of it (best effort; a marker ends it).
retireAgentSessions(services);
// PI_MODEL_MAP is retired (the composer shows pi-gateway's live model list):
// while it is still set, every boot logs one warning that it is ignored.
warnRetiredModelMapEnv();
// Avatar consultations run in a sandbox of their own, removed when the run ends;
// remove the ones a crash or restart left behind (best effort).
const sweptConsultations = sweepPiConsultationSandboxes(services.config);
if (sweptConsultations > 0) {
  logger.info({ count: sweptConsultations }, "removed leftover avatar-consultation sandboxes");
}
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
  if (services.config.pi) {
    // Never the service key — only where pi is and where its broker should reach us.
    logger.info(
      {
        gatewayUrl: services.config.pi.gatewayUrl,
        workspacesDir: services.config.pi.workspacesDir ?? null,
        mcpPublicUrl: services.config.pi.mcpPublicUrl ?? null,
        deckSandbox: services.config.pi.deckSandbox,
      },
      "pi runtime configured (register the broker entries with scripts/pi-register-mcp.mjs)",
    );
  }
});

// Fire owner-scheduled routine jobs in the background.
const stopScheduler = startRoutineScheduler(services);
const stopAvatarTaskDispatcher = startAvatarTaskDispatcher(services);

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
