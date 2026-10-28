/**
 * Host-side filesystem work inside a pi sandbox never follows a link the
 * sandbox planted (review C1). Each case plants a symlink at an agent-owned
 * folder between `PI_WORKSPACES_DIR/u-<key>` and the target and checks that
 * other users' workspaces (and anything else outside) are left untouched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/types.js";
import { PinnedDir, listDirVerified, readFileVerified } from "../src/server/pinnedFs.js";
import {
  deletePiConversationCopies,
  deletePiUserWorkspace,
  ensurePiConversationDir,
  moveLegacyConversationWorkspace,
  piConversationSegment,
  piUserKey,
  piWorkspaceFor,
  stagePiAttachmentFiles,
} from "../src/server/agent/pi/piWorkspace.js";
import { materializePiSkills } from "../src/server/agent/pi/piSkills.js";
import { commitPiRepoCopy, ensurePiRepoCopy, removePiRepoCopy } from "../src/server/agent/pi/piRepoCopy.js";
import {
  chatImagesDir,
  deleteStagedAttachmentCopies,
  readRegularFileAsync,
  readRegularFileSync,
  stageChatImageFilesFromAttachments,
} from "../src/server/chatImages.js";
import { saveBrowserCapture } from "../src/server/chatFiles.js";
import { gitInit, makeSkill, withTempDir } from "./helpers.js";

const dir = withTempDir("pi-sandbox-fs");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Two victims with work in their sandboxes, and an attacker whose sandbox plants links. */
function world() {
  const base = dir();
  const workspacesDir = path.join(base, "ws");
  const defaults = path.join(base, "defaults");
  makeSkill(defaults, "demo", "---\nname: demo\ndescription: d\n---", "hi");
  const config = { dataDir: path.join(base, "data"), defaultPluginsDir: defaults, pi: { workspacesDir } } as unknown as AppConfig;
  const victimRoot = (user: string) => path.join(workspacesDir, piUserKey(user));
  for (const user of ["victimA", "victimB"]) {
    const conv = path.join(victimRoot(user), "c", "conv-v");
    for (const sub of ["attachments", "captures", "confluence"]) {
      fs.mkdirSync(path.join(conv, sub), { recursive: true });
      fs.writeFileSync(path.join(conv, sub, "keep.png"), `${user} ${sub}`);
    }
    fs.writeFileSync(path.join(conv, "work.txt"), `${user} work`);
    fs.mkdirSync(path.join(victimRoot(user), ".noah", "skills", "default"), { recursive: true });
    fs.writeFileSync(path.join(victimRoot(user), ".noah", "skills", "default", "x"), "victim skill");
  }
  const attacker = piWorkspaceFor(config, "attacker", "conv-a");
  fs.mkdirSync(attacker.hostRoot!, { recursive: true });
  /** Every victim file and its content: must never change. */
  const snapshot = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (abs: string, rel: string) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const childAbs = path.join(abs, entry.name);
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(childAbs, childRel);
        else out[childRel] = entry.isSymbolicLink() ? `-> ${fs.readlinkSync(childAbs)}` : fs.readFileSync(childAbs, "utf8");
      }
    };
    for (const user of ["victimA", "victimB"]) walk(victimRoot(user), user);
    return out;
  };
  return { base, config, workspacesDir, defaults, attacker, victimRoot, snapshot, before: snapshot() };
}

