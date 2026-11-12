/**
 * The upload relay at the route (`/api/chat/upload-relay/*`): a ticket is
 * minted for the caller, collected only by the caller, and a relayed file is
 * judged, audited and acknowledged. The relay itself is a fake that checks
 * every server-to-server request against contract v1 — spelled out here
 * independently of `src/server/uploadRelay.ts`, so the two cannot drift
 * together.
 */
import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signup, withTempDir } from "./helpers.js";
import { createApp, createServices } from "../src/server/app.js";
import { loadConfig, parseUploadRelayConfig } from "../src/server/config.js";
import { SERVER_ONLY_SECRET_ENV_NAMES } from "../src/server/secretPolicy.js";
import {
  ackUploadRelayFile,
  judgeUploadRelayFile,
  mintUploadRelayTicket,
  signUploadRelayRequest,
  ticketText,
  verifyOwnUploadRelayTicket,
} from "../src/server/uploadRelay.js";
import { UPLOAD_RELAY_AUDIT_ACTION } from "../src/server/routes/uploadRelay.js";
import {
  UPLOAD_RELAY_COLLECT_GRACE_SECONDS,
  UPLOAD_RELAY_MAX_FILES,
  UPLOAD_RELAY_MAX_FILE_BYTES,
  UPLOAD_RELAY_MESSAGES,
  UPLOAD_RELAY_TICKET_TTL_SECONDS,
  uploadRelayAccept,
  uploadRelayKind,
  uploadRelayMediaType,
} from "../src/shared/uploadRelay.js";
import { MAX_CHAT_DOCUMENT_BYTES } from "../src/shared/chatDocuments.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const RELAY = { url: "https://unibridge.test", apiUrl: "https://unibridge.test/_api", secret: SECRET };

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** What a DRM-encrypted .pdf looks like to us: bytes that are not a PDF. */
const ENCRYPTED = Buffer.concat([Buffer.from("DRMENC\0\0"), crypto.randomBytes(64)]);
const sha256 = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

interface HeldFile {
  id: string;
  tid: string;
  name: string;
  content: Buffer;
  uploader: string;
  /** What the list endpoint claims (defaults to the real digest). */
  sha256?: string;
}

/** A relay that speaks contract v1 and refuses any request whose signature it cannot reproduce. */
class FakeRelay {
  files: HeldFile[] = [];
  acks: { id: string; outcome: string; reason?: string }[] = [];
  calls: string[] = [];
  down = false;
  /** Acknowledgements to answer 500 before one is taken. */
  failAcks = 0;

  hold(file: HeldFile): void {
    this.files.push(file);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    expect(url.origin).toBe("https://unibridge.test");
    expect(url.pathname.startsWith("/_api/upload-relay/")).toBe(true);
    expect(init?.redirect).toBe("error");
    const path = url.pathname.slice("/_api".length);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const timestamp = headers.get("X-Noah-Relay-Timestamp") ?? "";
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`noah-upload-relay-request:v1\n${method}\n${path}\n${timestamp}`, "utf8")
      .digest("hex");
    if (headers.get("X-Noah-Relay-Signature") !== expected || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return new Response(JSON.stringify({ detail: "bad signature" }), { status: 401 });
    }
    this.calls.push(`${method} ${path}`);
    const list = /^\/upload-relay\/tickets\/([A-Za-z0-9_-]+)\/files$/.exec(path);
    if (method === "GET" && list) {
      const files = this.files
        .filter((file) => file.tid === list[1])
        .map((file) => ({
          id: file.id,
          name: file.name,
          size: file.content.length,
          sha256: file.sha256 ?? sha256(file.content),
          uploader: file.uploader,
          uploadedAt: "2026-11-12T00:00:00Z",
        }));
      return Response.json({ files });
    }
    const content = /^\/upload-relay\/files\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && content) {
      const file = this.files.find((entry) => entry.id === content[1]);
      if (!file) return new Response(JSON.stringify({ detail: "gone" }), { status: 404 });
      return new Response(new Uint8Array(file.content), { headers: { "Content-Type": "application/octet-stream" } });
    }
    const ack = /^\/upload-relay\/files\/([A-Za-z0-9_-]+)\/ack$/.exec(path);
    if (method === "POST" && ack) {
      if (this.failAcks > 0) {
        this.failAcks -= 1;
        return new Response(JSON.stringify({ detail: "try again" }), { status: 500 });
      }
      const index = this.files.findIndex((entry) => entry.id === ack[1]);
      if (index < 0) return new Response(JSON.stringify({ detail: "gone" }), { status: 404 });
      this.files.splice(index, 1);
      this.acks.push({ id: ack[1], ...(JSON.parse(String(init?.body)) as { outcome: string; reason?: string }) });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ detail: "no such route" }), { status: 404 });
  };
}

