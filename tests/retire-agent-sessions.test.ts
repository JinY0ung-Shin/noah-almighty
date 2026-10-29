import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_SESSIONS_RETIRED_KEY, retireAgentSessions } from "../src/server/retireAgentSessions.js";
import { Store } from "../src/server/store.js";
import { loadConfig } from "../src/server/config.js";
import { withTempDir } from "./helpers.js";

describe("retireAgentSessions (boot cleanup of the removed SDK runner's CLI transcripts)", () => {
  const dir = withTempDir("retire-agent-sessions");
  const STAMP = "2026-10-29T00-00-00.000Z-abcdef";
  const quarantined = (...parts: string[]) => path.join(dir(), "retired", STAMP, ...parts);

  /** A store stand-in: the gate plus an in-memory app_config. */
  function fakeStore(allowed = true) {
    const config = new Map<string, string>();
    return {
      config,
      retirementGate: () => ({ allowed, stamp: STAMP }),
      getAppSecret: (key: string) => config.get(key) ?? null,
      setAppSecret: (key: string, value: string) => void config.set(key, value),
    };
  }
  const cfg = () => ({ dataDir: dir(), agentSessionsDir: path.join(dir(), "agent-sessions") });

  it("quarantines the whole folder (never deletes it) and stamps the marker", () => {
    const sessions = path.join(dir(), "agent-sessions");
    fs.mkdirSync(path.join(sessions, "projects", "-ws-conv"), { recursive: true });
    fs.writeFileSync(path.join(sessions, "projects", "-ws-conv", "s1.jsonl"), "{}\n");
    const store = fakeStore();
    retireAgentSessions({ config: cfg(), store });
    expect(fs.existsSync(sessions)).toBe(false);
    expect(fs.readFileSync(quarantined("agent-sessions", "projects", "-ws-conv", "s1.jsonl"), "utf8")).toBe("{}\n");
    expect(store.config.get(AGENT_SESSIONS_RETIRED_KEY)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("stamps the marker on a clean pass with nothing there, and skips every later boot", () => {
    const store = fakeStore();
    retireAgentSessions({ config: cfg(), store });
    expect(store.config.has(AGENT_SESSIONS_RETIRED_KEY)).toBe(true);
    // An older release booted in between and recreated it: the marker ends the step.
    fs.mkdirSync(path.join(dir(), "agent-sessions"));
    retireAgentSessions({ config: cfg(), store });
    expect(fs.existsSync(path.join(dir(), "agent-sessions"))).toBe(true);
    expect(fs.existsSync(path.join(dir(), "retired"))).toBe(false);
  });

  it("moves a link in its place AS a link, without following it", () => {
    const target = path.join(dir(), "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "x");
    fs.symlinkSync(target, path.join(dir(), "agent-sessions"));
    retireAgentSessions({ config: cfg(), store: fakeStore() });
    expect(fs.readlinkSync(quarantined("agent-sessions"))).toBe(target);
    expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("x");
  });

  it("leaves the folder and writes no marker on a boot whose pre-retirement backup failed", () => {
    fs.mkdirSync(path.join(dir(), "agent-sessions"));
    const store = fakeStore(false);
    retireAgentSessions({ config: cfg(), store });
    expect(fs.existsSync(path.join(dir(), "agent-sessions"))).toBe(true);
    expect(store.config.has(AGENT_SESSIONS_RETIRED_KEY)).toBe(false);
  });

  it("keeps trying on the next boot when the move is refused (no marker)", () => {
    fs.mkdirSync(path.join(dir(), "agent-sessions"));
    // A FILE where the quarantine root belongs makes the move fail.
    fs.writeFileSync(path.join(dir(), "retired"), "");
    const store = fakeStore();
    retireAgentSessions({ config: cfg(), store });
    expect(fs.existsSync(path.join(dir(), "agent-sessions"))).toBe(true);
    expect(store.config.has(AGENT_SESSIONS_RETIRED_KEY)).toBe(false);
  });

  it("works against the real store (marker in app_config)", () => {
    const config = loadConfig({ dataDir: dir(), agentRuntime: "local", sessionSecret: "t" });
    fs.mkdirSync(config.agentSessionsDir, { recursive: true });
    const store = new Store(config);
    try {
      retireAgentSessions({ config, store });
      expect(fs.existsSync(config.agentSessionsDir)).toBe(false);
      expect(store.getAppSecret(AGENT_SESSIONS_RETIRED_KEY)).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
