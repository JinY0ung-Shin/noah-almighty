import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/types.js";
import { shareGroup, signup, withTempDir } from "./helpers.js";

// PPT share links END TO END, across the seams no single lane owns:
//  1. the owner's interactive turn through the REAL chat route, runAgentStream
//     and runPiAgent — a scripted pi gateway (the fake client) delivers a
//     converter-built deck with share_file and asks for a link THROUGH the
//     app's own /mcp endpoint with the run token, exactly as pi's broker does:
//     the endpoint's per-run gate, the file_output server and the ROUTE's
//     onShareLink all run for real, and the result is the tool text the avatar
//     reads;
//  2. a colleague opens that link over HTTP; every URL in the payload is one the
//     viewer keeps (it drops anything but a normalized /api/share/ path), and
//     the slide and the .pptx flow through viewer-bound tickets;
//  3. the card button's create call reuses the avatar's link (one per card);
//     revoke → every recipient call is the one 404, never a 401;
//  4. a colleague turn through the SAME route: the call is refused by the run's
//     gate and the prompt redirects instead (the route's supply predicate and
//     the capability plan's registration gate agree);
//  5. a rebuilt deck re-delivered is a NEW card: its link is a new one, the
//     avatar's result names the earlier link (never by URL) and each link keeps
//     serving the file it was made for.

type ToolCall = (server: string, tool: string, args: Record<string, unknown>) => Promise<ToolResult>;
type ToolResult = { content: { text?: string }[]; isError?: boolean };

const S = vi.hoisted(() => ({
  /** One snapshot per pi request the chat route's run sent. */
  requests: [] as PiResponseRequest[],
  /** The scripted "model": runs inside the pi turn, while the chat turn is live. */
  script: null as null | ((req: PiResponseRequest, call: ToolCall) => Promise<void>),
  /** The app's own listening URL (the broker's view of Noah's /mcp). */
  baseUrl: "",
}));

// The gateway client every run of this process gets (piServicesFor builds it
// from createPiResponsesClient): a scripted pi that calls Noah's tools over
// the REAL /mcp endpoint with the run's token, then answers.
vi.mock("../src/server/agent/pi/responsesClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/agent/pi/responsesClient.js")>();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let turn = 0;
  return {
    ...actual,
    createPiResponsesClient: (): PiResponsesClient => ({
      async *stream(req) {
        S.requests.push(structuredClone(req));
        const token = req.headers?.["x-noah-run-token"] ?? "";
        const opened: InstanceType<typeof Client>[] = [];
        const call: ToolCall = async (server, tool, args) => {
          const mcp = new Client({ name: "broker", version: "1" });
          await mcp.connect(
            new StreamableHTTPClientTransport(new URL(`${S.baseUrl}/mcp/${server}`), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
            }),
          );
          opened.push(mcp);
          return (await mcp.callTool({ name: tool, arguments: args })) as ToolResult;
        };
        try {
          await S.script?.(req, call);
        } finally {
          await Promise.all(opened.map((mcp) => mcp.close()));
        }
        const id = `resp_flow${++turn}_1`;
        const ev = (type: string, data: Record<string, unknown>) => ({ type, data });
        yield ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } });
        yield ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } });
        yield ev("response.output_text.delta", { delta: "완료했습니다." });
        yield ev("response.output_item.done", { item: { type: "message", id: `${id}-m`, status: "completed" } });
        yield ev("response.completed", { response: { id, status: "completed", usage: { output_tokens: 3 } } });
      },
      async cancel() {
        return { status: "cancelled" };
      },
      async listModels() {
        return [];
      },
      async fileContent() {
        throw new Error("not used");
      },
    }),
  };
});

// No LibreOffice on a test box: a deck WITHOUT a converter sidecar gets no
// previews (download-only), exactly as on a toolchain-less deployment.
vi.mock("../src/server/deckRender.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/deckRender.js")>()),
  renderDocumentPreviews: vi.fn(async () => []),
}));

import { createApp, createServices } from "../src/server/app.js";
import { PI_RUN_TOKEN_HEADER } from "../src/server/agent/pi/piRuntime.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import type { PiResponseRequest, PiResponsesClient } from "../src/server/agent/pi/responsesClient.js";
import {
  SHARE_LINK_GONE_MESSAGE,
  type ShareLinkCreateResult,
  type ShareLinkSummary,
  type ShareViewPayload,
} from "../src/shared/shareLinks.js";