let tempDir: string;
const getTempDir = withTempDir("routes-upload-relay", () => {
  tempDir = getTempDir();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function boot(options: { relay?: boolean } = {}) {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
    ...(options.relay === false ? {} : { uploadRelay: RELAY }),
  });
  const relay = new FakeRelay();
  vi.stubGlobal("fetch", relay.fetch);
  return { services, app: createApp(services), store: services.store, relay };
}

async function member(app: ReturnType<typeof createApp>, name: string) {
  const agent = request.agent(app);
  const id = (await signup(agent, name).expect(201)).body.user.id as string;
  return { agent, id };
}

function ticketPayload(ticket: string): { tid: string; user: string; name: string; exp: number; accept: string[]; maxBytes: number; maxFiles: number } {
  return JSON.parse(Buffer.from(ticket.split(".")[1], "base64url").toString("utf8"));
}

/** Wait for the fire-and-forget acknowledgement that follows a response. */
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

const binary = (res: request.Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

describe("upload relay — the ticket (contract v1)", () => {
  it("is v1.<base64url JSON>.<base64url HMAC-SHA256> over the ticket domain, with the fields the relay enforces", () => {
    const now = Date.UTC(2026, 10, 12);
    const minted = mintUploadRelayTicket(RELAY, { id: "user-1", username: "jin", displayName: "진영" }, { documents: true, now });
    const [version, body, signature] = minted.ticket.split(".");
    expect(version).toBe("v1");
    // The signature, recomputed from the contract's own words.
    expect(signature).toBe(crypto.createHmac("sha256", SECRET).update(`noah-upload-relay-ticket:v1.${body}`, "utf8").digest("base64url"));
    expect(body).not.toMatch(/[=+/]/);
    const payload = ticketPayload(minted.ticket);
    expect(Object.keys(payload).sort()).toEqual(["accept", "exp", "maxBytes", "maxFiles", "name", "tid", "user"]);
    expect(payload).toMatchObject({
      user: "jin",
      name: "진영",
      exp: now / 1000 + UPLOAD_RELAY_TICKET_TTL_SECONDS,
      maxBytes: UPLOAD_RELAY_MAX_FILE_BYTES,
      maxFiles: UPLOAD_RELAY_MAX_FILES,
    });
    expect(payload.tid).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(payload.accept).toEqual(uploadRelayAccept(true));
    expect(payload.accept).toContain(".pdf");
    expect(payload.accept).toContain(".png");
    // The ticket rides the FRAGMENT of the relay page's address.
    expect(minted.url).toBe(`https://unibridge.test/upload-relay#t=${minted.ticket}`);
    expect(minted.expiresAt).toBe(new Date(payload.exp * 1000).toISOString());
  });

  it("never signs half a surrogate pair, and cuts names by code point", () => {
    expect(ticketText("가나다", 2)).toBe("가나");
    // 199 letters + an emoji: a UTF-16 slice at 200 would keep half of it.
    const long = `${"a".repeat(199)}😀tail`;
    expect(ticketText(long, 200)).toBe(`${"a".repeat(199)}😀`);
    expect(ticketText("x\ud83dy", 10)).toBe("x\ufffdy");
    expect(ticketText("\ude00x", 10)).toBe("\ufffdx");
    const minted = mintUploadRelayTicket(RELAY, { id: "u", username: "jin", displayName: long }, { documents: true });
    const name = ticketPayload(minted.ticket).name;
    expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    expect(name.endsWith("😀")).toBe(true);
    expect(minted.ttlSeconds).toBe(UPLOAD_RELAY_TICKET_TTL_SECONDS);
  });

  it("a pane that takes no documents gets an images-only ticket", () => {
    const minted = mintUploadRelayTicket(RELAY, { id: "u", username: "jin", displayName: "" }, { documents: false });
    expect(minted.payload.accept).toEqual([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    expect(minted.payload.name).toBe("jin");
  });

  it("is collectable only by the user it was minted for, only unmodified, and only until expiry plus the grace", () => {
    const now = Date.UTC(2026, 10, 12);
    const minted = mintUploadRelayTicket(RELAY, { id: "user-1", username: "jin", displayName: "진영" }, { documents: true, now });
    expect(verifyOwnUploadRelayTicket(RELAY, minted.ticket, "user-1", now)?.tid).toBe(minted.payload.tid);
    expect(verifyOwnUploadRelayTicket(RELAY, minted.ticket, "user-2", now)).toBeNull();
    // Another deployment's secret.
    expect(verifyOwnUploadRelayTicket({ ...RELAY, secret: SECRET.replace("0", "1") }, minted.ticket, "user-1", now)).toBeNull();
    // A re-encoded payload with the old signature.
    const [, body, signature] = minted.ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ ...ticketPayload(minted.ticket), exp: 9_999_999_999 }), "utf8").toString("base64url");
    expect(forged).not.toBe(body);
    expect(verifyOwnUploadRelayTicket(RELAY, `v1.${forged}.${signature}`, "user-1", now)).toBeNull();
    for (const junk of [undefined, null, 7, "", "v1", "v1..", `v2.${body}.${signature}`, `${minted.ticket}.x`, "a".repeat(5000)]) {
      expect(verifyOwnUploadRelayTicket(RELAY, junk, "user-1", now)).toBeNull();
    }
    const lastSecond = (minted.payload.exp + UPLOAD_RELAY_COLLECT_GRACE_SECONDS) * 1000;
    expect(verifyOwnUploadRelayTicket(RELAY, minted.ticket, "user-1", lastSecond)).not.toBeNull();
    expect(verifyOwnUploadRelayTicket(RELAY, minted.ticket, "user-1", lastSecond + 1000)).toBeNull();
  });

  it("signs a server-to-server request as lowercase hex HMAC over domain, METHOD, path and timestamp", () => {
    expect(signUploadRelayRequest(SECRET, "get", "/upload-relay/files/abc", 1_800_000_000)).toBe(
      crypto.createHmac("sha256", SECRET).update("noah-upload-relay-request:v1\nGET\n/upload-relay/files/abc\n1800000000", "utf8").digest("hex"),
    );
  });
});

