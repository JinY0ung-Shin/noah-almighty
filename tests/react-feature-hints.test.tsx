// FeatureHintLayer (#feature-hints): the bubble at a new feature's own control.
// jsdom lays nothing out, so each control is given a box by hand; where the
// bubble lands on a real screen is checked in a browser, not here.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FeatureHintLayer from "../src/client/src/components/FeatureHintLayer";
import { featureHintAnchor } from "../src/client/src/lib/featureHints";
import type { User } from "../src/client/src/lib/types";
import { FEATURE_HINTS, type FeatureHintAnchor } from "../src/server/releaseNotes";

const baseUser = {
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
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: "2026-08-01T00:00:00.000Z",
  lastSeenRelease: null,
  seenFeatureHints: [],
} satisfies User;

const hintFor = (anchor: FeatureHintAnchor) => FEATURE_HINTS.find((hint) => hint.anchor === anchor)!;
const attach = hintFor("composer-attach");
const teamBrain = hintFor("nav-teamBrain");
const brain = hintFor("nav-brain");

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

const unmarks: Array<() => void> = [];

/** A control on the page, marked as the anchor, with a box jsdom would not give it. */
function control(anchor: FeatureHintAnchor, label: string, box = rect(100, 300, 40, 40), parent: HTMLElement = document.body): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.getBoundingClientRect = () => box;
  parent.appendChild(element);
  const unmark = featureHintAnchor(anchor)(element) as (() => void) | void;
  unmarks.push(() => {
    unmark?.();
    element.remove();
  });
  return element;
}

let fetchMock: ReturnType<typeof vi.fn>;

function seenPosts(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/me/feature-hints/seen")
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { id: string }).id);
}

const bubbleTitle = () => document.querySelector(".feature-hint-title")?.textContent ?? null;
// The first look comes a moment after the list changes (FIRST_SCAN_MS).
const SOON = { timeout: 3000 };

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: baseUser }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const unmark of unmarks.splice(0)) unmark();
  vi.unstubAllGlobals();
});

