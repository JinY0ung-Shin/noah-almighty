// Inline styles for the inline UI components, built ONLY from the shared
// library's token tables and clamped numbers — never from a string the avatar
// wrote. The props reaching these functions are already normalized
// (`normalizeProps`): an enum is one of its allowed values, a spacing is 0–8.
import { ALIGN, JUSTIFY, background, lineColor, spacing, textColor } from "../../../shared/widget/index";

type Props = Record<string, unknown>;

const RADIUS: Record<string, string> = { none: "0", sm: "var(--r-sm)", md: "var(--r-md)", lg: "var(--r-lg)" };

function own(table: Record<string, string>, v: unknown): string | undefined {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(table, v) ? table[v] : undefined;
}

function join(parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(";");
}

/** A layout container's flex / grid styles. */
export function containerStyle(tag: string, p: Props): string {
  const gap = (fallback: number) => `gap:${spacing(p.gap) ?? spacing(fallback)}`;
  const align = own(ALIGN, p.align);
  const justify = own(JUSTIFY, p.justify);
  if (tag === "grid") {
    const columns = typeof p.columns === "number" ? p.columns : 2;
    return join([`grid-template-columns:repeat(${columns},minmax(0,1fr))`, gap(3)]);
  }
  if (tag === "grid-item") {
    return join([typeof p.span === "number" && `grid-column:span ${p.span}`, gap(2)]);
  }
  if (tag === "row") {
    return join([gap(2), `align-items:${align ?? "center"}`, justify && `justify-content:${justify}`, p.wrap === true && "flex-wrap:wrap"]);
  }
  if (tag === "box") {
    const framed = p.border === true || (typeof p.background === "string" && p.background !== "none");
    const bg = background(p.background);
    return join([
      `flex-direction:${p.direction === "row" ? "row" : "column"}`,
      gap(2),
      `padding:${spacing(p.padding) ?? spacing(framed ? 3 : 0)}`,
      bg && `background:${bg}`,
      `border-radius:${own(RADIUS, p.radius) ?? (framed ? RADIUS.md : "0")}`,
      align && `align-items:${align}`,
      justify && `justify-content:${justify}`,
    ]);
  }
  // col
  return join([gap(2), align && `align-items:${align}`, justify && `justify-content:${justify}`]);
}

/** `<spacer>`: a fixed gap with `size`, otherwise it takes the free space. */
export function spacerStyle(p: Props): string {
  const size = spacing(p.size);
  return size ? `flex:0 0 ${size};min-width:${size};min-height:${size}` : "flex:1 1 0";
}

/** `<image>`: the declared size and fit (numbers the library clamped), nothing free-form. */
export function imageStyle(p: Props): string {
  return join([
    typeof p.width === "number" && `width:${p.width}px`,
    typeof p.maxHeight === "number" && `max-height:${p.maxHeight}px`,
    `object-fit:${p.fit === "cover" ? "cover" : "contain"}`,
    `border-radius:${own(RADIUS, p.radius) ?? RADIUS.sm}`,
  ]);
}

/** A text color token → `color:…`, or nothing. */
export function colorStyle(token: unknown): string {
  const color = textColor(token);
  return color ? `color:${color}` : "";
}

/** `<text>`: color and alignment. */
export function textStyle(p: Props): string {
  const align = p.align === "center" || p.align === "end" ? (p.align === "end" ? "right" : "center") : "";
  return join([colorStyle(p.color), align && `text-align:${align}`]);
}

/** A tone (badge, callout, progress): text, soft background and edge from the same token family. */
export function toneStyle(tone: unknown): string {
  const t = typeof tone === "string" ? tone : "default";
  return join([
    `--wg-tone:${textColor(t) ?? "var(--text)"}`,
    `--wg-tone-soft:${background(t) ?? "var(--bg-subtle)"}`,
    `--wg-tone-line:${lineColor(t) ?? "var(--line)"}`,
  ]);
}
