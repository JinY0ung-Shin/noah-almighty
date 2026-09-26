import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DRAWIO_MEDIA_TYPE } from "../chatFiles.js";
import type { FileOutputRequest, FileOutputResult, ShareFileRequest } from "./events.js";
import { text } from "./mcpTools.js";

export const FILE_OUTPUT_SERVER_NAME = "file_output";
export const FILE_OUTPUT_TOOL_NAMES = [
  "mcp__file_output__show_file",
  "mcp__file_output__share_file",
] as const;

export interface FileOutputToolsContext {
  showFile: (request: FileOutputRequest) => Promise<FileOutputResult>;
  shareFile: (request: ShareFileRequest) => Promise<FileOutputResult>;
  /**
   * The `pptx` skill's HTML→PPTX converter is installed in this deployment
   * (the deck toolchain probe, passed by runPlan). Switches share_file's PPTX
   * sentence to the converter wording and enables the "no converter renders"
   * result note; absent/false keeps today's LibreOffice-only wording.
   */
  deckConverterInstalled?: boolean;
}

type SharedFile = Extract<FileOutputResult, { behavior: "shown" }>;

/** share_file's description; only the PPTX sentence depends on the converter. */
function shareFileDescription(deckConverterInstalled: boolean): string {
  const pptxSentence = deckConverterInstalled
    ? "For a PPTX built by the `pptx` skill's converter, pass the built file IN PLACE (use `name` for the user-facing filename; never copy, rename or edit it after building) — the card's side panel then shows the converter's exact slide renders; for any other PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders approximate page previews. Either way, do NOT render or publish slide images yourself for delivery. "
    : "For PPTX/DOCX/XLSX/PDF the server AUTOMATICALLY renders page previews into the card's side panel — do NOT render or publish slide images yourself for delivery. ";
  return (
    "Hand a generated document to the user as a DOWNLOAD CARD in the chat. " +
    "Use this whenever you finish producing a file the user should keep — a PPTX deck, PDF, DOCX, XLSX, ZIP, CSV, Markdown/text file, or draw.io diagram (.drawio). " +
    pptxSentence +
    "A shared .drawio file renders as an INTERACTIVE diagram in that same panel (client-side) — never export a diagram to PNG just to deliver it. " +
    "Pass the local file path from your working directory; never paste a local path or file:// URL into Markdown, because the browser cannot reach your filesystem and there is NO Bash workaround for delivering files. " +
    "The file must be inside the run's working directory or scratch workspace, at most 30 MB, and its content must match its extension. A turn can share at most 3 files."
  );
}

/**
 * The model-facing preview notes for a successful share, composed from the
 * host's FACTS (previews / previewSource / previewTotal / deckSidecar) — the
 * route states what happened, this decides what the model is told.
 */
function sharePreviewNotes(result: SharedFile, deckConverterInstalled: boolean): string[] {
  const previews = result.previews ?? 0;
  if (previews > 0 && result.previewSource === "converter") {
    const total = result.previewTotal ?? previews;
    return [
      `${previews} exact slide render(s) from the deck converter were attached to the card's side panel` +
        (total > previews ? ` (the first ${previews} of ${total} slides)` : "") +
        " — do not publish slide images yourself." +
        (result.deckSidecar?.profile === "malgun"
          ? " These renders use a metric-matched stand-in for 맑은 고딕; PowerPoint on Windows shows the real font."
          : ""),
    ];
  }
  // Any other attached previews are the server's LibreOffice rasterization
  // (older hosts report `previews` without a source).
  const libreOffice = previews > 0;
  const notes: string[] = [];
  if (libreOffice) {
    notes.push(
      `${previews} page preview(s) were rendered automatically into the card's side panel — do not publish slide images yourself.`,
    );
  }
  const sidecar = result.deckSidecar;
  if (sidecar?.status === "stale") {
    notes.push(
      "The deck converter's renders next to this file were NOT used: the .pptx changed after the converter built it" +
        (libreOffice ? ", so the panel shows approximate LibreOffice previews instead" : "") +
        ". To change a converted deck, edit its slide HTML and rebuild with the pptx skill's converter; never patch the built .pptx.",
    );
  } else if (sidecar?.status === "invalid") {
    notes.push(
      `The deck converter's renders next to this file were NOT used (${sidecar.detail || "the preview sidecar was rejected"})` +
        (libreOffice ? "; the panel shows approximate LibreOffice previews instead" : "") +
        ". Rebuild with the pptx skill's converter and share the built .pptx in place.",
    );
  } else if (sidecar?.status === "none" && deckConverterInstalled) {
    notes.push(
      "No converter renders were found next to this file" +
        (libreOffice ? "; the panel shows approximate LibreOffice previews" : "") +
        ". If this deck was built by the pptx skill's converter, share the built <stem>.pptx in place (not a copy or a renamed file) — or rebuild it — to get the exact slide renders.",
    );
  }
  if (!notes.length && result.attachment.mediaType === DRAWIO_MEDIA_TYPE) {
    notes.push("The card's side panel renders the diagram interactively — do not publish separate preview images.");
  }
  return notes;
}

