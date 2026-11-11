/**
 * The canvas `widget` component spec — the ONE source for the server's static
 * check (`check.ts`), the client renderer's prop handling (`normalizeProps`)
 * and the manual text (`widgetComponentReference`). Add a component or a prop
 * HERE and all three follow.
 */
import type { Expr } from "./expr.js";
import { NOOP_HANDLER, sanitizeData, toStr } from "./interp.js";
import { ALIGN, BACKGROUND_TOKENS, COLOR_TOKENS, JUSTIFY, MAX_SPACING_UNITS, TONE_TOKENS, clamp, conversationImageRef, safeLinkUrl } from "./style.js";

export type PropType =
  | { k: "enum"; values: readonly string[] }
  | { k: "number"; min: number; max: number; int?: boolean }
  | { k: "string"; max: number }
  | { k: "boolean" }
  /** A function: `{() => …}` or a setter name. */
  | { k: "handler" }
  /** A primitive the component displays or binds: string, number or boolean. */
  | { k: "value" }
  /** `["A", "B"]` or `[{ label, value }]`. */
  | { k: "options" }
  /** Table columns: `[{ key, label?, align? }]` (a bare string is a key). */
  | { k: "columns" }
  /** Table rows: an array of plain objects. */
  | { k: "rows" }
  /** A plain object (a Vega-Lite spec, the values of a submit). */
  | { k: "object" }
  /** Text a button sends as the user's next chat message: 1–MAX_SEND_CHARS characters after trimming. */
  | { k: "send" }
  /** An absolute http(s) URL (`safeLinkUrl`). The normalized href is what the renderer gets. */
  | { k: "url" }
  /** The address of an image of a conversation (`conversationImageRef`): `/api/conversations/<id>/images/<id>`. */
  | { k: "image" };

export interface PropSpec {
  type: PropType;
  required?: boolean;
  doc?: string;
}

/**
 * What a component may contain. `inline`: text and `{expr}` (plus the few tags
 * its `inlineTags` names). `block`: other components too.
 */
export type ChildKind = "block" | "inline" | "none";

export type ComponentGroup = "Layout" | "Text" | "Inputs" | "Data" | "Media" | "Submit";

/** Longest text a button's `send` may carry. */
export const MAX_SEND_CHARS = 2000;

export interface ComponentSpec {
  tag: string;
  group: ComponentGroup;
  child: ChildKind;
  props: Record<string, PropSpec>;
  /** The visible label may be the component's text children instead of a `label` prop. */
  labelFromChildren?: boolean;
  /** For an `inline` component: the tags it may still contain (a `<link>` inside a `<text>`). */
  inlineTags?: readonly string[];
  /** EXACTLY ONE of these props must be written (a button's action). */
  oneOf?: readonly string[];
  /** The component is its text: it needs non-empty children. */
  textRequired?: boolean;
  doc: string;
}

export const MAX_OPTIONS = 60;
export const MAX_TABLE_COLUMNS = 20;
export const MAX_TABLE_ROWS = 500;

const SPACING: PropType = { k: "number", min: 0, max: MAX_SPACING_UNITS };
const ALIGNS: PropType = { k: "enum", values: Object.keys(ALIGN) };
const JUSTIFIES: PropType = { k: "enum", values: Object.keys(JUSTIFY) };
const COLOR: PropType = { k: "enum", values: COLOR_TOKENS };
const TONE: PropType = { k: "enum", values: TONE_TOKENS };
const BOOL: PropType = { k: "boolean" };
const HANDLER: PropType = { k: "handler" };
const LABEL: PropSpec = { type: { k: "string", max: 200 }, required: true, doc: "visible label (required: every input is labelled)" };
const SHORT: PropType = { k: "string", max: 200 };
/** Tags that may sit inside running text. */
const IN_TEXT: readonly string[] = ["link"];

function component(
  tag: string,
  group: ComponentGroup,
  child: ChildKind,
  doc: string,
  props: Record<string, PropSpec>,
  extra: Partial<ComponentSpec> = {},
): ComponentSpec {
  return { tag, group, child, doc, props, ...extra };
}

