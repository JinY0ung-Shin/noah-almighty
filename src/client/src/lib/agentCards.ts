import { writable } from "svelte/store";
import type { LiveAgentNode } from "./types";

/**
 * Sub-agent cards the viewer opened while several agents share one activity
 * tree (ActivityTree folds each card to its latest call then). Keyed by agent
 * id — the spawn's tool_use id, unique per run — so a card the viewer opened
 * stays open as its live bubble finalizes into the stored message, which
 * renders a fresh tree over the same ids. Session-only by design: a reload
 * starts every card folded again.
 */
export const openAgentCards = writable<ReadonlySet<string>>(new Set());

export function toggleAgentCard(agentId: string): void {
  openAgentCards.update((open) => {
    const next = new Set(open);
    if (!next.delete(agentId)) next.add(agentId);
    return next;
  });
}

/**
 * A card's display title: its type/description label, behind the teammate's
 * `@name` on an OLDER snapshot from the retired agent teams (new runs never set
 * a name — kept read-only so stored activity trees still render as they did).
 */
export function agentTitle(node: Pick<LiveAgentNode, "name" | "label">): string {
  return [node.name ? `@${node.name}` : "", node.label].filter(Boolean).join(" · ");
}
