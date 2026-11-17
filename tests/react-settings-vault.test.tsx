// 설정 ▸ 지식·플러그인 ▸ 지식 저장소 card: where the brain notes are kept
// (`SettingsVaultStatus`, state in `usePersonalVaultStatus`, read from
// GET /api/me/personal-vault). Pinned: vault home `repo` adds NOTHING to the
// card; home `memory` says where the notes live and each state of the
// repository copy in words a person can act on — only what the SERVER
// reported, never a prediction; a repository that is still being checked
// offers no button; the copy on hold is released only by the second
// confirmation, with ONE call that names the repository and branch on screen;
// a refusal re-reads the state; a repository connect / refresh / disconnect
// reads the state now and once more four seconds later; a failed or pending
// read leaves the rest of the tab alone.
//
// Refusal sentences are the ones `src/server/routes/personalVault.ts` sends.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsKnowledgeTab from "../src/client/src/components/SettingsKnowledgeTab";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm";
import { timeLabel } from "../src/client/src/lib/format";
import { vaultMirrorFailure, vaultMirrorFailureText, vaultMirrorNoticeCount } from "../src/client/src/lib/personalVault";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { User } from "../src/client/src/lib/types";

vi.mock("../src/client/src/components/GraphViewModal", () => ({ default: () => null }));

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

interface Mirror {
  dirty: boolean;
  syncedAt: string | null;
  error: string | null;
  hold: "checking" | "confirm" | null;
  notice: string | null;
}

let calls: Call[] = [];
/** What GET /api/me/personal-vault answers; a function is called per request. */
let vault: unknown | (() => unknown | Promise<unknown>) = { home: "repo", mirror: null };
let confirmAnswer: () => Response = () => ok({ ok: true });

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

const mirror = (over: Partial<Mirror> = {}): Mirror => ({ dirty: false, syncedAt: null, error: null, hold: null, notice: null, ...over });
const memory = (over: Partial<Mirror> = {}) => ({ home: "memory", mirror: mirror(over) });

const block = (): HTMLElement | null => document.querySelector<HTMLElement>(".vault-status");
const line = (): string => document.querySelector(".vault-status-line")?.textContent || "";
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
  vault = { home: "repo", mirror: null };
  confirmAnswer = () => ok({ ok: true });
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
      if (call.url === "/api/me/personal-vault/mirror-confirm") return confirmAnswer();
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

describe("vault home `repo`", () => {
  it("adds nothing to the knowledge card", async () => {
    await open();

    expect(calls).toEqual([{ url: "/api/me/personal-vault", method: "GET" }]);
    expect(block()).toBeNull();
    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
    expect(document.body.textContent).not.toContain("메모리 서비스");
    // The card is what it was.
    expect(document.querySelector(".kr-link a")?.textContent).toBe("me/brain");
    expect(document.querySelector(".git-token-status")?.textContent).toBe("● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요");
  });

  it("shows nothing for an answer without the route's shape", async () => {
    vault = {};
    await open();
    expect(document.querySelector(".cmp-settings-vault-status")).toBeNull();
  });
});

