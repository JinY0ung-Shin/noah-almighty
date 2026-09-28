import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { closeRun, openRun } from "../src/server/agent/runRegistry.js";
import logger from "../src/server/logger.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import {
  deriveShareToken,
  issueShareTicket,
  newShareTokenSalt,
  otherActiveShareLinks,
  pickShareLinkCard,
  shareTicketLinkId,
  signShareTicket,
  verifyShareTicket,
  SHARE_TICKET_TTL_MS,
} from "../src/server/shareLinks.js";
import type { Store } from "../src/server/store.js";
import type { MessageAttachment } from "../src/server/types.js";
import {
  EXPIRED_SHARE_LINK_RETENTION_DAYS,
  MAX_ACTIVE_SHARE_LINKS,
  PPTX_MEDIA_TYPE,
  SHARE_LINK_GONE_MESSAGE,
  SHARE_TICKET_TTL_MINUTES,
  SHARE_TOKEN_RE,
  type ShareLinkSummary,
  type ShareViewPayload,
} from "../src/shared/shareLinks.js";
import { signup, withTempDir } from "./helpers.js";

let tempDir: string;
const getTempDir = withTempDir("share-links", () => {
  tempDir = getTempDir();
});

const SECRET = "share-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

function boot(dataDir = tempDir, sessionSecret = SECRET) {
  // The local runtime is a deterministic stub, so a real regenerate turn runs
  // without mocking the SDK.
  const services = createServices({ dataDir, agentRuntime: "local", sessionSecret });
  return { services, app: createApp(services), store: services.store, config: services.config };
}
type Booted = ReturnType<typeof boot>;
type Agent = ReturnType<typeof request.agent>;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(64, 1)]);

async function newUser(app: Booted["app"], username: string): Promise<{ agent: Agent; id: string }> {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

/** The raw better-sqlite3 handle, for expiring/inspecting rows the API never exposes. */
function dbOf(store: Store) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}
function rowCount(store: Store, where = "1 = 1", ...params: unknown[]): number {
  return (dbOf(store).prepare(`SELECT COUNT(*) AS n FROM share_links WHERE ${where}`).get(...params) as { n: number }).n;
}
function expire(store: Store, linkId: string, agoMs = 60_000): void {
  dbOf(store).prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - agoMs).toISOString(), linkId);
}

