import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "../types.js";
import { readRegularFileAsync } from "../chatImages.js";
import { asString } from "./agentUtils.js";
import { text } from "./mcpTools.js";

export const CONFLUENCE_SERVER_NAME = "confluence";
export const CONFLUENCE_PAT_SECRET_NAME = "CONFLUENCE_PAT";

export const CONFLUENCE_TOOL_NAMES = [
  "mcp__confluence__describe_config",
  "mcp__confluence__list_spaces",
  "mcp__confluence__search",
  "mcp__confluence__get_page",
  "mcp__confluence__list_attachments",
  "mcp__confluence__get_attachment",
  "mcp__confluence__extract_page_assets",
] as const;

export interface ConfluenceToolsContext {
  /** Deployment config, including the public Confluence base URL. */
  config: AppConfig;
  /**
   * Whether the model THIS run resolved to accepts image input. False →
   * attachment tools return notes instead of MCP image blocks (which would
   * 400 the whole turn on a text-only model). Undefined → supported.
   */
  visionEnabled?: boolean;
  /** Avatar owner's decrypted secret map; values are never returned. */
  ownerSecrets: Record<string, string>;
  /**
   * True for owner/trusted-user interactive chats. Gates BOTH read and write
   * tools: every Confluence call uses the OWNER's PAT, so a non-elevated
   * colleague must not read (or write) the owner's Confluence — mirroring how
   * `mcp__repo__read_file` and the personal second brain gate reads on `elevated`.
   */
  elevated: boolean;
  /**
   * The run's CONVERSATION scratch workspace (absolute — runPlan's
   * `conversationScratchDir`). `get_attachment` with `save_to_workspace` writes
   * the downloaded file under its `confluence/` folder, so a page's image or
   * diagram becomes a file the run can place (a deck's `assets/`, a document, a
   * commit). A LOCAL disk write: the Confluence side stays GET-only. Undefined →
   * the run has no workspace and the option answers with an error.
   */
  workspaceDir?: string;
  /**
   * Whether the conversation this run saves for still exists. Checked AFTER a
   * save lands: deleting a conversation sweeps its `confluence/` copies
   * (`deleteConversationWorkspaceCopies`) but cannot stop a download already in
   * flight, so a copy written after the sweep is removed again and reported as
   * `saveError`. Undefined → no such check (unit tests, runs without a
   * conversation — which have no workspace either).
   */
  isConversationLive?: () => boolean;
}

type JsonRecord = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 20_000;
const DEFAULT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 40_000;
const READ_DENIED =
  "Confluence tools can only be used in avatar owner or trusted user conversations. They read the owner's Confluence using the owner's Personal Access Token, so a non-trusted colleague cannot use them.";
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** `get_attachment` save_to_workspace: the folder inside the conversation scratch workspace. */
const WORKSPACE_SAVE_DIR = "confluence";
/** Appended when a save is refused BEFORE the download, so no inline result exists yet. */
const SAVE_INLINE_REDIRECT = "Call get_attachment again without save_to_workspace to read the attachment inline.";
const WORKSPACE_SAVE_UNAVAILABLE = `Saving attachments to the workspace is not available in this run. ${SAVE_INLINE_REDIRECT}`;
const WORKSPACE_SAVE_NOT_A_FOLDER = `${WORKSPACE_SAVE_DIR}/ in the conversation scratch workspace is not a plain folder (a symlink or a file there is never followed), so the attachment was not saved. Rename or remove it, then retry.`;
const WORKSPACE_SAVE_GONE = "The conversation scratch workspace no longer exists, so the attachment was not saved.";
const WORKSPACE_SAVE_NOT_WRITABLE = `The conversation scratch workspace or its ${WORKSPACE_SAVE_DIR}/ folder is not writable, so the attachment was not saved.`;
/** Cap on a saved file's sanitized title (extension included). */
const MAX_SAVED_NAME_CHARS = 80;
/** Cap on the sanitized attachment id that prefixes a saved file's name. */
const MAX_SAVED_ID_CHARS = 64;
/** `-2` … `-N`: the numbered names a save tries before a timestamped one. */
const MAX_NUMBERED_NAMES = 100;
/** Timestamped random names tried once every numbered name is taken. */
const MAX_FALLBACK_NAMES = 5;
/** Extension for a saved attachment whose title leaves no usable name (else `bin`). */
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/vnd.jgraph.mxfile": "drawio",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const TEXT_ATTACHMENT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/vnd.jgraph.mxfile",
  "image/svg+xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

