import crypto from "node:crypto";
import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { CanvasControl } from "../types.js";
import type { CanvasRequest, CanvasResult } from "./events.js";
import { checkMermaidSyntax } from "./mermaidCheck.js";
import { text } from "./mcpTools.js";
import logger from "../logger.js";
import { checkWidget, type WidgetCheck } from "../../shared/widget/check.js";

/** MCP server name; the tool surfaces to the model as `mcp__canvas__show`. */
export const CANVAS_SERVER_NAME = "canvas";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const CANVAS_TOOL_NAMES = ["mcp__canvas__show"] as const;

/**
 * `mediaType` of the message attachment a shown `widget` rides (kind `widget`,
 * id = the canvas artifact id, no file behind it): the chat route attaches one
 * so the bubble draws the widget inline. Hand-mirrored by the client.
 */
export const CANVAS_WIDGET_ATTACHMENT_MEDIA_TYPE = "application/vnd.noah.canvas-widget+json";

/**
 * Caps on a single canvas artifact. The content rides the pi session's history,
 * which every continued turn carries as context, AND the chat SSE/persistence payload —
 * so an oversized artifact silently inflates the token cost of EVERY later turn.
 * Over-limit is rejected with an actionable (agent-facing) error so the model can
 * compact or split and retry, rather than being silently truncated.
 */
export const MAX_CANVAS_CONTENT_CHARS = 20000;
export const MAX_CANVAS_TITLE_CHARS = 200;
export const MAX_CANVAS_CONTROLS = 12;

/**
 * Context for the canvas tool: a single callback that emits the artifact to the
 * client (over SSE) and resolves with the user's submission. The chat route owns
 * the SSE/`awaitResponse` plumbing; this tool just shapes the request/result.
 * Visual canvas (#50) — the avatar NEVER ships executable JS; the client renders
 * sanitized content + real form controls (CSP-safe).
 *
 * The tool never parks the run on the user (design D8): a call pi's broker made
 * cannot wait minutes for a form, so controls always render non-blocking and the
 * submission arrives as the user's next message. The description says so.
 */
export interface CanvasToolsContext {
  emitCanvas: (request: CanvasRequest) => Promise<CanvasResult>;
  /**
   * Whether the AVATAR OWNER turned the experimental `canvasWidget` feature on
   * (runCapabilities' `widgetEnabled`). pi's tools/list is a static catalog, so
   * `widget` is always in the contentType enum — the handler refuses it here
   * when this is not true. Absent = off.
   */
  widgetEnabled?: boolean;
}

/** Agent-facing refusal for a `widget` on an avatar whose owner has not enabled it. */
export const WIDGET_DISABLED_ERROR =
  "contentType 'widget' is an experimental feature the avatar owner has not turned on (Settings → 실험 기능). " +
  "Use 'vega' (a chart) or 'markdown' instead, or ask the owner to enable it. Nothing was shown.";

/** Agent-facing refusal for `controls` on a widget (design D8: one input model per canvas). */
export const WIDGET_CONTROLS_ERROR =
  "A 'widget' canvas declares its own inputs, so `controls` cannot be combined with it. Drop `controls`; " +
  "to send values back to you, put a `<submit values={{ key: value }}>Label</submit>` inside the widget. Nothing was shown.";

/** Agent-facing refusal for `editable` on a widget. */
export const WIDGET_EDITABLE_ERROR =
  "`editable` cannot be combined with contentType 'widget': the user changes a widget through its own inputs, not by editing its source. " +
  "Drop `editable` (use 'markdown' with `editable:true` when the user should rewrite the content). Nothing was shown.";

/**
 * Static check of a widget source (`src/shared/widget/check.ts`: parse + static
 * checks under the checker's own work budget — it never EVALUATES an expression,
 * so no avatar-authored code runs in this process). A verdict rejects; an
 * unexpected throw of the checker itself is `unverified` and the canvas shows,
 * where the client renders its own error (fail-open on infrastructure only).
 */
function checkWidgetSource(source: string): WidgetCheck {
  try {
    return checkWidget(source);
  } catch (error) {
    logger.warn({ err: error }, "canvas widget check threw; showing the widget unverified");
    return { ok: true, submits: /<submit[\s>/]/.test(source) };
  }
}

/** Head of every widget check error, so the model knows nothing reached the user. */
function widgetCheckError(detail: string): string {
  return (
    "Widget source error — the canvas was NOT shown. Fix the widget source and call show again " +
    "(pass the same canvasId if you were refining one). The grammar is in mcp__system__read_manual topic `canvas-widget`.\n" +
    detail
  );
}

