import type { ChatPane, SkillInfo } from "./types";
import { readState } from "./state";
import { TOUR_SLUG_LIST } from "../../../shared/tourScenarios";

export interface SlashCommand {
  name: string;
  title: string;
  description: string;
  argsLabel?: string;
  ownerOnly?: boolean;
  /**
   * Runs only on a LOCAL avatar session (Noah's own SDK run). Hidden in an
   * external avatar's pane, whose gateway has no such command — the server
   * refuses it there, so the menu never offers it.
   */
  nativeOnly?: boolean;
  requiresArgs?: boolean;
  prompt?: (args: string) => string;
  action?: "new";
  /** "skill" entries are built from the avatar's installed skills (not the static list above). */
  kind?: "skill";
  /** For skill entries: where the skill came from ("default" or a plugin slug). */
  source?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    title: "새 대화",
    description: "현재 아바타와 새 대화를 바로 시작합니다.",
    action: "new",
  },
  {
    name: "tour",
    title: "체험 시나리오",
    argsLabel: "시나리오",
    // The slug list comes from the shared contract, never a hand-copy — a new
    // scenario has to show up here without anyone remembering to edit this line.
    description: `대표 기능을 짧은 실습으로 함께 해봅니다. 고를 수 있는 시나리오: ${TOUR_SLUG_LIST}.`,
    ownerOnly: true,
    requiresArgs: true,
  },
  {
    name: "summarize",
    title: "요약",
    description: "지금까지의 대화를 요약합니다.",
  },
  {
    // The literal goes out as-is and the server runs the CLI's own /compact on the
    // conversation's session — the summary REPLACES what the model sees next.
    name: "compact",
    title: "대화 맥락 정리",
    argsLabel: "남길 내용",
    description: "지금까지의 대화를 요약해 컨텍스트를 줄입니다. 뒤에 적은 내용은 요약에 꼭 남길 것으로 전달됩니다.",
    nativeOnly: true,
  },
  {
    name: "learn",
    title: "세션 학습",
    description: "이번 대화에서 재사용할 지식을 추려, 저장 전에 먼저 확인을 받습니다.",
    ownerOnly: true,
  },
  {
    name: "remember",
    title: "지식 저장",
    argsLabel: "내용",
    description: "뒤에 쓴 내용을 내 지식 저장소에 기록하게 합니다.",
    ownerOnly: true,
    requiresArgs: true,
  },
  {
    name: "routine",
    title: "예약 작업 만들기",
    argsLabel: "작업",
    description: "작업 내용을 받아 한 번 또는 반복 실행할 예약 작업 생성을 요청합니다.",
    ownerOnly: true,
    requiresArgs: true,
  },
  {
    name: "find",
    title: "아바타 찾기",
    argsLabel: "요청",
    description: "요청에 맞는 동료 아바타를 찾아 추천하게 합니다.",
    requiresArgs: true,
  },
];

export function commandsForPane(pane: ChatPane | null): SlashCommand[] {
  const ownsAvatar = Boolean(pane?.avatar?.isOwn || (pane?.avatar?.id && pane.avatar.id === readState().user?.id));
  const external = pane?.avatar?.runtime === "external";
  return SLASH_COMMANDS.filter((cmd) => (!cmd.ownerOnly || ownsAvatar) && !(cmd.nativeOnly && external));
}

/**
 * Whether a text is the `/compact` command (with or without what to keep). It runs
 * as its own turn, never as a mid-turn message (it would reach the CLI as a command
 * in the middle of a run), and its row is not re-runnable with 다시 생성.
 */
export function isCompactCommandText(text: string | null | undefined): boolean {
  return /^\/compact(?:\s|$)/i.test((text ?? "").trim());
}

export function resolveTypedSlashCommand(pane: ChatPane | null, message: string): { command: SlashCommand; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match || message.startsWith("//")) return null;
  const name = match[1].toLowerCase();
  const command = commandsForPane(pane).find((cmd) => cmd.name === name);
  if (!command) return null;
  return { command, args: (match[2] || "").trim() };
}

/**
 * Build a slash-menu entry from one of the avatar's installed skills. Built-in
 * commands above send only the literal "/command" and let the SERVER swap in the
 * expanded (agent-facing) prompt; a skill instead sends a natural-language
 * instruction that names the skill, so the agent loads and runs it (and asks for
 * any missing input). Skill names may contain characters like ":" that aren't
 * typeable as a raw "/command", so these are reachable through the menu (and
 * free-text search), not the typed-slash path.
 */
export function skillToSlashCommand(skill: SkillInfo): SlashCommand {
  const name = skill.name;
  return {
    name,
    title: name,
    description: skill.description || "이 스킬을 실행합니다.",
    kind: "skill",
    source: skill.source,
    prompt: (args) => {
      const base = `"${name}" 스킬을 사용해서 진행해줘. 필요한 정보가 부족하면 먼저 물어봐줘.`;
      return args ? `${base}\n\n${args}` : base;
    },
  };
}

/** Built-in commands for the pane plus any installed skills, all searchable together. */
export function menuCommandsForPane(pane: ChatPane | null): SlashCommand[] {
  const skills = (pane?.skills || []).map(skillToSlashCommand);
  return [...commandsForPane(pane), ...skills];
}

/** Filter a command list by a slash query (matches name/title/description/source). */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands;
  return commands.filter((cmd) =>
    [cmd.name, cmd.title, cmd.description, cmd.argsLabel || "", cmd.source || ""].some((v) =>
      v.toLowerCase().includes(query),
    ),
  );
}