function asRecord(value: unknown): JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncate(value: string, max = MAX_BODY_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]` : value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeMediaType(value: string | null | undefined): string {
  const mediaType = (value ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === "image/jpg" ? "image/jpeg" : mediaType;
}

function mediaTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".drawio")) return "application/vnd.jgraph.mxfile";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  return "";
}

function isSupportedImageMediaType(mediaType: string): boolean {
  return SUPPORTED_IMAGE_MEDIA_TYPES.has(normalizeMediaType(mediaType));
}

function isTextAttachment(mediaType: string, title: string): boolean {
  const normalized = normalizeMediaType(mediaType) || mediaTypeFromFilename(title);
  return normalized.startsWith("text/") || TEXT_ATTACHMENT_MEDIA_TYPES.has(normalized);
}

function cqlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildCql(args: {
  cql?: string;
  space?: string;
  title?: string;
  text?: string;
  label?: string;
  type?: string;
}): string | null {
  if (args.cql?.trim()) {
    return args.cql.trim();
  }
  const parts: string[] = [];
  if (args.space?.trim()) parts.push(`space = "${cqlQuote(args.space.trim())}"`);
  if (args.title?.trim()) parts.push(`title ~ "${cqlQuote(args.title.trim())}"`);
  if (args.text?.trim()) parts.push(`text ~ "${cqlQuote(args.text.trim())}"`);
  if (args.label?.trim()) parts.push(`label = "${cqlQuote(args.label.trim())}"`);
  parts.push(`type = "${cqlQuote(args.type?.trim() || "page")}"`);
  return parts.length > 1 ? parts.join(" AND ") : null;
}

function isCloud(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes(".atlassian.net");
}

function webBase(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/g, "");
  if (!trimmed) return "";
  if (isCloud(trimmed)) {
    const withoutWiki = trimmed.endsWith("/wiki") ? trimmed.slice(0, -5) : trimmed;
    return `${withoutWiki}/wiki`;
  }
  return trimmed;
}

function resolveConfluenceLink(baseUrl: string, link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    const base = webBase(baseUrl).replace(/\/+$/g, "");
    return trimmed.startsWith("/") ? `${base}${trimmed}` : `${base}/${trimmed}`;
  }
}

function apiBase(rawUrl: string): string {
  return `${webBase(rawUrl)}/rest/api`;
}

function normalizeBaseUrl(rawUrl: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)
    ? rawUrl
    : `https://${rawUrl}`;
  const base = webBase(withScheme);
  try {
    // Validate early so a malformed env var returns a tool error, not an
    // unhandled exception before the fetch try/catch.
    new URL(base);
    return withScheme;
  } catch {
    return null;
  }
}

function webUrl(baseUrl: string, links: JsonRecord): string | null {
  const webui = asString(links.webui);
  return webui ? resolveConfluenceLink(baseUrl, webui) : null;
}

function credentials(ctx: Pick<ConfluenceToolsContext, "config" | "ownerSecrets">):
  | { ok: true; baseUrl: string; apiBase: string; pat: string }
  | { ok: false; message: string } {
  const baseUrl = ctx.config.confluenceUrl?.trim();
  if (!baseUrl) {
    return { ok: false, message: "The CONFLUENCE_URL environment variable is not set." };
  }
  const normalizedUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedUrl) {
    return { ok: false, message: "The CONFLUENCE_URL format is invalid." };
  }
  const pat =
    ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
    ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim();
  if (!pat) {
    return {
      ok: false,
      message: "The CONFLUENCE_PAT secret is not set. Register CONFLUENCE_PAT under Settings > Permissions & Connections > Secrets.",
    };
  }
  return { ok: true, baseUrl: normalizedUrl, apiBase: apiBase(normalizedUrl), pat };
}

/**
 * Whether these tools can authenticate for this owner: CONFLUENCE_URL set and
 * well-formed, plus the owner's PAT — the exact check every request makes.
 * runPlan folds it into `confluenceSaveToWorkspace`, so the metacognition
 * surfaces offer `save_to_workspace` only on a run where a save can land.
 */
export function confluenceCredentialsConfigured(
  config: AppConfig,
  ownerSecrets: Record<string, string>,
): boolean {
  return credentials({ config, ownerSecrets }).ok;
}

/**
 * GET-only by construction. These tools are READ-ONLY: there is no `method` or
 * `body` option, so a future tool cannot reach a mutating Confluence endpoint
 * without a deliberate, visible change here. Keep it that way — the PAT this
 * sends belongs to the avatar's owner and carries their full write access.
 */
