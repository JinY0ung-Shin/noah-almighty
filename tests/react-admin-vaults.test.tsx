// 관리자 ▸ 시스템 ▸ 개인 브레인 이전 (`AdminPersonalVaultPanel`), against
// mocked GET /api/admin/personal-vaults + dry-run / mode / run / rollback.
// Pinned: an unconfigured server offers nothing; every step that changes where
// somebody's notes live asks first and says what it does; a dry run shows what
// moves, what stays and why an owner cannot be moved; a running pass is
// visible and followed; a refusal is shown as the server phrased it and the
// table is read again (a 409 means the screen was out of date).
//
// Refusal bodies are the ones the server really sends: the sentences of
// `src/server/routes/personalVault.ts`, and `{ error: "Internal server error" }`
// (500) for a handler that threw (`app.ts`).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPersonalVaultPanel from "../src/client/src/components/AdminPersonalVaultPanel";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm";
import { timeLabel } from "../src/client/src/lib/format";
import { vaultBlockerText, vaultSkippedReasonText } from "../src/client/src/lib/personalVault";
import { get } from "../src/client/src/lib/store";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

const mirror = (over: Record<string, unknown> = {}) => ({ dirty: false, syncedAt: null, error: null, hold: null, notice: null, ...over });

// What the server answers (routes/personalVault.ts).
const NOT_CONFIGURED = "이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 서버 설정(PI_MEMORY_URL, PI_MEMORY_API_KEY_FILE)을 확인해 주세요.";
const HOME_MISMATCH = "이 팀원의 개인 브레인 위치가 화면에 보이던 것과 다릅니다. 아무것도 바꾸지 않았습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.";
const MIRROR_FAILED = "저장소 사본을 최신으로 올리지 못해 되돌릴 수 없습니다. 노트는 메모리 서비스에 그대로 있습니다. (상세: no git token)";
const LEFTOVER_NOT_SAVED = "메모리 서비스에 있는 노트 중 저장소에 없는 것을 읽어 따로 보관하지 못했습니다. 아무것도 지우거나 바꾸지 않았습니다. 잠시 후 다시 시도해 주세요.";

function owner(over: Record<string, unknown> = {}) {
  return { userId: "u1", username: "kim", displayName: "김하나", state: "repo", repo: "kim/brain", migratedAt: null, mirror: null, report: null, ...over };
}

function report(over: Record<string, unknown> = {}) {
  return { userId: "u1", repo: "kim/brain", sourceCommit: "abc123", notes: 12, bytes: 20000, skipped: [], blockers: [], state: "repo", ...over };
}

const OWNERS = [
  owner(),
  owner({
    userId: "u2",
    username: "lee",
    displayName: "이두리",
    state: "memory",
    repo: "lee/notes",
    migratedAt: "2026-11-16T01:00:00.000Z",
    mirror: mirror({ syncedAt: "2026-11-17T03:20:00.000Z" }),
  }),
  owner({ userId: "u3", username: "park", displayName: "박세나", state: "no_repo", repo: null }),
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: Call[] = [];
/** What GET /api/admin/personal-vaults answers now. */
let state: Record<string, unknown> = {};
let handle: Handler = () => undefined;

const posts = (): Call[] => calls.filter((call) => call.method === "POST");
const reads = (): number => calls.filter((call) => call.method === "GET").length;
const click = (element: Element): Promise<void> => act(async () => void fireEvent.click(element));
const status = (): string => document.getElementById("admin-personal-vault-status")?.textContent || "";
const button = (name: string): HTMLButtonElement => screen.getByRole("button", { name }) as HTMLButtonElement;
const radio = (name: RegExp): HTMLInputElement => screen.getByRole("radio", { name }) as HTMLInputElement;
const row = (name: string): HTMLElement => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;

async function open(): Promise<void> {
  render(<AdminPersonalVaultPanel active={true} />);
  await waitFor(() => expect(reads()).toBeGreaterThan(0));
  await act(async () => {});
}

async function confirmWith(answer: boolean): Promise<void> {
  await waitFor(() => expect(get(confirmation)).toBeTruthy());
  await act(async () => resolveConfirmation(answer));
}

beforeEach(() => {
  calls = [];
  state = { mode: "repo", serviceConfigured: true, running: false, owners: OWNERS };
  handle = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: String(init?.method || "GET").toUpperCase(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const custom = await handle(call);
      if (custom) return custom;
      if (call.url === "/api/admin/personal-vaults" && call.method === "GET") return json(state);
      return json({});
    }),
  );
});