const LIST: ComponentSpec[] = [
  component("box", "Layout", "block", "A container; with `border`/`background` it reads as a card.", {
    gap: { type: SPACING, doc: "space between children, 0–8 (1 = 4px)" },
    padding: { type: SPACING, doc: "inner padding, 0–8" },
    border: { type: BOOL },
    background: { type: { k: "enum", values: BACKGROUND_TOKENS } },
    radius: { type: { k: "enum", values: ["none", "sm", "md", "lg"] } },
    direction: { type: { k: "enum", values: ["col", "row"] } },
    align: { type: ALIGNS },
    justify: { type: JUSTIFIES },
  }),
  component("row", "Layout", "block", "Children side by side.", {
    gap: { type: SPACING },
    align: { type: ALIGNS },
    justify: { type: JUSTIFIES },
    wrap: { type: BOOL },
  }),
  component("col", "Layout", "block", "Children stacked.", {
    gap: { type: SPACING },
    align: { type: ALIGNS },
    justify: { type: JUSTIFIES },
  }),
  component("grid", "Layout", "block", "A grid of `<grid-item>` children.", {
    columns: { type: { k: "number", min: 1, max: 6, int: true }, doc: "number of columns (default 2)" },
    gap: { type: SPACING },
  }),
  component("grid-item", "Layout", "block", "One cell of a `<grid>`.", {
    span: { type: { k: "number", min: 1, max: 6, int: true }, doc: "columns this cell spans" },
    gap: { type: SPACING },
  }),
  component("divider", "Layout", "none", "A horizontal rule.", {}),
  component("spacer", "Layout", "none", "Pushes siblings apart in a row/col, or a fixed gap with `size`.", {
    size: { type: SPACING },
  }),

  component(
    "title",
    "Text",
    "inline",
    "A heading.",
    {
      size: { type: { k: "enum", values: ["sm", "md", "lg", "xl"] } },
      color: { type: COLOR },
    },
    { inlineTags: IN_TEXT },
  ),
  component(
    "text",
    "Text",
    "inline",
    "A paragraph of text with `{expr}` interpolation.",
    {
      size: { type: { k: "enum", values: ["xs", "sm", "md", "lg"] } },
      color: { type: COLOR },
      weight: { type: { k: "enum", values: ["normal", "medium", "bold"] } },
      align: { type: { k: "enum", values: ["start", "center", "end"] } },
      tabular: { type: BOOL, doc: "tabular digits, for numbers that change in place" },
    },
    { inlineTags: IN_TEXT },
  ),
  component(
    "badge",
    "Text",
    "inline",
    "A small status label.",
    {
      tone: { type: TONE },
    },
    { inlineTags: IN_TEXT },
  ),
  component(
    "link",
    "Text",
    "inline",
    "A link that opens in a new tab. Works on its own and inside <text>, <title>, <badge> and <callout>.",
    {
      href: { type: { k: "url" }, required: true, doc: "absolute http(s) URL" },
    },
    { textRequired: true },
  ),
  component("callout", "Text", "block", "A highlighted note.", {
    tone: { type: { k: "enum", values: ["info", "success", "warning", "danger"] } },
    title: { type: SHORT },
  }),

  component(
    "button",
    "Inputs",
    "inline",
    "Does ONE thing, shown to the user before they press: give exactly one of onClick | send | href.",
    {
      onClick: { type: HANDLER, doc: "runs a function: changes state locally, sends nothing to you" },
      send: { type: { k: "send" }, doc: `the text becomes the user's NEXT chat message when pressed (1–${MAX_SEND_CHARS} chars; may be computed from state)` },
      href: { type: { k: "url" }, doc: "opens this absolute http(s) URL in a new tab" },
      label: { type: SHORT },
      variant: { type: { k: "enum", values: ["primary", "secondary", "ghost"] } },
      disabled: { type: BOOL },
    },
    { labelFromChildren: true, oneOf: ["onClick", "send", "href"] },
  ),
  component("segmented-control", "Inputs", "none", "One choice out of a few, shown side by side.", {
    value: { type: { k: "value" }, required: true },
    onChange: { type: HANDLER, required: true, doc: "called with the chosen option's value" },
    options: { type: { k: "options" }, required: true },
    label: LABEL,
  }),
  component(
    "checkbox",
    "Inputs",
    "inline",
    "A checkbox.",
    {
      checked: { type: BOOL, required: true },
      onChange: { type: HANDLER, required: true, doc: "called with the new boolean" },
      label: { type: SHORT },
      disabled: { type: BOOL },
    },
    { labelFromChildren: true },
  ),
  component(
    "switch",
    "Inputs",
    "inline",
    "An on/off switch.",
    {
      checked: { type: BOOL, required: true },
      onChange: { type: HANDLER, required: true, doc: "called with the new boolean" },
      label: { type: SHORT },
      disabled: { type: BOOL },
    },
    { labelFromChildren: true },
  ),
  component("slider", "Inputs", "none", "A numeric range.", {
    value: { type: { k: "number", min: -1e12, max: 1e12 }, required: true },
    onChange: { type: HANDLER, required: true, doc: "called with the new number" },
    label: LABEL,
    min: { type: { k: "number", min: -1e12, max: 1e12 }, doc: "default 0" },
    max: { type: { k: "number", min: -1e12, max: 1e12 }, doc: "default 100" },
    step: { type: { k: "number", min: 1e-6, max: 1e12 }, doc: "default 1" },
    suffix: { type: { k: "string", max: 20 }, doc: "unit shown after the value" },
    showValue: { type: BOOL, doc: "show the current value (default true)" },
  }),
  component("select", "Inputs", "none", "A dropdown, for many options.", {
    value: { type: { k: "value" }, required: true },
    onChange: { type: HANDLER, required: true, doc: "called with the chosen option's value" },
    options: { type: { k: "options" }, required: true },
    label: LABEL,
    placeholder: { type: SHORT },
  }),
  component("input", "Inputs", "none", "A one-line text or number field.", {
    value: { type: { k: "value" }, required: true },
    onChange: { type: HANDLER, required: true, doc: 'called with the text, or with a number (or "" when empty) for type="number"' },
    label: LABEL,
    type: { type: { k: "enum", values: ["text", "number"] } },
    placeholder: { type: SHORT },
    min: { type: { k: "number", min: -1e12, max: 1e12 } },
    max: { type: { k: "number", min: -1e12, max: 1e12 } },
    step: { type: { k: "number", min: 1e-6, max: 1e12 } },
    maxLength: { type: { k: "number", min: 1, max: 2000, int: true }, doc: "default 500" },
  }),
  component("tabs", "Inputs", "none", "A tab strip; show the panel yourself with {#if tab === …}.", {
    value: { type: { k: "value" }, required: true },
    onChange: { type: HANDLER, required: true, doc: "called with the chosen tab's value" },
    options: { type: { k: "options" }, required: true },
    label: LABEL,
  }),

  component("stat", "Data", "none", "One headline number.", {
    label: { type: SHORT, required: true },
    value: { type: { k: "value" }, required: true },
    delta: { type: { k: "string", max: 60 }, doc: 'change text, e.g. "+3.8%"' },
    trend: { type: { k: "enum", values: ["up", "down", "flat"] } },
    hint: { type: SHORT },
  }),
  component("progress", "Data", "none", "A progress bar.", {
    value: { type: { k: "number", min: 0, max: 1 }, required: true, doc: "0–1" },
    label: LABEL,
    tone: { type: TONE },
  }),
  component("table", "Data", "none", "A data table (use this, not a Markdown table, for computed rows).", {
    columns: { type: { k: "columns" }, required: true, doc: "[{ key, label?, align? }] — align: start|center|end" },
    rows: { type: { k: "rows" }, required: true, doc: "array of objects keyed by column key" },
    caption: { type: SHORT },
  }),
  component("chart", "Data", "none", "A chart from a Vega-Lite spec OBJECT with inline data only.", {
    spec: { type: { k: "object" }, required: true, doc: "Vega-Lite spec; data.values inline, no url" },
    height: { type: { k: "number", min: 120, max: 600 }, doc: "px (default 240)" },
    label: { type: SHORT, doc: "accessible name of the chart" },
  }),
  component("details", "Data", "block", "A collapsible section.", {
    title: { type: SHORT, required: true },
    open: { type: BOOL },
  }),

  component(
    "image",
    "Media",
    "none",
    "An image of THIS conversation only (the URL a file-output tool returned); no remote or data URLs.",
    {
      src: { type: { k: "image" }, required: true, doc: "/api/conversations/<conversationId>/images/<imageId>" },
      alt: { type: { k: "string", max: 300 }, required: true, doc: "what the image shows (required)" },
      width: { type: { k: "number", min: 16, max: 800 }, doc: "px" },
      maxHeight: { type: { k: "number", min: 40, max: 800 }, doc: "px" },
      radius: { type: { k: "enum", values: ["none", "sm", "md", "lg"] } },
      fit: { type: { k: "enum", values: ["cover", "contain"] } },
    },
  ),

  component(
    "submit",
    "Submit",
    "inline",
    "Sends `values` to you as STRUCTURED data in the user's next message (shown with a fixed send-to-avatar look).",
    {
      values: { type: { k: "object" }, required: true, doc: "object of string/number/boolean (or arrays of them); up to 20 keys" },
      label: { type: SHORT },
      disabled: { type: BOOL },
    },
    { labelFromChildren: true },
  ),
];

