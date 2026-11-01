// Shared arg guards for the repo clone/commit/push paths (knowledgeRepo.ts,
// gitRepos.ts, marketplace.ts). A value git would read
// as an option (e.g. an identity or branch starting with "-") is a security hole,
// so these guards are intentionally identical across all call sites — kept
// in one place rather than copy-pasted. The identity/branch checks fall back to a
// safe default rather than fail; `assertSafeGitValue` throws.

// `scheme::` remote-helper syntax (e.g. `ext::sh -c …`, `fd::`) makes git run an
// arbitrary transport helper as a subprocess — a command-execution vector, and
// this process holds SESSION_SECRET. A `--` separator does NOT stop it: the
// scheme is part of the URL, not an option.
//
// git's own default protocol policy currently refuses `ext` ("fatal: transport
// 'ext' not allowed"), but that is git's default, not our guard — a
// `protocol.ext.allow`/`GIT_ALLOW_PROTOCOL` setting or a differently-built git
// re-opens it. Reject the syntax here so no clone path depends on that default.
//
// No legitimate branch, path, repo shorthand, or https/ssh URL we accept contains
// `::`, so rejecting it is safe across every value kind (sec-03).
const REMOTE_HELPER_RE = /^[a-z0-9+.-]*::/i;

/**
 * THE single arg-safety validator for every git value that reaches a `git`
 * argv (repo/url/branch/ref). Rejects values git would read as an option and
 * remote-helper syntax. Every clone path must funnel through this — previously
 * `gitRepos.ts` had the remote-helper check while the knowledge/group clone
 * paths only checked for a leading dash (T3.8).
 *
 * This is arg-safety ONLY. It deliberately does NOT judge the transport or host
 * (a bare local path is a legitimate repo source — `register_repo` accepts one by
 * design, and the offline tests clone from local bare remotes). Source/host
 * POLICY belongs at the entry point that claims it: see `isInternalGitSource`.
 */
export function assertSafeGitValue(value: string | null | undefined, what: string): void {
  if (value == null) {
    return;
  }
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${what}: must not start with "-"`);
  }
  if (REMOTE_HELPER_RE.test(value)) {
    throw new Error(`Invalid ${what}: remote-helper syntax ("<scheme>::") is not allowed`);
  }
}

/**
 * Guard a commit author identity against values git would read as options
 * (passed positionally after the config key). Falls back to safe defaults when a
 * field starts with "-".
 */
export function safeIdentity(identity: { name: string; email: string }): {
  name: string;
  email: string;
} {
  return {
    name: identity.name.startsWith("-") ? "noah-almighty" : identity.name,
    email: identity.email.startsWith("-") ? "avatar@noah-almighty.local" : identity.email,
  };
}

/**
 * Guard a push branch against a value git would read as an option. Falls back to
 * "HEAD" when the resolved branch starts with "-".
 */
export function safePushBranch(rawBranch: string): string {
  return rawBranch.startsWith("-") ? "HEAD" : rawBranch;
}
