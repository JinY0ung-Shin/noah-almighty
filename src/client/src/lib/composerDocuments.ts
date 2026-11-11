// Document attachments in the composer: what the user may stage next to the
// images, why a file was refused, and reading the bytes for the send.
//
// Every RULE comes from the shared module (`src/shared/chatDocuments.ts`) — the
// server applies the same ones again and answers with the same Korean sentence,
// so nothing here is a second copy of a limit. An image file is never a
// document: it keeps the image path (`pendingImages`), whatever its name says.
import {
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_DOCUMENT_MEDIA_TYPES,
  CHAT_DOCUMENT_MESSAGES,
  MAX_CHAT_ATTACHMENTS_ENCODED_BYTES,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENTS_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_BYTES,
  base64EncodedLength,
  chatDocumentExtension,
  chatDocumentName,
  chatDocumentNameProblem,
  uniqueChatDocumentNames,
  type ChatDocumentProblem,
} from "../../../shared/chatDocuments";
import { readFileAsDataUrl } from "./dom";
import { newId, notify, readState, updateState } from "./state";
import type { ChatPane, MessageAttachment, PendingDocument } from "./types";

/** The four image types the picker offers (the image path's own list). */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** `accept` of the attach input in a pane that also takes documents: images + every document extension. */
export const IMAGE_AND_DOCUMENT_ACCEPT = `${IMAGE_ACCEPT},${CHAT_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(",")}`;

/** "PDF · DOCX · …" — the document types, as the drop hint lists them. */
export const DOCUMENT_TYPE_LIST = CHAT_DOCUMENT_EXTENSIONS.map((ext) => ext.toUpperCase()).join(" · ");

/** The one test for "this goes down the IMAGE path" (the same one the image intake uses). */
export function isImageFile(file: { type: string }): boolean {
  return file.type.startsWith("image/");
}

/** Images keep their own path; everything else is a document CANDIDATE (validated by `planDocumentIntake`). */
export function splitAttachFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const file of Array.from(files ?? [])) (isImageFile(file) ? images : others).push(file);
  return { images, others };
}

/** Does a drag carry FILES (as opposed to text, a link or one of the app's own drags)? */
export function isFileDrag(event: { dataTransfer?: Pick<DataTransfer, "types"> | null }): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}

export interface DocumentCandidate {
  name: string;
  size: number;
}

export interface DocumentIntakePlan {
  /** Files that may be staged: `index` into the candidates, and the name each is SENT under. */
  accepted: Array<{ index: number; name: string; mediaType: string }>;
  /** Files that may not, with the reason (`name` as the user knows the file). */
  refused: Array<{ name: string; problem: ChatDocumentProblem }>;
}

/**
 * Judge files BEFORE any byte is read: by name and size alone. A refused file
 * never blocks the ones after it. `staged` is what the composer already holds
 * (it counts toward the per-message count, the total size and the taken names).
 * `allowed` is false in a pane that is not on the viewer's own avatar — every
 * document is then refused as NOT_ALLOWED_HERE. `encodedImageBytes` is the
 * base64 size of the images staged beside them: images and documents share ONE
 * request budget (the server's `decodeChatDocuments` takes the same number).
 */
export function planDocumentIntake(
  candidates: DocumentCandidate[],
  staged: DocumentCandidate[],
  allowed: boolean,
  encodedImageBytes = 0,
): DocumentIntakePlan {
  const plan: DocumentIntakePlan = { accepted: [], refused: [] };
  let count = staged.length;
  let total = staged.reduce((sum, doc) => sum + doc.size, 0);
  // Each document is its own base64 text, so the padding is counted per file.
  let encoded = staged.reduce((sum, doc) => sum + base64EncodedLength(doc.size), 0);
  const names = staged.map((doc) => doc.name);
  candidates.forEach((file, index) => {
    const refuse = (problem: ChatDocumentProblem) => plan.refused.push({ name: file.name, problem });
    if (!allowed) return refuse("NOT_ALLOWED_HERE");
    const name = chatDocumentName(file.name);
    if (name === null) return refuse(chatDocumentNameProblem(file.name) ?? "NAME");
    if (!(file.size > 0)) return refuse("EMPTY");
    if (file.size > MAX_CHAT_DOCUMENT_BYTES) return refuse("TOO_LARGE");
    if (count >= MAX_CHAT_DOCUMENTS_PER_MESSAGE) return refuse("TOO_MANY");
    if (total + file.size > MAX_CHAT_DOCUMENTS_TOTAL_BYTES) return refuse("TOTAL_TOO_LARGE");
    if (encodedImageBytes + encoded + base64EncodedLength(file.size) > MAX_CHAT_ATTACHMENTS_ENCODED_BYTES)
      return refuse("TOTAL_TOO_LARGE");
    names.push(name);
    // Earlier names are already unique, so only the new one can change.
    const unique = uniqueChatDocumentNames(names);
    names[names.length - 1] = unique[unique.length - 1];
    count += 1;
    total += file.size;
    encoded += base64EncodedLength(file.size);
    const extension = chatDocumentExtension(name);
    plan.accepted.push({
      index,
      name: names[names.length - 1],
      mediaType: extension ? CHAT_DOCUMENT_MEDIA_TYPES[extension] : "application/octet-stream",
    });
  });
  return plan;
}

const SHOWN_NAME_CHARS = 60;
const SHOWN_NAMES = 3;

function shownName(name: string): string {
  const clean = name.trim();
  if (!clean) return "이름 없는 파일";
  return clean.length > SHOWN_NAME_CHARS ? `${clean.slice(0, SHOWN_NAME_CHARS - 1)}…` : clean;
}

