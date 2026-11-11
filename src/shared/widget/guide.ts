/**
 * Inline UI — the model-facing brief that rides the system prompt.
 *
 * An avatar writes UI tags directly in its answer text (Markdown + tags); the
 * viewer's browser draws them in place while the answer streams. There is no
 * tool call, so the grammar has to be in front of the model on every turn:
 * this string is what the prompt builder appends for an interactive chat run.
 * The full reference (every prop's type, limits, `<svg>`, icons) stays in the
 * manual topic named here.
 *
 * The component list is GENERATED from the spec table (`spec.ts`), like the
 * manual's reference — a component or prop is added there, never here.
 */
import { WIDGET_COMPONENTS, WIDGET_TAGS, type ComponentSpec } from "./spec.js";

/** `mcp__system__read_manual` topic that holds the full reference. */
export const INLINE_UI_MANUAL_TOPIC = "inline-ui";

/** Heading of the paragraph that tells the avatar what the viewer's browser could not draw. */
export const INLINE_UI_REPORT_TITLE = "Inline UI render report";

function shape(c: ComponentSpec): string {
  const props = Object.entries(c.props)
    .map(([name, p]) => `${name}${p.required ? "*" : ""}`)
    .join(" ");
  const open = `<${c.tag}${props ? ` ${props}` : ""}`;
  if (c.child === "none") return `${open} />`;
  return `${open}>${c.child === "inline" ? "text" : c.child === "svg" ? "SVG" : "…"}</${c.tag}>`;
}

/** One line per group: every component with its prop NAMES (`*` = required). */
export function widgetComponentBrief(): string {
  const groups = new Map<string, string[]>();
  for (const tag of WIDGET_TAGS) {
    const c = WIDGET_COMPONENTS[tag];
    const list = groups.get(c.group) ?? [];
    list.push(shape(c));
    groups.set(c.group, list);
  }
  return [...groups].map(([group, shapes]) => `- ${group}: ${shapes.join(" · ")}`).join("\n");
}

let cached: string | null = null;

/**
 * The standing prompt section. English (the model reads it as input); the
 * examples' visible text is Korean because that is what an avatar writes.
 */
export function inlineUiPromptSpec(): string {
  if (cached !== null) return cached;
  cached = `# Inline UI
Your answer is Markdown. When a visual or interactive layout clearly serves the user better than prose — a chart of some data, a dashboard of key figures, a side-by-side comparison, a calculator or what-if, a quiz, a checklist, choices to pick from, a filterable table — write UI tags DIRECTLY IN YOUR ANSWER TEXT, mixed with the Markdown. The user's app draws them in place while the answer streams. There is no tool to call for this, and nothing opens in the side panel. A plain question gets plain Markdown: never decorate a simple answer, and do not repeat in prose what the UI already shows.

Rules
- Write the UI in your FINAL answer text. Text you write before a tool call is folded into the reasoning view, where tags are not drawn.
- A tag starts on its own line (indent ≤ 3 spaces): \`<box gap={2}> … </box>\`, self-closing \`<divider />\`. Props are \`name="string"\`, \`name={expression}\`, or a bare name for true. ONLY the components below exist — no HTML tags, no \`style\`/\`class\`.
- Never put UI tags inside a fenced code block (that shows the source instead) unless the user asked to see the source.
- Text between top-level tags is ordinary Markdown. Text INSIDE a tag is inline Markdown only (bold, italic, code, links) and may interpolate \`{expression}\`.
- State: \`{@state name = initial}\` on its own top-level line declares a variable and its setter \`setName(value)\` / \`setName(prev => next)\`. Derived values: \`{@const name = expression}\`. Declare both before the tags that use them.
- Blocks: \`{#each list as item, index} … {:else} … {/each}\` and \`{#if cond} … {:else if cond} … {:else} … {/if}\`.
- Expressions are a safe JavaScript subset: literals, template strings, arrays/objects/spread, \`.\` \`[]\` \`?.\` \`??\`, arithmetic/comparison/logical operators, ternaries, arrow functions, the usual array/string/number methods, \`Math.*\`, \`Number\`, \`String\`, \`JSON\`, \`Object.keys/values/entries\`. No assignment, loops, \`Date\`, regular expressions, \`fetch\`, DOM or \`Math.random\`.
- Setters and \`copy(text)\` work only inside an event handler: \`onChange={setX}\`, \`onClick={() => setTab("b")}\`.
- The UI recomputes in the user's browser. You are NOT called when they change an input and you never see the values they set. Only two things reach you, each as the user's NEXT message: \`<button send="text">Label</button>\` (posts that text — it may be computed from state and never starts with "/") and \`<submit values={{ a, b }}>Label</submit>\` (posts the label followed by the values).
- Links open in a new tab: \`<button href="https://…">\`, \`<link href="https://…">text</link>\`, \`[text](https://…)\`. \`<image src alt>\` shows only an image of THIS conversation (the URL \`mcp__file_output__show_file\` returns with \`hidden:true\`).
- Inline only the data the UI needs — it cannot load anything, and it stays in the conversation's context.
- Use the user's language for every visible text.

Components (\`*\` = required prop; an input's \`onChange\` receives the new value)
${widgetComponentBrief()}

Charts — a chart the user only needs to SEE also goes here, in the answer, not on a canvas:
\`<chart type="bar" data={[{ month: "1월", sales: 120, cost: 80 }, { month: "2월", sales: 150, cost: 90 }]} xKey="month" series={[{ key: "sales", label: "매출" }, { key: "cost", label: "비용" }]} unit="만원" title="월별 매출과 비용" />\`
\`type\`: bar | line | area | pie | donut, plus \`stacked\` and \`horizontal\`. Anything else (scatter, heatmap, layered marks): a whole Vega-Lite spec with inline values — \`<chart spec={{ mark: "point", data: { values: rows }, encoding: { … } }} />\`.

Example
{@state qty = 2}
{@const total = qty * 12000}
<box border padding={3} gap={2}>
  <title size="md">주문 계산</title>
  <slider label="수량" value={qty} onChange={setQty} min={1} max={10} />
  <stat label="합계" value={\`\${total.toLocaleString()}원\`} />
  <button send={\`수량 \${qty}개로 주문해 줘\`}>이대로 주문</button>
</box>

Every prop's type and allowed values, the limits, \`<svg>\` drawings and the icon names: \`mcp__system__read_manual\` topic \`${INLINE_UI_MANUAL_TOPIC}\` — read it once before a layout that goes beyond the example. A tag or prop that does not exist is dropped where it stands, and what the user's browser could not draw is told to you at the start of your next turn ("${INLINE_UI_REPORT_TITLE}").`;
  return cached;
}
