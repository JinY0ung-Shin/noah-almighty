import { get } from "../src/client/src/lib/store.js";
import { describe, expect, it } from "vitest";

import { confirmAction, confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";

describe("app confirmation queue", () => {
  it("uses specific destructive copy and resolves the owner choice", async () => {
    const result = confirmAction("Preview 계정을 삭제할까요? 되돌릴 수 없습니다.");
    expect(get(confirmation)).toMatchObject({
      title: "계정을 삭제할까요?",
      confirmLabel: "삭제",
      tone: "danger",
    });

    resolveConfirmation(true);
    await expect(result).resolves.toBe(true);
    expect(get(confirmation)).toBeNull();
  });

  it("serializes simultaneous requests instead of replacing an open dialog", async () => {
    const first = confirmAction("첫 번째 변경을 계속할까요?");
    const firstId = get(confirmation)?.id;
    const second = confirmAction("지식 저장소 연결을 해제할까요?");
    expect(get(confirmation)?.id).toBe(firstId);

    resolveConfirmation(false);
    await expect(first).resolves.toBe(false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(get(confirmation)).toMatchObject({ title: "연결을 해제할까요?", confirmLabel: "연결 해제" });

    resolveConfirmation(true);
    await expect(second).resolves.toBe(true);
    expect(get(confirmation)).toBeNull();
  });
});
