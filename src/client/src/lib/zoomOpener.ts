// The way into 크게 보기 (lib/zoomViewer.ts, a lazy chunk): whatever shows a
// drawing or a picture keeps ONE of these. It loads the viewer on the first
// press, never opens two for one owner, hands a redraw to the open viewer and
// can take it down again.
import type { ZoomContent, ZoomViewer, ZoomViewerOptions } from "./zoomViewer";

export interface ZoomOpener {
  /**
   * Open the viewer (nothing happens while one is open or on its way).
   * `content` is read when the chunk has LOADED — null then opens nothing — and
   * `options.onClose` runs when the VIEWER closes it, not for `close()` below.
   */
  open(content: () => ZoomContent | null, options?: ZoomViewerOptions): void;
  /** Hand the open viewer a redraw; nothing when it is not open. */
  update(content: ZoomContent): void;
  /** Take the viewer down (or call off one still loading), without `onClose`. */
  close(): void;
  readonly isOpen: boolean;
}

export function zoomOpener(): ZoomOpener {
  let viewer: ZoomViewer | null = null;
  let loading = false;
  /** Bumped by `close`: a chunk that lands after it opens nothing. */
  let request = 0;
  let quiet = false;
  return {
    open(content, options = {}) {
      if (viewer || loading) return;
      const mine = ++request;
      loading = true;
      void import("./zoomViewer").then(
        ({ openZoomViewer }) => {
          loading = false;
          if (mine !== request) return;
          const now = content();
          if (!now) return;
          viewer = openZoomViewer(now, {
            ...options,
            onClose: () => {
              viewer = null;
              if (!quiet) options.onClose?.();
            },
          });
        },
        () => {
          // The chunk did not load: nothing opens, and the next press tries again.
          loading = false;
        },
      );
    },
    update(content) {
      viewer?.update(content);
    },
    close() {
      request += 1;
      if (!viewer) return;
      quiet = true;
      try {
        viewer.close();
      } finally {
        quiet = false;
      }
    },
    get isOpen() {
      return viewer !== null;
    },
  };
}
