import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import SettingsAvatarApiKeys from "./SettingsAvatarApiKeys";
import SettingsShareLinks from "./SettingsShareLinks";
import Icon from "./Icon";
import BrowserBridgeGuideModal from "./BrowserBridgeGuideModal";
import RevealableInput from "./RevealableInput";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx, useAppState } from "../lib/hooks";
import { Presence } from "../lib/presence";
import { notify, readState, replaceState, updateState } from "../lib/state";
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
import type { SharedMcpServerUserView, User } from "../lib/types";
import "./SettingsAccessTab.css";

export interface SettingsAccessTabProps {
  active?: boolean;
}

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
const presetNames = new Set(SECRET_PRESETS.map((p) => p.name));

const identityStatusId = "access-git-identity-status";
const internalStatusId = "access-internal-token-status";
const externalStatusId = "access-external-token-status";
const extraStatusId = "access-extra-secret-status";
const sshStatusId = "access-ssh-key-status";

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

function secretDomId(name: string, part: string): string {
  return `access-secret-${name.replace(/[^A-Za-z0-9_-]/g, "-")}-${part}`;
}

/**
 * State the markup shows AND code that runs later reads (after an `await`, in
 * a guard against a second call): `ref.current` is always the value last set,
 * where the value a function closed over is the one of the render that made it.
 */
function useLiveState<T>(
  initial: T | (() => T),
): [T, (next: T | ((previous: T) => T)) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useRef((next: T | ((previous: T) => T)): void => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(ref.current) : next;
    ref.current = resolved;
    setValue(resolved);
  }).current;
  return [value, set, ref];
}

/**
 * A checkbox that is TOLD its value but does not hold it: `checked` is written
 * to the element only when the value changes, so between the click and the
 * answer the box shows what the user ticked — the one-way `checked={…}` +
 * change handler these controls have always been (a save that fails leaves the
 * tick where the user put it until the value next changes).
 */
function OneWayCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.checked = checked;
  }, [checked]);
  return (
    <input ref={ref} type="checkbox" disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
  );
}

/**
 * The same for a <select>: the bound secret is selected when it changes (or
 * when the option list does), and a pick stays on screen while it is saved.
 */
