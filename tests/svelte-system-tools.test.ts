// 관리자 ▸ 도구·스킬 ▸ MCP 도구 정책 (AdminToolPolicyPanel) — the ONE
// deployment-wide MCP tool policy that replaced the per-group editor when
// groups were retired. The `system` group is mandatory in every policy.
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminToolPolicyPanel from "../src/client/src/components/AdminToolPolicyPanel.svelte";
import { replaceState } from "../src/client/src/lib/state.js";

type Call = { url: string; method: string; body: string | null };

function mockPolicy(initial: string[] | null): { calls: Call[] } {
  const calls: Call[] = [];
  let policy = initial;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ url, method, body });
      const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value }) as Response;
      if (url === "/api/admin/tool-policy" && method === "PUT") {
        const next = JSON.parse(body!).allowedMcpToolGroups as string[] | null;
        policy = next === null ? null : next.includes("system") ? next : [...next, "system"];
        return json({ allowedMcpToolGroups: policy });
      }
      if (url === "/api/admin/tool-policy") return json({ allowedMcpToolGroups: policy });
      if (url === "/api/me") return json({ user: { id: "admin-1", allowedMcpToolGroups: policy } });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  );
  return { calls };
}

describe("AdminToolPolicyPanel (global MCP tool policy)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    replaceState({ user: { id: "admin-1", roles: ["admin"] } as never });
  });

  it("does not fetch until its tab is active", async () => {
    const { calls } = mockPolicy(null);
    const view = render(AdminToolPolicyPanel, { props: { active: false } });
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(view.container.textContent).toBe("");
  });

  it("shows an empty policy as system-only without making the form dirty, then saves an allowlist", async () => {
    const { calls } = mockPolicy([]);
    const view = render(AdminToolPolicyPanel, { props: { active: true } });
    const system = (await view.findByRole("checkbox", { name: /시스템 · 항상 사용/ })) as HTMLInputElement;
    expect(system.checked).toBe(true);
    expect(system.disabled).toBe(true);
    const save = view.getByRole("button", { name: "정책 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(view.getByText(/선택 가능한 도구 묶음이 모두 차단됩니다/)).toBeTruthy();

    await fireEvent.click(view.getByRole("checkbox", { name: /^캔버스/ }));
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => {
      const write = calls.find((c) => c.method === "PUT");
      expect(write?.url).toBe("/api/admin/tool-policy");
      expect(JSON.parse(write!.body!)).toEqual({ allowedMcpToolGroups: ["canvas", "system"] });
    });
    await waitFor(() => expect(view.getByText("허용 2/8 — 저장됨")).toBeTruthy());
    expect(save.disabled).toBe(true);
    // The admin's own composer reads the policy from /api/me.
    await waitFor(() => expect(calls.some((c) => c.url === "/api/me")).toBe(true));
  });

  it("starts unrestricted and clears a saved policy with null", async () => {
    const { calls } = mockPolicy(["canvas", "system"]);
    const view = render(AdminToolPolicyPanel, { props: { active: true } });
    const toggle = (await view.findByRole("checkbox", { name: /MCP 도구 묶음 제한 사용/ })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await fireEvent.click(toggle);
    expect(view.queryByRole("group", { name: "허용할 MCP 도구 묶음" })).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "정책 저장" }));
    await waitFor(() => {
      const write = calls.find((c) => c.method === "PUT");
      expect(JSON.parse(write!.body!)).toEqual({ allowedMcpToolGroups: null });
    });
    await waitFor(() => expect(view.getByText(/제한 없음 — 모든 팀원이/)).toBeTruthy());
  });

  it("surfaces a load failure with a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as Response),
    );
    const view = render(AdminToolPolicyPanel, { props: { active: true } });
    await view.findByText(/도구 정책을 불러오지 못했습니다/);
    expect(view.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
