import { useEffect, useRef, useState, type FormEvent } from "react";
import Icon from "./Icon";
import "./AuthView.css";
import { api, ApiError } from "../lib/api";
import { cx, useLatest, useWindowEvent } from "../lib/hooks";
import { goToLoginServerLogin, goToLoginServerRegistration } from "../lib/loginServer";
import { replaceState, notify } from "../lib/state";
import type { BootstrapInfo, User } from "../lib/types";

export interface AuthViewProps {
  bootstrap: BootstrapInfo | null;
}

const usernameIssueId = "auth-username-issue";
const passwordIssueId = "auth-password-issue";
const submitStatusId = "auth-submit-status";

/**
 * Opened from a PPTX share link: say why a login screen appeared. The hash
 * survives the login (syncHash is a no-op without a user), so the deck opens
 * right after it. Tracked, not read once: a link pasted into a tab already on
 * this screen is a same-document fragment navigation — no reload, no remount,
 * only a hashchange. (Not state.view: boot leaves it at 'explore' until
 * enterApp applies the route.)
 */
function useOpenedFromShareLink(): boolean {
  const [hash, setHash] = useState(() => (typeof location !== "undefined" ? location.hash : ""));
  useWindowEvent("hashchange", () => setHash(location.hash));
  return hash.startsWith("#/share/");
}

interface PasswordFieldProps {
  /** `current`: logging in; `new`: choosing one. */
  kind: "current" | "new";
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  issue: string;
  describedBy: string;
  disabled: boolean;
  autoFocus?: boolean;
}

function PasswordField({ kind, value, onChange, visible, onToggleVisible, issue, describedBy, disabled, autoFocus }: PasswordFieldProps) {
  return (
    <label className="field">
      <span>비밀번호</span>
      <div className="password-field">
        <input
          name="password"
          type={visible ? "text" : "password"}
          autoComplete={kind === "current" ? "current-password" : "new-password"}
          placeholder={kind === "current" ? "비밀번호" : "8자 이상"}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(issue)}
          required
          minLength={8}
          disabled={disabled}
          autoFocus={autoFocus}
        />
        <button
          className="password-toggle"
          type="button"
          disabled={disabled}
          aria-label={visible ? "비밀번호 숨기기" : "비밀번호 보기"}
          title={visible ? "비밀번호 숨기기" : "비밀번호 보기"}
          onClick={onToggleVisible}
        >
          <Icon name={visible ? "eye-off" : "eye"} />
        </button>
      </div>
      {issue ? (
        <span id={passwordIssueId} className="field-hint warn">
          {issue}
        </span>
      ) : null}
    </label>
  );
}

/**
 * The login / signup / first-run screen. With the single sign-on login
 * configured (bootstrap `sso`) it is a different screen — accounts are created
 * and (once moved) logged in on the login server; without it, the built-in
 * form exactly as before.
 */
export default function AuthView({ bootstrap }: AuthViewProps) {
  return bootstrap?.sso ? <SsoAuthView bootstrap={bootstrap} /> : <PasswordAuthView bootstrap={bootstrap} />;
}