// The table is read by the checker, the renderer and the manual: nothing may change it after load.
for (const c of LIST) {
  for (const p of Object.values(c.props)) {
    if (p.type.k === "enum") Object.freeze(p.type.values);
    Object.freeze(p.type);
    Object.freeze(p);
  }
  Object.freeze(c.props);
  Object.freeze(c);
}

/** Every widget component, by tag. A null-prototype map: a tag named like an Object member is simply unknown. */
export const WIDGET_COMPONENTS: Readonly<Record<string, ComponentSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ComponentSpec>, Object.fromEntries(LIST.map((c) => [c.tag, c]))),
);

export const WIDGET_TAGS: readonly string[] = Object.freeze(LIST.map((c) => c.tag));

export function componentSpec(tag: string): ComponentSpec | undefined {
  return WIDGET_COMPONENTS[tag];
}

function typeLabel(t: PropType): string {
  switch (t.k) {
    case "enum":
      return t.values.join("|");
    case "number":
      return t.min <= -1e12 || t.max >= 1e12 ? "number" : `number ${t.min}–${t.max}`;
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "handler":
      return "function";
    case "value":
      return "string|number|boolean";
    case "options":
      return '["A","B"] or [{label, value}]';
    case "columns":
      return "[{key, label?, align?}]";
    case "rows":
      return "[object]";
    case "object":
      return "object";
    case "send":
      return "text";
    case "url":
      return "http(s) URL";
    case "image":
      return "conversation image URL";
  }
}

