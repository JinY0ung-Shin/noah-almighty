import type { EntranceRule } from "./uiEntrance";

// What the inline UI components need from the view that hosts them. A new
// object is built whenever one of its fields changes (Svelte legacy mode tracks
// a prop, not what a helper reads), so components may read it in their markup.
export interface WidgetCtx {
  /** Run a widget handler as an EVENT (setters and `copy` act only then). */
  fire(handler: unknown, args: unknown[]): void;
  /** A `<submit>` was pressed: its label and values become the viewer's next chat message. */
  submit(values: unknown, label: string): void;
  /** Send a `<button send>`'s text as the viewer's next chat message. */
  send(text: string): void;
  /** Something failed to draw: one short ENGLISH line for the avatar (the render report). */
  report(problem: string): void;
  /** A submit cannot go out right now (the avatar is answering, or one is in flight). */
  locked: boolean;
  /** The id of the status line that says why, for `aria-describedby`. */
  statusId: string;
  /** Dark theme in effect — charts bake their colors in. */
  dark: boolean;
  /**
   * How a thing that appears NOW may play its entrance (lib/uiEntrance.ts): set
   * while the answer is being written (once per thing) and after the viewer
   * changed something in it (everything they bring up). null — an answer opened
   * from the history — draws everything at rest.
   */
  entrance: EntranceRule | null;
  /** A DOM id unique to this view for a node key (two answers on one page must not collide). */
  domId(key: string): string;
}
