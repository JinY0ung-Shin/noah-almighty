import { useRef } from "react";
import ReservedImage, { type PixelSize } from "./ReservedImage";
import { zoomOpener, type ZoomOpener } from "../lib/zoomOpener";
import "./ZoomableImage.css";

interface ZoomableImageProps {
  src: string;
  alt: string;
  /** The viewer's title: the file the picture belongs to. */
  title: string;
  /** The recorded pixel size, when the server has one. */
  size?: PixelSize | null;
  loading?: "lazy" | "eager";
  onError?: () => void;
}

/**
 * A page, a slide or an image of a side-panel tab: fitted to the panel's width
 * like before, and a press opens it in 크게 보기 (lib/zoomViewer.ts) — the
 * panel is too narrow to read a screenshot or a document page in. A real
 * button, so the keyboard gets there too.
 */
export default function ZoomableImage({ src, alt, title, size = null, loading, onError }: ZoomableImageProps) {
  const zoomer = useRef<ZoomOpener | null>(null);
  zoomer.current ??= zoomOpener();
  return (
    <button
      className="cmp-zoomable-image"
      type="button"
      aria-haspopup="dialog"
      aria-label={`${alt} 크게 보기`}
      title="크게 보기"
      onClick={() =>
        zoomer.current?.open(() => ({ image: { src, alt, width: size?.width, height: size?.height } }), { title, label: `${alt} 크게 보기` })
      }
    >
      <ReservedImage src={src} alt={alt} loading={loading} size={size} onError={onError} />
    </button>
  );
}
