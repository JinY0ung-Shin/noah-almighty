// The attach button on a deployment with an upload relay (ChatView +
// lib/uploadRelay): the press opens the relay's page in a popup instead of this
// page's file dialog, what is uploaded there arrives through the composer's
// ordinary intake, a refused file is named with its reason — and without a
// relay the button is the browser's own picker, as before.
//
// Runs in the vitest "react" project.
import { createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { ChatPane } from "../src/client/src/lib/types";
import {
  UPLOAD_RELAY_OPENED,
  UPLOAD_RELAY_POPUP_BLOCKED,
  resetUploadRelayForTests,
  startUploadRelay,
} from "../src/client/src/lib/uploadRelay";
import type { AvatarDetail } from "../src/server/types";
import { UPLOAD_RELAY_MESSAGES } from "../src/shared/uploadRelay";

vi.mock("../src/client/src/lib/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/chat")>()),
  sendSteer: vi.fn(async () => {}),
  addConversationToSplit: vi.fn(async () => {}),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const RELAY_URL = "https://unibridge.test/upload-relay#t=v1.payload.sig";

function avatar(own: boolean): AvatarDetail {
  return {
    id: own ? "me" : "colleague",
    username: own ? "me" : "kim",
    displayName: own ? "나" : "김동료",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    isOwn: own,
    elevated: true,
    plugins: [],
  } as unknown as AvatarDetail;
}

function seed(options: { relay: boolean; own?: boolean }): void {
  const pane = {
    id: "p1",
    avatar: avatar(options.own ?? true),
    conversationId: "conv-p1",
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    canvases: [],
  } as unknown as ChatPane;
  replaceState({
    avatars: [],
    user: { id: "me", roles: [] },
    chatPanes: [pane],
    activePaneId: "p1",
    view: "chat",
    // Vision-off ("file mode"): an image is staged with its original bytes (jsdom has no canvas).
    bootstrap: { uploadRelay: options.relay, modelSelection: { defaultVision: false, models: [] } },
  } as unknown as Parameters<typeof replaceState>[0]);
}

interface RelayedFile {
  id: string;
  name: string;
  bytes: BlobPart;
  /** A refusal the server answers instead of the bytes. */
  refuse?: { status: number; error: string };
  /** Transient failures (502) the fetch answers before it sends the bytes. */
  failFetch?: number;
  /** The body breaks off after the headers this many times. */
  breakBody?: number;
  /** Confirmations to fail (502) before one is taken. */
  failConfirm?: number;
}

