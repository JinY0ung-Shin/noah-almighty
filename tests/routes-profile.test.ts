import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { CURRENT_RELEASE_ID } from "../src/server/releaseNotes.js";
import { signup, withTempDir } from "./helpers.js";

// Coverage target: src/server/routes/profile.ts — the owner's profile + settings
// endpoints (PATCH /api/me field round-trips, group-knowledge/chat-composer
// defaults, avatar image lifecycle). The non-`local` intro/hashtag generation
// paths are deliberately excluded (they require a real, networked SDK runtime;
// the `local`-runtime placeholder branches are already exercised in app.test.ts).

let tempDir: string;
const getTempDir = withTempDir("routes-profile", () => {
  tempDir = getTempDir();
});

function testApp() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return createApp(services);
}

// 1x1 transparent PNG data URL.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC";
// A jpeg-typed data URL: the route decodes bytes and never inspects image
// structure, so any valid base64 with the jpeg mime satisfies the upload.
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD";

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

describe("PATCH /api/me profile fields", () => {
  it("round-trips every accepted profile field and normalizes tags/features", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "profile-owner");

    const res = await agent
      .patch("/api/me")
      .send({
        displayName: "New Name",
        alias: "  Ally  ",
        bio: "my bio",
        persona: "helpful and terse",
        intro: "hi there",
        hashtags: ["#Alpha", "beta", "beta"],
        visibility: "private",
        // Neither is a registered experimental key ("canvas" graduated), so both drop.
        experimentalFeatures: ["canvas", "bogus"],
        sharedAccount: true,
      })
      .expect(200);

    const user = res.body.user;
    expect(user.displayName).toBe("New Name");
    expect(user.alias).toBe("Ally"); // trimmed
    expect(user.bio).toBe("my bio");
    expect(user.persona).toBe("helpful and terse");
    expect(user.intro).toBe("hi there");
    expect(user.visibility).toBe("private");
    // hashtags: normalized (no leading "#") and de-duplicated.
    expect(user.hashtags).toContain("beta");
    expect(user.hashtags.some((t: string) => t.startsWith("#"))).toBe(false);
    expect(new Set(user.hashtags).size).toBe(user.hashtags.length);
    // experimental features validated against the (now empty) registry.
    expect(user.experimentalFeatures).toEqual([]);
    expect(user.sharedAccount).toBe(true);
  });

  it("ignores fields of the wrong type instead of applying them", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "profile-types");

    await agent.patch("/api/me").send({ displayName: "Base" }).expect(200);

    // Wrong-typed fields hit the `typeof` guards' false branch and are skipped;
    // the previously-set displayName is preserved.
    const res = await agent
      .patch("/api/me")
      .send({
        displayName: 42,
        bio: null,
        hashtags: "not-an-array",
        experimentalFeatures: { canvas: true },
        sharedAccount: "yes",
        // "public" is a RETIRED visibility state — the guard skips it silently
        // (unlike the admin override PUT, which 400s), same as any invalid value.
        visibility: "public",
      })
      .expect(200);
    expect(res.body.user.displayName).toBe("Base");
    expect(res.body.user.sharedAccount).toBe(false);
    expect(res.body.user.visibility).toBe("group"); // signup default, unchanged
  });
});

describe("PUT /api/me/group-knowledge-default", () => {
  it("stores the OFF-set and rejects a non-string-array body", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "gk-owner");

    await agent
      .put("/api/me/group-knowledge-default")
      .send({ off: "nope" })
      .expect(400);
    await agent
      .put("/api/me/group-knowledge-default")
      .send({ off: [1, 2] })
      .expect(400);

    const set = await agent
      .put("/api/me/group-knowledge-default")
      .send({ off: ["group-a", "group-b"] })
      .expect(200);
    expect(set.body.user.groupKnowledgeOffDefault).toEqual([
      "group-a",
      "group-b",
    ]);

    const cleared = await agent
      .put("/api/me/group-knowledge-default")
      .send({ off: [] })
      .expect(200);
    expect(cleared.body.user.groupKnowledgeOffDefault).toEqual([]);
  });
});

describe("POST /api/me/release-seen", () => {
  it("seeds signups as caught-up and stamps the server-current release id", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "release-owner");

    // Signup seeds the then-current release, so a day-one account sees no
    // "what's new" dialog for features that predate it.
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.lastSeenRelease).toBe(CURRENT_RELEASE_ID);

    // Stamping takes no body — the server writes ITS current id (a stale
    // client bundle can neither skip ahead nor store an arbitrary value).
    const seen = await agent.post("/api/me/release-seen").expect(200);
    expect(seen.body.user.lastSeenRelease).toBe(CURRENT_RELEASE_ID);
  });

  it("requires auth", async () => {
    const app = testApp();
    await request(app).post("/api/me/release-seen").expect(401);
  });
});