const NEVER_WAIT_SENTENCE =
  "On this runtime the tool NEVER waits: it shows the controls and returns at once, and the user's submission arrives as their NEXT message referencing this canvas — so after showing a form, finish your answer (say what you are waiting for) instead of waiting; `wait` is ignored. ";

const controlSchema = z.object({
  type: z
    .enum(["buttons", "text", "select", "slider", "number", "date"])
    .describe(
      "'buttons' = option cards (single/multi); 'select' = dropdown for many options; 'text' = freeform input; " +
        "'slider' = numeric range; 'number' = precise numeric input; 'date' = calendar date (returns 'YYYY-MM-DD').",
    ),
  id: z.string().describe("Stable identifier; becomes the key in the returned submitted-values object."),
  label: z.string().optional().describe("Label shown above the control."),
  options: z
    .array(
      z.object({
        label: z.string().describe("Option text shown to the user."),
        value: z.string().optional().describe("Value reported on submit; defaults to the label."),
        description: z.string().optional().describe("Optional helper text under the option."),
      }),
    )
    .optional()
    .describe("For type='buttons' or 'select': the selectable options."),
  multiSelect: z.boolean().optional().describe("For type='buttons': allow selecting more than one option."),
  placeholder: z.string().optional().describe("For type='text': placeholder text."),
  multiline: z.boolean().optional().describe("For type='text': render a multi-line textarea."),
  min: z.number().optional().describe("For type='slider' or 'number': lower numeric bound."),
  max: z.number().optional().describe("For type='slider' or 'number': upper numeric bound."),
  step: z.number().optional().describe("For type='slider' or 'number': increment step."),
  required: z
    .boolean()
    .optional()
    .describe("Whether the user must fill this control before submitting. Defaults to true; set false to allow skipping it."),
  defaultValue: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Initial value: slider/number start, select preselection, or date initial."),
});

/** Render the user's submitted values back into text the model can read. */
export function formatSubmission(values: Record<string, unknown>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "The user submitted the canvas with no values.";
  }
  const lines = entries.map(([id, value]) => {
    const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return `- ${id}: ${rendered}`;
  });
  return `The user responded on the canvas:\n${lines.join("\n")}`;
}

/** Agent-facing parse-error text: the parser's own detail plus the usual fix. */
export function mermaidSyntaxError(detail: string): string {
  const head =
    "Mermaid syntax error — the canvas was NOT shown. Fix the diagram source and call show again " +
    "(pass the same canvasId if you were refining one).\n" +
    `${detail}\n`;
  if (detail.startsWith("No diagram type detected")) {
    return (
      head +
      "The first line must name a supported diagram type, e.g. `flowchart LR`, `sequenceDiagram`, `classDiagram`, " +
      "`stateDiagram-v2`, `erDiagram`, `gantt`, `pie`, `mindmap`, `timeline`, `gitGraph` (zenuml is not available)."
    );
  }
  return (
    head +
    "Line numbers count from the diagram-type line and skip front matter, %% comment lines and leading blank lines. " +
    "Most common cause: a node or edge label containing ( ) [ ] { } | : ; # or a quote without double quotes around it — " +
    'quote it: A["Login (SSO)"], A -->|"POST /api (json)"| B, and write a literal double quote inside a label as #quot;.'
  );
}

/**
 * Build the canvas tool. INTENTIONALLY NOT self-gated (unlike the owner-only MCP
 * servers): showing UI grants no elevation, the panel is read-only display + form
 * input, and the server only REGISTERS this server when the conversation's canvas
 * tool group is on AND an interactive `events.onCanvas` sink exists (runCapabilities.ts)
 * — that registration gate is the boundary. Same posture as the deliberately
 * ungated avatarDirectory/sshTrust servers; don't add a viewer gate here.
 */
