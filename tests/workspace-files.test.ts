// The 파일 tab's shared contract (`src/shared/workspaceFiles.ts`): the path
// grammar the server trusts, what a file's name and bytes say about previewing
// it, and the CSV reader.
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES,
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  WORKSPACE_PATH_MAX_DEPTH,
  WORKSPACE_PATH_MAX_LENGTH,
  WORKSPACE_TEXT_PREVIEW_MAX_BYTES,
  decodeWorkspaceText,
  joinWorkspacePath,
  parseDelimitedText,
  parseWorkspacePath,
  workspaceDisplayName,
  workspaceDocumentExtension,
  workspaceExtension,
  workspaceImageMediaType,
  workspacePreviewKind,
} from "../src/shared/workspaceFiles.js";

describe("parseWorkspacePath", () => {
  it("takes the root and plain relative paths", () => {
    expect(parseWorkspacePath(undefined)).toEqual([]);
    expect(parseWorkspacePath("")).toEqual([]);
    expect(parseWorkspacePath("c")).toEqual(["c"]);
    expect(parseWorkspacePath("c/abc/보고서 최종.md")).toEqual(["c", "abc", "보고서 최종.md"]);
    expect(parseWorkspacePath(".noah/skills")).toEqual([".noah", "skills"]);
    expect(parseWorkspacePath("a/...")).toEqual(["a", "..."]);
  });

  it("refuses anything that is not plain segments", () => {
    for (const bad of ["..", "a/..", "../a", ".", "a/./b", "/a", "a/", "a//b", "a\\b", "a\0b", 3, ["a"], {}]) {
      expect(parseWorkspacePath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseWorkspacePath("a".repeat(WORKSPACE_PATH_MAX_LENGTH + 1))).toBeNull();
    expect(parseWorkspacePath(Array(WORKSPACE_PATH_MAX_DEPTH + 1).fill("a").join("/"))).toBeNull();
    expect(parseWorkspacePath(Array(WORKSPACE_PATH_MAX_DEPTH).fill("a").join("/"))).toHaveLength(WORKSPACE_PATH_MAX_DEPTH);
  });

  it("joins a child below a folder", () => {
    expect(joinWorkspacePath("", "c")).toBe("c");
    expect(joinWorkspacePath("c/x", "a.txt")).toBe("c/x/a.txt");
  });
});

describe("what a file's name says", () => {
  it("reads the extension, never from a dotfile's leading dot", () => {
    expect(workspaceExtension("Report.FINAL.MD")).toBe("md");
    expect(workspaceExtension(".gitignore")).toBe("");
    expect(workspaceExtension("Makefile")).toBe("");
  });

  it("types only the images the tab shows", () => {
    expect(workspaceImageMediaType("a.PNG")).toBe("image/png");
    expect(workspaceImageMediaType("a.jpeg")).toBe("image/jpeg");
    expect(workspaceImageMediaType("a.svg")).toBe("image/svg+xml");
    expect(workspaceImageMediaType("a.html")).toBeNull();
    expect(workspaceImageMediaType("a.pdf")).toBeNull();
  });

  it("picks the preview kind, or says why there is none", () => {
    expect(workspacePreviewKind("a.png", 10)).toBe("image");
    expect(workspacePreviewKind("a.png", WORKSPACE_IMAGE_PREVIEW_MAX_BYTES + 1)).toBe("TOO_LARGE");
    expect(workspacePreviewKind("README.md", 10)).toBe("markdown");
    expect(workspacePreviewKind("page.HTML", 10)).toBe("html");
    expect(workspacePreviewKind("data.csv", 10)).toBe("csv");
    expect(workspacePreviewKind("data.tsv", 10)).toBe("csv");
    expect(workspacePreviewKind("x.json", 10)).toBe("json");
    expect(workspacePreviewKind("flow.drawio", 10)).toBe("drawio");
    expect(workspacePreviewKind("main.py", 10)).toBe("text");
    expect(workspacePreviewKind("Makefile", 10)).toBe("text");
    expect(workspacePreviewKind("main.py", WORKSPACE_TEXT_PREVIEW_MAX_BYTES + 1)).toBe("TOO_LARGE");
    // Documents the server renders to page images.
    expect(workspacePreviewKind("deck.PPTX", 10)).toBe("document");
    expect(workspacePreviewKind("a.pdf", 10)).toBe("document");
    expect(workspacePreviewKind("a.docx", 10)).toBe("document");
    expect(workspacePreviewKind("a.pdf", WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES + 1)).toBe("TOO_LARGE");
    expect(workspaceDocumentExtension("a.docx")).toBe("docx");
    expect(workspaceDocumentExtension("a.xlsx")).toBeNull();
    // A known binary is never fetched to find out, whatever its size.
    expect(workspacePreviewKind("a.xlsx", 10)).toBe("BINARY");
    expect(workspacePreviewKind("old.ppt", 10)).toBe("BINARY");
    expect(workspacePreviewKind("a.zip", 10)).toBe("BINARY");
  });

  it("shows control characters and direction overrides as a mark", () => {
    expect(workspaceDisplayName("report.txt")).toBe("report.txt");
    expect(workspaceDisplayName("보고서 최종.md")).toBe("보고서 최종.md");
    expect(workspaceDisplayName("a‮gpj.exe")).toBe("a□gpj.exe");
    expect(workspaceDisplayName("a\nb\tc\u0007")).toBe("a□b□c□");
  });
});

describe("decodeWorkspaceText", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  it("reads UTF-8, with or without a BOM", () => {
    expect(decodeWorkspaceText(new TextEncoder().encode("이름,값\n"))).toBe("이름,값\n");
    expect(decodeWorkspaceText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe("a");
    expect(decodeWorkspaceText(bytes())).toBe("");
  });

  it("reads CP949 when the bytes are not UTF-8", () => {
    // "이름,값" as Korean Excel saves it.
    expect(decodeWorkspaceText(bytes(0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb0, 0xaa))).toBe("이름,값");
  });

  it("reads UTF-16 by its BOM", () => {
    expect(decodeWorkspaceText(bytes(0xff, 0xfe, 0x61, 0x00, 0x00, 0xac))).toBe("a가");
    expect(decodeWorkspaceText(bytes(0xfe, 0xff, 0x00, 0x61, 0xac, 0x00))).toBe("a가");
  });

  it("calls bytes with a NUL, or in no known encoding, binary", () => {
    expect(decodeWorkspaceText(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00))).toBeNull();
    expect(decodeWorkspaceText(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff))).toBeNull();
  });
});

