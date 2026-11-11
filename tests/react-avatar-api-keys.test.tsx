import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsAvatarApiKeys from "../src/client/src/components/SettingsAvatarApiKeys";

afterEach(() => vi.unstubAllGlobals());

it("issues a named key, refetches the list on tab re-entry, and revokes the key", async () => {
  const key = { id: "key-1", name: "모니터링", prefix: "noah_prefix", createdAt: "2026-09-06T00:00:00Z", lastUsedAt: null };
  // The server list is the source of truth: leaving the tab drops the one-time
  // secret AND the cached rows, so a re-entry must render a fresh GET (never a
  // previous account's keys).
  let stored: (typeof key)[] = [];
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "POST") stored = [key];
    if (options?.method === "DELETE") stored = [];
    return {
      ok: true, status: 200,
      json: async () => options?.method === "POST" ? { key, token: "noah_one_time_secret" } : options?.method === "DELETE" ? { ok: true } : { keys: stored },
    };
  });
  const listCalls = () => fetchMock.mock.calls.filter(([url, options]) => url === "/api/me/avatar-api-keys" && !options?.method).length;
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<SettingsAvatarApiKeys active />);
  await waitFor(() => expect(screen.getByText("발급된 API 키가 없습니다.")).toBeTruthy());
  expect(screen.getByRole("heading", { name: "외부 작업 API" }).tagName).toBe("H3");
  fireEvent.change(screen.getByLabelText("API 키 이름"), { target: { value: "모니터링" } });
  fireEvent.click(screen.getByRole("button", { name: "API 키 발급" }));
  await waitFor(() => expect((screen.getByLabelText("발급된 API 키") as HTMLInputElement).value).toBe("noah_one_time_secret"));
  expect(fetchMock.mock.calls.some(([, options]) => options?.body === '{"name":"모니터링"}')).toBe(true);
  const listedBefore = listCalls();
  view.rerender(<SettingsAvatarApiKeys active={false} />);
  view.rerender(<SettingsAvatarApiKeys active />);
  expect(screen.queryByLabelText("발급된 API 키")).toBeNull();
  await waitFor(() => expect(listCalls()).toBe(listedBefore + 1));
  await waitFor(() => expect(screen.getByRole("button", { name: "API 키 폐기: 모니터링" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "API 키 폐기: 모니터링" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "API 키 폐기: 모니터링" })).toBeNull());
  expect(fetchMock.mock.calls.some(([url, options]) => url === "/api/me/avatar-api-keys/key-1" && options?.method === "DELETE")).toBe(true);
});
