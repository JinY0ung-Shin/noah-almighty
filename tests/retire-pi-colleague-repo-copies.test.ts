// Trusted colleagues no longer get a copy of the avatar owner's repository in
// their own sandbox (review #11, user decision 2026-11-01). An existing
// deployment's colleague copies (`u-<colleague>/repos/<owner-seg>/<name>`,
// working tree + .git) are moved out of every sandbox's reach at boot — into
// `<PI_WORKSPACES_DIR>/.noah-retired/<stamp>/`, which no sandbox mounts — and
// never deleted; users' OWN copies stay.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import {
  PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY,
  PI_WORKSPACES_QUARANTINE_DIR,
  retirePiColleagueRepoCopies,
} from "../src/server/retirePiColleagueRepoCopies.js";
import { piUserKey } from "../src/server/agent/pi/piWorkspace.js";
import { piRepoCopyStateDir } from "../src/server/agent/pi/piRepoCopy.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-pi-colleague-copies");

function configFor(label: string): AppConfig {
  const base = loadConfig({ dataDir: path.join(tempDir(), label, "data"), agentRuntime: "local", sessionSecret: "t" });
  return {
    ...base,
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false, workspacesDir: path.join(tempDir(), label, "ws") },
  };
}

function write(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe("colleague working-repo copy retirement", () => {
  it("moves colleague copies and their records out of reach, keeps own copies, stamps the marker once", () => {
    const config = configFor("legacy");
    const ws = config.pi!.workspacesDir!;
    const store = new Store(config);
    try {
      const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
      const mateRoot = path.join(ws, piUserKey(mate.id));
      const ownerRoot = path.join(ws, piUserKey(owner.id));
      // The colleague's copy of the owner's repo (with history), and their record of it.
      write(path.join(mateRoot, "repos", owner.id, "app", "README.md"), "owner's code");
      write(path.join(mateRoot, "repos", owner.id, "app", ".git", "HEAD"), "ref: refs/heads/main\n");
      write(path.join(mateRoot, "repos", owner.id, "app.prev", "README.md"), "older");
      write(path.join(piRepoCopyStateDir(config, mate.id), `${owner.id}--app.json`), "{}");
      // The colleague's OWN copy of their own repo, and the owner's own copy: untouched.
      write(path.join(mateRoot, "repos", mate.id, "mine", "README.md"), "mate's code");
      write(path.join(piRepoCopyStateDir(config, mate.id), `${mate.id}--mine.json`), "{}");
      write(path.join(ownerRoot, "repos", owner.id, "app", "README.md"), "owner's copy");
      write(path.join(piRepoCopyStateDir(config, owner.id), `${owner.id}--app.json`), "{}");
      // A link where a foreign copy would be is never followed.
      const outside = path.join(tempDir(), "legacy", "outside");
      write(path.join(outside, "secret.txt"), "SECRET");
      fs.symlinkSync(outside, path.join(mateRoot, "repos", "linked-owner"));

      retirePiColleagueRepoCopies({ config, store });

      expect(fs.existsSync(path.join(mateRoot, "repos", owner.id))).toBe(false);
      const stamp = fs.readdirSync(path.join(ws, PI_WORKSPACES_QUARANTINE_DIR))[0]!;
      const moved = path.join(ws, PI_WORKSPACES_QUARANTINE_DIR, stamp, piUserKey(mate.id), "repos", owner.id);
      expect(fs.readFileSync(path.join(moved, "app", "README.md"), "utf8")).toBe("owner's code");
      expect(fs.readFileSync(path.join(moved, "app", ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
      expect(fs.readFileSync(path.join(moved, "app.prev", "README.md"), "utf8")).toBe("older");
      expect((fs.statSync(path.join(ws, PI_WORKSPACES_QUARANTINE_DIR)).mode & 0o777).toString(8)).toBe("700");
      // Not a sandbox root pi would ever mount.
      expect(PI_WORKSPACES_QUARANTINE_DIR).not.toMatch(/^u-[0-9a-f]{24}$/);
      expect(fs.existsSync(path.join(piRepoCopyStateDir(config, mate.id), `${owner.id}--app.json`))).toBe(false);
      expect(
        fs.existsSync(path.join(config.dataDir, "retired", stamp, "pi-repo-copies", piUserKey(mate.id), `${owner.id}--app.json`)),
      ).toBe(true);

      expect(fs.readFileSync(path.join(mateRoot, "repos", mate.id, "mine", "README.md"), "utf8")).toBe("mate's code");
      expect(fs.existsSync(path.join(piRepoCopyStateDir(config, mate.id), `${mate.id}--mine.json`))).toBe(true);
      expect(fs.readFileSync(path.join(ownerRoot, "repos", owner.id, "app", "README.md"), "utf8")).toBe("owner's copy");
      expect(fs.lstatSync(path.join(mateRoot, "repos", "linked-owner")).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");

      expect(store.getAppSecret(PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY)).toBeTruthy();
      // Marked: a later boot does nothing, even if something reappears.
      write(path.join(mateRoot, "repos", owner.id, "again", "x"), "x");
      retirePiColleagueRepoCopies({ config, store });
      expect(fs.existsSync(path.join(mateRoot, "repos", owner.id, "again", "x"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a held retirement gate moves nothing and leaves the marker unset", () => {
    const config = configFor("held");
    const ws = config.pi!.workspacesDir!;
    const store = new Store(config);
    try {
      const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
      const copy = path.join(ws, piUserKey(mate.id), "repos", owner.id, "app", "README.md");
      write(copy, "owner's code");
      const held = {
        retirementGate: () => ({ allowed: false, stamp: "x" }),
        getAppSecret: (key: string) => store.getAppSecret(key),
        setAppSecret: (key: string, value: string) => store.setAppSecret(key, value),
        listUsers: () => store.listUsers(),
      };
      retirePiColleagueRepoCopies({ config, store: held });
      expect(fs.existsSync(copy)).toBe(true);
      expect(store.getAppSecret(PI_COLLEAGUE_REPO_COPIES_RETIRED_KEY)).toBeNull();
    } finally {
      store.close();
    }
  });
});
