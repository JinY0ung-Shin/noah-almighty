/**
 * Inline UI — the shared library (prompt/manual text + static check + client runtime).
 * The directory keeps its name (`widget`) from when this was a canvas content type.
 *
 * Server:  `inlineUiPromptSpec()`, `widgetComponentReference()` and `checkWidget(source)`.
 * Client:  `parseWidget` → `restoreState`/`initialState` → `createRootEnv` →
 *          walk `doc.nodes` with `resolveProps` / `childScope` / `eachScopes` /
 *          `pickBranch` / `interpolate`, and `invokeHandler` for events.
 *
 * The parser and interpreter are ported from mireiffe/mirineereum
 * (src/lib/genui @ 0e469c4) with the owner's permission; see each file's header.
 */
export { checkWidget, widgetProblems, MAX_WIDGET_NODES, MAX_WIDGET_STATES, type WidgetCheck } from "./check.js";
export { CHART_SPEC_RETIRED, MAX_CHART_ROWS, MAX_CHART_SERIES, simpleChartModel, type SimpleChartModel, type SimpleChartRead } from "./chart.js";
export { INLINE_UI_TAG_NAMES, containsInlineUi, inlineUiPlainText } from "./detect.js";
export { INLINE_UI_MANUAL_TOPIC, INLINE_UI_REPORT_TITLE, inlineUiPromptSpec, widgetComponentBrief } from "./guide.js";
export {
  WIDGET_COMPONENTS,
  WIDGET_TAGS,
  componentSpec,
  emptyValue,
  normalizeProps,
  widgetComponentReference,
  MAX_OPTIONS,
  MAX_SEND_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type ChildKind,
  type ComponentGroup,
  type ComponentSpec,
  type PropSpec,
  type PropType,
  type WidgetColumn,
  type WidgetOption,
} from "./spec.js";
export {
  parseAnswer,
  parseWidget,
  lineCol,
  MAX_ANSWER_SOURCE_CHARS,
  type AnswerDoc,
  setterName,
  MAX_TEMPLATE_NESTING,
  MAX_WIDGET_SOURCE_CHARS,
  type Attr,
  type ConstNode,
  type EachNode,
  type ElNode,
  type ExprNode,
  type IfNode,
  type StateDecl,
  type TextNode,
  type TNode,
  type WidgetDoc,
  type WidgetProblem,
} from "./template.js";
export {
  Env,
  GLOBAL_NAMES,
  MAX_ALLOC,
  MAX_ARR,
  MAX_DEPTH,
  MAX_EVAL_NESTING,
  MAX_OUT_CHARS,
  MAX_OUT_ELEMENTS,
  MAX_RENDER_STEPS,
  MAX_STEPS,
  MAX_STR,
  NOOP_HANDLER,
  WidgetBudgetError,
  WidgetRuntimeError,
  beginRender,
  chargeOutput,
  createRuntime,
  dataSize,
  evaluate,
  invokeHandler,
  isPlainData,
  resetBudget,
  sanitizeData,
  toStr,
  type HandlerResult,
  type Runtime,
} from "./interp.js";
export {
  MAX_COPY_CHARS,
  MAX_EACH_ITEMS,
  MAX_SUBMIT_CHARS,
  MAX_SUBMIT_KEYS,
  childScope,
  createRootEnv,
  eachScopes,
  initialState,
  interpolate,
  normalizeSubmitValues,
  pickBranch,
  resolveProps,
  restoreState,
  snapshotState,
  type StoredState,
  type SubmitValue,
  type SubmitValues,
  type WidgetHost,
} from "./runtime.js";
export {
  ALIGN,
  BACKGROUND_TOKENS,
  COLOR_TOKENS,
  JUSTIFY,
  MAX_SPACING_UNITS,
  MAX_URL_CHARS,
  SVG_PAINT_TOKENS,
  TONE_TOKENS,
  UNIT_PX,
  background,
  bool,
  clamp,
  conversationImageRef,
  lineColor,
  safeLinkUrl,
  spacing,
  svgPaintToken,
  textColor,
} from "./style.js";
export { dedent, displayText, jsxWhitespace, unescapeText } from "./text.js";
export { WIDGET_ICON_NAMES, WIDGET_ICON_SIZES } from "./icons.js";
export {
  MAX_SVG_CHARS,
  MAX_SVG_COORD,
  MAX_SVG_NODES,
  MAX_SVG_PATH_CHARS,
  SVG_ELEMENTS,
  SVG_REF_TARGETS,
  SVG_TAGS,
  svgAttrKind,
  svgAttrValue,
  svgElementProblem,
  svgElementSpec,
  svgReference,
  svgRefProblem,
  type SvgElementSpec,
  type SvgKind,
  type SvgValue,
} from "./svg.js";
export { renderSvg, svgMarkup, type SvgTree } from "./svgRender.js";
export { MAX_AST_DEPTH, MAX_EXPR_CHAIN, MAX_EXPR_NESTING, parseExpression, type Expr, type Pattern } from "./expr.js";