/**
 * English component/prop reference for the manual, generated from the spec
 * table. `*` marks a required prop; `…` after a tag means it takes children.
 */
export function widgetComponentReference(): string {
  const lines: string[] = [];
  let group = "";
  for (const c of LIST) {
    if (c.group !== group) {
      group = c.group;
      lines.push(group);
    }
    const inner = c.inlineTags?.length ? `text, {expr}, ${c.inlineTags.map((t) => `<${t}>`).join(", ")}` : "text and {expr}";
    const shape = c.child === "none" ? `<${c.tag} />` : c.child === "inline" ? `<${c.tag}>${inner}</${c.tag}>` : `<${c.tag}>…components…</${c.tag}>`;
    const label = c.labelFromChildren ? " Its text children are its label (or pass `label`)." : "";
    lines.push(`- ${shape} — ${c.doc}${label}`);
    const props = Object.entries(c.props).map(
      ([name, p]) => `${name}${p.required ? "*" : ""}: ${typeLabel(p.type)}${p.doc ? ` (${p.doc})` : ""}`,
    );
    if (props.length) lines.push(`  props: ${props.join("; ")}`);
  }
  return lines.join("\n");
}

/* ───────────────────────── static literal check ───────────────────────── */

/**
 * Whether a prop's SOURCE form can never be valid for its type. Only literal
 * forms are judged (a computed `{expr}` is normalized at render time).
 * Returns the fix as English text, or null when the form is acceptable.
 */
