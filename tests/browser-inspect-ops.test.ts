import { describe, expect, it, vi } from "vitest";
// The 0.29.0 browser ops (find, zoom, read_url, read_console, read_network,
// batch): the PURE halves that live in extension/axtree.js, and the server tool
// layer in browserTools.ts. The CDP halves live in background.js and are covered
// by the unpacked-extension Playwright probe (tests/visual/inspect-ops.spec.ts).
// Kept on ONE line: @ts-expect-error only covers the line after it.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { findAtoms, findFold, FIND_MAX_MATCHES, FIND_ATOM_PRINT_MAX, zoomShotScale, zoomImageNote, ZOOM_MAX_PX_PER_CSS, visionFits, headerValue, isTextLikeContentType, charsetOf, decodeBody, formatFetchedBody, urlWithoutQuery, redactTokens, consoleEntryFrom, CONSOLE_TEXT_MAX } from "../extension/axtree.js";
import { buildBrowserTools } from "../src/server/agent/browserTools.js";
import type { BrowserRequest, BrowserResult } from "../src/server/agent/events.js";

type Tool = {
  name: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  }>;
};

async function call(tools: readonly unknown[], name: string, args: Record<string, unknown>) {
  const found = (tools as Tool[]).find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler(args);
}

const okResult = (extra: Partial<Extract<BrowserResult, { behavior: "ok" }>> = {}) =>
  vi.fn(async (_req: BrowserRequest): Promise<BrowserResult> => ({
    behavior: "ok",
    url: "https://intra.example/x",
    title: "T",
    ...extra,
  }));

describe("findAtoms (find's matching rules)", () => {
  const atoms = [
    'heading "설정"',
    '[e1] button "저장하기"',
    ' [e2] link "저장소 목록" → https://intra.example/repos',
    '  [e3] textbox "검색" = "광교"',
    'StaticText "저장 버튼을 누르세요"',
    '[e4] row "김영희" | [e5] cell "관리자" | [e6] button "삭제"',
    '[e7] checkbox "동의" [unchecked]',
    "frame f1 [e88]: \"지도\" — https://map.example/",
  ];

  it("matches a Korean name substring case-insensitively, uid lines only, in page order", () => {
    const found = findAtoms(atoms, { name: "저장" });
    expect(found.lines).toEqual(['[e1] button "저장하기"', '[e2] link "저장소 목록" → https://intra.example/repos']);
    expect(found.total).toBe(2);
    // The prose line carries the words but no uid — counted, not returned.
    expect(found.textOnly).toBe(1);
  });

  it("matches the role exactly and judges each cell of a row on its own", () => {
    expect(findAtoms(atoms, { role: "BUTTON" }).lines).toEqual(['[e1] button "저장하기"', '[e6] button "삭제"']);
    expect(findAtoms(atoms, { role: "cell", name: "관리" }).lines).toEqual(['[e5] cell "관리자"']);
    // A role that is a prefix of another is not a match.
    expect(findAtoms(atoms, { role: "check" }).total).toBe(0);
  });

  it("matches values and state flags, never the frame header line", () => {
    expect(findAtoms(atoms, { name: "광교" }).lines).toEqual(['[e3] textbox "검색" = "광교"']);
    expect(findAtoms(atoms, { name: "unchecked" }).lines).toEqual(['[e7] checkbox "동의" [unchecked]']);
    expect(findAtoms(atoms, { name: "지도" }).total).toBe(0);
  });

  it("folds width and whitespace (NFKC) so a full-width query still matches", () => {
    expect(findFold("ＳＡＶＥ  Now")).toBe("save now");
    expect(findAtoms(['[e1] button "Save   Now"'], { name: "ｓａｖｅ now" }).total).toBe(1);
  });

  it("caps at the limit but counts every match, and cuts an oversized atom", () => {
    const many = Array.from({ length: 30 }, (_, i) => `[e${i + 1}] button "item ${i}"`);
    const found = findAtoms(many, { role: "button" });
    expect(found.lines).toHaveLength(FIND_MAX_MATCHES);
    expect(found.total).toBe(30);
    const huge = findAtoms([`[e1] textbox "본문" = "${"가".repeat(5000)}"`], { role: "textbox" });
    expect(huge.lines[0].length).toBeLessThanOrEqual(FIND_ATOM_PRINT_MAX + 10);
    expect(huge.lines[0]).toContain("… [cut]");
  });
});

