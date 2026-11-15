import { useState, type ImgHTMLAttributes } from "react";
import "./ReservedImage.css";

/** An image's pixel size, as the server read it from the stored bytes' header. */
export interface PixelSize {
  width: number;
  height: number;
}

/** Bigger than anything the server stores; a value past it is noise, not a size. */
const MAX_EDGE = 100_000;

/**
 * A size worth laying out with, or null. The values ride stored JSON (an
 * attachment row, a preview answer), so anything that is not a positive whole
 * number in range — an older row's absence included — reads as "unknown".
 */
export function knownImageSize(width: unknown, height: unknown): PixelSize | null {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_EDGE;
  return ok(width) && ok(height) ? { width, height } : null;
}

/**
 * The box a `max-width`/`max-height` pair would shrink `size` into, never
 * enlarged — what the browser draws for a thumbnail once the image has loaded,
 * computed up front so the attributes reserve exactly that box.
 */
export function fitImageSize(size: PixelSize, maxWidth: number, maxHeight: number): PixelSize {
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** `.msg-image`'s max-width AND max-height (styles/20-shell-chat.css) — keep the two in step. */
export const CHAT_THUMB_MAX_PX = 240;

/** The box a chat image attachment's thumbnail takes, or null when its size was not recorded. */
export function chatThumbSize(att: { width?: unknown; height?: unknown }): PixelSize | null {
  const size = knownImageSize(att.width, att.height);
  return size ? fitImageSize(size, CHAT_THUMB_MAX_PX, CHAT_THUMB_MAX_PX) : null;
}

type ReservedImageProps =Omit<ImgHTMLAttributes<HTMLImageElement>, "width" | "height"> & {
  /** The size to reserve, or null/absent when it is not known. */
  size?: PixelSize | null;
};

/**
 * An `<img>` that holds its box BEFORE its bytes arrive, so a picture loading
 * into the transcript (or a side-panel tab) does not push everything below it.
 *
 * - Size known: `width`/`height` attributes; the stylesheet adds `height: auto`,
 *   so the attributes act as the aspect ratio and the image still scales down
 *   with its container's `max-width`.
 * - Size unknown (rows stored before the server recorded sizes, a workspace
 *   file): the image is marked `data-pending` until it loads or fails, and the
 *   surface's stylesheet reserves a placeholder box for that state only.
 *
 * Decoding is async by default: a large picture never blocks the frame that
 * lays out the rest of the transcript.
 */
export default function ReservedImage({ size, className, decoding = "async", onLoad, onError, ...rest }: ReservedImageProps) {
  const [settled, setSettled] = useState(false);
  const pending = !size && !settled;
  return (
    <img
      {...rest}
      className={className ? `cmp-reserved-image ${className}` : "cmp-reserved-image"}
      decoding={decoding}
      width={size?.width}
      height={size?.height}
      data-pending={pending ? "" : undefined}
      onLoad={(event) => {
        setSettled(true);
        onLoad?.(event);
      }}
      onError={(event) => {
        setSettled(true);
        onError?.(event);
      }}
    />
  );
}
