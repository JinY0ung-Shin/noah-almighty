// Background-phase attribution for the live activity tree.
//
// Once a turn goes to the background (done{background:true}) ONE live tree keeps
// receiving rows from several turns: the finalized turn's still-running work (a
// background agent's tool calls, a background shell settling) and each wake-up
// turn's own tool calls. Every row is stamped at creation with the SEGMENT it
// belongs to — 0 for the visible turn, k for the k-th wake-up turn — and a row
// owned by a sub-agent inherits that agent's segment, so a background agent's
// late tool calls stay with the turn that spawned it. `segmentMessageIds[k]` is
// the persisted message segment k became; the in-flight segment has none yet.
// Outside the background phase everything is segment 0, so nothing changes.
import type { ChatPane, LiveAgentNode, LiveTaskRow, LiveToolRow } from "./types";

export interface SegmentRows {
  agents: LiveAgentNode[];
  tools: LiveToolRow[];
  tasks: LiveTaskRow[];
}

type SegmentedPane = Pick<
  ChatPane,
  "liveAgents" | "liveTools" | "liveTasks" | "liveSegment" | "segmentMessageIds" | "backgroundPhase"
>;

// Rows stamped before segments existed (or by a path that never stamps) count
// as the visible turn's.
const segmentOf = (row: { segment?: number }): number => row.segment ?? 0;

/** The segment a NEW row owned by `agentId` belongs to. */
export function rowSegment(pane: SegmentedPane, agentId: string): number {
  if (agentId && agentId !== "main") {
    const owner = pane.liveAgents.find((a) => a.id === agentId);
    if (owner && typeof owner.segment === "number") return owner.segment;
  }
  return pane.liveSegment ?? 0;
}

/** The live rows of one segment, or of several merged in tree order. The root node rides along so the tree can render. */
export function segmentRows(pane: SegmentedPane, segments: number | number[]): SegmentRows {
  const wanted = Array.isArray(segments) ? segments : [segments];
  const inSegment = (row: { segment?: number }) => wanted.includes(segmentOf(row));
  return {
    agents: pane.liveAgents.filter((a) => a.isMain || inSegment(a)),
    tools: pane.liveTools.filter(inSegment),
    tasks: pane.liveTasks.filter(inSegment),
  };
}

export function hasRows(rows: SegmentRows): boolean {
  return rows.tools.length > 0 || rows.tasks.length > 0 || rows.agents.some((a) => !a.isMain);
}

/**
 * During the background phase, the live rows of the segment a persisted
 * message embodies — rendered under THAT bubble rather than the trailing live
 * one. Null outside the phase, for a message that is no segment's, or when the
 * segment has nothing to show.
 */
export function messageSegmentRows(pane: SegmentedPane, messageId: string): SegmentRows | null {
  if (!pane.backgroundPhase || !messageId) return null;
  const segment = (pane.segmentMessageIds ?? []).indexOf(messageId);
  if (segment < 0) return null;
  const rows = segmentRows(pane, segment);
  return hasRows(rows) ? rows : null;
}

/**
 * The rows the trailing live bubble shows. A visible turn keeps showing the
 * whole tree as soon as its root exists (unchanged); in the background phase
 * it is the in-flight wake-up turn's rows only, and no card while there are none.
 */
export function liveSegmentRows(pane: SegmentedPane): SegmentRows | null {
  if (!pane.backgroundPhase) {
    return pane.liveAgents.length
      ? { agents: pane.liveAgents, tools: pane.liveTools, tasks: pane.liveTasks }
      : null;
  }
  const rows = segmentRows(pane, pane.liveSegment ?? 0);
  return hasRows(rows) ? rows : null;
}

/**
 * Which persisted message each segment's rows seal onto when the phase ends.
 * A segment with no message of its own (a wake-up turn still in flight when the
 * phase was killed) joins the newest earlier bubble that has one; a segment
 * with no such bubble at all is dropped, as the whole tree was before when the
 * finalized turn had no persisted id.
 */
export function segmentSealTargets(pane: SegmentedPane): Map<string, number[]> {
  const ids = pane.segmentMessageIds ?? [];
  const last = Math.max(pane.liveSegment ?? 0, ids.length - 1);
  const targets = new Map<string, number[]>();
  for (let segment = 0; segment <= last; segment += 1) {
    let target = "";
    for (let s = Math.min(segment, ids.length - 1); s >= 0 && !target; s -= 1) target = ids[s] || "";
    if (!target) continue;
    const segments = targets.get(target) ?? [];
    segments.push(segment);
    targets.set(target, segments);
  }
  return targets;
}
