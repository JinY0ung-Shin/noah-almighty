import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { callTool, shareGroup, signup, withTempDir } from "./helpers.js";

// PPT share links END TO END, across the seams no single lane owns:
//  1. the owner's interactive turn through the REAL chat route, runAgentStream
//     and runPlan — the file_output server the plan builds carries
//     create_share_link wired to the ROUTE's onShareLink, and a scripted model
//     (the mocked SDK `query`) delivers a converter-built deck with share_file
//     and asks for a link: the exact tool text the avatar reads;
//  2. a colleague opens that link over HTTP; every URL in the payload is one the
//     viewer keeps (it drops anything but a normalized /api/share/ path), and
//     the slide and the .pptx flow through viewer-bound tickets;
//  3. the card button's create call reuses the avatar's link (one per card);
//     revoke → every recipient call is the one 404, never a 401;
//  4. group-agent and colleague turns through the SAME route: no tool and
//     the prompt's redirect instead (the route's supply predicate and runPlan's
//     registration gate agree);
//  5. a rebuilt deck re-delivered is a NEW card: its link is a new one, the
//     avatar's result names the earlier link (never by URL) and each link keeps
//     serving the file it was made for.

type QueryArgs = { prompt: unknown; options: Record<string, unknown> };

const S = vi.hoisted(() => ({
  /** One snapshot of `options` per SDK query (the run loop mutates the object). */
  calls: [] as { options: Record<string, unknown> }[],
  /** The scripted "model": runs mid-stream, while the chat turn is live. */
  script: null as null | ((options: Record<string, unknown>) => Promise<void>),
  /** Every file_output server runPlan built, with the tools its REAL builder put in it. */
  servers: [] as { server: unknown; tools: { name: string; handler: unknown }[] }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: QueryArgs) => {
      S.calls.push({ options: { ...args.options } });
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "flow-session", model: "opus" };
        await S.script?.(args.options);
        yield { type: "result", subtype: "success", result: "완료했습니다." };
      }
      return gen();
    },
  };
});

vi.mock("../src/server/agent/fileOutputTools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/agent/fileOutputTools.js")>();
  return {
    ...actual,
    buildFileOutputServer: (ctx: Parameters<typeof actual.buildFileOutputServer>[0]) => {
      const server = actual.buildFileOutputServer(ctx);
      // A second build from the SAME ctx: identical tools, callable directly.
      S.servers.push({ server, tools: actual.buildFileOutputTools(ctx) });
      return server;
    },
  };
});

// No LibreOffice on a test box: a deck WITHOUT a converter sidecar gets no
// previews (download-only), exactly as on a toolchain-less deployment.
vi.mock("../src/server/deckRender.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/deckRender.js")>()),
  renderDocumentPreviews: vi.fn(async () => []),
}));

import { createApp, createServices } from "../src/server/app.js";
import { FILE_OUTPUT_SHARE_LINK_TOOL_NAME } from "../src/server/agent/fileOutputTools.js";
import {
  SHARE_LINK_GONE_MESSAGE,
  type ShareLinkCreateResult,
  type ShareLinkSummary,
  type ShareViewPayload,
} from "../src/shared/shareLinks.js";

let tempDir: string;
const getTempDir = withTempDir("share-links-flow", () => {
  tempDir = getTempDir();
  S.calls.length = 0;
  S.servers.length = 0;
  S.script = null;
});

/** A converter-built deck: the .pptx plus its hash-bound `<stem>.preview/` sidecar (1 slide). */
const FIXTURE_DECK = path.join(__dirname, "fixtures", "deck-preview", "mini");
const TOOL_LINE = "Share links: `create_share_link`, ONLY if the user asks for a link.";
const REDIRECT =
  "Share links for a PPTX card cannot be created in this run; if the user wants a link other people can open, point them to the 공유 링크 button next to the deck's file card.";
const GROUP_REDIRECT = "Share links cannot be created for a group-agent conversation";

function boot() {
  const services = createServices({
    dataDir: path.join(tempDir, "data"),
    agentRuntime: "claude",
    sessionSecret: "flow-secret",
    anthropicModel: undefined,
    anthropicApiKey: undefined,
  });
  return { services, app: createApp(services), store: services.store };
}

/** The file_output tools of the run whose SDK options these are. */
function fileOutputTools(options: Record<string, unknown>) {
  const server = (options.mcpServers as Record<string, unknown>).file_output;
  const entry = S.servers.find((candidate) => candidate.server === server);
  if (!entry) throw new Error("this run built no file_output server");
  return entry.tools;
}

/** What run #i offered the model: the allowedTools entry, the server's own tool, the prompt. */
function offeredTo(i: number) {
  const { options } = S.calls[i];
  return {
    allowed: (options.allowedTools as string[]).includes(FILE_OUTPUT_SHARE_LINK_TOOL_NAME),
    registered: fileOutputTools(options).some((t) => t.name === "create_share_link"),
    append: (options.systemPrompt as { append: string }).append,
  };
}

