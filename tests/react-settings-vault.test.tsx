// 설정 ▸ 지식·플러그인 ▸ 지식 저장소 card: where the brain notes are kept
// (`SettingsVaultStatus`, state in `usePersonalVaultStatus`, read from
// GET /api/me/personal-vault). Pinned: under a connected repository ONE small
// block says the notes are kept in the memory service and are not copied into
// the repository; an outage (no service on this server, no answer, a refusal)
// is said in words — only what the SERVER reported; nothing of the retired
// copy (state, hold, confirmation, 지금 다시 확인, notice) is left; without a
// repository nothing is shown or read; a failed or pending read leaves the
// rest of the tab alone.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsKnowledgeTab from "../src/client/src/components/SettingsKnowledgeTab";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm";
import { readMyPersonalVault } from "../src/client/src/lib/personalVault";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { User } from "../src/client/src/lib/types";

vi.mock("../src/client/src/components/GraphViewModal", () => ({ default: () => null }));

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

const WORKING = { serviceConfigured: true, service: "ok" };
const KEPT = "브레인 노트는 메모리 서비스에 보관되며, 연결한 저장소로는 복사되지 않습니다. 스킬·플러그인 같은 나머지 파일은 지금처럼 저장소에 있습니다.";

let calls: Call[] = [];
/** What GET /api/me/personal-vault answers; a function is called per request. */
let vault: unknown | (() => unknown | Promise<unknown>) = WORKING;

function userOf(over: Partial<User> = {}): User {
  return {
    id: "me",
    username: "me",
    displayName: "나",
    alias: "",
    bio: "",
    intro: "",
    persona: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    roles: [],
    secretNames: [],
    browserSecrets: [],
    knowledgeRepo: "me/brain",
    knowledgeBranch: "",
    knowledgeSelected: null,
    gitTokenSet: true,
    sshPublicKey: "",
    onboardedAt: "2026-08-01T00:00:00.000Z",
    allowedMcpToolGroups: null,
    mcpToolGroupsDefault: null,
    ...over,
  } as unknown as User;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function refused(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

const block = (): HTMLElement | null => document.querySelector<HTMLElement>(".vault-status");
const alertText = (): string | null => block()?.querySelector('[role="alert"]')?.textContent ?? null;
const vaultReads = (): number => calls.filter((call) => call.url === "/api/me/personal-vault").length;
const click = (element: Element): Promise<void> => act(async () => void fireEvent.click(element));

async function open(): Promise<void> {
  render(<SettingsKnowledgeTab active={true} />);
  await waitFor(() => expect(vaultReads()).toBeGreaterThan(0));
  // Let the answer land.
  await act(async () => {});
}

beforeEach(() => {
  calls = [];
  vault = WORKING;
  toasts.set([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method || "GET" };
      if (typeof init?.body === "string") call.body = JSON.parse(init.body);
      calls.push(call);
      if (call.url === "/api/me/personal-vault") {
        const body = typeof vault === "function" ? await (vault as () => unknown)() : vault;
        return body instanceof Object && "ok" in body && "json" in body ? (body as Response) : ok(body);
      }
      if (call.url === "/api/me/knowledge-repo" && call.method === "PUT") {
        const body = call.body as { repo: string | null; branch?: string | null };
        return ok({ user: userOf({ knowledgeRepo: body.repo || "", knowledgeBranch: body.branch || "" }) });
      }
      return ok({});
    }),
  );
  replaceState({ user: userOf(), plugins: [], settingsTab: "knowledge", view: "settings" });
});

