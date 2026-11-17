// The three translation tables of the personal vault screens, and nothing else:
// no import, so the node test that pins them against the SERVER's code lists
// (`tests/client-vault-codes.test.ts`: `VAULT_MIRROR_ERROR`, `VAULT_BLOCKER`,
// `VAULT_SKIP`, `VAULT_LEFTOVER_BLOCKERS`, the notice prefix) can load this file
// without a DOM. A code added on either side without its twin fails that test.
// The sentences are composed in `personalVault.ts`.

/** What a mirror failure is about — it decides which way out the settings tab offers. */
export type VaultMirrorFailure =
  | "no_token"
  | "repo_dirty"
  | "rejected"
  | "denied"
  | "conflict"
  | "sync"
  | "not_cloned"
  | "service"
  | "refused"
  | "path"
  | "other";

/**
 * Every text the server stores in `mirrorError` (`VAULT_MIRROR_ERROR` in
 * `vaultMirror.ts`) → what it is about. A stored text is one of these heads,
 * alone or followed by `: <detail>` or ` (<detail>)`. `push` is told apart
 * further by git's own words; `other` shows the server's text as it came.
 */
export const VAULT_MIRROR_ERROR_KINDS: Record<string, VaultMirrorFailure | "push"> = {
  "repo has uncommitted changes": "repo_dirty",
  "no git token": "no_token",
  "not cloned": "not_cloned",
  "owner not found": "other",
  "memory service unavailable": "service",
  "memory service refused": "refused",
  "clone sync failed": "sync",
  "rebase conflict": "conflict",
  "push failed": "push",
  "commit failed": "other",
  "path blocked": "path",
  "mirror failed": "other",
};

/**
 * How the mirror's NOTICE begins (`VAULT_MIRROR_NOTICE.repoOnly` in
 * `vaultMirror.ts`): the repository holds vault notes the memory service does
 * not, and nothing was deleted. Stored as `<this>: <count>`.
 */
export const VAULT_MIRROR_NOTICE_PREFIX = "repository notes not in the memory service";

/** Korean sentence per blocker code; `detail: true` appends the server's detail. */
export const VAULT_BLOCKER_KO: Record<string, { text: string; detail?: true }> = {
  no_user: { text: "사용자를 찾을 수 없습니다." },
  memory_not_configured: { text: "이 서버에 메모리 서비스가 설정되어 있지 않습니다." },
  memory_unavailable: { text: "메모리 서비스에 연결하지 못했습니다. 잠시 후 다시 실행해 주세요." },
  refused: { text: "메모리 서비스가 노트를 받지 않았습니다.", detail: true },
  // The gate does not take a backup before a move: it HOLDS data-changing steps for the rest of a boot in which a backup failed.
  backup_failed: {
    text: "이 서버는 마지막으로 시작한 뒤 데이터베이스 백업에 실패해서, 데이터를 바꾸는 관리 작업을 모두 멈춰 두고 있습니다(이유는 서버 로그에 있습니다). 원인을 고치고 서버를 다시 시작하기 전에는 아무도 옮기지 않습니다.",
  },
  repo_changed: { text: "살펴보는 동안 본인이 연결한 저장소나 브랜치를 바꿨습니다. 새로 연결한 저장소는 따로 처리되니 잠시 뒤 다시 확인해 주세요." },
  run_in_progress: { text: "이 팀원의 아바타가 지금 작업 중입니다. 작업이 끝난 뒤 다시 실행해 주세요." },
  no_git_token: { text: "Git 토큰이 없어 저장소를 최신으로 가져올 수 없습니다. 본인이 설정 ▸ 권한·연결에서 Git 토큰을 설정해야 합니다." },
  sync_failed: { text: "저장소를 최신으로 가져오지 못했습니다.", detail: true },
  uncommitted_changes: { text: "저장소에 커밋하지 않은 변경이 있습니다. 본인의 아바타가 커밋·푸시를 마친 뒤 다시 실행해 주세요.", detail: true },
  unpushed_commits: { text: "저장소에 아직 올리지 않은 커밋이 있습니다. 본인의 아바타가 푸시를 마친 뒤 다시 실행해 주세요.", detail: true },
  note_too_large: { text: "512 KiB를 넘는 노트가 있습니다. 노트를 나누거나 줄인 뒤 다시 실행해 주세요.", detail: true },
  not_utf8: { text: "UTF-8 텍스트가 아닌 노트가 있습니다. 파일을 고친 뒤 다시 실행해 주세요.", detail: true },
  invalid_content: { text: "메모리 서비스가 담을 수 없는 문자(NUL)가 든 노트가 있습니다. 파일을 고친 뒤 다시 실행해 주세요.", detail: true },
  // The repository's own problem: two files that are ONE note path once normalized. The service holds nothing.
  note_conflict: { text: "저장소에 같은 노트 경로가 되는 파일이 둘 있고 내용이 다릅니다. 하나로 정리한 뒤 다시 실행해 주세요.", detail: true },
  service_note_conflict: {
    text: "메모리 서비스에 같은 경로로 내용이 다른 노트가 남아 있습니다. 남은 사본을 비운 뒤 다시 실행해 주세요.",
    detail: true,
  },
  service_only_note: { text: "메모리 서비스에 저장소에는 없는 노트가 남아 있습니다. 남은 사본을 비운 뒤 다시 실행해 주세요.", detail: true },
  vault_folder_link: {
    text: "저장소의 wiki/ 또는 raw/가 폴더가 아니라 링크(또는 파일)라서 옮길 수 없습니다. 옮긴 뒤 그 자리에 사본을 쓸 수 없기 때문입니다. 저장소에서 일반 폴더로 바꾼 뒤 다시 실행해 주세요.",
    detail: true,
  },
  wiki_full: { text: "메모리 서비스의 한도(노트 10,000개 또는 256 MiB)를 넘습니다.", detail: true },
  source_changed: { text: "옮기는 동안 저장소의 파일이 바뀌었습니다. 다시 실행해 주세요.", detail: true },
  verify_failed: { text: "옮긴 노트가 저장소의 파일과 같은지 확인하지 못해 옮기지 않았습니다. 다시 실행해 주세요.", detail: true },
  internal_error: { text: "예상하지 못한 오류로 옮기지 못했습니다. 서버 로그를 확인해 주세요." },
};

/** The blockers that mean "the service's leftover copy is in the way" — the CODE only, never the sentence (`VAULT_LEFTOVER_BLOCKERS` in `vaultMigration.ts`). */
export const VAULT_LEFTOVER_BLOCKERS: readonly string[] = ["service_note_conflict", "service_only_note"];

/** Korean reason per skip code (`VAULT_SKIP` in `vaultMigration.ts`). */
export const VAULT_SKIP_KO: Record<string, string> = {
  not_markdown: "마크다운(.md) 노트가 아닙니다",
  dot_name: "점(.)으로 시작하는 폴더나 파일 이름이 경로에 있습니다",
  too_deep: "폴더가 너무 깊습니다 (16단계 초과)",
  path_too_long: "경로가 너무 깁니다 (512바이트 초과, 또는 이름 하나가 255바이트 초과)",
  invalid_path: "경로에 역슬래시나 제어 문자가 있습니다",
  "unsupported path": "메모리 서비스가 담을 수 없는 경로입니다",
  symlink: "링크 파일입니다 (링크는 따라가지 않습니다)",
  not_a_file: "일반 파일이 아닙니다",
  duplicate: "경로를 정규화하면 다른 파일과 같은 노트입니다 (내용도 같음)",
};