let tempDir: string;
let server: http.Server | undefined;
let services: ReturnType<typeof createServices> | undefined;
const getTempDir = withTempDir("share-links-flow", () => {
  tempDir = getTempDir();
  S.requests.length = 0;
  S.script = null;
});
afterEach(async () => {
  // closeAllConnections: a supertest keep-alive socket would hold close() for its idle timeout.
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  services?.store.close();
  services = undefined;
});

/** A converter-built deck: the .pptx plus its hash-bound `<stem>.preview/` sidecar (1 slide). */
const FIXTURE_DECK = path.join(__dirname, "fixtures", "deck-preview", "mini");
const TOOL_LINE = "Share links: `create_share_link`, ONLY if the user asks for a link.";
const REDIRECT =
  "Share links for a PPTX card cannot be created in this run; if the user wants a link other people can open, point them to the 공유 링크 button next to the deck's file card.";

async function boot() {
  services = createServices({
    dataDir: path.join(tempDir, "data"),
    agentRuntime: "pi",
    sessionSecret: "flow-secret",
    pi: {
      gatewayUrl: "http://pi.invalid",
      apiKey: "k",
      modelMap: {},
      deckSandbox: false,
      workspacesDir: path.join(tempDir, "pi-ws"),
    },
  });
  server = http.createServer(createApp(services));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  S.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app: server, store: services.store, config: services.config };
}

/** Copy the fixture deck into this run's conversation folder; returns the sandbox path of the .pptx. */
function placeDeck(config: AppConfig, req: PiResponseRequest, conversationId: string, bytes?: Buffer): string {
  const ws = piWorkspaceFor(config, req.user, conversationId);
  const deckDir = path.join(ws.hostConversationDir!, "mini");
  fs.cpSync(FIXTURE_DECK, deckDir, { recursive: true });
  if (bytes) fs.writeFileSync(path.join(deckDir, "mini.pptx"), bytes);
  return `${ws.conversationDir}/mini/mini.pptx`;
}

