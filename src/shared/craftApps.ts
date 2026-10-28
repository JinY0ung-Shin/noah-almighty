/**
 * ArtCraft "Craft" apps Noah can drive through the network-less `craft-runner`
 * container (admin-only beta). Shared by server and client: the server keys
 * gating, relay registration and metacognition on this list; the client labels
 * the composer's tool groups and the side panel with it. Which apps a
 * deployment can actually serve comes from the runner's `health`, not from
 * here — an app listed here but absent from the runner reads "unavailable".
 *
 * The MCP server name IS the app id, so the tools are `mcp__photocraft__*` etc.
 */
export const CRAFT_APPS = [
  { id: "photocraft",  labelKo: "PhotoCraft",    labelEn: "PhotoCraft (Photoshop-style image editor)",  toolGroupId: "craft_photocraft" },
  { id: "vectorcraft", labelKo: "VectorCraft",   labelEn: "VectorCraft (Illustrator-style vector editor)", toolGroupId: "craft_vectorcraft" },
  { id: "designcraft", labelKo: "DesignCraft",   labelEn: "DesignCraft (InDesign-style page layout)",     toolGroupId: "craft_designcraft" },
  { id: "figcraft",    labelKo: "FigCraft",      labelEn: "FigCraft (Figma-style UI design)",            toolGroupId: "craft_figcraft" },
] as const;
export type CraftAppId = (typeof CRAFT_APPS)[number]["id"];
export type CraftApp = (typeof CRAFT_APPS)[number];

const CRAFT_APP_IDS = new Set<string>(CRAFT_APPS.map((app) => app.id));

export function isCraftAppId(value: unknown): value is CraftAppId {
  return typeof value === "string" && CRAFT_APP_IDS.has(value);
}

export function craftAppById(id: CraftAppId): CraftApp {
  return CRAFT_APPS.find((app) => app.id === id)!;
}

/** The Craft app a `mcp__<app>__<tool>` name belongs to, or null. */
export function craftAppOfToolName(toolName: string): CraftAppId | null {
  const match = /^mcp__([a-z0-9]+)__/.exec(toolName);
  return match && isCraftAppId(match[1]) ? match[1] : null;
}
