<script lang="ts">
  import SettingsAvatarApiKeys from "./SettingsAvatarApiKeys.svelte";
  import SettingsShareLinks from "./SettingsShareLinks.svelte";
  import Icon from "./Icon.svelte";
  import BrowserBridgeGuideModal from "./BrowserBridgeGuideModal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { appState, notify, readState, replaceState, updateState } from "../lib/state";
  import { copyText } from "../lib/dom";
  import {
    extensionsPageUrl,
    readAllowedOrigins,
    writeAllowedOrigins,
    type AllowlistSource,
  } from "../lib/browserBridge";
  import {
    clearExtensionDir,
    ensureDirPermission,
    fsaSupported,
    loadSavedExtensionDir,
    pickExtensionDir,
    saveExtensionDir,
    updateExtensionInPlace,
    verifyExtensionDir,
  } from "../lib/browserBridgeInstall";
  import { EXPERIMENTAL_FEATURES } from "../../../server/experimentalFeatures";
  import {
    isBrowserExposableSecret,
    isShellExposableSecret,
    type BrowserSecretPolicy,
  } from "../../../server/secretPolicy";
  import type { User } from "../lib/types";

  export let active = false;

  const INTERNAL_GIT_TOKEN = "GIT_TOKEN";
  const EXTERNAL_GIT_TOKEN = "GITHUB_TOKEN";
  const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  const SECRET_PRESETS = [
    {
      name: "SSH_PRIVATE_KEY",
      label: "SSH 개인키",
      description: "원격 SSH 도구가 사용할 OpenSSH/PEM 개인키입니다. 아래 'SSH 키' 생성 시 자동으로 채워져요.",
      placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n…",
      rows: 4,
    },
    {
      name: "CONFLUENCE_PAT",
      label: "Confluence PAT",
      description: "사내 Confluence 공용 도구의 Bearer 인증에 사용해요.",
      placeholder: "Confluence PAT (CONFLUENCE_PAT)",
      rows: 2,
    },
  ];

  const u0 = readState().user;

  // Browser bridge install/update state.
  const extensionsPage = extensionsPageUrl();
  let guideOpen = false;
  let extensionBusy = false;
  let extensionId: string | null = null;
  let extensionOrigins: string[] = [];
  let extensionMultimediaNotice = false;
  let extensionMetaLoaded = false;

  // One-click updater (File System Access): the folder handle picked at setup
  // lives in IndexedDB; permission is re-confirmed inside each button gesture.
  const updateDirSupported = fsaSupported();
  let updateDirName: string | null = null;
  let updateDirLoaded = false;
  let updateBusy = false;

  async function loadUpdateDirState(): Promise<void> {
    if (updateDirLoaded || !updateDirSupported) return;
    updateDirLoaded = true;
    const handle = await loadSavedExtensionDir();
    updateDirName = handle ? (handle.name ?? "연결된 폴더") : null;
  }

  async function connectUpdateDir(): Promise<void> {
    const handle = await pickExtensionDir();
    if (!handle) return; // cancelled
    const verdict = await verifyExtensionDir(handle);
    if (verdict === "not-extension") {
      notify("확장 폴더가 아닙니다 (manifest.json 없음). 압축을 푼 확장 폴더를 선택하세요.", "warn");
      return;
    }
    if (verdict === "different-extension") {
      notify("이 폴더의 확장은 Noah 브릿지가 아니거나 ID가 다릅니다. 압축을 푼 확장 폴더를 선택하세요.", "warn");
      return;
    }
    try {
      await saveExtensionDir(handle);
    } catch {
      notify("폴더 연결을 저장하지 못했습니다 (브라우저 저장소 오류). 다시 시도해 주세요.", "warn");
      return;
    }
    updateDirName = handle.name ?? "연결된 폴더";
    notify("확장 폴더를 연결했습니다. 이제 버전 업데이트는 버튼 한 번입니다.", "ok");
  }

  async function runOneClickUpdate(): Promise<void> {
    if (updateBusy) return;
    updateBusy = true;
    try {
      const handle = await loadSavedExtensionDir();
      if (!handle) {
        updateDirName = null;
        notify("연결된 폴더가 없습니다. 확장 폴더를 다시 연결해 주세요.", "warn");
        return;
      }
      if (!(await ensureDirPermission(handle))) {
        notify("폴더 쓰기 권한이 거부됐습니다. 확장 폴더를 다시 연결해 주세요.", "warn");
        return;
      }
      if ((await verifyExtensionDir(handle)) !== "ok") {
        notify("연결된 폴더가 더 이상 확장 폴더가 아닙니다. 다시 연결해 주세요.", "warn");
        return;
      }
      const outcome = await updateExtensionInPlace(handle);
      if (outcome.status === "updated") {
        notify(`확장이 v${outcome.version}(으)로 업데이트됐습니다.`, "ok");
      } else if (outcome.status === "manual-reload") {
        notify(
          `파일은 v${outcome.version}(으)로 교체했습니다. ${extensionsPage}에서 이 확장의 리로드(↻)를 한 번 눌러주세요 — 다음부터는 여기 버튼 한 번으로 끝납니다.`,
          "warn",
        );
      } else if (outcome.status === "wrong-folder") {
        notify(
          `리로드 후에도 실행 중인 버전이 그대로입니다. 연결한 폴더가 브라우저에 로드된 폴더가 아닌 것 같습니다 — ${extensionsPage}의 위치와 같은 폴더를 다시 연결해 주세요.`,
          "warn",
        );
      } else {
        notify(`업데이트 실패: ${outcome.reason}`, "warn");
      }
    } finally {
      updateBusy = false;
    }
  }

  async function disconnectUpdateDir(): Promise<void> {
    await clearExtensionDir();
    updateDirName = null;
    notify("폴더 연결을 해제했습니다.", "ok");
  }

  // The id is pinned by the manifest `key`, so it is the same on every install —
  // fetched rather than hardcoded so the guide can never drift from the bundle
  // the button actually hands out.
  async function loadExtensionMeta(): Promise<void> {
    if (extensionMetaLoaded) return;
    try {
      const meta = await api<{
        extensionId: string | null;
        origins: string[];
        multimediaNotice?: boolean;
        defaultAllowedOrigins?: string[];
      }>("/api/browser-extension");
      extensionId = meta.extensionId;
      extensionOrigins = meta.origins ?? [];
      extensionMultimediaNotice = Boolean(meta.multimediaNotice);
      serverDefaultOrigins = meta.defaultAllowedOrigins ?? [];
      // Mark loaded only on SUCCESS: a transient failure must not permanently pin
      // extensionId=null (the guide would show "id unavailable" with no retry).
      extensionMetaLoaded = true;
    } catch {
      // Non-fatal: leave extensionMetaLoaded false so re-activating the tab retries.
    }
  }

  // Fetched as a blob rather than navigating: the endpoint needs the session,
  // and a plain link would drop the fetch error handling and turn an auth
  // failure into a broken-looking download.
  async function downloadExtension(): Promise<void> {
    if (extensionBusy) return;
    extensionBusy = true;
    try {
      const res = await fetch("/api/browser-extension.zip", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "noah-browser-bridge.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify("확장 프로그램을 내려받았습니다. 압축을 풀고 설치 방법을 따라주세요.", "ok");
    } catch (err) {
      notify(`다운로드 실패: ${(err as Error).message}`, "warn");
    } finally {
      extensionBusy = false;
    }
  }

  $: if (active) {
    void loadExtensionMeta();
    void loadUpdateDirState();
  }

  // Deep link from the what's-new dialog: open the install guide as soon as
  // this tab is showing, then clear the one-shot flag.
  $: if (active && $appState.browserGuideRequested) {
    guideOpen = true;
    updateState((state) => (state.browserGuideRequested = false));
  }

  // The allowlist lives in the EXTENSION, not the server — it governs this one
  // browser. Loaded on demand rather than on mount so a page without the
  // extension installed doesn't show an editor it can't save.
  let allowLoaded = false;
  let allowBusy = false;
  let allowPatterns: string[] = [];
  let allowSource: AllowlistSource = "empty";
  let allowDraft = "";
  // 서버 기본 허용 사이트(BROWSER_ALLOWED_ORIGINS) — 빈 허용목록에는 채팅 화면이
  // 자동으로 적용하고, 여기서는 초안 채우기 버튼으로만 쓴다(저장은 항상 사용자
  // 클릭). Noah 자기 호스트를 덮는 항목은 서버가 이미 걸러서 내려준다.
  let serverDefaultOrigins: string[] = [];

  async function loadAllowlist(): Promise<void> {
    allowBusy = true;
    try {
      const reply = await readAllowedOrigins();
      if (!reply.ok) {
        notify(reply.message || "확장 프로그램에 연결하지 못했습니다.", "warn");
        return;
      }
      allowPatterns = reply.patterns ?? [];
      allowSource = reply.source ?? "empty";
      allowDraft = allowPatterns.join("\n");
      allowLoaded = true;
    } finally {
      allowBusy = false;
    }
  }

  async function saveAllowlist(): Promise<void> {
    allowBusy = true;
    try {
      const patterns = allowDraft
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      const reply = await writeAllowedOrigins(patterns);
      if (!reply.ok) {
        notify(reply.message || "허용 사이트를 저장하지 못했습니다.", "warn");
        return;
      }
      allowPatterns = reply.patterns ?? patterns;
      allowSource = reply.source ?? "empty";
      // Normalize the box to exactly what the extension stored, so what the
      // admin sees is what will actually be enforced.
      allowDraft = allowPatterns.join("\n");
      notify(
        allowPatterns.length
          ? `허용 사이트 ${allowPatterns.length}개를 저장했습니다.`
          : "허용 사이트를 비웠습니다. 모든 조작이 거부됩니다.",
        "ok",
      );
    } finally {
      allowBusy = false;
    }
  }

  // git identity
  let gitIdentityName = u0?.gitIdentityName || "";
  let gitIdentityEmail = u0?.gitIdentityEmail || "";
  let identitySaving = false;
  let identityError = "";
  let syncedIdentityUserId = u0?.id || "";

  // git token forms
  let internalToken = "";
  let externalToken = "";
  let internalBusy = false;
  let externalBusy = false;
  let internalError = "";
  let externalError = "";

  // preset secrets value inputs (keyed by name)
  let presetValues: Record<string, string> = {};
  let presetBusy: Record<string, boolean> = {};
  let presetErrors: Record<string, string> = {};

  // arbitrary secret form
  let extraName = "";
  let extraValue = "";
  let extraBusy = false;
  let extraError = "";
  let extraDeleting: Record<string, boolean> = {};

  let sshBusy = false;
  let sshError = "";
  let sshMessage = "";

  // experimental features (#50)
  let experimentalBusy = "";

  // per-secret agent-shell exposure toggle
  let shellExposeBusy = "";

  // per-secret 브라우저 입력 (browser secret input). Turning it ON is never a
  // one-click act: the allowed sites ARE the security policy, so the checkbox
  // only opens the inline editor and the PATCH waits for 저장.
  let browserFormFor = "";
  let browserHostsDraft = "";
  let browserPasswordOnly = true;
  let browserBusy = "";

  async function toggleShellExpose(name: string, on: boolean): Promise<void> {
    if (shellExposeBusy) return;
    shellExposeBusy = name;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ shellExpose: on }),
      });
      replaceState({ user: next });
      notify(
        on
          ? `${name} 시크릿을 아바타 셸에 노출합니다. 다음 대화부터 명령에서 $${name}으로 쓸 수 있습니다.`
          : `${name} 시크릿의 셸 노출을 껐습니다.`,
        "ok",
      );
    } catch (err) {
      notify(`셸 노출 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      shellExposeBusy = "";
    }
  }

  /** Only reads its ARGUMENT, so the template call stays correct under legacy untrack. */
  function browserSummary(policy: BrowserSecretPolicy): string {
    const where = policy.passwordOnly ? "비밀번호 필드만" : "모든 입력 필드";
    return `브라우저 입력: ${policy.hosts.join(", ")} · ${where}`;
  }

  /**
   * Comma / space / newline separated hosts → a list. Deliberately NO
   * client-side validation beyond splitting: `normalizeBrowserSecretHosts` on the
   * server is the single set of rules, and it is all-or-nothing, so a second
   * hand-mirrored copy here could disagree about which site is allowed.
   */
  function parseHostsDraft(raw: string): string[] {
    return raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function openBrowserForm(name: string, policy: BrowserSecretPolicy | undefined): void {
    browserFormFor = name;
    browserHostsDraft = (policy?.hosts || []).join(", ");
    browserPasswordOnly = policy ? policy.passwordOnly : true;
  }

  function closeBrowserForm(): void {
    browserFormFor = "";
    browserHostsDraft = "";
    browserPasswordOnly = true;
  }

  async function patchBrowserPolicy(
    name: string,
    browser: { enabled: boolean; hosts?: string[]; passwordOnly?: boolean },
    okMessage: string,
  ): Promise<void> {
    if (browserBusy) return;
    browserBusy = name;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ browser }),
      });
      replaceState({ user: next });
      if (browserFormFor === name) closeBrowserForm();
      notify(okMessage, "ok");
    } catch (err) {
      // The server owns host validation, so surface ITS text — it names the rule
      // that was broken (invalid host, none given, over the cap, reserved name).
      notify(`브라우저 입력 설정 실패: ${(err as Error).message}`, "warn");
    } finally {
      browserBusy = "";
    }
  }

  function saveBrowserPolicy(name: string): void {
    void patchBrowserPolicy(
      name,
      { enabled: true, hosts: parseHostsDraft(browserHostsDraft), passwordOnly: browserPasswordOnly },
      `${name} 시크릿을 지정한 사이트에서 브라우저 입력에 사용합니다.`,
    );
  }

  function toggleBrowserInput(
    name: string,
    on: boolean,
    policy: BrowserSecretPolicy | undefined,
  ): void {
    if (on) {
      openBrowserForm(name, policy);
      return;
    }
    // Unticking while the editor is open for a NEVER-enabled secret is a cancel,
    // not a disable: the box was only ticked to open the form, there is nothing
    // on the server to turn off, and "껐습니다" for something that was never on
    // tells the owner their vault changed when it did not.
    if (!policy) {
      if (browserFormFor === name) closeBrowserForm();
      return;
    }
    void patchBrowserPolicy(name, { enabled: false }, `${name} 시크릿의 브라우저 입력을 껐습니다.`);
  }
  const identityStatusId = "access-git-identity-status";
  const internalStatusId = "access-internal-token-status";
  const externalStatusId = "access-external-token-status";
  const extraStatusId = "access-extra-secret-status";
  const sshStatusId = "access-ssh-key-status";

  $: user = $appState.user;
  $: enabledExperimental = new Set(user?.experimentalFeatures || []);
  $: shellExposed = new Set(user?.shellExposedSecretNames || []);
  // A MAP the template reads DIRECTLY: a helper closing over `user` would be
  // untracked in legacy mode and render a stale policy (see client.md).
  $: browserPolicies = new Map<string, BrowserSecretPolicy>(
    (user?.browserSecrets || []).map((policy) => [policy.name, policy]),
  );
  $: sshStatus = sshBusy
    ? "SSH 키를 생성하는 중입니다."
    : sshError
      ? `SSH 키 생성 실패: ${sshError}`
      : sshMessage;

  async function toggleExperimental(key: string, on: boolean): Promise<void> {
    const current = new Set(readState().user?.experimentalFeatures || []);
    if (on) current.add(key);
    else current.delete(key);
    experimentalBusy = key;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ experimentalFeatures: [...current] }),
      });
      replaceState({ user: next });
      notify(`실험 기능을 ${on ? "켰습니다" : "껐습니다"}. 다음 대화부터 적용됩니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      experimentalBusy = "";
    }
  }
  $: internalSet = Boolean(user?.gitTokenSet);
  $: externalSet = Boolean(user?.secretNames.includes(EXTERNAL_GIT_TOKEN));
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: presetNames = new Set(SECRET_PRESETS.map((p) => p.name));
  // Git tokens have their own dedicated card — listing them here duplicated the
  // row and offered a second, competing delete path.
  $: extraSecretNames = (user?.secretNames || []).filter(
    (n) => !presetNames.has(n) && n !== INTERNAL_GIT_TOKEN && n !== EXTERNAL_GIT_TOKEN,
  );
  $: savedGitIdentityName = user?.gitIdentityName || "";
  $: savedGitIdentityEmail = user?.gitIdentityEmail || "";
  $: gitIdentityNameTrimmed = gitIdentityName.trim();
  $: gitIdentityEmailTrimmed = gitIdentityEmail.trim();
  $: identityDirty = Boolean(
    user &&
      (gitIdentityNameTrimmed !== savedGitIdentityName ||
        gitIdentityEmailTrimmed !== savedGitIdentityEmail),
  );
  $: identityStatus = identitySaving
    ? "저장 중…"
    : identityError
      ? `저장 실패: ${identityError}`
      : identityDirty
        ? "저장하지 않은 커밋 정보가 있습니다."
        : savedGitIdentityName || savedGitIdentityEmail
          ? "저장됨"
          : "저장 전";
  $: identityCanSave = Boolean(!identitySaving && identityDirty);
  $: if (user?.id && user.id !== syncedIdentityUserId && !identitySaving) {
    syncGitIdentityForm(user);
  }
  $: internalStatus = internalBusy
    ? "저장 중…"
    : internalError
      ? `저장 실패: ${internalError}`
      : internalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : internalSet
          ? "사내 Git 토큰이 설정되어 있습니다."
          : "사내 Git 토큰이 아직 없습니다.";
  $: externalStatus = externalBusy
    ? "저장 중…"
    : externalError
      ? `저장 실패: ${externalError}`
      : externalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : externalSet
          ? "외부 GitHub 토큰이 설정되어 있습니다."
          : "외부 GitHub 토큰이 아직 없습니다.";
  $: extraNameTrimmed = extraName.trim();
  $: extraHasValue = Boolean(extraValue.trim());
  $: extraNameValid = !extraNameTrimmed || SECRET_NAME_PATTERN.test(extraNameTrimmed);
  $: extraCanSave = Boolean(!extraBusy && extraNameTrimmed && extraHasValue && extraNameValid);
  $: extraStatus = extraBusy
    ? "저장 중…"
    : extraError
      ? extraError
      : !extraNameValid
        ? "이름 형식을 확인해 주세요."
        : !extraNameTrimmed && !extraHasValue
          ? "입력 대기"
          : !extraNameTrimmed
            ? "이름을 입력해 주세요."
            : !extraHasValue
              ? "값을 입력해 주세요."
              : "저장할 준비가 됐습니다.";

  function secretDomId(name: string, part: string): string {
    return `access-secret-${name.replace(/[^A-Za-z0-9_-]/g, "-")}-${part}`;
  }
  // Svelte 5 legacy mode compiles template FUNCTION CALLS inside untrack()
  // (preserving Svelte-4 compile-time dependency semantics), so a helper that
  // reads `presetValues` in its BODY never re-ran while typing — the 저장
  // button stayed disabled and the status label stale. Derive the per-preset
  // state up front and have the template read these maps DIRECTLY instead.
  $: presetFilled = Object.fromEntries(
    SECRET_PRESETS.map((p) => [p.name, Boolean(presetValues[p.name]?.trim())]),
  ) as Record<string, boolean>;
  $: presetStatusText = Object.fromEntries(
    SECRET_PRESETS.map((p) => {
      const isSet = Boolean(user?.secretNames.includes(p.name));
      const text = presetBusy[p.name]
        ? "저장 중…"
        : presetErrors[p.name]
          ? `저장 실패: ${presetErrors[p.name]}`
          : presetFilled[p.name]
            ? "저장할 값이 입력되었습니다."
            : isSet
              ? `${p.label} 시크릿이 설정되어 있습니다.`
              : `${p.label} 시크릿이 아직 없습니다.`;
      return [p.name, text];
    }),
  ) as Record<string, string>;
  function clearPresetError(name: string): void {
    if (!presetErrors[name]) return;
    presetErrors = { ...presetErrors, [name]: "" };
  }

  // ---- git tokens ----
  async function saveInternalToken(): Promise<void> {
    if (internalBusy) return;
    const token = internalToken.trim();
    if (!token) return;
    internalBusy = true;
    internalError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: next });
      internalToken = "";
      notify("사내 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      internalError = (err as Error).message;
      notify(`저장 실패: ${internalError}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function clearInternalToken(): Promise<void> {
    if (internalBusy) return;
    if (!(await confirmAction("사내 Git 토큰을 삭제할까요?"))) return;
    internalBusy = true;
    internalError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "DELETE" });
      replaceState({ user: next });
      notify("사내 Git 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function saveExternalToken(): Promise<void> {
    if (externalBusy) return;
    const token = externalToken.trim();
    if (!token) return;
    externalBusy = true;
    externalError = "";
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "PUT", body: JSON.stringify({ value: token }) });
      replaceState({ user: next });
      externalToken = "";
      notify("외부 GitHub 토큰을 저장했습니다.", "ok");
    } catch (err) {
      externalError = (err as Error).message;
      notify(`저장 실패: ${externalError}`, "warn");
    } finally {
      externalBusy = false;
    }
  }
  async function clearExternalToken(): Promise<void> {
    if (externalBusy) return;
    if (!(await confirmAction("외부 GitHub 토큰을 삭제할까요?"))) return;
    externalBusy = true;
    externalError = "";
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "DELETE" });
      replaceState({ user: next });
      notify("외부 GitHub 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      externalBusy = false;
    }
  }

  function syncGitIdentityForm(next: User): void {
    gitIdentityName = next.gitIdentityName || "";
    gitIdentityEmail = next.gitIdentityEmail || "";
    syncedIdentityUserId = next.id;
    identityError = "";
  }

  async function saveGitIdentity(): Promise<void> {
    if (identitySaving || !identityDirty) return;
    identitySaving = true;
    identityError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name: gitIdentityNameTrimmed || null, email: gitIdentityEmailTrimmed || null }),
      });
      syncGitIdentityForm(next);
      replaceState({ user: next });
      notify("커밋 정보를 저장했습니다.", "ok");
    } catch (err) {
      identityError = (err as Error).message;
      notify(`저장 실패: ${identityError}`, "warn");
    } finally {
      identitySaving = false;
    }
  }

  // ---- secrets ----
  async function savePresetSecret(name: string, label: string): Promise<void> {
    if (presetBusy[name]) return;
    const value = presetValues[name] || "";
    if (!value.trim()) {
      notify(`${label} 값을 입력해 주세요.`, "warn");
      return;
    }
    presetBusy = { ...presetBusy, [name]: true };
    presetErrors = { ...presetErrors, [name]: "" };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      presetValues = { ...presetValues, [name]: "" };
      notify(`${label} 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      presetErrors = { ...presetErrors, [name]: (err as Error).message };
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }
  async function clearPresetSecret(name: string, label: string): Promise<void> {
    if (presetBusy[name]) return;
    if (!(await confirmAction(`${label} 시크릿을 삭제할까요?`))) return;
    presetBusy = { ...presetBusy, [name]: true };
    presetErrors = { ...presetErrors, [name]: "" };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`${label} 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }

  async function saveExtraSecret(): Promise<void> {
    if (extraBusy) return;
    const name = extraNameTrimmed;
    const value = extraValue;
    extraError = "";
    if (!name || !value.trim()) {
      extraError = "시크릿 이름과 값을 모두 입력해 주세요.";
      notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
      return;
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      extraError = "이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.";
      notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
      return;
    }
    extraBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      extraName = "";
      extraValue = "";
      notify(`"${name}" 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      extraError = `저장 실패: ${(err as Error).message}`;
      notify(extraError, "warn");
    } finally {
      extraBusy = false;
    }
  }
  async function deleteExtraSecret(name: string): Promise<void> {
    if (extraDeleting[name]) return;
    if (!(await confirmAction(`"${name}" 시크릿을 삭제할까요?`))) return;
    extraDeleting = { ...extraDeleting, [name]: true };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`"${name}" 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      extraDeleting = { ...extraDeleting, [name]: false };
    }
  }

  async function generateSshKey(): Promise<void> {
    if (sshBusy) return;
    sshBusy = true;
    sshError = "";
    sshMessage = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      sshMessage = "SSH 키를 생성했습니다.";
      notify(sshMessage, "ok");
    } catch (err) {
      sshError = (err as Error).message;
      notify(`SSH 키 생성 실패: ${sshError}`, "warn");
    } finally {
      sshBusy = false;
    }
  }

  function copySshKey(event: MouseEvent): void {
    const btn = event.currentTarget as HTMLButtonElement;
    void copyText(user?.sshPublicKey || "", btn);
  }
</script>

<SettingsAvatarApiKeys active={active && Boolean(user)} />
<SettingsShareLinks active={active && Boolean(user)} />

{#if active && user}
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>브라우저 브릿지</h3>
        <p class="muted">
          확장 프로그램을 설치하면 아바타가 <strong>내 브라우저의 탭</strong>을 직접 열고 클릭할 수 있습니다.
          이미 로그인된 세션 그대로 동작하므로, 허용 사이트를 신중하게 정하세요.
        </p>
      </div>
    </div>
    <div class="browser-bridge-actions">
      <button type="button" class="btn primary" disabled={extensionBusy} on:click={downloadExtension}>
        <Icon name="file" />
        <span>{extensionBusy ? "준비 중…" : "확장 프로그램 다운로드"}</span>
      </button>
      <button type="button" class="btn ghost" on:click={() => (guideOpen = true)}>설치 방법 보기</button>
      <button type="button" class="btn ghost" disabled={allowBusy} on:click={loadAllowlist}>
        {allowLoaded ? "허용 사이트 새로고침" : "허용 사이트 불러오기"}
      </button>
    </div>

    {#if updateDirSupported}
      <div class="browser-bridge-actions">
        {#if updateDirName}
          <button type="button" class="btn primary" disabled={updateBusy} on:click={runOneClickUpdate}>
            {updateBusy ? "업데이트 중…" : "확장 원클릭 업데이트"}
          </button>
          <button type="button" class="btn ghost" disabled={updateBusy} on:click={disconnectUpdateDir}>
            폴더 연결 해제
          </button>
        {:else}
          <button type="button" class="btn ghost" on:click={connectUpdateDir}>
            확장 폴더 연결 (원클릭 업데이트)
          </button>
        {/if}
      </div>
      <p class="muted">
        {#if updateDirName}
          연결된 폴더: <code>{updateDirName}</code> — 버튼 한 번이면 파일 교체와 확장 리로드까지 끝납니다.
        {:else}
          압축을 푼 확장 폴더를 한 번 연결해 두면, 이후 버전 업데이트는 버튼 한 번입니다.
        {/if}
      </p>
    {/if}

    {#if allowLoaded}
      <div class="browser-allowlist">
        {#if allowSource === "managed"}
          <p class="muted">
            <strong>관리자 정책이 적용 중입니다.</strong> 이 브라우저의 허용 사이트는 조직에서 배포한
            목록이며 여기서 바꿀 수 없습니다.
          </p>
          <ul class="guide-origins">
            {#each allowPatterns as pattern (pattern)}
              <li><code>{pattern}</code></li>
            {/each}
          </ul>
        {:else}
          <label class="field">
            <span>아바타가 조작해도 되는 사이트 (한 줄에 하나)</span>
            <textarea
              bind:value={allowDraft}
              rows="4"
              spellcheck="false"
              placeholder={"intra.example.com\n*.corp.local"}
            ></textarea>
          </label>
          <p class="muted">
            정확한 호스트 또는 <code>*.도메인</code> 형태의 하위 도메인 와일드카드를 씁니다
            (<code>*.corp.local</code>은 <code>corp.local</code> 자체에는 적용되지 않아요).
            비워두면 모든 사이트가 거부됩니다.
          </p>
          {#if serverDefaultOrigins.length}
            <p class="muted">
              서버 기본값: {#each serverDefaultOrigins as origin, i (origin)}{i > 0 ? ", " : ""}<code
                >{origin}</code
              >{/each}
            </p>
          {/if}
          <div class="browser-bridge-actions">
            <button type="button" class="btn primary" disabled={allowBusy} on:click={saveAllowlist}>
              {allowBusy ? "저장 중…" : "허용 사이트 저장"}
            </button>
            {#if serverDefaultOrigins.length}
              <button
                type="button"
                class="btn"
                disabled={allowBusy}
                on:click={() => (allowDraft = serverDefaultOrigins.join("\n"))}
              >
                서버 기본값 채우기
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
  {#if guideOpen}
    <BrowserBridgeGuideModal
      extensionId={extensionId}
      origins={extensionOrigins}
      downloading={extensionBusy}
      multimediaNotice={extensionMultimediaNotice}
      on:download={downloadExtension}
      on:close={() => (guideOpen = false)}
    />
  {/if}

  <!-- 실험 기능 (#50) — hidden while no feature is in beta (the canvas graduated) -->
  {#if EXPERIMENTAL_FEATURES.length}
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>실험 기능</h3>
        <p class="muted">아직 다듬는 중인 베타 기능입니다. 기능마다 켜고 끌 수 있으며, 동작이 바뀔 수 있어요. 아바타도 어떤 실험 기능이 켜져 있는지 인지합니다.</p>
      </div>
    </div>
    <div class="experimental-list">
      {#each EXPERIMENTAL_FEATURES as feature (feature.key)}
        <label class="experimental-item">
          <input
            type="checkbox"
            checked={enabledExperimental.has(feature.key)}
            disabled={experimentalBusy === feature.key}
            on:change={(event) => toggleExperimental(feature.key, event.currentTarget.checked)}
          />
          <span class="experimental-meta">
            <strong>{feature.name} <span class="tag accent experimental-badge">실험</span></strong>
            <span class="muted">{feature.description}</span>
          </span>
        </label>
      {/each}
    </div>
  </section>
  {/if}

  <!-- Git 자격증명 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>Git 자격증명</h3>
        <p class="muted">사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
      </div>
    </div>
    <form class="secret-preset-row" aria-busy={internalBusy} on:submit|preventDefault={saveInternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>사내 Git 토큰</strong>
          <code>{INTERNAL_GIT_TOKEN}</code>
          <span class={internalSet ? "muted token-set" : "muted"}>{internalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">지식 저장소 생성·푸시와 사내({githubHost}) 비공개 저장소 접근에 사용해요.</p>
      </div>
      <RevealableInput bind:value={internalToken} name="internalToken" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" ariaDescribedby={internalStatusId} ariaInvalid={Boolean(internalError)} revealLabel="토큰" disabled={internalBusy} onInput={() => (internalError = "")} />
      <div class="secret-preset-actions">
        <span id={internalStatusId} class="settings-save-status" class:dirty={Boolean(internalToken.trim() && !internalBusy && !internalError)} class:pending={internalBusy} class:invalid={Boolean(internalError)} role="status" aria-live="polite">{internalStatus}</span>
        <button class="primary" type="submit" disabled={internalBusy || !internalToken.trim()}>{internalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!internalSet || internalBusy} on:click={clearInternalToken}>삭제</button>
      </div>
    </form>

    <form class="secret-preset-row" aria-busy={externalBusy} on:submit|preventDefault={saveExternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>외부 GitHub 토큰</strong>
          <code>{EXTERNAL_GIT_TOKEN}</code>
          <span class={externalSet ? "muted token-set" : "muted"}>{externalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">github.com HTTPS 저장소 접근에만 사용해요. 지식 저장소 생성·푸시에는 쓰이지 않아요.</p>
      </div>
      <RevealableInput bind:value={externalToken} name="externalToken" placeholder="github.com PAT (GITHUB_TOKEN)" ariaLabel="외부 GitHub 토큰 GITHUB_TOKEN" ariaDescribedby={externalStatusId} ariaInvalid={Boolean(externalError)} revealLabel="토큰" disabled={externalBusy} onInput={() => (externalError = "")} />
      <div class="secret-preset-actions">
        <span id={externalStatusId} class="settings-save-status" class:dirty={Boolean(externalToken.trim() && !externalBusy && !externalError)} class:pending={externalBusy} class:invalid={Boolean(externalError)} role="status" aria-live="polite">{externalStatus}</span>
        <button class="primary" type="submit" disabled={externalBusy || !externalToken.trim()}>{externalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!externalSet || externalBusy} on:click={clearExternalToken}>삭제</button>
      </div>
    </form>

    <div class="secret-extra-head">
      <strong>커밋 정보</strong>
      <p class="muted">아바타가 만드는 커밋의 작성자 이름·이메일입니다. 비우면 기본값을 사용해요.</p>
    </div>
    <form class="settings-form" on:submit|preventDefault={saveGitIdentity}>
      <div class="field-row-2col">
        <label class="field"><span>커밋 이름</span><input bind:value={gitIdentityName} placeholder={user.alias || user.displayName || ""} aria-describedby={identityStatusId} aria-invalid={identityError ? "true" : undefined} disabled={identitySaving} on:input={() => (identityError = "")} /></label>
        <label class="field"><span>커밋 이메일</span><input type="email" bind:value={gitIdentityEmail} placeholder={`${user.username}@example.com`} aria-describedby={identityStatusId} aria-invalid={identityError ? "true" : undefined} disabled={identitySaving} on:input={() => (identityError = "")} /></label>
      </div>
      <div class="settings-save-row">
        <span id={identityStatusId} class="settings-save-status" class:dirty={identityDirty && !identitySaving && !identityError} class:pending={identitySaving} class:invalid={Boolean(identityError)} role="status" aria-live="polite">{identityStatus}</span>
        <button class="primary" type="submit" disabled={!identityCanSave}>{identitySaving ? "저장 중…" : "커밋 정보 저장"}</button>
      </div>
    </form>
  </section>

  <!-- 시크릿 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>시크릿</h3>
        <p class="muted">내 아바타의 도구에만 주입되는 시크릿 값입니다. 암호화되어 저장되고 다시 표시되지 않습니다.</p>
      </div>
    </div>
    <ul class="hint-list">
      <li>직접 등록한 플러그인·지식 저장소의 <code>.mcp.json</code> MCP 서버에 환경변수로 주입돼요 — 본인·같은 그룹원과의 대화에서만.</li>
      <li><strong>셸 노출</strong>을 켜면 셸(Bash)에서 같은 이름의 환경변수로도 쓸 수 있어요. 필요한 키만 켜세요.</li>
      <li><strong>브라우저 입력</strong>을 켜면 아바타가 브라우저 확장을 통해 이 시크릿을 지정한 사이트의 로그인 필드에 이름으로 입력할 수 있어요. 값은 아바타에게 보이지 않고, 지정한 사이트 밖에서는 거부되며, 브라우저 세션마다 처음 한 번 브라우저에서 확인해요(그 한 번이 허용해 둔 모든 사이트에 적용돼요).</li>
      <li>도구 출력에 값이 나타나면 자동으로 가려져요.</li>
      <li>GIT_TOKEN·GITHUB_TOKEN·SSH 계열은 전용 경로로만 쓰이고, 그룹 저장소 MCP 서버·일반 사용자 대화에는 어떤 시크릿도 주입되지 않아요.</li>
    </ul>

    <div class="secret-preset-list">
      {#each SECRET_PRESETS as preset}
        {@const isSet = user.secretNames.includes(preset.name)}
        {@const presetStatusId = secretDomId(preset.name, "status")}
        <form class="secret-preset-row" aria-busy={presetBusy[preset.name]} on:submit|preventDefault={() => savePresetSecret(preset.name, preset.label)}>
          <div class="secret-preset-meta">
            <div class="secret-preset-title">
              <strong>{preset.label}</strong>
              <code>{preset.name}</code>
              {#if isSet}<span class="muted token-set">● 설정됨</span>{:else}<span class="muted">미설정</span>{/if}
            </div>
            <p class="muted">{preset.description}</p>
          </div>
          <textarea
            rows={preset.rows}
            placeholder={preset.placeholder}
            autocomplete="off"
            aria-label={`${preset.label} 값`}
            aria-describedby={presetStatusId}
            aria-invalid={presetErrors[preset.name] ? "true" : undefined}
            bind:value={presetValues[preset.name]}
            disabled={presetBusy[preset.name]}
            on:input={() => clearPresetError(preset.name)}
          ></textarea>
          <div class="secret-preset-actions">
            <span id={presetStatusId} class="settings-save-status" class:dirty={Boolean(presetFilled[preset.name] && !presetBusy[preset.name] && !presetErrors[preset.name])} class:pending={Boolean(presetBusy[preset.name])} class:invalid={Boolean(presetErrors[preset.name])} role="status" aria-live="polite">{presetStatusText[preset.name]}</span>
            {#if isSet && isShellExposableSecret(preset.name)}
              <label class="shell-expose-toggle" title="켜면 이 값이 아바타 셸(Bash) 환경변수로도 주입됩니다 (본인·신뢰하는 그룹원 대화에서만, 도구 출력에서는 자동 가려짐)">
                <input
                  type="checkbox"
                  checked={shellExposed.has(preset.name)}
                  disabled={shellExposeBusy === preset.name}
                  on:change={(event) => toggleShellExpose(preset.name, event.currentTarget.checked)}
                />
                <span class="muted">셸 노출</span>
              </label>
            {/if}
            {#if isSet && isBrowserExposableSecret(preset.name)}
              {@const browserPolicy = browserPolicies.get(preset.name)}
              <label class="browser-input-toggle" title="켜면 아바타가 브라우저 확장을 통해 이 시크릿을 지정한 사이트의 입력 필드에 넣을 수 있습니다 (값은 아바타에게 보이지 않고, 지정한 사이트 밖에서는 거부됩니다)">
                <input
                  type="checkbox"
                  checked={Boolean(browserPolicy) || browserFormFor === preset.name}
                  disabled={browserBusy === preset.name}
                  on:change={(event) => toggleBrowserInput(preset.name, event.currentTarget.checked, browserPolicy)}
                />
                <span class="muted">브라우저 입력</span>
              </label>
            {/if}
            <button class="primary" type="submit" disabled={presetBusy[preset.name] || !presetFilled[preset.name]}>{isSet ? "교체" : "저장"}</button>
            <button class="linkish small" type="button" disabled={!isSet || presetBusy[preset.name]} on:click={() => clearPresetSecret(preset.name, preset.label)}>삭제</button>
            {#if isSet && isBrowserExposableSecret(preset.name)}
              {@const browserPolicy = browserPolicies.get(preset.name)}
              {#if browserFormFor === preset.name}
                <div class="browser-input-box">
                  <label class="field browser-input-hosts">
                    <span>허용 사이트(호스트)</span>
                    <input
                      bind:value={browserHostsDraft}
                      placeholder="jira.corp.com, login.corp.com"
                      autocomplete="off"
                      spellcheck="false"
                      disabled={browserBusy === preset.name}
                      on:keydown={(event) => {
                        // Enter saves the POLICY. In a preset row this input sits
                        // inside the <form> that saves the secret VALUE, so the
                        // default submit has to be stopped.
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        saveBrowserPolicy(preset.name);
                      }}
                    />
                  </label>
                  <label class="browser-input-toggle">
                    <input type="checkbox" bind:checked={browserPasswordOnly} disabled={browserBusy === preset.name} />
                    <span class="muted">비밀번호 필드에만 입력</span>
                  </label>
                  <div class="browser-input-actions">
                    <button class="btn primary sm" type="button" disabled={browserBusy === preset.name} on:click={() => saveBrowserPolicy(preset.name)}>{browserBusy === preset.name ? "저장 중…" : "저장"}</button>
                    <button class="btn sm" type="button" disabled={browserBusy === preset.name} on:click={closeBrowserForm}>취소</button>
                  </div>
                </div>
              {:else if browserPolicy}
                <div class="browser-input-box">
                  <span class="muted browser-input-summary">{browserSummary(browserPolicy)}</span>
                  <button class="btn sm" type="button" disabled={browserBusy === preset.name} on:click={() => openBrowserForm(preset.name, browserPolicy)}>편집</button>
                </div>
              {/if}
            {/if}
          </div>
        </form>
      {/each}
    </div>

    <div class="secret-extra-head">
      <strong>SSH 키</strong>
      <p class="muted">키 쌍을 만들어 개인키는 SSH_PRIVATE_KEY 시크릿에 저장하고, 공개키를 여기에 표시합니다. 원격 서버에는 공개키를 등록하세요.</p>
    </div>
    {#if user.sshPublicKey}
      <div class="ssh-public-key-box">
        <label class="field ssh-public-key-field">
          <span>SSH 공개키</span>
          <div class="ssh-public-key-row">
            <textarea rows="3" readonly value={user.sshPublicKey}></textarea>
            <button class="msg-act" type="button" aria-label="SSH 공개키 복사" title="SSH 공개키 복사" on:click={copySshKey}><Icon name="copy" /></button>
          </div>
        </label>
      </div>
    {:else}
      <button class="primary" type="button" aria-describedby={sshStatus ? sshStatusId : undefined} disabled={sshBusy} on:click={generateSshKey}>{sshBusy ? "생성 중…" : "SSH 키 생성"}</button>
    {/if}
    {#if sshStatus}
      <div class="settings-save-row compact">
        <span id={sshStatusId} class="settings-save-status" class:pending={sshBusy} class:success={Boolean(sshMessage)} class:invalid={Boolean(sshError)} role="status" aria-live="polite">{sshStatus}</span>
      </div>
    {/if}

    <div class="secret-extra-head">
      <strong>기타 시크릿</strong>
      <p class="muted">도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요.</p>
    </div>
    <div class="secret-list">
      {#if !extraSecretNames.length}
        <div class="empty-note">추가 시크릿이 없습니다.</div>
      {:else}
        {#each extraSecretNames as name (name)}
          <div class="secret-row">
            <code>{name}</code>
            <span class="muted token-set">● 설정됨</span>
            {#if isShellExposableSecret(name)}
              <label class="shell-expose-toggle" title="켜면 이 값이 아바타 셸(Bash) 환경변수로도 주입됩니다 (본인·신뢰하는 그룹원 대화에서만, 도구 출력에서는 자동 가려짐)">
                <input
                  type="checkbox"
                  checked={shellExposed.has(name)}
                  disabled={shellExposeBusy === name}
                  on:change={(event) => toggleShellExpose(name, event.currentTarget.checked)}
                />
                <span class="muted">셸 노출</span>
              </label>
            {/if}
            {#if isBrowserExposableSecret(name)}
              {@const browserPolicy = browserPolicies.get(name)}
              <label class="browser-input-toggle" title="켜면 아바타가 브라우저 확장을 통해 이 시크릿을 지정한 사이트의 입력 필드에 넣을 수 있습니다 (값은 아바타에게 보이지 않고, 지정한 사이트 밖에서는 거부됩니다)">
                <input
                  type="checkbox"
                  checked={Boolean(browserPolicy) || browserFormFor === name}
                  disabled={browserBusy === name}
                  on:change={(event) => toggleBrowserInput(name, event.currentTarget.checked, browserPolicy)}
                />
                <span class="muted">브라우저 입력</span>
              </label>
            {/if}
            <button class="linkish small" type="button" aria-label={`시크릿 삭제: ${name}`} disabled={extraDeleting[name]} on:click={() => deleteExtraSecret(name)}>삭제</button>
            {#if isBrowserExposableSecret(name)}
              {@const browserPolicy = browserPolicies.get(name)}
              {#if browserFormFor === name}
                <div class="browser-input-box">
                  <label class="field browser-input-hosts">
                    <span>허용 사이트(호스트)</span>
                    <input
                      bind:value={browserHostsDraft}
                      placeholder="jira.corp.com, login.corp.com"
                      autocomplete="off"
                      spellcheck="false"
                      disabled={browserBusy === name}
                      on:keydown={(event) => {
                        // Enter saves the POLICY. In a preset row this input sits
                        // inside the <form> that saves the secret VALUE, so the
                        // default submit has to be stopped.
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        saveBrowserPolicy(name);
                      }}
                    />
                  </label>
                  <label class="browser-input-toggle">
                    <input type="checkbox" bind:checked={browserPasswordOnly} disabled={browserBusy === name} />
                    <span class="muted">비밀번호 필드에만 입력</span>
                  </label>
                  <div class="browser-input-actions">
                    <button class="btn primary sm" type="button" disabled={browserBusy === name} on:click={() => saveBrowserPolicy(name)}>{browserBusy === name ? "저장 중…" : "저장"}</button>
                    <button class="btn sm" type="button" disabled={browserBusy === name} on:click={closeBrowserForm}>취소</button>
                  </div>
                </div>
              {:else if browserPolicy}
                <div class="browser-input-box">
                  <span class="muted browser-input-summary">{browserSummary(browserPolicy)}</span>
                  <button class="btn sm" type="button" disabled={browserBusy === name} on:click={() => openBrowserForm(name, browserPolicy)}>편집</button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    <form class="settings-form" on:submit|preventDefault={saveExtraSecret}>
      <label class="field"><span>이름</span><input bind:value={extraName} placeholder="SSH_PRIVATE_KEY" autocomplete="off" required aria-describedby={extraStatusId} aria-invalid={extraNameValid ? undefined : "true"} disabled={extraBusy} on:input={() => (extraError = "")} /></label>
      <label class="field"><span>값</span><textarea rows="4" bind:value={extraValue} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…" autocomplete="off" required aria-describedby={extraStatusId} disabled={extraBusy} on:input={() => (extraError = "")}></textarea></label>
      <div class="settings-save-row">
        <span id={extraStatusId} class="settings-save-status" class:dirty={Boolean(extraNameTrimmed && extraHasValue && extraNameValid && !extraBusy && !extraError)} class:pending={extraBusy} class:invalid={!extraNameValid || Boolean(extraError)} role="status" aria-live="polite">{extraStatus}</span>
        <button class="primary" type="submit" disabled={!extraCanSave}>{extraBusy ? "저장 중…" : "추가 시크릿 저장"}</button>
      </div>
    </form>
  </section>
{/if}

<style>
  .experimental-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .experimental-item {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    cursor: pointer;
  }
  .experimental-item input {
    margin-top: var(--s-1);
  }
  .experimental-meta {
    display: flex;
    flex-direction: column;
    gap: var(--s-0-5);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .shell-expose-toggle,
  .browser-input-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    cursor: pointer;
    white-space: nowrap;
    min-height: 32px;
  }
  /* Takes a full line of the WRAPPING flex row it lives in (.secret-preset-actions
     / .secret-row), so the allowed-sites editor never squeezes the row's buttons
     onto a third line. */
  .browser-input-box {
    flex: 1 0 100%;
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-3);
    margin-top: var(--s-1);
    padding-top: var(--s-3);
    border-top: 1px dashed var(--line-soft);
  }
  .browser-input-hosts {
    flex: 1 1 240px;
    min-width: 0;
  }
  .browser-input-summary {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--t-xs);
    overflow-wrap: anywhere;
  }
  .browser-input-actions {
    display: flex;
    flex: none;
    gap: var(--s-2);
  }
  /* Composes the global `.tag accent` base; only the deltas that make it read as
     a label riding inside a <strong> heading live here. */
  .browser-allowlist {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    margin-top: var(--s-4);
    padding-top: var(--s-4);
    border-top: 1px solid var(--line-soft);
  }
  .browser-allowlist textarea {
    width: 100%;
    resize: vertical;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .browser-bridge-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.9rem;
  }
  .experimental-badge {
    font-weight: 600;
    vertical-align: middle;
  }
</style>