describe("vault home `memory`: the block and the copy's state", () => {
  it("says where the notes live, that the repository gets a copy, and what a direct git edit does", async () => {
    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z" });
    await open();

    const text = block()!.textContent || "";
    expect(screen.getByRole("group", { name: "브레인 노트 보관" })).toBe(block());
    expect(text).toContain("브레인 노트는 메모리 서비스에 보관되고, 연결한 저장소에는 그 사본이 올라갑니다.");
    expect(text).toContain("저장소 맨 위의 CLAUDE.md와 wiki/, raw/ 안의 .md 파일");
    expect(text).toContain("저장소에서 이 파일들을 git으로 직접 고쳐도 브레인에는 반영되지 않습니다.");
    expect(text).toContain("다음 사본이 올라갈 때 메모리 서비스의 내용으로 다시 바뀌고, 고친 내용은 저장소의 git 기록에만 남습니다.");
    // Text a teammate reads never names the runtime.
    expect(text).not.toMatch(/pi-gateway|pi gateway/i);
    // It sits inside the card, between the token line and the plugin row.
    const card = block()!.closest(".settings-card")!;
    const order = [...card.children].map((child) => child.className);
    expect(order.indexOf("vault-status cmp-settings-vault-status")).toBeGreaterThan(order.indexOf("git-token-status muted"));
    expect(order.indexOf("vault-status cmp-settings-vault-status")).toBeLessThan(order.indexOf("kr-plugins"));
  });

  it("up to date, with the time of the last copy", async () => {
    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z" });
    await open();

    expect(line()).toBe(`사본 최신 · ${timeLabel("2026-11-17T03:20:00.000Z")}에 올림`);
    expect(document.querySelector(".vault-status-line")?.className).toBe("vault-status-line synced");
    expect(block()!.querySelector(".vault-status-hold")).toBeNull();
    expect(screen.queryByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeNull();
  });

  it("up to date before any copy was needed", async () => {
    vault = memory();
    await open();
    expect(line()).toBe("사본 최신 · 메모리 서비스로 옮긴 뒤 바뀐 노트가 없습니다");
  });

  it("waiting to be pushed", async () => {
    vault = memory({ dirty: true, syncedAt: "2026-11-17T03:20:00.000Z" });
    await open();

    expect(line()).toBe(`올릴 변경이 있습니다 · 잠시 후 자동으로 올립니다 (마지막으로 올린 때 ${timeLabel("2026-11-17T03:20:00.000Z")})`);
    expect(document.querySelector(".vault-status-line")?.className).toBe("vault-status-line waiting");
  });

  it("predicts no failure: without the internal git token a waiting copy is still only waiting", async () => {
    // `gitTokenSet` knows the internal token alone; an owner pushing with another one must not be shown a failure.
    replaceState({ user: userOf({ gitTokenSet: false }) });
    vault = memory({ dirty: true });
    await open();

    expect(line()).toBe("올릴 변경이 있습니다 · 잠시 후 자동으로 올립니다");
    expect(document.querySelector(".vault-status-line")?.className).toBe("vault-status-line waiting");
    expect(block()!.querySelector(".vault-status-state .linkish")).toBeNull();
  });

  it("failed: no git token", async () => {
    vault = memory({ dirty: true, error: "no git token" });
    await open();

    expect(line()).toBe("사본을 올리지 못했습니다 — Git 토큰이 없어 저장소에 올리지 못했습니다.");
    expect(document.querySelector(".vault-status-line")?.className).toBe("vault-status-line failed");
    expect(block()!.textContent).toContain("노트는 메모리 서비스에 그대로 저장되어 있고, 사본은 자동으로 다시 시도합니다.");
    await click(screen.getByRole("button", { name: "권한·연결 탭에서 Git 토큰 설정" }));
    expect(readState().settingsTab).toBe("access");
  });

  it("failed: the repository has uncommitted changes, with a way to ask the avatar", async () => {
    vault = memory({ dirty: true, error: "repo has uncommitted changes" });
    await open();

    expect(line()).toBe(
      "사본을 올리지 못했습니다 — 저장소에 아직 커밋하지 않은 다른 변경이 있어 사본만 따로 올리지 않았습니다. 아바타가 저장소를 커밋하면 사본도 함께 올라갑니다.",
    );
    expect(screen.getByRole("button", { name: "아바타에게 커밋 요청" })).toBeTruthy();
  });

  it("failed: the push was rejected", async () => {
    vault = memory({ dirty: true, error: "push failed: ! [rejected] main -> main (fetch first); error: failed to push some refs to 'https://git.example/me/brain.git'" });
    await open();

    expect(line()).toBe("사본을 올리지 못했습니다 — 저장소가 사본을 받지 않았습니다. 저장소에 이 서버가 아직 가져오지 않은 커밋이 있을 수 있습니다.");
    expect(block()!.textContent).toContain("위의 ‘새로고침’으로 저장소를 다시 가져오면 다음 시도에 올라갑니다.");
  });

  it("failed: the token may not push", async () => {
    vault = memory({ dirty: true, error: "push failed: remote: Permission to me/brain.git denied to bot.; fatal: unable to access 'https://git.example/me/brain.git/': The requested URL returned error: 403" });
    await open();

    expect(line()).toBe("사본을 올리지 못했습니다 — Git 토큰으로 저장소에 올릴 권한이 없습니다. 토큰의 쓰기 권한을 확인해 주세요.");
    expect(screen.getByRole("button", { name: "권한·연결 탭에서 Git 토큰 설정" })).toBeTruthy();
  });

  it("failed: a conflict in the repository — it names who can settle it and does NOT send the user to the avatar", async () => {
    vault = memory({ dirty: true, error: "rebase conflict: skills/a/SKILL.md" });
    await open();

    expect(line()).toBe(
      "사본을 올리지 못했습니다 — 저장소에 새로 올라온 커밋과 이 서버가 아직 올리지 못한 커밋이 같은 파일을 고쳐서 사본을 올리지 못했습니다. 브레인 노트가 아닌 파일의 충돌이라 자동으로 정리되지 않고, 아바타도 풀 수 없습니다. 저장소에서 겹친 파일의 변경을 되돌려 올리거나, 관리자에게 서버 쪽 저장소 사본 정리를 요청해 주세요. (상세: skills/a/SKILL.md)",
    );
    // The avatar's commit tool answers the same conflict with "reconcile it manually": no button leads there.
    expect(screen.queryByRole("button", { name: /아바타에게/ })).toBeNull();
  });

  it("a server without a memory service says so, whatever the copy's last state was", async () => {
    vault = { ...memory({ dirty: false, syncedAt: "2026-11-17T01:00:00.000Z" }), serviceConfigured: false };
    await open();
    expect(block()!.querySelector('[role="alert"]')!.textContent).toContain("이 서버에 메모리 서비스가 연결되어 있지 않습니다.");
  });

  it("an answer that does not say whether the service is configured (an older server) shows no such warning", async () => {
    vault = memory({ dirty: false, syncedAt: "2026-11-17T01:00:00.000Z" });
    await open();
    expect(block()!.textContent).not.toContain("메모리 서비스가 연결되어 있지 않습니다");
  });

  it("the server's check of the memory service failed just now: an outage line above the copy's last state", async () => {
    vault = { ...memory({ dirty: false, syncedAt: "2026-11-17T01:00:00.000Z" }), serviceConfigured: true, service: "unavailable" };
    await open();
    const alert = block()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("지금 메모리 서비스에 연결하지 못했습니다.");
    expect(alert.textContent).toContain("저장된 노트는 그대로 있습니다");
    // The copy's state is still shown — it is what it was; the line above says the brain cannot be used now.
    expect(line()).toContain("사본 최신");
  });

  it("the service answered but refused this vault: its own outage line", async () => {
    vault = { ...memory({ dirty: false, syncedAt: "2026-11-17T01:00:00.000Z" }), serviceConfigured: true, service: "refused" };
    await open();
    expect(block()!.querySelector('[role="alert"]')!.textContent).toContain("지금 메모리 서비스가 이 브레인 노트를 열어 주지 않습니다.");
  });

  it("no outage line when the service answered, or when the server does not say (an older server)", async () => {
    vault = { ...memory({ dirty: false, syncedAt: "2026-11-17T01:00:00.000Z" }), serviceConfigured: true, service: "ok" };
    await open();
    expect(block()!.querySelector('[role="alert"]')).toBeNull();
  });

  it("failed: the memory service could not be used", async () => {
    vault = memory({ dirty: true, error: "memory service unavailable (timeout)" });
    await open();
    expect(line()).toBe("사본을 올리지 못했습니다 — 메모리 서비스에 연결하지 못해 사본을 만들지 못했습니다. 계속되면 관리자에게 알려 주세요.");
  });

  it("a notice: the repository holds notes the memory service does not — nothing was deleted, what it means, who can help", async () => {
    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z", notice: "repository notes not in the memory service: 7" });
    await open();

    // The copy itself is fine; the notice stands next to it.
    expect(line()).toContain("사본 최신");
    const notice = block()!.querySelector(".vault-status-notice")!;
    expect(notice.getAttribute("role")).toBe("note");
    expect(notice.textContent).toBe(
      "저장소 사본에는 메모리 서비스에 없는 노트가 7개 있습니다. 아무것도 지우지 않았습니다. 이 노트들은 브레인에 들어 있지 않아 아바타가 찾거나 읽지 못합니다. 브레인에 넣으려면 관리자에게 ‘되돌린 뒤 다시 옮기기’를 요청해 주세요.",
    );
  });

  it("a notice it does not know is shown as it came, and no notice shows nothing", async () => {
    vault = memory({ notice: "something new: 3" });
    await open();
    expect(block()!.querySelector(".vault-status-notice")?.textContent).toBe("something new: 3");
    expect(vaultMirrorNoticeCount("something new: 3")).toBeNull();
    expect(vaultMirrorNoticeCount("repository notes not in the memory service: 12")).toBe(12);

    vault = memory();
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));
    await waitFor(() => expect(block()!.querySelector(".vault-status-notice")).toBeNull());
  });

  it("failed for a reason it does not know: the raw text is shown", async () => {
    vault = memory({ dirty: true, error: "mirror failed: file system error (ENOSPC)" });
    await open();
    expect(line()).toBe("사본을 올리지 못했습니다 — 저장소에 올리지 못했습니다. (상세: mirror failed: file system error (ENOSPC))");
    // No way out is offered for a reason it cannot name.
    expect(block()!.querySelector(".vault-status-state .linkish")).toBeNull();
  });

  it("without a connected repository it only says where the notes are", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    vault = memory({ dirty: true });
    await open();

    expect(block()!.textContent).toBe(
      "브레인 노트 보관상태 새로 고침브레인 노트는 메모리 서비스에 보관됩니다. 지식 저장소를 연결하면 그 사본이 저장소에 올라갑니다.",
    );
    expect(document.querySelector(".empty-note")).toBeTruthy();
  });

  it("reads the state again from 상태 새로 고침", async () => {
    vault = memory({ dirty: true });
    await open();
    expect(line()).toContain("올릴 변경이 있습니다");

    vault = memory({ syncedAt: "2026-11-17T04:00:00.000Z" });
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));

    await waitFor(() => expect(line()).toBe(`사본 최신 · ${timeLabel("2026-11-17T04:00:00.000Z")}에 올림`));
    expect(vaultReads()).toBe(2);
  });

  it("keeps what it knows across a tab switch and reads again when the tab comes back", async () => {
    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z" });
    const view = render(<SettingsKnowledgeTab active={true} />);
    await waitFor(() => expect(block()).toBeTruthy());

    view.rerender(<SettingsKnowledgeTab active={false} />);
    expect(view.container.innerHTML).toBe("");
    const pending = new Promise<unknown>(() => {});
    vault = () => pending;
    view.rerender(<SettingsKnowledgeTab active={true} />);

    // Shown at once from what was read before, while the new read is in flight.
    expect(line()).toContain("사본 최신");
    await waitFor(() => expect(vaultReads()).toBe(2));
  });
});

