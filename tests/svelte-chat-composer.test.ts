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
import { tick } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { sendSteer } from "../src/client/src/lib/chat.js";
import { readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";
import { EFFORT_LEVELS } from "../src/server/effortLevels.js";

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

function pane(model: string): ChatPane {
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
    model,
  } as unknown as ChatPane;
}

/** Two models so the pane's own pick — not the default model — decides vision. */
function seed(model: string): void {
  replaceState({
    avatars: [],
    chatPanes: [pane(model)],
    activePaneId: "pane-1",
    view: "chat",
    bootstrap: {
      modelSelection: {
        defaultVision: true,
        models: [
          { id: "seeing", server: "vllm-a", vision: true },
          { id: "blind", server: null, vision: false },
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

/**
 * The attach control's NAME. It sits on the (visually hidden, focusable) file
 * input since document attachments: the label's tooltip carries the name plus
 * the hint that a paste or a drop works too. The fixture avatar is the viewer's
 * own, so the control offers images and documents.
 */
function attachName(container: HTMLElement): string {
  const label = container.querySelector<HTMLLabelElement>("label.composer-attach");
  expect(label).toBeTruthy();
  const name = label!.querySelector("input[type='file']")?.getAttribute("aria-label") ?? "";
  expect(label!.title).toBe(`${name} · 붙여넣기(Ctrl+V)나 끌어다 놓기로도 첨부할 수 있어요`);
  return name;
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
    expect(attachName(container)).toBe("이미지·문서 첨부 (모델이 이미지 내용을 보지 못해 이미지도 파일로 전달됨)");

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
    expect(attachName(container)).toBe("이미지·문서 첨부");
  });

  it("treats a pick pi no longer offers as the default model (vision included)", () => {
    seed("opus");
    const { container } = render(ChatView);
    expect(attachName(container)).toBe("이미지·문서 첨부");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="이 대화에 사용할 모델"]')!;
    expect(select.value).toBe("");
  });
});

describe("composer model picker", () => {
  it("offers pi's default model first, then every pi model by id", () => {
    seed("blind");
    const { container } = render(ChatView);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="이 대화에 사용할 모델"]')!;
    expect(select).toBeTruthy();
    expect(select.disabled).toBe(false);
    expect(select.title).toBe("이 대화에서 다음 메시지부터 사용할 모델을 고릅니다");
    expect([...select.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ["", "기본 모델"],
      ["seeing", "seeing"],
      ["blind", "blind"],
    ]);
    expect(select.value).toBe("blind");
    expect(container.textContent).not.toContain("고정되어 있습니다");
  });

  it("names pi's falcon tier wherever no pick is shown: picker, settings summary and toast", async () => {
    seed("");
    const { container } = render(ChatView);
    const summary = () => container.querySelector(".composer-settings-summary")?.textContent ?? "";
    // pi without a falcon tier: the plain label.
    expect(summary()).toMatch(/^기본 모델 · /);
    // The summary follows the bootstrap (a model-list refresh), not only the pane.
    updateState((state) => {
      state.bootstrap!.modelSelection!.defaultModel = "falcon";
    });
    await waitFor(() => expect(summary()).toMatch(/^기본 모델 \(falcon\) · /));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="이 대화에 사용할 모델"]')!;
    expect(select.options[0].textContent?.trim()).toBe("기본 모델 (falcon)");

    await fireEvent.change(select, { target: { value: "seeing" } });
    await waitFor(() => expect(summary()).toMatch(/^seeing · /));
    await fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(summary()).toMatch(/^기본 모델 \(falcon\) · /));
    expect(get(toasts).some((t) => t.message.includes("모델을 기본 모델 (falcon)(으)로 변경했습니다"))).toBe(true);
  });

  it("is hidden when pi offers no models", () => {
    replaceState({
      avatars: [],
      chatPanes: [pane("")],
      activePaneId: "pane-1",
      view: "chat",
      bootstrap: { modelSelection: { defaultVision: true, models: [] } },
    } as unknown as Parameters<typeof replaceState>[0]);
    const { container } = render(ChatView);
    expect(container.querySelector('select[aria-label="이 대화에 사용할 모델"]')).toBeNull();
  });

  it("picking a model writes it through as the remembered default; 기본 모델 clears it", async () => {
    seed("blind");
    const { container } = render(ChatView);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="이 대화에 사용할 모델"]')!;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    await fireEvent.change(select, { target: { value: "seeing" } });
    expect(readState().chatPanes[0].model).toBe("seeing");
    await fireEvent.change(select, { target: { value: "" } });
    expect(readState().chatPanes[0].model).toBeUndefined();
    expect(get(toasts).some((t) => t.message.includes("모델을 기본 모델(으)로 변경했습니다"))).toBe(true);

    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/me/chat-defaults"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([{ model: "seeing" }, { model: null }]);
  });
});

