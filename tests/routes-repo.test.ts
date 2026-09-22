import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import {
  type GitRepoContext,
  defaultGitRepoName,
  ensureGitRepoClone,
  gitRepoClonePath,
  gitRepoContextFor,
  gitRepoContextFromRecord,
  normalizeGitRepoName,
  pushGitRepo,
  removeGitRepoClone,
} from "../src/server/gitRepos.js";
import {
  type KnowledgeRepoContext,
  ensureClone,
} from "../src/server/knowledgeRepo.js";
import { acquireActiveRepo, releaseActiveRepo } from "../src/server/activeRepoLock.js";
import { resolveActiveWorkspaceRepo } from "../src/server/activeRepoResolve.js";
import { getWorkspaceRepo, setWorkspaceRepo } from "../src/server/repoWorkspace.js";
import { generateSshKeyPair } from "../src/server/sshIdentity.js";
import { signup, makeBareRemote, withTempDir } from "./helpers.js";

// Coverage target: the repo/git surface —
//  - src/server/routes/knowledgeRepo.ts  (git-token/secret/identity + knowledge-
//    repo CRUD + contents/graph/note/refresh/selected + notifications)
//  - src/server/routes/plugins.ts        (add/patch/contents/refresh edges)
//  - src/server/gitRepos.ts              (clone/status/diff/commit/file ops)
//  - src/server/activeRepoLock.ts        (per-clone workspace lock)
//  - src/server/activeRepoResolve.ts     (open-repo → cwd resolution)
// Everything runs OFFLINE against LOCAL bare remotes: `gitAuthArgs` returns [] for
// non-https URLs, so a local path needs no credentials.

let tempDir: string;
const getTempDir = withTempDir("routes-repo", () => {
  tempDir = getTempDir();
});

function bootstrap() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return { app: createApp(services), store: services.store, config: services.config };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

/**
 * Create a bare remote on `main`, seeded with the given repo-relative files, and
 * return its path. The seed working tree is committed and pushed so a subsequent
 * clone has a real `main` branch to track.
 */
function seedRemote(
  dataDir: string,
  name: string,
  files: Record<string, string>,
): string {
  const remote = makeBareRemote(path.join(dataDir, `${name}.git`));
  const seed = path.join(dataDir, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "seed@example.com");
  g("config", "user.name", "Seed");
  g("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

// ---- knowledgeRepo.ts: git token / secret / identity ------------------------

describe("git token, secret, and identity routes", () => {
  it("sets and clears the internal git token", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "tok");

    await agent.put("/api/me/git-token").send({ token: "   " }).expect(400);
    const set = await agent
      .put("/api/me/git-token")
      .send({ token: "ghp_secret_value" })
      .expect(200);
    expect(set.body.user.gitTokenSet).toBe(true);
    const cleared = await agent.delete("/api/me/git-token").expect(200);
    expect(cleared.body.user.gitTokenSet).toBe(false);
  });

  it("validates a secret name/value, stores it, and clears it", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "sec");

    // Name must be env-var shaped (uppercase/underscore); value must be non-empty.
    await agent.put("/api/me/secrets/lowercase").send({ value: "v" }).expect(400);
    await agent.put("/api/me/secrets/MY_KEY").send({ value: "" }).expect(400);

    const set = await agent
      .put("/api/me/secrets/MY_KEY")
      .send({ value: "s3cr3t" })
      .expect(200);
    expect(set.body.user.secretNames).toContain("MY_KEY");

    const cleared = await agent.delete("/api/me/secrets/MY_KEY").expect(200);
    expect(cleared.body.user.secretNames).not.toContain("MY_KEY");
  });

  it("derives the SSH public key from a pasted private key, tolerating junk", async () => {
    const { app } = bootstrap();

    // A real ed25519 key derives a public half (stored for later display).
    const { agent } = await newUser(app, "sshpaste");
    const pair = await generateSshKeyPair("avatar-chat-fixture");
    const good = await agent
      .put("/api/me/secrets/SSH_PRIVATE_KEY")
      .send({ value: pair.privateKey })
      .expect(200);
    expect(good.body.user.secretNames).toContain("SSH_PRIVATE_KEY");
    // The derivation re-labels the comment, so compare type + key material only.
    expect(good.body.user.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(good.body.user.sshPublicKey.split(" ").slice(0, 2).join(" ")).toBe(
      pair.publicKey.split(" ").slice(0, 2).join(" "),
    );

    // An unparseable key still stores the secret but leaves the public half unset.
    const { agent: agent2 } = await newUser(app, "sshjunk");
    const junk = await agent2
      .put("/api/me/secrets/SSH_PRIVATE_KEY")
      .send({ value: "not a valid key" })
      .expect(200);
    expect(junk.body.user.secretNames).toContain("SSH_PRIVATE_KEY");
    expect(junk.body.user.sshPublicKey).toBeNull();
  });

  it("validates the commit-identity email and stores name+email", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "ident");

    await agent
      .put("/api/me/git-identity")
      .send({ name: "N", email: "bad-email" })
      .expect(400);
    const ok = await agent
      .put("/api/me/git-identity")
      .send({ name: "Author", email: "author@example.com" })
      .expect(200);
    expect(ok.body.user.gitIdentityName).toBe("Author");
    expect(ok.body.user.gitIdentityEmail).toBe("author@example.com");
  });
});