describe("FeatureHintLayer", () => {
  it("registry: the three 2026-11-12 hints are in force", () => {
    expect(attach && teamBrain && brain).toBeTruthy();
  });

  it("shows the first pending hint whose control is on screen, placed and ringed", async () => {
    // Only the + button is on this screen: the two rail hints come first in the
    // registry but have nothing to point at.
    control("composer-attach", "+");
    render(<FeatureHintLayer user={baseUser} />);
    expect(document.querySelector(".feature-hint")).toBeNull();

    await waitFor(() => expect(bubbleTitle()).toBe(attach.title), SOON);
    expect(screen.getByText(attach.body)).toBeTruthy();
    // The small print: which files, how many, how large.
    expect(attach.details.length).toBeGreaterThan(0);
    const small = [...document.querySelectorAll(".feature-hint-details li")].map((line) => line.textContent);
    expect(small).toEqual(attach.details);
    expect(screen.getByText("새 기능")).toBeTruthy();
    const layer = document.querySelector<HTMLElement>(".feature-hint-layer")!;
    await waitFor(() => expect(layer.hasAttribute("data-placed")).toBe(true));
    const bubble = document.querySelector<HTMLElement>(".feature-hint")!;
    expect(bubble.dataset.hint).toBe(attach.id);
    expect(bubble.dataset.side).toBeDefined();
    // The ring is the control's box, a little larger.
    const ring = document.querySelector<HTMLElement>(".feature-hint-ring")!;
    expect(ring.style.width).toBe("48px");
    expect(ring.style.height).toBe("48px");
    expect(ring.style.transform).toBe("translate3d(96px, 296px, 0)");
    expect(seenPosts()).toEqual([]);
  });

  it("알겠어요 records the hint once, closes it, and offers the next one", async () => {
    control("nav-teamBrain", "팀 브레인", rect(12, 238, 255, 40));
    control("nav-brain", "내 브레인", rect(12, 196, 255, 40));
    render(<FeatureHintLayer user={baseUser} />);

    // Registry order, not screen order — every hint whose control is here, one at a
    // time. A control may be the home of more than one (팀 브레인: a newer
    // release's hint, then the older one's).
    const offered = FEATURE_HINTS.filter((hint) => hint.anchor === "nav-teamBrain" || hint.anchor === "nav-brain");
    expect(offered[0]).toBe(teamBrain);
    expect(offered.at(-1)).toBe(brain);
    const recorded: string[] = [];
    for (const hint of offered) {
      await waitFor(() => expect(document.querySelector<HTMLElement>(".feature-hint")?.dataset.hint).toBe(hint.id), SOON);
      expect(bubbleTitle()).toBe(hint.title);
      if (hint === teamBrain) {
        // A hint without small print draws no empty list.
        expect(teamBrain.details).toEqual([]);
        expect(document.querySelector(".feature-hint-details")).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "알겠어요" }));
      expect(document.querySelector(".feature-hint")).toBeNull();
      recorded.push(hint.id);
      expect(seenPosts()).toEqual(recorded);
    }
    // Nothing left that has a control here.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(document.querySelector(".feature-hint")).toBeNull();
  });

  it("using the control itself counts as seen — recorded once even for a label's double click", async () => {
    const button = control("composer-attach", "+");
    const inner = document.createElement("span");
    button.appendChild(inner);
    render(<FeatureHintLayer user={baseUser} />);
    await waitFor(() => expect(bubbleTitle()).toBe(attach.title), SOON);

    // A click somewhere else changes nothing.
    fireEvent.click(document.body);
    expect(bubbleTitle()).toBe(attach.title);

    fireEvent.click(inner);
    fireEvent.click(button);
    expect(document.querySelector(".feature-hint")).toBeNull();
    expect(seenPosts()).toEqual([attach.id]);
  });

  it("offers nothing the account already dismissed, and nothing without a seen list", async () => {
    control("composer-attach", "+");
    control("nav-brain", "내 브레인");
    const { rerender } = render(<FeatureHintLayer user={{ ...baseUser, seenFeatureHints: [attach.id, teamBrain.id] }} />);
    await waitFor(() => expect(bubbleTitle()).toBe(brain.title), SOON);

    // A server from before the feature sends no list at all: no bubbles, rather
    // than bubbles nothing could ever record as dismissed.
    const legacy = { ...baseUser } as Partial<User>;
    delete legacy.seenFeatureHints;
    rerender(<FeatureHintLayer user={legacy as User} />);
    expect(document.querySelector(".feature-hint")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(document.querySelector(".feature-hint")).toBeNull();
  });

  it("waits while a first-run dialog is up, and for a control it cannot point at", async () => {
    const inertHost = document.createElement("div");
    inertHost.setAttribute("inert", "");
    document.body.appendChild(inertHost);
    unmarks.push(() => inertHost.remove());
    control("nav-teamBrain", "팀 브레인", undefined, inertHost);
    const button = control("composer-attach", "+");

    const { rerender } = render(<FeatureHintLayer user={baseUser} blocked />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(document.querySelector(".feature-hint")).toBeNull();

    // The dialog closes: the rail item is still behind something inert, so the
    // + button's hint is the one that can be shown.
    rerender(<FeatureHintLayer user={baseUser} />);
    await waitFor(() => expect(bubbleTitle()).toBe(attach.title), SOON);

    // The control stops being usable (the answer is streaming): the bubble
    // steps aside without being recorded, and comes back afterwards.
    button.classList.add("disabled");
    await waitFor(() => expect(document.querySelector(".feature-hint")).toBeNull(), SOON);
    expect(seenPosts()).toEqual([]);
    button.classList.remove("disabled");
    await waitFor(() => expect(bubbleTitle()).toBe(attach.title), SOON);

    // The component withdraws the anchor (slash menu open): same.
    unmarks.pop()!();
    await waitFor(() => expect(document.querySelector(".feature-hint")).toBeNull(), SOON);
    expect(seenPosts()).toEqual([]);
  });
});
