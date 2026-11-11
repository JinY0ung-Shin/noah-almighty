// React component tests — run in the vitest "react" project (jsdom +
// @vitejs/plugin-react + @testing-library/react; see vitest.config.ts). New
// component tests must be named tests/react-*.test.tsx: that glob routes them
// to this project, and to tsconfig.client.json for typechecking.
//
// This file covers the plumbing every ported component stands on (the store,
// the hooks, <Presence>) and the shared leaf components.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ConfirmationDialog from "../src/client/src/components/ConfirmationDialog";
import Modal from "../src/client/src/components/Modal";
import RevealableInput from "../src/client/src/components/RevealableInput";
import Toasts from "../src/client/src/components/Toasts";
import Toggle from "../src/client/src/components/Toggle";
import { confirmAction } from "../src/client/src/lib/confirm";
import { useAction, useAppState, useStore, useStoreVersion } from "../src/client/src/lib/hooks";
import { Presence, Transition, useTransition } from "../src/client/src/lib/presence";
import { appState, readState, toasts, updateState } from "../src/client/src/lib/state";
import { get, writable } from "../src/client/src/lib/store";
import { fade } from "../src/client/src/lib/transition";
import type { Toast } from "../src/client/src/lib/types";

/* ------------------------------------------------------------------ */
/* lib/store — the contract lib/state.ts and every store module use    */
/* ------------------------------------------------------------------ */

describe("store", () => {
  it("hands a subscriber the current value at once, then every change", () => {
    const store = writable(1);
    const seen: number[] = [];
    const stop = store.subscribe((value) => seen.push(value));
    store.set(2);
    store.set(2); // an unchanged primitive is not published
    store.update((value) => value + 1);
    stop();
    store.set(9);
    expect(seen).toEqual([1, 2, 3]);
    expect(get(store)).toBe(9);
  });

  it("publishes an object again even when it is the same reference", () => {
    const value = { n: 0 };
    const store = writable(value);
    let calls = 0;
    store.subscribe(() => (calls += 1));
    value.n = 1;
    store.set(value);
    expect(calls).toBe(2);
  });

  it("delivers a set made inside a subscriber after the notification in progress", () => {
    const store = writable(0);
    const order: string[] = [];
    store.subscribe((value) => {
      order.push(`a${value}`);
      if (value === 1) store.set(2);
    });
    store.subscribe((value) => order.push(`b${value}`));
    store.set(1);
    // b sees 1 before anyone sees 2.
    expect(order).toEqual(["a0", "b0", "a1", "b1", "a2", "b2"]);
  });
});

/* ------------------------------------------------------------------ */
/* lib/hooks — reading stores, attaching actions                       */
/* ------------------------------------------------------------------ */

describe("useAppState", () => {
  it("re-renders on a state change that was made IN PLACE", async () => {
    function Probe() {
      const state = useAppState();
      const version = useStoreVersion(appState);
      return <output data-version={version}>{state.exploreQuery}</output>;
    }
    updateState((state) => (state.exploreQuery = "처음"));
    render(<Probe />);
    const before = Number(screen.getByRole("status").dataset.version);
    expect(screen.getByRole("status").textContent).toBe("처음");

    await act(async () => updateState((state) => (state.exploreQuery = "다음")));

    expect(screen.getByRole("status").textContent).toBe("다음");
    expect(Number(screen.getByRole("status").dataset.version)).toBeGreaterThan(before);
    expect(readState().exploreQuery).toBe("다음");
  });

  it("reads any store through useStore", async () => {
    const store = writable("a");
    function Probe() {
      return <output>{useStore(store)}</output>;
    }
    render(<Probe />);
    await act(async () => store.set("b"));
    expect(screen.getByRole("status").textContent).toBe("b");
  });
});

describe("useAction", () => {
  it("runs the action on mount, update() on a changed parameter, destroy() on unmount", async () => {
    const log: string[] = [];
    const action = (node: HTMLElement, param: string) => {
      log.push(`mount:${node.tagName}:${param}`);
      return {
        update: (next: string) => log.push(`update:${next}:${node.textContent}`),
        destroy: () => log.push("destroy"),
      };
    };
    function Probe({ value, other }: { value: string; other: number }) {
      return (
        <p ref={useAction(action, value)} data-other={other}>
          {value}
        </p>
      );
    }
    const view = render(<Probe value="a" other={0} />);
    view.rerender(<Probe value="a" other={1} />); // parameter unchanged → no update
    view.rerender(<Probe value="b" other={1} />);
    view.unmount();
    // update() ran after the DOM showed the new text.
    expect(log).toEqual(["mount:P:a", "update:b:b", "destroy"]);
  });
});

/* ------------------------------------------------------------------ */
/* lib/presence — when intros play, and exits that outlive the removal */
/* ------------------------------------------------------------------ */