/** Why a KNOWN text is not a valid `send` / link / image value (null when it is). Shared by the static check and the renderer. */
/** A `send` text as it is sent: no control characters except line breaks and tabs, trimmed. */
function cleanSendText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

function textProblem(kind: "send" | "url" | "image", text: string): string | null {
  switch (kind) {
    case "send": {
      // Judged on the text that would actually be SENT (control characters gone,
      // trimmed), so a slash hidden behind one cannot slip through.
      const t = cleanSendText(text);
      if (t.length === 0) return "is empty — nothing would be sent";
      // The message arrives exactly like a typed one, and a typed "/…" is a chat
      // command (/compact, /routine, /todo …): a widget button must never run one.
      if (t.startsWith("/")) return `must not start with "/" — that is a chat command, which a widget button may not send; word it as a sentence`;
      return t.length > MAX_SEND_CHARS ? `is too long (limit ${MAX_SEND_CHARS} chars)` : null;
    }
    case "url":
      if (text.trim().length === 0) return "is empty — there is no link to open";
      return safeLinkUrl(text) ? null : `must be an absolute http(s) URL, e.g. "https://example.com/page" (no javascript:, data:, relative or //host URLs)`;
    case "image":
      if (text.length === 0) return "is empty — there is no image to show";
      return conversationImageRef(text)
        ? null
        : `must be an image of THIS conversation, "/api/conversations/<conversationId>/images/<imageId>" (the URL a file-output tool returned); remote, data: and other URLs are not allowed`;
  }
}

export function literalProblem(type: PropType, value: Expr | string | true): string | null {
  if (value === true) return type.k === "boolean" ? null : `needs a value (it is not a boolean prop)`;
  if (type.k === "send" || type.k === "url" || type.k === "image") {
    // Only a text KNOWN at check time is judged; a computed one is validated when it renders.
    if (typeof value === "string") return textProblem(type.k, value);
    if (value.type === "Lit") return typeof value.value === "string" ? textProblem(type.k, value.value) : "must be a string";
    if (value.type === "Tmpl" && value.exprs.length === 0) return textProblem(type.k, value.quasis[0]);
    if (value.type === "Arrow") return "must be a string, not a function";
    if (value.type === "Arr" || value.type === "Obj") return "must be a string";
    return null;
  }
  if (typeof value === "string") {
    switch (type.k) {
      case "string":
      case "value":
        return null;
      case "enum":
        return type.values.includes(value) ? null : `must be one of ${type.values.join(", ")}`;
      case "number":
        return /^-?\d+(\.\d+)?$/.test(value.trim()) ? null : `must be a number — write it in braces, e.g. {12}`;
      case "boolean":
        return `must be a boolean — write the bare prop name for true, or {false}`;
      case "handler":
        return `must be a function in braces, e.g. {() => setX(1)} or {setX}`;
      default:
        return `must be an expression in braces, not a quoted string`;
    }
  }
  if (value.type === "Lit") {
    const v = value.value;
    switch (type.k) {
      case "enum":
        return typeof v === "string" && type.values.includes(v) ? null : `must be one of ${type.values.join(", ")}`;
      case "number":
        return typeof v === "number" ? null : `must be a number`;
      case "boolean":
        return typeof v === "boolean" ? null : `must be a boolean`;
      case "string":
        return typeof v === "string" || typeof v === "number" ? null : `must be a string`;
      case "value":
        return null;
      case "handler":
        return `must be a function, e.g. {() => setX(1)} or {setX}`;
      default:
        return `must be an array or object, not a literal value`;
    }
  }
  if (value.type === "Arrow") return type.k === "handler" ? null : `must not be a function`;
  if (type.k === "handler" && (value.type === "Arr" || value.type === "Obj" || value.type === "Tmpl")) {
    return `must be a function, e.g. {() => setX(1)} or {setX}`;
  }
  if (value.type === "Arr" && (type.k === "object" || type.k === "boolean" || type.k === "number" || type.k === "enum" || type.k === "string")) {
    return type.k === "object" ? `must be an object, not an array` : `must not be an array`;
  }
  if (value.type === "Obj" && type.k !== "object" && type.k !== "handler") {
    return type.k === "options" || type.k === "columns" || type.k === "rows" ? `must be an array, not an object` : `must not be an object`;
  }
  return null;
}