/**
 * One Korean sentence per REASON, naming the files it refused (the toast stack
 * keeps only a few entries, so one toast per file would push the first ones out).
 */
export function documentRefusalMessages(refused: DocumentIntakePlan["refused"]): string[] {
  const byProblem = new Map<ChatDocumentProblem, string[]>();
  for (const item of refused) byProblem.set(item.problem, [...(byProblem.get(item.problem) ?? []), item.name]);
  return [...byProblem].map(([problem, names]) => {
    const listed = names.slice(0, SHOWN_NAMES).map((name) => `'${shownName(name)}'`).join(", ");
    const more = names.length > SHOWN_NAMES ? ` 외 ${names.length - SHOWN_NAMES}개` : "";
    return `${listed}${more}: ${CHAT_DOCUMENT_MESSAGES[problem]}`;
  });
}

/**
 * The file's bytes as the `data:` URL the server takes. The media type is the
 * one the EXTENSION maps to — what the browser reports for a file (`file.type`)
 * differs per OS and is often empty.
 */
export async function readDocumentDataUrl(file: File, mediaType: string): Promise<string> {
  const raw = await readFileAsDataUrl(file);
  const comma = raw.indexOf(",");
  if (!raw.startsWith("data:") || comma < 0 || comma === raw.length - 1) throw new Error("empty read");
  return `data:${mediaType};base64,${raw.slice(comma + 1)}`;
}

function updatePaneDocuments(paneId: string, change: (docs: PendingDocument[]) => PendingDocument[]): void {
  updateState((state) => {
    const target = state.chatPanes.find((p) => p.id === paneId);
    if (target) target.pendingDocuments = change(target.pendingDocuments ?? []);
  });
}

/**
 * Stage `files` as documents of the pane's next message. Refused files are
 * named with their reason (a warn toast is an assertive live region) and the
 * rest are staged AT ONCE as chips in a "reading" state; the bytes follow
 * asynchronously, so a large file never blocks the handler that picked it.
 * Resolves when every read has settled.
 */
export async function stageDocuments(paneId: string, files: File[], allowed: boolean): Promise<void> {
  if (!files.length) return;
  const pane = readState().chatPanes.find((p) => p.id === paneId);
  if (!pane) return;
  // Told at staging, not at send: a document that cannot ride with the images
  // already staged is refused now (images added later are caught by the send).
  const plan = planDocumentIntake(files, pane.pendingDocuments ?? [], allowed, encodedImageBytes(pane.pendingImages ?? []));
  for (const message of documentRefusalMessages(plan.refused)) notify(message, "warn");
  if (!plan.accepted.length) return;
  const reading = plan.accepted.map((item) => ({
    file: files[item.index],
    doc: { id: newId(), name: item.name, size: files[item.index].size, mediaType: item.mediaType, dataUrl: null } as PendingDocument,
  }));
  // No await between the plan and this write: a second intake that starts
  // meanwhile counts these against the limits and the taken names.
  updatePaneDocuments(paneId, (docs) => [...docs, ...reading.map((item) => item.doc)]);
  await Promise.all(
    reading.map(async ({ file, doc }) => {
      try {
        const dataUrl = await readDocumentDataUrl(file, doc.mediaType);
        // A chip removed (or a pane reset) while its file was read is simply gone.
        updatePaneDocuments(paneId, (docs) => docs.map((item) => (item.id === doc.id ? { ...item, dataUrl } : item)));
      } catch {
        updatePaneDocuments(paneId, (docs) => docs.filter((item) => item.id !== doc.id));
        notify(`'${shownName(doc.name)}' 파일을 읽지 못했습니다. 다시 첨부해 주세요.`, "warn");
      }
    }),
  );
}

export function removePendingDocument(paneId: string, id: string): void {
  updatePaneDocuments(paneId, (docs) => docs.filter((doc) => doc.id !== id));
}

/** Is a staged document still being read? A message cannot go out until none is. */
export function documentsReading(pane: Pick<ChatPane, "pendingDocuments">): boolean {
  return (pane.pendingDocuments ?? []).some((doc) => doc.dataUrl === null);
}

/** "PDF", "DOCX" … — the type label of a chip or a card. */
export function documentTypeLabel(name: string | undefined): string {
  return (chatDocumentExtension(name ?? "") ?? "파일").toUpperCase();
}

/** The staged documents as the attachments of the optimistic user bubble (the stored shape). */
export function documentAttachments(docs: PendingDocument[]): MessageAttachment[] {
  return docs.map((doc) => ({
    id: doc.id,
    kind: "file" as const,
    mediaType: doc.mediaType,
    name: doc.name,
    size: doc.size,
    uploaded: true,
  }));
}

/** A document the user attached to their own message — never a file card the avatar published (the server's rule). */
export function isUploadedDocument(att: MessageAttachment): boolean {
  return att.kind === "file" && att.uploaded === true;
}

/**
 * Would this message's images and documents together exceed what one request
 * may carry (base64, the shared budget)? The server refuses the same way; the
 * check here only saves an upload that could not succeed.
 */
export function attachmentsTooLarge(images: Array<{ dataUrl: string }>, docs: Array<{ size: number }>): boolean {
  const documentBytes = docs.reduce((sum, doc) => sum + base64EncodedLength(doc.size), 0);
  return encodedImageBytes(images) + documentBytes > MAX_CHAT_ATTACHMENTS_ENCODED_BYTES;
}

/** Base64 size of staged images: the payload of each data URL (what the server measures after decoding). */
export function encodedImageBytes(images: Array<{ dataUrl: string }>): number {
  return images.reduce((sum, img) => sum + Math.max(0, img.dataUrl.length - (img.dataUrl.indexOf(",") + 1)), 0);
}

export { CHAT_DOCUMENT_MESSAGES };