function OneWaySelect({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  ariaLabel: string;
  onChange: (select: HTMLSelectElement) => void;
}) {
  const ref = useRef<HTMLSelectElement | null>(null);
  const optionsKey = options.join("\n");
  useLayoutEffect(() => {
    // No matching option selects nothing, as before.
    if (ref.current) ref.current.value = value;
  }, [value, optionsKey]);
  return (
    <select ref={ref} disabled={disabled} aria-label={ariaLabel} onChange={(event) => onChange(event.currentTarget)}>
      <option value="">연결 안 함</option>
      {options.map((name, index) => (
        <option key={index} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

export default function SettingsAccessTab({ active = false }: SettingsAccessTabProps) {
  const state = useAppState();
  const [u0] = useState(() => readState().user);

  // Browser bridge install/update state.
  const [extensionsPage] = useState(extensionsPageUrl);
  const [guideOpen, setGuideOpen] = useState(false);
  const [extensionBusy, setExtensionBusy, extensionBusyRef] = useLiveState(false);
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [extensionOrigins, setExtensionOrigins] = useState<string[]>([]);
  const [extensionMultimediaNotice, setExtensionMultimediaNotice] = useState(false);
  const extensionMetaLoaded = useRef(false);

  // One-click updater (File System Access): the folder handle picked at setup
  // lives in IndexedDB; permission is re-confirmed inside each button gesture.
  const [updateDirSupported] = useState(fsaSupported);
  const [updateDirName, setUpdateDirName] = useState<string | null>(null);
  const updateDirLoaded = useRef(false);
  const [updateBusy, setUpdateBusy, updateBusyRef] = useLiveState(false);

  async function loadUpdateDirState(): Promise<void> {
    if (updateDirLoaded.current || !updateDirSupported) return;
    updateDirLoaded.current = true;
    const handle = await loadSavedExtensionDir();
    setUpdateDirName(handle ? (handle.name ?? "연결된 폴더") : null);
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
    setUpdateDirName(handle.name ?? "연결된 폴더");
    notify("확장 폴더를 연결했습니다. 이제 버전 업데이트는 버튼 한 번입니다.", "ok");
  }

  async function runOneClickUpdate(): Promise<void> {
    if (updateBusyRef.current) return;
    setUpdateBusy(true);
    try {
      const handle = await loadSavedExtensionDir();
      if (!handle) {
        setUpdateDirName(null);
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
      setUpdateBusy(false);
    }
  }

  async function disconnectUpdateDir(): Promise<void> {
    await clearExtensionDir();
    setUpdateDirName(null);
    notify("폴더 연결을 해제했습니다.", "ok");
  }

  // The id is pinned by the manifest `key`, so it is the same on every install —
  // fetched rather than hardcoded so the guide can never drift from the bundle
  // the button actually hands out.
  async function loadExtensionMeta(): Promise<void> {
    if (extensionMetaLoaded.current) return;
    try {
      const meta = await api<{
        extensionId: string | null;
        origins: string[];
        multimediaNotice?: boolean;
        defaultAllowedOrigins?: string[];
      }>("/api/browser-extension");
      setExtensionId(meta.extensionId);
      setExtensionOrigins(meta.origins ?? []);
      setExtensionMultimediaNotice(Boolean(meta.multimediaNotice));
      setServerDefaultOrigins(meta.defaultAllowedOrigins ?? []);
      // Mark loaded only on SUCCESS: a transient failure must not permanently pin
      // extensionId=null (the guide would show "id unavailable" with no retry).
      extensionMetaLoaded.current = true;
    } catch {
      // Non-fatal: leave extensionMetaLoaded false so re-activating the tab retries.
    }
  }

  // Fetched as a blob rather than navigating: the endpoint needs the session,
  // and a plain link would drop the fetch error handling and turn an auth
  // failure into a broken-looking download.
  async function downloadExtension(): Promise<void> {
    if (extensionBusyRef.current) return;
    setExtensionBusy(true);
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
      setExtensionBusy(false);
    }
  }

  useEffect(() => {
    if (active) {
      void loadExtensionMeta();
      void loadUpdateDirState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Deep link from the what's-new dialog: open the install guide as soon as
  // this tab is showing, then clear the one-shot flag. The guide opens in the
  // SAME render that sees the flag (so it is on screen with the tab, and a tab
  // that opens with its guide does not animate it in); the flag is a store
  // write, so it is cleared after the render.
  const guideRequested = active && state.browserGuideRequested;
  if (guideRequested && !guideOpen) setGuideOpen(true);
  useEffect(() => {
    if (guideRequested) updateState((state) => (state.browserGuideRequested = false));
  }, [guideRequested]);

  // The allowlist lives in the EXTENSION, not the server — it governs this one
  // browser. Loaded on demand rather than on mount so a page without the
  // extension installed doesn't show an editor it can't save.
  const [allowLoaded, setAllowLoaded] = useState(false);
  const [allowBusy, setAllowBusy] = useState(false);
  const [allowPatterns, setAllowPatterns] = useState<string[]>([]);
  const [allowSource, setAllowSource] = useState<AllowlistSource>("empty");
  const [allowDraft, setAllowDraft] = useState("");
  // 서버 기본 허용 사이트(BROWSER_ALLOWED_ORIGINS) — 빈 허용목록에는 채팅 화면이
  // 자동으로 적용하고, 여기서는 초안 채우기 버튼으로만 쓴다(저장은 항상 사용자
  // 클릭). Noah 자기 호스트를 덮는 항목은 서버가 이미 걸러서 내려준다.
  const [serverDefaultOrigins, setServerDefaultOrigins] = useState<string[]>([]);

  async function loadAllowlist(): Promise<void> {
    setAllowBusy(true);
    try {
      const reply = await readAllowedOrigins();
      if (!reply.ok) {
        notify(reply.message || "확장 프로그램에 연결하지 못했습니다.", "warn");
        return;
      }
      const stored = reply.patterns ?? [];
      setAllowPatterns(stored);
      setAllowSource(reply.source ?? "empty");
      setAllowDraft(stored.join("\n"));
      setAllowLoaded(true);
    } finally {
      setAllowBusy(false);
    }
  }

  async function saveAllowlist(): Promise<void> {
    setAllowBusy(true);
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
      const stored = reply.patterns ?? patterns;
      setAllowPatterns(stored);
      setAllowSource(reply.source ?? "empty");
      // Normalize the box to exactly what the extension stored, so what the
      // admin sees is what will actually be enforced.
      setAllowDraft(stored.join("\n"));
      notify(
        stored.length
          ? `허용 사이트 ${stored.length}개를 저장했습니다.`
          : "허용 사이트를 비웠습니다. 모든 조작이 거부됩니다.",
        "ok",
      );
    } finally {
      setAllowBusy(false);
    }
  }

  // git identity
  const [gitIdentityName, setGitIdentityName] = useState(u0?.gitIdentityName || "");
  const [gitIdentityEmail, setGitIdentityEmail] = useState(u0?.gitIdentityEmail || "");
  const [identitySaving, setIdentitySaving, identitySavingRef] = useLiveState(false);
  const [identityError, setIdentityError] = useState("");
  const syncedIdentityUserId = useRef(u0?.id || "");

  // git token forms
  const [internalToken, setInternalToken] = useState("");
  const [externalToken, setExternalToken] = useState("");
  const [internalBusy, setInternalBusy, internalBusyRef] = useLiveState(false);
  const [externalBusy, setExternalBusy, externalBusyRef] = useLiveState(false);
  const [internalError, setInternalError] = useState("");
  const [externalError, setExternalError] = useState("");

  // preset secrets value inputs (keyed by name)
  const [presetValues, setPresetValues] = useLiveState<Record<string, string>>({});
  const [presetBusy, setPresetBusy, presetBusyRef] = useLiveState<Record<string, boolean>>({});
  const [presetErrors, setPresetErrors, presetErrorsRef] = useLiveState<Record<string, string>>({});

  const user = state.user;

  // arbitrary secret form
  // 공용 MCP 서버 the admin registered: each credential slot shows which of MY
  // secrets I connected to it. Connecting is my consent for that secret to be
  // sent to the server's host — the admin never names a secret.
  const [sharedMcpServers, setSharedMcpServers, sharedMcpServersRef] = useLiveState<SharedMcpServerUserView[]>([]);
  const [sharedMcpBusy, setSharedMcpBusy, sharedMcpBusyRef] = useLiveState<Record<string, boolean>>({});
  // Reload on every activation of the tab: the admin may have added, moved or
  // re-slotted a server since this (always-mounted) tab last looked.
  const sharedMcpWasActive = useRef(false);
  useEffect(() => {
    if (active !== sharedMcpWasActive.current) {
      sharedMcpWasActive.current = active;
      if (active) void loadSharedMcpServers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // …and whenever my secret list changes: deleting a secret drops its
  // bindings server-side, so a re-added name must not still read as connected.
  const sharedMcpSecretsKey = useRef("");
  const secretsKey = (user?.secretNames || []).join(",");
  useEffect(() => {
    const key = secretsKey;
    if (key !== sharedMcpSecretsKey.current) {
      const changed = sharedMcpSecretsKey.current !== "" || sharedMcpServersRef.current.length > 0;
      sharedMcpSecretsKey.current = key;
      if (active && changed) void loadSharedMcpServers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretsKey]);
  const sharedMcpSlotted = sharedMcpServers.filter((server) => server.slots.length > 0);
  const bindableSecretNames = (user?.secretNames || []).filter(isShellExposableSecret);

  async function loadSharedMcpServers(): Promise<void> {
    try {
      // A reply without the list (an older server, a stubbed fetch) reads as
      // "no servers" — never `undefined`, which the slotted filter would throw on.
      setSharedMcpServers((await api<{ servers?: SharedMcpServerUserView[] }>("/api/me/shared-mcp-servers")).servers ?? []);
    } catch {
      // Informational only: the card works without the list.
      setSharedMcpServers([]);
    }
  }

  async function bindSharedMcpSlot(
    server: SharedMcpServerUserView,
    slot: SharedMcpServerUserView["slots"][number],
    select: HTMLSelectElement,
  ): Promise<void> {
    const slotId = slot.id;
    const secretName = select.value;
    const key = `${server.name}/${slotId}`;
    if (sharedMcpBusyRef.current[key]) return;
    setSharedMcpBusy((busy) => ({ ...busy, [key]: true }));
    try {
      const path = `/api/me/shared-mcp-servers/${encodeURIComponent(server.name)}/slots/${encodeURIComponent(slotId)}`;
      const result = await api<{ servers?: SharedMcpServerUserView[] }>(
        path,
        secretName ? { method: "PUT", body: JSON.stringify({ secretName }) } : { method: "DELETE" },
      );
      setSharedMcpServers((servers) => result.servers ?? servers);
      notify(
        secretName
          ? `${secretName} 시크릿을 ${server.label}에 연결했습니다. 다음 메시지부터 ${server.origin}로 전송됩니다.`
          : `${server.label} 연결을 해제했습니다.`,
        "ok",
      );
    } catch (err) {
      notify(`연결 실패: ${(err as Error).message}`);
      // The rendered `value` did not change, so the DOM keeps the rejected
      // pick unless it is put back by hand.
      select.value = slot.boundSecret ?? "";
    } finally {
      setSharedMcpBusy((busy) => ({ ...busy, [key]: false }));
    }
  }

  function addSecretForShared(server: SharedMcpServerUserView): void {
    setExtraName(`${server.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`);
    setExtraError("");
    requestAnimationFrame(() => document.getElementById("secret-extra-value")?.focus());
  }

  const [extraName, setExtraName] = useState("");
  const [extraValue, setExtraValue] = useState("");
  const [extraBusy, setExtraBusy, extraBusyRef] = useLiveState(false);
  const [extraError, setExtraError] = useState("");
  const [extraDeleting, setExtraDeleting, extraDeletingRef] = useLiveState<Record<string, boolean>>({});

  const [sshBusy, setSshBusy, sshBusyRef] = useLiveState(false);
  const [sshError, setSshError] = useState("");
  const [sshMessage, setSshMessage] = useState("");

  // experimental features (#50)
  const [experimentalBusy, setExperimentalBusy] = useState("");

  // per-secret agent-shell exposure toggle
  const [shellExposeBusy, setShellExposeBusy, shellExposeBusyRef] = useLiveState("");

  // per-secret 브라우저 입력 (browser secret input). Turning it ON is never a
  // one-click act: the allowed sites ARE the security policy, so the checkbox
  // only opens the inline editor and the PATCH waits for 저장.
  const [browserFormFor, setBrowserFormFor, browserFormForRef] = useLiveState("");
  const [browserHostsDraft, setBrowserHostsDraft, browserHostsDraftRef] = useLiveState("");
  const [browserPasswordOnly, setBrowserPasswordOnly, browserPasswordOnlyRef] = useLiveState(true);
  const [browserBusy, setBrowserBusy, browserBusyRef] = useLiveState("");

  async function toggleShellExpose(name: string, on: boolean): Promise<void> {
    if (shellExposeBusyRef.current) return;
    setShellExposeBusy(name);
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ shellExpose: on }),
      });
      replaceState({ user: next });
      notify(
        on
          ? `${name} 시크릿을 아바타 셸에 노출합니다. 다음 메시지부터 내 대화·루틴·API 작업의 명령에서 $${name}으로 쓸 수 있습니다.`
          : `${name} 시크릿의 셸 노출을 껐습니다.`,
        "ok",
      );
    } catch (err) {
      notify(`셸 노출 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      setShellExposeBusy("");
    }
  }

  function openBrowserForm(name: string, policy: BrowserSecretPolicy | undefined): void {
    setBrowserFormFor(name);
    setBrowserHostsDraft((policy?.hosts || []).join(", "));
    setBrowserPasswordOnly(policy ? policy.passwordOnly : true);
  }

  function closeBrowserForm(): void {
    setBrowserFormFor("");
    setBrowserHostsDraft("");
    setBrowserPasswordOnly(true);
  }

  async function patchBrowserPolicy(
    name: string,
    browser: { enabled: boolean; hosts?: string[]; passwordOnly?: boolean },
    okMessage: string,
  ): Promise<void> {
    if (browserBusyRef.current) return;
    setBrowserBusy(name);
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ browser }),
      });
      replaceState({ user: next });
      if (browserFormForRef.current === name) closeBrowserForm();
      notify(okMessage, "ok");
    } catch (err) {
      // The server owns host validation, so surface ITS text — it names the rule
      // that was broken (invalid host, none given, over the cap, reserved name).
      notify(`브라우저 입력 설정 실패: ${(err as Error).message}`, "warn");
    } finally {
      setBrowserBusy("");
    }
  }

  function saveBrowserPolicy(name: string): void {
    void patchBrowserPolicy(
      name,
      {
        enabled: true,
        hosts: parseHostsDraft(browserHostsDraftRef.current),
        passwordOnly: browserPasswordOnlyRef.current,
      },
      `${name} 시크릿을 지정한 사이트에서 브라우저 입력에 사용합니다.`,
    );
  }

  function toggleBrowserInput(name: string, on: boolean, policy: BrowserSecretPolicy | undefined): void {
    if (on) {
      openBrowserForm(name, policy);
      return;
    }
    // Unticking while the editor is open for a NEVER-enabled secret is a cancel,
    // not a disable: the box was only ticked to open the form, there is nothing
    // on the server to turn off, and "껐습니다" for something that was never on
    // tells the owner their vault changed when it did not.
    if (!policy) {
      if (browserFormForRef.current === name) closeBrowserForm();
      return;
    }
    void patchBrowserPolicy(name, { enabled: false }, `${name} 시크릿의 브라우저 입력을 껐습니다.`);
  }

  const enabledExperimental = new Set(user?.experimentalFeatures || []);
  const shellExposed = new Set(user?.shellExposedSecretNames || []);
  const browserPolicies = new Map<string, BrowserSecretPolicy>(
    (user?.browserSecrets || []).map((policy) => [policy.name, policy]),
  );
  const sshStatus = sshBusy ? "SSH 키를 생성하는 중입니다." : sshError ? `SSH 키 생성 실패: ${sshError}` : sshMessage;

  async function toggleExperimental(key: string, on: boolean): Promise<void> {
    const current = new Set(readState().user?.experimentalFeatures || []);
    if (on) current.add(key);
    else current.delete(key);
    setExperimentalBusy(key);
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ experimentalFeatures: [...current] }),
      });
      replaceState({ user: next });
      // The tool gate reads the owner's flag on every run, so the change holds from
      // the next message — in a conversation already open too.
      notify(`실험 기능을 ${on ? "켰습니다" : "껐습니다"}. 다음 메시지부터 적용됩니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      setExperimentalBusy("");
    }
  }
  const internalSet = Boolean(user?.gitTokenSet);
  const externalSet = Boolean(user?.secretNames.includes(EXTERNAL_GIT_TOKEN));
  const githubHost = state.bootstrap?.githubHost || "github.com";
  // Git tokens have their own dedicated card — listing them here duplicated the
  // row and offered a second, competing delete path.
  const extraSecretNames = (user?.secretNames || []).filter(
    (n) => !presetNames.has(n) && n !== INTERNAL_GIT_TOKEN && n !== EXTERNAL_GIT_TOKEN,
  );
  const savedGitIdentityName = user?.gitIdentityName || "";
  const savedGitIdentityEmail = user?.gitIdentityEmail || "";
  const gitIdentityNameTrimmed = gitIdentityName.trim();
  const gitIdentityEmailTrimmed = gitIdentityEmail.trim();
  const identityDirty = Boolean(
    user && (gitIdentityNameTrimmed !== savedGitIdentityName || gitIdentityEmailTrimmed !== savedGitIdentityEmail),
  );
  const identityStatus = identitySaving
    ? "저장 중…"
    : identityError
      ? `저장 실패: ${identityError}`
      : identityDirty
        ? "저장하지 않은 커밋 정보가 있습니다."
        : savedGitIdentityName || savedGitIdentityEmail
          ? "저장됨"
          : "저장 전";
  const identityCanSave = Boolean(!identitySaving && identityDirty);
  // Another account in the same (always-mounted) tab: take ITS commit identity.
  // Before paint, and never over a save that is still in flight.
  useLayoutEffect(() => {
    if (user?.id && user.id !== syncedIdentityUserId.current && !identitySavingRef.current) {
      syncGitIdentityForm(user);
    }
  });
  const internalStatus = internalBusy
    ? "저장 중…"
    : internalError
      ? `저장 실패: ${internalError}`
      : internalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : internalSet
          ? "사내 Git 토큰이 설정되어 있습니다."
          : "사내 Git 토큰이 아직 없습니다.";
  const externalStatus = externalBusy
    ? "저장 중…"
    : externalError
      ? `저장 실패: ${externalError}`
      : externalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : externalSet
          ? "외부 GitHub 토큰이 설정되어 있습니다."
          : "외부 GitHub 토큰이 아직 없습니다.";
  const extraNameTrimmed = extraName.trim();
  const extraHasValue = Boolean(extraValue.trim());
  const extraNameValid = !extraNameTrimmed || SECRET_NAME_PATTERN.test(extraNameTrimmed);
  const extraCanSave = Boolean(!extraBusy && extraNameTrimmed && extraHasValue && extraNameValid);
  const extraStatus = extraBusy
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

  const presetFilled = Object.fromEntries(
    SECRET_PRESETS.map((p) => [p.name, Boolean(presetValues[p.name]?.trim())]),
  ) as Record<string, boolean>;
  const presetStatusText = Object.fromEntries(
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
    if (!presetErrorsRef.current[name]) return;
    setPresetErrors((errors) => ({ ...errors, [name]: "" }));
  }

  // ---- git tokens ----
  async function saveInternalToken(): Promise<void> {
    if (internalBusyRef.current) return;
    const token = internalToken.trim();
    if (!token) return;
    setInternalBusy(true);
    setInternalError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: next });
      setInternalToken("");
      notify("사내 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      const message = (err as Error).message;
      setInternalError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setInternalBusy(false);
    }
  }
  async function clearInternalToken(): Promise<void> {
    if (internalBusyRef.current) return;
    if (!(await confirmAction("사내 Git 토큰을 삭제할까요?"))) return;
    setInternalBusy(true);
    setInternalError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "DELETE" });
      replaceState({ user: next });
      notify("사내 Git 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setInternalBusy(false);
    }
  }
  async function saveExternalToken(): Promise<void> {
    if (externalBusyRef.current) return;
    const token = externalToken.trim();
    if (!token) return;
    setExternalBusy(true);
    setExternalError("");
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "PUT", body: JSON.stringify({ value: token }) });
      replaceState({ user: next });
      setExternalToken("");
      notify("외부 GitHub 토큰을 저장했습니다.", "ok");
    } catch (err) {
      const message = (err as Error).message;
      setExternalError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setExternalBusy(false);
    }
  }
  async function clearExternalToken(): Promise<void> {
    if (externalBusyRef.current) return;
    if (!(await confirmAction("외부 GitHub 토큰을 삭제할까요?"))) return;
    setExternalBusy(true);
    setExternalError("");
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "DELETE" });
      replaceState({ user: next });
      notify("외부 GitHub 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setExternalBusy(false);
    }
  }

  function syncGitIdentityForm(next: User): void {
    setGitIdentityName(next.gitIdentityName || "");
    setGitIdentityEmail(next.gitIdentityEmail || "");
    syncedIdentityUserId.current = next.id;
    setIdentityError("");
  }

  async function saveGitIdentity(): Promise<void> {
    if (identitySavingRef.current || !identityDirty) return;
    setIdentitySaving(true);
    setIdentityError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name: gitIdentityNameTrimmed || null, email: gitIdentityEmailTrimmed || null }),
      });
      syncGitIdentityForm(next);
      replaceState({ user: next });
      notify("커밋 정보를 저장했습니다.", "ok");
    } catch (err) {
      const message = (err as Error).message;
      setIdentityError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setIdentitySaving(false);
    }
  }

  // ---- secrets ----
  async function savePresetSecret(name: string, label: string): Promise<void> {
    if (presetBusyRef.current[name]) return;
    const value = presetValues[name] || "";
    if (!value.trim()) {
      notify(`${label} 값을 입력해 주세요.`, "warn");
      return;
    }
    setPresetBusy((busy) => ({ ...busy, [name]: true }));
    setPresetErrors((errors) => ({ ...errors, [name]: "" }));
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      setPresetValues((values) => ({ ...values, [name]: "" }));
      notify(`${label} 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      setPresetErrors((errors) => ({ ...errors, [name]: (err as Error).message }));
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      setPresetBusy((busy) => ({ ...busy, [name]: false }));
    }
  }
  async function clearPresetSecret(name: string, label: string): Promise<void> {
    if (presetBusyRef.current[name]) return;
    if (!(await confirmAction(`${label} 시크릿을 삭제할까요?`))) return;
    setPresetBusy((busy) => ({ ...busy, [name]: true }));
    setPresetErrors((errors) => ({ ...errors, [name]: "" }));
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`${label} 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setPresetBusy((busy) => ({ ...busy, [name]: false }));
    }
  }

  async function saveExtraSecret(): Promise<void> {
    if (extraBusyRef.current) return;
    const name = extraNameTrimmed;
    const value = extraValue;
    setExtraError("");
    if (!name || !value.trim()) {
      setExtraError("시크릿 이름과 값을 모두 입력해 주세요.");
      notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
      return;
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      setExtraError("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
      return;
    }
    setExtraBusy(true);
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      setExtraName("");
      setExtraValue("");
      notify(`"${name}" 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      const message = `저장 실패: ${(err as Error).message}`;
      setExtraError(message);
      notify(message, "warn");
    } finally {
      setExtraBusy(false);
    }
  }
  async function deleteExtraSecret(name: string): Promise<void> {
    if (extraDeletingRef.current[name]) return;
    if (!(await confirmAction(`"${name}" 시크릿을 삭제할까요?`))) return;
    setExtraDeleting((deleting) => ({ ...deleting, [name]: true }));
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`"${name}" 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setExtraDeleting((deleting) => ({ ...deleting, [name]: false }));
    }
  }

  async function generateSshKey(): Promise<void> {
    if (sshBusyRef.current) return;
    setSshBusy(true);
    setSshError("");
    setSshMessage("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      const message = "SSH 키를 생성했습니다.";
      setSshMessage(message);
      notify(message, "ok");
    } catch (err) {
      const message = (err as Error).message;
      setSshError(message);
      notify(`SSH 키 생성 실패: ${message}`, "warn");
    } finally {
      setSshBusy(false);
    }
  }

  function copySshKey(event: MouseEvent<HTMLButtonElement>): void {
    const btn = event.currentTarget;
    void copyText(user?.sshPublicKey || "", btn);
  }

  // The 셸 노출 / 브라우저 입력 controls are the same markup in a preset row and
  // in a 기타 시크릿 row; `name` is the only thing that differs.
  function shellExposeToggle(name: string): ReactNode {
    return (
      <label
        className="shell-expose-toggle"
        title="켜면 이 값이 아바타 셸(Bash) 환경변수로도 주입됩니다 (본인 대화·루틴·API 작업에서만, 팀원 대화에는 전달되지 않음, 도구 출력에서는 자동 가려짐)"
      >
        <OneWayCheckbox
          checked={shellExposed.has(name)}
          disabled={shellExposeBusy === name}
          onChange={(checked) => void toggleShellExpose(name, checked)}
        />
        <span className="muted">셸 노출</span>
      </label>
    );
  }

  function browserInputToggle(name: string): ReactNode {
    const browserPolicy = browserPolicies.get(name);
    return (
      <label
        className="browser-input-toggle"
        title="켜면 아바타가 브라우저 확장을 통해 이 시크릿을 지정한 사이트의 입력 필드에 넣을 수 있습니다 (값은 아바타에게 보이지 않고, 지정한 사이트 밖에서는 거부됩니다)"
      >
        <OneWayCheckbox
          checked={Boolean(browserPolicy) || browserFormFor === name}
          disabled={browserBusy === name}
          onChange={(checked) => toggleBrowserInput(name, checked, browserPolicy)}
        />
        <span className="muted">브라우저 입력</span>
      </label>
    );
  }

  function browserInputBox(name: string): ReactNode {
    const browserPolicy = browserPolicies.get(name);
    if (browserFormFor === name) {
      return (
        <div className="browser-input-box">
          <label className="field browser-input-hosts">
            <span>허용 사이트(호스트)</span>
            <input
              value={browserHostsDraft}
              onChange={(event) => setBrowserHostsDraft(event.currentTarget.value)}
              placeholder="jira.corp.com, login.corp.com"
              autoComplete="off"
              spellCheck={false}
              disabled={browserBusy === name}
              onKeyDown={(event) => {
                // Enter saves the POLICY. In a preset row this input sits
                // inside the <form> that saves the secret VALUE, so the
                // default submit has to be stopped.
                if (event.key !== "Enter") return;
                event.preventDefault();
                saveBrowserPolicy(name);
              }}
            />
          </label>
          <label className="browser-input-toggle">
            <input
              type="checkbox"
              checked={browserPasswordOnly}
              onChange={(event) => setBrowserPasswordOnly(event.currentTarget.checked)}
              disabled={browserBusy === name}
            />
            <span className="muted">비밀번호 필드에만 입력</span>
          </label>
          <div className="browser-input-actions">
            <button className="btn primary sm" type="button" disabled={browserBusy === name} onClick={() => saveBrowserPolicy(name)}>
              {browserBusy === name ? "저장 중…" : "저장"}
            </button>
            <button className="btn sm" type="button" disabled={browserBusy === name} onClick={closeBrowserForm}>
              취소
            </button>
          </div>
        </div>
      );
    }
    if (browserPolicy) {
      return (
        <div className="browser-input-box">
          <span className="muted browser-input-summary">{browserSummary(browserPolicy)}</span>
          <button className="btn sm" type="button" disabled={browserBusy === name} onClick={() => openBrowserForm(name, browserPolicy)}>
            편집
          </button>
        </div>
      );
    }
    return null;
  }

  return (
    <>
      <SettingsAvatarApiKeys active={active && Boolean(user)} />
      <SettingsShareLinks active={active && Boolean(user)} />

      {active && user ? (
        <>
          <section className="settings-card cmp-settings-access-tab">
            <div className="panel-section-head">
              <div>
                <h3>브라우저 브릿지</h3>
                <p className="muted">
                  확장 프로그램을 설치하면 아바타가 <strong>내 브라우저의 탭</strong>을 직접 열고 클릭할 수 있습니다.
                  이미 로그인된 세션 그대로 동작하므로, 허용 사이트를 신중하게 정하세요.
                </p>
              </div>
            </div>
            <div className="browser-bridge-actions">
              <button type="button" className="btn primary" disabled={extensionBusy} onClick={() => void downloadExtension()}>
                <Icon name="file" />
                <span>{extensionBusy ? "준비 중…" : "확장 프로그램 다운로드"}</span>
              </button>
              <button type="button" className="btn ghost" onClick={() => setGuideOpen(true)}>
                설치 방법 보기
              </button>
              <button type="button" className="btn ghost" disabled={allowBusy} onClick={() => void loadAllowlist()}>
                {allowLoaded ? "허용 사이트 새로고침" : "허용 사이트 불러오기"}
              </button>
            </div>

            {updateDirSupported ? (
              <>
                <div className="browser-bridge-actions">
                  {updateDirName ? (
                    <>
                      <button type="button" className="btn primary" disabled={updateBusy} onClick={() => void runOneClickUpdate()}>
                        {updateBusy ? "업데이트 중…" : "확장 원클릭 업데이트"}
                      </button>
                      <button type="button" className="btn ghost" disabled={updateBusy} onClick={() => void disconnectUpdateDir()}>
                        폴더 연결 해제
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn ghost" onClick={() => void connectUpdateDir()}>
                      확장 폴더 연결 (원클릭 업데이트)
                    </button>
                  )}
                </div>
                <p className="muted">
                  {updateDirName ? (
                    <>
                      연결된 폴더: <code>{updateDirName}</code> — 버튼 한 번이면 파일 교체와 확장 리로드까지 끝납니다.
                    </>
                  ) : (
                    "압축을 푼 확장 폴더를 한 번 연결해 두면, 이후 버전 업데이트는 버튼 한 번입니다."
                  )}
                </p>
              </>
            ) : null}

            {allowLoaded ? (
              <div className="browser-allowlist">
                {allowSource === "managed" ? (
                  <>
                    <p className="muted">
                      <strong>관리자 정책이 적용 중입니다.</strong> 이 브라우저의 허용 사이트는 조직에서 배포한
                      목록이며 여기서 바꿀 수 없습니다.
                    </p>
                    <ul className="guide-origins">
                      {allowPatterns.map((pattern) => (
                        <li key={pattern}>
                          <code>{pattern}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>아바타가 조작해도 되는 사이트 (한 줄에 하나)</span>
                      <textarea
                        value={allowDraft}
                        onChange={(event) => setAllowDraft(event.currentTarget.value)}
                        rows={4}
                        spellCheck={false}
                        placeholder={"intra.example.com\n*.corp.local"}
                      ></textarea>
                    </label>
                    <p className="muted">
                      정확한 호스트 또는 <code>*.도메인</code> 형태의 하위 도메인 와일드카드를 씁니다{" "}
                      (<code>*.corp.local</code>은 <code>corp.local</code> 자체에는 적용되지 않아요).
                      비워두면 모든 사이트가 거부됩니다.
                    </p>
                    {serverDefaultOrigins.length ? (
                      <p className="muted">
                        서버 기본값:{" "}
                        {serverDefaultOrigins.map((origin, i) => (
                          <Fragment key={origin}>
                            {i > 0 ? ", " : ""}
                            <code>{origin}</code>
                          </Fragment>
                        ))}
                      </p>
                    ) : null}
                    <div className="browser-bridge-actions">
                      <button type="button" className="btn primary" disabled={allowBusy} onClick={() => void saveAllowlist()}>
                        {allowBusy ? "저장 중…" : "허용 사이트 저장"}
                      </button>
                      {serverDefaultOrigins.length ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={allowBusy}
                          onClick={() => setAllowDraft(serverDefaultOrigins.join("\n"))}
                        >
                          서버 기본값 채우기
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </section>
          <Presence>
            {guideOpen ? (
              <BrowserBridgeGuideModal
                key="browser-bridge-guide"
                extensionId={extensionId}
                origins={extensionOrigins}
                downloading={extensionBusy}
                multimediaNotice={extensionMultimediaNotice}
                onDownload={() => void downloadExtension()}
                onClose={() => setGuideOpen(false)}
              />
            ) : null}
          </Presence>

          {/* 실험 기능 (#50) — hidden while no feature is in beta (the canvas graduated) */}
          {EXPERIMENTAL_FEATURES.length ? (
            <section className="settings-card cmp-settings-access-tab">
              <div className="panel-section-head">
                <div>
                  <h3>실험 기능</h3>
                  <p className="muted">아직 다듬는 중인 베타 기능입니다. 기능마다 켜고 끌 수 있으며, 동작이 바뀔 수 있어요. 아바타도 어떤 실험 기능이 켜져 있는지 인지합니다.</p>
                </div>
              </div>
              <div className="experimental-list">
                {EXPERIMENTAL_FEATURES.map((feature) => (
                  <label className="experimental-item" key={feature.key}>
                    <OneWayCheckbox
                      checked={enabledExperimental.has(feature.key)}
                      disabled={experimentalBusy === feature.key}
                      onChange={(checked) => void toggleExperimental(feature.key, checked)}
                    />
                    <span className="experimental-meta">
                      <strong>
                        {feature.name} <span className="tag accent experimental-badge">실험</span>
                      </strong>
                      <span className="muted">{feature.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          {/* Git 자격증명 */}
          <section className="settings-card cmp-settings-access-tab">
            <div className="panel-section-head">
              <div>
                <h3>Git 자격증명</h3>
                <p className="muted">사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
              </div>
            </div>
            <form
              className="secret-preset-row"
              aria-busy={internalBusy}
              onSubmit={(event) => {
                event.preventDefault();
                void saveInternalToken();
              }}
            >
              <div className="secret-preset-meta">
                <div className="secret-preset-title">
                  <strong>사내 Git 토큰</strong>
                  <code>{INTERNAL_GIT_TOKEN}</code>
                  <span className={internalSet ? "muted token-set" : "muted"}>{internalSet ? "● 설정됨" : "미설정"}</span>
                </div>
                <p className="muted">지식 저장소 생성·푸시와 사내({githubHost}) 비공개 저장소 접근에 사용해요.</p>
              </div>
              <RevealableInput
                value={internalToken}
                onValueChange={setInternalToken}
                name="internalToken"
                placeholder="사내 GitHub PAT (GIT_TOKEN)"
                ariaLabel="사내 Git 토큰 GIT_TOKEN"
                ariaDescribedby={internalStatusId}
                ariaInvalid={Boolean(internalError)}
                revealLabel="토큰"
                disabled={internalBusy}
                onInput={() => setInternalError("")}
              />
              <div className="secret-preset-actions">
                <span
                  id={internalStatusId}
                  className={cx(
                    "settings-save-status",
                    Boolean(internalToken.trim() && !internalBusy && !internalError) && "dirty",
                    internalBusy && "pending",
                    Boolean(internalError) && "invalid",
                  )}
                  role="status"
                  aria-live="polite"
                >
                  {internalStatus}
                </span>
                <button className="primary" type="submit" disabled={internalBusy || !internalToken.trim()}>
                  {internalSet ? "교체" : "저장"}
                </button>
                <button className="linkish small" type="button" disabled={!internalSet || internalBusy} onClick={() => void clearInternalToken()}>
                  삭제
                </button>
              </div>
            </form>

            <form
              className="secret-preset-row"
              aria-busy={externalBusy}
              onSubmit={(event) => {
                event.preventDefault();
                void saveExternalToken();
              }}
            >
              <div className="secret-preset-meta">
                <div className="secret-preset-title">
                  <strong>외부 GitHub 토큰</strong>
                  <code>{EXTERNAL_GIT_TOKEN}</code>
                  <span className={externalSet ? "muted token-set" : "muted"}>{externalSet ? "● 설정됨" : "미설정"}</span>
                </div>
                <p className="muted">github.com HTTPS 저장소 접근에만 사용해요. 지식 저장소 생성·푸시에는 쓰이지 않아요.</p>
              </div>
              <RevealableInput
                value={externalToken}
                onValueChange={setExternalToken}
                name="externalToken"
                placeholder="github.com PAT (GITHUB_TOKEN)"
                ariaLabel="외부 GitHub 토큰 GITHUB_TOKEN"
                ariaDescribedby={externalStatusId}
                ariaInvalid={Boolean(externalError)}
                revealLabel="토큰"
                disabled={externalBusy}
                onInput={() => setExternalError("")}
              />
              <div className="secret-preset-actions">
                <span
                  id={externalStatusId}
                  className={cx(
                    "settings-save-status",
                    Boolean(externalToken.trim() && !externalBusy && !externalError) && "dirty",
                    externalBusy && "pending",
                    Boolean(externalError) && "invalid",
                  )}
                  role="status"
                  aria-live="polite"
                >
                  {externalStatus}
                </span>
                <button className="primary" type="submit" disabled={externalBusy || !externalToken.trim()}>
                  {externalSet ? "교체" : "저장"}
                </button>
                <button className="linkish small" type="button" disabled={!externalSet || externalBusy} onClick={() => void clearExternalToken()}>
                  삭제
                </button>
              </div>
            </form>

            <div className="secret-extra-head">
              <strong>커밋 정보</strong>
              <p className="muted">아바타가 만드는 커밋의 작성자 이름·이메일입니다. 비우면 기본값을 사용해요.</p>
            </div>
            <form
              className="settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveGitIdentity();
              }}
            >
              <div className="field-row-2col">
                <label className="field">
                  <span>커밋 이름</span>
                  <input
                    value={gitIdentityName}
                    placeholder={user.alias || user.displayName || ""}
                    aria-describedby={identityStatusId}
                    aria-invalid={identityError ? "true" : undefined}
                    disabled={identitySaving}
                    onChange={(event) => {
                      setGitIdentityName(event.currentTarget.value);
                      setIdentityError("");
                    }}
                  />
                </label>
                <label className="field">
                  <span>커밋 이메일</span>
                  <input
                    type="email"
                    value={gitIdentityEmail}
                    placeholder={`${user.username}@example.com`}
                    aria-describedby={identityStatusId}
                    aria-invalid={identityError ? "true" : undefined}
                    disabled={identitySaving}
                    onChange={(event) => {
                      setGitIdentityEmail(event.currentTarget.value);
                      setIdentityError("");
                    }}
                  />
                </label>
              </div>
              <div className="settings-save-row">
                <span
                  id={identityStatusId}
                  className={cx(
                    "settings-save-status",
                    identityDirty && !identitySaving && !identityError && "dirty",
                    identitySaving && "pending",
                    Boolean(identityError) && "invalid",
                  )}
                  role="status"
                  aria-live="polite"
                >
                  {identityStatus}
                </span>
                <button className="primary" type="submit" disabled={!identityCanSave}>
                  {identitySaving ? "저장 중…" : "커밋 정보 저장"}
                </button>
              </div>
            </form>
          </section>

          {/* 시크릿 */}
          <section className="settings-card cmp-settings-access-tab">
            <div className="panel-section-head">
              <div>
                <h3>시크릿</h3>
                <p className="muted">내 아바타의 도구에만 주입되는 시크릿 값입니다. 암호화되어 저장되고 다시 표시되지 않습니다.</p>
              </div>
            </div>
            <ul className="hint-list">
              <li>직접 등록한 플러그인·지식 저장소의 <code>.mcp.json</code> MCP 서버에 환경변수로(HTTP 서버는 헤더의 <code>{"${이름}"}</code>으로) 주입되고, 공용 MCP 서버에는 아래에서 직접 연결한 시크릿만 들어가요 — 본인·팀원과의 대화에서만.</li>
              <li><strong>셸 노출</strong>을 켜면 내 대화·루틴·API 작업의 셸(Bash)에서 같은 이름의 환경변수로도 쓸 수 있어요. 동료와의 대화나 아바타 간 질문의 셸에는 들어가지 않아요. 필요한 키만 켜세요.</li>
              <li><strong>브라우저 입력</strong>을 켜면 아바타가 브라우저 확장을 통해 이 시크릿을 지정한 사이트의 로그인 필드에 이름으로 입력할 수 있어요. 값은 아바타에게 보이지 않고, 지정한 사이트 밖에서는 거부되며, 브라우저 세션마다 처음 한 번 브라우저에서 확인해요(그 한 번이 허용해 둔 모든 사이트에 적용돼요).</li>
              <li>도구 출력에 값이 나타나면 자동으로 가려져요.</li>
              <li>GIT_TOKEN·GITHUB_TOKEN·SSH 계열은 전용 경로로만 쓰이고, 일반 동료 대화에는 어떤 시크릿도 주입되지 않아요.</li>
            </ul>

            {sharedMcpSlotted.length ? (
              <div className="shared-mcp-secret-box">
                <strong>공용 MCP 서버에 연결할 시크릿</strong>
                <p className="muted">관리자가 등록한 서버입니다. 각 인증 자리에 내 시크릿 중 하나를 연결하면 다음 메시지부터 그 서버 주소로 전송되고, 연결하지 않으면 내 아바타에서 빠집니다.</p>
                <ul>
                  {sharedMcpSlotted.map((server) => (
                    <li key={server.name}>
                      <div className="shared-mcp-secret-head">
                        <span className="shared-mcp-secret-server">{server.label}</span>
                        <span className="muted mono">{server.origin}</span>
                      </div>
                      {server.description ? <span className="muted shared-mcp-secret-desc">{server.description}</span> : null}
                      {server.slots.map((slot) => {
                        const key = `${server.name}/${slot.id}`;
                        return (
                          <label className="shared-mcp-slot" key={slot.id}>
                            <span>
                              {slot.label} <span className="muted mono">({slot.header})</span>
                            </span>
                            <OneWaySelect
                              value={slot.boundSecret ?? ""}
                              options={bindableSecretNames}
                              disabled={sharedMcpBusy[key]}
                              ariaLabel={`${server.label} ${slot.label}에 연결할 시크릿`}
                              onChange={(select) => void bindSharedMcpSlot(server, slot, select)}
                            />
                            {slot.stale ? (
                              <span className="shared-mcp-stale" role="status">
                                서버 주소가 바뀌어 연결이 해제됐어요. 다시 연결해 주세요.
                              </span>
                            ) : null}
                          </label>
                        );
                      })}
                      <button className="linkish small" type="button" onClick={() => addSecretForShared(server)}>
                        이 서버용 시크릿 새로 추가
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="secret-preset-list">
              {SECRET_PRESETS.map((preset, index) => {
                const isSet = user.secretNames.includes(preset.name);
                const presetStatusId = secretDomId(preset.name, "status");
                return (
                  <form
                    className="secret-preset-row"
                    key={index}
                    aria-busy={presetBusy[preset.name]}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void savePresetSecret(preset.name, preset.label);
                    }}
                  >
                    <div className="secret-preset-meta">
                      <div className="secret-preset-title">
                        <strong>{preset.label}</strong>
                        <code>{preset.name}</code>
                        {isSet ? <span className="muted token-set">● 설정됨</span> : <span className="muted">미설정</span>}
                      </div>
                      <p className="muted">{preset.description}</p>
                    </div>
                    <textarea
                      rows={preset.rows}
                      placeholder={preset.placeholder}
                      autoComplete="off"
                      aria-label={`${preset.label} 값`}
                      aria-describedby={presetStatusId}
                      aria-invalid={presetErrors[preset.name] ? "true" : undefined}
                      value={presetValues[preset.name] ?? ""}
                      disabled={presetBusy[preset.name]}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setPresetValues((values) => ({ ...values, [preset.name]: value }));
                        clearPresetError(preset.name);
                      }}
                    ></textarea>
                    <div className="secret-preset-actions">
                      <span
                        id={presetStatusId}
                        className={cx(
                          "settings-save-status",
                          Boolean(presetFilled[preset.name] && !presetBusy[preset.name] && !presetErrors[preset.name]) && "dirty",
                          Boolean(presetBusy[preset.name]) && "pending",
                          Boolean(presetErrors[preset.name]) && "invalid",
                        )}
                        role="status"
                        aria-live="polite"
                      >
                        {presetStatusText[preset.name]}
                      </span>
                      {isSet && isShellExposableSecret(preset.name) ? shellExposeToggle(preset.name) : null}
                      {isSet && isBrowserExposableSecret(preset.name) ? browserInputToggle(preset.name) : null}
                      <button className="primary" type="submit" disabled={presetBusy[preset.name] || !presetFilled[preset.name]}>
                        {isSet ? "교체" : "저장"}
                      </button>
                      <button
                        className="linkish small"
                        type="button"
                        disabled={!isSet || presetBusy[preset.name]}
                        onClick={() => void clearPresetSecret(preset.name, preset.label)}
                      >
                        삭제
                      </button>
                      {isSet && isBrowserExposableSecret(preset.name) ? browserInputBox(preset.name) : null}
                    </div>
                  </form>
                );
              })}
            </div>

            <div className="secret-extra-head">
              <strong>SSH 키</strong>
              <p className="muted">키 쌍을 만들어 개인키는 SSH_PRIVATE_KEY 시크릿에 저장하고, 공개키를 여기에 표시합니다. 원격 서버에는 공개키를 등록하세요.</p>
            </div>
            {user.sshPublicKey ? (
              <div className="ssh-public-key-box">
                <label className="field ssh-public-key-field">
                  <span>SSH 공개키</span>
                  <div className="ssh-public-key-row">
                    <textarea rows={3} readOnly value={user.sshPublicKey}></textarea>
                    <button className="msg-act" type="button" aria-label="SSH 공개키 복사" title="SSH 공개키 복사" onClick={copySshKey}>
                      <Icon name="copy" />
                    </button>
                  </div>
                </label>
              </div>
            ) : (
              <button
                className="primary"
                type="button"
                aria-describedby={sshStatus ? sshStatusId : undefined}
                disabled={sshBusy}
                onClick={() => void generateSshKey()}
              >
                {sshBusy ? "생성 중…" : "SSH 키 생성"}
              </button>
            )}
            {sshStatus ? (
              <div className="settings-save-row compact">
                <span
                  id={sshStatusId}
                  className={cx("settings-save-status", sshBusy && "pending", Boolean(sshMessage) && "success", Boolean(sshError) && "invalid")}
                  role="status"
                  aria-live="polite"
                >
                  {sshStatus}
                </span>
              </div>
            ) : null}

            <div className="secret-extra-head">
              <strong>기타 시크릿</strong>
              <p className="muted">도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요.</p>
            </div>
            <div className="secret-list">
              {!extraSecretNames.length ? (
                <div className="empty-note">추가 시크릿이 없습니다.</div>
              ) : (
                extraSecretNames.map((name) => (
                  <div className="secret-row" key={name}>
                    <code>{name}</code>
                    <span className="muted token-set">● 설정됨</span>
                    {isShellExposableSecret(name) ? shellExposeToggle(name) : null}
                    {isBrowserExposableSecret(name) ? browserInputToggle(name) : null}
                    <button
                      className="linkish small"
                      type="button"
                      aria-label={`시크릿 삭제: ${name}`}
                      disabled={extraDeleting[name]}
                      onClick={() => void deleteExtraSecret(name)}
                    >
                      삭제
                    </button>
                    {isBrowserExposableSecret(name) ? browserInputBox(name) : null}
                  </div>
                ))
              )}
            </div>
            <form
              className="settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveExtraSecret();
              }}
            >
              <label className="field">
                <span>이름</span>
                <input
                  value={extraName}
                  placeholder="SSH_PRIVATE_KEY"
                  autoComplete="off"
                  required
                  aria-describedby={extraStatusId}
                  aria-invalid={extraNameValid ? undefined : "true"}
                  disabled={extraBusy}
                  onChange={(event) => {
                    setExtraName(event.currentTarget.value);
                    setExtraError("");
                  }}
                />
              </label>
              <label className="field">
                <span>값</span>
                <textarea
                  id="secret-extra-value"
                  rows={4}
                  value={extraValue}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…"
                  autoComplete="off"
                  required
                  aria-describedby={extraStatusId}
                  disabled={extraBusy}
                  onChange={(event) => {
                    setExtraValue(event.currentTarget.value);
                    setExtraError("");
                  }}
                ></textarea>
              </label>
              <div className="settings-save-row">
                <span
                  id={extraStatusId}
                  className={cx(
                    "settings-save-status",
                    Boolean(extraNameTrimmed && extraHasValue && extraNameValid && !extraBusy && !extraError) && "dirty",
                    extraBusy && "pending",
                    (!extraNameValid || Boolean(extraError)) && "invalid",
                  )}
                  role="status"
                  aria-live="polite"
                >
                  {extraStatus}
                </span>
                <button className="primary" type="submit" disabled={!extraCanSave}>
                  {extraBusy ? "저장 중…" : "추가 시크릿 저장"}
                </button>
              </div>
            </form>
          </section>
        </>
      ) : null}
    </>
  );
}