/* ───────────────────────── render-time normalization ───────────────────────── */

type Primitive = string | number | boolean;

const MAX_VALUE_CHARS = 2000;
const MAX_LABEL_CHARS = 200;

/** A displayable / bindable primitive: a bounded string, a FINITE number or a boolean. */
function primitive(v: unknown): Primitive | undefined {
  if (typeof v === "string") return v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  return undefined;
}

export interface WidgetOption {
  label: string;
  value: Primitive;
}

export interface WidgetColumn {
  key: string;
  label: string;
  align: "start" | "center" | "end";
}

function normalizeOptions(v: unknown): WidgetOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WidgetOption[] = [];
  for (const item of v.slice(0, MAX_OPTIONS)) {
    const p = primitive(item);
    if (p !== undefined) {
      out.push({ label: String(p).slice(0, MAX_LABEL_CHARS), value: p });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const rawLabel = Object.prototype.hasOwnProperty.call(rec, "label") ? primitive(rec.label) : undefined;
    const rawValue = Object.prototype.hasOwnProperty.call(rec, "value") ? primitive(rec.value) : undefined;
    const value = rawValue ?? rawLabel;
    if (value === undefined) continue;
    out.push({ label: String(rawLabel ?? value).slice(0, MAX_LABEL_CHARS), value });
  }
  return out;
}

