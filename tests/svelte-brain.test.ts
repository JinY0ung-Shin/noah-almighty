import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BrainView from "../src/client/src/views/BrainView.svelte";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import type { User } from "../src/client/src/lib/types.js";

const user = {
  id: "owner-1",
  username: "owner",
  displayName: "Owner",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "private",
  roles: [],
  pluginCount: 0,
  gitTokenSet: false,
  gitIdentityName: null,
  gitIdentityEmail: null,
  knowledgeRepo: null,
  knowledgeBranch: null,
  knowledgeSelected: null,
  modelDefault: null,
  effortDefault: null,
  mcpToolGroupsDefault: null,
  allowedMcpToolGroups: null,
  secretNames: [],
  shellExposedSecretNames: [],
  browserSecrets: [],
  sshPublicKey: null,
  groups: [],
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
} satisfies User;

beforeEach(() => {
  replaceState({ user, view: "brain", settingsTab: "profile" });
});

describe("BrainView empty setup state", () => {
  it("does not request a missing repository and routes the CTA to knowledge settings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(BrainView);

    expect(screen.getByRole("heading", { name: "연결된 지식 저장소가 없습니다" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "새로고침" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "지식 저장소 설정" }));
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("knowledge");
  });
});