afterEach(() => {
  if (get(confirmation)) resolveConfirmation(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a server without the memory service", () => {
  it("with nobody moved: says where the notes are, keeps the table, offers no action", async () => {
    state = { mode: "repo", serviceConfigured: false, running: false, owners: [OWNERS[0], OWNERS[2]] };
    await open();

    expect(screen.getByRole("heading", { name: "개인 브레인 이전" })).toBeTruthy();
    const note = document.querySelector(".vault-admin-unconfigured")!;
    expect(note.textContent).toBe(
      "이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 옮긴 팀원이 없어 모든 팀원의 브레인 노트는 각자의 지식 저장소에 있습니다. 서버 환경 변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 설정하고 다시 배포하면 여기에서 이전을 시작할 수 있습니다.",
    );
    expect(screen.getByRole("table", { name: "팀원별 개인 브레인 보관 상태" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    // Only the refresh button is left.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["새로 고침"]);
  });

  it("with owners on the memory service: says their notes cannot be read or written, shows who, offers no action", async () => {
    const LEFTOVER = "service_only_note: the memory service already holds wiki/old.md, which the repository does not have";
    state = {
      mode: "memory",
      serviceConfigured: false,
      running: false,
      owners: [
        owner({ report: report({ blockers: [LEFTOVER] }) }),
        OWNERS[1],
        owner({ userId: "u5", username: "jung", displayName: "정다섯", state: "memory", mirror: mirror({ notice: "repository notes not in the memory service: 4" }) }),
        OWNERS[2],
      ],
    };
    await open();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 메모리 서비스로 옮긴 팀원 2명의 브레인 노트는 서비스가 다시 설정될 때까지 읽을 수도 쓸 수도 없습니다. 서버 환경 변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 다시 설정하고 배포해 주세요. 그때까지 이 화면에서 할 수 있는 작업은 없습니다.",
    );
    // It does not claim the brains are in the repositories.
    expect(document.body.textContent).not.toContain("지금처럼 각자의 지식 저장소에 보관됩니다");
    expect(document.body.textContent).not.toContain("모든 팀원의 브레인 노트는 각자의 지식 저장소에 있습니다");

    // Who is affected stays visible…
    expect(row("이두리").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("메모리 서비스 읽기·쓰기 불가");
    expect(row("정다섯").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("메모리 서비스 읽기·쓰기 불가");
    expect(row("김하나").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("저장소");
    // …with the reports, but nothing that could be pressed: no mode, no dry run, no run, no rollback, no leftover clear.
    expect((row("김하나").nextElementSibling as HTMLElement).textContent).toContain("메모리 서비스에 저장소에는 없는 노트가 남아 있습니다.");
    // A notice is still told, without the way out that cannot be taken now.
    expect((row("정다섯").nextElementSibling as HTMLElement).textContent).toBe(
      "저장소 사본에 메모리 서비스에는 없는 노트가 4개 있습니다. 아무것도 지우지 않았습니다. 이 노트들은 이 팀원의 브레인에 들어 있지 않습니다.",
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "미리 확인" })).toBeNull();
    expect(screen.queryByRole("button", { name: "이전 실행" })).toBeNull();
    expect(screen.queryByRole("button", { name: /되돌리기/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /남은 사본 비우기/ })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["새로 고침"]);
    expect(posts()).toEqual([]);
  });

  it("renders nothing while its tab is not the active one, and reads only when it is", async () => {
    const view = render(<AdminPersonalVaultPanel active={false} />);
    expect(view.container.innerHTML).toBe("");
    expect(calls).toEqual([]);

    view.rerender(<AdminPersonalVaultPanel active={true} />);
    expect(await screen.findByRole("table", { name: "팀원별 개인 브레인 보관 상태" })).toBeTruthy();
    expect(reads()).toBe(1);
  });
});

describe("the mode and the per-owner table", () => {
  it("shows the current mode, every owner's state, repository, time and copy state", async () => {
    await open();

    expect(radio(/저장소에 보관/).checked).toBe(true);
    expect(radio(/메모리 서비스로 이전/).checked).toBe(false);
    expect(status()).toBe("옮긴 팀원 1명 / 저장소를 연결한 팀원 2명");

    const table = screen.getByRole("table", { name: "팀원별 개인 브레인 보관 상태" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["팀원", "보관 위치", "저장소", "옮긴 때", "저장소 사본", "작업"]);
    const cells = (name: string) => [...row(name).querySelectorAll("th, td")].map((cell) => cell.textContent);
    expect(cells("김하나")).toEqual(["김하나 @kim", "저장소", "kim/brain", "—", "—", ""]);
    expect(cells("이두리")).toEqual([
      "이두리 @lee",
      "메모리 서비스",
      "lee/notes",
      timeLabel("2026-11-16T01:00:00.000Z"),
      `최신 · ${timeLabel("2026-11-17T03:20:00.000Z")}`,
      "되돌리기",
    ]);
    expect(cells("박세나")).toEqual(["박세나 @park", "저장소 없음", "—", "—", "—", ""]);
    // Only a moved owner can be rolled back.
    expect(screen.getAllByRole("button", { name: /되돌리기/ })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/pi-gateway/i);
  });

  it("names each copy state in the table", async () => {
    state = {
      ...state,
      owners: [
        owner({ userId: "a", displayName: "가", username: "a", state: "memory", mirror: mirror({ dirty: true }) }),
        owner({ userId: "b", displayName: "나", username: "b", state: "memory", mirror: mirror({ dirty: true, error: "no git token" }) }),
        owner({ userId: "c", displayName: "다", username: "c", state: "memory", mirror: mirror({ dirty: true, hold: "confirm" }) }),
        owner({ userId: "g", displayName: "사", username: "g", state: "memory", mirror: mirror({ dirty: true, hold: "checking" }) }),
        owner({ userId: "d", displayName: "라", username: "d", state: "memory", mirror: mirror({ dirty: true, error: "commit failed: fatal: unable to write index" }) }),
        owner({ userId: "f", displayName: "바", username: "f", state: "memory", mirror: mirror({ dirty: true, error: "push failed: ! [rejected] main -> main (fetch first)" }) }),
        owner({ userId: "e", displayName: "마", username: "e", state: "memory", mirror: mirror() }),
      ],
    };
    await open();

    const copy = (name: string) => row(name).querySelector('td[data-label="저장소 사본"]')!;
    expect(copy("가").textContent).toBe("올릴 변경 있음");
    expect(copy("나").textContent).toBe("실패 · Git 토큰 없음");
    expect(copy("나").querySelector("span")?.getAttribute("title")).toBe("no git token");
    expect(copy("다").textContent).toBe("보류 · 본인 확인 대기");
    expect(copy("사").textContent).toBe("저장소 확인 중");
    expect(copy("라").textContent).toBe("실패 · commit failed: fatal: unable to write index");
    expect(copy("바").textContent).toBe("실패 · 저장소가 받지 않음");
    expect(copy("마").textContent).toBe("최신");
  });

  it("gates 이전 실행 on the mode and says what to do first", async () => {
    await open();
    expect(button("이전 실행").disabled).toBe(true);
    expect(button("미리 확인").disabled).toBe(false);
    expect(screen.getByText(/이전을 실행하려면 먼저 보관 방식을 ‘메모리 서비스로 이전’으로 바꿔 주세요/)).toBeTruthy();
  });

  it("shows a load failure and loads again from 새로 고침", async () => {
    handle = (call) => (call.method === "GET" ? json({ error: "Admin access required" }, 403) : undefined);
    await open();

    expect(screen.getByRole("alert").textContent).toBe("관리자 권한이 필요합니다.");
    expect(screen.queryByRole("table")).toBeNull();

    handle = () => undefined;
    await click(button("새로 고침"));

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an answer without the route's shape as a failure, not as an empty team", async () => {
    handle = (call) => (call.method === "GET" ? json({}) : undefined);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("개인 브레인 이전 상태를 불러오지 못했습니다.");
  });
});

describe("switching the mode", () => {
  it("to memory: explains what will happen, and 취소 changes nothing", async () => {
    await open();

    await click(radio(/메모리 서비스로 이전/));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());

    const request = get(confirmation)!;
    expect(request.title).toBe("메모리 서비스로 이전을 시작할까요?");
    expect(request.confirmLabel).toBe("이전 시작");
    expect(request.message).toContain("바로 이전을 시작합니다.");
    expect(request.message).toContain(
      "옮긴 노트는 하나씩 다시 읽어 저장소의 파일과 비교합니다. 한 사람의 노트가 모두 일치할 때만 그 사람을 전환하고, 하나라도 다르면 지금처럼 저장소에 그대로 둡니다.",
    );
    // The screen promises no database backup: none is taken before a move.
    expect(request.message).not.toContain("백업");
    expect(request.message).toContain("옮길 수 없는 팀원은 건너뛰고, 그 사유를 아래 표에 보여 줍니다.");
    expect(request.message).toContain("저장소의 파일은 지우지 않습니다.");

    await act(async () => resolveConfirmation(false));

    expect(posts()).toEqual([]);
    expect(radio(/저장소에 보관/).checked).toBe(true);
    expect(radio(/메모리 서비스로 이전/).checked).toBe(false);
  });

  it("to memory: after the confirmation it posts the mode once and follows the pass it started", async () => {
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/mode") return undefined;
      state = { ...state, mode: "memory", running: true };
      return json({ mode: "memory", started: true });
    };
    await open();

    await click(radio(/메모리 서비스로 이전/));
    await confirmWith(true);

    await waitFor(() => expect(radio(/메모리 서비스로 이전/).checked).toBe(true));
    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/mode", method: "POST", body: { mode: "memory" } }]);
    expect(status()).toBe("이전을 진행하고 있습니다… 표는 자동으로 새로 고칩니다.");
  });

  it("back to repo: says that nobody is rolled back", async () => {
    state = { ...state, mode: "memory" };
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/mode") return undefined;
      state = { ...state, mode: "repo" };
      return json({ mode: "repo", started: false });
    };
    await open();
    expect(radio(/메모리 서비스로 이전/).checked).toBe(true);

    await click(radio(/저장소에 보관/));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    const request = get(confirmation)!;
    expect(request.title).toBe("새로 옮기는 것을 멈출까요?");
    expect(request.message).toContain("아직 옮기지 않은 팀원을 더 이상 옮기지 않습니다.");
    expect(request.message).toContain("이미 옮긴 팀원은 되돌리지 않습니다.");
    expect(request.message).toContain("되돌리려면 아래 표에서 한 명씩 ‘되돌리기’를 눌러 주세요.");
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(radio(/저장소에 보관/).checked).toBe(true));
    expect(posts().map((call) => call.body)).toEqual([{ mode: "repo" }]);
    expect(status()).toBe("보관 방식을 바꿨습니다. 새로 옮기지 않습니다.");
    // The moved owner is still moved.
    expect(row("이두리").textContent).toContain("메모리 서비스");
  });

  it("shows a refused mode change and keeps the saved mode checked", async () => {
    handle = (call) => (call.url === "/api/admin/personal-vaults/mode" ? json({ error: NOT_CONFIGURED }, 409) : undefined);
    await open();

    await click(radio(/메모리 서비스로 이전/));
    await confirmWith(true);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(NOT_CONFIGURED));
    expect(radio(/저장소에 보관/).checked).toBe(true);
  });
});

