import fs from "node:fs";
import path from "node:path";

/**
 * Disk primitives shared by the boot-time retirements of removed features
 * (`retirePersonalAgents.ts`, `retireExternalAvatars.ts`): remove a retired
 * file or tree without ever following a link, list a folder, and tally every
 * failure so a retirement can withhold its completion marker until a clean
 * pass. Nothing here throws.
 */

/** How many failed paths a retirement warning names. */
const FAILED_PATH_SAMPLE = 20;

export interface SweepTally {
  failures: number;
  /** The first FAILED_PATH_SAMPLE failed paths, each with its error code. */
  sample: string[];
}

export function recordFailure(sweep: SweepTally, target: string, code: string | undefined): void {
  sweep.failures += 1;
  if (sweep.sample.length < FAILED_PATH_SAMPLE) {
    sweep.sample.push(`${target} (${code ?? "error"})`);
  }
}

export function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function isPermissionError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "EACCES" || code === "EPERM";
}

/**
 * Remove `target` — a file, a link (unlinked, never followed) or a whole tree —
 * when it exists; true when it is gone. A read-only directory inside a tree
 * (what `go mod download` leaves behind) makes every unlink in it fail with
 * EACCES, so on a permission error the target and every real directory below
 * it are made owner-writable and the removal is retried once. Anything still
 * in place counts as a failure.
 */
export function removeRetired(target: string, sweep: SweepTally): boolean {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target, { throwIfNoEntry: false });
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
    return false;
  }
  if (!stat) {
    return true;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (!stat.isDirectory() || !isPermissionError(err)) {
      recordFailure(sweep, target, errorCode(err));
      return false;
    }
  }
  grantOwnerAccess(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
    return false;
  }
}

/**
 * Add u+rwx to `dir` ITSELF and to every real directory below it, each BEFORE
 * it is read (a 0000 or 0444 folder cannot even be listed). Every entry is
 * lstat-checked first and a link is never chmodded or descended into:
 * chmodSync follows links, and Node has no lchmod on Linux, so following one
 * could rewrite the mode of a folder outside the retired tree. Nothing above `dir`
 * is touched. Best-effort: the retried removal is what decides success.
 */
function grantOwnerAccess(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      return;
    }
    fs.chmodSync(dir, (stat.mode & 0o7777) | 0o700);
  } catch {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      grantOwnerAccess(path.join(dir, entry.name));
    }
  }
}

/**
 * The entries of `dir` ([] when it does not exist). Any other listing error
 * counts as a failure and yields null, so a folder that cannot be read never
 * lets the marker be stamped.
 */
export function listEntries(dir: string, sweep: SweepTally): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    recordFailure(sweep, dir, code);
    return null;
  }
}

/** One path segment that cannot climb out of its folder. */
export function isPlainSegment(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}