// ---- knowledgeRepo.ts: PUT /api/me/knowledge-repo ---------------------------

describe("PUT /api/me/knowledge-repo", () => {
  it("sets, rejects a malformed repo, and clears via empty/null", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "kbset");

    // owner/repo shorthand resolves to the default (github.com) internal host.
    const set = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "owner/brain", branch: "main" })
      .expect(200);
    expect(set.body.user.knowledgeRepo).toBe("owner/brain");
    expect(set.body.user.knowledgeBranch).toBe("main");

    // A string that is neither owner/repo nor a git/https URL is rejected.
    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "not a repo!!" })
      .expect(400);

    // Empty string clears.
    const clearedEmpty = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "" })
      .expect(200);
    expect(clearedEmpty.body.user.knowledgeRepo).toBeNull();

    // Re-connect, then null clears.
    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    const clearedNull = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: null })
      .expect(200);
    expect(clearedNull.body.user.knowledgeRepo).toBeNull();
  });

  // Regression (sec): `isInternalGitSource` used to return true when it could not
  // parse a host, and `looksLikeRepo` accepts anything ending in `.git`. Together
  // that let any authenticated user connect their knowledge repo to a LOCAL path —
  // e.g. another user's knowledge clone under dataDir/knowledge/<otherUserId> or a
  // group repo they are not a member of — and then read it back through
  // /contents, /note, /graph and the agent's repo/brain read tools.
  it("rejects a local filesystem path as a knowledge repo source", async () => {
    const { app, config, store } = bootstrap();
    const { agent, userId } = await newUser(app, "kblocalpath");
    const victim = await newUser(app, "kbvictim");

    // A real, clonable local repo standing in for another user's clone. Ends in
    // `.git`, so it satisfies looksLikeRepo.
    const victimClone = seedRemote(config.dataDir, "victim-brain", {
      "wiki/secret.md": "victim private note",
    });
    expect(victimClone.endsWith(".git")).toBe(true);

    const rejected = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: victimClone, branch: "main" })
      .expect(400);
    expect(rejected.body.error).toContain("사내 GitHub host");

    // The exact shape of the cross-user read: the path of another user's clone.
    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: `${path.join(config.dataDir, "knowledge", victim.userId)}/.git` })
      .expect(400);

    // Nothing was persisted, so no clone can be triggered later.
    expect(store.getUserById(userId)?.knowledgeRepo ?? null).toBeNull();
  });

  it("rejects remote-helper (scheme::) syntax as a knowledge repo source", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "kbexthelper");

    // `ext::sh -c …` makes git run an arbitrary command. It ends in `.git` here so
    // it clears looksLikeRepo, and it has no parseable host.
    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "ext::sh -c evil .git" })
      .expect(400);
  });
});