// INTENTIONALLY NOT self-gated (like canvasTools): REGISTRATION is the boundary
// — the server is only built when fileOutputActive (request.cwd + events.onFile,
// see claudeAgent.ts), and outputs flow only to the run's own viewer.
export function buildFileOutputTools(ctx: FileOutputToolsContext) {
  const deckConverterInstalled = ctx.deckConverterInstalled === true;
  return [
    tool(
      "show_file",
      "Show a PNG, JPEG, WebP, or GIF file from your current working directory to the user in the chat. " +
        "Use this after you generate or download an image the user should see. Pass the local file path; never put a local path or file:// URL in Markdown because the browser cannot access your filesystem. " +
        "Do NOT call Read to inspect, verify, or prepare an image: show_file validates the image bytes itself, while Read may fail when the active model cannot accept image input. " +
        "If the image is outside the allowed working roots (for example under /tmp), copy it into the current directory with Bash (`cp /tmp/image.png \"$PWD/image.png\"`), then call show_file with `./image.png`. " +
        "The file must be inside the run's working directory or scratch workspace and no larger than 5 MB. A turn can show at most 6 images inline; with `hidden:true` the image is instead published quietly (not rendered in the chat bubble) and the result returns a same-origin URL you can embed in a canvas — use that for slide previews (up to 30 hidden publishes per turn).",
      {
        path: z.string().min(1).max(4096).describe("Image path, relative to the current working directory or absolute inside an allowed working root."),
        caption: z.string().max(300).optional().describe("Optional short description shown below the image."),
        hidden: z
          .boolean()
          .optional()
          .describe("Publish without rendering in the chat bubble; the returned URL can be embedded in a canvas (e.g. `![Slide 1](<url>)`)."),
      },
      async (args) => {
        const result = await ctx.showFile({
          path: args.path,
          caption: args.caption?.trim() || undefined,
          hidden: args.hidden || undefined,
        });
        if (result.behavior === "error") {
          return text(result.message, true);
        }
        if (args.hidden) {
          return text(
            `The image was published without being shown in the chat (attachment id: ${result.attachment.id}). ` +
              `To display it inside a canvas, embed exactly this URL in the canvas markdown: ![](${result.url}) — it only renders same-origin, so never rewrite it.`,
          );
        }
        return text(
          `The image was shown to the user (attachment id: ${result.attachment.id}). Do not repeat it as a local-path Markdown image.`,
        );
      },
    ),
    tool(
      "share_file",
      shareFileDescription(deckConverterInstalled),
      {
        path: z.string().min(1).max(4096).describe("File path, relative to the current working directory or absolute inside an allowed working root."),
        name: z.string().max(200).optional().describe("Download filename shown to the user (defaults to the file's basename). Keep the correct extension."),
      },
      async (args) => {
        const result = await ctx.shareFile({
          path: args.path,
          name: args.name?.trim() || undefined,
        });
        if (result.behavior === "error") {
          return text(result.message, true);
        }
        const previewNote = sharePreviewNotes(result, deckConverterInstalled)
          .map((note) => ` ${note}`)
          .join("");
        return text(
          `The file "${result.attachment.name}" is now available to the user as a download card (attachment id: ${result.attachment.id}).${previewNote} ` +
            "Do not also paste its local path; briefly tell the user the file is ready to download.",
        );
      },
    ),
  ];
}

export function buildFileOutputServer(ctx: FileOutputToolsContext) {
  return createSdkMcpServer({
    name: FILE_OUTPUT_SERVER_NAME,
    version: "1.0.0",
    tools: buildFileOutputTools(ctx),
  });
}
