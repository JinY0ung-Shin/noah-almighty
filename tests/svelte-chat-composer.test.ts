// Two composer behaviours that are easy to break apart: image intake in "file
// mode", and the mid-turn message ("steer") controls that appear while a turn is
// streaming.
//
// Composer image intake when the pane's model has NO vision ("file mode"). The
// server no longer rejects those uploads — it stages them as files in the agent
// workspace and hands the model only the path — so the composer must let them
// through, send the ORIGINAL bytes (a canvas re-encode would corrupt what the
// model opens as a file), and say plainly that the model cannot see the pixels.
// The pins below are the three halves that are easy to lose separately: the
// unresized passthrough, the honest notice, and the type/size gate that keeps
// the payload inside what the server accepts.
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { sendSteer } from "../src/client/src/lib/chat.js";
import { readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";

// Only the steer sender is faked; everything else ChatView imports from the chat
// module (mount-time loaders included) stays real.
vi.mock("../src/client/src/lib/chat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/chat.js")>()),
  sendSteer: vi.fn(async () => {}),
}));

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

const avatar = {
  id: "avatar-1",
  username: "ava",
  displayName: "아바타",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "group",
  isOwn: true,
  elevated: true,
  plugins: [],
} as unknown as AvatarDetail;

function pane(modelTier: string): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
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
    groupKnowledgeOff: [],
    modelTier,
  } as unknown as ChatPane;
}

/** Two tiers so the pane's own pick — not the deployment default — decides vision. */
function seed(modelTier: string): void {
  replaceState({
    avatars: [],
    chatPanes: [pane(modelTier)],
    activePaneId: "pane-1",
    view: "chat",
    bootstrap: {
      visionEnabled: true,
      modelSelection: {
        locked: false,
        defaultVision: true,
        tiers: [
          { id: "seeing", label: "Seeing", description: "", model: "m-1", vision: true },
          { id: "blind", label: "Blind", description: "", model: "m-2", vision: false },
        ],
      },
    },
  } as unknown as Parameters<typeof replaceState>[0]);
}

function pickFiles(container: HTMLElement, files: File[]): Promise<boolean> {
  const input = container.querySelector<HTMLInputElement>(".composer-attach input[type='file']");
  expect(input).toBeTruthy();
  return fireEvent.change(input!, { target: { files } });
}

function attachLabel(container: HTMLElement): HTMLLabelElement {
  const label = container.querySelector<HTMLLabelElement>("label.composer-attach");
  expect(label).toBeTruthy();
  return label!;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
  toasts.set([]);
  vi.mocked(sendSteer).mockClear();
});