// ---- knowledgeRepo.ts: content routes (clone-backed) ------------------------

describe("knowledge-repo content routes", () => {
  it("lists repo contents, 404s without a repo, and 502s on a broken clone", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "kbcontents");

    // No repo connected yet.
    await agent.get("/api/me/knowledge-repo/contents").expect(404);

    // Connect a real (local) marketplace repo and list it.
    const remote = seedRemote(config.dataDir, "kbc", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "kbc", plugins: [] }),
    });
    store.setKnowledgeRepo(userId, remote, "main");
    const contents = await agent.get("/api/me/knowledge-repo/contents").expect(200);
    expect(contents.body.contents.kind).toBe("marketplace");

    // Point at a repo that can't be cloned → 502 (git failure is scrubbed).
    store.setKnowledgeRepo(userId, path.join(config.dataDir, "missing.git"), "main");
    await agent.get("/api/me/knowledge-repo/contents").expect(502);
  });

  it("builds the wikilink graph, 404s without a repo, and 502s on a broken clone", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "kbgraph");

    await agent.get("/api/me/knowledge-repo/graph").expect(404);

    const remote = seedRemote(config.dataDir, "kbg", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "kbg", plugins: [] }),
      "wiki/concepts/foo.md": "---\ntitle: Foo\n---\n\nRelated: [[Bar]].",
      "wiki/concepts/bar.md": "---\ntitle: Bar\n---\n\nStandalone.",
      // Structural vault files — readable, but never graph nodes.
      "wiki/index.md": "# Index\n\n- [[Foo]]",
      "wiki/log.md": "# Reflection log",
    });
    store.setKnowledgeRepo(userId, remote, "main");
    const graph = await agent.get("/api/me/knowledge-repo/graph").expect(200);
    expect(Array.isArray(graph.body.graph.nodes)).toBe(true);
    expect(graph.body.graph.nodes.length).toBe(2);
    const nodeIds = graph.body.graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).not.toContain("wiki/index.md");
    expect(nodeIds).not.toContain("wiki/log.md");
    expect(Array.isArray(graph.body.graph.edges)).toBe(true);

    store.setKnowledgeRepo(userId, path.join(config.dataDir, "missing.git"), "main");
    await agent.get("/api/me/knowledge-repo/graph").expect(502);
  });

  it("reads a vault note and gates non-vault / missing / repo-less requests", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "kbnote");

    const remote = seedRemote(config.dataDir, "kbn", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "kbn", plugins: [] }),
      "wiki/concepts/foo.md": "---\ntitle: Foo\n---\n\nHello note.",
    });
    store.setKnowledgeRepo(userId, remote, "main");

    // Missing / non-vault paths are rejected before any clone.
    await agent.get("/api/me/knowledge-repo/note").expect(400);
    await agent.get("/api/me/knowledge-repo/note?path=README.md").expect(400);

    // A real vault note is returned.
    const note = await agent
      .get("/api/me/knowledge-repo/note?path=wiki/concepts/foo.md")
      .expect(200);
    expect(note.body.note.path).toBe("wiki/concepts/foo.md");
    expect(note.body.note.content).toContain("Hello note.");

    // A vault-shaped path that doesn't exist → 404 (mapped from the fs error).
    await agent
      .get("/api/me/knowledge-repo/note?path=wiki/concepts/ghost.md")
      .expect(404);

    // A different user with no repo, valid vault path → 404 (no repo).
    const { agent: noRepo } = await newUser(app, "kbnote-empty");
    await noRepo
      .get("/api/me/knowledge-repo/note?path=wiki/concepts/foo.md")
      .expect(404);
  });

  it("refreshes a connected repo and 404s without one", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "kbrefresh");

    await agent.post("/api/me/knowledge-repo/refresh").expect(404);

    const remote = seedRemote(config.dataDir, "kbr", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "kbr", plugins: [] }),
    });
    store.setKnowledgeRepo(userId, remote, "main");
    const refreshed = await agent.post("/api/me/knowledge-repo/refresh").expect(200);
    expect(refreshed.body.contents.kind).toBe("marketplace");
  });

  it("stores the plugin selection and validates it (needs a connected repo)", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "kbselected");

    // No repo connected → 404 regardless of body.
    await agent
      .put("/api/me/knowledge-repo/selected")
      .send({ selected: null })
      .expect(404);

    // Connect a repo (no clone needed — the route only checks it's set).
    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "owner/kb", branch: "main" })
      .expect(200);

    await agent
      .put("/api/me/knowledge-repo/selected")
      .send({ selected: "not-an-array" })
      .expect(400);

    const arr = await agent
      .put("/api/me/knowledge-repo/selected")
      .send({ selected: ["alpha", "beta"] })
      .expect(200);
    expect(arr.body.user.knowledgeSelected).toEqual(["alpha", "beta"]);

    const nulled = await agent
      .put("/api/me/knowledge-repo/selected")
      .send({ selected: null })
      .expect(200);
    expect(nulled.body.user.knowledgeSelected).toBeNull();

    // Omitted `selected` is treated as null ("load all").
    const omitted = await agent
      .put("/api/me/knowledge-repo/selected")
      .send({})
      .expect(200);
    expect(omitted.body.user.knowledgeSelected).toBeNull();
  });
});

