// 관리자 ▸ 시스템 ▸ 개인 브레인 사용량 (`AdminPersonalVaultPanel`), against a
// mocked GET /api/admin/personal-vaults/usage. Pinned: per owner the note
// count, the size and the share of the service's limit — counts only; an owner
// whose wiki could not be listed says why; a server without the memory service
// says so; the panel is read-only (ONE route, GET, and the only button reads
// again); nothing of the retired migration screen (mode, dry run, pass,
// rollback, leftover clearing, copy state) is left; the retired audit ids keep
// their labels.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminPersonalVaultPanel from "../src/client/src/components/AdminPersonalVaultPanel";
import { readAdminVaultUsage, vaultUsagePercent } from "../src/client/src/lib/personalVault";
import adminViewSource from "../src/client/src/views/AdminView.tsx?raw";

interface Call {
  url: string;
  method: string;
}

const USERS = [
  { id: "u1", username: "kim", displayName: "김하나" },
  { id: "u2", username: "lee", displayName: "이두리" },
  { id: "u3", username: "park", displayName: "" },
];
const LIMITS = { notes: 10_000, bytes: 256 * 1024 * 1024 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let calls: Call[] = [];
/** What GET /api/admin/personal-vaults/usage answers now; a function is called per request. */
let usage: unknown | (() => Response | Promise<Response>) = {};

const reads = (): number => calls.filter((call) => call.url === "/api/admin/personal-vaults/usage").length;
const click = (element: Element): Promise<void> => act(async () => void fireEvent.click(element));
const status = (): string => document.getElementById("admin-personal-vault-status")?.textContent || "";
const row = (name: string): HTMLElement => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;
const cells = (name: string): (string | null)[] => [...row(name).querySelectorAll("td")].map((td) => td.textContent);

async function open(): Promise<void> {
  render(<AdminPersonalVaultPanel active={true} users={USERS} />);
  await waitFor(() => expect(reads()).toBeGreaterThan(0));
  await act(async () => {});
}

beforeEach(() => {
  calls = [];
  usage = { serviceConfigured: true, limits: LIMITS, owners: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call: Call = { url: String(input), method: String(init?.method || "GET").toUpperCase() };
      calls.push(call);
      if (call.url === "/api/admin/personal-vaults/usage" && call.method === "GET") {
        return typeof usage === "function" ? (usage as () => Response | Promise<Response>)() : json(usage);
      }
      return json({ error: "Not found" }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("how full each owner's brain is", () => {
  it("shows the count, the size and the share of the service's limit — counts only, one row per owner", async () => {
    usage = {
      serviceConfigured: true,
      limits: LIMITS,
      owners: [
        { userId: "u1", notes: 1234, bytes: 3_500_000 },
        { userId: "u2", notes: 0, bytes: 0 },
      ],
    };
    await open();

    expect(screen.getByRole("heading", { name: "개인 브레인 사용량" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "팀원별 개인 브레인 사용량" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["팀원", "노트", "크기", "한도 대비"]);
    expect(row("김하나").querySelector("th")?.textContent).toBe("김하나 @kim");
    expect(cells("김하나")).toEqual(["1,234개", "3.3 MB", "12%"]);
    // An owner who has written nothing yet is a row of zeros, not a failure.
    expect(cells("이두리")).toEqual(["0개", "0 B", "0%"]);
    expect(document.querySelector(".vault-admin-limits")?.textContent).toBe(
      "한 사람의 한도는 노트 10,000개 · 256.0 MB입니다. 둘 중 하나라도 넘으면 메모리 서비스가 새 노트의 저장을 거절합니다.",
    );
    expect(status()).toBe("지식 저장소를 연결한 팀원 2명");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a small brain reads 1% 미만, not 0%", async () => {
    usage = { serviceConfigured: true, limits: LIMITS, owners: [{ userId: "u2", notes: 6, bytes: 1300 }] };
    await open();
    expect(cells("이두리")).toEqual(["6개", "1.3 KB", "1% 미만"]);
  });

  it("near the limit (by notes OR by size) it is marked and says what happens next", async () => {
    usage = {
      serviceConfigured: true,
      limits: LIMITS,
      owners: [
        { userId: "u1", notes: 8_500, bytes: 1000 },
        { userId: "u2", notes: 3, bytes: 240 * 1024 * 1024 },
        { userId: "u3", notes: 7_999, bytes: 1000 },
      ],
    };
    await open();
    expect(cells("김하나")).toEqual(["8,500개", "1000 B", "85% — 한도에 가까워 곧 저장을 거절할 수 있습니다"]);
    expect(row("김하나").querySelector(".vault-cell-near")).toBeTruthy();
    expect(cells("이두리")[2]).toBe("93% — 한도에 가까워 곧 저장을 거절할 수 있습니다");
    // 79 %: not yet.
    expect(cells("park")).toEqual(["7,999개", "1000 B", "79%"]);
    expect(row("park").querySelector(".vault-cell-near")).toBeNull();
    expect(status()).toBe("지식 저장소를 연결한 팀원 3명 · 한도에 가까운 팀원 2명");
    expect(vaultUsagePercent({ notes: 8_000, bytes: 0 }, LIMITS)).toBe(80);
  });

  it("an owner whose brain could not be listed says why, in its own words per reason; the others are still shown", async () => {
    usage = {
      serviceConfigured: true,
      limits: LIMITS,
      owners: [
        { userId: "u1", error: "unavailable" },
        { userId: "u2", error: "refused" },
        { userId: "u3", error: "timeout" },
        { userId: "u4", notes: 2, bytes: 2048 },
      ],
    };
    await open();
    expect(cells("김하나")).toEqual(["메모리 서비스에 연결하지 못했습니다"]);
    expect(cells("이두리")).toEqual(["메모리 서비스가 거절했습니다"]);
    expect(cells("park")).toEqual(["메모리 서비스가 제때 응답하지 않았습니다"]);
    expect(row("김하나").querySelector(".vault-cell-failed")).toBeTruthy();
    // An account the admin view's list does not know (yet) is shown by its id.
    expect(cells("u4")).toEqual(["2개", "2.0 KB", "1% 미만"]);
    expect(status()).toBe("지식 저장소를 연결한 팀원 4명 · 확인하지 못한 팀원 3명");
    expect(document.body.textContent).not.toMatch(/pi-gateway/i);
  });

  it("an owner without a display name is shown by username, once", async () => {
    usage = { serviceConfigured: true, limits: LIMITS, owners: [{ userId: "u3", notes: 1, bytes: 10 }] };
    await open();
    expect(row("park").querySelector("th")?.textContent?.trim()).toBe("park");
  });

  it("nobody has connected a repository yet: says so instead of an empty table", async () => {
    await open();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".empty-note")?.textContent).toBe("지식 저장소를 연결한 팀원이 아직 없습니다.");
    expect(status()).toBe("지식 저장소를 연결한 팀원 0명");
  });
});

describe("a server without the memory service", () => {
  it("says the brains cannot be read or written and what the operator has to set — no table, no limits line", async () => {
    usage = { serviceConfigured: false, limits: LIMITS, owners: [] };
    await open();

    expect(screen.getByRole("heading", { name: "개인 브레인 사용량" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 팀원의 브레인 노트는 서비스가 설정될 때까지 읽을 수도 쓸 수도 없습니다. 서버 환경 변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 설정하고 다시 배포해 주세요.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".vault-admin-limits")).toBeNull();
    expect(document.querySelector(".empty-note")).toBeNull();
    expect(status()).toBe("");
    // It does not claim the notes are somewhere else.
    expect(document.body.textContent).not.toContain("지식 저장소에 있습니다");
  });
});

describe("reading", () => {
  it("renders nothing while its tab is not the active one, reads only when it is, and keeps what it read across a tab switch", async () => {
    usage = { serviceConfigured: true, limits: LIMITS, owners: [{ userId: "u1", notes: 5, bytes: 500 }] };
    const view = render(<AdminPersonalVaultPanel active={false} users={USERS} />);
    expect(view.container.innerHTML).toBe("");
    expect(calls).toEqual([]);

    view.rerender(<AdminPersonalVaultPanel active={true} users={USERS} />);
    expect(await screen.findByRole("table", { name: "팀원별 개인 브레인 사용량" })).toBeTruthy();
    expect(reads()).toBe(1);

    view.rerender(<AdminPersonalVaultPanel active={false} users={USERS} />);
    view.rerender(<AdminPersonalVaultPanel active={true} users={USERS} />);
    expect(cells("김하나")[0]).toBe("5개");
    expect(reads()).toBe(1);
  });

  it("says it is loading from the first paint", async () => {
    usage = () => new Promise<Response>(() => {});
    render(<AdminPersonalVaultPanel active={true} users={USERS} />);
    expect(status()).toBe("불러오는 중…");
    expect(document.querySelector(".cmp-admin-personal-vault-panel")?.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "새로 고침" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a load failure and loads again from 새로 고침", async () => {
    usage = () => json({ error: "Internal server error" }, 500);
    await open();
    // (`api` words a bare 500 for people.)
    expect(screen.getByRole("alert").textContent).toBe("개인 브레인 사용량을 불러오지 못했습니다: 서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    expect(screen.queryByRole("table")).toBeNull();

    usage = { serviceConfigured: true, limits: LIMITS, owners: [{ userId: "u1", notes: 5, bytes: 500 }] };
    await click(screen.getByRole("button", { name: "새로 고침" }));
    await waitFor(() => expect(cells("김하나")[0]).toBe("5개"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reads()).toBe(2);
  });

  it("a later read that fails keeps the table that was read before, with the failure above it", async () => {
    usage = { serviceConfigured: true, limits: LIMITS, owners: [{ userId: "u1", notes: 5, bytes: 500 }] };
    await open();
    usage = () => json({ error: "Internal server error" }, 500);
    await click(screen.getByRole("button", { name: "새로 고침" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("불러오지 못했습니다"));
    expect(cells("김하나")[0]).toBe("5개");
  });

  it("treats an answer without the route's shape as a failure, not as an empty team", async () => {
    usage = { nonsense: true };
    await open();
    expect(screen.getByRole("alert").textContent).toBe("개인 브레인 사용량을 불러오지 못했습니다: 서버의 응답을 읽을 수 없습니다.");
    expect(document.querySelector(".empty-note")).toBeNull();

    expect(readAdminVaultUsage({ serviceConfigured: true, limits: { notes: 0, bytes: 1 }, owners: [] })).toBeNull();
    // A malformed owner entry is dropped; the others are kept.
    expect(
      readAdminVaultUsage({ serviceConfigured: true, limits: LIMITS, owners: [null, { userId: 3 }, { userId: "u1", notes: 1, bytes: 2 }] })?.owners,
    ).toEqual([{ userId: "u1", notes: 1, bytes: 2 }]);
  });
});

describe("what is gone with the migration", () => {
  it("is read-only: ONE route, GET only, and the only button reads again", async () => {
    usage = {
      serviceConfigured: true,
      limits: LIMITS,
      owners: [
        { userId: "u1", notes: 9_900, bytes: 1000 },
        { userId: "u2", error: "refused" },
      ],
    };
    await open();

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["새로 고침"]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    for (const gone of ["이전", "미리 확인", "되돌리기", "남은 사본", "저장소 사본", "보관 방식", "보관 위치", "옮긴"]) {
      expect(document.querySelector(".cmp-admin-personal-vault-panel")!.textContent).not.toContain(gone);
    }

    await click(screen.getByRole("button", { name: "새로 고침" }));
    await waitFor(() => expect(reads()).toBe(2));
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/admin/personal-vaults/usage",
      "GET /api/admin/personal-vaults/usage",
    ]);
    cleanup();
  });

  it("the audit log still names the retired actions, so old rows stay readable", () => {
    for (const [id, label] of [
      ["set_personal_vault_mode", "개인 브레인 보관 방식 변경"],
      ["personal_vault_run", "개인 브레인 이전 실행"],
      ["personal_vault_rollback", "개인 브레인 되돌리기"],
      ["personal_vault_mirror_confirm", "개인 브레인 저장소 사본 확인"],
    ]) {
      expect(adminViewSource).toContain(`${id}: "${label}"`);
    }
    // The 시스템 tab mounts the usage panel with the team's names.
    expect(adminViewSource).toContain('<AdminPersonalVaultPanel active={state.adminTab === "system"} users={state.adminUsers} />');
  });
});
