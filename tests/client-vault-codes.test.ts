// The personal vault screens translate three closed lists of SERVER texts into
// Korean (`src/client/src/lib/personalVaultCodes.ts`): what the mirror stores
// in `mirrorError`, the migration's blocker codes and its skip codes — plus the
// codes that offer "남은 사본 비우기" and the mirror's notice. The server's lists
// are imported here, so a code added on one side without its twin fails:
// a server code without a translation would reach a person as raw English, and
// a translation without a server code is dead text nobody can see.
//
// Node project (no DOM): the tables live in a file without imports.
import { describe, expect, it } from "vitest";

import {
  VAULT_BLOCKER_KO,
  VAULT_LEFTOVER_BLOCKERS as CLIENT_LEFTOVER_BLOCKERS,
  VAULT_MIRROR_ERROR_KINDS,
  VAULT_MIRROR_NOTICE_PREFIX,
  VAULT_SKIP_KO,
} from "../src/client/src/lib/personalVaultCodes";
import { VAULT_BLOCKER, VAULT_LEFTOVER_BLOCKERS, VAULT_SKIP } from "../src/server/vaultMigration";
import { VAULT_MIRROR_ERROR, VAULT_MIRROR_NOTICE } from "../src/server/vaultMirror";

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe("the client's vault translation tables cover exactly the server's code lists", () => {
  it("mirror errors: every text the mirror stores has a kind, and no kind is left without a server text", () => {
    expect(sorted(Object.keys(VAULT_MIRROR_ERROR_KINDS))).toEqual(sorted(Object.values(VAULT_MIRROR_ERROR)));
  });

  it("blockers: every code has a Korean sentence, and no sentence is left without a code", () => {
    expect(sorted(Object.keys(VAULT_BLOCKER_KO))).toEqual(sorted(Object.values(VAULT_BLOCKER)));
    for (const [code, entry] of Object.entries(VAULT_BLOCKER_KO)) {
      expect(entry.text, code).toMatch(/[가-힣]/);
    }
  });

  it("skip reasons: every code has a Korean reason, and no reason is left without a code", () => {
    expect(sorted(Object.keys(VAULT_SKIP_KO))).toEqual(sorted(Object.values(VAULT_SKIP)));
    for (const [code, text] of Object.entries(VAULT_SKIP_KO)) {
      expect(text, code).toMatch(/[가-힣]/);
    }
  });

  it("the codes that offer 남은 사본 비우기 are the server's, and each is a blocker code", () => {
    expect(sorted(CLIENT_LEFTOVER_BLOCKERS)).toEqual(sorted(VAULT_LEFTOVER_BLOCKERS));
    for (const code of CLIENT_LEFTOVER_BLOCKERS) {
      expect(Object.values(VAULT_BLOCKER) as string[]).toContain(code);
    }
  });

  it("the notice: the one the mirror stores is the one the client reads the count from", () => {
    expect(Object.values(VAULT_MIRROR_NOTICE)).toEqual([VAULT_MIRROR_NOTICE_PREFIX]);
  });

  it("no code is a prefix of another in the same list (each list is matched by its beginning)", () => {
    for (const list of [Object.values(VAULT_MIRROR_ERROR), Object.values(VAULT_BLOCKER), Object.values(VAULT_SKIP)] as string[][]) {
      for (const a of list) {
        for (const b of list) {
          if (a !== b) expect(b.startsWith(`${a}:`) || b.startsWith(`${a} (`), `${a} / ${b}`).toBe(false);
        }
      }
    }
  });
});
