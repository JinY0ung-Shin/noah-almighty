import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { inspectRepoContents } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { isInternalGitSource } from "../gitCredentials.js";
import { ensureClone, knowledgeRepoContextFor, readFile } from "../knowledgeRepo.js";
import { buildKnowledgeGraphFromNotes, isVaultNotePath } from "../knowledgeGraph.js";
import { MemoryUnavailableError } from "../memory/memoryClient.js";
import { memoryVaultFor, type MemoryVault } from "../personalVault.js";
import { assertNoVaultAlias, vaultNotePathOf } from "../agent/repoToolKit.js";
import { onKnowledgeRepoChanged } from "../vaultImport.js";
import { generateSshKeyPair, deriveSshPublicKey } from "../sshIdentity.js";
import {
  MAX_BROWSER_SECRET_HOSTS,
  isBrowserExposableSecret,
  isShellExposableSecret,
  normalizeBrowserSecretHosts,
} from "../secretPolicy.js";
import {
  apiError,
  looksLikeRepo,
  respondNoteFsError,
  safeString,
  type RouterDeps,
} from "./_shared.js";
import type { Response } from "express";
import type { KnowledgeRepoContext } from "../knowledgeRepo.js";

/**
 * ensureClone → inspectRepoContents → res.json, shared by the personal repo's
 * GET /contents and POST /refresh (functionally identical bodies; only the
 * Korean catch label differs). User-facing Korean — `errorLabel` carries it.
 */
async function respondRepoContents(
  res: Response,
  ctx: KnowledgeRepoContext,
  errorLabel: string,
): Promise<void> {
  try {
    const repoRoot = await ensureClone(ctx);
    const contents = await inspectRepoContents(repoRoot);
    res.json({ contents });
  } catch (error) {
    apiError(res, 502, `${errorLabel}: ${scrubGitError(error)}`);
  }
}

/** The memory service could not be used: say so (never "no notes"), without naming what runs behind it. */
const MEMORY_SERVICE_UNAVAILABLE = "메모리 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/**
 * One note of the viewer's vault (in the memory service), for the graph: null
 * when the note is gone or cannot be a note (left out, as an unreadable file
 * is); a service that cannot be used — or that refuses — is thrown on, so the
 * graph never comes back with notes silently missing.
 */
async function readVaultNoteForGraph(vault: MemoryVault, notePath: string): Promise<string | null> {
  try {
    return await vault.read(notePath);
  } catch (error) {
    if (error instanceof Error && (error.message === "NOT_FOUND" || error.message === "INVALID_PATH")) return null;
    throw error;
  }
}