/** Fake timers: let pending promises settle and move the clock. */
const flush = (ms = 0): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("a newly connected repository that the server has not looked at yet (`checking`)", () => {
  const CHECKING = "연결한 저장소를 확인하는 중입니다";

  it("shows a neutral line, says what to do if it stays that way, and offers NO confirmation", async () => {
    vault = memory({ dirty: true, hold: "checking" });
    await open();

    const state = block()!.querySelector(".vault-status-state")!;
    expect(state.textContent).toContain(`${CHECKING} · 이 저장소에 이미 브레인 노트가 있는지 살펴보고 있습니다. 확인이 끝날 때까지 저장소에는 아무것도 올리지 않습니다.`);
    expect(state.textContent).toContain(
      "이 상태가 계속되면 서버가 저장소를 읽지 못하고 있는 것입니다. Git 토큰이 유효한지, 저장소 주소에 접근할 수 있는지 확인한 뒤 ‘지금 다시 확인’을 눌러 주세요. 누르지 않아도 서버가 계속 다시 확인합니다(처음 30분은 약 1분마다, 그 뒤로는 10분마다). 그래도 풀리지 않으면 관리자에게 알려 주세요(막힌 이유가 관리자 화면에 나옵니다).",
    );
    // Nothing was found yet, so nothing can be confirmed: no warning, no destructive button.
    expect(block()!.querySelector(".vault-status-hold")).toBeNull();
    expect(block()!.textContent).not.toContain("이미 브레인 노트가 들어 있습니다");
    expect(screen.queryByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeNull();

    await click(screen.getByRole("button", { name: "권한·연결 탭에서 Git 토큰 확인" }));
    expect(readState().settingsTab).toBe("access");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("지금 다시 확인 asks the server to look again and then follows what it finds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vault = memory({ dirty: true, hold: "checking" });
    let rechecks = 0;
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/me/personal-vault/mirror-recheck") return real(input, init);
      calls.push({ url: String(input), method: init?.method || "GET" });
      rechecks += 1;
      // What the route answers: 202, the look has only been started.
      return { ok: true, status: 202, json: async () => ({ started: true }) } as unknown as Response;
    });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();
    expect(vaultReads()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "지금 다시 확인" }));
    await flush();

    // One request without a body, then the state is read now…
    expect(rechecks).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toEqual([{ url: "/api/me/personal-vault/mirror-recheck", method: "POST" }]);
    expect(vaultReads()).toBe(2);
    expect(block()!.textContent).toContain(CHECKING);

    // …and again four seconds later, by when the look found brain notes in the repository.
    vault = memory({ dirty: true, hold: "confirm" });
    await flush(4000);
    expect(screen.getByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "지금 다시 확인" })).toBeNull();
  });

  it("the button exists only while checking", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    await open();
    expect(screen.queryByRole("button", { name: "지금 다시 확인" })).toBeNull();

    vault = memory({ dirty: true });
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));
    await waitFor(() => expect(line()).toContain("올릴 변경이 있습니다"));
    expect(screen.queryByRole("button", { name: "지금 다시 확인" })).toBeNull();
  });

  it("reads a hold it does not know as `checking` — never as something to confirm", async () => {
    vault = { home: "memory", mirror: { dirty: true, syncedAt: null, error: null, hold: true, notice: null } };
    await open();
    expect(block()!.textContent).toContain(CHECKING);
    expect(screen.queryByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeNull();
  });

  it("follows the check by itself: nothing found → the copy simply continues", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vault = memory({ dirty: true, hold: "checking" });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();
    expect(block()!.textContent).toContain(CHECKING);
    expect(vaultReads()).toBe(1);

    await flush(3999);
    expect(vaultReads()).toBe(1);
    await flush(1);
    expect(vaultReads()).toBe(2);
    expect(block()!.textContent).toContain(CHECKING);

    vault = memory({ dirty: true });
    await flush(4000);
    expect(vaultReads()).toBe(3);
    expect(line()).toBe("올릴 변경이 있습니다 · 잠시 후 자동으로 올립니다");

    // Once the check is over it stops reading.
    await flush(60000);
    expect(vaultReads()).toBe(3);
  });

  it("follows the check by itself: notes found → the confirmation appears", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vault = memory({ dirty: true, hold: "checking" });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();

    vault = memory({ dirty: true, hold: "confirm" });
    await flush(4000);

    expect(block()!.querySelector(".vault-status-hold")).toBeTruthy();
    expect(screen.getByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeTruthy();
  });

  it("stops following a check that never ends (ten more reads), and a failed read does not stop it earlier", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vault = memory({ dirty: true, hold: "checking" });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();

    const still = memory({ dirty: true, hold: "checking" });
    let failNext = true;
    vault = () => {
      if (!failNext) return still;
      failNext = false;
      return refused(502, "");
    };
    await flush(4000);
    expect(vaultReads()).toBe(2);
    // The failed read kept the block and the follow-up alive.
    expect(block()!.textContent).toContain(CHECKING);
    // (One step per read: the next one is scheduled by the render that follows each answer.)
    for (let i = 0; i < 20; i += 1) await flush(4000);
    expect(vaultReads()).toBe(11);
    expect(block()!.textContent).toContain(CHECKING);
  });
});

