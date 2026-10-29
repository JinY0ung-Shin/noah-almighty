import fs from "node:fs";
import path from "node:path";
import logger from "./logger.js";
import { BACKUP_DIR } from "./store/retirementBackup.js";

/**
 * Disk primitives shared by the boot-time retirements of removed features
 * (`retirePersonalAgents.ts`, `retireExternalAvatars.ts`, `retireGroupAgents.ts`,
 * `retireCraftApps.ts`, `retiredSessionFiles.ts`): QUARANTINE a retired file or
 * tree — move it, never delete it (user decision 2026-10-29) — without ever
 * following a link, list a folder, and tally every failure so a retirement can
 * withhold its completion marker until a clean pass. Nothing here throws.
 *
 * Quarantine layout: `<dataDir>/retired/<boot stamp>/<path relative to
 * dataDir>`, one stamp per boot (the same one the pre-retirement DB backup
 * carries, `store/retirementBackup.ts`), folders created 0700. Noah never reads,
 * serves, sweeps or prunes `retired/`: cleanup is the operator's, by hand
 * (docs/architecture/server-core.md, "Retirement backup and quarantine").
 */

/** How many failed paths a retirement warning names. */
const FAILED_PATH_SAMPLE = 20;
/** The quarantine root under `dataDir`. Reserved: no other code writes or reads it. */
export const QUARANTINE_DIR = "retired";

/** Where this boot's retirements move what they retire. */
export interface Quarantine {
  dataDir: string;
  /** The boot's UTC stamp (`retirementStamp`), the folder name under `retired/`. */
  stamp: string;
}

export interface SweepTally {
  failures: number;
  /** The first FAILED_PATH_SAMPLE failed paths, each with its error code. */
  sample: string[];
  quarantine: Quarantine;
}

/** A fresh tally for one retirement pass of this boot. */
export function newSweep(quarantine: Quarantine): SweepTally {
  return { failures: 0, sample: [], quarantine };
}

/**
 * The tally for one retirement pass, or null when this boot's retirement gate
 * is HELD (the pre-retirement DB backup failed): the pass is then skipped
 * whole — nothing moved, nothing purged, no marker — with one warning, and the
 * next boot runs it once its backup succeeds.
 */
export function openRetirementSweep(
  dataDir: string,
  gate: { allowed: boolean; stamp: string },
  label: string,
): SweepTally | null {
  if (!gate.allowed) {
    logger.warn(`retired ${label} purge skipped on this boot: the pre-retirement database backup failed; it runs once a backup succeeds`);
    return null;
  }
  return newSweep({ dataDir, stamp: gate.stamp });
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
 * Move `target` — a file, a link (moved AS a link, never followed) or a whole
 * tree — into this boot's quarantine at the same path relative to `dataDir`;
 * true when it is no longer at `target`. One rename, so nothing inside a tree is
 * opened, followed or rewritten. Refused (left in place, counted as a failure):
 * a target outside `dataDir` or inside Noah's own `retired/`/`backups/`, a
 * quarantine root or folder on the way that is a link, an occupied destination
 * (except a folder merged into one, see mergeIntoQuarantine), and EXDEV — a target on another filesystem is NEVER copied and deleted, it
 * stays where it is and the caller keeps it pending. Renaming a folder to a new
 * parent needs write access to the folder itself, so on a permission error a
 * real folder (never a link) gets u+w, the rename is retried once, and the
 * moved folder gets its old mode back.
 */
export function quarantineRetired(target: string, sweep: SweepTally): boolean {
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
  const { dataDir } = sweep.quarantine;
  const rel = path.relative(dataDir, target);
  const [head] = rel.split(path.sep);
  if (!rel || path.isAbsolute(rel) || head === ".." || head === QUARANTINE_DIR || head === BACKUP_DIR) {
    recordFailure(sweep, target, "OUTSIDE_QUARANTINE_SCOPE");
    return false;
  }
  let destination: string;
  let occupied: fs.Stats | undefined;
  try {
    ({ destination, occupied } = prepareDestination(sweep.quarantine, rel));
  } catch (err) {
    recordFailure(sweep, target, errorCode(err) ?? (err as Error).message);
    return false;
  }
  if (occupied) {
    return mergeIntoQuarantine(target, stat, occupied, sweep);
  }
  try {
    fs.renameSync(target, destination);
    return true;
  } catch (err) {
    if (errorCode(err) === "EXDEV") {
      logger.warn(
        { target, quarantine: destination },
        "retired item is on another filesystem than the quarantine folder and was left in place (never copied and deleted)",
      );
    }
    if (!stat.isDirectory() || !isPermissionError(err)) {
      recordFailure(sweep, target, errorCode(err));
      return false;
    }
  }
  const mode = stat.mode & 0o7777;
  let moved = false;
  try {
    fs.chmodSync(target, mode | 0o700);
    fs.renameSync(target, destination);
    moved = true;
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
  }
  try {
    // lstat-checked above: a real folder, so chmod cannot follow a link.
    fs.chmodSync(moved ? destination : target, mode);
  } catch {
    // Cosmetic: the folder's old mode, best effort.
  }
  return moved;
}

/**
 * A folder whose quarantine destination already exists: an earlier move of this
 * boot put something from INSIDE it there (a session transcript moved by id,
 * then its whole project folder by name). Both must be REAL folders; each entry
 * is then quarantined on its own (recursing the same way) and the emptied
 * folder removed — only an empty folder, so nothing is ever deleted. Anything
 * else is refused.
 */
function mergeIntoQuarantine(target: string, stat: fs.Stats, occupied: fs.Stats, sweep: SweepTally): boolean {
  if (!stat.isDirectory() || !occupied.isDirectory()) {
    recordFailure(sweep, target, "QUARANTINE_OCCUPIED");
    return false;
  }
  const entries = listEntries(target, sweep);
  if (entries === null) {
    return false;
  }
  let complete = true;
  for (const entry of entries) {
    complete = quarantineRetired(path.join(target, entry.name), sweep) && complete;
  }
  if (!complete) {
    return false;
  }
  try {
    fs.rmdirSync(target);
    return true;
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
    return false;
  }
}

/**
 * The destination for `rel` under `retired/<stamp>/`, every folder on the way
 * created 0700 or verified to be a REAL folder (a link there would send the
 * move somewhere else), plus what already occupies it, if anything. Throws a
 * coded error.
 */
function prepareDestination(quarantine: Quarantine, rel: string): { destination: string; occupied: fs.Stats | undefined } {
  let dir = quarantine.dataDir;
  for (const segment of [QUARANTINE_DIR, quarantine.stamp, ...path.dirname(rel).split(path.sep)]) {
    if (segment === "." || segment === "") {
      continue;
    }
    dir = path.join(dir, segment);
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!existing) {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    } else if (!existing.isDirectory()) {
      throw Object.assign(new Error("QUARANTINE_PATH_NOT_A_FOLDER"), { code: "QUARANTINE_PATH_NOT_A_FOLDER" });
    }
  }
  const destination = path.join(quarantine.dataDir, QUARANTINE_DIR, quarantine.stamp, rel);
  return { destination, occupied: fs.lstatSync(destination, { throwIfNoEntry: false }) };
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