// ---- Git credentials & personal knowledge repo ----------------------
// The knowledge repo is browsed/edited/committed by the AVATAR via chat (the
// owner-only `mcp__repo__*` tools), not here — these routes only store the
// token, the commit identity, and the repo location.
export function createKnowledgeRepoRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  // Set (or clear) the user's internal Git token. Write-only: the token is
  // never returned — `user.gitTokenSet` reflects whether GIT_TOKEN is stored.
  router.put("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      apiError(res, 400, "token을 입력해 주세요.");
      return;
    }
    const user = store.setGitToken(req.user!.id, token);
    logger.info({ userId: req.user!.id }, "internal git token set");
    auditAs(req, "git_token_set", "set internal git token"); // name/action only — never the token
    res.json({ user });
  });

  router.delete("/api/me/git-token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const user = store.setGitToken(req.user!.id, null);
    logger.info({ userId: req.user!.id }, "internal git token cleared");
    auditAs(req, "git_token_clear", "cleared internal git token");
    res.json({ user });
  });

  // Per-user secrets: named values (e.g. SSH_PRIVATE_KEY) encrypted at rest and
  // injected ONLY into the avatar's MCP subprocess env — never returned to the
  // client or visible to the agent. `user.secretNames` lists which are set.
  // The name must be a valid env-var key so it can be passed through as-is.
  const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

  router.put("/api/me/secrets/:name", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    if (!SECRET_NAME_RE.test(name)) {
      apiError(res, 400, "secret 이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      return;
    }
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    if (!value) {
      apiError(res, 400, "value를 입력해 주세요.");
      return;
    }
    store.setUserSecret(req.user!.id, name, value);
    // Keep the SSH public key queryable: setUserSecret clears ssh_public_key
    // when SSH_PRIVATE_KEY changes, so derive and re-store the public half for a
    // pasted key (best-effort — an unparseable/passphrase key just leaves it unset).
    if (name === "SSH_PRIVATE_KEY") {
      const derived = await deriveSshPublicKey(value, `avatar-chat-${req.user!.username}`);
      if (derived) {
        store.setSshPublicKey(req.user!.id, derived.publicKey);
      } else {
        logger.warn({ userId: req.user!.id }, "could not derive ssh public key from pasted SSH_PRIVATE_KEY");
      }
    }
    logger.info({ userId: req.user!.id, name }, "user secret set");
    auditAs(req, "secret_set", `set secret ${name}`); // name only — value is write-only
    res.json({ user: store.getUserById(req.user!.id) });
  });

  router.delete("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    // Validate + 404 like the PATCH sibling, instead of the old always-200 no-op.
    if (!SECRET_NAME_RE.test(name)) {
      apiError(res, 400, "secret 이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.");
      return;
    }
    if (!store.deleteUserSecret(req.user!.id, name)) {
      apiError(res, 404, "등록되지 않은 시크릿입니다.");
      return;
    }
    logger.info({ userId: req.user!.id, name }, "user secret cleared");
    auditAs(req, "secret_delete", `deleted secret ${name}`);
    res.json({ user: store.getUserById(req.user!.id) });
  });

  // Per-secret EXPOSURE toggles (value untouched — the value is write-only via
  // PUT): agent-shell exposure (`shellExpose`) and browser input (`browser`).
  // Both may ride one request; reserved git/SSH names have dedicated routing and
  // qualify for neither.
  router.patch("/api/me/secrets/:name", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name || "");
    const shellExpose = req.body?.shellExpose;
    const browser = req.body?.browser;
    const wantsShell = shellExpose !== undefined;
    const wantsBrowser = browser !== undefined;
    if (!wantsShell && !wantsBrowser) {
      apiError(res, 400, "shellExpose(boolean) 또는 browser 설정을 보내 주세요.");
      return;
    }
    if (wantsShell && typeof shellExpose !== "boolean") {
      apiError(res, 400, "shellExpose(boolean)를 보내 주세요.");
      return;
    }

    // Validate the WHOLE body before touching the row: a request that half
    // applies would leave the owner's two toggles in a state they never asked for.
    let browserPolicy: { enabled: boolean; hosts: string[]; passwordOnly: boolean } | null = null;
    if (wantsBrowser) {
      const enabled = (browser as { enabled?: unknown })?.enabled;
      if (typeof enabled !== "boolean") {
        apiError(res, 400, "browser.enabled(boolean)를 보내 주세요.");
        return;
      }
      if (!isBrowserExposableSecret(name)) {
        apiError(res, 400, "이 시크릿은 전용 경로로만 사용되어 브라우저에 입력할 수 없습니다.");
        return;
      }
      const rawHosts = (browser as { hosts?: unknown }).hosts;
      // Over-cap is called out separately: "20개까지" is actionable, whereas the
      // generic "제대로 입력해 주세요" would read as a typo the owner can't find.
      if (Array.isArray(rawHosts) && rawHosts.length > MAX_BROWSER_SECRET_HOSTS) {
        apiError(res, 400, `허용 사이트는 최대 ${MAX_BROWSER_SECRET_HOSTS}개입니다.`);
        return;
      }
      // All-or-nothing normalization (secretPolicy.ts): a silently dropped typo
      // would leave the owner believing a site is allowed when it is not.
      const hosts = rawHosts === undefined ? null : normalizeBrowserSecretHosts(rawHosts);
      if (enabled && !hosts?.length) {
        apiError(
          res,
          400,
          "브라우저 입력을 켜려면 허용 사이트(호스트)를 1개 이상 올바르게 입력해 주세요. (예: jira.corp.com)",
        );
        return;
      }
      const rawPasswordOnly = (browser as { passwordOnly?: unknown }).passwordOnly;
      if (rawPasswordOnly !== undefined && typeof rawPasswordOnly !== "boolean") {
        apiError(res, 400, "browser.passwordOnly(boolean)를 보내 주세요.");
        return;
      }
      // An omitted host list on a disable is handed through as empty on purpose:
      // setSecretBrowserPolicy then keeps the stored hosts/flag, so flipping the
      // toggle back on restores the owner's configuration.
      browserPolicy = {
        enabled,
        hosts: hosts ?? [],
        // Password-only is the SAFE default, so an omitted flag means true.
        passwordOnly: rawPasswordOnly ?? true,
      };
    }

    if (wantsShell) {
      if (!isShellExposableSecret(name)) {
        apiError(res, 400, "이 시크릿은 전용 경로로만 사용되어 셸에 노출할 수 없습니다.");
        return;
      }
      if (!store.setSecretShellExpose(req.user!.id, name, shellExpose as boolean)) {
        apiError(res, 404, "등록되지 않은 시크릿입니다.");
        return;
      }
      logger.info(
        { userId: req.user!.id, name, shellExpose },
        "user secret shell exposure toggled",
      );
      // Security-relevant: shell exposure is what lets a secret's VALUE into the
      // agent's Bash env, so it belongs in the queryable audit trail.
      auditAs(req, "secret_shell_expose", `${shellExpose ? "exposed" : "hid"} secret ${name} to the shell`);
    }

    if (browserPolicy) {
      if (!store.setSecretBrowserPolicy(req.user!.id, name, browserPolicy)) {
        apiError(res, 404, "등록되지 않은 시크릿입니다.");
        return;
      }
      logger.info(
        {
          userId: req.user!.id,
          name,
          browserExpose: browserPolicy.enabled,
          hosts: browserPolicy.hosts.length,
        },
        "user secret browser input toggled",
      );
      // Same reasoning as the shell audit, one step further: this is what lets a
      // secret's VALUE be typed into a live browser session. NAME + hosts only.
      auditAs(
        req,
        "secret_browser_expose",
        browserPolicy.enabled
          ? `enabled secret ${name} for browser input on [${browserPolicy.hosts.join(", ")}] (${
              browserPolicy.passwordOnly ? "password fields only" : "any text field"
            })`
          : `disabled browser input for secret ${name}`,
      );
    }

    res.json({ user: store.getUserById(req.user!.id) });
  });

  router.post("/api/me/ssh-key", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const user = store.getUserById(req.user!.id);
    const secretNames = store.listUserSecretNames(req.user!.id);
    if (secretNames.includes("SSH_PRIVATE_KEY") || user?.sshPublicKey) {
      apiError(
        res,
        409,
        user?.sshPublicKey
          ? "이미 SSH 키가 설정되어 있습니다."
          : "이미 SSH_PRIVATE_KEY 시크릿이 설정되어 있습니다.",
      );
      return;
    }
    try {
      const pair = await generateSshKeyPair(`avatar-chat-${req.user!.username}`);
      const updated = store.setSshKeyPair(req.user!.id, pair.privateKey, pair.publicKey);
      auditAs(
        req,
        "ssh_identity_generate_key",
        JSON.stringify({ fingerprint: pair.fingerprint, source: "settings" }),
      );
      logger.info({ userId: req.user!.id }, "ssh key generated");
      res.json({ user: updated, publicKey: pair.publicKey, fingerprint: pair.fingerprint });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      apiError(res, 500, `SSH 키를 생성하지 못했습니다: ${message}`);
    }
  });

  // Set the commit author identity used for knowledge-repo commits.
  router.put("/api/me/git-identity", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const name = safeString(req.body?.name) || null;
    const email = safeString(req.body?.email) || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      apiError(res, 400, "email 형식이 올바르지 않습니다.");
      return;
    }
    const user = store.setGitIdentity(req.user!.id, name, email);
    res.json({ user });
  });

  // Point the user at a personal knowledge repo (owner/repo or git URL). The
  // avatar manages the repo's contents itself via chat; this only stores where
  // it lives. An empty/null repo clears it.
  router.put("/api/me/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const repoRaw = req.body?.repo;
    // Shared-skill listings (#skill-share) advertise `skills/` dirs of the
    // CONNECTED repo — after a disconnect or repoint they would offer content
    // that no longer resolves, so drop them. A same-repo re-save keeps them.
    const { repo: previousRepo, branch: previousBranch } = store.getKnowledgeRepo(req.user!.id);
    if (repoRaw === null || repoRaw === "") {
      if (previousRepo) {
        store.clearSharedSkills(req.user!.id);
      }
      const user = store.setKnowledgeRepo(req.user!.id, null, null);
      res.json({ user });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    if (previousRepo && previousRepo !== repo) {
      store.clearSharedSkills(req.user!.id);
    }
    const user = store.setKnowledgeRepo(req.user!.id, repo, branch);
    // A repository was connected, or a different one, or the same one on a different branch: the vault's
    // side of that (importing the notes it brings along into a vault that is still empty — a branch holds
    // its own files) starts in the background. A re-save of the same repository and branch is not a change.
    if (previousRepo !== repo || (previousBranch ?? null) !== branch) {
      try {
        onKnowledgeRepoChanged(store, config, req.user!.id);
      } catch (error) {
        logger.warn({ userId: req.user!.id, err: error }, "knowledge repo saved, but the vault follow-up could not be started");
      }
    }
    res.json({ user });
  });

  // List the plugins the connected knowledge repo contains, for the selection
  // UI. Clones/fetches the repo (same working tree the agent's repo tools use).
  router.get("/api/me/knowledge-repo/contents", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    await respondRepoContents(res, ctx, "저장소를 가져오지 못했습니다");
  });

  // Build the second-brain `[[wikilink]]` graph for the interactive graph view,
  // from the viewer's vault notes in the memory service — never from the clone
  // (a file at a vault path there is not the vault's). Pure read, returns
  // {nodes, edges}; a service that cannot be used is an error, never an empty graph.
  router.get("/api/me/knowledge-repo/graph", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    const vault = memoryVaultFor(store, config, req.user!.id);
    try {
      const graph = await buildKnowledgeGraphFromNotes({
        list: () => vault.list(),
        read: (notePath) => readVaultNoteForGraph(vault, notePath),
      });
      res.json({ graph });
    } catch (error) {
      if (error instanceof MemoryUnavailableError) {
        apiError(res, 503, MEMORY_SERVICE_UNAVAILABLE);
        return;
      }
      apiError(res, 502, `지식 그래프를 만들지 못했습니다: ${scrubGitError(error)}`);
    }
  });

  // Read one note's markdown for the graph view's content panel. A graph node id
  // IS the repo-relative path, so the client passes it straight through; we only
  // serve markdown under wiki/ and raw/. A vault note is read from the memory
  // service; only a markdown file that cannot be a vault note is the clone's.
  router.get("/api/me/knowledge-repo/note", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const path = req.query.path;
    if (!isVaultNotePath(path)) {
      apiError(res, 400, "유효한 노트 경로가 아닙니다.");
      return;
    }
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    // A vault note is read in the memory service (classified the way the tools classify a path). A markdown
    // file the service cannot hold (e.g. under a dot folder) is not a vault note and is read from the clone
    // — unless it is a link into the clone's vault folders (`readFile` guards the traversal).
    const note = vaultNotePathOf(path);
    if (note) {
      try {
        const content = await memoryVaultFor(store, config, req.user!.id).read(note);
        res.json({ note: { path, content } });
      } catch (error) {
        if (error instanceof MemoryUnavailableError) {
          apiError(res, 503, MEMORY_SERVICE_UNAVAILABLE);
          return;
        }
        if (error instanceof Error && error.message === "NOT_FOUND") {
          apiError(res, 404, "노트를 찾을 수 없습니다.");
          return;
        }
        respondNoteFsError(res, error);
      }
      return;
    }
    try {
      const repoRoot = await ensureClone(ctx);
      assertNoVaultAlias(repoRoot, path);
      const content = await readFile(repoRoot, path);
      res.json({ note: { path, content } });
    } catch (error) {
      respondNoteFsError(res, error);
    }
  });

  // Force a re-sync of the connected knowledge repo from its remote. `ensureClone`
  // already does `git fetch --prune` + `checkout -B <branch> origin/<branch>` on
  // every call, so this is simply ensureClone + return the (possibly changed)
  // plugin list. No clone-cache to clear — knowledge repos aren't in `clonedPaths`.
  router.post("/api/me/knowledge-repo/refresh", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
    if (!ctx) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    await respondRepoContents(res, ctx, "새로고침 실패");
  });

  // Choose which knowledge-repo plugins the avatar loads. `selected: null`
  // (or all/empty) means "load all" — the repo is the avatar's by default.
  router.put("/api/me/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    if (!store.getKnowledgeRepo(req.user!.id).repo) {
      apiError(res, 404, "연결된 지식 저장소가 없습니다.");
      return;
    }
    const raw = req.body?.selected;
    let selected: string[] | null;
    if (raw === null || raw === undefined) {
      selected = null;
    } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
      selected = raw as string[];
    } else {
      apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
      return;
    }
    const user = store.setKnowledgeSelected(req.user!.id, selected);
    res.json({ user });
  });

  // ---- Knowledge (owner's gap inbox: colleague questions to handle) ----

  router.get("/api/me/knowledge/requests", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const status = safeString(req.query.status);
    const allowed = ["open", "resolved"] as const;
    const filter = (allowed as readonly string[]).includes(status)
      ? (status as (typeof allowed)[number])
      : undefined;
    res.json({ requests: store.listKnowledgeRequests(req.user!.id, filter) });
  });

  // Resolve (close) a gap once handled. No body: the avatar learns via plugins,
  // so there's no answer to store — clearing the request is the whole action.
  router.delete(
    "/api/me/knowledge/requests/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const resolved = store.resolveKnowledgeRequest(req.user!.id, req.params.id);
      if (!resolved) {
        apiError(res, 404, "정보 요청을 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  // ---- Avatar notifications (owner inbox / alarms) ---------------------

  router.get("/api/me/notifications", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ notifications: store.listAvatarNotifications(req.user!.id, req.query.unread === "1") });
  });

  router.post("/api/me/notifications/read-all", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ changed: store.markAllAvatarNotificationsRead(req.user!.id) });
  });

  router.delete("/api/me/notifications", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ deleted: store.deleteAllAvatarNotifications(req.user!.id) });
  });

  router.patch("/api/me/notifications/:id/read", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.markAvatarNotificationRead(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "알림을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/api/me/notifications/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.deleteAvatarNotification(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "알림을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