describe("PUT /api/me/chat-defaults", () => {
  it("validates and stores model / effort / mcpToolGroups independently", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "cd-owner");

    // model: unknown tier → 400; a known tier → stored; null → cleared.
    await agent.put("/api/me/chat-defaults").send({ model: "bogus" }).expect(400);
    const m = await agent
      .put("/api/me/chat-defaults")
      .send({ model: "opus" })
      .expect(200);
    expect(m.body.user.modelDefault).toBe("opus");
    const mCleared = await agent
      .put("/api/me/chat-defaults")
      .send({ model: null })
      .expect(200);
    expect(mCleared.body.user.modelDefault).toBeNull();

    // effort: unknown level → 400; a known level → stored.
    await agent
      .put("/api/me/chat-defaults")
      .send({ effort: "bogus" })
      .expect(400);
    const e = await agent
      .put("/api/me/chat-defaults")
      .send({ effort: "high" })
      .expect(200);
    expect(e.body.user.effortDefault).toBe("high");
    const eCleared = await agent
      .put("/api/me/chat-defaults")
      .send({ effort: null })
      .expect(200);
    expect(eCleared.body.user.effortDefault).toBeNull();

    // mcpToolGroups: non-array → 400; array → normalized (unknown dropped);
    // null → cleared to "all on".
    await agent
      .put("/api/me/chat-defaults")
      .send({ mcpToolGroups: "no" })
      .expect(400);
    const g = await agent
      .put("/api/me/chat-defaults")
      .send({ mcpToolGroups: ["git_repo", "bogus", "ssh"] })
      .expect(200);
    expect(g.body.user.mcpToolGroupsDefault).toEqual(["git_repo", "ssh"]);
    const gCleared = await agent
      .put("/api/me/chat-defaults")
      .send({ mcpToolGroups: null })
      .expect(200);
    expect(gCleared.body.user.mcpToolGroupsDefault).toBeNull();
  });

  it("applies all three fields in one request and leaves omitted fields untouched", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "cd-combo");

    await agent
      .put("/api/me/chat-defaults")
      .send({ model: "opus", effort: "low", mcpToolGroups: ["system"] })
      .expect(200);
    // A follow-up that omits `model` must NOT reset it.
    const res = await agent
      .put("/api/me/chat-defaults")
      .send({ effort: "max" })
      .expect(200);
    expect(res.body.user.modelDefault).toBe("opus");
    expect(res.body.user.effortDefault).toBe("max");
    expect(res.body.user.mcpToolGroupsDefault).toEqual(["system"]);
  });
});

describe("avatar image routes", () => {
  it("replaces the prior file when the extension changes and serves the new type", async () => {
    const app = testApp();
    const { agent, userId } = await newUser(app, "img-owner");
    const avatarsDir = path.join(tempDir, "avatars");

    await agent
      .put("/api/me/avatar-image")
      .send({ image: PNG_DATA_URL })
      .expect(200);
    expect(fs.existsSync(path.join(avatarsDir, `${userId}.png`))).toBe(true);

    // Switching png → jpg must remove the stale .png so extensions can't linger.
    const swapped = await agent
      .put("/api/me/avatar-image")
      .send({ image: JPEG_DATA_URL })
      .expect(200);
    expect(swapped.body.hasImage).toBe(true);
    expect(fs.existsSync(path.join(avatarsDir, `${userId}.png`))).toBe(false);
    expect(fs.existsSync(path.join(avatarsDir, `${userId}.jpg`))).toBe(true);

    const served = await request(app)
      .get(`/api/users/${userId}/avatar-image`)
      .expect(200);
    expect(served.headers["content-type"]).toContain("image/jpeg");
  });

  it("404s serving an avatar with no ext, and when the ext is set but the file is gone", async () => {
    const app = testApp();
    const { agent, userId } = await newUser(app, "img-missing");

    // No image ever uploaded → no ext.
    await request(app).get(`/api/users/${userId}/avatar-image`).expect(404);

    // Upload one, then delete the file from disk behind the store's back: the ext
    // is still recorded but the file is gone (the `!fs.existsSync` 404 branch).
    await agent
      .put("/api/me/avatar-image")
      .send({ image: PNG_DATA_URL })
      .expect(200);
    fs.rmSync(path.join(tempDir, "avatars", `${userId}.png`), { force: true });
    await request(app).get(`/api/users/${userId}/avatar-image`).expect(404);
  });
});