async function requestJson(
  ctx: ConfluenceToolsContext,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<{ ok: true; baseUrl: string; data: JsonRecord } | { ok: false; message: string }> {
  const creds = credentials(ctx);
  if (!creds.ok) return creds;

  const url = new URL(`${creds.apiBase}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${creds.pat}`,
    };
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const raw = await res.text();
    let data: JsonRecord = {};
    if (raw) {
      try {
        data = asRecord(JSON.parse(raw));
      } catch {
        data = { raw };
      }
    }
    if (!res.ok) {
      const detail = raw ? `: ${truncate(raw.replace(/\s+/g, " "), 500)}` : "";
      return { ok: false, message: `Confluence HTTP ${res.status}${detail}` };
    }
    return { ok: true, baseUrl: creds.baseUrl, data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Confluence request failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

async function requestBinary(
  ctx: ConfluenceToolsContext,
  url: string,
  maxBytes: number,
): Promise<
  | { ok: true; baseUrl: string; data: Buffer; mediaType: string; bytes: number }
  | { ok: false; message: string }
> {
  const creds = credentials(ctx);
  if (!creds.ok) return creds;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${creds.pat}`,
      },
      signal: controller.signal,
    });
    const contentLength = asNumberish(res.headers.get("content-length"));
    if (contentLength !== null && contentLength > maxBytes) {
      return { ok: false, message: `Confluence attachment is too large (${contentLength} bytes, max ${maxBytes}).` };
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const detail = raw ? `: ${truncate(raw.replace(/\s+/g, " "), 500)}` : "";
      return { ok: false, message: `Confluence HTTP ${res.status}${detail}` };
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) {
      return { ok: false, message: `Confluence attachment is too large (${data.length} bytes, max ${maxBytes}).` };
    }
    return {
      ok: true,
      baseUrl: creds.baseUrl,
      data,
      mediaType: normalizeMediaType(res.headers.get("content-type")),
      bytes: data.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Confluence request failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function formatPageSummary(baseUrl: string, page: JsonRecord): JsonRecord {
  const space = asRecord(page.space);
  const version = asRecord(page.version);
  return {
    id: asString(page.id),
    title: asString(page.title),
    type: asString(page.type),
    spaceKey: asString(space.key),
    version: asNumber(version.number),
    url: webUrl(baseUrl, asRecord(page._links)),
  };
}

function pageBody(page: JsonRecord): string {
  const body = asRecord(page.body);
  const storage = asRecord(body.storage);
  return asString(storage.value);
}

function attachmentDownloadUrl(baseUrl: string, attachment: JsonRecord): string | null {
  const links = asRecord(attachment._links);
  return resolveConfluenceLink(baseUrl, asString(links.download) || asString(attachment.downloadLink));
}

function formatAttachmentSummary(baseUrl: string, attachment: JsonRecord): JsonRecord {
  const links = asRecord(attachment._links);
  const metadata = asRecord(attachment.metadata);
  const extensions = asRecord(attachment.extensions);
  const version = asRecord(attachment.version);
  const title = asString(attachment.title) || asString(attachment.filename);
  const mediaType =
    normalizeMediaType(
      asString(metadata.mediaType) || asString(extensions.mediaType) || asString(attachment.mediaType),
    ) || mediaTypeFromFilename(title);
  return {
    id: asString(attachment.id),
    title,
    type: asString(attachment.type),
    mediaType,
    fileSize:
      asNumberish(extensions.fileSize) ??
      asNumberish(metadata.fileSize) ??
      asNumberish(attachment.fileSize),
    version: asNumberish(version.number),
    comment: asString(metadata.comment) || asString(attachment.comment),
    webUrl: webUrl(baseUrl, links) || resolveConfluenceLink(baseUrl, asString(attachment.webuiLink)),
    downloadUrl: attachmentDownloadUrl(baseUrl, attachment),
  };
}

function attachmentsFrom(data: JsonRecord): JsonRecord[] {
  return Array.isArray(data.results) ? data.results.map(asRecord) : [];
}

function attachmentTitle(summary: JsonRecord): string {
  return asString(summary.title);
}

function matchesAttachmentFilter(summary: JsonRecord, args: { filename?: string; media_type?: string }): boolean {
  const filename = args.filename?.trim();
  const mediaType = normalizeMediaType(args.media_type);
  if (filename && attachmentTitle(summary) !== filename) return false;
  if (mediaType && normalizeMediaType(asString(summary.mediaType)) !== mediaType) return false;
  return true;
}

async function fetchPageAttachments(
  ctx: ConfluenceToolsContext,
  pageId: string,
  args: { limit?: number; start?: number } = {},
): Promise<{ ok: true; baseUrl: string; data: JsonRecord; attachments: JsonRecord[] } | { ok: false; message: string }> {
  const res = await requestJson(ctx, `/content/${encodeURIComponent(pageId)}/child/attachment`, {
    query: {
      expand: "version,metadata,extensions",
      limit: args.limit ?? 25,
      start: args.start ?? 0,
    },
  });
  if (!res.ok) return res;
  return { ok: true, baseUrl: res.baseUrl, data: res.data, attachments: attachmentsFrom(res.data) };
}

async function resolveAttachment(
  ctx: ConfluenceToolsContext,
  args: { page_id?: string; attachment_id?: string; filename?: string },
): Promise<{ ok: true; baseUrl: string; attachment: JsonRecord } | { ok: false; message: string }> {
  const attachmentId = args.attachment_id?.trim();
  const filename = args.filename?.trim();
  const pageId = args.page_id?.trim();

  if (pageId) {
    const listed = await fetchPageAttachments(ctx, pageId, { limit: 100 });
    if (!listed.ok) return listed;
    const found = listed.attachments.find((attachment) => {
      if (attachmentId && asString(attachment.id) === attachmentId) return true;
      return Boolean(filename && (asString(attachment.title) || asString(attachment.filename)) === filename);
    });
    if (found) return { ok: true, baseUrl: listed.baseUrl, attachment: found };
    if (filename) {
      return { ok: false, message: `No Confluence attachment named "${filename}" was found on page ${pageId}.` };
    }
  }

  if (attachmentId) {
    const res = await requestJson(ctx, `/content/${encodeURIComponent(attachmentId)}`, {
      query: { expand: "version,metadata,extensions" },
    });
    if (!res.ok) return res;
    return { ok: true, baseUrl: res.baseUrl, attachment: res.data };
  }

  return { ok: false, message: "Provide attachment_id, or provide page_id with filename." };
}

function effectiveAttachmentMediaType(summary: JsonRecord, binaryMediaType?: string): string {
  const title = attachmentTitle(summary);
  const binary = normalizeMediaType(binaryMediaType);
  if (binary && binary !== "application/octet-stream") return binary;
  return normalizeMediaType(asString(summary.mediaType)) || mediaTypeFromFilename(title) || binary;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).trim();
}

function extractAssetReferences(storageBody: string): {
  attachmentFilenames: string[];
  imageFilenames: string[];
  drawioMacros: JsonRecord[];
} {
  const attachmentFilenames: string[] = [];
  const imageFilenames: string[] = [];

  const attachmentRe = /<ri:attachment\b[^>]*\bri:filename=(["'])(.*?)\1/gi;
  for (const match of storageBody.matchAll(attachmentRe)) {
    attachmentFilenames.push(decodeEntities(match[2] ?? ""));
  }

  const imageRe = /<ac:image\b[\s\S]*?<\/ac:image>|<ac:image\b[^>]*\/>/gi;
  for (const match of storageBody.matchAll(imageRe)) {
    for (const attachment of match[0].matchAll(attachmentRe)) {
      imageFilenames.push(decodeEntities(attachment[2] ?? ""));
    }
  }

  const drawioMacros: JsonRecord[] = [];
  const macroRe =
    /<ac:structured-macro\b(?=[^>]*\bac:name=(["'])drawio\1)[^>]*>[\s\S]*?<\/ac:structured-macro>/gi;
  const paramRe =
    /<ac:parameter\b[^>]*\bac:name=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/ac:parameter>/gi;
  const fileLikeRe = /[^<>"']+\.(?:drawio|png|jpe?g|gif|webp|svg|xml)\b/gi;
  for (const match of storageBody.matchAll(macroRe)) {
    const block = match[0];
    const parameters: JsonRecord = {};
    const candidates: string[] = [];
    for (const param of block.matchAll(paramRe)) {
      const name = decodeEntities(param[2] ?? "").trim();
      const value = stripTags(param[3] ?? "");
      if (!name) continue;
      parameters[name] = value;
      if (/\b(diagram|file|filename|name)\b/i.test(name) && /\.[a-z0-9]+$/i.test(value)) {
        candidates.push(value);
      }
    }
    for (const fileLike of block.matchAll(fileLikeRe)) {
      candidates.push(stripTags(fileLike[0]));
    }
    drawioMacros.push({ parameters, candidateFilenames: unique(candidates) });
  }

  return {
    attachmentFilenames: unique(attachmentFilenames),
    imageFilenames: unique(imageFilenames),
    drawioMacros,
  };
}

function isDrawioAttachment(summary: JsonRecord): boolean {
  const title = attachmentTitle(summary).toLowerCase();
  const mediaType = normalizeMediaType(asString(summary.mediaType));
  return title.endsWith(".drawio") || title.includes("drawio") || mediaType === "application/vnd.jgraph.mxfile";
}

function isImageAttachment(summary: JsonRecord): boolean {
  const mediaType = normalizeMediaType(asString(summary.mediaType)) || mediaTypeFromFilename(attachmentTitle(summary));
  return isSupportedImageMediaType(mediaType);
}

function findByTitle(summaries: JsonRecord[], title: string): JsonRecord | null {
  return summaries.find((summary) => attachmentTitle(summary) === title) ?? null;
}

function assetStem(filename: string): string {
  const name = filename.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  return name
    .replace(/\.(png|jpe?g|gif|webp|svg|xml)$/i, "")
    .replace(/\.drawio$/i, "");
}

function matchesDrawioCandidate(summary: JsonRecord, candidates: string[]): boolean {
  const title = attachmentTitle(summary);
  if (candidates.includes(title)) return true;
  if (!isImageAttachment(summary)) return false;
  const titleStem = assetStem(title);
  return Boolean(titleStem && candidates.some((candidate) => assetStem(candidate) === titleStem));
}

/**
 * Every char outside `[A-Za-z0-9._-]` → `-`, `-` runs collapsed, `-`/`.`
 * trimmed off both ends, at most `maxChars` — re-trimmed after the cut, which
 * can expose a trailing `-` or `.`. No path separator survives the mapping, so
 * the result is always ONE plain path segment (or empty).
 */
function safeNamePart(value: string, maxChars: number): string {
  const trimEnds = (part: string) => part.replace(/^[-.]+|[-.]+$/g, "");
  const mapped = trimEnds(value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-"));
  return trimEnds(mapped.slice(0, maxChars));
}

/**
 * A saved attachment's file name, `<attachmentId>-<safeName>`, split into stem
 * + extension so a collision can insert `-2`, `-3`… before the extension.
 * safeName = the title's stem made safe plus its original extension lowercased,
 * at most 80 chars together. A stem that leaves nothing (a Korean-only title,
 * say) becomes `attachment`, keeping the title's own extension, else one from
 * the media type, else `bin`.
 */
function savedAttachmentName(
  attachmentId: string,
  title: string,
  mediaType: string,
): { stem: string; ext: string } {
  const trimmed = title.trim();
  const extMatch = /\.([A-Za-z0-9]{1,10})$/.exec(trimmed);
  const titleExt = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
  const titleStem = safeNamePart(
    extMatch ? trimmed.slice(0, extMatch.index) : trimmed,
    MAX_SAVED_NAME_CHARS - titleExt.length,
  );
  // Only a title with neither a usable stem nor an extension borrows one.
  const ext =
    (titleStem || titleExt)
      ? titleExt
      : `.${MEDIA_TYPE_EXTENSIONS[normalizeMediaType(mediaType)] ?? "bin"}`;
  const id = safeNamePart(attachmentId, MAX_SAVED_ID_CHARS) || "attachment";
  return { stem: `${id}-${titleStem || "attachment"}`, ext };
}

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
}

/**
 * Create `target` EXCLUSIVELY and write `data` into it. `wx` is O_CREAT|O_EXCL:
 * it never replaces an existing file and never follows a symlink planted at the
 * name. A failed write removes the partial file this call created.
 */
async function writeNewFile(target: string, data: Buffer): Promise<"written" | "exists" | { code: string }> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(target, "wx");
  } catch (error) {
    return errnoCode(error) === "EEXIST" ? "exists" : { code: errnoCode(error) };
  }
  try {
    await handle.writeFile(data);
    await handle.close();
    return "written";
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(target).catch(() => {});
    return { code: errnoCode(error) };
  }
}

/** True when `filePath` is a regular file — never read through a symlink — holding exactly `data`. */
async function holdsSameBytes(filePath: string, data: Buffer): Promise<boolean> {
  // A size mismatch (the usual case for a changed attachment) costs one lstat, not a read.
  const stat = await fs.promises.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size !== data.length) return false;
  const read = await readRegularFileAsync(filePath, data.length);
  if ("buffer" in read) return read.buffer.equals(data);
  // readRegularFileAsync refuses an empty file; an empty download matches one.
  return read.error === "EMPTY" && data.length === 0;
}

/** "20260930-181005": the KST wall clock (UTC+9, no DST) — the stamp browser captures are named with. */
function kstFileStamp(nowMs: number): string {
  const iso = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * The names a save tries, in order: `<stem><ext>`, `-2` … `-100`, then — once
 * every numbered name holds other bytes (a daily routine re-saving a changing
 * attachment into ONE workspace) — `-<KST stamp>-<6 hex>` names. Each is still
 * created O_EXCL, so none can overwrite anything; the space never runs out.
 */
function* candidateNames(name: { stem: string; ext: string }, nowMs: number): Generator<string> {
  yield `${name.stem}${name.ext}`;
  for (let n = 2; n <= MAX_NUMBERED_NAMES; n += 1) yield `${name.stem}-${n}${name.ext}`;
  const stamp = kstFileStamp(nowMs);
  for (let i = 0; i < MAX_FALLBACK_NAMES; i += 1) {
    yield `${name.stem}-${stamp}-${crypto.randomBytes(3).toString("hex")}${name.ext}`;
  }
}

/**
 * Where a save lands, checked without creating anything: the workspace exists
 * (realpath'd — the containment anchor), `confluence/` is absent or a PLAIN
 * folder (lstat: a symlink or a file there is refused, never followed), and the
 * folder — or, before it exists, the workspace that will hold it — is writable.
 * The cheap pre-check the handler runs BEFORE the download, and the first step
 * of {@link saveToWorkspace} after it, when the agent's shell may have raced it.
 */
async function checkSaveFolder(
  workspaceDir: string,
): Promise<{ ok: true; dir: string; exists: boolean } | { ok: false; message: string }> {
  let root: string;
  try {
    root = await fs.promises.realpath(workspaceDir);
    if (!(await fs.promises.stat(root)).isDirectory()) return { ok: false, message: WORKSPACE_SAVE_GONE };
  } catch {
    return { ok: false, message: WORKSPACE_SAVE_GONE };
  }
  const dir = path.join(root, WORKSPACE_SAVE_DIR);
  const dirStat = await fs.promises.lstat(dir).catch(() => null);
  if (dirStat && !dirStat.isDirectory()) return { ok: false, message: WORKSPACE_SAVE_NOT_A_FOLDER };
  try {
    await fs.promises.access(dirStat ? dir : root, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, message: WORKSPACE_SAVE_NOT_WRITABLE };
  }
  return { ok: true, dir, exists: Boolean(dirStat) };
}

/**
 * Save a downloaded attachment as `<workspaceDir>/confluence/<name>`. A LOCAL
 * write — nothing here talks to Confluence. Containment: {@link checkSaveFolder}
 * runs again (the pre-download check can be stale by now); the name is one
 * sanitized segment; and every path handed back is re-resolved, so a folder
 * swapped for a symlink mid-save cannot land bytes outside the workspace. Never
 * overwrites: an existing file with the SAME bytes is reused (a repeat save
 * returns its path), anything else moves on to the next candidate name.
 * `savedPath` is spelled under `workspaceDir` as given — the same prefix the
 * run's cwd and describe_system use.
 */
async function saveToWorkspace(
  workspaceDir: string,
  name: { stem: string; ext: string },
  data: Buffer,
  nowMs: number = Date.now(),
): Promise<{ ok: true; savedPath: string } | { ok: false; message: string }> {
  const folder = await checkSaveFolder(workspaceDir);
  if (!folder.ok) return folder;
  const { dir } = folder;
  if (!folder.exists) {
    try {
      await fs.promises.mkdir(dir);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") return { ok: false, message: WORKSPACE_SAVE_NOT_WRITABLE };
    }
    // lstat: a symlink reads as a symlink here, never as the folder it points at.
    const dirStat = await fs.promises.lstat(dir).catch(() => null);
    if (!dirStat?.isDirectory()) return { ok: false, message: WORKSPACE_SAVE_NOT_A_FOLDER };
  }
  for (const fileName of candidateNames(name, nowMs)) {
    const target = path.join(dir, fileName);
    const outcome = await writeNewFile(target, data);
    if (outcome !== "written" && outcome !== "exists") {
      return {
        ok: false,
        message: `Could not save the attachment to the conversation scratch workspace (${outcome.code}).`,
      };
    }
    if (outcome === "exists" && !(await holdsSameBytes(target, data))) continue;
    // Realpath containment of what is handed back: `dir` hangs off the
    // realpath'd workspace and was a plain folder, so a clean save resolves to
    // EXACTLY `target` — a strictly tighter test than "inside the workspace". Anything
    // else means the folder was swapped mid-save: undo a file this call
    // created (O_EXCL made it ours) and refuse.
    const real = await fs.promises.realpath(target).catch(() => null);
    if (real !== target) {
      if (outcome === "written") await fs.promises.unlink(target).catch(() => {});
      return { ok: false, message: WORKSPACE_SAVE_NOT_A_FOLDER };
    }
    return { ok: true, savedPath: path.join(path.resolve(workspaceDir), WORKSPACE_SAVE_DIR, fileName) };
  }
  // Unreachable in practice: it takes every numbered name AND five fresh
  // random ones colliding.
  return { ok: false, message: `No free file name was found in ${WORKSPACE_SAVE_DIR}/, so the attachment was not saved.` };
}

export function buildConfluenceTools(ctx: ConfluenceToolsContext) {
  return [
    tool(
      "describe_config",
      "Check the configuration status of the shared Confluence tools. Does not return the URL/PAT values themselves.",
      {},
      async () => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const baseUrl = ctx.config.confluenceUrl?.trim();
        const hasPat = Boolean(
          ctx.ownerSecrets[CONFLUENCE_PAT_SECRET_NAME]?.trim() ||
            ctx.ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN?.trim(),
        );
        const lines = [
          "Confluence tool configuration:",
          `- host: ${baseUrl ? "configured" : "not set"}`,
          `- PAT secret: ${hasPat ? "configured" : "not set"}`,
          "- auth: on-prem Personal Access Token (Bearer)",
        ];
        return text(lines.join("\n"));
      },
    ),
    tool(
      "list_spaces",
      "Fetch the list of Confluence spaces.",
      {
        limit: z.number().int().min(1).max(100).optional().describe("Number of results to fetch, default 25"),
        start: z.number().int().min(0).optional().describe("Pagination start offset, default 0"),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const res = await requestJson(ctx, "/space", {
          query: { limit: args.limit ?? 25, start: args.start ?? 0 },
        });
        if (!res.ok) return text(res.message, true);
        const results = Array.isArray(res.data.results) ? res.data.results.map(asRecord) : [];
        if (!results.length) {
          return text("No Confluence spaces found.");
        }
        return text(JSON.stringify(results.map((s) => ({
          key: asString(s.key),
          name: asString(s.name),
          type: asString(s.type),
        })), null, 2));
      },
    ),
    tool(
      "search",
      "Search Confluence pages with CQL. Provide cql directly, or combine space/title/text/label conditions.",
      {
        cql: z.string().optional().describe("Raw CQL. If present, takes precedence over the other search conditions."),
        space: z.string().optional().describe("space key"),
        title: z.string().optional().describe("Fuzzy search on title"),
        text: z.string().optional().describe("Fuzzy search on body"),
        label: z.string().optional().describe("Exact label match"),
        type: z.string().optional().describe("content type, default page"),
        limit: z.number().int().min(1).max(100).optional().describe("Number of results to fetch, default 25"),
        start: z.number().int().min(0).optional().describe("Pagination start offset, default 0"),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const cql = buildCql(args);
        if (!cql) {
          return text("Provide cql or at least one of space/title/text/label.", true);
        }
        const res = await requestJson(ctx, "/content/search", {
          query: {
            cql,
            limit: args.limit ?? 25,
            start: args.start ?? 0,
            expand: "space,version",
          },
        });
        if (!res.ok) return text(res.message, true);
        const results = Array.isArray(res.data.results) ? res.data.results.map(asRecord) : [];
        const summary = {
          cql,
          size: asNumber(res.data.size) ?? results.length,
          results: results.map((page) => formatPageSummary(res.baseUrl, page)),
        };
        return text(JSON.stringify(summary, null, 2));
      },
    ),
    tool(
      "get_page",
      "Fetch a Confluence page by ID. By default returns metadata + storage body.",
      {
        page_id: z.string().describe("Confluence page id"),
        max_body_chars: z.number().int().min(0).max(100_000).optional().describe("Maximum number of body characters, default 20000"),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const res = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          query: { expand: "body.storage,version,space,ancestors,metadata.labels" },
        });
        if (!res.ok) return text(res.message, true);
        const body = pageBody(res.data);
        const max = args.max_body_chars ?? MAX_BODY_CHARS;
        const labels = asRecord(asRecord(res.data.metadata).labels);
        const labelResults = Array.isArray(labels.results) ? labels.results.map(asRecord) : [];
        const ancestors = Array.isArray(res.data.ancestors) ? res.data.ancestors.map(asRecord) : [];
        const payload = {
          ...formatPageSummary(res.baseUrl, res.data),
          labels: labelResults.map((l) => asString(l.name)).filter(Boolean),
          ancestors: ancestors.map((a) => ({ id: asString(a.id), title: asString(a.title) })),
          body_storage: max === 0 ? undefined : truncate(body, max),
        };
        return text(JSON.stringify(payload, null, 2));
      },
    ),
    tool(
      "list_attachments",
      "Fetch metadata for attachments on a Confluence page. Use this before downloading images or draw.io files.",
      {
        page_id: z.string().describe("Confluence page id"),
        filename: z.string().optional().describe("Exact filename to filter locally"),
        media_type: z.string().optional().describe("Exact media type to filter locally, e.g. image/png"),
        limit: z.number().int().min(1).max(100).optional().describe("Number of results to fetch, default 25"),
        start: z.number().int().min(0).optional().describe("Pagination start offset, default 0"),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const res = await fetchPageAttachments(ctx, args.page_id, { limit: args.limit, start: args.start });
        if (!res.ok) return text(res.message, true);
        const attachments = res.attachments
          .map((attachment) => formatAttachmentSummary(res.baseUrl, attachment))
          .filter((summary) => matchesAttachmentFilter(summary, args));
        return text(
          JSON.stringify(
            {
              page_id: args.page_id,
              size: attachments.length,
              attachments,
            },
            null,
            2,
          ),
        );
      },
    ),
    tool(
      "get_attachment",
      "Download a Confluence attachment by attachment id, or by page id + filename. Supported image attachments are returned as MCP image blocks. " +
        "Pass save_to_workspace: true to ALSO save the downloaded file (any type — image, draw.io, PDF, …) into the conversation scratch workspace under confluence/; the result's savedPath is its absolute path. " +
        "Use it whenever the user wants that image or diagram IN something you produce (a deck's assets/, a document, a commit): place the saved file itself instead of describing or redrawing it.",
      {
        page_id: z.string().optional().describe("Confluence page id. Required when using filename."),
        attachment_id: z.string().optional().describe("Confluence attachment content id"),
        filename: z.string().optional().describe("Exact attachment filename on the page"),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_ATTACHMENT_BYTES)
          .optional()
          .describe(`Maximum bytes to download, default ${DEFAULT_ATTACHMENT_BYTES}`),
        max_text_chars: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe(`Maximum text/XML characters to return for non-image text attachments, default ${MAX_ATTACHMENT_TEXT_CHARS}`),
        save_to_workspace: z
          .boolean()
          .optional()
          .describe(
            `Also save the downloaded file, any media type, as ${WORKSPACE_SAVE_DIR}/<attachmentId>-<name> in the conversation scratch workspace and return its absolute savedPath (an existing different file is never overwritten; a save that fails after the download is reported as saveError next to the normal result). Default false.`,
          ),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        // Cheap checks before any request: a run without a workspace, or whose
        // save folder is already unusable, spends no download on a save that
        // cannot land. saveToWorkspace repeats them after the download.
        if (args.save_to_workspace) {
          if (!ctx.workspaceDir) return text(WORKSPACE_SAVE_UNAVAILABLE, true);
          const folder = await checkSaveFolder(ctx.workspaceDir);
          if (!folder.ok) return text(`${folder.message} ${SAVE_INLINE_REDIRECT}`, true);
        }
        const resolved = await resolveAttachment(ctx, args);
        if (!resolved.ok) return text(resolved.message, true);

        const summary = formatAttachmentSummary(resolved.baseUrl, resolved.attachment);
        const downloadUrl = asString(summary.downloadUrl);
        if (!downloadUrl) {
          return text(
            JSON.stringify(
              {
                attachment: summary,
                error: "The attachment metadata did not include a download URL.",
              },
              null,
              2,
            ),
            true,
          );
        }

        const bytes = await requestBinary(ctx, downloadUrl, args.max_bytes ?? DEFAULT_ATTACHMENT_BYTES);
        if (!bytes.ok) return text(bytes.message, true);

        const mediaType = effectiveAttachmentMediaType(summary, bytes.mediaType);
        summary.mediaType = mediaType;
        const payload: JsonRecord = {
          attachment: summary,
          download: {
            bytes: bytes.bytes,
            returnedAs: "metadata",
          },
        };
        // The save rides alongside the inline result below, never instead of
        // it: an image still comes back as an image block on a vision run, and
        // a save that fails now (the folder changed during the download, a disk
        // error) costs only the copy — it is reported as saveError.
        if (args.save_to_workspace && ctx.workspaceDir) {
          const saved = await saveToWorkspace(
            ctx.workspaceDir,
            savedAttachmentName(
              asString(summary.id) || args.attachment_id?.trim() || "",
              attachmentTitle(summary),
              mediaType,
            ),
            bytes.data,
          );
          if (saved.ok && ctx.isConversationLive && !ctx.isConversationLive()) {
            // The conversation was deleted while this save was in flight: its
            // sweep already ran, so this copy would outlive the conversation.
            await fs.promises.unlink(saved.savedPath).catch(() => {});
            payload.saveError =
              "The conversation was deleted while the attachment was being saved, so the saved copy was removed.";
          } else if (saved.ok) payload.savedPath = saved.savedPath;
          else payload.saveError = saved.message;
        }
        const savedNote = payload.savedPath
          ? " The file itself is saved at savedPath, so you can still place or share it as a file."
          : "";
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];

        if (isSupportedImageMediaType(mediaType) && ctx.visionEnabled !== false) {
          payload.download = { bytes: bytes.bytes, returnedAs: "image" };
          content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
          content.push({ type: "image", data: bytes.data.toString("base64"), mimeType: mediaType });
          return { content };
        }
        if (isSupportedImageMediaType(mediaType)) {
          // Text-only backend: an image block would 400 the whole turn.
          payload.note =
            "This is an image attachment, but the active model cannot accept image input, so no image block was returned. Reference the Confluence page/attachment link for the user instead." +
            savedNote;
          content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
          return { content };
        }

        if (isTextAttachment(mediaType, attachmentTitle(summary))) {
          const decoded = bytes.data.toString("utf8");
          payload.download = { bytes: bytes.bytes, returnedAs: "text" };
          payload.text = args.max_text_chars === 0 ? undefined : truncate(decoded, args.max_text_chars ?? MAX_ATTACHMENT_TEXT_CHARS);
        } else {
          payload.note =
            "Attachment bytes were downloaded but not returned inline because this media type is not an inline image or text/XML attachment." +
            savedNote;
        }
        return text(JSON.stringify(payload, null, 2));
      },
    ),
    tool(
      "extract_page_assets",
      "Inspect a Confluence page storage body for image and draw.io references, then match those references with page attachments.",
      {
        page_id: z.string().describe("Confluence page id"),
        include_images: z.boolean().optional().describe("Download matched raster image attachments as MCP image blocks, default false"),
        max_images: z.number().int().min(1).max(5).optional().describe("Maximum image blocks to return, default 3"),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_ATTACHMENT_BYTES)
          .optional()
          .describe(`Maximum bytes per downloaded image, default ${DEFAULT_ATTACHMENT_BYTES}`),
      },
      async (args) => {
        if (!ctx.elevated) return text(READ_DENIED, true);
        const page = await requestJson(ctx, `/content/${encodeURIComponent(args.page_id)}`, {
          query: { expand: "body.storage,version,space,ancestors,metadata.labels" },
        });
        if (!page.ok) return text(page.message, true);
        const attachments = await fetchPageAttachments(ctx, args.page_id, { limit: 100 });
        if (!attachments.ok) return text(attachments.message, true);

        const body = pageBody(page.data);
        const references = extractAssetReferences(body);
        const summaries = attachments.attachments.map((attachment) =>
          formatAttachmentSummary(attachments.baseUrl, attachment),
        );
        const referencedImages = references.imageFilenames
          .map((filename) => findByTitle(summaries, filename))
          .filter((summary): summary is JsonRecord => Boolean(summary));
        const referencedAttachments = references.attachmentFilenames
          .map((filename) => findByTitle(summaries, filename))
          .filter((summary): summary is JsonRecord => Boolean(summary));
        const drawioCandidateFilenames = unique(
          references.drawioMacros.flatMap((macro) =>
            Array.isArray(macro.candidateFilenames) ? macro.candidateFilenames.map(asString) : [],
          ),
        );
        const drawioAttachments = summaries.filter((summary) => {
          if (isDrawioAttachment(summary)) return true;
          return matchesDrawioCandidate(summary, drawioCandidateFilenames);
        });
        const availableImages = summaries.filter(isImageAttachment);

        const inlineImages: JsonRecord[] = [];
        const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
        if (args.include_images && ctx.visionEnabled === false) {
          // Text-only backend: never emit image blocks; say so instead of
          // silently returning nothing.
          inlineImages.push({
            error:
              "include_images was requested, but the active model cannot accept image input, so no image blocks were returned.",
          });
        }
        if (args.include_images && ctx.visionEnabled !== false) {
          const candidates = unique(
            [...referencedImages, ...drawioAttachments.filter(isImageAttachment)]
              .map(attachmentTitle)
              .filter(Boolean),
          )
            .map((title) => findByTitle(summaries, title))
            .filter((summary): summary is JsonRecord => Boolean(summary))
            .slice(0, args.max_images ?? 3);
          for (const candidate of candidates) {
            const downloadUrl = asString(candidate.downloadUrl);
            const mediaType = normalizeMediaType(asString(candidate.mediaType)) || mediaTypeFromFilename(attachmentTitle(candidate));
            if (!downloadUrl || !isSupportedImageMediaType(mediaType)) continue;
            const bytes = await requestBinary(ctx, downloadUrl, args.max_bytes ?? DEFAULT_ATTACHMENT_BYTES);
            if (!bytes.ok) {
              inlineImages.push({ attachment: candidate, error: bytes.message });
              continue;
            }
            const effectiveMediaType = effectiveAttachmentMediaType(candidate, bytes.mediaType);
            if (!isSupportedImageMediaType(effectiveMediaType)) {
              inlineImages.push({ attachment: candidate, error: `Unsupported image media type ${effectiveMediaType}` });
              continue;
            }
            inlineImages.push({ attachment: { ...candidate, mediaType: effectiveMediaType }, bytes: bytes.bytes });
            imageBlocks.push({
              type: "image",
              data: bytes.data.toString("base64"),
              mimeType: effectiveMediaType,
            });
          }
        }

        const payload = {
          page: formatPageSummary(page.baseUrl, page.data),
          references,
          matched: {
            referencedImages,
            referencedAttachments,
            drawioAttachments,
          },
          available: {
            imageAttachments: availableImages,
            drawioAttachments: summaries.filter(isDrawioAttachment),
          },
          inlineImages,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }, ...imageBlocks],
        };
      },
    ),
  ];
}

export function buildConfluenceServer(ctx: ConfluenceToolsContext) {
  return createSdkMcpServer({
    name: CONFLUENCE_SERVER_NAME,
    version: "0.1.0",
    tools: buildConfluenceTools(ctx),
  });
}