afterEach(() => {
  if (get(confirmation)) resolveConfirmation(false);
  toasts.set([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("where the brain notes are kept", () => {
  it("one small block: the memory service keeps them, the repository gets no copy — and nothing of the retired copy is left", async () => {
    await open();

    expect(block()!.getAttribute("role")).toBe("group");
    expect(block()!.textContent).toBe(`브레인 노트 보관상태 새로 고침${KEPT}`);
    expect(alertText()).toBeNull();
    // It sits in the repository card, under the token line and above the plugin picker.
    expect(block()!.previousElementSibling?.className).toContain("git-token-status");
    expect(block()!.nextElementSibling?.className).toContain("kr-plugins");
    // The only control is the re-read.
    expect([...block()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["상태 새로 고침"]);
    for (const gone of ["사본 최신", "올릴 변경", "보류", "지금 다시 확인", "저장소의 노트를 바꾸고", "git으로 직접"]) {
      expect(document.body.textContent).not.toContain(gone);
    }
    // Nothing but the one read was asked of the vault routes.
    expect(calls.filter((call) => call.url.startsWith("/api/me/personal-vault")).map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/me/personal-vault",
    ]);
  });

  it("never names the runtime behind the memory service", async () => {
    for (const answer of [WORKING, { serviceConfigured: false, service: null }, { serviceConfigured: true, service: "unavailable" }]) {
      vault = answer;
      const view = render(<SettingsKnowledgeTab active={true} />);
      await waitFor(() => expect(block()).toBeTruthy());
      expect(block()!.textContent).not.toMatch(/pi-gateway|\bpi\b/i);
      view.unmount();
    }
  });

  it("without a connected repository it shows nothing and asks nothing", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    render(<SettingsKnowledgeTab active={true} />);
    await act(async () => {});

    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
    expect(document.querySelector(".empty-note")).toBeTruthy();
    expect(vaultReads()).toBe(0);
  });

  it("shows nothing for an answer without the route's shape", async () => {
    vault = { nonsense: true };
    await open();
    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
    // The retired shape (a home and a mirror, no word about the service) is not the route's shape either.
    expect(readMyPersonalVault({ home: "memory", mirror: { dirty: false } })).toBeNull();
    expect(readMyPersonalVault(null)).toBeNull();
    expect(readMyPersonalVault({ serviceConfigured: true, service: "something else" })).toEqual({ serviceConfigured: true, service: null });
  });
});

describe("outages", () => {
  it("a server without a memory service says so", async () => {
    vault = { serviceConfigured: false, service: null };
    await open();
    expect(alertText()).toBe(
      "이 서버에 메모리 서비스가 연결되어 있지 않습니다. 브레인 노트를 읽거나 쓸 수 없습니다. 관리자에게 알려 주세요.",
    );
    // Where the notes are kept is still said, under the outage.
    expect(block()!.textContent).toContain(KEPT);
  });

  it("the server's check of the memory service failed just now: 연결할 수 없음", async () => {
    vault = { serviceConfigured: true, service: "unavailable" };
    await open();
    expect(alertText()).toBe(
      "지금 메모리 서비스에 연결하지 못했습니다. 브레인 노트를 읽거나 쓸 수 없지만, 저장된 노트는 그대로 있습니다. 잠시 뒤 ‘상태 새로 고침’으로 다시 확인해 보고, 계속되면 관리자에게 알려 주세요.",
    );
    expect(block()!.textContent).toContain(KEPT);
  });

  it("the service answered but refused these notes: its own outage line", async () => {
    vault = { serviceConfigured: true, service: "refused" };
    await open();
    expect(alertText()).toBe(
      "지금 메모리 서비스가 이 브레인 노트를 열어 주지 않습니다. 브레인 노트를 읽거나 쓸 수 없지만, 저장된 노트는 그대로 있습니다. 잠시 뒤 ‘상태 새로 고침’으로 다시 확인해 보고, 계속되면 관리자에게 알려 주세요.",
    );
  });

  it("상태 새로 고침 reads again, and the outage line goes once the service answers", async () => {
    vault = { serviceConfigured: true, service: "unavailable" };
    await open();
    expect(alertText()).toContain("연결하지 못했습니다");

    vault = WORKING;
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));

    await waitFor(() => expect(alertText()).toBeNull());
    expect(vaultReads()).toBe(2);
    expect(block()!.textContent).toContain(KEPT);
  });
});

describe("when the state is read", () => {
  /** Fake timers: let pending promises settle and move the clock. */
  const flush = (ms = 0): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const field = (label: string): HTMLInputElement => screen.getByText(label).closest("label")!.querySelector("input")!;

  async function mount(): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();
  }

  it("keeps what it knows across a tab switch and reads again when the tab comes back", async () => {
    vault = { serviceConfigured: true, service: "unavailable" };
    const view = render(<SettingsKnowledgeTab active={true} />);
    await waitFor(() => expect(block()).toBeTruthy());

    view.rerender(<SettingsKnowledgeTab active={false} />);
    expect(view.container.innerHTML).toBe("");
    const pending = new Promise<unknown>(() => {});
    vault = () => pending;
    view.rerender(<SettingsKnowledgeTab active={true} />);

    // Shown at once from what was read before, while the new read is in flight.
    expect(alertText()).toContain("연결하지 못했습니다");
    await waitFor(() => expect(vaultReads()).toBe(2));
  });

  it("connecting a repository brings the block in with ONE read — no follow-up read later", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    await mount();
    expect(vaultReads()).toBe(0);
    fireEvent.change(field("저장소 주소"), { target: { value: "me/new-brain" } });

    await act(async () => void fireEvent.submit(field("저장소 주소").closest("form")!));
    await flush();

    expect(readState().user?.knowledgeRepo).toBe("me/new-brain");
    expect(vaultReads()).toBe(1);
    expect(block()!.textContent).toContain(KEPT);
    await flush(60000);
    expect(vaultReads()).toBe(1);
  });

  it("refreshing the repository (새로고침) reads nothing again: the copy it used to follow is gone", async () => {
    await mount();
    expect(vaultReads()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await flush(60000);

    expect(calls.some((call) => call.url === "/api/me/knowledge-repo/refresh" && call.method === "POST")).toBe(true);
    expect(vaultReads()).toBe(1);
  });

  it("disconnecting the repository takes the block away", async () => {
    await mount();
    expect(block()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
    await flush();
    await act(async () => resolveConfirmation(true));
    await flush(60000);

    expect(readState().user?.knowledgeRepo).toBe("");
    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
    expect(vaultReads()).toBe(1);
  });

  it("an answer that lands after the tab was unmounted changes nothing", async () => {
    let answer: (body: unknown) => void = () => {};
    vault = () => new Promise<unknown>((resolve) => (answer = resolve));
    const view = render(<SettingsKnowledgeTab active={true} />);
    await waitFor(() => expect(vaultReads()).toBe(1));

    view.unmount();
    await act(async () => answer(WORKING));

    expect(vaultReads()).toBe(1);
    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
  });

  it("another account's answer is never shown for this one", async () => {
    let answer: (body: unknown) => void = () => {};
    vault = () => new Promise<unknown>((resolve) => (answer = resolve));
    render(<SettingsKnowledgeTab active={true} />);
    await waitFor(() => expect(vaultReads()).toBe(1));

    // The session changes hands while the first account's read is still in flight.
    vault = WORKING;
    await act(async () => void replaceState({ user: userOf({ id: "other", username: "other" }) }));
    await waitFor(() => expect(vaultReads()).toBe(2));
    await waitFor(() => expect(block()).toBeTruthy());
    await act(async () => answer({ serviceConfigured: false, service: null }));

    expect(alertText()).toBeNull();
  });
});

describe("a read that is pending or fails leaves the tab alone", () => {
  it("shows nothing new while the first read is in flight", async () => {
    vault = () => new Promise<unknown>(() => {});
    render(<SettingsKnowledgeTab active={true} />);
    await waitFor(() => expect(vaultReads()).toBe(1));

    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
    expect(document.querySelector(".knowledge-repo-form")).toBeTruthy();
    expect(document.querySelector(".kr-plugins")).toBeTruthy();
    expect(screen.getByText("GitHub 플러그인")).toBeTruthy();
  });

  it("says the state could not be read, keeps the card usable, and retries", async () => {
    vault = () => refused(503, "잠시 후 다시 시도해 주세요.");
    await open();

    const note = document.querySelector<HTMLElement>(".vault-status-failed")!;
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toBe("브레인 노트의 보관 상태를 불러오지 못했습니다: 잠시 후 다시 시도해 주세요. 다시 시도");
    expect(document.querySelector(".knowledge-repo-form")).toBeTruthy();
    expect(document.querySelector(".kr-link a")?.textContent).toBe("me/brain");
    expect(screen.getByRole("button", { name: "사용할 플러그인 선택" })).toBeTruthy();

    vault = WORKING;
    await click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(block()!.textContent).toContain(KEPT));
    expect(document.querySelector(".vault-status-failed")).toBeNull();
  });

  it("keeps the last known state when a later read fails, and says so", async () => {
    vault = { serviceConfigured: true, service: "refused" };
    await open();

    vault = () => refused(500, "");
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));

    await waitFor(() => expect([...block()!.querySelectorAll(".error-note")].at(-1)?.textContent).toContain("상태를 새로 불러오지 못했습니다: "));
    expect(block()!.textContent).toContain("열어 주지 않습니다");
    expect(block()!.textContent).toContain(KEPT);
  });
});