describe("미리 확인 (dry run)", () => {
  const TOO_LARGE = "note_too_large: wiki/big.md is 600000 bytes (a note is at most 524288)";
  const UNKNOWN = "something the client has never heard of";

  it("shows per owner what would move, what stays in the repository and why an owner cannot be moved", async () => {
    handle = (call) =>
      call.url === "/api/admin/personal-vaults/dry-run"
        ? json({
            reports: [
              report({
                skipped: [
                  { path: "wiki/diagram.png", reason: "not_markdown: not a markdown note; it stays in the repository" },
                  { path: "wiki/.obsidian/app.md", reason: "dot_name: a folder or file name starts with a dot; it stays in the repository" },
                  { path: "raw/odd", reason: "a reason nobody translated" },
                ],
              }),
              report({ userId: "u3", repo: null, sourceCommit: null, notes: 0, bytes: 0, state: "no_repo" }),
              report({ userId: "u4", notes: 3, bytes: 900, blockers: ["uncommitted_changes: the clone has uncommitted changes (skills/a.md)", TOO_LARGE, "run_in_progress: a run is in progress for this owner", UNKNOWN] }),
            ],
          })
        : undefined;
    state = { ...state, owners: [...OWNERS, owner({ userId: "u4", username: "choi", displayName: "최네모", repo: "choi/kb" })] };
    await open();

    await click(button("미리 확인"));

    await waitFor(() => expect(status()).toBe("미리 확인을 마쳤습니다. 옮길 수 있는 팀원 1명, 아직 옮길 수 없는 팀원 1명. 아무것도 바뀌지 않았습니다."));
    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/dry-run", method: "POST", body: undefined }]);

    // The report sits in the row right under its owner.
    const detail = (name: string): HTMLElement => row(name).nextElementSibling as HTMLElement;
    const kim = detail("김하나");
    expect(kim.className).toBe("vault-report-row");
    expect(kim.textContent).toContain("옮길 노트 12개 · 19.5 KB");
    expect(within(kim).getByText("저장소에 그대로 남는 파일 3개")).toBeTruthy();
    expect([...kim.querySelectorAll("details li")].map((li) => li.textContent)).toEqual([
      "wiki/diagram.png — 마크다운(.md) 노트가 아닙니다",
      "wiki/.obsidian/app.md — 점(.)으로 시작하는 폴더나 파일 이름이 경로에 있습니다",
      "raw/odd — a reason nobody translated",
    ]);
    expect(kim.querySelector(".vault-report-blockers")).toBeNull();

    expect(detail("박세나").textContent).toBe("연결된 저장소가 없어 옮길 노트가 없습니다.");

    const choi = detail("최네모");
    expect(choi.textContent).toContain("옮길 노트 3개 · 900 B");
    expect(choi.querySelector(".vault-report-blockers strong")?.textContent).toBe("아직 옮길 수 없습니다.");
    expect([...choi.querySelectorAll(".vault-report-blockers li")].map((li) => li.textContent)).toEqual([
      "저장소에 커밋하지 않은 변경이 있습니다. 본인의 아바타가 커밋·푸시를 마친 뒤 다시 실행해 주세요. (상세: the clone has uncommitted changes (skills/a.md))",
      "512 KiB를 넘는 노트가 있습니다. 노트를 나누거나 줄인 뒤 다시 실행해 주세요. (상세: wiki/big.md is 600000 bytes (a note is at most 524288))",
      "이 팀원의 아바타가 지금 작업 중입니다. 작업이 끝난 뒤 다시 실행해 주세요.",
      UNKNOWN,
    ]);
    // An owner the dry run did not report keeps no report row.
    expect((row("이두리").nextElementSibling as HTMLElement).className).not.toBe("vault-report-row");
  });

  it("shows the report the server still holds for an owner (a finished cutover)", async () => {
    state = {
      ...state,
      owners: [owner({ userId: "u2", username: "lee", displayName: "이두리", state: "memory", mirror: mirror(), report: report({ userId: "u2", state: "memory", notes: 40, bytes: 3_500_000 }) })],
    };
    await open();
    expect((row("이두리").nextElementSibling as HTMLElement).textContent).toBe("옮긴 노트 40개 · 3.3 MB");
  });

  it("translates every known blocker and skip code, and passes unknown text through", () => {
    expect(vaultBlockerText("no_git_token: no git token is set for this repository's host, so the repository cannot be synced")).toBe(
      "Git 토큰이 없어 저장소를 최신으로 가져올 수 없습니다. 본인이 설정 ▸ 권한·연결에서 Git 토큰을 설정해야 합니다.",
    );
    expect(
      vaultBlockerText(
        "backup_failed: this server has been holding data-changing maintenance steps since its last start because a database backup failed (the server log has the reason); nobody is moved until that is fixed and the server is restarted",
      ),
    ).toBe(
      "이 서버는 마지막으로 시작한 뒤 데이터베이스 백업에 실패해서, 데이터를 바꾸는 관리 작업을 모두 멈춰 두고 있습니다(이유는 서버 로그에 있습니다). 원인을 고치고 서버를 다시 시작하기 전에는 아무도 옮기지 않습니다.",
    );
    expect(vaultBlockerText("note_conflict: wiki/a.md and wiki/á.md are one note path once normalized (NFC) and their content differs")).toBe(
      "저장소에 같은 노트 경로가 되는 파일이 둘 있고 내용이 다릅니다. 하나로 정리한 뒤 다시 실행해 주세요. (상세: wiki/a.md and wiki/á.md are one note path once normalized (NFC) and their content differs)",
    );
    expect(vaultBlockerText("service_note_conflict: the memory service already holds a different note at wiki/a.md")).toBe(
      "메모리 서비스에 같은 경로로 내용이 다른 노트가 남아 있습니다. 남은 사본을 비운 뒤 다시 실행해 주세요. (상세: the memory service already holds a different note at wiki/a.md)",
    );
    expect(vaultBlockerText("not_utf8: and 7 more of this kind")).toBe("UTF-8 텍스트가 아닌 노트가 있습니다. 파일을 고친 뒤 다시 실행해 주세요. (같은 사유 7건 더 있음)");
    expect(vaultBlockerText("memory_unavailable: the memory service could not be used (timeout)")).toBe("메모리 서비스에 연결하지 못했습니다. 잠시 후 다시 실행해 주세요.");
    expect(vaultBlockerText("vault_folder_link: wiki is a link in the repository, not a plain folder: the mirror could never write notes under it")).toBe(
      "저장소의 wiki/ 또는 raw/가 폴더가 아니라 링크(또는 파일)라서 옮길 수 없습니다. 옮긴 뒤 그 자리에 사본을 쓸 수 없기 때문입니다. 저장소에서 일반 폴더로 바꾼 뒤 다시 실행해 주세요. (상세: wiki is a link in the repository, not a plain folder: the mirror could never write notes under it)",
    );
    expect(
      vaultBlockerText("repo_changed: the connected repository or branch changed while this owner was being looked at; the new one is handled on its own"),
    ).toBe("살펴보는 동안 본인이 연결한 저장소나 브랜치를 바꿨습니다. 새로 연결한 저장소는 따로 처리되니 잠시 뒤 다시 확인해 주세요.");
    expect(vaultBlockerText("brand_new_code: whatever")).toBe("brand_new_code: whatever");
    expect(vaultSkippedReasonText("symlink: a symbolic link is never followed; it stays in the repository")).toBe("링크 파일입니다 (링크는 따라가지 않습니다)");
    expect(vaultSkippedReasonText("not_markdown: 12 more files that are not markdown notes stay in the repository")).toBe("마크다운(.md) 노트가 아닌 파일 12개가 더 있습니다");
    expect(vaultSkippedReasonText("unsupported path: the service cannot hold this path; it stays in the repository")).toBe("메모리 서비스가 담을 수 없는 경로입니다");
  });

  it("shows a dry run that failed on the server (the route refuses nothing: a failure is a 500)", async () => {
    handle = (call) => (call.url === "/api/admin/personal-vaults/dry-run" ? json({ error: "Internal server error" }, 500) : undefined);
    await open();

    await click(button("미리 확인"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."));
    // Nothing was reported, and the panel is usable again.
    expect(document.querySelector(".vault-report-row")).toBeNull();
    expect(button("미리 확인").disabled).toBe(false);
  });

  it("shows the notice of a moved owner under their row: what it is, that nothing was deleted, and the way to bring the notes in", async () => {
    state = {
      ...state,
      owners: [
        OWNERS[0],
        owner({ userId: "u2", username: "lee", displayName: "이두리", state: "memory", repo: "lee/notes", mirror: mirror({ syncedAt: "2026-11-17T03:20:00.000Z", notice: "repository notes not in the memory service: 4" }) }),
      ],
    };
    await open();

    const detail = row("이두리").nextElementSibling as HTMLElement;
    expect(detail.className).toBe("vault-report-row");
    expect(detail.querySelector(".vault-notice")?.textContent).toBe(
      "저장소 사본에 메모리 서비스에는 없는 노트가 4개 있습니다. 아무것도 지우지 않았습니다. 이 노트들은 이 팀원의 브레인에 들어 있지 않습니다. ‘되돌리기’를 한 뒤 다시 옮기면 저장소의 노트가 모두 브레인에 들어갑니다.",
    );
    // The copy itself is up to date, and the way out named in the notice is in the row.
    expect(row("이두리").querySelector('td[data-label="저장소 사본"]')?.textContent).toBe(`최신 · ${timeLabel("2026-11-17T03:20:00.000Z")}`);
    expect(button("이두리 되돌리기").disabled).toBe(false);
    expect((row("김하나").nextElementSibling as HTMLElement).className).not.toBe("vault-report-row");
  });
});

describe("이전 실행 and the running state", () => {
  const flush = (ms = 0): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("starts the pass, shows that it is running, follows it, and says when it ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state = { ...state, mode: "memory" };
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/run") return undefined;
      state = { ...state, running: true };
      return json({ started: true }, 202);
    };
    render(<AdminPersonalVaultPanel active={true} />);
    await flush();
    expect(button("이전 실행").disabled).toBe(false);

    fireEvent.click(button("이전 실행"));
    await flush();

    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/run", method: "POST", body: undefined }]);
    expect(status()).toBe("이전을 진행하고 있습니다… 표는 자동으로 새로 고칩니다.");
    expect(document.getElementById("admin-personal-vault-status")?.className).toBe("settings-save-status pending");
    expect(document.querySelector(".cmp-admin-personal-vault-panel")?.getAttribute("aria-busy")).toBe("true");
    // Nothing else can be started while it runs.
    expect(button("이전 중…").disabled).toBe(true);
    expect(button("미리 확인").disabled).toBe(true);
    expect(button("이두리 되돌리기").disabled).toBe(true);

    // It keeps reading while the pass runs…
    const before = reads();
    await flush(3000);
    expect(reads()).toBe(before + 1);
    expect(status()).toBe("이전을 진행하고 있습니다… 표는 자동으로 새로 고칩니다.");

    // …a read that fails does not stop it…
    handle = (call) => (call.method === "GET" ? json({ error: "잠시 연결이 끊겼습니다." }, 502) : undefined);
    await flush(3000);
    expect(reads()).toBe(before + 2);
    expect(screen.queryByRole("alert")).toBeNull();

    // …and the next one finds the pass finished, with the owner moved.
    handle = () => undefined;
    state = {
      ...state,
      running: false,
      owners: [owner({ state: "memory", migratedAt: "2026-11-17T05:00:00.000Z", mirror: mirror(), report: report({ state: "memory" }) }), ...OWNERS.slice(1)],
    };
    await flush(3000);

    expect(status()).toBe("이전 실행이 끝났습니다. 팀원별 결과는 아래 표에 있습니다.");
    expect(row("김하나").textContent).toContain("메모리 서비스");
    expect(button("이전 실행").disabled).toBe(false);
    // No more reads once it is over.
    const after = reads();
    await flush(10000);
    expect(reads()).toBe(after);
  });

  it("says so when a pass is already running", async () => {
    state = { ...state, mode: "memory" };
    handle = (call) => (call.url === "/api/admin/personal-vaults/run" ? json({ started: false }, 202) : undefined);
    await open();

    await click(button("이전 실행"));

    await waitFor(() => expect(status()).toBe("이미 이전이 진행 중입니다."));
  });

  it("opens on a pass that is already running", async () => {
    state = { ...state, mode: "memory", running: true };
    await open();
    expect(status()).toBe("이전을 진행하고 있습니다… 표는 자동으로 새로 고칩니다.");
    expect(button("이전 중…").disabled).toBe(true);
  });
});