function normalizeColumns(v: unknown): WidgetColumn[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WidgetColumn[] = [];
  for (const item of v.slice(0, MAX_TABLE_COLUMNS)) {
    if (typeof item === "string") {
      const key = item.slice(0, MAX_LABEL_CHARS);
      out.push({ key, label: key, align: "start" });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const key = Object.prototype.hasOwnProperty.call(rec, "key") && typeof rec.key === "string" ? rec.key.slice(0, MAX_LABEL_CHARS) : undefined;
    if (key === undefined) continue;
    const label = Object.prototype.hasOwnProperty.call(rec, "label") ? primitive(rec.label) : undefined;
    const align = Object.prototype.hasOwnProperty.call(rec, "align") ? rec.align : undefined;
    out.push({
      key,
      label: String(label ?? key).slice(0, MAX_LABEL_CHARS),
      align: align === "center" || align === "end" ? align : "start",
    });
  }
  return out;
}

function normalizeOne(type: PropType, v: unknown): unknown {
  if (type.k === "send" || type.k === "url" || type.k === "image") {
    // These name an EFFECT (a message to send, a page to open, an image to
    // load): an empty or invalid one is never defaulted — it is dropped and
    // reported, so the renderer shows a disabled / broken control instead of
    // doing something else.
    const text = typeof v === "string" ? v : type.k === "send" && (typeof v === "number" || typeof v === "boolean") ? String(v) : null;
    if (text === null) throw new Error(v === undefined || v === null ? textProblem(type.k, "")! : "must be a string");
    const problem = textProblem(type.k, text);
    if (problem) throw new Error(problem);
    if (type.k === "url") return safeLinkUrl(text)!;
    // send: one clean message — trimmed, no control characters except line breaks and tabs.
    return type.k === "send" ? cleanSendText(text) : text;
  }
  if (v === undefined || v === null) return undefined;
  switch (type.k) {
    case "enum":
      return typeof v === "string" && type.values.includes(v) ? v : undefined;
    case "number": {
      const n = clamp(v, type.min, type.max);
      return n === undefined ? undefined : type.int ? Math.round(n) : n;
    }
    case "string": {
      const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : Array.isArray(v) ? toStr(v) : undefined;
      return s === undefined ? undefined : s.slice(0, type.max);
    }
    case "boolean":
      return v === true || v === "true" || v === "" ? true : v === false || v === "false" ? false : Boolean(v);
    case "handler":
      return typeof v === "function" ? v : undefined;
    case "value":
      return primitive(v);
    case "options":
      return normalizeOptions(v);
    case "columns":
      return normalizeColumns(v);
    case "rows": {
      if (!Array.isArray(v)) return undefined;
      const rows = sanitizeData(v.slice(0, MAX_TABLE_ROWS)) as unknown[];
      return rows.filter((r) => r !== null && typeof r === "object" && !Array.isArray(r));
    }
    case "object": {
      if (typeof v !== "object" || Array.isArray(v)) return undefined;
      return sanitizeData(v);
    }
  }
}

/**
 * What a REQUIRED prop falls back to when it is written in the source but its
 * value is empty (null / undefined) or not something its type can take:
 *
 *   boolean  → false                    (checkbox / switch `checked`)
 *   value    → ""                       (select / segmented-control / tabs: nothing selected; input: empty; stat: blank)
 *   number   → the component's `min` when it has one, else 0, clamped into the prop's range
 *   string   → ""                       (label, title)
 *   handler  → a no-op                  (the control renders; interacting does nothing)
 *   options / columns / rows → []
 *   object   → {}                       (chart spec, submit values)
 *   send / url / image → NOT defaulted: dropped and reported (see normalizeOne)
 *
 * A widget binds inputs to state that is legitimately empty at first
 * (`{@state pick = null}`, `done[k]` before the box is ever ticked); that must
 * render an empty control, not an error.
 */
function emptyValue(type: PropType, props: Record<string, unknown>): unknown {
  switch (type.k) {
    case "boolean":
      return false;
    case "value":
    case "string":
      return "";
    case "number": {
      const min = typeof props.min === "number" ? props.min : 0;
      return Math.min(Math.max(min, type.min), type.max);
    }
    case "handler":
      return NOOP_HANDLER;
    case "options":
    case "columns":
    case "rows":
      return [];
    case "object":
      return {};
    case "enum":
      return type.values[0];
    case "send":
    case "url":
    case "image":
      return undefined; // never defaulted (normalizeOne reports an empty one instead)
  }
}

/**
 * Turn evaluated attribute values into the props a renderer may trust: only
 * the component's declared props, each coerced to its type (clamped numbers,
 * allowlisted enum values, bounded strings, deep-copied plain data).
 *
 * `raw` holds an entry for every prop WRITTEN in the source (whatever it
 * evaluated to). For those:
 * - a required prop always comes back defined — an empty or unusable value
 *   becomes the type's empty value (`emptyValue` above);
 * - an optional prop with an empty or unusable value is left out (the
 *   renderer's default applies).
 * A prop that is not in `raw` is left out, required or not: that is "missing".
 * A normalization that throws (data too large) is reported in `errors` and the
 * prop is dropped.
 */
export function normalizeProps(tag: string, raw: Record<string, unknown>): { props: Record<string, unknown>; errors: string[] } {
  const props: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const errors: string[] = [];
  const spec = WIDGET_COMPONENTS[tag];
  if (!spec) return { props, errors: [`unknown component <${tag}>`] };
  const empty: string[] = [];
  for (const name of Object.keys(spec.props)) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    try {
      const v = normalizeOne(spec.props[name].type, raw[name]);
      if (v !== undefined) props[name] = v;
      // A written action of a `oneOf` group counts like a required prop: `onClick={maybeFn}` that is empty stays a (no-op) button.
      else if (spec.props[name].required || spec.oneOf?.includes(name)) empty.push(name);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : "invalid value"}`);
    }
  }
  // After the pass, so a number's fallback can use the component's own `min`.
  for (const name of empty) {
    const fallback = emptyValue(spec.props[name].type, props);
    if (fallback !== undefined) props[name] = fallback;
  }
  return { props, errors };
}
