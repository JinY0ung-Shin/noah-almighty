/**
 * Registry of reasoning EFFORT levels a user can pick per conversation in the chat
 * composer, alongside the model tier. Each `id` is passed to pi as the
 * response's `reasoningEffort`, which guides how much thinking/reasoning the
 * model applies to the turn; pi fixes it per session, so a change starts a new
 * session from the text history.
 *
 * The five ids ('low' | 'medium' | 'high' | 'xhigh' | 'max') are a subset of
 * pi's REASONING_EFFORTS (the names come from the retired Agent SDK's
 * `EffortLevel`); what a model does with a level it does not support is pi's
 * call — no per-model gating here.
 *
 * Effort is INDEPENDENT of the model tier.
 *
 * `label`/`description` are user-facing, so they are KOREAN (matching the
 * project's language split: user strings Korean, stable `id`s never localized).
 * `labelEn` is the ENGLISH name for model-facing surfaces (`describe_system`) —
 * the same labelKo/labelEn split `mcpToolGroups.ts` uses, so a Korean string
 * never leaks into the agent's English self-state.
 * This module is intentionally dependency-free so BOTH the server and the Svelte
 * client can import it (it is listed in `tsconfig.client.json` includes), mirroring
 * `modelTiers.ts` — the composer renders the same registry, avoiding drift.
 */
export interface EffortLevel {
  /** Effort id passed to pi as `reasoningEffort`. */
  id: string;
  /** User-facing level name (Korean). */
  label: string;
  /** Model-facing level name (English) — used by describe_system. */
  labelEn: string;
  /** User-facing one-line description (Korean). */
  description: string;
}

export const EFFORT_LEVELS: EffortLevel[] = [
  {
    id: "low",
    label: "낮음",
    labelEn: "Low",
    description: "최소한의 사고 — 가장 빠르고 가벼운 응답",
  },
  {
    id: "medium",
    label: "보통",
    labelEn: "Medium",
    description: "적당한 수준의 사고 — 속도와 깊이의 균형",
  },
  {
    id: "high",
    label: "높음",
    labelEn: "High",
    description: "깊은 추론 — 대부분의 작업에 적합 (기본값)",
  },
  {
    id: "xhigh",
    label: "매우 높음",
    labelEn: "Very high",
    description: "high보다 더 깊은 추론 (Opus 4.7+; 그 외 모델은 high로 자동 조정)",
  },
  {
    id: "max",
    label: "최대",
    labelEn: "Maximum",
    description: "최대 사고 — 가장 어려운 작업용 (일부 모델만 지원, 느리고 비쌈)",
  },
];

/** All registered effort ids, for validation + membership checks. */
export const EFFORT_LEVEL_IDS: string[] = EFFORT_LEVELS.map((e) => e.id);

/**
 * The effort the composer and describe_system SHOW when no choice applies
 * (`high` — deep reasoning; the retired SDK's documented default). An unset
 * choice sends no effort to pi, which then applies its own default.
 */
export const DEFAULT_EFFORT_LEVEL = "high";

/** Type guard: a non-empty string that names a known effort level. */
export function isEffortLevel(value: unknown): value is string {
  return typeof value === "string" && EFFORT_LEVEL_IDS.includes(value);
}
