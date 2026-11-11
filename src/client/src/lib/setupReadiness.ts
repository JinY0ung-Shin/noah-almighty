import type { User } from "./types";

/**
 * The 시작하기 checklist predicates, shared by the explore progress card and the
 * welcome modal's quick steps. They lived as two hand-copied `$:` blocks and had
 * already drifted: the modal counted a stored CONFLUENCE_PAT as 권한 연결,
 * explore did not, so the same account read "완료" in one surface and "필요" in
 * the other.
 *
 * Reconciled on the SUPERSET (the modal's rule): any ONE of a git token, an SSH
 * key, or a Confluence PAT means the avatar can act on the user's behalf
 * somewhere, which is what the step promises. A stricter "all of them" reading
 * would leave the item permanently red for people who only ever need one.
 *
 * Callers pass whatever they hold — the app state's `user` (nullable) or a `User` prop
 * — so every predicate accepts null and answers false for a signed-out state.
 */
export type ReadinessUser = Pick<
  User,
  "alias" | "bio" | "intro" | "hashtags" | "knowledgeRepo" | "gitTokenSet" | "sshPublicKey" | "secretNames"
>;

/** 프로필: anything the avatar can introduce itself with. */
export function profileReady(user: Partial<ReadinessUser> | null | undefined): boolean {
  return Boolean(user && (user.alias || user.bio || user.intro || user.hashtags?.length));
}

/** 지식 저장소: a repo is connected (branch/selection are refinements, not readiness). */
export function knowledgeReady(user: Partial<ReadinessUser> | null | undefined): boolean {
  return Boolean(user?.knowledgeRepo);
}

/** 권한 연결: a git token, an SSH key (generated or stored), or a Confluence PAT. */
export function accessReady(user: Partial<ReadinessUser> | null | undefined): boolean {
  if (!user) return false;
  return Boolean(
    user.gitTokenSet ||
      user.sshPublicKey?.trim() ||
      user.secretNames?.includes("SSH_PRIVATE_KEY") ||
      user.secretNames?.includes("CONFLUENCE_PAT"),
  );
}