/** Our own server's three relay routes, as the page sees them. */
class FakeServer {
  waiting: RelayedFile[] = [];
  ticketBodies: unknown[] = [];
  /** Every fetch that sent bytes (or a refusal), in order. */
  collected: string[] = [];
  /** Files the browser confirmed it has — the hand-over. */
  confirmed: string[] = [];
  /** Sent, awaiting confirmation. */
  sent = new Map<string, RelayedFile>();
  ticketFails = false;

  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value });
    if (path === "/api/chat/upload-relay/tickets") {
      this.ticketBodies.push(body);
      if (this.ticketFails) return json(502, { error: "업로드 중계 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      return json(200, { ticket: "v1.payload.sig", url: RELAY_URL, expiresAt: new Date(Date.now() + 600_000).toISOString(), ttlSeconds: 600 });
    }
    if (path === "/api/chat/upload-relay/poll") {
      expect(body.ticket).toBe("v1.payload.sig");
      return json(200, { files: this.waiting.map((file) => ({ id: file.id, name: file.name, size: 1 })) });
    }
    if (path === "/api/chat/upload-relay/fetch") {
      expect(body.ticket).toBe("v1.payload.sig");
      const index = this.waiting.findIndex((file) => file.id === body.fileId);
      if (index < 0) return json(404, { error: "gone" });
      const file = this.waiting[index];
      if (file.failFetch) {
        file.failFetch -= 1;
        return json(502, { error: "업로드 중계 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
      this.collected.push(file.id);
      if (file.refuse) {
        this.waiting.splice(index, 1);
        return json(file.refuse.status, { error: file.refuse.error });
      }
      if (file.breakBody) {
        file.breakBody -= 1;
        return {
          ok: true,
          status: 200,
          blob: async () => {
            throw new TypeError("network error");
          },
        };
      }
      // Like the real relay: the file stays listed until it is confirmed.
      this.sent.set(file.id, file);
      return { ok: true, status: 200, blob: async () => new Blob([file.bytes]) };
    }
    if (path === "/api/chat/upload-relay/confirm") {
      expect(body.ticket).toBe("v1.payload.sig");
      const file = this.sent.get(String(body.fileId));
      if (!file) return json(404, { error: "gone" });
      if (file.failConfirm) {
        file.failConfirm -= 1;
        return json(502, { error: "업로드 중계 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
      this.sent.delete(file.id);
      this.waiting = this.waiting.filter((entry) => entry.id !== file.id);
      this.confirmed.push(file.id);
      return json(200, { ok: true });
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

function fakePopup() {
  return { closed: false, close: vi.fn(), location: { replace: vi.fn() }, opener: {} as unknown };
}

function attachInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`[data-pane="p1"] .composer-attach input[type='file']`);
  expect(input).toBeTruthy();
  return input!;
}

/** Click the attach control; true when the click was cancelled (no file dialog). */
function press(input: HTMLInputElement): boolean {
  const click = createEvent.click(input);
  fireEvent(input, click);
  return click.defaultPrevented;
}

const toastTexts = () => get(toasts).map((toast) => toast.message);
const stagedDocuments = () => (readState().chatPanes[0].pendingDocuments ?? []).map((doc) => doc.name);
const stagedImages = () => (readState().chatPanes[0].pendingImages ?? []).map((image) => image.name);

let server: FakeServer;

beforeEach(() => {
  toasts.set([]);
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  resetUploadRelayForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attach button with an upload relay", () => {
  it("opens the relay page in a popup instead of the file dialog, and says so on the control", async () => {
    seed({ relay: true });
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { container } = render(<ChatView />);
    const input = attachInput(container);
    expect(input.closest("label")!.title).toContain("업로드 창이 열립니다");

    expect(press(input)).toBe(true);
    // Opened inside the click, before anything is awaited — and never `noopener` (its `closed` is read).
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("about:blank", "noah-upload-relay", expect.not.stringContaining("noopener"));

    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(RELAY_URL));
    // The relay page gets no handle on this page.
    expect(popup.opener).toBeNull();
    // An own-avatar pane asks for a ticket that takes documents.
    expect(server.ticketBodies).toEqual([{ documents: true }]);
    expect(toastTexts()).toContain(UPLOAD_RELAY_OPENED);
  });

  it("stages what is uploaded there through the ordinary intake: a document as a chip, an image as an image", async () => {
    seed({ relay: true });
    vi.spyOn(window, "open").mockReturnValue(fakePopup() as unknown as Window);
    server.waiting.push({ id: "f1", name: "분기 보고.pdf", bytes: "%PDF-1.7 demo" }, { id: "f2", name: "shot.png", bytes: PNG_BYTES });
    const { container } = render(<ChatView />);
    press(attachInput(container));

    await waitFor(() => expect(stagedDocuments()).toEqual(["분기 보고.pdf"]));
    await waitFor(() => expect(stagedImages()).toEqual(["shot.png"]));
    await waitFor(() => expect(container.querySelector(`[data-pane="p1"] .composer-doc-name`)?.textContent).toContain("분기 보고.pdf"));
    // Each file is fetched once and confirmed — the confirmation is the hand-over.
    expect(server.collected).toEqual(["f1", "f2"]);
    expect(server.confirmed).toEqual(["f1", "f2"]);
  });

  it("names a file the server refused, with the server's reason, and stages nothing for it", async () => {
    seed({ relay: true });
    vi.spyOn(window, "open").mockReturnValue(fakePopup() as unknown as Window);
    server.waiting.push({ id: "enc", name: "기밀.pdf", bytes: "x", refuse: { status: 422, error: UPLOAD_RELAY_MESSAGES.BAD_FORMAT } });
    const { container } = render(<ChatView />);
    press(attachInput(container));

    await waitFor(() => expect(toastTexts()).toContain(`'기밀.pdf': ${UPLOAD_RELAY_MESSAGES.BAD_FORMAT}`));
    expect(stagedDocuments()).toEqual([]);
    expect(server.confirmed).toEqual([]);
  });

  it("a colleague's pane asks for an images-only ticket", async () => {
    seed({ relay: true, own: false });
    vi.spyOn(window, "open").mockReturnValue(fakePopup() as unknown as Window);
    const { container } = render(<ChatView />);
    press(attachInput(container));
    await waitFor(() => expect(server.ticketBodies).toEqual([{ documents: false }]));
  });

  it("says so when the popup is blocked, and closes the blank popup when no ticket could be had", async () => {
    seed({ relay: true });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<ChatView />);
    expect(press(attachInput(container))).toBe(true);
    expect(toastTexts()).toContain(UPLOAD_RELAY_POPUP_BLOCKED);
    expect(server.ticketBodies).toEqual([]);

    const popup = fakePopup();
    open.mockReturnValue(popup as unknown as Window);
    server.ticketFails = true;
    press(attachInput(container));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(toastTexts().some((text) => text.includes("업로드 중계 서버"))).toBe(true);
  });
});

describe("upload relay session (lib/uploadRelay)", () => {
  /** A session driven directly, with a short poll interval. */
  function session(popup = fakePopup()) {
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const files: string[] = [];
    const notes: string[] = [];
    const done = startUploadRelay({
      documents: true,
      onFiles: (arrived) => void files.push(...arrived.map((file) => `${file.name}:${file.type}`)),
      notify: (message) => void notes.push(message),
      pollIntervalMs: 10,
    });
    return { popup, files, notes, done };
  }

  it("attaches a file only once its arrival was confirmed, and tries again when a step failed", async () => {
    // One file per way a hand-over can break: the fetch fails, the body breaks off, the confirmation fails.
    server.waiting.push(
      { id: "f1", name: "a.pdf", bytes: "%PDF-1.7 a", failFetch: 1 },
      { id: "f2", name: "b.pdf", bytes: "%PDF-1.7 b", breakBody: 1 },
      { id: "f3", name: "c.png", bytes: PNG_BYTES, failConfirm: 1 },
    );
    const { files, notes } = session();
    await waitFor(() => expect(files).toHaveLength(3));
    // Nothing was handed to the composer before its confirmation went through.
    expect(files.sort()).toEqual(["a.pdf:application/pdf", "b.pdf:application/pdf", "c.png:image/png"]);
    expect(server.confirmed.sort()).toEqual(["f1", "f2", "f3"]);
    // f2 and f3 were fetched twice (the first try did not complete), f1 once after its failed fetch.
    expect(server.collected.filter((id) => id === "f2")).toHaveLength(2);
    expect(server.collected.filter((id) => id === "f3")).toHaveLength(2);
    expect(notes.filter((note) => note.startsWith("'"))).toEqual([]);
  });

  it("gives up on a file after three failed tries, names it, and never attaches it", async () => {
    server.waiting.push({ id: "f1", name: "stuck.pdf", bytes: "%PDF-1.7", failFetch: 99 });
    const { files, notes } = session();
    await waitFor(() => expect(notes.some((note) => note.startsWith("'stuck.pdf': "))).toBe(true));
    expect(99 - (server.waiting[0].failFetch ?? 0)).toBe(3);
    expect(files).toEqual([]);
    expect(server.confirmed).toEqual([]);
    // Given up on: later polls leave it alone.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(99 - (server.waiting[0].failFetch ?? 0)).toBe(3);
    expect(notes.filter((note) => note.startsWith("'stuck.pdf': "))).toHaveLength(1);
  });

  it("a new press lets the earlier session look once more for what its ticket still holds", async () => {
    const first = session();
    await waitFor(() => expect(first.popup.location.replace).toHaveBeenCalled());
    // Uploaded under the first ticket a moment before the second press.
    server.waiting.push({ id: "late", name: "late.pdf", bytes: "%PDF-1.7" });
    const second = session();
    await waitFor(() => expect(first.files.length + second.files.length).toBe(1));
    await first.done;
    expect(server.confirmed).toEqual(["late"]);
  });

  it("keeps looking for a while after the popup is closed, then ends — and never rejects", async () => {
    const { popup, files, done } = session();
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    popup.closed = true;
    // Uploaded just as the window went away: still collected.
    server.waiting.push({ id: "f1", name: "a.pdf", bytes: "%PDF-1.7" });
    await waitFor(() => expect(files).toEqual(["a.pdf:application/pdf"]), { timeout: 8000 });
    resetUploadRelayForTests();
    await expect(done).resolves.toBeUndefined();
  }, 12_000);

  it("stops with a notice when our own server cannot be reached three polls in a row", async () => {
    const { notes, done } = session();
    await waitFor(() => expect(server.ticketBodies).toHaveLength(1));
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await expect(done).resolves.toBeUndefined();
    expect(notes.at(-1)).toContain("서버에 연결할 수 없습니다");
  });
});

describe("attach button without an upload relay", () => {
  it("stays the browser's own file dialog", () => {
    seed({ relay: false });
    const open = vi.spyOn(window, "open");
    const { container } = render(<ChatView />);
    const input = attachInput(container);
    expect(input.closest("label")!.title).not.toContain("업로드 창");
    expect(press(input)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(server.ticketBodies).toEqual([]);
  });
});