describe("the copy on hold: the check found brain notes in the repository (`confirm`)", () => {
  const CONFIRM = "저장소의 노트를 바꾸고 사본 올리기";
  // The sentences `POST /api/me/personal-vault/mirror-confirm` really refuses with (routes/personalVault.ts).
  const REFUSED_OTHER_REPO = "연결된 저장소나 브랜치가 화면에 보이던 것과 다릅니다. 아무것도 바꾸지 않았습니다. 화면을 새로 고친 뒤 다시 확인해 주세요.";
  const REFUSED_CHECKING = "새로 연결한 저장소를 아직 확인하는 중입니다. 확인이 끝난 뒤, 필요할 때만 다시 물어봅니다.";
  const posts = (): Call[] => calls.filter((call) => call.method === "POST");

  it("explains that the repository's brain notes will be REPLACED and stay in git history", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    await open();

    const hold = block()!.querySelector(".vault-status-hold")!;
    expect(hold.textContent).toContain("사본 보류 중 — 확인이 필요합니다.");
    expect(hold.textContent).toContain("지금 연결한 저장소에는 이미 브레인 노트가 들어 있습니다.");
    expect(hold.textContent).toContain("저장소의 CLAUDE.md와 wiki/, raw/ 안의 노트가 메모리 서비스의 내용으로 바뀝니다.");
    expect(hold.textContent).toContain("바뀌기 전 내용은 저장소의 git 기록에 남습니다.");
    expect(hold.textContent).toContain("확인하기 전에는 저장소를 건드리지 않습니다.");
    // On hold there is no "waiting"/"failed" line next to it.
    expect(document.querySelector(".vault-status-line")).toBeNull();
  });

  it("asks once more, and a 취소 calls nothing", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    await open();

    await click(screen.getByRole("button", { name: CONFIRM }));

    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    const request = get(confirmation)!;
    expect(request.title).toBe("저장소의 브레인 노트를 바꿀까요?");
    expect(request.confirmLabel).toBe("바꾸고 사본 올리기");
    expect(request.tone).toBe("danger");
    expect(request.message).toContain("메모리 서비스의 내용으로 바꿉니다.");
    expect(request.message).toContain("저장소에만 있던 노트는 저장소에서 지워지고, 바뀌기 전 내용은 저장소의 git 기록에 남습니다.");
    // Nothing was sent by the first press.
    expect(posts()).toEqual([]);

    await act(async () => resolveConfirmation(false));

    expect(posts()).toEqual([]);
    expect(block()!.querySelector(".vault-status-hold")).toBeTruthy();
  });

  it("calls mirror-confirm ONCE after the second confirmation, naming the repository on screen, and shows the new state", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    await open();

    await click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    vault = memory({ dirty: true });
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(block()!.querySelector(".vault-status-hold")).toBeNull());
    // The default branch is sent as null, never as "".
    expect(posts()).toEqual([{ url: "/api/me/personal-vault/mirror-confirm", method: "POST", body: { repo: "me/brain", branch: null } }]);
    expect(line()).toContain("올릴 변경이 있습니다");
    expect(get(toasts).at(-1)?.message).toBe("확인했습니다. 잠시 후 저장소에 사본을 올립니다.");
  });

  it("sends the SAVED repository and branch, not text typed into the form", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain", knowledgeBranch: "notes" }) });
    vault = memory({ dirty: true, hold: "confirm" });
    await open();
    // Unsaved edits of the form are not what the warning is about.
    fireEvent.change(screen.getByText("저장소 주소").closest("label")!.querySelector("input")!, { target: { value: "someone/else" } });
    fireEvent.change(screen.getByText("브랜치 (선택)").closest("label")!.querySelector("input")!, { target: { value: "main" } });

    await click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ repo: "me/brain", branch: "notes" });
  });

  it("after a refusal it shows the server's sentence AND re-reads: the stale warning does not stay", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    confirmAnswer = () => refused(409, REFUSED_OTHER_REPO);
    await open();
    const before = vaultReads();

    await click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    // The state moved on while the warning was on screen: another repository is being checked now.
    vault = memory({ dirty: true, hold: "checking" });
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(get(toasts).at(-1)?.message).toBe(`확인하지 못했습니다: ${REFUSED_OTHER_REPO}`));
    await waitFor(() => expect(block()!.querySelector(".vault-status-hold")).toBeNull());
    expect(vaultReads()).toBe(before + 1);
    expect(block()!.textContent).toContain("연결한 저장소를 확인하는 중입니다");
    expect(screen.queryByRole("button", { name: CONFIRM })).toBeNull();
  });

  it("a refusal that leaves the state as it was keeps the warning usable", async () => {
    vault = memory({ dirty: true, hold: "confirm" });
    confirmAnswer = () => refused(409, REFUSED_CHECKING);
    await open();

    await click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(get(toasts).at(-1)?.message).toBe(`확인하지 못했습니다: ${REFUSED_CHECKING}`));
    await waitFor(() => expect((screen.getByRole("button", { name: CONFIRM }) as HTMLButtonElement).disabled).toBe(false));
    expect(posts()).toHaveLength(1);
  });
});