describe("Presence", () => {
  function animatedElements(): Element[] {
    return [...document.querySelectorAll("[data-row]")];
  }

  it("keeps a removed child mounted until its exit has played, inert meanwhile", async () => {
    function Row({ id }: { id: string }) {
      const ref = useRef<HTMLLIElement | null>(null);
      useTransition(ref, { out: (node) => fade(node, { duration: 50 }) });
      return (
        <li ref={ref} data-row={id}>
          {id}
        </li>
      );
    }
    function List({ ids }: { ids: string[] }) {
      return (
        <ul>
          <Presence>
            {ids.map((id) => (
              <Row key={id} id={id} />
            ))}
          </Presence>
        </ul>
      );
    }
    const view = render(<List ids={["a", "b", "c"]} />);
    view.rerender(<List ids={["a", "c"]} />);

    // Still there, in its old place, and inert.
    expect(animatedElements().map((el) => el.textContent)).toEqual(["a", "b", "c"]);
    expect((screen.getByText("b") as HTMLElement).inert).toBe(true);

    await waitFor(() => expect(animatedElements().map((el) => el.textContent)).toEqual(["a", "c"]));
  });

  it("removes a child with no transition at once", () => {
    function Open({ open }: { open: boolean }) {
      return <Presence>{open && <p key="x">열림</p>}</Presence>;
    }
    const view = render(<Open open />);
    view.rerender(<Open open={false} />);
    expect(screen.queryByText("열림")).toBeNull();
  });

  it("plays the intro for a child that arrives later, not for one mounted with it", async () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    function Cards({ ids }: { ids: string[] }) {
      return (
        <Presence>
          {ids.map((id) => (
            <Transition key={id} tag="div" data-row={id} in={(node) => fade(node, { duration: 50 })}>
              {id}
            </Transition>
          ))}
        </Presence>
      );
    }
    const view = render(<Cards ids={["first"]} />);
    expect(animate).not.toHaveBeenCalled();

    view.rerender(<Cards ids={["first", "second"]} />);
    expect(animate).toHaveBeenCalled();
    expect(animate.mock.instances.every((el) => (el as unknown as HTMLElement).dataset.row === "second")).toBe(true);
    animate.mockRestore();
  });

  it("turns a child around when it comes back mid-exit instead of remounting it", async () => {
    const mounts: string[] = [];
    function Box() {
      const ref = useRef<HTMLDivElement | null>(null);
      useTransition(ref, { both: (node) => fade(node, { duration: 50 }) });
      const [id] = useState(() => {
        const next = `box-${mounts.length}`;
        mounts.push(next);
        return next;
      });
      return (
        <div ref={ref} data-row={id}>
          상자
        </div>
      );
    }
    function Host({ open }: { open: boolean }) {
      return <Presence>{open && <Box key="box" />}</Presence>;
    }
    const view = render(<Host open />);
    view.rerender(<Host open={false} />);
    view.rerender(<Host open />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mounts).toEqual(["box-0"]);
    expect((screen.getByText("상자") as HTMLElement).inert).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Toggle — accessible switch whose visual state follows the SAVE      */
/* ------------------------------------------------------------------ */

describe("Toggle", () => {
  it("renders an accessible switch and flips only after onChange succeeds", async () => {
    const onChange = vi.fn(async (_next: boolean) => {});
    render(<Toggle on={false} label="알림 사용" onChange={onChange} />);

    const sw = screen.getByRole("switch", { name: "알림 사용" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(true);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(sw.className).toContain("on");
  });

  it("keeps the previous visual state when the save rejects", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("save failed");
    });
    render(<Toggle on label="저장 실패" onChange={onChange} />);

    const sw = screen.getByRole("switch", { name: "저장 실패" });
    fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(sw.getAttribute("aria-busy")).toBe("false"));
    expect(sw.getAttribute("aria-checked")).toBe("true"); // still on
  });

  it("locks while a save is in flight and ignores re-clicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onChange = vi.fn(() => gate);
    render(<Toggle on={false} label="느린 저장" onChange={onChange} />);

    const sw = screen.getByRole("switch", { name: "느린 저장" }) as HTMLButtonElement;
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(sw.disabled).toBe(true);

    fireEvent.click(sw); // busy → ignored
    release();
    await waitFor(() => expect(sw.getAttribute("aria-busy")).toBe("false"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("takes the parent's value again when the prop changes", () => {
    const view = render(<Toggle on={false} label="외부 변경" />);
    view.rerender(<Toggle on label="외부 변경" />);
    expect(screen.getByRole("switch", { name: "외부 변경" }).getAttribute("aria-checked")).toBe("true");
  });

  it("does not let its click reach a clickable ancestor", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <Toggle label="행 안의 스위치" />
      </div>,
    );
    fireEvent.click(screen.getByRole("switch", { name: "행 안의 스위치" }));
    expect(onRow).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* RevealableInput — a secret field that can be shown                  */
/* ------------------------------------------------------------------ */

describe("RevealableInput", () => {
  it("reports typing, reveals on demand and hides again when it gets locked", () => {
    const onValueChange = vi.fn();
    const onInput = vi.fn();
    const view = render(<RevealableInput ariaLabel="토큰" revealLabel="토큰" onValueChange={onValueChange} onInput={onInput} />);
    const input = screen.getByLabelText("토큰") as HTMLInputElement;
    expect(input.type).toBe("password");

    fireEvent.change(input, { target: { value: "abc" } });
    expect(onValueChange).toHaveBeenCalledWith("abc");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("abc");

    fireEvent.click(screen.getByRole("button", { name: "토큰 보기" }));
    expect(input.type).toBe("text");

    view.rerender(<RevealableInput ariaLabel="토큰" revealLabel="토큰" disabled />);
    expect(input.type).toBe("password");
    view.rerender(<RevealableInput ariaLabel="토큰" revealLabel="토큰" />);
    expect(input.type).toBe("password"); // unlocking does not reveal it again
  });
});

/* ------------------------------------------------------------------ */
/* Toasts — store-driven notification stack                            */
/* ------------------------------------------------------------------ */

describe("Toasts", () => {
  beforeEach(() => {
    toasts.set([]);
  });

  it("renders queued toasts with urgency-aware live-region roles", () => {
    const queue: Toast[] = [
      { id: "t1", message: "저장 완료", kind: "info" },
      { id: "t2", message: "연결 끊김", kind: "warn" },
    ];
    toasts.set(queue);
    render(<Toasts />);

    const info = screen.getByText("저장 완료").closest(".toast")!;
    const warn = screen.getByText("연결 끊김").closest(".toast")!;
    expect(info.getAttribute("role")).toBe("status");
    expect(info.getAttribute("aria-live")).toBe("polite");
    expect(warn.getAttribute("role")).toBe("alert");
    expect(warn.getAttribute("aria-live")).toBe("assertive");
    expect(warn.className).toContain("warn");
  });

  it("runs a toast action then dismisses it; × closes plain toasts", async () => {
    const action = vi.fn();
    toasts.set([
      { id: "a1", message: "삭제했습니다", kind: "warn", actionLabel: "실행 취소", action },
      { id: "p1", message: "그냥 알림", kind: "ok" },
    ]);
    render(<Toasts />);

    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(get(toasts).map((t) => t.id)).toEqual(["p1"]);
    await waitFor(() => expect(screen.queryByText("삭제했습니다")).toBeNull());

    // The toast that is on its way out is inert; the one left has the only live ×.
    fireEvent.click(within(screen.getByText("그냥 알림").closest(".toast") as HTMLElement).getByRole("button", { name: "알림 닫기" }));
    expect(get(toasts)).toEqual([]);
    await waitFor(() => expect(screen.queryByText("그냥 알림")).toBeNull());
  });
});

/* ------------------------------------------------------------------ */
/* Modal + ConfirmationDialog                                          */
/* ------------------------------------------------------------------ */

describe("Modal", () => {
  it("moves focus into the card, inerts the page behind it, and restores both on close", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            열기
          </button>
          <Presence>
            {open && (
              <Modal key="m" ariaLabelledby="t" onClose={() => setOpen(false)}>
                <h2 id="t">제목</h2>
                <button type="button">첫 버튼</button>
                <button type="button" data-modal-autofocus="">
                  기본 버튼
                </button>
              </Modal>
            )}
          </Presence>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "열기" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "제목" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "기본 버튼" }));
    expect(opener.inert).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("ignores Escape while closing is disabled, and renders under <body> when portaled", () => {
    const onClose = vi.fn();
    const view = render(
      <div data-testid="deep">
        <Modal portal closeDisabled onClose={onClose}>
          <p>내용</p>
        </Modal>
      </div>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("내용").closest(".modal-overlay")?.parentElement).toBe(document.body);
    expect(view.getByTestId("deep").querySelector(".modal-overlay")).toBeNull();
  });
});

describe("ConfirmationDialog", () => {
  it("asks, resolves with the pressed answer, and shows the next queued question", async () => {
    render(<ConfirmationDialog />);
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    await act(async () => {
      first = confirmAction("대화를 삭제할까요?\n되돌릴 수 없습니다.");
      second = confirmAction("모델을 변경할까요?");
    });

    const dialog = screen.getByRole("dialog", { name: "대화를 삭제할까요?" });
    expect(within(dialog).getByText("되돌릴 수 없습니다.")).toBeTruthy();
    expect(dialog.querySelector(".confirm-symbol")?.className).toContain("danger");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "취소" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await expect(first!).resolves.toBe(true);

    const next = await screen.findByRole("dialog", { name: "이대로 진행할까요?" });
    fireEvent.click(within(next).getByRole("button", { name: "취소" }));
    await expect(second!).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
