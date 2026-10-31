// Skills shipped in plugin roots: `<root>/skills/<dir>/SKILL.md`, the layout
// default-skills, owner plugins and knowledge-repo scaffolds all use. Read by
// the admin tool/skill policy (the global list), the pi skill sync
// (`pi/piSkills.ts`) and skill sharing (`skillTransfer.ts`).

import fs from "node:fs";
import path from "node:path";
import type { DiscoveredSkill } from "../toolSkillPolicy.js";

/** Cap for SKILL.md reads — frontmatter sits at the top of the file. */
const SKILL_MD_READ_BYTES = 4096;

/** Read a SKILL.md's frontmatter name/description (capped, tolerant). Also
 *  used by skillTransfer.ts to snapshot share metadata. */
export function skillMdMeta(filePath: string): { name?: string; description?: string } {
  let head: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(SKILL_MD_READ_BYTES);
      const read = fs.readSync(fd, buf, 0, SKILL_MD_READ_BYTES, 0);
      head = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  if (!head.startsWith("---")) {
    return {};
  }
  const end = head.indexOf("\n---", 3);
  const frontmatter = end >= 0 ? head.slice(0, end) : head;
  const pick = (key: "name" | "description"): string | undefined => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: pick("name"), description: pick("description") };
}

/**
 * Enumerate skills shipped by a run's plugin roots — `<root>/skills/<dir>/SKILL.md`,
 * the layout default-skills, owner plugins, and knowledge-repo scaffolds all
 * use. Name comes from SKILL.md frontmatter, falling back to the directory
 * name. Unreadable roots are skipped. The admin skill policy lists the bundled
 * default-skills root with it; pi runs copy (or serve) only what the policy
 * leaves enabled (`pi/piSkills.ts`).
 */
export function listPluginRootSkills(rootPaths: string[]): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of rootPaths) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const mdPath = path.join(root, "skills", entry.name, "SKILL.md");
      if (!fs.existsSync(mdPath)) {
        continue;
      }
      const meta = skillMdMeta(mdPath);
      const name = meta.name || entry.name;
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, description: meta.description ?? "" });
      }
    }
  }
  return out;
}