describe("composer image attach in file mode", () => {
  it("stages the original bytes and says the model only gets the file", async () => {
    seed("blind");
    const { container } = render(ChatView);

    // The control stays reachable on a vision-off model, and carries WHY.
    expect(attachLabel(container).title).toBe("이미지 첨부 (모델이 내용을 보지 못하고 파일로 전달됨)");

    await pickFiles(container, [new File([PNG_BYTES], "shot.png", { type: "image/png" })]);

    const staged = await waitFor(() => {
      const images = readState().chatPanes[0].pendingImages;
      expect(images?.length).toBe(1);
      return images![0];
    });
    // Byte-identical to the file the user picked: no canvas downscale in file mode.
    // btoa (not Buffer): this file is checked by svelte-check under the CLIENT
    // tsconfig, which has no node types.
    expect(staged.dataUrl).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`);
    expect(staged.mediaType).toBe("image/png");
    expect(staged.name).toBe("shot.png");
    expect(get(toasts).some((t) => t.kind === "info" && t.message.includes("이미지 내용을 보지 못합니다"))).toBe(true);
  });

  it("drops a type the server cannot sniff and a file over the size cap", async () => {
    seed("blind");
    const { container } = render(ChatView);

    const oversized = new File([PNG_BYTES], "big.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 5 * 1024 * 1024 + 1 });
    await pickFiles(container, [new File([PNG_BYTES], "scan.bmp", { type: "image/bmp" }), oversized]);

    await waitFor(() => {
      expect(get(toasts).some((t) => t.message.includes("PNG/JPEG/WebP/GIF만"))).toBe(true);
      expect(get(toasts).some((t) => t.message.includes("'big.png'은(는) 5 MB를 넘어"))).toBe(true);
    });
    expect(readState().chatPanes[0].pendingImages ?? []).toHaveLength(0);
  });

  it("keeps the plain label on a model that can actually see the image", () => {
    seed("seeing");
    const { container } = render(ChatView);
    expect(attachLabel(container).title).toBe("이미지 첨부");
  });
});

/* ------------------------------------------------------------------ */
/* mid-turn messages ("steers")                                        */
/* ------------------------------------------------------------------ */

/** A pane mid-answer with something typed — the only state that offers a steer. */
function seedStreaming(overrides: Partial<ChatPane> = {}): void {
  const target = { ...pane("seeing"), streaming: true, liveRunId: "run-1", draft: "중간에 한마디", ...overrides } as ChatPane;
  replaceState({
    avatars: [],
    chatPanes: [target],
    activePaneId: target.id,
    view: "chat",
    bootstrap: { visionEnabled: true },
  } as unknown as Parameters<typeof replaceState>[0]);
}

const externalAvatar = { ...avatar, id: "avatar-ext", runtime: "external" } as unknown as AvatarDetail;

function composerTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(".composer-box textarea");
  expect(el).toBeTruthy();
  return el!;
}

describe("composer mid-turn messages", () => {
  it("offers the steer button on a streaming local pane, and Enter sends through it", async () => {
    seedStreaming();
    const { container } = render(ChatView);

    const steerButton = container.querySelector<HTMLButtonElement>(".send-button.steer-send");
    expect(steerButton).toBeTruthy();
    expect(steerButton!.getAttribute("aria-label")).toBe("응답 중 메시지 보내기");
    expect(steerButton!.disabled).toBe(false);
    expect(steerButton!.title).toBe("응답 중 메시지 보내기 (다음 작업 사이에 전달됩니다)");
    // The stop button is untouched — killing the run and messaging it are two acts.
    expect(container.querySelector(".send-button.is-stop")).toBeTruthy();
    // And the extra column is declared, or the button would wrap onto its own row.
    expect(container.querySelector(".composer-box.with-steer")).toBeTruthy();

    await fireEvent.keyDown(composerTextarea(container), { key: "Enter" });
    expect(vi.mocked(sendSteer)).toHaveBeenCalledWith("pane-1", "중간에 한마디");
  });

  it("keeps the steer button mounted on an empty draft, disabled and saying why", () => {
    seedStreaming({ draft: "   " });
    const { container } = render(ChatView);

    const steerButton = container.querySelector<HTMLButtonElement>(".send-button.steer-send");
    expect(steerButton).toBeTruthy();
    expect(steerButton!.disabled).toBe(true);
    // A disabled control with an unstated prerequisite reads as broken.
    expect(steerButton!.title).toBe("메시지를 입력하면 응답 중에도 보낼 수 있어요");
    // The column list is the same one the typed state uses, so the row cannot
    // reflow on the first keystroke.
    expect(container.querySelector(".composer-box.with-steer")).toBeTruthy();
  });

  it("an external pane keeps the old mid-stream composer: no button, Enter breaks the line", async () => {
    seedStreaming({ avatar: externalAvatar });
    const { container } = render(ChatView);

    expect(container.querySelector(".send-button.steer-send")).toBeNull();
    expect(container.querySelector(".composer-box.with-steer")).toBeNull();
    await fireEvent.keyDown(composerTextarea(container), { key: "Enter" });
    expect(vi.mocked(sendSteer)).not.toHaveBeenCalled();
  });

  it("says a message can be sent mid-answer — but only where one actually can", () => {
    seedStreaming();
    const local = render(ChatView);
    expect(composerTextarea(local.container).placeholder).toBe(
      "응답 중에도 메시지를 보낼 수 있어요 · Enter로 보내면 다음 작업 사이에 전달됩니다",
    );
    local.unmount();

    seedStreaming({ avatar: externalAvatar });
    const external = render(ChatView);
    expect(composerTextarea(external.container).placeholder).toBe(
      "응답을 기다리는 중… (다음 메시지를 미리 작성할 수 있어요)",
    );
  });

  it("refuses to steer while an image is staged, and says when it can go", async () => {
    seedStreaming({
      pendingImages: [{ id: "img-1", dataUrl: "data:image/png;base64,AA", name: "shot.png", mediaType: "image/png" }],
    });
    const { container } = render(ChatView);

    await fireEvent.keyDown(composerTextarea(container), { key: "Enter" });
    expect(vi.mocked(sendSteer)).not.toHaveBeenCalled();
    expect(get(toasts).some((t) => t.message.includes("이미지는 응답이 끝난 뒤"))).toBe(true);
  });
});