function writeStoredFile(t: Booted, conversationId: string, id: string, ext: string, bytes: Buffer): void {
  const dir = chatFilesDir(t.config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), bytes);
}
function writeStoredImage(t: Booted, conversationId: string, id: string): void {
  const dir = chatImagesDir(t.config, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.png`), PNG);
}
function hiddenImage(t: Booted, conversationId: string, name: string, parentId?: string): MessageAttachment {
  const id = crypto.randomUUID();
  writeStoredImage(t, conversationId, id);
  return { id, kind: "image", mediaType: "image/png", name, hidden: true, ...(parentId ? { parentId } : {}) };
}

interface SeedOptions {
  /** The conversation's avatar binding (default: the owner's own avatar). */
  avatarId?: string;
  name?: string;
  /** Renders stamped with the card id (default 2). */
  slides?: number;
  slideNames?: "converter" | "libreoffice";
  /** Hidden images WITHOUT a parentId on the same message (show_file review renders). */
  unstamped?: number;
  /** Pre-parentId deck: the slides carry no parentId at all. */
  legacy?: boolean;
  /** A non-pptx card instead ("pdf" | "screenshot"). */
  kind?: "pdf" | "screenshot";
  extra?: MessageAttachment[];
}

/** Persist what a finished share_file turn leaves behind: bytes on disk + the card message. */
function seedDeck(t: Booted, ownerId: string, conversationId: string, opts: SeedOptions = {}) {
  t.store.touchConversation(ownerId, conversationId, opts.avatarId ?? ownerId, "덱 만들어 주세요");
  t.store.addMessage(conversationId, { role: "user", content: "덱 만들어 주세요" });
  const cardId = crypto.randomUUID();
  let card: MessageAttachment;
  if (opts.kind === "pdf") {
    writeStoredFile(t, conversationId, cardId, "pdf", PDF);
    card = { id: cardId, kind: "file", mediaType: "application/pdf", name: "보고서.pdf", size: PDF.length };
  } else if (opts.kind === "screenshot") {
    writeStoredFile(t, conversationId, cardId, "png", PNG);
    card = { id: cardId, kind: "file", mediaType: "image/png", name: "스크린샷.png", size: PNG.length };
  } else {
    writeStoredFile(t, conversationId, cardId, "pptx", PPTX);
    card = { id: cardId, kind: "file", mediaType: PPTX_MEDIA_TYPE, name: opts.name ?? "3분기 보고.pptx", size: PPTX.length };
  }
  const slides = Array.from({ length: opts.slides ?? 2 }, (_, i) =>
    hiddenImage(
      t,
      conversationId,
      opts.slideNames === "libreoffice" ? `slide-${i + 1}.png` : `슬라이드 ${i + 1} – 제목 ${i + 1}`,
      opts.legacy ? undefined : cardId,
    ),
  );
  const unstamped = Array.from({ length: opts.unstamped ?? 0 }, (_, i) =>
    hiddenImage(t, conversationId, `review-${i + 1}.png`),
  );
  t.store.addMessage(conversationId, {
    role: "assistant",
    content: "완성했습니다.",
    attachments: [card, ...slides, ...unstamped, ...(opts.extra ?? [])],
  });
  return { card, slides, unstamped };
}

function create(agent: Agent, conversationId: string, fileId: string, body: object = {}) {
  return agent.post(`/api/conversations/${conversationId}/files/${fileId}/share-links`).send(body);
}
function open(agent: Agent, token: unknown) {
  return agent.post("/api/share/open").send({ token });
}
function tokenOf(url: string | null): string {
  const match = /#\/share\/([A-Za-z0-9_-]{43})$/.exec(url ?? "");
  if (!match) throw new Error(`not a share url: ${url}`);
  return match[1];
}
/**
 * supertest listens on a fresh ephemeral port per request, so the absolute
 * url's origin differs between calls: compare links by their token instead.
 */
function byToken(link: ShareLinkSummary): ShareLinkSummary {
  return { ...link, url: link.url ? tokenOf(link.url) : null };
}
/** Collect a binary body (superagent leaves unknown content types unbuffered). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  // At runtime superagent hands the parser the raw response stream.
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}

/** Owner + deck + one link + a second signed-in user, the recipient fixture. */
async function linked(opts: SeedOptions = {}) {
  const t = boot();
  const owner = await newUser(t.app, "owner");
  const viewer = await newUser(t.app, "viewer");
  const deck = seedDeck(t, owner.id, "conv-deck", opts);
  const res = await create(owner.agent, "conv-deck", deck.card.id).expect(201);
  const link = res.body.link as ShareLinkSummary;
  return { t, owner, viewer, deck, link, token: tokenOf(link.url) };
}

describe("share links — owner create / reuse / list / revoke", () => {
  it("creates a link for a persisted PPTX card, reuses it while active, lists and audits it", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const deck = seedDeck(t, owner.id, "conv-deck");

    const first = await create(owner.agent, "conv-deck", deck.card.id).expect(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.created).toBe(true);
    const link = first.body.link as ShareLinkSummary;
    expect(link).toMatchObject({
      conversationId: "conv-deck",
      conversationTitle: "덱 만들어 주세요",
      fileId: deck.card.id,
      fileName: "3분기 보고.pptx",
      slideCount: 2,
      expired: false,
      viewCount: 0,
      lastViewedAt: null,
    });
    // Absolute with the request origin; the token rides the FRAGMENT.
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/share\/[A-Za-z0-9_-]{43}$/);
    expect(SHARE_TOKEN_RE.test(tokenOf(link.url))).toBe(true);
    // Default expiry: 7 days, fixed at creation.
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(7 * DAY_MS);

    // One active link per card: a second create returns it as-is.
    const again = await create(owner.agent, "conv-deck", deck.card.id, { expiresInDays: 30 }).expect(200);
    expect(again.body.created).toBe(false);
    expect(byToken(again.body.link)).toEqual(byToken(link));

    const list = await owner.agent.get("/api/me/share-links").expect(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect((list.body as ShareLinkSummary[]).map(byToken)).toEqual([byToken(link)]);
    const filtered = await owner.agent
      .get(`/api/me/share-links?conversationId=conv-deck&fileId=${deck.card.id}`)
      .expect(200);
    expect((filtered.body as ShareLinkSummary[]).map(byToken)).toEqual([byToken(link)]);
    const other = await owner.agent.get("/api/me/share-links?fileId=someone-else").expect(200);
    expect(other.body).toEqual([]);

    // Only the actual creation is audited (never the reuse).
    const audits = t.store.listAudit(owner.id, true).filter((a) => a.action === "share_link_create");
    expect(audits.map((a) => a.detail)).toEqual([`link ${link.id} "3분기 보고.pptx" 7d`]);
    // The token itself is never stored — only its hash.
    const stored = dbOf(t.store).prepare("SELECT token_hash FROM share_links").get() as { token_hash: string };
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dbOf(t.store).prepare("SELECT * FROM share_links").all())).not.toContain(tokenOf(link.url));
  });

  it("takes 1 or 30 days and rejects every other expiry", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const a = seedDeck(t, owner.id, "conv-a");
    const b = seedDeck(t, owner.id, "conv-b");

    const month = await create(owner.agent, "conv-a", a.card.id, { expiresInDays: 30 }).expect(201);
    expect(Date.parse(month.body.link.expiresAt) - Date.parse(month.body.link.createdAt)).toBe(30 * DAY_MS);
    const day = await create(owner.agent, "conv-b", b.card.id, { expiresInDays: 1 }).expect(201);
    expect(Date.parse(day.body.link.expiresAt) - Date.parse(day.body.link.createdAt)).toBe(DAY_MS);

    for (const bad of [5, 0, "7", 7.5, -1, true]) {
      const res = await create(owner.agent, "conv-a", a.card.id, { expiresInDays: bad }).expect(400);
      expect(res.body.error).toBe("유효 기간은 1일, 7일, 30일 중에서 선택해 주세요.");
    }
  });

  it("refuses non-PPTX cards and answers one 404 for strangers, unknown files and conversations", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const stranger = await newUser(t.app, "stranger");
    const deck = seedDeck(t, owner.id, "conv-deck");
    const pdf = seedDeck(t, owner.id, "conv-pdf", { kind: "pdf" });
    const shot = seedDeck(t, owner.id, "conv-shot", { kind: "screenshot" });

    for (const [cid, fileId] of [
      ["conv-pdf", pdf.card.id],
      ["conv-shot", shot.card.id],
    ] as const) {
      const res = await create(owner.agent, cid, fileId).expect(400);
      expect(res.body.error).toBe("PPTX 파일만 공유 링크를 만들 수 있습니다.");
    }
    // A hidden render is not a card either.
    await create(owner.agent, "conv-deck", deck.slides[0].id).expect(404);
    for (const [agent, cid, fileId] of [
      [stranger.agent, "conv-deck", deck.card.id],
      [owner.agent, "conv-deck", crypto.randomUUID()],
      [owner.agent, "no-such-conversation", deck.card.id],
    ] as const) {
      const res = await create(agent, cid, fileId).expect(404);
      expect(res.body.error).toBe("파일을 찾을 수 없습니다.");
    }
    // A card whose bytes are gone (e.g. swept) cannot be shared.
    fs.rmSync(path.join(chatFilesDir(t.config, "conv-deck"), `${deck.card.id}.pptx`));
    await create(owner.agent, "conv-deck", deck.card.id).expect(404);
    await request(t.app).post(`/api/conversations/conv-deck/files/${deck.card.id}/share-links`).expect(401);
    expect(rowCount(t.store)).toBe(0);
  });

  it("409s while the card is still live on a running turn, 404s once nothing is running", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    t.store.touchConversation(owner.id, "conv-live", owner.id, "덱");
    // share_file writes the bytes at once; the card persists at the turn boundary.
    const cardId = crypto.randomUUID();
    writeStoredFile(t, "conv-live", cardId, "pptx", PPTX);
    openRun("run-live", owner.id, { conversationId: "conv-live", avatarId: owner.id });
    try {
      const res = await create(owner.agent, "conv-live", cardId).expect(409);
      expect(res.body.error).toBe("응답이 끝난 뒤에 공유 링크를 만들 수 있습니다.");
    } finally {
      closeRun("run-live");
    }
    await create(owner.agent, "conv-live", cardId).expect(404);
  });

  it(`caps ACTIVE links at ${MAX_ACTIVE_SHARE_LINKS} per user; reuse and expired rows never count`, async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const kept = seedDeck(t, owner.id, "conv-kept");
    const keptLink = (await create(owner.agent, "conv-kept", kept.card.id).expect(201)).body.link as ShareLinkSummary;
    const nowIso = new Date().toISOString();
    for (let i = 1; i < MAX_ACTIVE_SHARE_LINKS; i += 1) {
      t.store.createShareLink({
        id: crypto.randomUUID(),
        ownerUserId: owner.id,
        conversationId: `conv-filler-${i}`,
        fileId: `file-${i}`,
        fileName: `filler-${i}.pptx`,
        slideIds: [],
        tokenHash: crypto.randomBytes(32).toString("hex"),
        tokenSalt: newShareTokenSalt(),
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
      });
    }
    expect(t.store.countActiveShareLinks(owner.id)).toBe(MAX_ACTIVE_SHARE_LINKS);

    const next = seedDeck(t, owner.id, "conv-next");
    const capped = await create(owner.agent, "conv-next", next.card.id).expect(409);
    expect(capped.body.error).toBe(
      `공유 링크는 최대 ${MAX_ACTIVE_SHARE_LINKS}개까지 만들 수 있습니다. 내 아바타 → 권한·연결 → 공유 링크에서 쓰지 않는 링크를 해제한 뒤 다시 시도해 주세요.`,
    );
    // The reuse path is not a new link: it still answers at the cap.
    await create(owner.agent, "conv-kept", kept.card.id).expect(200);
    // An expired link frees its slot.
    expire(t.store, keptLink.id);
    await create(owner.agent, "conv-next", next.card.id).expect(201);
    // …and the expired card needs a slot of its own again: its old link is not revived.
    const renewed = await create(owner.agent, "conv-kept", kept.card.id).expect(409);
    expect(renewed.body.error).toContain(`최대 ${MAX_ACTIVE_SHARE_LINKS}개`);
  });

  it("revokes (deletes) active and expired links, owner-scoped and audited", async () => {
    const { t, owner, viewer, link, token } = await linked();
    const stranger = viewer;
    const denied = await stranger.agent.delete(`/api/me/share-links/${link.id}`).expect(404);
    expect(denied.body.error).toBe("공유 링크를 찾을 수 없습니다.");
    await owner.agent.delete(`/api/me/share-links/${link.id}`).expect(204);
    await owner.agent.delete(`/api/me/share-links/${link.id}`).expect(404);
    expect((await owner.agent.get("/api/me/share-links").expect(200)).body).toEqual([]);
    await open(viewer.agent, token).expect(404);
    const audits = t.store.listAudit(owner.id, true).filter((a) => a.action === "share_link_revoke");
    expect(audits.map((a) => a.detail)).toEqual([`link ${link.id} "3분기 보고.pptx"`]);

    // An expired row is removable too.
    const second = seedDeck(t, owner.id, "conv-second");
    const expiredLink = (await create(owner.agent, "conv-second", second.card.id).expect(201)).body.link as ShareLinkSummary;
    expire(t.store, expiredLink.id);
    await owner.agent.delete(`/api/me/share-links/${expiredLink.id}`).expect(204);
    expect(rowCount(t.store)).toBe(0);
  });

  it("lists active links first, keeps expired ones within the retention and prunes older rows globally", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const other = await newUser(t.app, "other");
    const links: ShareLinkSummary[] = [];
    for (const cid of ["conv-1", "conv-2", "conv-3"]) {
      const deck = seedDeck(t, owner.id, cid);
      links.push((await create(owner.agent, cid, deck.card.id).expect(201)).body.link);
    }
    const theirs = seedDeck(t, other.id, "conv-other");
    const theirLink = (await create(other.agent, "conv-other", theirs.card.id).expect(201)).body.link as ShareLinkSummary;
    expire(t.store, links[0].id); // expired a minute ago: listed as expired
    expire(t.store, links[1].id, (EXPIRED_SHARE_LINK_RETENTION_DAYS + 1) * DAY_MS); // beyond the retention
    expire(t.store, theirLink.id, (EXPIRED_SHARE_LINK_RETENTION_DAYS + 1) * DAY_MS); // someone else's, too

    const list = (await owner.agent.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(list.map((l) => l.id)).toEqual([links[2].id, links[0].id]);
    expect(list[1]).toMatchObject({ expired: true, url: null });
    expect(byToken(list[0])).toMatchObject({ expired: false, url: tokenOf(links[2].url) });
    // The prune is global and one statement: the OTHER user's stale row is gone as well.
    expect(rowCount(t.store, "id = ?", links[1].id)).toBe(0);
    expect(rowCount(t.store, "id = ?", theirLink.id)).toBe(0);
    expect(rowCount(t.store)).toBe(2);
  });

  it("cannot show a link again after SESSION_SECRET changes, while recipients keep opening it", async () => {
    const dataDir = path.join(tempDir, "rotating");
    const before = boot(dataDir, "secret-one");
    const owner = await newUser(before.app, "owner");
    const deck = seedDeck(before, owner.id, "conv-deck");
    const link = (await create(owner.agent, "conv-deck", deck.card.id).expect(201)).body.link as ShareLinkSummary;
    const token = tokenOf(link.url);
    before.store.close();

    const after = boot(dataDir, "secret-two");
    const ownerAgain = request.agent(after.app);
    await ownerAgain.post("/api/auth/login").send({ username: "owner", password: "password123" }).expect(200);
    const viewer = await newUser(after.app, "viewer");
    const list = (await ownerAgain.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(list).toEqual([expect.objectContaining({ id: link.id, expired: false, url: null })]);
    const reused = await create(ownerAgain, "conv-deck", deck.card.id).expect(200);
    expect(reused.body).toMatchObject({ created: false, link: { id: link.id, url: null } });
    // Looked up by the stored hash: the old token still opens.
    const opened = await open(viewer.agent, token).expect(200);
    expect(opened.body.fileName).toBe("3분기 보고.pptx");
  });

  it("mints nothing from SESSION_SECRET plus a logged link id — before or after rotation; the salt never leaves the server", { timeout: 30_000 }, async () => {
    const dataDir = path.join(tempDir, "salted");
    const before = boot(dataDir, "secret-one");
    const owner = await newUser(before.app, "owner");
    const outsider = await newUser(before.app, "outsider");
    const deck = seedDeck(before, owner.id, "conv-deck");
    const created = await create(owner.agent, "conv-deck", deck.card.id).expect(201);
    const link = created.body.link as ShareLinkSummary;
    const token = tokenOf(link.url);
    const { tokenSalt } = before.store.getShareLink(link.id)!;
    expect(token).toBe(deriveShareToken("secret-one", link.id, tokenSalt));
    // Link ids are logged (ticket paths, audit details); the secret alone plus
    // an id — the old unsalted derivation, or any salt guess — opens nothing.
    const unsalted = crypto.createHmac("sha256", "secret-one").update(`noah-share-link:v1:${link.id}`).digest("base64url");
    const minted = [unsalted, deriveShareToken("secret-one", link.id, "")];
    for (const guess of minted) await open(outsider.agent, guess).expect(404);
    // Nor does it forge a viewer ticket for the outsider's own id.
    const exp = Math.floor((Date.now() + 10 * 60_000) / 1000);
    await outsider.agent
      .get(`/api/share/t/${signShareTicket("secret-one", { id: link.id, tokenSalt: "" }, outsider.id, exp)}/download`)
      .expect(404);
    // The salt stays in the DB: not in the create answer, the owner's list, the
    // viewer's payload or the audit trail.
    const listed = await owner.agent.get("/api/me/share-links").expect(200);
    const opened = await open(outsider.agent, token).expect(200);
    for (const body of [created.body, listed.body, opened.body, before.store.listAudit(owner.id, true)]) {
      expect(JSON.stringify(body)).not.toContain(tokenSalt);
    }
    before.store.close();

    // Rotation: the OLD secret plus the id still mints nothing, and the real
    // token keeps opening (looked up by its hash).
    const after = boot(dataDir, "secret-two");
    const outsiderAgain = request.agent(after.app);
    await outsiderAgain.post("/api/auth/login").send({ username: "outsider", password: "password123" }).expect(200);
    for (const guess of minted) await open(outsiderAgain, guess).expect(404);
    await open(outsiderAgain, token).expect(200);
  });
});

describe("share links — recipients", () => {
  it("opens for any signed-in user: slides, download, the creator's identity and a view count", async () => {
    const { t, owner, viewer, link, token } = await linked();
    const res = await open(viewer.agent, token).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const payload = res.body as ShareViewPayload;
    expect(payload).toMatchObject({
      fileName: "3분기 보고.pptx",
      ownerName: "owner",
      ownerUsername: "owner",
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      previewCapped: false,
    });
    expect(payload.slides.map((s) => ({ index: s.index, alt: s.alt }))).toEqual([
      { index: 1, alt: "슬라이드 1 – 제목 1" },
      { index: 2, alt: "슬라이드 2 – 제목 2" },
    ]);
    for (const url of [...payload.slides.map((s) => s.url), payload.downloadUrl]) {
      expect(url.startsWith("/api/share/t/")).toBe(true);
      // The token itself never rides a URL the server sees.
      expect(url).not.toContain(token);
    }

    // The owner's own opens are not views.
    await open(owner.agent, token).expect(200);
    const listed = (await owner.agent.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(listed[0].viewCount).toBe(1);
    expect(listed[0].lastViewedAt).toEqual(expect.any(String));
    await open(viewer.agent, token).expect(200);
    expect(t.store.getShareLink(link.id)!.viewCount).toBe(2);
    // A long-open viewer renewing its tickets is not another open: fresh
    // tickets, same count.
    const refreshed = await viewer.agent.post("/api/share/open").send({ token, refresh: true }).expect(200);
    expect((refreshed.body as ShareViewPayload).downloadUrl).toMatch(/^\/api\/share\/t\/[^/]+\/download$/);
    expect(t.store.getShareLink(link.id)!.viewCount).toBe(2);
    // Only a literal true marks a refresh.
    await viewer.agent.post("/api/share/open").send({ token, refresh: "true" }).expect(200);
    expect(t.store.getShareLink(link.id)!.viewCount).toBe(3);
    // No audit row per view.
    expect(t.store.listAudit(viewer.id, true).filter((a) => a.action.startsWith("share_link"))).toHaveLength(1);
  });

  it("serves slides and the deck with the specified headers, revalidating every reuse", async () => {
    const { t, owner, viewer, link, token } = await linked();
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;

    const slide = await viewer.agent.get(payload.slides[0].url).buffer(true).parse(binary).expect(200);
    expect(slide.headers["content-type"]).toBe("image/png");
    expect(slide.headers["x-content-type-options"]).toBe("nosniff");
    expect(slide.headers["cache-control"]).toBe("private, no-cache");
    expect(Buffer.compare(slide.body as Buffer, PNG)).toBe(0);
    const etag = slide.headers.etag as string;
    expect(etag).toBeTruthy();
    const revalidated = await viewer.agent.get(payload.slides[0].url).set("If-None-Match", etag).expect(304);
    expect(revalidated.headers["cache-control"]).toBe("private, no-cache");

    const deck = await viewer.agent.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);
    expect(deck.headers["content-type"]).toBe(PPTX_MEDIA_TYPE);
    expect(deck.headers["content-disposition"]).toBe(
      `attachment; filename="3_ _.pptx"; filename*=UTF-8''${encodeURIComponent("3분기 보고.pptx")}`,
    );
    expect(deck.headers["x-content-type-options"]).toBe("nosniff");
    expect(deck.headers["cache-control"]).toBe("private, no-cache");
    expect(Buffer.compare(deck.body as Buffer, PPTX)).toBe(0);

    // Revocation is immediate, even for a cached copy being revalidated.
    await owner.agent.delete(`/api/me/share-links/${link.id}`).expect(204);
    const dead = await viewer.agent.get(payload.slides[0].url).set("If-None-Match", etag).expect(404);
    expect(dead.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    expect(dead.headers["cache-control"]).toBe("no-store");
    expect(dead.headers["content-disposition"]).toBeUndefined();
    await viewer.agent.get(payload.downloadUrl).expect(404);
    expect(t.store.getShareLink(link.id)).toBeNull();
  });

  it("answers a late send failure without the file's headers — 416/412 keep their status for a VALID link", { timeout: 30_000 }, async () => {
    const { t, viewer, deck, token } = await linked();
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    const served = await viewer.agent.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);
    const fileEtag = served.headers.etag as string;
    expect(fileEtag).toBeTruthy();
    // send sets the file's headers (the `headers` option, ETag, Last-Modified,
    // Accept-Ranges) BEFORE its 412/416 checks and the open: none may survive
    // onto a JSON error. (Express gives the JSON its own ETag.)
    const withoutFileHeaders = (res: request.Response) => {
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.headers["last-modified"]).toBeUndefined();
      expect(res.headers["accept-ranges"]).toBeUndefined();
      expect(res.headers.etag).not.toBe(fileEtag);
    };

    // A download resumed at or past the end (a browser resuming a finished one).
    for (const range of [`bytes=${PPTX.length}-`, "bytes=100000-"]) {
      const res = await viewer.agent.get(payload.downloadUrl).set("Range", range);
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe(`bytes */${PPTX.length}`);
      expect(res.body.error).toBe("요청한 범위를 보낼 수 없습니다.");
      withoutFileHeaders(res);
    }
    const slideRange = await viewer.agent.get(payload.slides[0].url).set("Range", "bytes=100000-");
    expect(slideRange.status).toBe(416);
    expect(slideRange.headers["content-range"]).toBe(`bytes */${PNG.length}`);
    // A failed If-Match.
    const precondition = await viewer.agent.get(payload.downloadUrl).set("If-Match", '"nope"');
    expect(precondition.status).toBe(412);
    expect(precondition.headers["content-range"]).toBeUndefined();
    withoutFileHeaders(precondition);
    // The link was valid all along: a satisfiable range and a plain GET still stream.
    const partial = await viewer.agent.get(payload.downloadUrl).set("Range", "bytes=10-").buffer(true).parse(binary).expect(206);
    expect(partial.headers["content-range"]).toBe(`bytes 10-${PPTX.length - 1}/${PPTX.length}`);
    await viewer.agent.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);

    // The file cannot be OPENED after the checks passed — send has set its
    // headers by then — so it is the one 404, carrying none of them. Root
    // ignores permission bits, so only a non-root run can stage it.
    if (process.getuid?.() !== 0) {
      const deckPath = path.join(chatFilesDir(t.config, "conv-deck"), `${deck.card.id}.pptx`);
      fs.chmodSync(deckPath, 0o000);
      try {
        const unreadable = await viewer.agent.get(payload.downloadUrl);
        expect(unreadable.status).toBe(404);
        expect(unreadable.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
        expect(unreadable.headers["content-range"]).toBeUndefined();
        withoutFileHeaders(unreadable);
      } finally {
        fs.chmodSync(deckPath, 0o644);
      }
    }
  });

  // ~35 sequential round-trips: fast alone (<1 s), but past the 5 s default
  // under the full parallel suite — the skill-share.test.ts precedent.
  it("answers 404 — never 401 — to a signed-in viewer for every invalid state", { timeout: 30_000 }, async () => {
    const { t, owner, viewer, deck, link, token } = await linked();
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    const expectGone = async (res: request.Response) => {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    };

    // Malformed or unknown tokens (the regex runs before any lookup).
    for (const bad of ["", "short", `${token}x`, token.replace(/.$/, "."), 42, null, crypto.randomBytes(32).toString("base64url")]) {
      await expectGone(await open(viewer.agent, bad));
    }
    await expectGone(await viewer.agent.post("/api/share/open").send({}));
    // Slide indexes: strict digits, 1-based, inside the snapshot.
    const base = payload.slides[0].url.replace(/\/slides\/1$/, "");
    for (const index of ["0", "3", "01", "1a", "100", "-1"]) {
      await expectGone(await viewer.agent.get(`${base}/slides/${index}`));
    }

    // The creator suspended → dead; reinstated → alive again.
    t.store.setSuspended(owner.id, true);
    await expectGone(await open(viewer.agent, token));
    await expectGone(await viewer.agent.get(payload.slides[0].url));
    t.store.setSuspended(owner.id, false);
    await open(viewer.agent, token).expect(200);

    // Expired.
    expire(t.store, link.id);
    await expectGone(await open(viewer.agent, token));
    await expectGone(await viewer.agent.get(payload.downloadUrl));
    dbOf(t.store).prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(link.expiresAt, link.id);
    await open(viewer.agent, token).expect(200);

    // A render or the deck deleted on disk.
    fs.rmSync(path.join(chatImagesDir(t.config, "conv-deck"), `${deck.slides[1].id}.png`));
    await expectGone(await viewer.agent.get(payload.slides[1].url));
    await viewer.agent.get(payload.slides[0].url).expect(200);
    // The send itself failing after the checks passed (here: the entry turned
    // into a directory) is mapped to the same 404 by sendFile's callback —
    // never the app's 500 handler, whose log line would carry the ticket path.
    const slidePath = path.join(chatImagesDir(t.config, "conv-deck"), `${deck.slides[0].id}.png`);
    fs.rmSync(slidePath);
    fs.mkdirSync(slidePath);
    const failedSend = await viewer.agent.get(payload.slides[0].url);
    await expectGone(failedSend);
    expect(failedSend.headers["cache-control"]).toBe("no-store");
    fs.rmdirSync(slidePath);
    fs.writeFileSync(slidePath, PNG);
    await viewer.agent.get(payload.slides[0].url).expect(200);
    fs.rmSync(path.join(chatFilesDir(t.config, "conv-deck"), `${deck.card.id}.pptx`));
    await expectGone(await open(viewer.agent, token));
    await expectGone(await viewer.agent.get(payload.downloadUrl));

    // Signed OUT is the one 401 (the viewer then shows the login screen).
    await request(t.app).post("/api/share/open").send({ token }).expect(401);
  });

  it("dies with its conversation", async () => {
    const { owner, viewer, token, t } = await linked();
    await owner.agent.delete("/api/conversations/conv-deck").expect(200);
    const res = await open(viewer.agent, token).expect(404);
    expect(res.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    expect(rowCount(t.store)).toBe(0);
  });

  it("binds tickets to the viewer, expires them and rejects tampering", async () => {
    const { t, viewer, link, token } = await linked();
    const third = await newUser(t.app, "third");
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    await viewer.agent.get(payload.slides[0].url).expect(200);

    // Someone else presenting the viewer's ticket.
    await third.agent.get(payload.slides[0].url).expect(404);
    await third.agent.get(payload.downloadUrl).expect(404);

    const ticket = /\/api\/share\/t\/([^/]+)\/download$/.exec(payload.downloadUrl)![1];
    const [linkId, exp, sig] = ticket.split("~");
    expect(linkId).toBe(link.id);
    // Tickets are signed over the ROW (its id and salt): re-signing with the
    // row reproduces the server's ticket, so the 404s below are the tampering.
    const row = t.store.getShareLink(link.id)!;
    expect(signShareTicket(SECRET, row, viewer.id, Number(exp))).toBe(ticket);
    // Expired (a validly signed ticket from the past).
    const past = Math.floor((Date.now() - 1000) / 1000);
    await viewer.agent.get(`/api/share/t/${signShareTicket(SECRET, row, viewer.id, past)}/download`).expect(404);
    // Signed far beyond the TTL (only the server mints tickets).
    const far = Math.floor((Date.now() + 10 * SHARE_TICKET_TTL_MS) / 1000);
    await viewer.agent.get(`/api/share/t/${signShareTicket(SECRET, row, viewer.id, far)}/download`).expect(404);
    // Tampered: another signature, another expiry, another link, a foreign
    // secret, garbage — and the RIGHT secret and link id without the row's
    // salt, which is all SESSION_SECRET plus a logged ticket path would give.
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    for (const forged of [
      `${linkId}~${exp}~${flipped}`,
      `${linkId}~${Number(exp) + 1}~${sig}`,
      `${crypto.randomUUID()}~${exp}~${sig}`,
      signShareTicket("another-secret", row, viewer.id, Number(exp)),
      signShareTicket(SECRET, { id: link.id, tokenSalt: "" }, viewer.id, Number(exp)),
      signShareTicket(SECRET, { id: link.id, tokenSalt: newShareTokenSalt() }, viewer.id, Number(exp)),
      "garbage",
      `${linkId}~0${exp}~${sig}`,
    ]) {
      const res = await viewer.agent.get(`/api/share/t/${forged}/download`).expect(404);
      expect(res.body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    }
  });

  it("serves ONLY the renders stamped with the card id — never unstamped hidden images", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    // One message: the deck, its 2 stamped renders, 2 show_file review renders
    // (hidden, no parentId), and a SECOND card with a render of its own.
    const otherCardId = crypto.randomUUID();
    writeStoredFile(t, "conv-mixed", otherCardId, "pptx", PPTX);
    const otherCard: MessageAttachment = { id: otherCardId, kind: "file", mediaType: PPTX_MEDIA_TYPE, name: "다른 덱.pptx", size: PPTX.length };
    t.store.touchConversation(owner.id, "conv-mixed", owner.id, "덱");
    const otherRender = hiddenImage(t, "conv-mixed", "슬라이드 1 – 다른 덱", otherCardId);
    const deck = seedDeck(t, owner.id, "conv-mixed", { unstamped: 2, extra: [otherCard, otherRender] });

    const link = (await create(owner.agent, "conv-mixed", deck.card.id).expect(201)).body.link as ShareLinkSummary;
    expect(link.slideCount).toBe(2);
    const stored = t.store.getShareLink(link.id)!;
    expect(stored.slideIds).toEqual(deck.slides.map((s) => s.id));
    const payload = (await open(viewer.agent, tokenOf(link.url)).expect(200)).body as ShareViewPayload;
    expect(payload.slides).toHaveLength(2);
    const base = payload.slides[0].url.replace(/\/slides\/1$/, "");
    await viewer.agent.get(`${base}/slides/3`).expect(404);
    await viewer.agent.get(`${base}/slides/4`).expect(404);

    // A legacy deck (renders without parentId) is shared download-only.
    const legacy = seedDeck(t, owner.id, "conv-legacy", { legacy: true, unstamped: 1 });
    const legacyLink = (await create(owner.agent, "conv-legacy", legacy.card.id).expect(201)).body.link as ShareLinkSummary;
    expect(legacyLink.slideCount).toBe(0);
    const legacyPayload = (await open(viewer.agent, tokenOf(legacyLink.url)).expect(200)).body as ShareViewPayload;
    expect(legacyPayload.slides).toEqual([]);
    expect(legacyPayload.previewCapped).toBe(false);
    await viewer.agent.get(legacyPayload.downloadUrl).expect(200);
  });

  it("caps the previews at 30 and flags it; LibreOffice pages get plain numbered alt text", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const big = seedDeck(t, owner.id, "conv-big", { slides: 32 });
    const bigLink = (await create(owner.agent, "conv-big", big.card.id).expect(201)).body.link as ShareLinkSummary;
    expect(bigLink.slideCount).toBe(30);
    const bigPayload = (await open(viewer.agent, tokenOf(bigLink.url)).expect(200)).body as ShareViewPayload;
    expect(bigPayload.slides).toHaveLength(30);
    expect(bigPayload.previewCapped).toBe(true);

    const lo = seedDeck(t, owner.id, "conv-lo", { slideNames: "libreoffice" });
    const loLink = (await create(owner.agent, "conv-lo", lo.card.id).expect(201)).body.link as ShareLinkSummary;
    const loPayload = (await open(viewer.agent, tokenOf(loLink.url)).expect(200)).body as ShareViewPayload;
    expect(loPayload.slides.map((s) => s.alt)).toEqual(["슬라이드 1", "슬라이드 2"]);
  });
});

describe("share links — download names", () => {
  /** Both Content-Disposition names — the ASCII `filename` and the RFC 5987 `filename*`. */
  function dispositionNames(header: string): { ascii: string; utf8: string } {
    const match = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/.exec(header);
    if (!match) throw new Error(`unexpected Content-Disposition: ${header}`);
    return { ascii: match[1], utf8: decodeURIComponent(match[2]) };
  }

  it("never stores or serves a link's deck under anything but .pptx", { timeout: 30_000 }, async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const cases: Array<[string, string, string]> = [
      // A 205-char card name, as share_file stored a 200-char "….jar" before
      // its own cap: a plain 200-char cut dropped exactly the forced ".pptx".
      ["conv-long", `${"x".repeat(196)}.jar.pptx`, `${"x".repeat(195)}.pptx`],
      // A bidi override would DISPLAY "…raj.pptx" for a name ending in ".jar".
      ["conv-bidi", "invoice‮tpp.jar.pptx", "invoicetpp.jar.pptx"],
    ];
    for (const [cid, cardName, served] of cases) {
      const deck = seedDeck(t, owner.id, cid, { name: cardName });
      const link = (await create(owner.agent, cid, deck.card.id).expect(201)).body.link as ShareLinkSummary;
      expect(link.fileName).toBe(served);
      expect(t.store.getShareLink(link.id)!.fileName).toBe(served);
      const payload = (await open(viewer.agent, tokenOf(link.url)).expect(200)).body as ShareViewPayload;
      expect(payload.fileName).toBe(served);
      const download = await viewer.agent.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);
      const names = dispositionNames(download.headers["content-disposition"] as string);
      expect(names.utf8).toBe(served);
      expect(names.ascii).toMatch(/\.pptx$/);
    }

    // Defence in depth: a row whose name lacks the extension (written around
    // the service) is still served as .pptx — the bytes always are one.
    const raw = seedDeck(t, owner.id, "conv-raw");
    const id = crypto.randomUUID();
    const tokenSalt = newShareTokenSalt();
    const token = deriveShareToken(SECRET, id, tokenSalt);
    t.store.createShareLink({
      id,
      ownerUserId: owner.id,
      conversationId: "conv-raw",
      fileId: raw.card.id,
      fileName: "보고서.jar",
      slideIds: [],
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      tokenSalt,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    const rawPayload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    expect(rawPayload.fileName).toBe("보고서.jar.pptx");
    const rawDownload = await viewer.agent.get(rawPayload.downloadUrl).buffer(true).parse(binary).expect(200);
    expect(dispositionNames(rawDownload.headers["content-disposition"] as string)).toEqual({
      ascii: "_.jar.pptx",
      utf8: "보고서.jar.pptx",
    });
  });

  it("keeps the stored file's extension on the owner's own download, whatever ?name= says", { timeout: 30_000 }, async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const deck = seedDeck(t, owner.id, "conv-own");
    const nameFor = async (name?: string) => {
      const res = await owner.agent
        .get(`/api/conversations/conv-own/files/${deck.card.id}`)
        .query(name === undefined ? {} : { name })
        .buffer(true)
        .parse(binary)
        .expect(200);
      return dispositionNames(res.headers["content-disposition"] as string).utf8;
    };
    expect(await nameFor(`${"x".repeat(196)}.jar.pptx`)).toBe(`${"x".repeat(195)}.pptx`);
    expect(await nameFor("evil.jar")).toBe("evil.jar.pptx");
    expect(await nameFor("invoice‮tpp.jar.pptx")).toBe("invoicetpp.jar.pptx");
    expect(await nameFor("3분기 보고.PPTX")).toBe("3분기 보고.PPTX");
    expect(await nameFor()).toBe("file.pptx");
    // An emoji straddling the cut: never half a surrogate pair, which would
    // make the header's encodeURIComponent throw (a 500).
    expect(await nameFor(`${"가".repeat(199)}😀`)).toBe(`${"가".repeat(195)}.pptx`);
  });
});

describe("share links — which threads can share", () => {
  it("refuses group-agent member threads, and never serves a row that points into one", async () => {
    const t = boot();
    const member = await newUser(t.app, "member");
    const viewer = await newUser(t.app, "viewer");
    const group = t.store.createGroup({ name: "플랫폼" });
    t.store.addGroupMember(group.id, member.id);
    const agent = t.store.createGroupAgent(group.id, { displayName: "팀 비서" })!;
    const deck = seedDeck(t, member.id, "conv-ga", { avatarId: `group:${group.id}:${agent.id}` });
    const res = await create(member.agent, "conv-ga", deck.card.id).expect(404);
    expect(res.body.error).toBe("파일을 찾을 수 없습니다.");

    // A row that got in some other way still never opens.
    const id = crypto.randomUUID();
    const tokenSalt = newShareTokenSalt();
    const token = deriveShareToken(SECRET, id, tokenSalt);
    t.store.createShareLink({
      id,
      ownerUserId: member.id,
      conversationId: "conv-ga",
      fileId: deck.card.id,
      fileName: "팀 덱.pptx",
      slideIds: [],
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      tokenSalt,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    await open(viewer.agent, token).expect(404);
  });

  it("shares a deck from the owner's own bot thread", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner"); // first signup = admin (the bot feature gate)
    const viewer = await newUser(t.app, "viewer");
    const bot = t.store.createPersonalAgent(owner.id, { displayName: "리서치 봇" });
    const deck = seedDeck(t, owner.id, "conv-bot", { avatarId: personalAgentAvatarId(owner.id, bot.id) });
    const link = (await create(owner.agent, "conv-bot", deck.card.id).expect(201)).body.link as ShareLinkSummary;
    await open(viewer.agent, tokenOf(link.url)).expect(200);
  });

  it("lets a colleague share their own thread's deck only while the avatar stays reachable", async () => {
    const t = boot();
    const avatarOwner = await newUser(t.app, "avatarowner");
    const colleague = await newUser(t.app, "colleague");
    const viewer = await newUser(t.app, "viewer");
    const group = t.store.createGroup({ name: "팀" });
    t.store.addGroupMember(group.id, avatarOwner.id);
    t.store.addGroupMember(group.id, colleague.id);
    // The colleague's OWN thread with the avatar owner's avatar.
    const deck = seedDeck(t, colleague.id, "conv-colleague", { avatarId: avatarOwner.id });
    // Only the conversation owner creates — never the avatar's owner.
    await create(avatarOwner.agent, "conv-colleague", deck.card.id).expect(404);
    const link = (await create(colleague.agent, "conv-colleague", deck.card.id).expect(201)).body.link as ShareLinkSummary;
    const token = tokenOf(link.url);
    await open(viewer.agent, token).expect(200);

    // The colleague leaves the group: the avatar is out of reach, so is the link.
    t.store.removeGroupMember(group.id, colleague.id);
    await open(viewer.agent, token).expect(404);
    await create(colleague.agent, "conv-colleague", deck.card.id).expect(404);
    t.store.addGroupMember(group.id, colleague.id);
    await open(viewer.agent, token).expect(200);
    // The avatar goes private → unreachable again; suspended → likewise.
    t.store.updateProfile(avatarOwner.id, { visibility: "private" });
    await open(viewer.agent, token).expect(404);
    t.store.updateProfile(avatarOwner.id, { visibility: "group" });
    await open(viewer.agent, token).expect(200);
    t.store.setSuspended(avatarOwner.id, true);
    await open(viewer.agent, token).expect(404);
  });
});

describe("share links — cascades", () => {
  /** Insert a link straight into the store (bypasses the thread-kind check on purpose). */
  function rawLink(store: Store, ownerUserId: string, conversationId: string, fileId = crypto.randomUUID()): string {
    const id = crypto.randomUUID();
    store.createShareLink({
      id,
      ownerUserId,
      conversationId,
      fileId,
      fileName: "deck.pptx",
      slideIds: [],
      tokenHash: crypto.randomBytes(32).toString("hex"),
      tokenSalt: newShareTokenSalt(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    return id;
  }

  it("single and bulk conversation deletes drop the links", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    for (const cid of ["conv-1", "conv-2", "conv-3"]) {
      const deck = seedDeck(t, owner.id, cid);
      await create(owner.agent, cid, deck.card.id).expect(201);
    }
    await owner.agent.delete("/api/conversations/conv-1").expect(200);
    expect(rowCount(t.store, "conversation_id = ?", "conv-1")).toBe(0);
    expect(rowCount(t.store)).toBe(2);
    await owner.agent.delete("/api/conversations").expect(200);
    expect(rowCount(t.store)).toBe(0);
  });

  it("deleteUser drops links in both directions", async () => {
    const t = boot();
    const doomed = await newUser(t.app, "doomed");
    const colleague = await newUser(t.app, "colleague");
    const bystander = await newUser(t.app, "bystander");
    const group = t.store.createGroup({ name: "팀" });
    t.store.addGroupMember(group.id, doomed.id);
    t.store.addGroupMember(group.id, colleague.id);
    // (a) links the doomed user created in their own thread…
    const own = seedDeck(t, doomed.id, "conv-own");
    await create(doomed.agent, "conv-own", own.card.id).expect(201);
    // …plus a stray row pointing elsewhere (by owner, not by conversation).
    rawLink(t.store, doomed.id, "conv-elsewhere");
    // (b) a colleague's link on THEIR thread with the doomed user's avatar.
    const theirs = seedDeck(t, colleague.id, "conv-with-doomed", { avatarId: doomed.id });
    await create(colleague.agent, "conv-with-doomed", theirs.card.id).expect(201);
    // Unrelated links survive.
    const safe = seedDeck(t, bystander.id, "conv-safe");
    await create(bystander.agent, "conv-safe", safe.card.id).expect(201);

    expect(t.store.deleteUser(doomed.id)).toBe(true);
    expect(rowCount(t.store, "owner_user_id = ?", doomed.id)).toBe(0);
    expect(rowCount(t.store, "conversation_id = ?", "conv-with-doomed")).toBe(0);
    expect(rowCount(t.store)).toBe(1);
    expect(rowCount(t.store, "owner_user_id = ?", bystander.id)).toBe(1);
  });

  it("group-agent, bot and group deletes drop the links of their threads", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const group = t.store.createGroup({ name: "플랫폼" });
    t.store.addGroupMember(group.id, owner.id);
    const agentA = t.store.createGroupAgent(group.id, { displayName: "비서 A" })!;
    const agentB = t.store.createGroupAgent(group.id, { displayName: "비서 B" })!;
    t.store.touchConversation(owner.id, "conv-ga-a", `group:${group.id}:${agentA.id}`, "안녕");
    t.store.touchConversation(owner.id, "conv-ga-b", `group:${group.id}:${agentB.id}`, "안녕");
    rawLink(t.store, owner.id, "conv-ga-a");
    rawLink(t.store, owner.id, "conv-ga-b");
    const bot = t.store.createPersonalAgent(owner.id, { displayName: "봇" });
    t.store.touchConversation(owner.id, "conv-bot", personalAgentAvatarId(owner.id, bot.id), "안녕");
    rawLink(t.store, owner.id, "conv-bot");
    const kept = seedDeck(t, owner.id, "conv-kept");
    await create(owner.agent, "conv-kept", kept.card.id).expect(201);

    expect(t.store.deleteGroupAgent(agentA.id)).toBe(true);
    expect(rowCount(t.store, "conversation_id = ?", "conv-ga-a")).toBe(0);
    expect(rowCount(t.store, "conversation_id = ?", "conv-ga-b")).toBe(1);
    expect(t.store.deletePersonalAgent(bot.id)).toBe(true);
    expect(rowCount(t.store, "conversation_id = ?", "conv-bot")).toBe(0);
    expect(t.store.deleteGroup(group.id)).toBe(true);
    expect(rowCount(t.store, "conversation_id = ?", "conv-ga-b")).toBe(0);
    expect(rowCount(t.store)).toBe(1);
  });

  it("regenerate drops the links of the replaced turn's decks", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const earlier = seedDeck(t, owner.id, "conv-regen", { name: "초안.pptx" });
    const earlierLink = (await create(owner.agent, "conv-regen", earlier.card.id).expect(201)).body.link as ShareLinkSummary;
    const replaced = seedDeck(t, owner.id, "conv-regen", { name: "최종.pptx" });
    const replacedLink = (await create(owner.agent, "conv-regen", replaced.card.id).expect(201)).body.link as ShareLinkSummary;

    await owner.agent
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, conversationId: "conv-regen", message: "덱 만들어 주세요", regenerate: true })
      .expect(200);

    expect(rowCount(t.store, "id = ?", replacedLink.id)).toBe(0);
    await open(viewer.agent, tokenOf(replacedLink.url)).expect(404);
    // Only the replaced turn: the earlier deck's link survives.
    await open(viewer.agent, tokenOf(earlierLink.url)).expect(200);
  });
});

describe("share links — service units", () => {
  it("derives a 43-char token per (secret, link id, row salt) and keeps it out of storage", () => {
    const id = crypto.randomUUID();
    const salt = newShareTokenSalt();
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 random bytes
    expect(newShareTokenSalt()).not.toBe(salt);
    const token = deriveShareToken(SECRET, id, salt);
    expect(SHARE_TOKEN_RE.test(token)).toBe(true);
    expect(deriveShareToken(SECRET, id, salt)).toBe(token);
    expect(deriveShareToken("other", id, salt)).not.toBe(token);
    expect(deriveShareToken(SECRET, crypto.randomUUID(), salt)).not.toBe(token);
    // The secret and the id alone are not enough: the row's salt is part of it.
    expect(deriveShareToken(SECRET, id, newShareTokenSalt())).not.toBe(token);
    expect(deriveShareToken(SECRET, id, "")).not.toBe(token);
  });

  it("verifies tickets strictly: row and salt, viewer, expiry, exact format", () => {
    // The lifetime is the ONE shared constant the viewer's refresh keys on.
    expect(SHARE_TICKET_TTL_MS).toBe(SHARE_TICKET_TTL_MINUTES * 60 * 1000);
    const now = Date.parse("2026-09-29T00:00:00Z");
    const link = { id: crypto.randomUUID(), tokenSalt: newShareTokenSalt() };
    const ticket = issueShareTicket(SECRET, link, "viewer-1", now);
    // The link id is read BEFORE the MAC check (the row, salt included, is
    // loaded by it) — strictly, and only inside the ticket's lifetime.
    expect(shareTicketLinkId(ticket, now)).toBe(link.id);
    expect(shareTicketLinkId(ticket, now + SHARE_TICKET_TTL_MS)).toBeNull();
    expect(shareTicketLinkId(`${ticket}x`, now)).toBeNull();
    expect(verifyShareTicket(SECRET, ticket, link, "viewer-1", now)).toBe(true);
    expect(verifyShareTicket(SECRET, ticket, link, "viewer-1", now + SHARE_TICKET_TTL_MS - 1000)).toBe(true);
    expect(verifyShareTicket(SECRET, ticket, link, "viewer-1", now + SHARE_TICKET_TTL_MS)).toBe(false);
    expect(verifyShareTicket(SECRET, ticket, link, "viewer-2", now)).toBe(false);
    expect(verifyShareTicket("other", ticket, link, "viewer-1", now)).toBe(false);
    expect(verifyShareTicket(SECRET, ticket, { ...link, tokenSalt: newShareTokenSalt() }, "viewer-1", now)).toBe(false);
    expect(verifyShareTicket(SECRET, ticket, { ...link, id: crypto.randomUUID() }, "viewer-1", now)).toBe(false);
    expect(verifyShareTicket(SECRET, ticket.toUpperCase(), link, "viewer-1", now)).toBe(false);
    expect(verifyShareTicket(SECRET, `${ticket}x`, link, "viewer-1", now)).toBe(false);
  });

  it("picks the card an avatar means: this turn first, the latest deck, or an explicit id", () => {
    const deck = (name: string): MessageAttachment => ({ id: crypto.randomUUID(), kind: "file", mediaType: PPTX_MEDIA_TYPE, name });
    const render = (parentId: string): MessageAttachment => ({ id: crypto.randomUUID(), kind: "image", mediaType: "image/png", hidden: true, parentId });
    const pdf: MessageAttachment = { id: crypto.randomUUID(), kind: "file", mediaType: "application/pdf", name: "보고서.pdf" };
    const older = deck("초안.pptx");
    const draft = deck("리뷰.pptx");
    const final = deck("리뷰.pptx");
    const thisTurn = [draft, render(draft.id), final, render(final.id), pdf];
    const persisted = [[older, render(older.id)]];

    // The latest batch holds ONE deck (re-shared twice): its latest card.
    expect(pickShareLinkCard([thisTurn, ...persisted])).toEqual({ card: final, attachments: thisTurn });
    // Nothing this turn: the newest persisted deck.
    expect(pickShareLinkCard([[], ...persisted])).toEqual({ card: older, attachments: persisted[0] });
    // Explicit ids, this turn first then persisted.
    expect(pickShareLinkCard([thisTurn, ...persisted], older.id)).toEqual({ card: older, attachments: persisted[0] });
    expect(pickShareLinkCard([thisTurn, ...persisted], draft.id)).toEqual({ card: draft, attachments: thisTurn });

    const errorOf = (result: ReturnType<typeof pickShareLinkCard>) => ("error" in result ? result.error : "PICKED");
    // Several DIFFERENT decks most recently: ask, listing them by name and id.
    const two = [deck("영업.pptx"), deck("인사.pptx")];
    const ambiguous = errorOf(pickShareLinkCard([two]));
    expect(ambiguous).toContain("pass attachmentId");
    expect(ambiguous).toContain(`"영업.pptx" (attachment id: ${two[0].id})`);
    expect(ambiguous).toContain(`"인사.pptx" (attachment id: ${two[1].id})`);
    // Not a deck / not here / not an id / nothing at all.
    expect(errorOf(pickShareLinkCard([thisTurn], pdf.id))).toContain('only be created for PPTX decks, and "보고서.pdf" is not one');
    // A hidden render's id is not a card id.
    expect(errorOf(pickShareLinkCard([thisTurn], thisTurn[1].id))).toContain("No file card with attachment id");
    expect(errorOf(pickShareLinkCard([thisTurn], crypto.randomUUID()))).toContain(`"리뷰.pptx" (attachment id: ${final.id})`);
    expect(errorOf(pickShareLinkCard([thisTurn], "../../etc"))).toContain("not a valid attachment id");
    expect(errorOf(pickShareLinkCard([[pdf]]))).toContain("no PPTX deck to share yet");
  });
});

describe("share links — log hygiene", () => {
  it("never prints a token: a malformed open body is dropped from the error log", async () => {
    const { viewer, token } = await linked();
    const errors = vi.spyOn(logger, "error");
    try {
      await viewer.agent
        .post("/api/share/open")
        .set("Content-Type", "application/json")
        .send(`{"token":"${token}"`)
        .expect(500);
      expect(errors).toHaveBeenCalled();
      const logged = errors.mock.calls.map((call) => JSON.stringify(call)).join("\n");
      expect(logged).not.toContain(token);
    } finally {
      errors.mockRestore();
    }
  });
});