// ---- knowledgeRepo.ts: avatar notification routes ---------------------------

describe("avatar notification routes", () => {
  it("lists, reads, read-all/delete-all, and 404s unknown ids", async () => {
    const { app, store } = bootstrap();
    const { agent, userId } = await newUser(app, "notif");

    const notif = store.addAvatarNotification(userId, {
      avatarUserId: userId,
      title: "Ping",
      message: "a colleague asked you something",
    });

    const list = await agent.get("/api/me/notifications").expect(200);
    expect(list.body.notifications.length).toBe(1);
    const unread = await agent.get("/api/me/notifications?unread=1").expect(200);
    expect(unread.body.notifications.length).toBe(1);

    // Mark one read (happy), then mark-all-read.
    await agent.patch(`/api/me/notifications/${notif.id}/read`).expect(200);
    const readAll = await agent.post("/api/me/notifications/read-all").send({}).expect(200);
    expect(typeof readAll.body.changed).toBe("number");

    // Unknown ids → 404 for read + delete.
    await agent.patch("/api/me/notifications/ghost/read").expect(404);
    await agent.delete("/api/me/notifications/ghost").expect(404);

    // Delete the real one (happy), then delete-all.
    await agent.delete(`/api/me/notifications/${notif.id}`).expect(200);
    const delAll = await agent.delete("/api/me/notifications").expect(200);
    expect(typeof delAll.body.deleted).toBe("number");
  });
});

// ---- plugins.ts -------------------------------------------------------------