describe("parseDelimitedText", () => {
  it("splits rows and cells", () => {
    expect(parseDelimitedText("a,b\n1,2\n", ",")).toEqual({ rows: [["a", "b"], ["1", "2"]], truncated: false });
    expect(parseDelimitedText("a\tb\r\n1\t2", "\t").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimitedText("a,,c\n,\n", ",").rows).toEqual([["a", "", "c"], ["", ""]]);
  });

  it("honours quotes: delimiters, line breaks and doubled quotes inside a cell", () => {
    expect(parseDelimitedText('"a,b","c\nd","e ""f"" g"\nx,y,z', ",").rows).toEqual([
      ["a,b", "c\nd", 'e "f" g'],
      ["x", "y", "z"],
    ]);
    // A quote inside an unquoted cell is text; an unclosed quote runs to the end.
    expect(parseDelimitedText('5" pipe,ok', ",").rows).toEqual([['5" pipe', "ok"]]);
    expect(parseDelimitedText('a,"open\nstill', ",").rows).toEqual([["a", "open\nstill"]]);
  });

  it("skips blank lines and keeps an empty quoted cell", () => {
    expect(parseDelimitedText("a\n\n\nb\n", ",").rows).toEqual([["a"], ["b"]]);
    expect(parseDelimitedText('""\n', ",").rows).toEqual([]);
    expect(parseDelimitedText("", ",")).toEqual({ rows: [], truncated: false });
  });

  it("cuts at the row and column caps and says so", () => {
    const tall = parseDelimitedText("1\n2\n3\n4\n", ",", 2, 5);
    expect(tall).toEqual({ rows: [["1"], ["2"]], truncated: true });
    const wide = parseDelimitedText("a,b,c,d\n", ",", 5, 2);
    expect(wide).toEqual({ rows: [["a", "b"]], truncated: true });
    expect(parseDelimitedText("1\n2\n", ",", 2, 5).truncated).toBe(false);
  });
});