describe("composer effort picker (review #9)", () => {
  function seedEffort(model: string, effort: string): void {
    replaceState({
      avatars: [],
      chatPanes: [{ ...pane(model), effort }],
      activePaneId: "pane-1",
      view: "chat",
      bootstrap: {
        modelSelection: {
          defaultVision: true,
          defaultReasoning: null,
          models: [
            { id: "small", server: null, vision: true, reasoning: { efforts: ["none", "low", "medium", "high"], defaultEffort: "high" } },
            { id: "older", server: null, vision: true },
          ],
        },
        effortSelection: { levels: EFFORT_LEVELS, default: "high" },
      },
    } as unknown as Parameters<typeof replaceState>[0]);
  }
  const effortOptions = (container: HTMLElement) =>
    [...container.querySelector<HTMLSelectElement>('select[aria-label="이 대화에 사용할 사고 강도(effort)"]')!.options].map((o) => [
      o.value,
      o.textContent?.trim(),
      o.disabled,
    ]);

  it("greys out the levels the pane's model does not take and says what runs instead", () => {
    seedEffort("small", "high");
    const { container } = render(ChatView);
    expect(effortOptions(container)).toEqual([
      ["low", "낮음", false],
      ["medium", "보통", false],
      ["high", "높음", false],
      ["xhigh", "매우 높음 (이 모델 미지원 → 높음)", true],
      ["max", "최대 (이 모델 미지원 → 높음)", true],
    ]);
  });

  it("keeps an unsupported CURRENT pick selectable, and greys nothing when pi did not say", async () => {
    seedEffort("small", "max");
    const { container } = render(ChatView);
    expect(effortOptions(container).at(-1)).toEqual(["max", "최대 (이 모델 미지원 → 높음)", false]);
    updateState((state) => {
      state.chatPanes[0]!.model = "older";
    });
    await tick();
    expect(effortOptions(container).every(([, , disabled]) => disabled === false)).toBe(true);
    // 기본 모델 here does not reason: every level but the current one is greyed out.
    updateState((state) => {
      state.chatPanes[0]!.model = undefined;
    });
    await tick();
    expect(effortOptions(container).filter(([, , disabled]) => !disabled).map(([value]) => value)).toEqual(["max"]);
    expect(effortOptions(container)[0]).toEqual(["low", "낮음 (이 모델은 사고 강도를 쓰지 않음)", true]);
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
    bootstrap: {},
  } as unknown as Parameters<typeof replaceState>[0]);
}

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
    expect(steerButton!.title).toBe("응답 중 메시지 보내기 (작업 도중에 전달돼 진행 중인 일을 바꿀 수 있어요)");
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

  it("says a message sent mid-answer arrives after the answer, never between actions", () => {
    seedStreaming();
    const { container } = render(ChatView);
    expect(composerTextarea(container).placeholder).toBe(
      "응답 중에도 메시지를 보낼 수 있어요 · Enter로 보내면 작업 도중에 전달돼 진행 중인 일을 바꿀 수 있어요",
    );
    expect(container.textContent).not.toContain("다음 작업 사이");
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