describe("plugins routes", () => {
  it("rejects a malformed or missing repo on add (400)", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "plug400");
    await agent.post("/api/me/plugins").send({ repo: "not a repo!!" }).expect(400);
    await agent.post("/api/me/plugins").send({}).expect(400);
  });

  it("patches selected/ref, validates selected, and 404s an unknown plugin", async () => {
    const { app, store } = bootstrap();
    const { agent, userId } = await newUser(app, "plugpatch");
    const plugin = store.addPlugin(userId, { repo: "owner/repo", label: "L" });

    const selArr = await agent
      .patch(`/api/me/plugins/${plugin.id}`)
      .send({ selected: ["alpha"] })
      .expect(200);
    expect(selArr.body.plugin.selected).toEqual(["alpha"]);

    const selNull = await agent
      .patch(`/api/me/plugins/${plugin.id}`)
      .send({ selected: null })
      .expect(200);
    expect(selNull.body.plugin.selected).toBeNull();

    await agent
      .patch(`/api/me/plugins/${plugin.id}`)
      .send({ selected: 123 })
      .expect(400);

    const refSet = await agent
      .patch(`/api/me/plugins/${plugin.id}`)
      .send({ ref: "v2" })
      .expect(200);
    expect(refSet.body.plugin.ref).toBe("v2");
    const refClear = await agent
      .patch(`/api/me/plugins/${plugin.id}`)
      .send({ ref: null })
      .expect(200);
    expect(refClear.body.plugin.ref).toBeNull();

    // Unknown id (with an otherwise-valid field) → 404.
    await agent.patch("/api/me/plugins/ghost").send({ enabled: true }).expect(404);
  });

  it("lists a plugin repo's contents from a local clone (404/502 edges)", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "plugcontents");

    await agent.get("/api/me/plugins/ghost/contents").expect(404);

    const remote = seedRemote(config.dataDir, "plugrepo", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "myplug" }),
    });
    const good = store.addPlugin(userId, { repo: remote });
    const contents = await agent
      .get(`/api/me/plugins/${good.id}/contents`)
      .expect(200);
    expect(contents.body.contents.kind).toBe("single");

    const bad = store.addPlugin(userId, { repo: path.join(config.dataDir, "missing.git") });
    await agent.get(`/api/me/plugins/${bad.id}/contents`).expect(502);
  });

  it("force-refreshes a plugin clone (404/502 edges)", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "plugrefresh");

    await agent.post("/api/me/plugins/ghost/refresh").expect(404);

    const remote = seedRemote(config.dataDir, "plugrefreshrepo", {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "myplug" }),
    });
    const good = store.addPlugin(userId, { repo: remote });
    const refreshed = await agent
      .post(`/api/me/plugins/${good.id}/refresh`)
      .expect(200);
    expect(refreshed.body.plugin.lastSyncedAt).toBeTruthy();

    const bad = store.addPlugin(userId, { repo: path.join(config.dataDir, "missing2.git") });
    await agent.post(`/api/me/plugins/${bad.id}/refresh`).expect(502);
  });
});

// ---- gitRepos.ts (direct unit tests over local bare remotes) ----------------

describe("gitRepos name + context helpers", () => {
  it("normalizes repo names and derives a default from a repo reference", () => {
    expect(normalizeGitRepoName("  My Repo  ")).toBe("my-repo");
    expect(normalizeGitRepoName("--edge--")).toBe("edge");
    expect(normalizeGitRepoName("!!!")).toBe("repo"); // sanitizes to empty → fallback

    expect(defaultGitRepoName("https://github.com/owner/Cool.Repo.git")).toBe("cool.repo");
    expect(defaultGitRepoName("git@github.com:owner/thing.git")).toBe("thing");
    expect(defaultGitRepoName("owner/repo/")).toBe("repo");
  });

  it("resolves a context from the store (null when unregistered) and from a record", () => {
    const { store, config } = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "grc", displayName: "GRC", password: "password123" });

    expect(gitRepoContextFor(store, owner.id, "nope", config)).toBeNull();

    const remote = seedRemote(config.dataDir, "ctx", { "README.md": "x" });
    store.upsertGitRepo(owner.id, "app", remote, "main");

    const ctx = gitRepoContextFor(store, owner.id, "app", config);
    expect(ctx).not.toBeNull();
    expect(ctx!.repo).toBe(remote);
    expect(ctx!.branch).toBe("main");
    expect(ctx!.token).toBeNull(); // local path is non-https → no auth token

    const record = store.getGitRepo(owner.id, "app")!;
    const fromRecord = gitRepoContextFromRecord(store, record, config);
    expect(fromRecord.userId).toBe(owner.id);
    expect(fromRecord.name).toBe("app");
    expect(fromRecord.repo).toBe(remote);
  });
});

