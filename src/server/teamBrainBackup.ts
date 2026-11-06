// Team brain backup: a PUSH-ONLY mirror of the local vault (teamBrain.ts) to an
// admin-chosen repository on the INTERNAL git host, pushed with THAT admin's own
// stored git token (server-side only — on env via gitAuthConfig, never argv).
// The local vault is the source of truth, but the mirror is NEVER force-pushed:
// a plain push only fast-forwards, so a branch holding history the vault does
// not know (a mirror after a lost volume, a mistyped project repo) is refused
// instead of overwritten. It is never fetched or merged either. Restore clones the mirror back ONLY into an empty
// vault (the DB — queue and settings — lives on the same volume, so a lost
// volume means an admin re-enters the URL and presses 복원).
//
// One instance per process (AppServices.teamBrainBackup). Its debounce timer is
// unref'd so it never holds the process open.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import logger from "./logger.js";
import { withRepoLock } from "./gitMutex.js";
import { git } from "./repoGitCore.js";
import { assertSafeGitValue } from "./repoGitGuards.js";
import { DEFAULT_GITHUB_HOST, gitAuthConfig, marketplaceCloneUrl, normalizeGithubHost, scrubGitError } from "./marketplace.js";
import { isInternalGitSource, tokenForGitUrl } from "./gitCredentials.js";
import {
  TEAM_BRAIN_BRANCH,
  countTeamNotes,
  countTeamRaw,
  ensureTeamBrainRepo,
  migrateTeamBrainHoldingLock,
  reconcileTeamBrainHoldingLock,
  teamBrainInitialized,
  teamBrainRoot,
} from "./teamBrain.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import type { TeamBrainBackupState } from "../shared/teamBrain.js";

export const TEAM_BRAIN_BACKUP_KEY = "team_brain_backup";
export const TEAM_BRAIN_BACKUP_STATUS_KEY = "team_brain_backup_status";
const DEFAULT_BRANCH = "main";
const DEBOUNCE_MS = 30_000;

interface BackupSettings {
  url: string;
  branch: string;
  adminId: string;
}

