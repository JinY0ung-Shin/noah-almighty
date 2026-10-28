import { createRequire } from "node:module";
import pino from "pino";

const level =
  process.env.LOG_LEVEL ??
  (process.env.NODE_ENV === "test" ? "silent" : "info");

// pino-pretty is a devDependency; a prod-mode-less run on an --omit=dev install
// must fall back to JSON logs instead of crashing at module load.
const prettyAvailable = (() => {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
})();

const logger = pino({
  level,
  // Defense-in-depth secret hygiene: call sites are already careful never to log
  // secret values, but redact censors them automatically if a token/secret/auth
  // header ever lands in a logged object (one nested level via the `*.` paths).
  redact: {
    paths: [
      "token",
      "*.token",
      "password",
      "*.password",
      "secret",
      "*.secret",
      "sessionSecret",
      "*.sessionSecret",
      "gitToken",
      "*.gitToken",
      "apiKey",
      "*.apiKey",
      "privateKey",
      "*.privateKey",
      "passphrase",
      "*.passphrase",
      "authorization",
      "*.authorization",
      "headers.authorization",
      "*.headers.authorization",
    ],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV !== "production" && prettyAvailable
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        }
      : undefined,
});

export default logger;
