import { agentTitle, openAgentCards, toggleAgentCard } from "../lib/agentCards";
import { useStore } from "../lib/hooks";
import type { LiveAgentNode, LiveTaskRow, LiveToolRow } from "../lib/types";

export interface ActivityTreeProps {
  agentId?: string;
  agents: LiveAgentNode[];
  tools: LiveToolRow[];
  tasks?: LiveTaskRow[];
  /**
   * Fold each sub-agent card's own rows behind its header. Left unset at the
   * root, which decides for the whole tree: several agents working side by side
   * stack every call into one long scroll, so each card then shows only its
   * latest call until the viewer opens it. A lone agent keeps its rows in view.
   * Nested trees inherit the root's decision.
   */
  fold?: boolean;
}

const NO_TASKS: LiveTaskRow[] = [];

const statusLabels: Record<string, string> = {
  running: "진행 중",
  done: "완료",
  failed: "실패",
  blocked: "승인 대기",
};

function rowLabel(kind: string, label: string, status: string, detail = ""): string {
  return [kind, label, statusLabels[status] || status, detail].filter(Boolean).join(" · ");
}
// kind "compact" (a context compaction) shares the tool-row rendering but is
// not a tool call — so its accessible name must not announce it as one.
function toolRowKind(kind: string): string {
  return kind === "compact" ? "맥락" : "도구";
}

function TaskRow({ row }: { row: LiveTaskRow }) {
  const label = rowLabel("태스크", row.label || "작업", row.status, row.detail || "");
  return (
    <div className="task-row" data-status={row.status} role="listitem" title={label} aria-label={label}>
      <span className="task-spinner"></span>
      <span className="task-badge">태스크</span>
      {row.label ? <span className="task-name">{row.label}</span> : null}
      {row.detail ? <span className="task-detail">{row.detail}</span> : null}
    </div>
  );
}

function ToolRow({ row }: { row: LiveToolRow }) {
  const kindName = toolRowKind(row.kind);
  const label = rowLabel(kindName, row.label, row.status, row.detail || "");
  return (
    <div
      className={`tool-row ${row.kind === "blocked" ? "blocked" : ""}`}
      data-status={row.status}
      role="listitem"
      title={label}
      aria-label={label}
    >
      {row.status === "blocked" ? <span className="tool-dot"></span> : <span className="tool-spinner"></span>}
      <span className="tool-name">{row.label}</span>
      {row.detail ? <span className="tool-arg">{row.detail}</span> : null}
    </div>
  );
}

export default function ActivityTree({ agentId = "main", agents, tools, tasks = NO_TASKS, fold }: ActivityTreeProps) {
  const openCards = useStore(openAgentCards);

  const folding = fold ?? agents.filter((a) => !a.isMain).length >= 2;
  const node = agents.find((a) => a.id === agentId);
  const title = node ? agentTitle(node) : "";
  // kind "memory" rows (second-brain captures) are summary-line chips, not tree
  // rows: they must be visible while the disclosure is COLLAPSED, so ChatView
  // renders them on the <summary> and the tree skips them here.
  const ownTools = tools.filter((t) => t.agentId === agentId && t.kind !== "task" && t.kind !== "memory");
  const ownTasks: LiveTaskRow[] = [
    ...tasks.filter((t) => t.agentId === agentId),
    ...tools
      .filter((t) => t.agentId === agentId && t.kind === "task")
      .map(
        (t) =>
          ({
            id: t.id,
            agentId: t.agentId,
            label: t.label,
            detail: t.detail,
            status: t.status === "failed" ? "failed" : t.status === "running" ? "running" : "done",
          }) satisfies LiveTaskRow,
      ),
  ];
  const children = agents.filter((a) => a.parentId === agentId && !a.isMain);
  // Only a card with rows to hide gets the disclosure: a just-spawned agent has
  // nothing behind a chevron yet.
  const foldable = folding && !!node && !node.isMain && ownTools.length + ownTasks.length > 0;
  const open = !foldable || openCards.has(agentId);
  const latestTool = ownTools[ownTools.length - 1];
  const latestTask = ownTasks[ownTasks.length - 1];
  const rowCount = [
    ownTools.length ? `도구 ${ownTools.length}개` : "",
    ownTasks.length ? `태스크 ${ownTasks.length}개` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (!node) return null;

  return (
    <div
      className={`agent-node ${node.isMain ? "is-main" : "sub"}`}
      data-status={node.status}
      role={node.isMain ? undefined : "listitem"}
      aria-label={node.isMain ? undefined : rowLabel("에이전트", title, node.status)}
    >
      {!node.isMain ? (
        foldable ? (
          // An explicit name: the text content would carry the badge's
          // decorative ◆ and miss the run status the listitem announces.
          <button
            type="button"
            className="agent-head agent-toggle"
            aria-expanded={open}
            aria-label={rowLabel("에이전트", title, node.status, rowCount)}
            title={open ? "접기" : "펼치기"}
            onClick={() => toggleAgentCard(agentId)}
          >
            <span className="agent-spinner"></span>
            <span className="agent-badge">에이전트</span>
            {node.name ? <span className="agent-name">{`@${node.name}`}</span> : null}
            <span className="agent-label">{node.label}</span>
            <span className="agent-meta">
              <span className="agent-count">{rowCount}</span>
              <span className="agent-chevron" aria-hidden="true"></span>
            </span>
          </button>
        ) : (
          <div className="agent-head">
            <span className="agent-spinner"></span>
            <span className="agent-badge">에이전트</span>
            {node.name ? <span className="agent-name">{`@${node.name}`}</span> : null}
            <span className="agent-label">{node.label}</span>
          </div>
        )
      ) : null}
      {open ? (
        <>
          {ownTasks.length ? (
            <div className="agent-tasks" role="list" aria-label={`${title} 태스크`}>
              {ownTasks.map((row) => (
                <TaskRow key={row.id} row={row} />
              ))}
            </div>
          ) : null}
          {ownTools.length ? (
            <div className="agent-tools" role="list" aria-label={`${title} 도구 실행`}>
              {ownTools.map((row) => (
                <ToolRow key={row.id} row={row} />
              ))}
            </div>
          ) : null}
        </>
      ) : latestTool ? (
        // Folded: the card's most recent call stands in for its whole list.
        <div className="agent-tools" role="list" aria-label={`${title} 최근 도구 실행`}>
          <ToolRow row={latestTool} />
        </div>
      ) : latestTask ? (
        <div className="agent-tasks" role="list" aria-label={`${title} 최근 태스크`}>
          <TaskRow row={latestTask} />
        </div>
      ) : null}
      {children.length ? (
        <div className="agent-children" role="list" aria-label={`${title} 하위 에이전트`}>
          {children.map((child) => (
            <ActivityTree key={child.id} agentId={child.id} agents={agents} tools={tools} tasks={tasks} fold={folding} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