/** Collect a binary body (superagent leaves unknown content types unbuffered). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}

const toolText = (result: ToolResult) => {
  if (result.isError) throw new Error(`tool failed: ${result.content[0]?.text}`);
  return result.content[0]?.text ?? "";
};

describe("share links end to end (chat route → runPiAgent → /mcp → tool → recipient)", () => {
  // Two signups, a full chat turn and a dozen round-trips: well under a second
  // alone, but past the 5 s default under the full parallel suite.
  it("the owner asks their own avatar for a link; a colleague views and downloads; revoke kills every ticket", { timeout: 30_000 }, async () => {
    const { app, config } = await boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "flowowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "flowcolleague").expect(201);

    let shareText = "";
    let linkText = "";
    let cardId = "";
    S.script = async (req, call) => {
      // The skill's workflow: the WHOLE deck folder is in the workspace, so the
      // converter's exact renders ride along with the .pptx.
      const deck = placeDeck(config, req, "conv-flow");
      shareText = toolText(await call("file_output", "share_file", { path: deck, name: "3분기 보고" }));
      cardId = /attachment id: ([^)]+)\)/.exec(shareText)?.[1] ?? "";
      linkText = toolText(await call("file_output", "create_share_link", {}));
    };
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-flow", message: "3분기 보고 PPT 만들고 팀장님이 볼 링크도 줘" })
      .expect(200);

    // The run ran as the owner, carried a run token, and stated the tool in its frozen prompt.
    expect(S.requests).toHaveLength(1);
    expect(S.requests[0]!.user).toBe(ownerId);
    expect(S.requests[0]!.headers?.[PI_RUN_TOKEN_HEADER]).toMatch(/^nrt_/);
    expect(S.requests[0]!.instructions).toContain(TOOL_LINE);
    expect(S.requests[0]!.instructions).not.toContain(REDIRECT);

    // What the avatar reads: the security banner first, KST expiry, the facts, one URL line.
    expect(cardId).not.toBe("");
    const lines = linkText.split("\n");
    expect(lines[0]).toMatch(
      /^SECURITY: this URL is a bearer link — anyone signed in to Noah who has it can view the slides and download the \.pptx \(speaker notes included\) until \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\. Give it ONLY to the user/,
    );
    // A fresh deployment signs anyone up — the result says so.
    expect(linkText).toContain("Sign-up is OPEN on this server");
    expect(linkText).toContain('Created a new share link for "3분기 보고.pptx" — it shows 1 slide render(s) plus the .pptx download');
    const urlLine = lines.find((line) => line.startsWith("URL: "));
    expect(urlLine).toMatch(/^URL: http:\/\/127\.0\.0\.1:\d+\/#\/share\/[A-Za-z0-9_-]{43}$/);
    expect(linkText).not.toContain("This is a path on this Noah server");
    expect(linkText).toContain("내 아바타 → 권한·연결 → 공유 링크");
    const token = /#\/share\/([A-Za-z0-9_-]{43})$/.exec(urlLine!)![1];

    // A colleague signed in to Noah opens it — after the turn persisted, so the
    // converter's slide title reaches the alt text.
    const opened = await colleague.post("/api/share/open").send({ token }).expect(200);
    expect(opened.headers["cache-control"]).toBe("no-store");
    const payload = opened.body as ShareViewPayload;
    expect(payload).toMatchObject({
      fileName: "3분기 보고.pptx",
      ownerName: "flowowner",
      ownerUsername: "flowowner",
      previewCapped: false,
    });
    expect(payload.slides).toEqual([
      { index: 1, url: expect.stringMatching(/^\/api\/share\/t\/[^/]+\/slides\/1$/), alt: "슬라이드 1 – 미리보기 계약 확인" },
    ]);
    expect(payload.downloadUrl).toMatch(/^\/api\/share\/t\/[^/]+\/download$/);
    // The viewer keeps only URLs that are same-origin /api/share/ paths AFTER
    // normalization (isShareAssetUrl, pinned in client-share-links.test.ts), so
    // every server URL must already be one: relative, and a fixed point of URL
    // normalization.
    for (const url of [...payload.slides.map((s) => s.url), payload.downloadUrl]) {
      const parsed = new URL(url, "https://noah.invalid");
      expect(parsed.origin).toBe("https://noah.invalid");
      expect(`${parsed.pathname}${parsed.search}${parsed.hash}`).toBe(url);
    }

    // Bytes through the viewer-bound tickets.
    const slide = await colleague.get(payload.slides[0].url).buffer(true).parse(binary).expect(200);
    expect(slide.headers["content-type"]).toBe("image/png");
    expect(slide.headers["cache-control"]).toBe("private, no-cache");
    expect(slide.headers["x-content-type-options"]).toBe("nosniff");
    expect(slide.body).toEqual(fs.readFileSync(path.join(FIXTURE_DECK, "mini.preview", "slide-01.png")));
    const download = await colleague.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);
    expect(download.headers["content-disposition"]).toBe(
      `attachment; filename="3_ _.pptx"; filename*=UTF-8''${encodeURIComponent("3분기 보고.pptx")}`,
    );
    expect(download.body).toEqual(fs.readFileSync(path.join(FIXTURE_DECK, "mini.pptx")));
    // The ticket is the COLLEAGUE's: the owner's session cannot replay it.
    await owner.get(payload.downloadUrl).expect(404);

    // The owner's list: the avatar's link, one counted view.
    const list = (await owner.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ conversationId: "conv-flow", fileId: cardId, slideCount: 1, viewCount: 1, expired: false });
    expect(list[0].url).toMatch(new RegExp(`#/share/${token}$`));

    // The card's 공유 링크 button reaches the SAME link (one active link per card).
    const fromCard = await owner.post(`/api/conversations/conv-flow/files/${cardId}/share-links`).send({}).expect(200);
    expect((fromCard.body as ShareLinkCreateResult).created).toBe(false);
    expect((fromCard.body as ShareLinkCreateResult).link.id).toBe(list[0].id);

    // Revoke: every recipient call is the one 404 — never a 401 (that would log the colleague out).
    await owner.delete(`/api/me/share-links/${list[0].id}`).expect(204);
    for (const res of [
      await colleague.post("/api/share/open").send({ token }),
      await colleague.get(payload.slides[0].url),
      await colleague.get(payload.downloadUrl),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: SHARE_LINK_GONE_MESSAGE });
    }
  });

  it("offers no tool on a colleague turn — the prompt redirects instead", { timeout: 30_000 }, async () => {
    const { app } = await boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gateowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "gatecolleague").expect(201);
    // Co-members: the colleague reaches (and is trusted by) the owner's avatar.
    await shareGroup(owner, ["gateowner", "gatecolleague"]);

    const turns: Array<[string, ReturnType<typeof request.agent>, string]> = [
      ["own", owner, ownerId],
      ["colleague", colleague, ownerId],
    ];
    // Each turn calls create_share_link with no card: the owner's run reaches
    // the handler (which refuses for want of a deck), the colleague's is
    // stopped by the run's gate before any handler runs.
    const results: ToolResult[] = [];
    S.script = async (_req, call) => {
      results.push(await call("file_output", "create_share_link", {}));
    };
    for (const [conversation, agent, avatarId] of turns) {
      await agent
        .post("/api/chat/stream")
        .send({ avatarId, conversationId: `conv-${conversation}-${crypto.randomUUID().slice(0, 8)}`, message: "링크 줘" })
        .expect(200);
    }
    expect(S.requests).toHaveLength(turns.length);

    const [own, colleagueRun] = S.requests;
    expect(own!.instructions).toContain(TOOL_LINE);
    expect(own!.instructions).not.toContain(REDIRECT);
    // The owner's call reached the ROUTE's onShareLink (it found no deck card).
    expect(results[0]!.content[0]?.text).toContain("This conversation has no PPTX deck to share yet");
    expect(colleagueRun!.instructions).not.toContain(TOOL_LINE);
    expect(colleagueRun!.instructions).toContain(REDIRECT);
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[1]!.content[0]?.text).toContain(
      "Tool 'mcp__file_output__create_share_link' is not available in this run",
    );
  });

  it("a rebuilt deck re-delivered is a NEW card: the avatar learns the earlier link still serves the old file", { timeout: 30_000 }, async () => {
    const { app, config } = await boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "rebuildowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "rebuildpeer").expect(201);
    const v1 = fs.readFileSync(path.join(FIXTURE_DECK, "mini.pptx"));
    const v2 = Buffer.concat([v1, Buffer.from("REBUILT-V2")]); // still a zip prefix; the sidecar no longer matches

    /** One review round: (re)build the deck in place, deliver it with share_file, ask for the link. */
    const round = async (bytes: Buffer, message: string) => {
      let linkText = "";
      S.script = async (req, call) => {
        const deck = placeDeck(config, req, "conv-rebuild", bytes);
        toolText(await call("file_output", "share_file", { path: deck, name: "3분기 보고" }));
        linkText = toolText(await call("file_output", "create_share_link", {}));
      };
      await owner.post("/api/chat/stream").send({ avatarId: ownerId, conversationId: "conv-rebuild", message }).expect(200);
      return linkText;
    };
    const first = await round(v1, "3분기 보고 PPT 만들고 팀장님 볼 링크도 줘");
    const second = await round(v2, "2번 슬라이드 고쳐서 링크 다시 줘");

    const tokenIn = (text: string) => /^URL: \S*#\/share\/([A-Za-z0-9_-]{43})$/m.exec(text)![1];
    const [token1, token2] = [tokenIn(first), tokenIn(second)];
    expect(token2).not.toBe(token1);
    expect(first).not.toContain("still active");
    // The second result names the earlier link by deck name — never by its URL,
    // which is a bearer credential.
    const note = second.split("\n").find((line) => line.includes("still active"));
    expect(note).toContain("3분기 보고.pptx");
    expect(second).not.toContain(token1);
    // Each link keeps serving the file it was made for.
    for (const [token, bytes] of [
      [token1, v1],
      [token2, v2],
    ] as const) {
      const opened = await colleague.post("/api/share/open").send({ token }).expect(200);
      const download = await colleague
        .get((opened.body as ShareViewPayload).downloadUrl)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(download.body).toEqual(bytes);
    }
  });
});
