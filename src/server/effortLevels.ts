/**
 * Registry of reasoning EFFORT levels a user can pick per conversation in the chat
 * composer, alongside the model. Each `id` is passed to pi as the
 * response's `reasoningEffort`, which guides how much thinking/reasoning the
 * model applies to the turn; every turn sends it, so a change applies to the
 * same pi session from that turn on.
 *
 * The five ids ('low' | 'medium' | 'high' | 'xhigh' | 'max') are a subset of
 * pi's REASONING_EFFORTS (the names come from the retired Agent SDK's
 * `EffortLevel`). The pick is per conversation, independent of the model, but
 * what is SENT depends on it: pi's `/v1/models` lists each model's efforts and
 * pi 400s any other, so {@link effortForModel} clamps the pick to the model
 * (the run, describe_system and the composer all use it).
 *
 * `label`/`description` are user-facing, so they are KOREAN (matching the
 * project's language split: user strings Korean, stable `id`s never localized).
 * `labelEn` is the ENGLISH name for model-facing surfaces (`describe_system`) —
 * the same labelKo/labelEn split `mcpToolGroups.ts` uses, so a Korean string
 * never leaks into the agent's English self-state.
 * This module is intentionally dependency-free so BOTH the server and the web
 * client can import it (it is listed in `tsconfig.client.json` includes) — the
 * composer renders the same registry, avoiding drift.
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
    description: "high보다 더 깊은 추론 (모델이 지원하지 않으면 지원하는 가장 가까운 낮은 강도로 실행)",
  },
  {
    id: "max",
    label: "최대",
    labelEn: "Maximum",
    description: "최대 사고 — 가장 어려운 작업용 (느리고 비쌈; 모델이 지원하지 않으면 지원하는 가장 가까운 낮은 강도로 실행)",
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

/**
 * pi's REASONING_EFFORTS, lowest to highest — the order a pick is lowered in.
 * `none` turns reasoning off; it is never a lowered pick's target.
 */
export const REASONING_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * What pi's `/v1/models` says about one model's efforts: the ones it accepts
 * (pi 400s any other) and the one it uses when a request names none. `null` in
 * its place = the model does not reason (pi ignores any effort); absent = pi did
 * not say (an older pi) → the pick is sent as is.
 */
export interface ModelEffortSupport {
  efforts: readonly string[];
  defaultEffort?: string;
}

/**
 * The effort actually SENT for a pick on a model:
 * - `picked`: supported (or support unknown) → sent as picked;
 * - `lowered`: the closest supported level BELOW the pick (never `none`);
 * - `model_default`: no supported level at or below the pick → the model's
 *   default effort (undefined when pi named none: nothing is sent);
 * - `not_reasoning`: the model does not reason → nothing is sent;
 * - `unset`: nothing picked → nothing is sent (pi's default).
 */
export interface ModelEffort {
  effort: string | undefined;
  kind: "picked" | "lowered" | "model_default" | "not_reasoning" | "unset";
}

export function effortForModel(
  picked: string | null | undefined,
  support: ModelEffortSupport | null | undefined,
): ModelEffort {
  if (!picked) return { effort: undefined, kind: "unset" };
  if (support === undefined) return { effort: picked, kind: "picked" };
  if (support === null) return { effort: undefined, kind: "not_reasoning" };
  if (support.efforts.includes(picked)) return { effort: picked, kind: "picked" };
  const rank = (id: string): number => (REASONING_EFFORT_ORDER as readonly string[]).indexOf(id);
  const lowered = support.efforts
    .filter((id) => id !== "none" && rank(id) >= 0 && rank(id) < rank(picked))
    .sort((a, b) => rank(b) - rank(a))[0];
  if (lowered) return { effort: lowered, kind: "lowered" };
  return { effort: support.defaultEffort, kind: "model_default" };
}