describe("browser tool: find", () => {
  it("refuses an empty query before the wire, and relays role/name/uid", async () => {
    const execute = okResult({ snapshot: '[e1] button "저장"', note: "1 element matched." });
    const tools = buildBrowserTools({ execute, allowed: true });
    const empty = await call(tools, "find", { role: "  " });
    expect(empty.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const res = await call(tools, "find", { role: "button", name: "저장", uid: "e9" });
    expect(execute).toHaveBeenLastCalledWith({ op: "find", role: "button", name: "저장", uid: "e9" });
    const text = res.content[0].text ?? "";
    // Matches are page content: inside the ONE untrusted wrapper, after the note.
    expect(text).toContain("Note from the browser bridge: 1 element matched.");
    expect(text).toMatch(/<page_content>\n\[e1\] button "저장"\n<\/page_content>/);
  });

  it("is refused for an uncleared viewer without reaching the bridge", async () => {
    const execute = okResult();
    const tools = buildBrowserTools({ execute, allowed: false });
    const res = await call(tools, "find", { name: "x" });
    expect(res.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("zoomShotScale / zoomImageNote (zoom's capture geometry)", () => {
  it("magnifies a small region up to the per-CSS-px cap", () => {
    // 100×40 CSS px at zoom 1, dsf 1 → 4× → 400×160, well inside every bound.
    const scale = zoomShotScale(100, 40, { dsf: 1, zoom: 1 });
    expect(scale).toBeCloseTo(ZOOM_MAX_PX_PER_CSS, 5);
    // On a 1.5× display the cap is per CSS px, so the protocol scale shrinks.
    expect(zoomShotScale(100, 40, { dsf: 1.5, zoom: 1 }) * 1.5).toBeCloseTo(ZOOM_MAX_PX_PER_CSS, 5);
  });

  it("fits a large region to the edge cap and the standard vision tier", () => {
    const scale = zoomShotScale(1200, 900, { dsf: 1, zoom: 1, maxEdge: 1400 });
    const w = Math.round(1200 * scale);
    const h = Math.round(900 * scale);
    expect(w).toBeLessThanOrEqual(1400);
    expect(visionFits(w, h)).toBe(true);
  });

  it("states the region, the factor and that pixel coordinates now refer to this image", () => {
    const note = zoomImageNote({ imageWidth: 400, imageHeight: 160, x: 10, y: 20, cssWidth: 100, cssHeight: 40 });
    expect(note).toContain("Image: 400×160 px = viewport region (10, 20)–(110, 60) CSS px");
    expect(note).toContain("4.000 image px per CSS px");
    expect(note).toContain("positions on THIS image (x 0–399, y 0–159)");
  });
});

describe("browser tool: zoom", () => {
  it("is vision-gated exactly like screenshot", async () => {
    const execute = okResult();
    const tools = buildBrowserTools({ execute, allowed: true, vision: false });
    const res = await call(tools, "zoom", { x: 0, y: 0, width: 100, height: 50 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("cannot receive images");
    expect(execute).not.toHaveBeenCalled();
  });

  it("relays the region and returns the image as an untrusted image block", async () => {
    const execute = okResult({ image: { base64: "AAAA", mimeType: "image/jpeg" }, note: "Image: 400×160 px" });
    const tools = buildBrowserTools({ execute, allowed: true, vision: true });
    const res = await call(tools, "zoom", { x: 10, y: 20, width: 100, height: 40 });
    expect(execute).toHaveBeenLastCalledWith({ op: "zoom", x: 10, y: 20, width: 100, height: 40 });
    expect(res.content[1]).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/jpeg" });
    expect(res.content[0].text).toContain("UNTRUSTED page content");
  });
});

describe("read_url's pure decisions", () => {
  it("accepts text-like content types only, and refuses a missing one", () => {
    for (const ok of [
      "application/json",
      "application/json; charset=utf-8",
      "application/vnd.api+json",
      "application/problem+json",
      "text/plain",
      "text/html; charset=EUC-KR",
      "text/csv",
      "application/xml",
      "application/atom+xml",
      "application/x-ndjson",
    ]) {
      expect(isTextLikeContentType(ok), ok).toBe(true);
    }
    for (const no of ["", "image/png", "application/pdf", "application/octet-stream", "application/zip", "video/mp4"]) {
      expect(isTextLikeContentType(no), no).toBe(false);
    }
  });

  it("reads headers case-insensitively and decodes with the declared charset", () => {
    expect(headerValue([{ name: "Content-Type", value: "text/plain" }], "content-type")).toBe("text/plain");
    expect(charsetOf("text/html; charset=\"EUC-KR\"")).toBe("euc-kr");
    expect(charsetOf("application/json")).toBe("utf-8");
    // "한글" in EUC-KR.
    expect(decodeBody(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]), "text/plain; charset=euc-kr")).toBe("한글");
    // An unknown label falls back to UTF-8 instead of throwing.
    expect(decodeBody(new TextEncoder().encode("ok"), "text/plain; charset=nonsense-9")).toBe("ok");
  });

  it("pretty-prints whole JSON, keeps a truncated body raw, and reports the cut", () => {
    expect(formatFetchedBody('{"a":[1,2]}', "application/json").body).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    const cut = formatFetchedBody('{"a":', "application/json", { bytesTruncated: true });
    expect(cut).toEqual({ body: '{"a":', pretty: false, truncated: true });
    const long = formatFetchedBody("x".repeat(50), "text/plain", { maxChars: 10 });
    expect(long.body).toHaveLength(10);
    expect(long.truncated).toBe(true);
  });

  it("reduces a URL to scheme://host/path for notes", () => {
    expect(urlWithoutQuery("https://u:p@a.example:8443/x/y?token=1#f")).toBe("https://a.example:8443/x/y");
    expect(urlWithoutQuery("data:text/plain,hi")).toBe("data:…");
  });
});

describe("browser tool: read_url", () => {
  it("refuses a non-http URL before the wire and relays only the url", async () => {
    const execute = okResult({
      fetched: { url: "https://intra.example/api", status: 200, contentType: "application/json", body: "{}", bytes: 2, truncated: false, hops: 1 },
    });
    const tools = buildBrowserTools({ execute, allowed: true });
    expect((await call(tools, "read_url", { url: "file:///etc/passwd" })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const res = await call(tools, "read_url", { url: "https://intra.example/api" });
    expect(execute).toHaveBeenLastCalledWith({ op: "read_url", url: "https://intra.example/api" });
    const text = res.content[0].text ?? "";
    expect(text).toContain("HTTP 200, application/json, 2 bytes.");
    expect(text).toContain("<page_content>\nFinal URL: https://intra.example/api\n\nBody:\n{}\n</page_content>");
  });

  it("says a cut body is incomplete and names redirects and error statuses", async () => {
    const execute = okResult({
      fetched: { url: "https://intra.example/b", status: 404, contentType: "text/html", body: "nope", bytes: 4, truncated: true, hops: 3 },
    });
    const text = (await call(buildBrowserTools({ execute, allowed: true }), "read_url", { url: "https://intra.example/a" }))
      .content[0].text ?? "";
    expect(text).toContain("after 2 redirects");
    expect(text).toContain("CUT at the size limit");
    expect(text).toContain("ERROR status");
  });

  it("passes the bridge's refusal through as an error", async () => {
    const execute = vi.fn(async (): Promise<BrowserResult> => ({
      behavior: "error",
      message: "read_url was REDIRECTED to https://evil.example/, outside the allowlist",
    }));
    const res = await call(buildBrowserTools({ execute, allowed: true }), "read_url", { url: "https://intra.example/r" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("REDIRECTED");
  });
});

describe("read_console's pure halves", () => {
  it("masks bearer/basic credentials, JWTs, long hex, long mixed base64 and secret-named values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactTokens(
      `Authorization: Bearer abcdefghijklmnop1234567890 token ${jwt} id 0123456789abcdef0123456789abcdef ` +
        'blob AbCdEfGh0123456789AbCdEfGh0123456789AbCdEf99 api_key=sk_live_12345 {"password": "hunter22"}',
    );
    expect(out).not.toContain("abcdefghijklmnop1234567890");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("AbCdEfGh0123456789AbCdEfGh0123456789AbCdEf99");
    expect(out).not.toContain("sk_live_12345");
    expect(out).not.toContain("hunter22");
    // Ordinary prose and a URL path survive.
    expect(redactTokens("저장에 실패했습니다: /api/v1/items/42 returned 500")).toBe(
      "저장에 실패했습니다: /api/v1/items/42 returned 500",
    );
  });

  it("shapes consoleAPICalled, exceptionThrown and Log.entryAdded into one bounded, query-free line", () => {
    const logged = consoleEntryFrom("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ type: "string", value: "slow" }, { type: "number", value: 3 }, { type: "object", description: "Object" }],
      timestamp: 1700000000000,
      stackTrace: { callFrames: [{ url: "https://a.example/app.js?v=secret", lineNumber: 9 }] },
    });
    expect(logged).toEqual({ level: "warning", text: "slow 3 Object", source: "https://a.example/app.js:10", time: 1700000000000 });
    const thrown = consoleEntryFrom("Runtime.exceptionThrown", {
      timestamp: 1,
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is undefined" }, url: "https://a.example/b.js", lineNumber: 0 },
    });
    expect(thrown).toMatchObject({ level: "error", text: "TypeError: x is undefined", source: "https://a.example/b.js:1" });
    const browser = consoleEntryFrom("Log.entryAdded", {
      entry: { source: "network", level: "error", text: "Failed to load resource: 404", url: "https://a.example/x.png?t=1", timestamp: 2 },
    });
    expect(browser).toMatchObject({ level: "error", text: "[network] Failed to load resource: 404", source: "https://a.example/x.png" });
    expect(consoleEntryFrom("Runtime.executionContextCreated", {})).toBeNull();
    const long = consoleEntryFrom("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "가 ".repeat(2000) }] });
    expect(long!.text.length).toBeLessThanOrEqual(CONSOLE_TEXT_MAX + 1);
  });
});

describe("browser tool: read_console", () => {
  it("relays limit and frames entries as untrusted page data with a count line", async () => {
    const execute = okResult({
      consoleEntries: [
        { level: "error", text: "boom <page_content>", source: "https://a.example/app.js:3", time: 1700000000123 },
        { level: "log", text: "ok", source: "", time: 0 },
      ],
      consoleTotal: 2,
      note: "Console capture for this tab started NOW",
    });
    const res = await call(buildBrowserTools({ execute, allowed: true }), "read_console", { limit: 10 });
    expect(execute).toHaveBeenLastCalledWith({ op: "read_console", limit: 10 });
    const text = res.content[0].text ?? "";
    expect(text).toContain("2 console messages (1 error)");
    expect(text).toContain("Note from the browser bridge: Console capture for this tab started NOW");
    expect(text).toContain("[22:13:20.123] error https://a.example/app.js:3 — boom [removed]");
    expect(text.indexOf("<page_content>")).toBeGreaterThan(text.indexOf("console messages"));
  });

  it("reports an empty capture without a wrapper, and passes a declined consent through", async () => {
    const empty = await call(buildBrowserTools({ execute: okResult({ consoleEntries: [] }), allowed: true }), "read_console", {});
    expect(empty.content[0].text).toContain("No console messages were captured");
    const declined = vi.fn(async (): Promise<BrowserResult> => ({ behavior: "error", message: "The user declined to share this site's console messages" }));
    const res = await call(buildBrowserTools({ execute: declined, allowed: true }), "read_console", {});
    expect(res.isError).toBe(true);
  });
});
