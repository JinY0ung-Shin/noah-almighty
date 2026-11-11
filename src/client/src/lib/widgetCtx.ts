// What a canvas widget's components need from the view that hosts them. A new
// object is built whenever one of its fields changes (Svelte legacy mode tracks
// a prop, not what a helper reads), so components may read it in their markup.
export interface WidgetCtx {
  /** Run a widget handler as an EVENT (setters and `copy` act only then). */
  fire(handler: unknown, args: unknown[]): void;
  /** Send a `<submit>`'s values to the avatar. */
  submit(values: unknown): void;
  /** A submit cannot go out right now (the avatar is answering, or one is in flight). */
  locked: boolean;
  /** The id of the status line that says why, for `aria-describedby`. */
  statusId: string;
  /** Dark theme in effect — charts bake their colors in. */
  dark: boolean;
  /** A DOM id unique to this view for a node key (the panel and fullscreen copies must not collide). */
  domId(key: string): string;
}