describe("a repository change reads the state now and once more four seconds later", () => {
  const field = (label: string): HTMLInputElement => screen.getByText(label).closest("label")!.querySelector("input")!;

  async function mount(): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<SettingsKnowledgeTab active={true} />);
    await flush();
    expect(vaultReads()).toBe(1);
  }

  async function expectFollowUp(): Promise<void> {
    // Now…
    expect(vaultReads()).toBe(2);
    // …and once more after four seconds (the server applies a repository change in the background).
    await flush(3999);
    expect(vaultReads()).toBe(2);
    await flush(1);
    expect(vaultReads()).toBe(3);
    await flush(60000);
    expect(vaultReads()).toBe(3);
  }

  it("connecting a repository", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    await mount();
    fireEvent.change(field("저장소 주소"), { target: { value: "me/new-brain" } });

    await act(async () => void fireEvent.submit(field("저장소 주소").closest("form")!));
    await flush();

    expect(readState().user?.knowledgeRepo).toBe("me/new-brain");
    await expectFollowUp();
  });

  it("shows what the follow-up read finds: the new repository went from `checking` to `confirm`", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    vault = memory();
    await mount();
    fireEvent.change(field("저장소 주소"), { target: { value: "me/new-brain" } });
    vault = memory({ dirty: true, hold: "checking" });

    await act(async () => void fireEvent.submit(field("저장소 주소").closest("form")!));
    await flush();
    // The first re-read comes before the server has looked: neutral, no button.
    expect(block()!.textContent).toContain("연결한 저장소를 확인하는 중입니다");
    expect(screen.queryByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeNull();

    vault = memory({ dirty: true, hold: "confirm" });
    await flush(4000);
    expect(screen.getByRole("button", { name: "저장소의 노트를 바꾸고 사본 올리기" })).toBeTruthy();
  });

  it("refreshing the repository (새로고침)", async () => {
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await flush();

    expect(calls.some((call) => call.url === "/api/me/knowledge-repo/refresh" && call.method === "POST")).toBe(true);
    await expectFollowUp();
  });

  it("disconnecting the repository", async () => {
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
    await flush();
    await act(async () => resolveConfirmation(true));
    await flush();

    expect(readState().user?.knowledgeRepo).toBe("");
    await expectFollowUp();
  });

  it("a failed save reads nothing again", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "" }) });
    await mount();
    vi.mocked(fetch).mockImplementationOnce(async () => refused(400, "저장소 주소가 올바르지 않습니다."));
    fireEvent.change(field("저장소 주소"), { target: { value: "bad" } });

    await act(async () => void fireEvent.submit(field("저장소 주소").closest("form")!));
    await flush(10000);

    expect(vaultReads()).toBe(1);
  });

  it("leaves no read behind once the tab is unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = render(<SettingsKnowledgeTab active={true} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await flush();
    expect(vaultReads()).toBe(2);

    view.unmount();
    await flush(10000);

    expect(vaultReads()).toBe(2);
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
    vault = () => refused(503, "메모리 서비스에 연결할 수 없습니다.");
    await open();

    const note = document.querySelector<HTMLElement>(".vault-status-failed")!;
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toBe("브레인 노트의 보관 상태를 불러오지 못했습니다: 메모리 서비스에 연결할 수 없습니다. 다시 시도");
    expect(document.querySelector(".knowledge-repo-form")).toBeTruthy();
    expect(document.querySelector(".kr-link a")?.textContent).toBe("me/brain");
    expect(screen.getByRole("button", { name: "사용할 플러그인 선택" })).toBeTruthy();

    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z" });
    await click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(line()).toContain("사본 최신"));
    expect(document.querySelector(".vault-status-failed")).toBeNull();
  });

  it("keeps the last known state when a later read fails, and says so", async () => {
    vault = memory({ syncedAt: "2026-11-17T03:20:00.000Z" });
    await open();

    vault = () => refused(500, "");
    await click(screen.getByRole("button", { name: "상태 새로 고침" }));

    await waitFor(() => expect(block()!.querySelector(".error-note")?.textContent).toContain("상태를 새로 불러오지 못했습니다: "));
    expect(line()).toContain("사본 최신");
  });
});