describe("PinnedDir", () => {
  it("refuses a link anywhere on the way and keeps writing into the folder it pinned after a swap", () => {
    const base = dir();
    fs.mkdirSync(path.join(base, "root", "a"), { recursive: true });
    fs.mkdirSync(path.join(base, "outside"));
    fs.symlinkSync(path.join(base, "outside"), path.join(base, "root", "link"));
    expect(PinnedDir.openBelow(path.join(base, "root"), ["link"], { create: true })).toBeNull();
    expect(PinnedDir.openBelow(path.join(base, "root"), ["link", "deeper"], { create: true })).toBeNull();
    expect(PinnedDir.open(path.join(base, "root", "link"))).toBeNull();

    const pinned = PinnedDir.openBelow(path.join(base, "root"), ["a"])!;
    try {
      fs.renameSync(path.join(base, "root", "a"), path.join(base, "root", "a-moved"));
      fs.symlinkSync(path.join(base, "outside"), path.join(base, "root", "a"));
      expect(pinned.writeFileExclusive("f", "x")).toBe("written");
      expect(pinned.dir(["sub"], { create: true })).not.toBeNull();
      pinned.remove("sub");
    } finally {
      pinned.close();
    }
    expect(fs.readdirSync(path.join(base, "outside"))).toEqual([]);
    expect(fs.readdirSync(path.join(base, "root", "a-moved"))).toEqual(["f"]);
  });

  it("removes a tree without following any link inside it", () => {
    const base = dir();
    fs.mkdirSync(path.join(base, "root", "t", "deep"), { recursive: true });
    fs.mkdirSync(path.join(base, "outside"));
    fs.writeFileSync(path.join(base, "outside", "precious"), "x");
    fs.symlinkSync(path.join(base, "outside"), path.join(base, "root", "t", "deep", "link"));
    fs.symlinkSync(path.join(base, "outside", "precious"), path.join(base, "root", "t", "file-link"));
    const root = PinnedDir.open(path.join(base, "root"))!;
    root.remove("t");
    root.close();
    expect(fs.readdirSync(path.join(base, "root"))).toEqual([]);
    expect(fs.readFileSync(path.join(base, "outside", "precious"), "utf8")).toBe("x");
  });

  it("verified reads refuse a file reached through a folder swapped for a link", () => {
    const base = dir();
    fs.mkdirSync(path.join(base, "root", "a"), { recursive: true });
    fs.writeFileSync(path.join(base, "root", "a", "f.txt"), "inside");
    fs.mkdirSync(path.join(base, "outside"));
    fs.writeFileSync(path.join(base, "outside", "f.txt"), "SECRET");
    const real = fs.realpathSync(path.join(base, "root", "a", "f.txt"));
    const realDir = path.dirname(real);
    expect(readFileVerified(real, real, 1024)?.toString()).toBe("inside");
    fs.renameSync(path.join(base, "root", "a"), path.join(base, "root", "a-moved"));
    fs.symlinkSync(path.join(base, "outside"), path.join(base, "root", "a"));
    expect(readFileVerified(real, real, 1024)).toBeNull();
    expect(listDirVerified(realDir, realDir)).toBeNull();
  });
});