describe("gitRepos clone safety guards", () => {
  function ctx(over: Partial<GitRepoContext>): GitRepoContext {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    return {
      userId: "u",
      name: "guard",
      repo: "owner/repo",
      branch: null,
      token: null,
      config,
      ...over,
    };
  }

  it("rejects a repo/branch that git would read as an option", async () => {
    await expect(ensureGitRepoClone(ctx({ repo: "-oProxyCommand=evil" }))).rejects.toThrow(
      /must not start with/,
    );
  });

  it("rejects remote-helper (scheme::) syntax", async () => {
    await expect(ensureGitRepoClone(ctx({ repo: "ext::sh -c evil" }))).rejects.toThrow(
      /remote-helper/,
    );
  });

  it("rejects a leading-dash branch", async () => {
    const remote = seedRemote(tempDir, "guardbranch", { "README.md": "x" });
    await expect(
      ensureGitRepoClone(ctx({ repo: remote, branch: "-x", name: "gb" })),
    ).rejects.toThrow(/must not start with/);
  });
});

// The knowledge/group clone paths used to check only for a leading dash, so
// `ext::sh -c …` reached `git clone` and only git's own default protocol policy
// refused it (T3.8). Both now share ONE validator with gitRepos above. Local
// paths must STILL clone — they are how these suites run offline.
describe("knowledge repo clone safety guards", () => {
  function kbCtx(over: Partial<KnowledgeRepoContext>): KnowledgeRepoContext {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    return {
      userId: "kbguard",
      repo: "owner/repo",
      branch: null,
      token: null,
      selected: null,
      config,
      ...over,
    };
  }

  it("rejects remote-helper (scheme::) syntax on the personal clone path", async () => {
    await expect(ensureClone(kbCtx({ repo: "ext::sh -c evil" }))).rejects.toThrow(
      /remote-helper/,
    );
  });

  it("rejects a repo git would read as an option", async () => {
    await expect(ensureClone(kbCtx({ repo: "-oProxyCommand=evil" }))).rejects.toThrow(
      /must not start with/,
    );
  });

  it("rejects a remote-helper branch", async () => {
    const remote = seedRemote(tempDir, "kbguardbranch", { "README.md": "x" });
    await expect(
      ensureClone(kbCtx({ repo: remote, branch: "ext::sh -c evil", userId: "kbguard2" })),
    ).rejects.toThrow(/remote-helper/);
  });

  it("still clones a legitimate local bare remote (offline test pattern)", async () => {
    const remote = seedRemote(tempDir, "kbguardok", { "README.md": "ok" });
    const root = await ensureClone(kbCtx({ repo: remote, branch: "main", userId: "kbguard3" }));
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("ok");
  });
});