export function buildCanvasTools(ctx: CanvasToolsContext) {
  return [
    tool(
      "show",
      "Show a visual canvas to the user in the chat side panel. Use it to share a diagram, mockup, layout, chart, or option comparison and refine it together — not to repeat text the chat could already render. " +
        "Set contentType to one of: 'markdown' (rich text), 'vega' (a chart — pass ONLY a compact Vega-Lite JSON spec as content; PREFER this for any data chart over hand-drawn SVG, it is far cheaper in tokens — inline the data, keep it small, no remote data URLs), 'mermaid' (a flow/sequence/graph diagram — pass ONLY the diagram source as content; double-quote every node/edge label that contains punctuation such as ( ) [ ] { } | : ; or #, e.g. A[\"Login (SSO)\"] -->|\"POST /api (json)\"| B — the source is syntax-checked before display and a parse error comes back to you to fix), 'svg' (an inline <svg> for bespoke diagrams Vega/mermaid can't express), 'html' (a static page in its own sandboxed frame: its <style> applies there only, scripts never run, links don't open), " +
        "or 'widget' (EXPERIMENTAL — unlike every other type it renders INLINE in your answer, at the point where you call this tool, not in the side panel: something the user operates — a calculator, a what-if comparison, a quiz, a checklist, choices to pick from, a filterable table, a slider-driven chart. Write the text before and after it as ONE answer and do not repeat in prose what the widget shows. It recomputes locally in the user's browser and you are NOT called again on each change — for a chart that is only looked at, use 'vega'. Content is a declarative tag + expression source, never HTML/JS: read mcp__system__read_manual topic `canvas-widget` BEFORE writing one; the source is checked before display and an error comes back to you to fix; `controls`/`editable` do not combine with it — it returns structured values with its own `<submit>`, and a `<button send>` posts the user's next chat message). " +
        "Never include scripts or executable JS in content; it is sanitized away. " +
        "To collect a decision ANCHORED TO the artifact on screen (choosing between the mockups shown, tuning a value against the chart, marking up the content), pass `controls`: 'buttons' (a few choices as cards, single or multiSelect), 'select' (a dropdown when there are many options), 'slider'/'number' (a numeric value, with min/max/step), 'date' (a calendar date), and/or 'text' inputs. Each control is required by default — set `required:false` to make it optional. " +
        "For a plain question or a simple choice with no visual content to show, use the built-in AskUserQuestion tool instead — never open a canvas just to ask something. " +
        NEVER_WAIT_SENTENCE +
        "The client renders real form controls, so when a canvas IS the right surface, do not ask the user to type their choice into chat when controls can capture it. " +
        "Set `editable:true` (best with markdown) to let the user edit or annotate the content and send the edited version back as a new message. " +
        "To REFINE an artifact together with the user, call show again with the SAME `canvasId` (returned to you when you first showed it): it UPDATES that canvas in place (keeping a version the user can roll back to) instead of stacking a new one — don't re-show a slightly changed copy under a new id.",
      {
        title: z.string().describe("Short title shown atop the canvas panel."),
        content: z.string().describe("The artifact body, interpreted per contentType."),
        contentType: z
          .enum(["markdown", "vega", "mermaid", "svg", "html", "widget"])
          .describe("How to render content. Prefer 'vega' (Vega-Lite spec) for charts and 'mermaid' for diagrams — both render rich visuals from a tiny token-cheap source. 'widget' (experimental) is for something the user operates: it renders inline in the answer and recomputes locally; see manual topic `canvas-widget`."),
        controls: z.array(controlSchema).optional().describe("Optional interactive controls to collect a response."),
        canvasId: z
          .string()
          .optional()
          .describe("Reuse a previous canvas's id (returned when you showed it) to UPDATE that canvas in place — for refining an artifact with the user — instead of opening a new panel/tab. Omit to create a new canvas."),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Ignored on this runtime: the canvas never blocks, and the user's submission arrives as their next message referencing this canvas.",
          ),
        editable: z
          .boolean()
          .optional()
          .describe(
            "Allow the user to edit/annotate the content and send the edited version back as a new message. Best with contentType 'markdown'.",
          ),
      },
      async (args) => {
        const isWidget = args.contentType === "widget";
        // Self-gate: the static catalog always lists 'widget', so only this
        // handler knows whether the avatar owner enabled it. Checked first — an
        // avatar without the feature should hear that, not a syntax error.
        if (isWidget && !ctx.widgetEnabled) {
          return text(WIDGET_DISABLED_ERROR, true);
        }
        if (args.content.length > MAX_CANVAS_CONTENT_CHARS) {
          return text(
            `Canvas content is too large (${args.content.length} chars; limit ${MAX_CANVAS_CONTENT_CHARS}). ` +
              (isWidget
                ? "Compact it: inline less data (keep only the rows the widget needs), move repeated values into `{@const}`, drop decoration, or split it across smaller canvases — then call show again."
                : "Compact it: for a chart prefer a 'vega' Vega-Lite spec over hand-written SVG, drop inline data you don't need, or split it across smaller canvases — then call show again."),
            true,
          );
        }
        if (args.title.length > MAX_CANVAS_TITLE_CHARS) {
          return text(`Canvas title is too long (limit ${MAX_CANVAS_TITLE_CHARS} chars). Use a short title.`, true);
        }
        const controls = (args.controls ?? []) as CanvasControl[];
        if (isWidget && controls.length > 0) {
          return text(WIDGET_CONTROLS_ERROR, true);
        }
        if (isWidget && args.editable) {
          return text(WIDGET_EDITABLE_ERROR, true);
        }
        if (controls.length > MAX_CANVAS_CONTROLS) {
          return text(`Too many controls (${controls.length}; limit ${MAX_CANVAS_CONTROLS}). Show fewer at once.`, true);
        }
        // Per-control semantic validation, returned as actionable agent-facing
        // errors so the model can fix the spec and call show again.
        const seenIds = new Set<string>();
        for (const c of controls) {
          if (seenIds.has(c.id)) {
            return text(`Duplicate control id '${c.id}'. Each control needs a unique id (it is the submitted-values key).`, true);
          }
          seenIds.add(c.id);
          if ((c.type === "buttons" || c.type === "select") && !(c.options && c.options.length > 0)) {
            return text(`Control '${c.id}' (type '${c.type}') needs a non-empty 'options' array.`, true);
          }
          if (
            (c.type === "slider" || c.type === "number") &&
            typeof c.min === "number" &&
            typeof c.max === "number" &&
            c.min > c.max
          ) {
            return text(`Control '${c.id}' has min (${c.min}) greater than max (${c.max}).`, true);
          }
        }
        // The client renders mermaid, so without this a parse error was a banner
        // only the user saw. Fail-open: only a real parse verdict rejects.
        if (args.contentType === "mermaid") {
          const check = await checkMermaidSyntax(args.content);
          if (check.ok === false) {
            return text(mermaidSyntaxError(check.error), true);
          }
        }
        // A widget is parsed + statically checked before display (the mermaid #69
        // rule): a silent client-side failure is an error only the user sees.
        let widgetSubmits = false;
        if (isWidget) {
          const check = checkWidgetSource(args.content);
          if (check.ok === false) {
            return text(widgetCheckError(check.error), true);
          }
          widgetSubmits = check.submits;
        }
        // Never blocking (design D8): controls render async and the user's answer
        // arrives later as a new chat turn. A widget's `<submit>` rides the same
        // async path (`canvasSubmission.values`).
        const interaction: "async" | undefined = controls.length > 0 || widgetSubmits ? "async" : undefined;
        const editable = Boolean(args.editable);
        const artifactId = args.canvasId?.trim() || crypto.randomUUID();
        const result = await ctx.emitCanvas({
          artifactId,
          title: args.title,
          content: args.content,
          contentType: args.contentType,
          // Pass controls WHENEVER present so async forms render too (not just blocking).
          controls: controls.length > 0 ? controls : undefined,
          awaitInput: false,
          interaction,
          editable,
        });
        const idNote = ` (canvas id: ${artifactId} — pass as canvasId to refine this canvas in place)`;
        if (result.behavior === "submitted") {
          return text(formatSubmission(result.values) + `\n${idNote.trim()}`);
        }
        if (result.behavior === "cancelled") {
          return text(`The user dismissed the canvas without responding. Proceed without a selection.${idNote}`);
        }
        if (isWidget) {
          return text(
            "The widget was shown INLINE in your answer, at this point of the text (not in the side panel): continue the answer after it and do not repeat in prose what it shows. " +
              "It recomputes locally in the user's browser as they change its inputs — you are NOT called on those changes and cannot see the values they set. " +
              (widgetSubmits
                ? "It has a `<submit>`: when the user presses it, the submitted values arrive as their NEXT message referencing this canvas, so finish your answer now (say what the widget does and what pressing submit sends) instead of waiting."
                : "It has no `<submit>`, so no structured values come back from it (a `<button send>` in it posts the user's next chat message when pressed); if you need the user's result as data, refine the widget with a `<submit values={{ … }}>`.") +
              idNote,
          );
        }
        // Display-only OR async/editable: nothing blocked. Tell the model how the
        // user's later response will arrive so it doesn't wait on this call.
        if (interaction === "async" || editable) {
          return text(
            controls.length > 0
              ? `The canvas was shown with its controls. On this runtime it does not wait: the user's submission arrives as their NEXT message referencing this canvas, so finish your answer now (tell the user what to fill in) instead of waiting.${idNote}`
              : `The canvas was shown with interactive elements but is NOT blocking. The user may submit or edit later; their response will arrive as a new user message referencing this canvas.${idNote}`,
          );
        }
        return text(`The canvas was shown to the user.${idNote}`);
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the canvas tool for one run. */
export function buildCanvasServer(ctx: CanvasToolsContext) {
  return createMcpToolServer({
    name: CANVAS_SERVER_NAME,
    version: "0.1.0",
    tools: buildCanvasTools(ctx),
  });
}
