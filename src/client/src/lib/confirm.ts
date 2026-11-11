import { writable } from "./store";

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface ConfirmRequest extends Required<ConfirmOptions> {
  id: number;
  message: string;
  resolve: (confirmed: boolean) => void;
}

export const confirmation = writable<ConfirmRequest | null>(null);

let nextId = 0;
let active: ConfirmRequest | null = null;
const queue: ConfirmRequest[] = [];

function infer(message: string): Required<ConfirmOptions> {
  const destructive = /삭제|제거|해제|정지|차단|영구|되돌릴 수 없/.test(message);
  const disconnect = /연결을 해제/.test(message);
  const suspend = /정지/.test(message);
  const remove = /제거/.test(message);
  const change = /전환|변경|부여/.test(message);
  const title = /계정.*삭제|사용자.*삭제/.test(message)
    ? "계정을 삭제할까요?"
    : /대화.*삭제/.test(message)
      ? "대화를 삭제할까요?"
      : disconnect
          ? "연결을 해제할까요?"
          : suspend
            ? "계정을 정지할까요?"
            : remove
              ? "제거할까요?"
              : destructive
                ? "계속 진행할까요?"
                : "이대로 진행할까요?";
  return {
    title,
    confirmLabel: disconnect ? "연결 해제" : suspend ? "정지" : remove ? "제거" : destructive ? "삭제" : change ? "변경" : "계속",
    cancelLabel: "취소",
    tone: destructive ? "danger" : "default",
  };
}

function pump(): void {
  if (active || !queue.length) return;
  active = queue.shift() ?? null;
  confirmation.set(active);
}

export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const defaults = infer(message);
  return new Promise((resolve) => {
    queue.push({
      id: ++nextId,
      message,
      title: options.title ?? defaults.title,
      confirmLabel: options.confirmLabel ?? defaults.confirmLabel,
      cancelLabel: options.cancelLabel ?? defaults.cancelLabel,
      tone: options.tone ?? defaults.tone,
      resolve,
    });
    pump();
  });
}

export function resolveConfirmation(confirmed: boolean): void {
  if (!active) return;
  const request = active;
  active = null;
  confirmation.set(null);
  request.resolve(confirmed);
  queueMicrotask(pump);
}