describe("gitRepos clone / status / file operations", () => {
  function freshCtx(name: string, files: Record<string, string>): GitRepoContext {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    const remote = seedRemote(config.dataDir, `${name}-remote`, files);
    return { userId: "u", name, repo: remote, branch: "main", token: null, config };
  }

  it("syncs by fetch+rebase on the configured branch", async () => {
    const c = freshCtx("syncbranch", { "README.md": "hello" });
    await ensureGitRepoClone(c);
    // A second call with sync fetches + rebases onto origin/main (a no-op here,
    // but it exercises the branch checkout + rebase path).
    await expect(ensureGitRepoClone(c, { sync: true })).resolves.toBe(
      gitRepoClonePath(c.userId, c.name, c.config),
    );
  });

  it("clones a null-branch repo, syncs via pull --rebase, and pushes commits to the remote", async () => {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    const remote = seedRemote(config.dataDir, "nb-remote", { "README.md": "hello" });
    const c: GitRepoContext = {
      userId: "u",
      name: "nb",
      repo: remote,
      branch: null, // exercises the null-branch guard + the no-branch sync path
      token: null,
      config,
    };
    await ensureGitRepoClone(c);
    // With no configured branch, sync goes through `git pull --rebase --autostash`.
    await ensureGitRepoClone(c, { sync: true });

    // Create a local commit to push. The retired commitGitRepo MCP helper used to
    // do this; the working surface is now native git in the clone.
    const nbRoot = gitRepoClonePath(c.userId, c.name, config);
    const ng = (...a: string[]) => execFileSync("git", ["-C", nbRoot, ...a], { stdio: "pipe" });
    fs.writeFileSync(path.join(nbRoot, "pushed.md"), "content");
    ng("config", "user.email", "c@example.io");
    ng("config", "user.name", "C");
    ng("add", "-A");
    ng("commit", "-q", "-m", "add pushed");
    const branch = await pushGitRepo(c);
    expect(branch).toBe("main");

    // The remote actually received the commit.
    const verify = path.join(config.dataDir, "nb-verify");
    execFileSync("git", ["clone", "-q", remote, verify], { stdio: "pipe" });
    expect(fs.existsSync(path.join(verify, "pushed.md"))).toBe(true);
  });

  it("removes a clone from disk", async () => {
    const c = freshCtx("rmclone", { "README.md": "x" });
    await ensureGitRepoClone(c);
    const root = gitRepoClonePath(c.userId, c.name, c.config);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    await removeGitRepoClone(c);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("refuses to replace a clone whose remote changed while it has unpushed commits", async () => {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    const remoteA = seedRemote(config.dataDir, "switchA", { "README.md": "a" });
    const remoteB = seedRemote(config.dataDir, "switchB", { "README.md": "b" });
    const c: GitRepoContext = {
      userId: "u",
      name: "switch",
      repo: remoteA,
      branch: "main",
      token: null,
      config,
    };
    const root = await ensureGitRepoClone(c);
    const g = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
    g("config", "user.email", "x@y.z");
    g("config", "user.name", "X");
    g("commit", "--allow-empty", "-q", "-m", "local unpushed");

    await expect(
      ensureGitRepoClone({ ...c, repo: remoteB }),
    ).rejects.toThrow(/unpushed commits/);
  });

  it("re-clones when the remote changed and there are no unpushed commits", async () => {
    const config = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    }).config;
    const remoteA = seedRemote(config.dataDir, "swapA", { "README.md": "a" });
    const remoteB = seedRemote(config.dataDir, "swapB", { "README.md": "b" });
    const c: GitRepoContext = {
      userId: "u",
      name: "swap",
      repo: remoteA,
      branch: "main",
      token: null,
      config,
    };
    await ensureGitRepoClone(c);
    await ensureGitRepoClone({ ...c, repo: remoteB });

    const root = gitRepoClonePath(c.userId, c.name, config);
    const origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    expect(origin).toBe(remoteB);
    expect(fs.existsSync(path.join(root, "README.md"))).toBe(true);
  });
});

// ---- activeRepoLock.ts ------------------------------------------------------

describe("activeRepoLock", () => {
  it("serializes a clone path to one conversation, re-entrant for the holder", () => {
    const p = path.join(tempDir, "lock-clone-path");
    expect(acquireActiveRepo(p, "convA")).toBe(true);
    expect(acquireActiveRepo(p, "convA")).toBe(true); // holder re-acquires
    expect(acquireActiveRepo(p, "convB")).toBe(false); // held by A

    releaseActiveRepo(p, "convB"); // not the holder → no-op
    expect(acquireActiveRepo(p, "convB")).toBe(false); // still A

    releaseActiveRepo(p, "convA"); // holder releases
    expect(acquireActiveRepo(p, "convB")).toBe(true); // now free
    releaseActiveRepo(p, "convB");
  });
});

// ---- activeRepoResolve.ts ---------------------------------------------------

