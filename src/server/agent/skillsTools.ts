import fs from "node:fs";
import path from "node:path";
import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import { text } from "./mcpTools.js";

/**
 * `mcp__skills__read` — read-only access to skills that are listed in a pi
 * run's instructions but NOT copied into its sandbox (docs/architecture/pi-runtime.md
 * "Skills"): a trusted colleague chatting with someone's avatar runs in their
 * OWN sandbox, so the avatar owner's personal and plugin skills reach
 * them only through this tool. The skill set is the run's own (`sources`,
 * already filtered by the admin skill policy); an unlisted skill, a path out
 * of the skill folder, a link or a file over the cap is refused. Registered
 * only on pi runs that have such skills; every other run gets the refusal.
 */
export const SKILLS_SERVER_NAME = "skills";
export const SKILLS_TOOL_NAMES = ["mcp__skills__read"] as const;

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 300;
const SKIP_NAMES = new Set(["__pycache__", ".build", ".git", "node_modules"]);

export interface SkillsToolsContext {
  /** `<root>/<dir>` → host skill folder. Undefined/empty → every call refuses. */
  sources?: ReadonlyMap<string, string>;
}

/** The text a skill's `${CLAUDE_SKILL_DIR}` reads as when served by this tool. */
export function servedSkillDir(skill: string): string {
  return `skill:${skill}`;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string, depth: number): void => {
    if (depth > 8 || out.length >= MAX_LIST_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP_NAMES.has(entry.name) || out.length >= MAX_LIST_ENTRIES) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(abs, entry.name), childRel, depth + 1);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  visit(dir, "", 0);
  return out;
}

export function buildSkillsTools(ctx: SkillsToolsContext) {
  return [
    tool(
      "read",
      "Read a skill that your instructions list as 'read with mcp__skills__read' (the avatar owner's own skills, which are not copied into your sandbox). `skill` is its `<root>/<dir>` id from that list; `path` is a file inside the skill (default SKILL.md) — read SKILL.md first, then the files it names. Wherever a skill's text says `skill:<root>/<dir>/<file>`, read that file with this tool (skill `<root>/<dir>`, path `<file>`). A folder path lists its files. The skill's scripts are not in your sandbox: to run one, write a copy into your conversation folder first. Read-only.",
      {
        skill: z.string().describe("The skill id `<root>/<dir>` from your instructions' skill list"),
        path: z.string().optional().describe("A file or folder inside the skill (default SKILL.md)"),
      },
      async (args) => {
        const sources = ctx.sources;
        if (!sources || sources.size === 0) {
          return text(
            "No skills are served through this tool in this run. Your skills are files under /workspace/.noah/ — read their SKILL.md with the built-in read tool (paths are in your instructions).",
            true,
          );
        }
        const id = args.skill.trim().replace(/^skill:/, "").replace(/\/+$/, "");
        const root = sources.get(id);
        if (!root) {
          return text(`Unknown skill '${id}'. Skills served here: ${[...sources.keys()].join(", ")}.`, true);
        }
        const rel = (args.path ?? "SKILL.md").trim().replace(/^\/+/, "") || "SKILL.md";
        const parts = rel.split("/").filter((part) => part && part !== ".");
        if (parts.includes("..")) return text("The path must stay inside the skill folder.", true);
        let current = root;
        let stat: fs.Stats | undefined;
        for (const part of ["", ...parts]) {
          current = part ? path.join(current, part) : current;
          try {
            stat = fs.lstatSync(current, { throwIfNoEntry: false });
          } catch {
            stat = undefined;
          }
          if (!stat) return text(`'${rel}' does not exist in skill ${id}.`, true);
          if (stat.isSymbolicLink()) return text(`'${rel}' is a link, which this tool does not follow.`, true);
        }
        if (stat!.isDirectory()) {
          const files = listFiles(current);
          return text(`Files in skill ${id}${parts.length ? `/${parts.join("/")}` : ""}:\n${files.join("\n") || "(none)"}`);
        }
        if (!stat!.isFile()) return text(`'${rel}' is not a regular file.`, true);
        if (stat!.size > MAX_READ_BYTES) {
          return text(`'${rel}' is ${stat!.size} bytes, over the ${MAX_READ_BYTES / 1024} KB read limit of this tool.`, true);
        }
        const bytes = fs.readFileSync(current);
        if (bytes.includes(0)) return text(`'${rel}' is a binary file (${bytes.length} bytes); it cannot be shown as text.`, true);
        const body = bytes
          .toString("utf8")
          .split("${CLAUDE_SKILL_DIR}")
          .join(servedSkillDir(id))
          .replace(/timeout:\s*600000\b/g, "timeout: 600");
        return text(body);
      },
    ),
  ];
}

export function buildSkillsServer(ctx: SkillsToolsContext) {
  return createMcpToolServer({ name: SKILLS_SERVER_NAME, version: "0.1.0", tools: buildSkillsTools(ctx) });
}
