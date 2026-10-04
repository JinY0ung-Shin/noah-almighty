// Coverage-gap tests for the in-process MCP tool servers under src/server/agent/.
// Companion to agent-tools.test.ts: this file targets branches that file leaves
// uncovered (Confluence request/attachment plumbing, get_attachment's
// save_to_workspace and the run plan that picks its target, brain/group-brain happy
// paths over a real local clone, group-repo list/scaffold/commit/create_repo,
// ssh-trust add/remove, and the shared mcpTools helpers). Everything is offline:
// fetch is stubbed per test, git uses local bare remotes, addTrustedHost is
// mocked (its real impl needs a live SSH handshake). No real SDK is exercised.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createServices } from "../src/server/app.js";
import {
  buildConfluenceTools,
  buildConfluenceServer,
  CONFLUENCE_SERVER_NAME,
} from "../src/server/agent/confluenceTools.js";
import {
  buildBrainTools,
  buildBrainServer,
  BRAIN_SERVER_NAME,
} from "../src/server/agent/brainTools.js";
import {
  buildGroupBrainTools,
  buildGroupBrainServer,
  GROUP_BRAIN_SERVER_NAME,
} from "../src/server/agent/groupBrainTools.js";
import {
  buildGroupRepoTools,
  buildGroupRepoServer,
  GROUP_REPO_SERVER_NAME,
} from "../src/server/agent/groupRepoTools.js";
import {
  buildSshTrustTools,
  buildSshTrustServer,
  SSH_TRUST_SERVER_NAME,
} from "../src/server/agent/sshTrustTools.js";
import { text, decodeRepoFsError, decodeExecError } from "../src/server/agent/mcpTools.js";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import { gitInit, makeBareRemote, callTool } from "./helpers.js";

// addTrustedHost fetches a live host key over an SSH handshake (paramiko); mock
// it so the add_host success path is deterministic + offline. listTrustedHosts /
// removeTrustedHost stay REAL (file-backed) via importActual.
vi.mock("../src/server/sshTrust.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/sshTrust.js")>();
  return { ...actual, addTrustedHost: vi.fn() };
});
import { addTrustedHost } from "../src/server/sshTrust.js";
// The run-plan tests record the ctx buildAgentRunPlan hands the Confluence and
// system servers. Both factories are wrapped in spies that still build the real
// servers, so every other test here sees the real modules.
vi.mock("../src/server/agent/confluenceTools.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/agent/confluenceTools.js")>();
  return { ...actual, buildConfluenceServer: vi.fn(actual.buildConfluenceServer) };
});
vi.mock("../src/server/agent/systemTools.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/server/agent/systemTools.js")>();
  return { ...actual, buildSystemServer: vi.fn(actual.buildSystemServer) };
});
import { buildSystemServer } from "../src/server/agent/systemTools.js";
import { buildAgentRunPlan, conversationScratchDir } from "../src/server/agent/runPlan.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-gaps-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// confluenceTools — the request/attachment plumbing agent-tools.test.ts skips
// ---------------------------------------------------------------------------