/** Collect a binary body (superagent leaves unknown content types unbuffered). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}

const toolText = (result: { content: { text?: string }[]; isError?: boolean }) => {
  if (result.isError) throw new Error(`tool failed: ${result.content[0]?.text}`);
  return result.content[0]?.text ?? "";
};

describe("share links end to end (chat route → runPlan → tool → recipient)", () => {
  // Two signups, a full chat turn and a dozen round-trips: well under a second
  // alone, but past the 5 s default under the full parallel suite.
  it("the owner asks their own avatar for a link; a colleague views and downloads; revoke kills every ticket", { timeout: 30_000 }, async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "flowowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "flowcolleague").expect(201);

    let shareText = "";
    let linkText = "";
    let cardId = "";
    S.script = async (options) => {
      const tools = fileOutputTools(options);
      // The skill's workflow: the WHOLE deck folder is in the workspace, so the
      // converter's exact renders ride along with the .pptx.
      fs.cpSync(FIXTURE_DECK, path.join(options.cwd as string, "mini"), { recursive: true });
      shareText = toolText(await callTool(tools, "share_file", { path: "mini/mini.pptx", name: "3분기 보고" }));
      cardId = /attachment id: ([^)]+)\)/.exec(shareText)?.[1] ?? "";
      linkText = toolText(await callTool(tools, "create_share_link", {}));
    };
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "conv-flow", message: "3분기 보고 PPT 만들고 팀장님이 볼 링크도 줘" })
      .expect(200);

    // The run offered the tool in BOTH lists and stated it in the prompt.
    const run = offeredTo(0);
    expect(run).toMatchObject({ allowed: true, registered: true });
    expect(run.append).toContain(TOOL_LINE);
    expect(run.append).not.toContain(REDIRECT);

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

  it("offers no tool on group-agent and colleague turns — the prompt redirects instead", { timeout: 30_000 }, async () => {
    const { app, store } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "gateowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "gatecolleague").expect(201);
    // Co-members: the colleague reaches (and is trusted by) the owner's avatar.
    const groupId = await shareGroup(owner, ["gateowner", "gatecolleague"]);
    const groupAgent = store.createGroupAgent(groupId, { displayName: "팀 비서" })!;

    const turns: Array<[string, ReturnType<typeof request.agent>, string]> = [
      ["own", owner, ownerId],
      ["group", owner, `group:${groupId}:${groupAgent.id}`],
      ["colleague", colleague, ownerId],
    ];
    for (const [conversation, agent, avatarId] of turns) {
      await agent
        .post("/api/chat/stream")
        .send({ avatarId, conversationId: `conv-${conversation}-${crypto.randomUUID().slice(0, 8)}`, message: "링크 줘" })
        .expect(200);
    }
    expect(S.calls).toHaveLength(turns.length);

    const [own, groupRun, colleagueRun] = turns.map((_, i) => offeredTo(i));
    expect(own).toMatchObject({ allowed: true, registered: true });
    expect(own.append).toContain(TOOL_LINE);
    for (const run of [groupRun, colleagueRun]) {
      expect(run).toMatchObject({ allowed: false, registered: false });
      expect(run.append).not.toContain(TOOL_LINE);
    }
    expect(colleagueRun.append).toContain(REDIRECT);
    // A group-agent pane has no 공유 링크 button, so the avatar must not point at one.
    expect(groupRun.append).toContain(GROUP_REDIRECT);
    expect(groupRun.append).not.toContain(REDIRECT);
  });

  it("a rebuilt deck re-delivered is a NEW card: the avatar learns the earlier link still serves the old file", { timeout: 30_000 }, async () => {
    const { app } = boot();
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "rebuildowner").expect(201)).body.user.id as string;
    const colleague = request.agent(app);
    await signup(colleague, "rebuildpeer").expect(201);
    const v1 = fs.readFileSync(path.join(FIXTURE_DECK, "mini.pptx"));
    const v2 = Buffer.concat([v1, Buffer.from("REBUILT-V2")]); // still a zip prefix; the sidecar no longer matches

    /** One review round: (re)build the deck in place, deliver it with share_file, ask for the link. */
    const round = async (bytes: Buffer, message: string) => {
      let linkText = "";
      S.script = async (options) => {
        const tools = fileOutputTools(options);
        const deckDir = path.join(options.cwd as string, "mini");
        fs.cpSync(FIXTURE_DECK, deckDir, { recursive: true });
        fs.writeFileSync(path.join(deckDir, "mini.pptx"), bytes);
        toolText(await callTool(tools, "share_file", { path: "mini/mini.pptx", name: "3분기 보고" }));
        linkText = toolText(await callTool(tools, "create_share_link", {}));
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