interface BackupStatus {
  lastOkAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

export type BackupConfigureResult = { ok: true } | { ok: false; message: string };
export type BackupRunResult = { ok: true } | { ok: false; message: string };

/** Wiki pages OR raw sources (incl. raw/legacy) — a vault with either is not "empty" for restore. */
async function vaultHoldsKnowledge(config: AppConfig): Promise<boolean> {
  return (await countTeamNotes(config)) > 0 || (await countTeamRaw(config)) > 0;
}

/** A branch name git would take as a plain ref (no options, no ref syntax tricks). */
function safeBranch(raw: string): string | null {
  const b = raw.trim() || DEFAULT_BRANCH;
  if (b.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith("-") || b.includes("..") || b.endsWith(".lock") || b.startsWith("/") || b.endsWith("/")) {
    return null;
  }
  return b;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The mirror's state straight from the store (describe_system has no backup instance). */
export function readTeamBrainBackupState(store: Store): TeamBrainBackupState {
  const s = parseJson<BackupSettings>(store.getAppSecret(TEAM_BRAIN_BACKUP_KEY));
  const settings = s && typeof s.url === "string" && s.url ? s : null;
  const st = parseJson<BackupStatus>(store.getAppSecret(TEAM_BRAIN_BACKUP_STATUS_KEY));
  const admin = settings ? store.getUserById(settings.adminId) : null;
  return {
    url: settings?.url ?? null,
    branch: settings?.branch ?? DEFAULT_BRANCH,
    adminName: admin ? admin.username : settings ? "(삭제된 사용자)" : null,
    lastOkAt: st?.lastOkAt ?? null,
    lastError: st?.lastError ?? null,
    lastAttemptAt: st?.lastAttemptAt ?? null,
  };
}

/** No internal host configured (GITHUB_HOST unset → github.com): the mirror is unavailable, fail closed. */
function noInternalHost(config: Pick<AppConfig, "githubHost">): boolean {
  return normalizeGithubHost(config.githubHost) === DEFAULT_GITHUB_HOST;
}
const NO_INTERNAL_HOST = "사내 git host(GITHUB_HOST)가 설정되지 않은 서버라 팀 브레인 백업을 사용할 수 없습니다.";
const NON_FAST_FORWARD =
  "백업 브랜치에 팀 브레인이 모르는 내용이 있어 백업하지 않았습니다(덮어쓰지 않습니다). 서버를 새로 설치했다면 비어 있는 팀 브레인에서 '백업에서 복원'을 먼저 하고, 아니라면 다른 저장소나 브랜치를 지정하세요.";

export class TeamBrainBackup {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupRunResult> | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly debounceMs = DEBOUNCE_MS,
  ) {}

  private settings(): BackupSettings | null {
    const s = parseJson<BackupSettings>(this.store.getAppSecret(TEAM_BRAIN_BACKUP_KEY));
    return s && typeof s.url === "string" && s.url ? s : null;
  }

  private status(): BackupStatus {
    return (
      parseJson<BackupStatus>(this.store.getAppSecret(TEAM_BRAIN_BACKUP_STATUS_KEY)) ?? {
        lastOkAt: null,
        lastError: null,
        lastAttemptAt: null,
      }
    );
  }

  private writeStatus(patch: Partial<BackupStatus>): void {
    this.store.setAppSecret(TEAM_BRAIN_BACKUP_STATUS_KEY, JSON.stringify({ ...this.status(), ...patch }));
  }

  state(): TeamBrainBackupState {
    return readTeamBrainBackupState(this.store);
  }

  /** Validate and store the mirror target; the saving admin's token pushes from now on. */
  configure(rawUrl: string | null, rawBranch: string | null, adminId: string): BackupConfigureResult {
    if (rawUrl === null || !rawUrl.trim()) {
      this.store.deleteAppSecret(TEAM_BRAIN_BACKUP_KEY);
      this.store.deleteAppSecret(TEAM_BRAIN_BACKUP_STATUS_KEY);
      return { ok: true };
    }
    if (noInternalHost(this.config)) return { ok: false, message: NO_INTERNAL_HOST };
    const url = rawUrl.trim();
    try {
      assertSafeGitValue(url, "backup url");
    } catch {
      return { ok: false, message: "백업 저장소 주소 형식이 올바르지 않습니다." };
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(url) && !/^https:\/\//i.test(url)) {
      return { ok: false, message: "백업 저장소는 owner/repo 또는 https 주소로 입력하세요." };
    }
    if (!isInternalGitSource(url, this.config.githubHost)) {
      return { ok: false, message: `백업 저장소는 사내 git host(${this.config.githubHost})에 있어야 합니다.` };
    }
    const branch = safeBranch(rawBranch ?? "");
    if (!branch) return { ok: false, message: "브랜치 이름이 올바르지 않습니다." };
    this.store.setAppSecret(TEAM_BRAIN_BACKUP_KEY, JSON.stringify({ url, branch, adminId } satisfies BackupSettings));
    this.writeStatus({ lastError: null });
    return { ok: true };
  }

  /** Debounced push after a commit (no-op when no mirror is configured). */
  schedule(): void {
    if (!this.settings()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pushNow();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolve the push URL + auth for the configured admin, or a Korean reason it can't push. */
  private resolveAuth(s: BackupSettings): { url: string; auth: ReturnType<typeof gitAuthConfig> } | { error: string } {
    if (!this.store.isActiveAdmin(s.adminId)) {
      return { error: "백업을 설정한 관리자가 더 이상 활성 관리자가 아닙니다. 다른 관리자가 백업 주소를 다시 저장하세요." };
    }
    // Policy is re-checked at push time too: a host config change must not leak the vault.
    if (noInternalHost(this.config)) return { error: NO_INTERNAL_HOST };
    if (!isInternalGitSource(s.url, this.config.githubHost)) {
      return { error: `백업 저장소가 사내 git host(${this.config.githubHost})에 있지 않습니다.` };
    }
    const url = marketplaceCloneUrl(s.url, this.config.githubHost);
    const token = tokenForGitUrl(url, this.config, this.store.getGitTokens(s.adminId));
    if (!token && /^https:\/\//i.test(url)) {
      return { error: "백업을 설정한 관리자의 git 토큰이 없습니다. 설정 → 권한·연결에서 토큰을 저장하세요." };
    }
    return { url, auth: gitAuthConfig(url, token) };
  }

  /** Push the vault to the mirror now (serialized with every vault write). */
  pushNow(): Promise<BackupRunResult> {
    if (this.running) return this.running;
    this.running = this.doPush().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doPush(): Promise<BackupRunResult> {
    const s = this.settings();
    if (!s) return { ok: false, message: "백업 저장소가 설정되지 않았습니다." };
    const attemptAt = new Date().toISOString();
    const resolved = this.resolveAuth(s);
    if ("error" in resolved) {
      this.writeStatus({ lastAttemptAt: attemptAt, lastError: resolved.error });
      return { ok: false, message: resolved.error };
    }
    try {
      const root = await ensureTeamBrainRepo(this.config);
      const branch = safeBranch(s.branch) ?? DEFAULT_BRANCH;
      await withRepoLock(root, () =>
        // No --force, ever: only a fast-forward lands (see the header).
        git(root, ["push", "--quiet", "--", resolved.url, `${TEAM_BRAIN_BRANCH}:refs/heads/${branch}`], 120_000, resolved.auth),
      );
      this.writeStatus({ lastAttemptAt: attemptAt, lastOkAt: attemptAt, lastError: null });
      return { ok: true };
    } catch (error) {
      const raw = scrubGitError(error);
      const message = /non-fast-forward|\[rejected\]|fetch first|failed to push some refs/i.test(raw)
        ? NON_FAST_FORWARD
        : `백업 push 실패: ${raw.split("\n").slice(-3).join(" ").slice(0, 300)}`;
      logger.warn({ err: scrubGitError(error) }, "team brain backup push failed");
      this.writeStatus({ lastAttemptAt: attemptAt, lastError: message });
      return { ok: false, message };
    }
  }

  /**
   * Restore the vault from the mirror — ONLY while the local vault holds no
   * notes. The previous (seed-only) vault is renamed aside, never deleted; the
   * restored clone keeps no remote and is refused if it carries a symlink.
   */
  async restore(): Promise<BackupRunResult> {
    const s = this.settings();
    if (!s) return { ok: false, message: "백업 저장소가 설정되지 않았습니다." };
    if (await vaultHoldsKnowledge(this.config)) {
      return { ok: false, message: "팀 브레인에 이미 노트가 있어 복원할 수 없습니다. 복원은 비어 있는 팀 브레인에만 할 수 있습니다." };
    }
    const resolved = this.resolveAuth(s);
    if ("error" in resolved) return { ok: false, message: resolved.error };
    const root = teamBrainRoot(this.config);
    const branch = safeBranch(s.branch) ?? DEFAULT_BRANCH;
    const tmp = `${root}.restore-${Date.now()}`;
    try {
      return await withRepoLock(root, async () => {
        // Leftovers of a crashed write never count (or ride along into the aside copy as live).
        await reconcileTeamBrainHoldingLock(root);
        // Re-checked under the lock: an approval may have landed since the first check.
        if (await vaultHoldsKnowledge(this.config)) throw new Error("RESTORE_NOT_EMPTY");
        await fs.mkdir(path.dirname(root), { recursive: true });
        await git(
          path.dirname(root),
          ["clone", "--quiet", "--single-branch", "--branch", branch, "--", resolved.url, tmp],
          300_000,
          resolved.auth,
        );
        await git(tmp, ["remote", "remove", "origin"]).catch(() => undefined);
        const { stdout } = await git(tmp, ["ls-files", "-s"]);
        if (stdout.split("\n").some((line) => line.startsWith("120000 ") || line.startsWith("160000 "))) {
          throw new Error("RESTORE_LINK");
        }
        if (!fsSync.existsSync(path.join(tmp, "wiki"))) throw new Error("RESTORE_NO_VAULT");
        // Our vault branch name is fixed; the mirror branch may differ.
        await git(tmp, ["branch", "-M", TEAM_BRAIN_BRANCH]);
        if (teamBrainInitialized(this.config) || fsSync.existsSync(root)) {
          await fs.rename(root, `${root}.pre-restore-${Date.now()}`);
        }
        await fs.rename(tmp, root);
        // A mirror from before the current schema is brought up to it right away (one Noah commit).
        await migrateTeamBrainHoldingLock(root).catch((error) => {
          logger.warn({ err: error }, "team brain restore: schema migration failed; retried on the next write/boot");
        });
        return { ok: true as const };
      });
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      const code = error instanceof Error ? error.message : "";
      if (code === "RESTORE_NOT_EMPTY") {
        return { ok: false, message: "팀 브레인에 이미 노트가 있어 복원할 수 없습니다. 복원은 비어 있는 팀 브레인에만 할 수 있습니다." };
      }
      if (code === "RESTORE_LINK") return { ok: false, message: "백업에 링크 파일이 있어 복원하지 않았습니다." };
      if (code === "RESTORE_NO_VAULT") return { ok: false, message: "백업 저장소에 wiki/ 폴더가 없습니다." };
      logger.warn({ err: scrubGitError(error) }, "team brain restore failed");
      return { ok: false, message: `복원 실패: ${scrubGitError(error).split("\n").slice(-2).join(" ").slice(0, 300)}` };
    }
  }
}