describe("sandbox filesystem operations never follow a planted link (review C1)", () => {
  it("skill sync through `.noah/skills -> ../..` wipes no other user's workspace and falls back to mcp", () => {
    const w = world();
    fs.mkdirSync(path.join(w.attacker.hostRoot!, ".noah"));
    fs.symlinkSync("../..", path.join(w.attacker.hostRoot!, ".noah", "skills"));
    const plan = materializePiSkills({
      config: w.config,
      workspace: w.attacker,
      pluginRoots: [{ type: "local", path: w.defaults }],
      ownerRun: true,
      disabledSkills: [],
    });
    expect(fs.readdirSync(w.workspacesDir).sort()).toEqual(
      [piUserKey("attacker"), piUserKey("victimA"), piUserKey("victimB")].sort(),
    );
    expect(w.snapshot()).toEqual(w.before);
    expect(plan.entries.map((e) => `${e.root}/${e.dir}:${e.via}`)).toEqual(["default/demo:mcp"]);
    expect(plan.mcpSources.get("default/demo")).toBe(path.join(w.defaults, "skills", "demo"));
    expect(plan.failures.join("\n")).toContain(".noah/skills");
    expect(fs.lstatSync(path.join(w.attacker.hostRoot!, ".noah", "skills")).isSymbolicLink()).toBe(true);
  });

  it("skill sync through `.noah -> another user's root` writes and removes nothing there", () => {
    const w = world();
    fs.symlinkSync(w.victimRoot("victimA"), path.join(w.attacker.hostRoot!, ".noah"));
    materializePiSkills({ config: w.config, workspace: w.attacker, pluginRoots: [{ type: "local", path: w.defaults }], ownerRun: true, disabledSkills: [] });
    expect(w.snapshot()).toEqual(w.before);
  });

  it("links planted INSIDE .noah/skills (a stale root, a skill folder) are unlinked, never descended", () => {
    const w = world();
    const roots = [{ type: "local" as const, path: w.defaults }];
    materializePiSkills({ config: w.config, workspace: w.attacker, pluginRoots: roots, ownerRun: true, disabledSkills: [] });
    const skills = path.join(w.attacker.hostRoot!, ".noah", "skills");
    fs.symlinkSync(w.victimRoot("victimA"), path.join(skills, "stale"));
    fs.rmSync(path.join(skills, "default", "demo"), { recursive: true });
    fs.symlinkSync(w.victimRoot("victimB"), path.join(skills, "default", "demo"));
    const plan = materializePiSkills({ config: w.config, workspace: w.attacker, pluginRoots: roots, ownerRun: true, disabledSkills: [] });
    expect(w.snapshot()).toEqual(w.before);
    expect(fs.existsSync(path.join(skills, "stale"))).toBe(false);
    expect(fs.readFileSync(path.join(skills, "default", "demo", "SKILL.md"), "utf8")).toContain("hi");
    expect(plan.entries[0]!.via).toBe("file");
  });

  it("the conversation folder is refused when `c` or `c/<conv>` is a link", () => {
    const w = world();
    const c = path.join(w.attacker.hostRoot!, "c");
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c"), c);
    expect(ensurePiConversationDir(w.attacker)).toBe(false);
    fs.unlinkSync(c);
    fs.mkdirSync(c);
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v"), path.join(c, piConversationSegment("conv-a")));
    expect(ensurePiConversationDir(w.attacker)).toBe(false);
    expect(fs.readdirSync(path.join(w.victimRoot("victimA"), "c"))).toEqual(["conv-v"]);
    expect(w.snapshot()).toEqual(w.before);
  });

  it("attachment staging, captures and the rewind cascade never cross a linked conversation folder", () => {
    const w = world();
    fs.mkdirSync(path.join(w.attacker.hostRoot!, "c"));
    const conv = w.attacker.hostConversationDir!;
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v"), conv);
    // A stored image for the attacker's conversation.
    const images = chatImagesDir(w.config, "conv-a");
    fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, "keep.png"), PNG);
    const attachments = [{ id: "keep", kind: "image" as const, mediaType: "image/png" as const, name: "keep.png" }];
    expect(stageChatImageFilesFromAttachments(w.config, "conv-a", conv, attachments, w.attacker.hostRoot)).toEqual([]);
    expect(saveBrowserCapture(conv, PNG, Date.now(), w.attacker.hostRoot)).toEqual({ error: "WRITE_FAILED" });
    deleteStagedAttachmentCopies(conv, attachments, w.attacker.hostRoot);
    // The pi staging path (fallback copy into attachments/).
    const outsideFile = path.join(w.base, "upload.png");
    fs.writeFileSync(outsideFile, PNG);
    expect(stagePiAttachmentFiles(w.attacker, [{ path: outsideFile, mediaType: "image/png", name: "upload.png" }])).toEqual([]);
    expect(w.snapshot()).toEqual(w.before);
  });

  it("the pi attachment copy refuses a linked attachments/ folder", () => {
    const w = world();
    expect(ensurePiConversationDir(w.attacker)).toBe(true);
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v", "attachments"), path.join(w.attacker.hostConversationDir!, "attachments"));
    const outsideFile = path.join(w.base, "keep.png");
    fs.writeFileSync(outsideFile, PNG);
    expect(stagePiAttachmentFiles(w.attacker, [{ path: outsideFile, mediaType: "image/png", name: "keep.png" }])).toEqual([]);
    expect(w.snapshot()).toEqual(w.before);
  });

  it("the D3 legacy move writes nothing through a linked conversation folder or a linked sub-folder", () => {
    const w = world();
    const legacy = path.join(w.base, "legacy");
    fs.mkdirSync(path.join(legacy, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "attachments", "keep.png"), "legacy");
    fs.writeFileSync(path.join(legacy, "work.txt"), "legacy work");
    fs.mkdirSync(path.join(w.attacker.hostRoot!, "c"));
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v"), w.attacker.hostConversationDir!);
    expect(moveLegacyConversationWorkspace(legacy, w.attacker).moved).toBe(0);

    // A real conversation folder whose `attachments` is a link: that subtree is skipped.
    fs.unlinkSync(w.attacker.hostConversationDir!);
    fs.mkdirSync(w.attacker.hostConversationDir!);
    fs.symlinkSync(path.join(w.victimRoot("victimB"), "c", "conv-v", "attachments"), path.join(w.attacker.hostConversationDir!, "attachments"));
    const moved = moveLegacyConversationWorkspace(legacy, w.attacker);
    expect(moved.moved).toBe(1); // work.txt
    expect(moved.skipped).toBe(1); // attachments/
    expect(fs.readFileSync(path.join(legacy, "attachments", "keep.png"), "utf8")).toBe("legacy");
    expect(w.snapshot()).toEqual(w.before);
  });

  it("conversation and account deletion remove links, never what they point at", () => {
    const w = world();
    const conv = w.attacker.hostConversationDir!;
    fs.mkdirSync(path.join(conv, "attachments"), { recursive: true });
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v", "attachments"), path.join(conv, "attachments", "inner"));
    fs.symlinkSync(path.join(w.victimRoot("victimA"), "c", "conv-v", "captures"), path.join(conv, "captures"));
    // A second conversation folder that IS a link to a victim's folder.
    fs.symlinkSync(path.join(w.victimRoot("victimB"), "c", "conv-v"), path.join(w.attacker.hostRoot!, "c", piConversationSegment("conv-b")));
    deletePiConversationCopies(w.workspacesDir, ["conv-a", "conv-b"], ["attachments", "captures", "confluence"]);
    expect(fs.readdirSync(conv)).toEqual([]);
    expect(w.snapshot()).toEqual(w.before);

    fs.symlinkSync(w.victimRoot("victimA"), path.join(w.attacker.hostRoot!, "evil"));
    fs.mkdirSync(path.join(w.attacker.hostRoot!, "deep", "er"), { recursive: true });
    fs.symlinkSync(w.victimRoot("victimB"), path.join(w.attacker.hostRoot!, "deep", "er", "evil"));
    deletePiUserWorkspace(w.config, "attacker");
    expect(fs.existsSync(w.attacker.hostRoot!)).toBe(false);
    expect(w.snapshot()).toEqual(w.before);
  });

  describe("working-repo copies", () => {
    function repo(w: ReturnType<typeof world>) {
      const clonePath = path.join(w.base, "clone");
      gitInit(clonePath);
      const ref = { config: w.config, workspace: w.attacker, ownerId: "owner-1", name: "app", clonePath };
      const victimCopy = path.join(w.victimRoot("victimA"), "repos", "owner-1", "app");
      fs.mkdirSync(path.join(victimCopy, ".git"), { recursive: true });
      fs.writeFileSync(path.join(victimCopy, ".git", "config"), "victim git config");
      fs.writeFileSync(path.join(victimCopy, "work.txt"), "victim uncommitted");
      return { ref, victimCopy, before: w.snapshot() };
    }

    it("a linked `repos/<owner>` is refused for create, commit and removal", async () => {
      const w = world();
      const r = repo(w);
      fs.mkdirSync(path.join(w.attacker.hostRoot!, "repos"));
      fs.symlinkSync(path.dirname(r.victimCopy), path.join(w.attacker.hostRoot!, "repos", "owner-1"));
      await expect(ensurePiRepoCopy(r.ref, "refresh")).rejects.toThrow("not a plain folder");
      expect((await commitPiRepoCopy(r.ref, "msg")).kind).toBe("no_copy");
      removePiRepoCopy(r.ref);
      expect(w.snapshot()).toEqual(r.before);
    });

    it("a link swapped in at `repos/<owner>` after the copy exists never redirects the commit's .git refresh", async () => {
      const w = world();
      const r = repo(w);
      await ensurePiRepoCopy(r.ref, "keep");
      const parent = path.join(w.attacker.hostRoot!, "repos", "owner-1");
      fs.writeFileSync(path.join(parent, "app", "README.md"), "edited");
      fs.renameSync(parent, `${parent}-moved`);
      fs.symlinkSync(path.dirname(r.victimCopy), parent);
      expect((await commitPiRepoCopy(r.ref, "msg")).kind).toBe("no_copy");
      expect(w.snapshot()).toEqual(r.before);
    });

    it("a refresh replaces a planted `<name>.prev` link without following it, and the read-back skips links", async () => {
      const w = world();
      const r = repo(w);
      await ensurePiRepoCopy(r.ref, "keep");
      const copy = path.join(w.attacker.hostRoot!, "repos", "owner-1", "app");
      fs.symlinkSync(r.victimCopy, `${copy}.prev`);
      await ensurePiRepoCopy(r.ref, "refresh");
      expect(fs.lstatSync(`${copy}.prev`).isDirectory()).toBe(true);
      expect(w.snapshot()).toEqual(r.before);

      const outside = path.join(w.base, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
      fs.symlinkSync(outside, path.join(copy, "src"));
      const outcome = await commitPiRepoCopy(r.ref, "msg");
      expect(outcome.kind).toBe("nothing");
      expect(execFileSync("git", ["-C", r.ref.clonePath, "ls-files"]).toString()).not.toContain("secret");
      removePiRepoCopy(r.ref);
      expect(fs.existsSync(copy)).toBe(false);
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("SECRET");
      expect(w.snapshot()).toEqual(r.before);
    });
  });

  it("share_file/show_file/copy_image and deck-sidecar reads refuse a folder swapped for a link after the realpath", async () => {
    const base = dir();
    const root = path.join(base, "u-root");
    fs.mkdirSync(path.join(root, "c", "deck"), { recursive: true });
    fs.writeFileSync(path.join(root, "c", "deck", "a.png"), PNG);
    const outside = path.join(base, "other-user");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "a.png"), Buffer.concat([PNG, Buffer.from("SECRET")]));
    const real = fs.realpathSync(path.join(root, "c", "deck", "a.png"));
    expect("buffer" in readRegularFileSync(real, 1024)).toBe(true);
    // The agent swaps the folder after the reader's realpath containment check.
    fs.renameSync(path.join(root, "c", "deck"), path.join(root, "c", "deck-moved"));
    fs.symlinkSync(outside, path.join(root, "c", "deck"));
    expect(readRegularFileSync(real, 1024)).toEqual({ error: "READ_FAILED" });
    expect(await readRegularFileAsync(real, 1024)).toEqual({ error: "READ_FAILED" });
  });
});
