/**
 * The icon names inline UI may use (`<icon name>`, `icon` on a button or
 * a callout): exactly the icons the app itself draws
 * (`src/client/src/lib/icons.ts`, `ICON_PATHS`).
 *
 * The list lives here because the shared library cannot import a client module
 * (the server compiles it too). `tests/widget-icons.test.ts` fails when the two
 * drift: add an icon to `ICON_PATHS` and it must be added here, remove one and
 * it must go from here.
 */
export const WIDGET_ICON_NAMES: readonly string[] = Object.freeze([
  "compass",
  "chat",
  "user",
  "shield",
  "gear",
  "close",
  "send",
  "stop",
  "play",
  "pause",
  "ban",
  "minus",
  "refresh",
  "plus",
  "search",
  "maximize",
  "menu",
  "edit",
  "trash",
  "copy",
  "check",
  "check-square",
  "eye",
  "eye-off",
  "file",
  "file-text",
  "link",
  "logout",
  "camera",
  "image",
  "globe",
  "lock",
  "back",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "book",
  "sparkles",
  "clock",
  "inbox",
  "bell",
  "arrow-down",
  "columns",
  "rows",
  "grid",
  "users",
  "activity",
  "list",
  "key",
  "server",
  "power",
  "sun",
  "moon",
  "monitor",
  "network",
  "panel-left-close",
]);

/** Pixel size of each `<icon size>` step. */
export const WIDGET_ICON_SIZES: Readonly<Record<string, number>> = Object.freeze({ sm: 14, md: 18, lg: 24, xl: 32 });
