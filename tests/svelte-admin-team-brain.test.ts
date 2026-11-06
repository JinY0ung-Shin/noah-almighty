// 관리자 → 팀 브레인 panel: after the schema migration every old note is a raw
// source, so the panel must show the raw / uncompiled counts and point at the
// curate pass — not just a wiki page count of 0.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdminTeamBrainPanel from "../src/client/src/components/AdminTeamBrainPanel.svelte";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { get } from "svelte/store";

const backup = { url: "team/brain", branch: "main", adminName: "admin", lastOkAt: null, lastError: null, lastAttemptAt: null };

function serve(payload: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ pendingReview: 0, backup, githubHost: "git.example", ...payload }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const HINT = "아바타에게 '팀 브레인 정리(team-brain-curate)'를 요청하면 미편찬 원본을 위키로 편찬합니다.";

describe("AdminTeamBrainPanel counts", () => {
  it("shows raw and uncompiled sources with the curate hint, and keeps restore disabled for a non-empty vault", async () => {
    serve({ noteCount: 0, rawSources: 12, uncompiledSources: 12 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("위키 페이지")).toBeTruthy();
    expect(screen.getByText("원본")).toBeTruthy();
    expect(screen.getByText("미편찬 12건")).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect((screen.getByRole("button", { name: "백업에서 복원" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the hint once everything is compiled", async () => {
    serve({ noteCount: 8, rawSources: 5, uncompiledSources: 0 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("미편찬 0건")).toBeTruthy();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("enables restore only for an empty vault", async () => {
    serve({ noteCount: 0, rawSources: 0, uncompiledSources: 0 });
    render(AdminTeamBrainPanel, { props: { active: true } });

    expect(await screen.findByText("미편찬 0건")).toBeTruthy();
    expect((screen.getByRole("button", { name: "백업에서 복원" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports the migrated counts after a restore (the restore reply has no raw counts)", async () => {
    let restored = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/admin/team-brain/backup/restore") {
        expect(init?.method).toBe("POST");
        restored = true;
        return new Response(JSON.stringify({ backup, noteCount: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const counts = restored ? { noteCount: 0, rawSources: 7, uncompiledSources: 7 } : { noteCount: 0, rawSources: 0, uncompiledSources: 0 };
      return new Response(JSON.stringify({ pendingReview: 0, backup, githubHost: "git.example", ...counts }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    render(AdminTeamBrainPanel, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "백업에서 복원" }));
    await waitFor(() => expect(get(confirmation)).toBeTruthy());
    resolveConfirmation(true);

    expect(await screen.findByText("복원했습니다. 위키 페이지 0개 · 원본 7건 (미편찬 7건)")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("미편찬 7건")).toBeTruthy());
    expect(screen.getByText(HINT)).toBeTruthy();
  });
});