describe("mirror failure text", () => {
  it("maps the reasons the server names and falls back to the raw text", () => {
    // The server's closed list (VAULT_MIRROR_ERROR in vaultMirror.ts), alone or with a detail.
    expect(vaultMirrorFailure("no git token")).toBe("no_token");
    expect(vaultMirrorFailure("repo has uncommitted changes")).toBe("repo_dirty");
    expect(vaultMirrorFailure("push failed: ! [rejected] main -> main (non-fast-forward)")).toBe("rejected");
    expect(vaultMirrorFailure("push failed: fatal: Authentication failed for 'https://git.example/x.git/'")).toBe("denied");
    // A protected branch is neither a token scope nor a stale clone: git's words are shown.
    expect(vaultMirrorFailure("push failed: ! [remote rejected] main -> main (protected branch hook declined)")).toBe("other");
    expect(vaultMirrorFailure("push failed: fatal: unable to access: Could not resolve host")).toBe("other");
    expect(vaultMirrorFailure("rebase conflict: wiki/a.md")).toBe("conflict");
    expect(vaultMirrorFailure("clone sync failed: fatal: repository not found")).toBe("sync");
    expect(vaultMirrorFailure("not cloned")).toBe("not_cloned");
    expect(vaultMirrorFailure("memory service unavailable (network)")).toBe("service");
    expect(vaultMirrorFailure("memory service refused (wiki_full)")).toBe("refused");
    // Retired with the deletion ledger: no longer a text the mirror stores.
    expect(vaultMirrorFailure("memory service holds no notes")).toBe("other");
    expect(vaultMirrorFailure("path blocked: wiki is a link")).toBe("path");
    expect(vaultMirrorFailure("commit failed: fatal: unable to write index")).toBe("other");
    expect(vaultMirrorFailure("owner not found")).toBe("other");
    expect(vaultMirrorFailure("something else")).toBe("other");
    expect(vaultMirrorFailureText("memory service refused (wiki_full)")).toBe(
      "메모리 서비스가 요청을 받지 않아 사본을 만들지 못했습니다. 계속되면 관리자에게 알려 주세요. (상세: wiki_full)",
    );
    expect(vaultMirrorFailureText("clone sync failed: fatal: repository not found")).toBe(
      "저장소를 가져오지 못했습니다. 저장소 주소와 Git 토큰 권한을 확인해 주세요. (상세: fatal: repository not found)",
    );
    expect(vaultMirrorFailureText("something else")).toBe("저장소에 올리지 못했습니다. (상세: something else)");
  });
});