function PasswordAuthView({ bootstrap }: AuthViewProps) {
  const openedFromShareLink = useOpenedFromShareLink();

  const [mode, setModeValue] = useState<"login" | "signup">(bootstrap?.needsSetup ? "signup" : "login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [busy, setBusyValue] = useState(false);
  // `busy` is also the re-entry guard of submit/setMode, which must see a write
  // made earlier in the same tick.
  const busyRef = useRef(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyValue(next);
  }

  const isSetup = Boolean(bootstrap?.needsSetup);
  const signupAllowed = isSetup || bootstrap?.signupMode === "approval";
  // A bootstrap that turns out to need setup forces the signup form (the
  // initial value above covers the first render).
  const [seenSetup, setSeenSetup] = useState(isSetup);
  if (seenSetup !== isSetup) {
    setSeenSetup(isSetup);
    if (isSetup) setModeValue("signup");
  }
  const isLogin = mode === "login";
  const usernameTrimmed = username.trim();
  const displayNameTrimmed = displayName.trim();
  const usernameIssue =
    usernameTrimmed.length === 0 ? "사용자명을 입력해 주세요." : usernameTrimmed.length < 3 ? "사용자명은 3자 이상이어야 합니다." : "";
  const passwordIssue =
    password.length === 0 ? "비밀번호를 입력해 주세요." : password.length < 8 ? "비밀번호는 8자 이상이어야 합니다." : "";
  const canSubmit = Boolean(usernameTrimmed.length >= 3 && password.length >= 8 && !busy);
  const heading = isSetup ? "관리자 계정 만들기" : isLogin ? "다시 오신 것을 환영합니다" : "Noah Almighty 시작하기";
  const description = isSetup
    ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
    : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.";
  const submitLabel = busy
    ? isLogin
      ? "로그인 중…"
      : isSetup
        ? "계정 만드는 중…"
        : "가입 중…"
    : isLogin
      ? "로그인"
      : isSetup
        ? "관리자 계정 만들기"
        : "회원가입";
  const submitStatus = busy
    ? isLogin
      ? "로그인 요청을 보내는 중입니다."
      : "계정 요청을 보내는 중입니다."
    : usernameIssue ||
      passwordIssue ||
      (isLogin
        ? "로그인할 준비가 됐습니다."
        : isSetup
          ? "관리자 계정을 만들 준비가 됐습니다."
          : bootstrap?.signupMode === "approval"
            ? "승인 요청을 보낼 준비가 됐습니다."
            : "회원가입할 준비가 됐습니다.");
  const submitStatusWarn = Boolean(!busy && (usernameIssue || passwordIssue));
  const usernameDescribedBy = usernameIssue ? `${usernameIssueId} ${submitStatusId}` : submitStatusId;
  const passwordDescribedBy = passwordIssue ? `${passwordIssueId} ${submitStatusId}` : submitStatusId;

  // What submit() reads AFTER its request came back.
  const modeRef = useLatest(mode);
  const isSetupRef = useLatest(isSetup);

  function setMode(next: "login" | "signup", force = false): void {
    if (busyRef.current && !force) return;
    setModeValue(next);
    setError("");
    setPending(false);
  }

  async function submit(): Promise<void> {
    if (!canSubmit || busyRef.current) return;
    setError("");
    setPending(false);
    setBusy(true);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const payload =
        mode === "login"
          ? { username: usernameTrimmed, password }
          : { username: usernameTrimmed, displayName: displayNameTrimmed, password };
      const result = await api<{ user?: User; pending?: boolean }>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (result.pending) {
        notify("가입 요청이 접수되었습니다. 관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.", "info");
        setMode("login", true);
        setPending(true);
        return;
      }
      if (result.user) {
        const signedUp = modeRef.current === "signup" && !isSetupRef.current;
        replaceState({ user: result.user, view: "explore" });
        if (signedUp) {
          notify("회원가입이 완료되었습니다. 팀에 합류했습니다.", "info", { durationMs: 9000 });
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <main className="auth-view cmp-auth-view">
      <section className="auth-panel">
        <img className="login-mark" src="/icon-192.png" alt="Noah Almighty" width="48" height="48" />
        {isSetup ? <div className="setup-badge">첫 실행 · 관리자 설정</div> : null}
        <h1>{heading}</h1>
        <p>{description}</p>
        {openedFromShareLink && !isSetup ? (
          <p className="auth-share-hint" role="note">
            공유받은 PPT를 보려면 Noah에 로그인하세요.
          </p>
        ) : null}

        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        {pending ? (
          <p className="muted auth-note" role="status">
            가입 요청이 승인 대기 상태입니다.
          </p>
        ) : mode === "signup" && !isSetup && bootstrap?.signupMode === "approval" ? (
          <p className="muted auth-note">관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.</p>
        ) : null}

        <form className="form-stack" onSubmit={onSubmit} aria-busy={busy ? "true" : "false"} aria-describedby={submitStatusId}>
          <label className="field">
            <span>사용자명</span>
            <input
              name="username"
              autoComplete="username"
              placeholder="user123"
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              aria-describedby={usernameDescribedBy}
              aria-invalid={Boolean(usernameIssue)}
              required
              minLength={3}
              disabled={busy}
            />
            {usernameIssue ? (
              <span id={usernameIssueId} className="field-hint warn">
                {usernameIssue}
              </span>
            ) : null}
          </label>

          {mode === "signup" ? (
            <label className="field">
              <span>내 이름</span>
              <input
                name="displayName"
                autoComplete="nickname"
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
                placeholder="홍길동"
                disabled={busy}
              />
              <span className="field-hint">동료에게 보이는 이름이에요. 비워두면 사용자명이 표시됩니다.</span>
            </label>
          ) : null}

          <PasswordField
            kind={mode === "login" ? "current" : "new"}
            value={password}
            onChange={setPassword}
            visible={passwordVisible}
            onToggleVisible={() => setPasswordVisible((visible) => !visible)}
            issue={passwordIssue}
            describedBy={passwordDescribedBy}
            disabled={busy}
          />

          <p id={submitStatusId} className={cx("auth-submit-status", submitStatusWarn && "warn")} role="status" aria-live="polite">
            {submitStatus}
          </p>

          <button className="primary" type="submit" disabled={!canSubmit}>
            {submitLabel}
          </button>
        </form>

        {!isSetup ? (
          <div className="auth-switch">
            {mode === "login" && signupAllowed ? (
              <button type="button" className="linkish" disabled={busy} onClick={() => setMode("signup")}>
                {bootstrap?.signupMode === "approval" ? "가입 승인 요청" : "회원가입"}
              </button>
            ) : mode === "signup" ? (
              <button type="button" className="linkish" disabled={busy} onClick={() => setMode("login")}>
                로그인
              </button>
            ) : bootstrap?.signupMode === "closed" ? (
              <span className="muted">현재 회원가입을 받지 않습니다.</span>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

// ---- Single sign-on (bootstrap `sso`) ---------------------------------

// A login on the login server that did not end in a session comes back as
// `/?auth=<code>`. Each code is said here once; an unknown one reads as `failed`.
const AUTH_RETURN_FAILED = "로그인을 마치지 못했습니다. 다시 시도해 주세요.";
const AUTH_RETURN_ERRORS = new Map<string, string>([
  ["suspended", "비활성화된 계정입니다. 관리자 승인이나 문의가 필요합니다."],
  ["closed", "현재 회원가입이 비활성화되어 있습니다. 관리자에게 문의해 주세요."],
  ["full", "지금은 가입 신청이 많아 새 신청을 받을 수 없습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요."],
  ["name", "이 사용자명은 사용할 수 없습니다. 관리자에게 문의해 주세요."],
  ["failed", AUTH_RETURN_FAILED],
]);

/** What `/?auth=<code>` says, read where the screen starts (the address is cleaned in an effect). */
function readAuthReturn(): { pending: boolean; error: string } {
  const code = typeof location !== "undefined" ? new URLSearchParams(location.search).get("auth") : null;
  if (!code) return { pending: false, error: "" };
  if (code === "pending") return { pending: true, error: "" };
  return { pending: false, error: AUTH_RETURN_ERRORS.get(code) ?? AUTH_RETURN_FAILED };
}

function SsoAuthView({ bootstrap }: { bootstrap: BootstrapInfo }) {
  const openedFromShareLink = useOpenedFromShareLink();
  const isSetup = Boolean(bootstrap.needsSetup);

  const [returned] = useState(readAuthReturn);
  // `username`: only the name is asked; `password`: the server said this
  // account still logs in with its built-in password.
  const [step, setStep] = useState<"username" | "password">("username");
  const [username, setUsernameValue] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState(returned.error);
  const [pending, setPending] = useState(returned.pending);
  const [busy, setBusyValue] = useState(false);
  // On the way to the login server: the screen stays busy until the page is gone.
  const [leaving, setLeaving] = useState(false);
  // The re-entry guard, which must see a write made earlier in the same tick.
  const busyRef = useRef(false);

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyValue(next);
  }

  // The notice is on screen; the code leaves the address so a reload or a
  // copied link does not say it again.
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("auth")) return;
    url.searchParams.delete("auth");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // Back/forward can bring this very page back from the cache, still "leaving".
  useWindowEvent("pageshow", (event) => {
    if (!event.persisted) return;
    setLeaving(false);
    setBusy(false);
  });

  const usernameTrimmed = username.trim();
  const usernameIssue =
    usernameTrimmed.length === 0 ? "사용자명을 입력해 주세요." : usernameTrimmed.length < 3 ? "사용자명은 3자 이상이어야 합니다." : "";
  const passwordStep = step === "password";
  const passwordIssue = !passwordStep
    ? ""
    : password.length === 0
      ? "비밀번호를 입력해 주세요."
      : password.length < 8
        ? "비밀번호는 8자 이상이어야 합니다."
        : "";
  const canSubmit = Boolean(!usernameIssue && !passwordIssue && !busy);
  const submitLabel = leaving ? "이동 중…" : busy ? (passwordStep ? "로그인 중…" : "확인 중…") : passwordStep ? "로그인" : "다음";
  const submitStatus = leaving
    ? "로그인 화면으로 이동하는 중입니다."
    : busy
      ? passwordStep
        ? "로그인 요청을 보내는 중입니다."
        : "사용자명을 확인하는 중입니다."
      : usernameIssue || passwordIssue || (passwordStep ? "로그인할 준비가 됐습니다." : "다음 단계로 넘어갈 준비가 됐습니다.");
  const submitStatusWarn = Boolean(!busy && (usernameIssue || passwordIssue));
  const usernameDescribedBy = usernameIssue ? `${usernameIssueId} ${submitStatusId}` : submitStatusId;
  const passwordDescribedBy = passwordIssue ? `${passwordIssueId} ${submitStatusId}` : submitStatusId;

  function setUsername(next: string): void {
    setUsernameValue(next);
    // The answer was about the name as it was: another name starts over.
    if (step === "password" && next.trim() !== usernameTrimmed) {
      setStep("username");
      setPassword("");
      setPasswordVisible(false);
    }
  }

  function leave(go: () => void): void {
    setLeaving(true);
    setBusy(true);
    go();
  }

  function register(): void {
    if (busyRef.current) return;
    setError("");
    setPending(false);
    leave(goToLoginServerRegistration);
  }

  async function submit(): Promise<void> {
    if (!canSubmit || busyRef.current) return;
    const name = usernameTrimmed;
    setError("");
    setPending(false);
    setBusy(true);
    let left = false;
    try {
      if (!passwordStep) {
        const { method } = await api<{ method?: string }>("/api/auth/login-method", {
          method: "POST",
          body: JSON.stringify({ username: name }),
        });
        if (method === "password") {
          setStep("password");
        } else if (method === "sso") {
          left = true;
          leave(() => goToLoginServerLogin(name));
        } else {
          setError("로그인 방법을 확인하지 못했습니다. 다시 시도해 주세요.");
        }
        return;
      }
      const result = await api<{ user?: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: name, password }),
      });
      if (result.user) replaceState({ user: result.user, view: "explore" });
    } catch (err) {
      // The account's password has moved since the name was checked: it logs in
      // on the login server now.
      if (passwordStep && err instanceof ApiError && err.status === 409 && err.data.sso === true) {
        left = true;
        leave(() => goToLoginServerLogin(name));
        return;
      }
      setError((err as Error).message);
    } finally {
      if (!left) setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <main className="auth-view cmp-auth-view">
      <section className="auth-panel">
        <img className="login-mark" src="/icon-192.png" alt="Noah Almighty" width="48" height="48" />
        {isSetup ? <div className="setup-badge">첫 실행 · 관리자 설정</div> : null}
        <h1>{isSetup ? "관리자 계정 만들기" : "다시 오신 것을 환영합니다"}</h1>
        <p>
          {isSetup
            ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
            : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요."}
        </p>
        {openedFromShareLink && !isSetup ? (
          <p className="auth-share-hint" role="note">
            공유받은 PPT를 보려면 Noah에 로그인하세요.
          </p>
        ) : null}

        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        {pending ? (
          <p className="muted auth-note" role="status">
            가입 요청이 승인 대기 상태입니다. 관리자가 승인하면 팀에 합류해 로그인할 수 있습니다.
          </p>
        ) : null}

        {isSetup ? (
          // No account exists yet: the first one registered on the login server
          // becomes the administrator.
          <button className="primary" type="button" disabled={busy} onClick={register}>
            {leaving ? "이동 중…" : "관리자 계정 만들기"}
          </button>
        ) : (
          <>
            <form className="form-stack" onSubmit={onSubmit} aria-busy={busy ? "true" : "false"} aria-describedby={submitStatusId}>
              <label className="field">
                <span>사용자명</span>
                <input
                  name="username"
                  autoComplete="username"
                  placeholder="user123"
                  value={username}
                  onChange={(event) => setUsername(event.currentTarget.value)}
                  aria-describedby={usernameDescribedBy}
                  aria-invalid={Boolean(usernameIssue)}
                  required
                  minLength={3}
                  disabled={busy}
                />
                {usernameIssue ? (
                  <span id={usernameIssueId} className="field-hint warn">
                    {usernameIssue}
                  </span>
                ) : null}
              </label>

              {passwordStep ? (
                <PasswordField
                  kind="current"
                  value={password}
                  onChange={setPassword}
                  visible={passwordVisible}
                  onToggleVisible={() => setPasswordVisible((visible) => !visible)}
                  issue={passwordIssue}
                  describedBy={passwordDescribedBy}
                  disabled={busy}
                  autoFocus
                />
              ) : null}

              <p id={submitStatusId} className={cx("auth-submit-status", submitStatusWarn && "warn")} role="status" aria-live="polite">
                {submitStatus}
              </p>

              <button className="primary" type="submit" disabled={!canSubmit}>
                {submitLabel}
              </button>
            </form>

            <div className="auth-switch">
              {bootstrap.signupMode === "approval" ? (
                <>
                  <button type="button" className="linkish" disabled={busy} onClick={register}>
                    가입 신청
                  </button>
                  <p className="auth-switch-note">가입 신청을 마치면 관리자가 승인한 뒤 로그인할 수 있습니다.</p>
                </>
              ) : bootstrap.signupMode === "closed" ? (
                <span className="muted">현재 회원가입을 받지 않습니다.</span>
              ) : null}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