describe("upload relay — what a relayed file must be", () => {
  const accept = uploadRelayAccept(true);
  const info = (name: string, content: Buffer) => ({ name, sha256: sha256(content) });

  it("takes a document or an image whose bytes are what its name says", () => {
    expect(judgeUploadRelayFile(info("보고서.pdf", PDF), PDF, accept)).toBeNull();
    expect(judgeUploadRelayFile(info("shot.PNG", PNG), PNG, accept)).toBeNull();
    expect(judgeUploadRelayFile(info("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), accept)).toBeNull();
    const gif = Buffer.from("GIF89a....");
    expect(judgeUploadRelayFile(info("a.gif", gif), gif, accept)).toBeNull();
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ");
    expect(judgeUploadRelayFile(info("a.webp", webp), webp, accept)).toBeNull();
  });

  it("refuses a file the DRM agent did not decrypt, a wrong type, an empty or oversized one, and a digest mismatch", () => {
    expect(judgeUploadRelayFile(info("보고서.pdf", ENCRYPTED), ENCRYPTED, accept)).toBe("BAD_FORMAT");
    expect(judgeUploadRelayFile(info("shot.png", ENCRYPTED), ENCRYPTED, accept)).toBe("BAD_FORMAT");
    expect(judgeUploadRelayFile(info("run.exe", PDF), PDF, accept)).toBe("TYPE");
    expect(judgeUploadRelayFile(info("noext", PDF), PDF, accept)).toBe("TYPE");
    // A document on an images-only ticket.
    expect(judgeUploadRelayFile(info("보고서.pdf", PDF), PDF, uploadRelayAccept(false))).toBe("TYPE");
    expect(judgeUploadRelayFile(info("a.pdf", Buffer.alloc(0)), Buffer.alloc(0), accept)).toBe("EMPTY");
    const bigDocument = Buffer.concat([PDF, Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES)]);
    expect(judgeUploadRelayFile(info("big.pdf", bigDocument), bigDocument, accept)).toBe("TOO_LARGE");
    // An image may be bigger than a document (the composer downscales it) …
    const bigImage = Buffer.concat([PNG, Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES)]);
    expect(judgeUploadRelayFile(info("big.png", bigImage), bigImage, accept)).toBeNull();
    // … up to the relay's own cap.
    const hugeImage = Buffer.concat([PNG, Buffer.alloc(UPLOAD_RELAY_MAX_FILE_BYTES)]);
    expect(judgeUploadRelayFile(info("huge.png", hugeImage), hugeImage, accept)).toBe("TOO_LARGE");
    expect(judgeUploadRelayFile({ name: "a.pdf", sha256: sha256(PNG) }, PDF, accept)).toBe("CHECKSUM");
  });

  it("names the intake path and media type the composer uses", () => {
    expect(uploadRelayKind("a.PDF")).toBe("document");
    expect(uploadRelayKind("a.jpeg")).toBe("image");
    expect(uploadRelayKind("a.exe")).toBeNull();
    expect(uploadRelayMediaType("a.jpeg")).toBe("image/jpeg");
    expect(uploadRelayMediaType("a.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(uploadRelayMediaType(".pdf")).toBeNull();
  });
});

describe("upload relay — configuration", () => {
  it("is off without both values and stops the boot on half a configuration or a bad value", () => {
    expect(parseUploadRelayConfig({ url: "", apiUrl: "", secret: "" })).toBeUndefined();
    expect(parseUploadRelayConfig({ url: "https://UniBridge.corp:8443/", apiUrl: "", secret: SECRET })).toEqual({
      url: "https://unibridge.corp:8443",
      apiUrl: "https://unibridge.corp:8443/_api",
      secret: SECRET,
    });
    expect(parseUploadRelayConfig({ url: "https://u.corp", apiUrl: "http://unibridge-service:8000/", secret: SECRET })?.apiUrl).toBe(
      "http://unibridge-service:8000",
    );
    expect(() => parseUploadRelayConfig({ url: "https://u.corp", apiUrl: "", secret: "" })).toThrow(/both/);
    expect(() => parseUploadRelayConfig({ url: "", apiUrl: "", secret: SECRET })).toThrow(/both/);
    expect(() => parseUploadRelayConfig({ url: "https://u.corp", apiUrl: "", secret: "short" })).toThrow(/32/);
    expect(() => parseUploadRelayConfig({ url: "https://u.corp/app", apiUrl: "", secret: SECRET })).toThrow(/origin only/);
    expect(() => parseUploadRelayConfig({ url: "ftp://u.corp", apiUrl: "", secret: SECRET })).toThrow(/http/);
    expect(() => parseUploadRelayConfig({ url: "https://a:b@u.corp", apiUrl: "", secret: SECRET })).toThrow(/credentials/);
    expect(() => parseUploadRelayConfig({ url: "u.corp", apiUrl: "", secret: SECRET })).toThrow(/absolute/);
  });

  it("reads the environment, and the secret is a server-only one", () => {
    vi.stubEnv("UPLOAD_RELAY_URL", "https://unibridge.test");
    vi.stubEnv("UPLOAD_RELAY_SECRET", SECRET);
    try {
      expect(loadConfig({ dataDir: tempDir, sessionSecret: "test", agentRuntime: "local" }).uploadRelay).toEqual(RELAY);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(loadConfig({ dataDir: tempDir, sessionSecret: "test", agentRuntime: "local" }).uploadRelay).toBeUndefined();
    expect(SERVER_ONLY_SECRET_ENV_NAMES).toContain("UPLOAD_RELAY_SECRET");
  });
});

describe("/api/chat/upload-relay", () => {
  it("is absent when no relay is configured, and bootstrap says which it is", async () => {
    const off = boot({ relay: false });
    const { agent } = await member(off.app, "relayoff");
    expect((await agent.get("/api/bootstrap").expect(200)).body.uploadRelay).toBe(false);
    await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(404);
    await agent.post("/api/chat/upload-relay/poll").send({ ticket: "x" }).expect(404);
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket: "x", fileId: "y" }).expect(404);
    await agent.post("/api/chat/upload-relay/confirm").send({ ticket: "x", fileId: "y" }).expect(404);
    off.services.store.close();

    const on = boot();
    expect((await request(on.app).get("/api/bootstrap").expect(200)).body.uploadRelay).toBe(true);
    // Never without a session.
    await request(on.app).post("/api/chat/upload-relay/tickets").send({}).expect(401);
    await request(on.app).post("/api/chat/upload-relay/poll").send({ ticket: "x" }).expect(401);
    await request(on.app).post("/api/chat/upload-relay/fetch").send({ ticket: "x", fileId: "y" }).expect(401);
    await request(on.app).post("/api/chat/upload-relay/confirm").send({ ticket: "x", fileId: "y" }).expect(401);
    on.services.store.close();
  });

  it("hands a relayed document to its owner, audits it and tells the relay to drop its copy", async () => {
    const { app, store, relay } = boot();
    const { agent, id } = await member(app, "relayowner");
    const minted = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as {
      ticket: string;
      url: string;
      expiresAt: string;
      ttlSeconds: number;
    };
    expect(minted.ttlSeconds).toBe(UPLOAD_RELAY_TICKET_TTL_SECONDS);
    expect(minted.url).toBe(`https://unibridge.test/upload-relay#t=${minted.ticket}`);
    const { tid, user } = ticketPayload(minted.ticket);
    expect(user).toBe("relayowner");

    // Nothing uploaded yet.
    expect((await agent.post("/api/chat/upload-relay/poll").send({ ticket: minted.ticket }).expect(200)).body).toEqual({ files: [] });

    relay.hold({ id: "file-1", tid, name: "보고서.pdf", content: PDF, uploader: "kc-jin" });
    const poll = await agent.post("/api/chat/upload-relay/poll").send({ ticket: minted.ticket }).expect(200);
    expect(poll.headers["cache-control"]).toBe("no-store");
    expect(poll.body).toEqual({ files: [{ id: "file-1", name: "보고서.pdf", size: PDF.length }] });

    const got = await agent
      .post("/api/chat/upload-relay/fetch")
      .send({ ticket: minted.ticket, fileId: "file-1" })
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-disposition"]).toBe("attachment");
    expect(Buffer.compare(got.body as Buffer, PDF)).toBe(0);

    // SENT is not RECEIVED: nothing is audited or acknowledged until the
    // browser confirms it has the bytes, and the relay keeps its copy.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(relay.acks).toEqual([]);
    expect(relay.files).toHaveLength(1);
    expect(store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toEqual([]);

    expect((await agent.post("/api/chat/upload-relay/confirm").send({ ticket: minted.ticket, fileId: "file-1" }).expect(200)).body).toEqual({ ok: true });
    await settled(() => relay.acks.length === 1);
    expect(relay.acks).toEqual([{ id: "file-1", outcome: "delivered" }]);
    expect(relay.files).toEqual([]);

    const rows = store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].detail).toContain('"보고서.pdf"');
    expect(rows[0].detail).toContain(`${PDF.length} bytes`);
    expect(rows[0].detail).toContain(sha256(PDF));
    expect(rows[0].detail).toContain("kc-jin");
    expect(rows[0].detail).toContain(tid);

    // Collected once: a second confirmation is a 404 (never a second row), and the relay no longer lists the file.
    await agent.post("/api/chat/upload-relay/confirm").send({ ticket: minted.ticket, fileId: "file-1" }).expect(404);
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket: minted.ticket, fileId: "file-1" }).expect(404);
    expect(store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toHaveLength(1);
    expect(relay.acks).toHaveLength(1);
    store.close();
  });

  it("a file whose bytes never reached the browser stays on the relay and can be fetched again", async () => {
    const { app, store, relay } = boot();
    const { agent, id } = await member(app, "relayretry");
    const { ticket } = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string };
    relay.hold({ id: "f1", tid: ticketPayload(ticket).tid, name: "a.pdf", content: PDF, uploader: "kc" });

    // The response left the server, the tab went away: no confirmation.
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId: "f1" }).buffer(true).parse(binary).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(relay.files).toHaveLength(1);
    expect(relay.acks).toEqual([]);

    // The next poll still lists it, and it is handed over on the second try.
    expect((await agent.post("/api/chat/upload-relay/poll").send({ ticket }).expect(200)).body.files).toHaveLength(1);
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId: "f1" }).buffer(true).parse(binary).expect(200);
    await agent.post("/api/chat/upload-relay/confirm").send({ ticket, fileId: "f1" }).expect(200);
    await settled(() => relay.acks.length === 1);
    expect(store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toHaveLength(1);
    store.close();
  });

  it("confirms only what it sent to that user under that ticket", async () => {
    const { app, store, relay } = boot();
    const alice = await member(app, "confalice");
    const bob = await member(app, "confbob");
    const aliceTicket = ((await alice.agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string }).ticket;
    const bobTicket = ((await bob.agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string }).ticket;
    relay.hold({ id: "f1", tid: ticketPayload(aliceTicket).tid, name: "a.pdf", content: PDF, uploader: "kc" });

    // Never fetched: nothing to confirm.
    await alice.agent.post("/api/chat/upload-relay/confirm").send({ ticket: aliceTicket, fileId: "f1" }).expect(404);
    await alice.agent.post("/api/chat/upload-relay/fetch").send({ ticket: aliceTicket, fileId: "f1" }).buffer(true).parse(binary).expect(200);
    // Not by another user, with either ticket; not without an id.
    await bob.agent.post("/api/chat/upload-relay/confirm").send({ ticket: bobTicket, fileId: "f1" }).expect(404);
    await bob.agent.post("/api/chat/upload-relay/confirm").send({ ticket: aliceTicket, fileId: "f1" }).expect(400);
    await alice.agent.post("/api/chat/upload-relay/confirm").send({ ticket: aliceTicket }).expect(404);
    expect(relay.acks).toEqual([]);
    expect(store.listAudit(alice.id, true).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toEqual([]);

    await alice.agent.post("/api/chat/upload-relay/confirm").send({ ticket: aliceTicket, fileId: "f1" }).expect(200);
    await settled(() => relay.acks.length === 1);
    store.close();
  });

  it("retries an acknowledgement the relay did not take", async () => {
    const relay = new FakeRelay();
    relay.hold({ id: "f1", tid: "t".repeat(38), name: "a.pdf", content: PDF, uploader: "kc" });
    relay.failAcks = 2;
    await ackUploadRelayFile(RELAY, "f1", "delivered", undefined, { fetchImpl: relay.fetch as typeof fetch, retryDelaysMs: [1, 1] });
    expect(relay.acks).toEqual([{ id: "f1", outcome: "delivered" }]);
    // Three failures in a row are reported to the caller.
    relay.hold({ id: "f2", tid: "t".repeat(38), name: "a.pdf", content: PDF, uploader: "kc" });
    relay.failAcks = 3;
    await expect(ackUploadRelayFile(RELAY, "f2", "refused", "TYPE", { fetchImpl: relay.fetch as typeof fetch, retryDelaysMs: [1, 1] })).rejects.toThrow(/500/);
    // Already gone on the relay is a success, not a retry.
    await ackUploadRelayFile(RELAY, "never-there", "delivered", undefined, { fetchImpl: relay.fetch as typeof fetch, retryDelaysMs: [1, 1] });
  });

  it("holds one user to two fetches at a time", async () => {
    const { app, store, relay } = boot();
    const { agent } = await member(app, "relaybusy");
    const { ticket } = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string };
    const tid = ticketPayload(ticket).tid;
    for (const id of ["a", "b", "c"]) relay.hold({ id, tid, name: `${id}.pdf`, content: PDF, uploader: "kc" });
    // Hold every relay answer until released, so the three requests overlap.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = relay.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return inner(input, init);
    });
    const requests = ["a", "b", "c"].map((fileId) =>
      agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId }).buffer(true).parse(binary).then((res) => res.status),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const statuses = (await Promise.all(requests)).sort();
    expect(statuses).toEqual([200, 200, 429]);
    // The slot is released: the refused one goes through afterwards.
    const again = await Promise.all(
      ["a", "b", "c"].map((fileId) => agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId }).buffer(true).parse(binary).then((res) => res.status)),
    );
    expect(again.filter((status) => status === 200).length).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("refuses a file that was not decrypted: 422, an error audit row and a 'refused' acknowledgement", async () => {
    const { app, store, relay } = boot();
    const { agent, id } = await member(app, "relaydrm");
    const { ticket } = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string };
    relay.hold({ id: "enc-1", tid: ticketPayload(ticket).tid, name: "기밀‮.pdf", content: ENCRYPTED, uploader: "kc-jin" });

    const refused = await agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId: "enc-1" }).expect(422);
    expect(refused.body).toEqual({ error: UPLOAD_RELAY_MESSAGES.BAD_FORMAT, problem: "BAD_FORMAT" });
    await settled(() => relay.acks.length === 1);
    expect(relay.acks).toEqual([{ id: "enc-1", outcome: "refused", reason: "BAD_FORMAT" }]);

    const rows = store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].detail).toContain("거절(BAD_FORMAT)");
    // A bidi control in the name never reaches the trail.
    expect(rows[0].detail).toContain('"기밀?.pdf"');
    store.close();
  });

  it("refuses a file whose bytes are not the ones the relay listed, and a document on an images-only ticket", async () => {
    const { app, store, relay } = boot();
    const { agent } = await member(app, "relaysum");
    const { ticket } = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string };
    relay.hold({ id: "sum-1", tid: ticketPayload(ticket).tid, name: "a.pdf", content: PDF, uploader: "kc", sha256: sha256(PNG) });
    expect((await agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId: "sum-1" }).expect(422)).body.problem).toBe("CHECKSUM");

    const imagesOnly = (await agent.post("/api/chat/upload-relay/tickets").send({}).expect(200)).body as { ticket: string };
    expect(ticketPayload(imagesOnly.ticket).accept).toEqual(uploadRelayAccept(false));
    relay.hold({ id: "doc-1", tid: ticketPayload(imagesOnly.ticket).tid, name: "a.pdf", content: PDF, uploader: "kc" });
    relay.hold({ id: "img-1", tid: ticketPayload(imagesOnly.ticket).tid, name: "a.png", content: PNG, uploader: "kc" });
    expect((await agent.post("/api/chat/upload-relay/fetch").send({ ticket: imagesOnly.ticket, fileId: "doc-1" }).expect(422)).body.problem).toBe("TYPE");
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket: imagesOnly.ticket, fileId: "img-1" }).buffer(true).parse(binary).expect(200);
    store.close();
  });

  it("never serves another user's ticket, a foreign ticket, or a file that is not on the ticket", async () => {
    const { app, store, relay } = boot();
    const alice = await member(app, "relayalice");
    const bob = await member(app, "relaybob");
    const aliceTicket = ((await alice.agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string }).ticket;
    const bobTicket = ((await bob.agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string }).ticket;
    relay.hold({ id: "alice-file", tid: ticketPayload(aliceTicket).tid, name: "a.pdf", content: PDF, uploader: "kc" });
    const callsBefore = relay.calls.length;

    // Bob holding Alice's ticket: refused before the relay is asked anything.
    await bob.agent.post("/api/chat/upload-relay/poll").send({ ticket: aliceTicket }).expect(400);
    await bob.agent.post("/api/chat/upload-relay/fetch").send({ ticket: aliceTicket, fileId: "alice-file" }).expect(400);
    await bob.agent.post("/api/chat/upload-relay/poll").send({ ticket: "v1.e30.AAAA" }).expect(400);
    await bob.agent.post("/api/chat/upload-relay/poll").send({}).expect(400);
    expect(relay.calls.length).toBe(callsBefore);

    // Bob's own ticket does not reach Alice's file by id.
    await bob.agent.post("/api/chat/upload-relay/fetch").send({ ticket: bobTicket, fileId: "alice-file" }).expect(404);
    await bob.agent.post("/api/chat/upload-relay/fetch").send({ ticket: bobTicket, fileId: "../../admin" }).expect(404);
    await bob.agent.post("/api/chat/upload-relay/fetch").send({ ticket: bobTicket }).expect(400);
    expect(relay.calls.filter((call) => call.startsWith("GET /upload-relay/files/"))).toEqual([]);
    expect(relay.acks).toEqual([]);
    expect(store.listAudit(bob.id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toEqual([]);

    // Alice still gets hers.
    await alice.agent.post("/api/chat/upload-relay/fetch").send({ ticket: aliceTicket, fileId: "alice-file" }).buffer(true).parse(binary).expect(200);
    store.close();
  });

  it("answers 502 in Korean when the relay cannot be reached, and audits nothing", async () => {
    const { app, store, relay } = boot();
    const { agent, id } = await member(app, "relaydown");
    const { ticket } = (await agent.post("/api/chat/upload-relay/tickets").send({ documents: true }).expect(200)).body as { ticket: string };
    relay.down = true;
    const poll = await agent.post("/api/chat/upload-relay/poll").send({ ticket }).expect(502);
    expect(poll.body.error).toContain("업로드 중계 서버");
    await agent.post("/api/chat/upload-relay/fetch").send({ ticket, fileId: "x" }).expect(502);
    expect(store.listAudit(id, false).filter((row) => row.action === UPLOAD_RELAY_AUDIT_ACTION)).toEqual([]);
    store.close();
  });
});
