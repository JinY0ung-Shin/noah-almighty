import { useState } from "react";
import Modal from "./Modal";
import RevealableInput from "./RevealableInput";
import { api } from "../lib/api";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import type { AdminUserSummary } from "../lib/types";

export interface AdminPasswordResetModalProps {
  user: AdminUserSummary;
  onClose?: () => void;
  onDone?: () => void;
}

const VALIDATION_ERRORS = new Set(["비밀번호는 8자 이상이어야 합니다.", "두 비밀번호가 일치하지 않습니다."]);

/**
 * Renders a `<Modal>`: the parent renders it inside `<Presence>` with a key so
 * it can play its exit.
 */
export default function AdminPasswordResetModal({ user, onClose, onDone }: AdminPasswordResetModalProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [storedError, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const userIdBase = user.id.replace(/[^A-Za-z0-9_-]/g, "-");
  const titleId = `admin-password-reset-${userIdBase}-title`;
  const descId = `admin-password-reset-${userIdBase}-desc`;
  const statusId = `admin-password-reset-${userIdBase}-status`;
  const errorId = `admin-password-reset-${userIdBase}-error`;
  const passwordReady = password.length >= 8;
  const passwordsMatch = Boolean(password && confirmPassword && password === confirmPassword);
  const canSubmit = Boolean(!busy && passwordReady && passwordsMatch);
  // A validation error goes away as soon as the form becomes submittable.
  const clearError = Boolean(storedError && VALIDATION_ERRORS.has(storedError) && canSubmit);
  if (clearError) setErrorMessage("");
  const errorMessage = clearError ? "" : storedError;
  const passwordInvalid = Boolean(password && !passwordReady) || errorMessage === "비밀번호는 8자 이상이어야 합니다.";
  const confirmInvalid = Boolean(confirmPassword && !passwordsMatch) || errorMessage === "두 비밀번호가 일치하지 않습니다.";
  const inputDescribedBy = errorMessage ? `${statusId} ${errorId}` : statusId;
  const passwordStatus = busy
    ? "재설정 중…"
    : !password
      ? "새 비밀번호를 입력해 주세요."
      : !passwordReady
        ? "비밀번호는 8자 이상이어야 합니다."
        : !confirmPassword
          ? "확인 비밀번호를 입력해 주세요."
          : !passwordsMatch
            ? "두 비밀번호가 일치하지 않습니다."
            : "재설정할 준비가 됐습니다.";

  async function submit() {
    if (busy) return;
    if (password.length < 8) {
      setErrorMessage("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("두 비밀번호가 일치하지 않습니다.");
      return;
    }
    setErrorMessage("");
    setBusy(true);
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      notify("비밀번호를 재설정했습니다.", "ok");
      onDone?.();
      onClose?.();
    } catch (err) {
      setBusy(false);
      setErrorMessage(`재설정 실패: ${(err as Error).message}`);
    }
  }

  return (
    <Modal
      cardClass="password-reset-card"
      ariaLabelledby={titleId}
      ariaDescribedby={descId}
      closeDisabled={busy}
      onClose={() => onClose?.()}
    >
      <h2 id={titleId}>비밀번호 재설정</h2>
      <p className="muted" id={descId}>
        저장하면 이 사용자의 기존 세션이 모두 로그아웃됩니다.
      </p>
      <form
        className="routine-modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>새 비밀번호</span>
          <RevealableInput
            value={password}
            onValueChange={setPassword}
            name="password"
            autocomplete="new-password"
            placeholder="새 비밀번호"
            ariaLabel={`${user.displayName} 새 비밀번호`}
            ariaDescribedby={inputDescribedBy}
            ariaInvalid={passwordInvalid}
            revealLabel="비밀번호"
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>새 비밀번호 확인</span>
          <RevealableInput
            value={confirmPassword}
            onValueChange={setConfirmPassword}
            name="confirmPassword"
            autocomplete="new-password"
            placeholder="새 비밀번호 확인"
            ariaLabel={`${user.displayName} 새 비밀번호 확인`}
            ariaDescribedby={inputDescribedBy}
            ariaInvalid={confirmInvalid}
            revealLabel="비밀번호"
            disabled={busy}
          />
        </label>
        {errorMessage && (
          <div className="error" id={errorId} role="alert">
            {errorMessage}
          </div>
        )}
        <div
          className={cx(
            "routine-form-status",
            Boolean(errorMessage || passwordInvalid || confirmInvalid) && "invalid",
            canSubmit && "dirty",
            busy && "pending",
          )}
          id={statusId}
          role="status"
          aria-live="polite"
        >
          {passwordStatus}
        </div>
        <div className="routine-modal-actions">
          <div className="routine-modal-actions-left">
            <span className="muted">
              대상: {user.displayName} (@{user.username})
            </span>
          </div>
          <div className="routine-modal-actions-right">
            <button className="ghost-sm" type="button" disabled={busy} onClick={() => onClose?.()}>
              취소
            </button>
            <button className="primary" type="submit" disabled={!canSubmit}>
              {busy ? "재설정 중…" : "재설정"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