describe("confluence tools — request + attachment plumbing", () => {
  function makeConfig(confluenceUrl?: string): AppConfig {
    return createServices({
      dataDir: path.join(tempDir, `conf-${Math.random().toString(36).slice(2)}`),
      agentRuntime: "local",
      sessionSecret: "t",
      confluenceUrl,
    }).config;
  }

  /** Elevated Confluence ctx pointed at `url` (default on-prem) with a PAT. */
  function ctx(url = "https://confluence.internal/confluence", elevated = true) {
    return { config: makeConfig(url), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated };
  }

  /** Stub global fetch with a URL-dispatching handler. Throwing inside rejects. */
  function stubFetch(impl: (url: URL, init: RequestInit) => unknown) {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(impl(new URL(String(input)), init ?? {})),
    );
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  /** A minimal Response-shaped object so content-length/body can be controlled exactly. */
  function fakeBinary(opts: {
    ok?: boolean;
    status?: number;
    contentLength?: string | null;
    contentType?: string | null;
    bytes?: Uint8Array;
    errorText?: string;
  }): Response {
    const { ok = true, status = 200, contentLength = null, contentType = null, bytes, errorText = "" } = opts;
    return {
      ok,
      status,
      headers: {
        get(header: string) {
          const h = header.toLowerCase();
          if (h === "content-length") return contentLength;
          if (h === "content-type") return contentType;
          return null;
        },
      },
      async text() {
        return errorText;
      },
      async arrayBuffer() {
        const b = bytes ?? new Uint8Array();
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  }

  it("describe_config reports host/PAT status when elevated, and refuses otherwise", async () => {
    const configured = await callTool(buildConfluenceTools(ctx()), "describe_config", {});
    expect(configured.isError).toBeFalsy();
    expect(configured.content[0].text).toContain("host: configured");
    expect(configured.content[0].text).toContain("PAT secret: configured");

    // No URL, no PAT → both report "not set" (still no secret leakage).
    const bare = await callTool(
      buildConfluenceTools({ config: makeConfig(), ownerSecrets: {}, elevated: true }),
      "describe_config",
      {},
    );
    expect(bare.content[0].text).toContain("host: not set");
    expect(bare.content[0].text).toContain("PAT secret: not set");

    const denied = await callTool(
      buildConfluenceTools({ ...ctx(), elevated: false }),
      "describe_config",
      {},
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("owner or trusted user");
  });

  it("list_spaces returns space rows, and reports the empty case", async () => {
    stubFetch(() => json({ results: [{ key: "DEV", name: "Development", type: "global" }] }));
    const listed = await callTool(buildConfluenceTools(ctx()), "list_spaces", { limit: 10, start: 0 });
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("DEV");
    expect(listed.content[0].text).toContain("Development");

    stubFetch(() => json({ results: [] }));
    const empty = await callTool(buildConfluenceTools(ctx()), "list_spaces", {});
    expect(empty.content[0].text).toContain("No Confluence spaces found");

    const denied = await callTool(buildConfluenceTools({ ...ctx(), elevated: false }), "list_spaces", {});
    expect(denied.isError).toBe(true);
  });

  it("search rejects an empty query, accepts raw CQL, and reaches the cloud /wiki API base", async () => {
    // No cql / space / title / text / label → buildCql yields only `type=page` → refused.
    const noCriteria = await callTool(buildConfluenceTools(ctx()), "search", {});
    expect(noCriteria.isError).toBe(true);
    expect(noCriteria.content[0].text).toContain("Provide cql or at least one");

    // Raw cql takes precedence and is sent verbatim.
    let seenCql: string | null = null;
    stubFetch((url) => {
      seenCql = url.searchParams.get("cql");
      return json({ size: 0, results: [] });
    });
    const raw = await callTool(buildConfluenceTools(ctx()), "search", { cql: "label = \"runbook\"" });
    expect(raw.isError).toBeFalsy();
    expect(seenCql).toBe('label = "runbook"');

    // Atlassian Cloud base → the REST path is prefixed with /wiki.
    let cloudPath: string | null = null;
    stubFetch((url) => {
      cloudPath = url.pathname;
      return json({ size: 0, results: [] });
    });
    const cloud = await callTool(
      buildConfluenceTools({ config: makeConfig("https://acme.atlassian.net"), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: true }),
      "search",
      { text: "auth" },
    );
    expect(cloud.isError).toBeFalsy();
    expect(cloudPath).toBe("/wiki/rest/api/content/search");
  });

  it("search surfaces an HTTP error (truncated body) and a network failure", async () => {
    // Non-2xx with a long non-JSON body → JSON.parse fallback + truncated detail.
    stubFetch(() => new Response("x".repeat(1200), { status: 502 }));
    const httpErr = await callTool(buildConfluenceTools(ctx()), "search", { text: "auth" });
    expect(httpErr.isError).toBe(true);
    expect(httpErr.content[0].text).toContain("Confluence HTTP 502");
    expect(httpErr.content[0].text).toContain("[truncated");

    // fetch itself rejects → the request-failed catch.
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    const netErr = await callTool(buildConfluenceTools(ctx()), "search", { text: "auth" });
    expect(netErr.isError).toBe(true);
    expect(netErr.content[0].text).toContain("Confluence request failed");
    expect(netErr.content[0].text).toContain("ECONNRESET");
  });

  it("reports an invalid CONFLUENCE_URL as a tool error, not an exception", async () => {
    const res = await callTool(
      buildConfluenceTools({ config: makeConfig("http://"), ownerSecrets: { CONFLUENCE_PAT: "pat" }, elevated: true }),
      "search",
      { text: "auth" },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("CONFLUENCE_URL format is invalid");
  });

  it("get_page returns metadata, labels, ancestors and a truncated body", async () => {
    stubFetch(() =>
      json({
        id: "42",
        type: "page",
        title: "Runbook",
        space: { key: "DEV" },
        version: { number: 3 },
        _links: { webui: "/pages/42" },
        ancestors: [{ id: "1", title: "Root" }],
        metadata: { labels: { results: [{ name: "ops" }, { name: "oncall" }] } },
        body: { storage: { value: "A".repeat(50) } },
      }),
    );
    const res = await callTool(buildConfluenceTools(ctx()), "get_page", { page_id: "42", max_body_chars: 10 });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.title).toBe("Runbook");
    expect(payload.labels).toEqual(["ops", "oncall"]);
    expect(payload.ancestors).toEqual([{ id: "1", title: "Root" }]);
    expect(payload.body_storage).toContain("[truncated");
  });

  it("get_attachment: needs an argument, and errors when metadata lacks a download URL", async () => {
    // Neither attachment_id nor page_id+filename.
    const noArgs = await callTool(buildConfluenceTools(ctx()), "get_attachment", {});
    expect(noArgs.isError).toBe(true);
    expect(noArgs.content[0].text).toContain("Provide attachment_id, or provide page_id with filename");

    // Metadata present but carries no download link.
    stubFetch(() => json({ id: "att-1", type: "attachment", title: "x.bin", metadata: {}, _links: {} }));
    const noUrl = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-1" });
    expect(noUrl.isError).toBe(true);
    expect(noUrl.content[0].text).toContain("did not include a download URL");
  });

  it("get_attachment resolves by page_id+filename and returns a text attachment inline", async () => {
    stubFetch((url) => {
      if (url.pathname.includes("/child/attachment")) {
        return json({
          results: [
            {
              id: "att-9",
              type: "attachment",
              title: "notes.txt",
              metadata: {},
              extensions: { fileSize: 5 },
              _links: { download: "/download/attachments/7/notes.txt" },
            },
          ],
        });
      }
      // The binary download: octet-stream content-type forces media-type-from-filename.
      return fakeBinary({ contentType: "application/octet-stream", bytes: new TextEncoder().encode("hello") });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { page_id: "7", filename: "notes.txt" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.download.returnedAs).toBe("text");
    expect(payload.text).toBe("hello");
  });

  it("get_attachment reports a filename not present on the page", async () => {
    stubFetch(() => json({ results: [{ id: "att-9", type: "attachment", title: "other.txt", _links: {} }] }));
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { page_id: "7", filename: "missing.txt" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No Confluence attachment named "missing.txt"');
  });

  it("get_attachment notes an unsupported (non-image, non-text) media type instead of inlining it", async () => {
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-z")) {
        return json({
          id: "att-z",
          type: "attachment",
          title: "archive.zip",
          metadata: { mediaType: "application/zip" },
          _links: { download: "/download/attachments/7/archive.zip" },
        });
      }
      return fakeBinary({ contentType: "application/zip", bytes: new Uint8Array([1, 2, 3]) });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-z" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    expect(payload.note).toContain("not returned inline");
  });

  it("get_attachment enforces size limits from content-length, HTTP status, and post-download length", async () => {
    // content-length already exceeds max_bytes → rejected before reading the body.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-big")) {
        return json({ id: "att-big", title: "big.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/big.png" } });
      }
      return fakeBinary({ contentLength: "9999999", contentType: "image/png" });
    });
    const tooLargeHeader = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-big", max_bytes: 8 });
    expect(tooLargeHeader.isError).toBe(true);
    expect(tooLargeHeader.content[0].text).toContain("too large");

    // Download returns a non-2xx status.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-403")) {
        return json({ id: "att-403", title: "denied.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/denied.png" } });
      }
      return fakeBinary({ ok: false, status: 403, errorText: "forbidden" });
    });
    const forbidden = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-403" });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content[0].text).toContain("Confluence HTTP 403");

    // No content-length header, but the body itself exceeds max_bytes.
    stubFetch((url) => {
      if (url.pathname.endsWith("/content/att-stream")) {
        return json({ id: "att-stream", title: "s.png", metadata: { mediaType: "image/png" }, _links: { download: "/download/x/s.png" } });
      }
      return fakeBinary({ contentType: "image/png", bytes: new Uint8Array(64) });
    });
    const oversizeBody = await callTool(buildConfluenceTools(ctx()), "get_attachment", { attachment_id: "att-stream", max_bytes: 10 });
    expect(oversizeBody.isError).toBe(true);
    expect(oversizeBody.content[0].text).toContain("too large");
  });

  it("extract_page_assets can download referenced images and records a failed download", async () => {
    stubFetch((url) => {
      if (url.pathname.includes("/child/attachment")) {
        return json({
          results: [
            {
              id: "img-ok",
              type: "attachment",
              title: "diagram.png",
              metadata: { mediaType: "image/png" },
              _links: { download: "/download/attachments/p/diagram.png" },
            },
            {
              id: "img-bad",
              type: "attachment",
              title: "broken.png",
              metadata: { mediaType: "image/png" },
              _links: { download: "/download/attachments/p/broken.png" },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/diagram.png")) {
        return fakeBinary({ contentType: "image/png", bytes: new Uint8Array([9, 9, 9]) });
      }
      if (url.pathname.endsWith("/broken.png")) {
        return fakeBinary({ ok: false, status: 500, errorText: "boom" });
      }
      // The page body: image refs (with HTML numeric entities) + a drawio macro
      // whose parameter name is a bare "file" so the candidate branch is exercised.
      return json({
        id: "p",
        type: "page",
        title: "Arch",
        space: { key: "DEV" },
        version: { number: 1 },
        _links: { webui: "/pages/p" },
        body: {
          storage: {
            value:
              '<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>' +
              '<ac:image><ri:attachment ri:filename="broke&#x6e;.png" /></ac:image>' +
              '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="file">flow.drawio</ac:parameter></ac:structured-macro>',
          },
        },
      });
    });
    const res = await callTool(buildConfluenceTools(ctx()), "extract_page_assets", {
      page_id: "p",
      include_images: true,
      max_images: 5,
    });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text ?? "{}");
    // Numeric entity decoded: broke&#x6e;.png → broken.png.
    expect(payload.references.imageFilenames).toContain("broken.png");
    expect(payload.references.drawioMacros[0].candidateFilenames).toContain("flow.drawio");
    // One image downloaded OK (an image block returned), one recorded as an error.
    const errored = payload.inlineImages.find((i: { error?: string }) => i.error);
    expect(errored).toBeTruthy();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });

  it("never sends anything but GET to Confluence", async () => {
    // The write TOOLS are gone; this pins the layer underneath them, since the
    // PAT in play is the owner's and carries their full write access.
    const methods: (string | undefined)[] = [];
    stubFetch((url, init) => {
      methods.push(init.method);
      return json({ id: "1", type: "page", title: "T", version: { number: 1 }, results: [] });
    });
    const tools = buildConfluenceTools(ctx());
    const argsByTool: Record<string, Record<string, unknown>> = {
      list_spaces: {},
      search: { text: "auth" },
      get_page: { page_id: "1" },
      list_attachments: { page_id: "1" },
      extract_page_assets: { page_id: "1" },
    };
    for (const [name, args] of Object.entries(argsByTool)) {
      await callTool(tools, name, args);
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === undefined || method === "GET")).toBe(true);
  });

  it("buildConfluenceServer exposes the named MCP server", () => {
    const server = buildConfluenceServer(ctx());
    expect(server).toBeTruthy();
    expect(CONFLUENCE_SERVER_NAME).toBe("confluence");
  });

  describe("get_attachment save_to_workspace", () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let workspace: string;
    beforeEach(() => {
      workspace = path.join(tempDir, "scratch");
      fs.mkdirSync(workspace);
    });
    const savedDir = () => path.join(workspace, "confluence");

    /**
     * Serve ONE attachment: metadata at /content/<requestedId> (its `id` field
     * may differ, for a hostile id), bytes at the download link. Returns every
     * request's method, so a test can pin that the save stays GET-only.
     */
    function serve(
      meta: { requestedId: string; id?: string; title?: string; mediaType?: string },
      bytes: Uint8Array,
    ): (string | undefined)[] {
      const methods: (string | undefined)[] = [];
      stubFetch((url, init) => {
        methods.push(init.method);
        if (url.pathname.endsWith(`/content/${meta.requestedId}`)) {
          return json({
            id: meta.id ?? meta.requestedId,
            type: "attachment",
            title: meta.title,
            metadata: meta.mediaType ? { mediaType: meta.mediaType } : {},
            _links: { download: "/download/attachments/7/file" },
          });
        }
        return fakeBinary({ contentType: meta.mediaType ?? null, bytes });
      });
      return methods;
    }

    /** get_attachment with save_to_workspace on, against this test's workspace. */
    function save(
      args: Record<string, unknown>,
      over: { visionEnabled?: boolean; workspaceDir?: string; elevated?: boolean } = {},
    ) {
      return callTool(
        buildConfluenceTools({ ...ctx(), workspaceDir: workspace, ...over }),
        "get_attachment",
        { save_to_workspace: true, ...args },
      );
    }

    const savedPathOf = (res: { content: { text?: string }[] }): string =>
      JSON.parse(res.content[0].text ?? "{}").savedPath;

    it("declares the option as an optional boolean and names it in the description", () => {
      const getAttachment = buildConfluenceTools(ctx()).find((t) => t.name === "get_attachment")!;
      expect(getAttachment.description).toContain("save_to_workspace");
      expect(getAttachment.description).toContain("savedPath");
      const shape = getAttachment.inputSchema as Record<string, { safeParse(v: unknown): { success: boolean } }>;
      expect(shape.save_to_workspace.safeParse(undefined).success).toBe(true);
      expect(shape.save_to_workspace.safeParse(true).success).toBe(true);
      expect(shape.save_to_workspace.safeParse("yes").success).toBe(false);
    });

    it("saves an image under confluence/ and still returns the image block on a vision run", async () => {
      const methods = serve({ requestedId: "att-1", title: "Architecture Diagram.PNG", mediaType: "image/png" }, PNG);
      const res = await save({ attachment_id: "att-1" });
      expect(res.isError).toBeFalsy();
      const payload = JSON.parse(res.content[0].text ?? "{}");
      const expected = path.join(savedDir(), "att-1-Architecture-Diagram.png");
      expect(payload.savedPath).toBe(expected);
      expect(path.isAbsolute(payload.savedPath)).toBe(true);
      expect(fs.readFileSync(expected)).toEqual(Buffer.from(PNG));
      // Unchanged inline behavior: the image block rides along with the save.
      expect(payload.download.returnedAs).toBe("image");
      expect(res.content[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      });
      // A LOCAL write: Confluence itself only ever saw the two GETs.
      expect(methods).toHaveLength(2);
      expect(methods.every((method) => method === undefined || method === "GET")).toBe(true);
    });

    it("undoes a save that lands after its conversation was deleted (the copy sweep already ran)", async () => {
      // A delete cannot stop a download already in flight: when the save lands
      // the conversation row is gone, so the copy is removed again.
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const gone = await callTool(
        buildConfluenceTools({ ...ctx(), workspaceDir: workspace, isConversationLive: () => false }),
        "get_attachment",
        { save_to_workspace: true, attachment_id: "att-1" },
      );
      expect(gone.isError).toBeFalsy();
      const payload = JSON.parse(gone.content[0].text ?? "{}");
      expect(payload.savedPath).toBeUndefined();
      expect(payload.saveError).toContain("deleted");
      expect(fs.existsSync(path.join(savedDir(), "att-1-diagram.png"))).toBe(false);
      // The read itself still answers: the image block rides along as before.
      expect(gone.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });

      // Control: a live conversation keeps its copy.
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const live = await callTool(
        buildConfluenceTools({ ...ctx(), workspaceDir: workspace, isConversationLive: () => true }),
        "get_attachment",
        { save_to_workspace: true, attachment_id: "att-1" },
      );
      expect(fs.existsSync(savedPathOf(live))).toBe(true);
    });

    it("saves any media type: a non-inline zip, a draw.io diagram, a text file found by name", async () => {
      const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
      serve({ requestedId: "att-z", title: "archive.zip", mediaType: "application/zip" }, zip);
      const zipPayload = JSON.parse((await save({ attachment_id: "att-z" })).content[0].text ?? "{}");
      expect(zipPayload.savedPath).toBe(path.join(savedDir(), "att-z-archive.zip"));
      expect(zipPayload.note).toContain("not returned inline");
      expect(zipPayload.note).toContain("saved at savedPath");
      expect(fs.readFileSync(zipPayload.savedPath)).toEqual(Buffer.from(zip));

      const mxfile = "<mxfile><diagram/></mxfile>";
      serve({ requestedId: "att-d", title: "flow.drawio", mediaType: "application/vnd.jgraph.mxfile" }, new TextEncoder().encode(mxfile));
      const drawio = JSON.parse((await save({ attachment_id: "att-d" })).content[0].text ?? "{}");
      expect(drawio.savedPath).toBe(path.join(savedDir(), "att-d-flow.drawio"));
      expect(drawio.download.returnedAs).toBe("text");
      expect(drawio.text).toBe(mxfile);
      expect(fs.readFileSync(drawio.savedPath, "utf8")).toBe(mxfile);

      // Resolved from the page listing: the saved name carries the LISTED id.
      stubFetch((url) => {
        if (url.pathname.includes("/child/attachment")) {
          return json({
            results: [{ id: "att-9", type: "attachment", title: "notes.txt", metadata: {}, _links: { download: "/download/attachments/7/notes.txt" } }],
          });
        }
        return fakeBinary({ contentType: "application/octet-stream", bytes: new TextEncoder().encode("hello") });
      });
      const notes = JSON.parse((await save({ page_id: "7", filename: "notes.txt" })).content[0].text ?? "{}");
      expect(notes.savedPath).toBe(path.join(savedDir(), "att-9-notes.txt"));
      expect(notes.text).toBe("hello");
    });

    it("on a text-only run saves the image and says so, with no image block", async () => {
      serve({ requestedId: "att-1", title: "chart.png", mediaType: "image/png" }, PNG);
      const res = await save({ attachment_id: "att-1" }, { visionEnabled: false });
      expect(res.isError).toBeFalsy();
      expect(res.content).toHaveLength(1);
      const payload = JSON.parse(res.content[0].text ?? "{}");
      expect(payload.note).toContain("cannot accept image input");
      expect(payload.note).toContain("saved at savedPath");
      expect(fs.readFileSync(payload.savedPath)).toEqual(Buffer.from(PNG));
    });

    it("builds a safe single-segment name from any title and id", async () => {
      const cases: { id: string; responseId?: string; title?: string; mediaType: string; expected: string }[] = [
        // A Hangul-only stem → `attachment`, keeping the title's own extension.
        { id: "att-k", title: "아키텍처 다이어그램.png", mediaType: "image/png", expected: "att-k-attachment.png" },
        // Unsafe runs collapse to ONE `-`; the extension is lowercased.
        { id: "att-m", title: "Q3 매출 차트 v2.PNG", mediaType: "image/png", expected: "att-m-Q3-v2.png" },
        // Separators never survive, and leading dots are trimmed.
        { id: "att-p", title: "../../etc/passwd", mediaType: "text/plain", expected: "att-p-etc-passwd" },
        // A hostile id in the metadata is made safe the same way.
        { id: "att-h", responseId: "../../evil", title: "x.png", mediaType: "image/png", expected: "evil-x.png" },
        // No title at all → attachment.<ext from the media type>, else .bin.
        { id: "att-e", mediaType: "image/jpeg", expected: "att-e-attachment.jpg" },
        { id: "att-u", mediaType: "application/x-unknown", expected: "att-u-attachment.bin" },
        // ≤ 80 chars with the extension, re-trimmed when the cut ends on `-`.
        { id: "att-l", title: `${"A".repeat(200)}.png`, mediaType: "image/png", expected: `att-l-${"A".repeat(76)}.png` },
        { id: "att-t", title: `${"a".repeat(75)} b.png`, mediaType: "image/png", expected: `att-t-${"a".repeat(75)}.png` },
      ];
      for (const c of cases) {
        serve({ requestedId: c.id, id: c.responseId, title: c.title, mediaType: c.mediaType }, PNG);
        const res = await save({ attachment_id: c.id }, { visionEnabled: false });
        expect(res.isError, c.expected).toBeFalsy();
        expect(savedPathOf(res), c.expected).toBe(path.join(savedDir(), c.expected));
      }
      // Every file landed directly inside confluence/ and nowhere else.
      expect(fs.readdirSync(workspace)).toEqual(["confluence"]);
      expect(fs.readdirSync(savedDir()).sort()).toEqual(cases.map((c) => c.expected).sort());
    });

    it("never overwrites a different file, and reuses one with identical bytes", async () => {
      fs.mkdirSync(savedDir());
      const taken = path.join(savedDir(), "att-1-diagram.png");
      fs.writeFileSync(taken, "someone else's file");
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const first = savedPathOf(await save({ attachment_id: "att-1" }));
      expect(first).toBe(path.join(savedDir(), "att-1-diagram-2.png"));
      expect(fs.readFileSync(taken, "utf8")).toBe("someone else's file");

      // The same bytes again → the same file, not another copy.
      expect(savedPathOf(await save({ attachment_id: "att-1" }))).toBe(first);

      // A changed attachment → the next free name.
      const changed = new Uint8Array([...PNG, 9]);
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, changed);
      const third = savedPathOf(await save({ attachment_id: "att-1" }));
      expect(third).toBe(path.join(savedDir(), "att-1-diagram-3.png"));
      expect(fs.readFileSync(third)).toEqual(Buffer.from(changed));
      expect(fs.readdirSync(savedDir()).sort()).toEqual([
        "att-1-diagram-2.png",
        "att-1-diagram-3.png",
        "att-1-diagram.png",
      ]);
    });

    it("never follows a symlink — neither the confluence/ folder nor a planted file name", async () => {
      const outside = path.join(tempDir, "outside");
      fs.mkdirSync(outside);
      const methods = serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);

      // confluence/ → a folder outside the workspace: refused by the pre-check
      // (no request sent), nothing lands there.
      fs.symlinkSync(outside, savedDir());
      const viaLink = await save({ attachment_id: "att-1" });
      expect(viaLink.isError).toBe(true);
      expect(viaLink.content[0].text).toContain("not a plain folder");
      expect(viaLink.content[0].text).toContain("without save_to_workspace");
      expect(fs.readdirSync(outside)).toEqual([]);

      // A FILE named confluence is refused the same way.
      fs.unlinkSync(savedDir());
      fs.writeFileSync(savedDir(), "");
      const viaFile = await save({ attachment_id: "att-1" });
      expect(viaFile.isError).toBe(true);
      expect(viaFile.content[0].text).toContain("not a plain folder");
      expect(methods).toEqual([]);

      // Symlinks planted at the name — one dangling, one to IDENTICAL bytes —
      // are skipped: never written through, never reused.
      fs.unlinkSync(savedDir());
      fs.mkdirSync(savedDir());
      const identical = path.join(outside, "same.png");
      fs.writeFileSync(identical, PNG);
      fs.symlinkSync(path.join(outside, "created-through-link.png"), path.join(savedDir(), "att-1-diagram.png"));
      fs.symlinkSync(identical, path.join(savedDir(), "att-1-diagram-2.png"));
      const planted = savedPathOf(await save({ attachment_id: "att-1" }));
      expect(planted).toBe(path.join(savedDir(), "att-1-diagram-3.png"));
      expect(fs.lstatSync(planted).isFile()).toBe(true);
      expect(fs.readdirSync(outside)).toEqual(["same.png"]);
    });

    it("without a workspace, refuses before sending any request", async () => {
      const methods = serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const res = await save({ attachment_id: "att-1" }, { workspaceDir: undefined });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Saving attachments to the workspace is not available in this run.");
      expect(methods).toEqual([]);
    });

    it("reports a workspace that no longer exists before the download, instead of recreating it", async () => {
      const methods = serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const gone = path.join(tempDir, "deleted-conversation");
      const res = await save({ attachment_id: "att-1" }, { workspaceDir: gone });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("no longer exists");
      expect(methods).toEqual([]);
      expect(fs.existsSync(gone)).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "a workspace it cannot write is refused before the download, creating nothing",
      async () => {
        const methods = serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
        fs.chmodSync(workspace, 0o555);
        try {
          const res = await save({ attachment_id: "att-1" });
          expect(res.isError).toBe(true);
          expect(res.content[0].text).toContain("not writable");
          expect(res.content[0].text).toContain("without save_to_workspace");
          expect(methods).toEqual([]);
        } finally {
          fs.chmodSync(workspace, 0o755);
        }
        expect(fs.existsSync(savedDir())).toBe(false);
      },
    );

    it("past the numbered names falls back to a timestamped random name, still never overwriting", async () => {
      // A daily routine re-saving a CHANGING attachment into one workspace
      // eventually holds every numbered name.
      fs.mkdirSync(savedDir());
      const numbered = ["att-1-diagram.png", ...Array.from({ length: 99 }, (_, i) => `att-1-diagram-${i + 2}.png`)];
      for (const name of numbered) fs.writeFileSync(path.join(savedDir(), name), `taken ${name}`);
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const fallback = await save({ attachment_id: "att-1" });
      expect(fallback.isError).toBeFalsy();
      const first = savedPathOf(fallback);
      expect(path.dirname(first)).toBe(savedDir());
      expect(path.basename(first)).toMatch(/^att-1-diagram-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
      expect(fs.readFileSync(first)).toEqual(Buffer.from(PNG));
      for (const name of numbered) {
        expect(fs.readFileSync(path.join(savedDir(), name), "utf8")).toBe(`taken ${name}`);
      }

      // The next change lands on yet another fresh name.
      const changed = new Uint8Array([...PNG, 7]);
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, changed);
      const second = savedPathOf(await save({ attachment_id: "att-1" }));
      expect(second).not.toBe(first);
      expect(path.basename(second)).toMatch(/^att-1-diagram-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
      expect(fs.readFileSync(second)).toEqual(Buffer.from(changed));
      expect(fs.readdirSync(savedDir())).toHaveLength(numbered.length + 2);
    });

    it("a save that fails after the download keeps the inline result and reports saveError", async () => {
      const outside = path.join(tempDir, "outside");
      fs.mkdirSync(outside);
      /** Serve `att-1`, swapping a link in at confluence/ WHILE its download is in flight. */
      const serveRacing = (mediaType: string, bytes: Uint8Array) =>
        stubFetch((url) => {
          if (url.pathname.endsWith("/content/att-1")) {
            return json({
              id: "att-1",
              type: "attachment",
              title: mediaType === "image/png" ? "diagram.png" : "archive.zip",
              metadata: { mediaType },
              _links: { download: "/download/attachments/7/file" },
            });
          }
          // The pre-check already passed; the agent's shell swaps the folder now.
          fs.symlinkSync(outside, savedDir());
          return fakeBinary({ contentType: mediaType, bytes });
        });

      serveRacing("image/png", PNG);
      const image = await save({ attachment_id: "att-1" });
      expect(image.isError).toBeFalsy();
      const imagePayload = JSON.parse(image.content[0].text ?? "{}");
      expect(imagePayload.saveError).toContain("not a plain folder");
      expect(imagePayload.savedPath).toBeUndefined();
      // Only the copy is lost: the image block still comes back.
      expect(imagePayload.download.returnedAs).toBe("image");
      expect(image.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });

      // A non-inline type keeps its note, which must not claim a saved file.
      fs.unlinkSync(savedDir());
      serveRacing("application/zip", new Uint8Array([0x50, 0x4b, 3, 4]));
      const zipPayload = JSON.parse((await save({ attachment_id: "att-1" })).content[0].text ?? "{}");
      expect(zipPayload.saveError).toContain("not a plain folder");
      expect(zipPayload.note).toContain("not returned inline");
      expect(zipPayload.note).not.toContain("saved at savedPath");
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("writes nothing unless save_to_workspace is set", async () => {
      serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      const res = await callTool(buildConfluenceTools({ ...ctx(), workspaceDir: workspace }), "get_attachment", {
        attachment_id: "att-1",
      });
      expect(res.isError).toBeFalsy();
      expect(savedPathOf(res)).toBeUndefined();
      expect(fs.readdirSync(workspace)).toEqual([]);
    });

    it("keeps the elevated gate first: a non-elevated viewer saves and sends nothing", async () => {
      const methods = serve({ requestedId: "att-1", title: "diagram.png", mediaType: "image/png" }, PNG);
      for (const workspaceDir of [workspace, undefined]) {
        const res = await save({ attachment_id: "att-1" }, { elevated: false, workspaceDir });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain("owner or trusted user");
      }
      expect(methods).toEqual([]);
      expect(fs.readdirSync(workspace)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// runPlan.ts — which workspace the Confluence save targets, and the ONE
// boolean both metacognition surfaces offer it on
// ---------------------------------------------------------------------------

describe("run plan — the Confluence save target", () => {
  it("conversationScratchDir is the cwd, or the scratch additional dir behind an open repo", () => {
    expect(conversationScratchDir({ conversationId: "c1", cwd: "/ws/c1" })).toBe("/ws/c1");
    expect(
      conversationScratchDir({
        conversationId: "c1",
        cwd: "/clones/repo",
        additionalDirs: ["/ws/c1"],
        activeRepoName: "repo",
      }),
    ).toBe("/ws/c1");
    // No conversation (profile generators, consultations): no conversation workspace.
    expect(conversationScratchDir({ cwd: "/ws/intro" })).toBeUndefined();
    // An open repo without its scratch dir fails closed — never the clone.
    expect(
      conversationScratchDir({ conversationId: "c1", cwd: "/clones/repo", activeRepoName: "repo" }),
    ).toBeUndefined();
  });

  function setup(dir: string, opts: { confluenceUrl?: string; pat?: boolean } = {}) {
    const { store, config } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
      confluenceUrl: opts.confluenceUrl,
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    if (opts.pat) store.setUserSecret(owner.id, "CONFLUENCE_PAT", "pat");
    const scratch = path.join(tempDir, dir, "workspaces", "conv-1");
    fs.mkdirSync(scratch, { recursive: true });
    return { store, config, owner, scratch };
  }

  function request(s: ReturnType<typeof setup>, over: Partial<AgentRequest> = {}): AgentRequest {
    return {
      message: "hi",
      avatar: { id: s.owner.id, displayName: "Owner", alias: "", persona: "" },
      viewerUserId: s.owner.id,
      viewerIsOwner: true,
      conversationId: "conv-1",
      cwd: s.scratch,
      ...over,
    };
  }

  async function plan(s: ReturnType<typeof setup>, req: AgentRequest) {
    vi.mocked(buildConfluenceServer).mockClear();
    vi.mocked(buildSystemServer).mockClear();
    const result = await buildAgentRunPlan(req, [], s.config, s.store, undefined, undefined, () => 0);
    return {
      result,
      confluenceCtx: vi.mocked(buildConfluenceServer).mock.calls[0][0],
      // Read loosely: describe_system's ctx declares these in systemTools.ts.
      systemCtx: vi.mocked(buildSystemServer).mock.calls[0][1] as unknown as {
        scratchWorkspaceDir?: string;
        confluenceSaveToWorkspace?: boolean;
        canWriteFiles?: boolean;
      },
    };
  }

  it("hands the tools the conversation scratch workspace, never an open repo clone", async () => {
    const s = setup("plan-target", { confluenceUrl: "https://confluence.internal", pat: true });
    const plain = await plan(s, request(s));
    expect(plain.confluenceCtx.workspaceDir).toBe(s.scratch);
    expect(plain.systemCtx.scratchWorkspaceDir).toBe(s.scratch);
    // The path rides describe_system's ctx only; the plan returns just the
    // boolean runClaudeAgent stamps onto the prompt.
    expect(Object.keys(plain.result)).not.toContain("scratchWorkspaceDir");
    expect(plain.result.confluenceSaveToWorkspace).toBe(true);
    expect(plain.systemCtx.confluenceSaveToWorkspace).toBe(true);
    expect(plain.systemCtx.canWriteFiles).toBe(true);

    const clone = path.join(tempDir, "plan-target", "clones", "repo");
    fs.mkdirSync(clone, { recursive: true });
    const withRepo = await plan(
      s,
      request(s, { cwd: clone, additionalDirs: [s.scratch], activeRepoName: "repo" }),
    );
    expect(withRepo.confluenceCtx.workspaceDir).toBe(s.scratch);
    expect(withRepo.systemCtx.scratchWorkspaceDir).toBe(s.scratch);
    expect(withRepo.result.confluenceSaveToWorkspace).toBe(true);
  });

  it("offers the save only where it can land: registered, elevated, a workspace, and credentials", async () => {
    const s = setup("plan-offer", { confluenceUrl: "https://confluence.internal", pat: true });
    const colleague = s.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    // A colleague is refused by the tools' own `elevated` gate — no offer.
    const notElevated = await plan(s, request(s, { viewerUserId: colleague.id, viewerIsOwner: false }));
    expect(notElevated.result.confluenceSaveToWorkspace).toBe(false);
    expect(notElevated.confluenceCtx.elevated).toBe(false);
    // The Confluence tool group is not registered this run.
    const deselected = await plan(s, request(s, { mcpToolGroups: ["personal_knowledge"] }));
    expect(deselected.result.confluenceSaveToWorkspace).toBe(false);
    // No conversation workspace: the tools get none and refuse the option.
    const noWorkspace = await plan(s, request(s, { conversationId: undefined }));
    expect(noWorkspace.confluenceCtx.workspaceDir).toBeUndefined();
    expect(noWorkspace.systemCtx.scratchWorkspaceDir).toBeUndefined();
    expect(noWorkspace.result.confluenceSaveToWorkspace).toBe(false);
    // Credentials: the tools' own check — URL and the owner's PAT.
    const noPat = setup("plan-no-pat", { confluenceUrl: "https://confluence.internal" });
    expect((await plan(noPat, request(noPat))).result.confluenceSaveToWorkspace).toBe(false);
    const noUrl = setup("plan-no-url", { pat: true });
    expect((await plan(noUrl, request(noUrl))).systemCtx.confluenceSaveToWorkspace).toBe(false);
  });

  it("canWriteFiles follows the elevated built-in gate, on describe_system's ctx and the plan alike", async () => {
    const s = setup("plan-can-write");
    const colleague = s.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    const cases: { label: string; over: Partial<AgentRequest>; expected: boolean }[] = [
      { label: "owner chat", over: {}, expected: true },
      { label: "read-only colleague", over: { viewerUserId: colleague.id, viewerIsOwner: false }, expected: false },
      // Profile generators: headless without the opt-in stay tool-restricted.
      { label: "restricted headless", over: { headless: true, conversationId: undefined }, expected: false },
      { label: "owner routine", over: { headless: true, allowHeadlessTools: true }, expected: true },
    ];
    for (const c of cases) {
      const { result, systemCtx } = await plan(s, request(s, c.over));
      expect(systemCtx.canWriteFiles, c.label).toBe(c.expected);
      expect(result.canWriteFiles, c.label).toBe(c.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// brainTools — personal second-brain search over a REAL local clone
// ---------------------------------------------------------------------------

/** Seed a bare remote from `files` (repo-relative path → content) on `main`. */
function seedRemote(dir: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(dir, "remote.git"));
  const seed = path.join(dir, "seed");
  gitInit(seed);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

describe("brain tools — search + get_note over a real vault", () => {
  function setup(dir: string, files: Record<string, string> | null) {
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    if (files) {
      const remote = seedRemote(base, files);
      store.setKnowledgeRepo(owner.id, remote, "main");
    }
    return { store, config, owner };
  }
  // Omit `elevated` so the `elevated ?? viewerIsOwner` default path is exercised.
  const tools = (s: ReturnType<typeof setup>) =>
    buildBrainTools(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config });

  const NOTE = "---\ntitle: Deploy Guide\ntags: [ops]\naliases: [rollout]\n---\nUse kubernetes to deploy the service.\n";

  it("ranks a matching wiki note and reads it back with get_note", async () => {
    const s = setup("brain-hit", { "wiki/concepts/deploy.md": NOTE, "README.md": "x" });
    const hit = await callTool(tools(s), "search", { query: "deploy" });
    expect(hit.isError).toBeFalsy();
    expect(hit.content[0].text).toContain("wiki/concepts/deploy.md");
    expect(hit.content[0].text).toContain("Deploy Guide");

    const note = await callTool(tools(s), "get_note", { path: "wiki/concepts/deploy.md" });
    expect(note.isError).toBeFalsy();
    expect(note.content[0].text).toContain("Use kubernetes to deploy");
  });

  it("reports no matches distinctly from an absent vault", async () => {
    const withVault = setup("brain-empty", { "wiki/concepts/deploy.md": NOTE });
    const noMatch = await callTool(tools(withVault), "search", { query: "somethingnobodywrote" });
    expect(noMatch.isError).toBeFalsy();
    expect(noMatch.content[0].text).toContain("No notes in your second brain matched");

    // A repo with neither wiki/ nor raw/ → the migrate-first message.
    const noVault = setup("brain-novault", { "README.md": "just a readme" });
    const res = await callTool(tools(noVault), "search", { query: "deploy" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("brain-migrate");
  });

  it("get_note surfaces a read failure for a missing wiki path", async () => {
    const s = setup("brain-missing", { "wiki/concepts/deploy.md": NOTE });
    const res = await callTool(tools(s), "get_note", { path: "wiki/does-not-exist.md" });
    expect(res.isError).toBe(true);
    // readFile's resolveInRepo guards containment + existence together, so a
    // missing (but wiki-scoped) path decodes to the INVALID_PATH sentinel.
    expect(res.content[0].text).toContain("Invalid path");
  });

  it("maps a clone failure to the load-failure message", async () => {
    const s = setup("brain-clone-fail", null);
    // Point at a bogus local remote so ensureClone throws.
    s.store.setKnowledgeRepo(s.owner.id, path.join(tempDir, "nope.git"), "main");
    const res = await callTool(tools(s), "search", { query: "deploy" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Failed to load the repository");
    expect(res.content[0].text).toContain("no git credentials");
  });

  it("buildBrainServer exposes the named MCP server", () => {
    const s = setup("brain-server", null);
    expect(buildBrainServer(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(BRAIN_SERVER_NAME).toBe("brain");
  });
});

// ---------------------------------------------------------------------------
// groupBrainTools — team second-brain search over a REAL local group clone
// ---------------------------------------------------------------------------

describe("group brain tools — search + get_note over a real group vault", () => {
  function setup(dir: string, files: Record<string, string> | null) {
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const group = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(group.id, owner.id, "member");
    if (files) {
      const remote = seedRemote(base, files);
      store.setGroupKnowledgeRepo(group.id, remote, "main");
    }
    return { store, config, owner, group };
  }
  const tools = (s: ReturnType<typeof setup>) =>
    buildGroupBrainTools(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config });

  const NOTE = "---\ntitle: Team Runbook\ntags: [oncall]\n---\nEscalate incidents to the platform channel.\n";

  it("ranks a matching group note and reads it with get_note", async () => {
    const s = setup("gb-hit", { "wiki/runbook.md": NOTE });
    const hit = await callTool(tools(s), "search", { group: "Team", query: "incidents" });
    expect(hit.isError).toBeFalsy();
    expect(hit.content[0].text).toContain("Team Runbook");
    expect(hit.content[0].text).toContain("'Team' team brain");

    const note = await callTool(tools(s), "get_note", { group: "Team", path: "wiki/runbook.md" });
    expect(note.isError).toBeFalsy();
    expect(note.content[0].text).toContain("Escalate incidents");
  });

  it("reports no matches, and points a vault-less group repo at brain-migrate", async () => {
    const withVault = setup("gb-empty", { "wiki/runbook.md": NOTE });
    const noMatch = await callTool(tools(withVault), "search", { group: "Team", query: "unrelatedxyz" });
    expect(noMatch.isError).toBeFalsy();
    expect(noMatch.content[0].text).toContain("team brain matched");

    const noVault = setup("gb-novault", { "README.md": "x" });
    const res = await callTool(tools(noVault), "search", { group: "Team", query: "incidents" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("brain-migrate");
  });

  it("get_note surfaces a read failure for a missing group wiki path", async () => {
    const s = setup("gb-missing", { "wiki/runbook.md": NOTE });
    const res = await callTool(tools(s), "get_note", { group: "Team", path: "wiki/ghost.md" });
    expect(res.isError).toBe(true);
    // Same containment+existence guard as the personal server.
    expect(res.content[0].text).toContain("Invalid path");
  });

  it("buildGroupBrainServer exposes the named MCP server", () => {
    const s = setup("gb-server", null);
    expect(buildGroupBrainServer(s.store, { avatarUserId: s.owner.id, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(GROUP_BRAIN_SERVER_NAME).toBe("group_brain");
  });
});

// ---------------------------------------------------------------------------
// groupRepoTools — list_groups, scaffold_skill, commit failure, create_repo
// ---------------------------------------------------------------------------

describe("group repo tools — coverage gaps", () => {
  function setup(dir: string, opts: { connectRepo?: boolean; role?: "admin" | "member"; withGroup?: boolean } = {}) {
    const { connectRepo = true, role = "admin", withGroup = true } = opts;
    const base = path.join(tempDir, dir);
    fs.mkdirSync(base, { recursive: true });
    const { store, config } = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.setGitToken(owner.id, "tkn");
    let group: { id: string; name: string } | null = null;
    let remote: string | null = null;
    if (withGroup) {
      group = store.createGroup({ name: "Team", createdBy: null });
      store.addGroupMember(group.id, owner.id, role);
      if (connectRepo) {
        remote = seedRemote(base, { "README.md": "# team" });
        store.setGroupKnowledgeRepo(group.id, remote, "main");
      }
    }
    return { store, config, owner: { id: owner.id, username: "owner", displayName: "Owner" }, ownerId: owner.id, group, remote, base };
  }
  const tools = (s: ReturnType<typeof setup>, opts: { createRemoteRepo?: Parameters<typeof buildGroupRepoTools>[2] } = {}) =>
    buildGroupRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config },
      opts.createRemoteRepo ?? {},
    );

  it("list_groups renders the owner's groups, and the no-groups case", async () => {
    const withGroup = setup("gr-list");
    const listed = await callTool(tools(withGroup), "list_groups", {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("1 group(s) I belong to");
    expect(listed.content[0].text).toContain("Team");
    expect(listed.content[0].text).toContain("admin");
    expect(listed.content[0].text).toContain("connected");

    const none = setup("gr-list-none", { withGroup: false });
    const empty = await callTool(tools(none), "list_groups", {});
    expect(empty.content[0].text).toContain("do not belong to any group");
  });

  it("scaffold_skill creates a skill in the group repo for an admin", async () => {
    const s = setup("gr-scaffold");
    const res = await callTool(tools(s), "scaffold_skill", { group: "Team", name: "Team Runbook", description: "escalation steps" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("skills/team-runbook/SKILL.md");
  });

  it("commit surfaces a rebase conflict from an external push", async () => {
    const s = setup("gr-conflict");
    // Establish v1 of a file.
    await callTool(tools(s), "write_file", { group: "Team", path: "notes/x.md", content: "v1" });
    const first = await callTool(tools(s), "commit", { group: "Team", message: "x v1" });
    expect(first.isError).toBeFalsy();

    // A pending local edit to the SAME file…
    await callTool(tools(s), "write_file", { group: "Team", path: "notes/x.md", content: "local edit" });
    // …while an external actor pushes a conflicting change to notes/x.md.
    const ext = path.join(s.base, "ext");
    execFileSync("git", ["clone", "-q", s.remote!, ext], { stdio: "pipe" });
    const g = (...a: string[]) => execFileSync("git", ["-C", ext, ...a], { stdio: "pipe" });
    g("config", "user.email", "e@x.local");
    g("config", "user.name", "Ext");
    fs.writeFileSync(path.join(ext, "notes", "x.md"), "external edit");
    g("add", "-A");
    g("commit", "-q", "-m", "external");
    g("push", "-q", "origin", "main");

    const res = await callTool(tools(s), "commit", { group: "Team", message: "x local" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("CONFLICT");
    expect(res.content[0].text).toContain("notes/x.md");
  });

  it("create_repo refuses when a repo is already connected", async () => {
    const s = setup("gr-create-exists");
    const res = await callTool(tools(s), "create_repo", { group: "Team", name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already has a shared knowledge repository");
  });

  it("create_repo surfaces a creator failure and leaves the group unconnected", async () => {
    const s = setup("gr-create-fail", { connectRepo: false });
    const create = vi.fn(async () => ({ ok: false as const, exitCode: 1, message: "name already exists" }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
      org: "acme",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Failed to create GitHub repository");
    expect(create).toHaveBeenCalled();
    expect(s.store.listUserGroups(s.ownerId)[0].knowledgeRepoConfigured).toBe(false);
  });

  it("create_repo connects a new repo and seeds its vault", async () => {
    const s = setup("gr-create-ok", { connectRepo: false });
    // The creator returns a local bare remote, so the post-create clone/seed/push runs offline.
    const remote = seedRemote(path.join(s.base, "created"), { "README.md": "seed" });
    const create = vi.fn(async () => ({ ok: true as const, fullName: remote, defaultBranch: "main", isPrivate: true }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("second-brain vault");
    expect(s.store.listUserGroups(s.ownerId)[0].knowledgeRepoConfigured).toBe(true);
  });

  it("create_repo connects but reports a skipped seed when the clone fails", async () => {
    const s = setup("gr-create-seedfail", { connectRepo: false });
    // A bogus fullName: it connects (store row written) but the seed clone throws.
    const create = vi.fn(async () => ({ ok: true as const, fullName: path.join(tempDir, "ghost.git"), defaultBranch: "main", isPrivate: true }));
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Created and connected");
    expect(res.content[0].text).toContain("Skipped initializing the default template");
  });

  it("create_repo reports the outer-catch message when the creator throws", async () => {
    const s = setup("gr-create-throw", { connectRepo: false });
    const create = vi.fn(async () => {
      throw new Error("network exploded");
    });
    const res = await callTool(tools(s, { createRemoteRepo: { createRemoteRepo: create } }), "create_repo", {
      group: "Team",
      name: "team-knowledge",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error while creating GitHub repository");
  });

  it("buildGroupRepoServer exposes the named MCP server", () => {
    const s = setup("gr-server");
    expect(buildGroupRepoServer(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config })).toBeTruthy();
    expect(GROUP_REPO_SERVER_NAME).toBe("group_repo");
  });
});

// ---------------------------------------------------------------------------
// sshTrustTools — add_host success/failure, remove_host miss, server builder
// ---------------------------------------------------------------------------

describe("ssh trust tools — add/remove branches", () => {
  function setup(dir: string) {
    const { store, config } = createServices({ dataDir: path.join(tempDir, dir), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { config, ownerId: owner.id };
  }

  it("add_host reports a freshly-registered host, and an already-known one", async () => {
    const { config, ownerId } = setup("ssh-add");
    const entry = { host: "10.0.0.5", keyType: "ssh-ed25519", fingerprint: "SHA256:abc" };

    (addTrustedHost as unknown as Mock).mockResolvedValueOnce({ entry, changed: true });
    const added = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "10.0.0.5" });
    expect(added.isError).toBeFalsy();
    expect(added.content[0].text).toContain("Registered the host key");
    expect(added.content[0].text).toContain("SHA256:abc");

    (addTrustedHost as unknown as Mock).mockResolvedValueOnce({ entry, changed: false });
    const again = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "10.0.0.5", port: 22 });
    expect(again.content[0].text).toContain("already registered");
  });

  it("add_host maps a host-key fetch failure to an actionable network hint", async () => {
    const { config, ownerId } = setup("ssh-add-fail");
    (addTrustedHost as unknown as Mock).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const res = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "add_host", { host: "192.0.2.1", port: 2222 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Could not fetch the host key");
    expect(res.content[0].text).toContain("192.0.2.1:2222");
    expect(res.content[0].text).toContain("reachable from the network");
  });

  it("remove_host reports when the host is not in the trust list", async () => {
    const { config, ownerId } = setup("ssh-remove-miss");
    const res = await callTool(buildSshTrustTools({ avatarUserId: ownerId, config }), "remove_host", { host: "203.0.113.9" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("is not in the trust list");
  });

  it("buildSshTrustServer exposes the named MCP server", () => {
    const { config, ownerId } = setup("ssh-server");
    expect(buildSshTrustServer({ avatarUserId: ownerId, config })).toBeTruthy();
    expect(SSH_TRUST_SERVER_NAME).toBe("ssh_trust");
  });
});

// ---------------------------------------------------------------------------
// mcpTools — the shared result/error helpers, unit-tested directly
// ---------------------------------------------------------------------------

describe("mcpTools shared helpers", () => {
  it("text() wraps a message and marks errors", () => {
    const ok = text("done");
    expect(ok).toEqual({ content: [{ type: "text", text: "done" }], isError: false });
    const err = text("nope", true);
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toBe("nope");
  });

  it("decodeRepoFsError maps each filesystem sentinel and falls back otherwise", () => {
    expect(decodeRepoFsError("INVALID_PATH", { fallback: "fb" })).toBe("Invalid path.");
    expect(decodeRepoFsError("FILE_TOO_LARGE", { fallback: "fb", tooLarge: "too big" })).toBe("too big");
    expect(decodeRepoFsError("NOT_A_FILE", { fallback: "fb", notAFile: "not a file" })).toBe("not a file");
    expect(decodeRepoFsError("SKILL_EXISTS", { fallback: "fb", skillExists: "dup skill" })).toBe("dup skill");
    // Sentinel present but the caller supplied no override → the fallback path.
    expect(decodeRepoFsError("FILE_TOO_LARGE", { fallback: "fb" })).toBe("fb: FILE_TOO_LARGE");
    // Unknown detail → fallback with the raw detail appended.
    expect(decodeRepoFsError("WAT", { fallback: "generic" })).toBe("generic: WAT");
  });

  it("decodeExecError prefers stderr, exposes the exit code, and redacts a token", () => {
    const withStderr = decodeExecError(Object.assign(new Error("m"), { stderr: "boom on stderr", code: 3 }));
    expect(withStderr.message).toContain("boom on stderr");
    expect(withStderr.exitCode).toBe(3);

    // Buffer stdout used when stderr is absent.
    const fromStdout = decodeExecError(Object.assign(new Error("m"), { stdout: Buffer.from("out detail") }));
    expect(fromStdout.message).toContain("out detail");
    expect(fromStdout.exitCode).toBeUndefined();

    // A bare error with a fallback, and token redaction.
    expect(decodeExecError({}, { fallback: "fell back" }).message).toContain("fell back");
    const redacted = decodeExecError(Object.assign(new Error("used ghp_secret here"), { stderr: "ghp_secret leaked" }), {
      redactToken: "ghp_secret",
    });
    expect(redacted.message).not.toContain("ghp_secret");
    expect(redacted.message).toContain("[REDACTED]");
  });
});