describe("resolveActiveWorkspaceRepo", () => {
  function setup() {
    const { store, config } = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "o", displayName: "Owner", password: "password123" });
    const avatar = { id: owner.id, displayName: "Owner", alias: "" };
    return { store, config, avatar };
  }

  it("returns kind:none when not elevated, tools disabled, or nothing opened", async () => {
    const { store, config, avatar } = setup();
    store.touchConversation(avatar.id, "conv-none", avatar.id, "hi");

    // Elevated + enabled but nothing opened.
    const none = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-none",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    expect(none.kind).toBe("none");

    // Open a repo, then confirm the two gates each short-circuit to none.
    const remote = seedRemote(config.dataDir, "wsnone", { "README.md": "x" });
    store.upsertGitRepo(avatar.id, "app", remote, "main");
    setWorkspaceRepo(store, "conv-none", "app");

    const notElevated = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-none",
      elevated: false,
      gitRepoToolsEnabled: true,
    });
    expect(notElevated.kind).toBe("none");

    const toolsOff = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-none",
      elevated: true,
      gitRepoToolsEnabled: false,
    });
    expect(toolsOff.kind).toBe("none");
  });

  it("resolves an opened repo to its clone cwd and frees the lock on release", async () => {
    const { store, config, avatar } = setup();
    const remote = seedRemote(config.dataDir, "wsok", { "README.md": "x" });
    store.upsertGitRepo(avatar.id, "app", remote, "main");
    store.touchConversation(avatar.id, "conv-ok", avatar.id, "hi");
    setWorkspaceRepo(store, "conv-ok", "app");

    const res = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-ok",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.repoName).toBe("app");
      expect(res.cwd).toBe(gitRepoClonePath(avatar.id, "app", config));
      expect(fs.existsSync(path.join(res.cwd, ".git"))).toBe(true);
      res.release();
    }

    // The lock is freed, so a fresh resolve still succeeds.
    const again = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-ok",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    expect(again.kind).toBe("ok");
    if (again.kind === "ok") again.release();
  });

  it("self-heals a dangling working-repo pointer (removed/renamed) to kind:none", async () => {
    const { store, config, avatar } = setup();
    store.touchConversation(avatar.id, "conv-nf", avatar.id, "hi");
    setWorkspaceRepo(store, "conv-nf", "ghost");

    const res = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-nf",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    // A repo removed/renamed after open_repo leaves working_repo dangling;
    // resolving falls back to scratch AND clears the stale pointer rather than
    // dead-ending the conversation with a hard error.
    expect(res.kind).toBe("none");
    expect(getWorkspaceRepo(store, "conv-nf")).toBeNull();
  });

  it("reports locked when another conversation already holds the clone", async () => {
    const { store, config, avatar } = setup();
    const remote = seedRemote(config.dataDir, "wslock", { "README.md": "x" });
    store.upsertGitRepo(avatar.id, "app", remote, "main");
    store.touchConversation(avatar.id, "conv-lock", avatar.id, "hi");
    setWorkspaceRepo(store, "conv-lock", "app");

    // A different conversation grabs the clone first.
    acquireActiveRepo(gitRepoClonePath(avatar.id, "app", config), "other-conv");

    const res = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-lock",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.reason).toBe("locked");
  });

  it("reports open_failed and frees the lock when the clone can't be created", async () => {
    const { store, config, avatar } = setup();
    store.upsertGitRepo(avatar.id, "app", path.join(tempDir, "does-not-exist.git"), "main");
    store.touchConversation(avatar.id, "conv-fail", avatar.id, "hi");
    setWorkspaceRepo(store, "conv-fail", "app");

    const res = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar,
      conversationId: "conv-fail",
      elevated: true,
      gitRepoToolsEnabled: true,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toBe("open_failed");
      expect(typeof res.detail).toBe("string");
    }
    // The lock must have been released so a retry can proceed.
    expect(
      acquireActiveRepo(gitRepoClonePath(avatar.id, "app", config), "retry-conv"),
    ).toBe(true);
  });
});