describe("되돌리기 (per owner)", () => {
  it("states exactly what it does before anything is sent", async () => {
    state = { ...state, mode: "memory" };
    await open();

    await click(button("이두리 되돌리기"));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());

    const request = get(confirmation)!;
    expect(request.title).toBe("저장소 보관으로 되돌릴까요?");
    expect(request.confirmLabel).toBe("되돌리기");
    expect(request.tone).toBe("danger");
    expect(request.message).toBe(
      "이두리님의 브레인 노트를 저장소 보관으로 되돌립니다.\n" +
        "1. 먼저 저장소의 사본을 최신으로 맞춥니다. 맞추지 못하면 되돌리지 않고 이유를 알려 줍니다.\n" +
        "2. 그다음부터 이 팀원의 노트는 다시 저장소에서 읽고 씁니다.\n" +
        "3. 메모리 서비스에 있던 이 팀원의 노트는 지웁니다. 같은 내용이 모두 저장소에 있습니다.\n" +
        "보관 방식이 ‘메모리 서비스로 이전’인 동안에는 다음 이전 때 이 팀원이 다시 옮겨집니다.",
    );
    expect(posts()).toEqual([]);

    await act(async () => resolveConfirmation(false));
    expect(posts()).toEqual([]);
  });

  it("rolls the owner back after the confirmation and shows the new state", async () => {
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/u2/rollback") return undefined;
      state = { ...state, owners: [OWNERS[0], owner({ userId: "u2", username: "lee", displayName: "이두리", repo: "lee/notes" }), OWNERS[2]] };
      return json({ ok: true });
    };
    await open();

    await click(button("이두리 되돌리기"));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    // In `repo` mode nobody is moved again, so the extra line is not there.
    expect(get(confirmation)!.message).not.toContain("다시 옮겨집니다");
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(status()).toBe("이두리님의 브레인 노트를 저장소 보관으로 되돌렸습니다."));
    // `expect` tells the server which of the two actions this screen offered.
    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/u2/rollback", method: "POST", body: { expect: "memory" } }]);
    expect(row("이두리").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("저장소");
    expect(screen.queryByRole("button", { name: /되돌리기/ })).toBeNull();
  });

  it("offers to discard the service's leftover copy of an owner who is still on the repository", async () => {
    const LEFTOVER = "service_only_note: the memory service already holds wiki/old.md, which the repository does not have";
    state = { ...state, owners: [owner({ report: report({ blockers: [LEFTOVER] }) }), owner({ userId: "u9", username: "yoon", displayName: "윤아홉", report: report({ userId: "u9", blockers: ["run_in_progress: a run is in progress for this owner"] }) })] };
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/u1/rollback") return undefined;
      // The server drops the report that named the leftover; the table is read again after the press.
      state = { ...state, owners: (state.owners as ReturnType<typeof owner>[]).map((o) => (o.userId === "u1" ? { ...o, report: null } : o)) };
      return json({ ok: true });
    };
    await open();
    const readsBefore = reads();

    const detail = row("김하나").nextElementSibling as HTMLElement;
    expect(detail.textContent).toContain(
      "메모리 서비스에 저장소에는 없는 노트가 남아 있습니다. 남은 사본을 비운 뒤 다시 실행해 주세요. (상세: the memory service already holds wiki/old.md, which the repository does not have)",
    );
    // Only the blocker it resolves gets the button.
    expect(screen.getAllByRole("button", { name: /남은 사본 비우기/ })).toHaveLength(1);
    // The owner is not moved, so there is no 되돌리기 in the row itself.
    expect(row("김하나").querySelector("button")).toBeNull();

    await click(button("김하나 남은 사본 비우기"));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    const request = get(confirmation)!;
    expect(request.title).toBe("메모리 서비스에 남은 사본을 비울까요?");
    expect(request.tone).toBe("danger");
    expect(request.message).toContain("김하나님의 브레인 노트는 지금 저장소에 있고, 저장소의 노트는 바뀌지 않습니다.");
    expect(request.message).toContain(
      "그 사본에만 있거나 저장소와 내용이 다른 노트는 지우기 전에 서버에 따로 보관해 두므로 운영자가 복구할 수 있습니다.",
    );
    expect(posts()).toEqual([]);
    await act(async () => resolveConfirmation(true));

    await waitFor(() => expect(status()).toBe("김하나님의 메모리 서비스에 남은 사본을 비웠습니다. ‘미리 확인’으로 다시 확인해 주세요."));
    // `expect: "repo"`: this press may only clear a leftover, never roll back an owner who was moved meanwhile.
    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/u1/rollback", method: "POST", body: { expect: "repo" } }]);
    // The table came from the server again (not a local edit of the old one).
    expect(reads()).toBe(readsBefore + 1);
    // The report that named the leftover is gone; the other owner's stays.
    expect((row("김하나").nextElementSibling as HTMLElement).className).not.toBe("vault-report-row");
    expect((row("윤아홉").nextElementSibling as HTMLElement).className).toBe("vault-report-row");
  });

  it("keys the leftover button on the blocker CODE: both service codes get it, the repository's own conflict never does", async () => {
    const withBlocker = (userId: string, name: string, blocker: string) =>
      owner({ userId, username: userId, displayName: name, report: report({ userId, blockers: [blocker] }) });
    state = {
      ...state,
      owners: [
        withBlocker("s1", "서비스충돌", "service_note_conflict: the memory service already holds a different note at wiki/a.md"),
        withBlocker("s2", "서비스전용", "service_only_note: the memory service already holds wiki/x.md, which the repository does not have"),
        // The clone's own problem — the service holds nothing, whatever the sentence says.
        withBlocker("r1", "저장소충돌", "note_conflict: wiki/a.md and wiki/á.md are one note path once normalized (NFC) and their content differs"),
        withBlocker("r2", "옛문장", "note_conflict: the memory service already holds a different note at wiki/a.md"),
        // A moved owner is rolled back from the row, not from the report.
        owner({ userId: "m1", username: "m1", displayName: "옮긴이", state: "memory", mirror: mirror(), report: report({ userId: "m1", state: "memory", blockers: ["service_only_note: x"] }) }),
      ],
    };
    await open();

    expect(screen.getAllByRole("button", { name: /남은 사본 비우기/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "서비스충돌 남은 사본 비우기",
      "서비스전용 남은 사본 비우기",
    ]);
  });

  it("shows the refusal when a leftover note could not be set aside, and keeps the report", async () => {
    const REFUSAL = LEFTOVER_NOT_SAVED;
    state = { ...state, owners: [owner({ report: report({ blockers: ["service_only_note: the memory service already holds wiki/old.md, which the repository does not have"] }) })] };
    handle = (call) => (call.url === "/api/admin/personal-vaults/u1/rollback" ? json({ error: REFUSAL }, 409) : undefined);
    await open();

    await click(button("김하나 남은 사본 비우기"));
    await confirmWith(true);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(REFUSAL));
    // Nothing was deleted, so the blocker and its way out are still there.
    expect((row("김하나").nextElementSibling as HTMLElement).className).toBe("vault-report-row");
    expect(button("김하나 남은 사본 비우기").disabled).toBe(false);
  });

  it("says there is nowhere for a copy to go when a moved owner has no repository", async () => {
    state = { ...state, owners: [owner({ state: "memory", repo: null, migratedAt: "2026-11-16T01:00:00.000Z", mirror: mirror({ dirty: true }) })] };
    await open();
    expect(row("김하나").querySelector('td[data-label="저장소 사본"]')?.textContent).toBe("저장소 없음 · 사본을 올릴 곳이 없음");
  });

  it("after a 409 the table is read again: a screen that was out of date shows where the owner really is", async () => {
    // Another admin rolled this owner back meanwhile; this screen still offered 되돌리기.
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/u2/rollback") return undefined;
      state = { ...state, owners: [OWNERS[0], owner({ userId: "u2", username: "lee", displayName: "이두리", repo: "lee/notes" }), OWNERS[2]] };
      return json({ error: HOME_MISMATCH }, 409);
    };
    await open();
    const readsBefore = reads();

    await click(button("이두리 되돌리기"));
    await confirmWith(true);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(HOME_MISMATCH));
    expect(posts()).toEqual([{ url: "/api/admin/personal-vaults/u2/rollback", method: "POST", body: { expect: "memory" } }]);
    expect(reads()).toBe(readsBefore + 1);
    expect(row("이두리").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("저장소");
    expect(screen.queryByRole("button", { name: /되돌리기/ })).toBeNull();
  });

  it("a leftover clear refused because the owner was moved meanwhile rolls nobody back and shows the new table", async () => {
    const LEFTOVER = "service_only_note: the memory service already holds wiki/old.md, which the repository does not have";
    state = { ...state, owners: [owner({ report: report({ blockers: [LEFTOVER] }) })] };
    handle = (call) => {
      if (call.url !== "/api/admin/personal-vaults/u1/rollback") return undefined;
      state = { ...state, owners: [owner({ state: "memory", migratedAt: "2026-11-17T05:00:00.000Z", mirror: mirror(), report: report({ state: "memory" }) })] };
      return json({ error: HOME_MISMATCH }, 409);
    };
    await open();

    await click(button("김하나 남은 사본 비우기"));
    await confirmWith(true);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(HOME_MISMATCH));
    expect(posts().map((call) => call.body)).toEqual([{ expect: "repo" }]);
    expect(row("김하나").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("메모리 서비스");
    expect(screen.queryByRole("button", { name: /남은 사본 비우기/ })).toBeNull();
  });

  it("shows a 409 as the server phrased it and leaves the owner where they were", async () => {
    const REFUSAL = MIRROR_FAILED;
    handle = (call) => (call.url === "/api/admin/personal-vaults/u2/rollback" ? json({ error: REFUSAL }, 409) : undefined);
    await open();

    await click(button("이두리 되돌리기"));
    await confirmWith(true);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(REFUSAL));
    expect(row("이두리").querySelector('td[data-label="보관 위치"]')?.textContent).toBe("메모리 서비스");
    expect(button("이두리 되돌리기").disabled).toBe(false);
    expect(status()).toBe("옮긴 팀원 1명 / 저장소를 연결한 팀원 2명");
  });
});
