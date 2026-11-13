// 관리자 공지 bar — the ONE notice an admin set, across the top of every screen
// (mounted by App.tsx as the first child of <main>; the admin card previews its
// draft with the same component). The text is plain text: React escapes it, and
// nothing here turns it into markup or a link.
import { useEffect, useRef } from "react";
import Icon from "./Icon";
import { cx } from "../lib/hooks";
import { ADMIN_NOTICE_LEVEL_LABELS, type AdminNotice } from "../../../shared/adminNotice";
import "./NoticeBar.css";

export interface NoticeBarProps {
  notice: Pick<AdminNotice, "text" | "level">;
  /** Close for this account. Omitted in the admin card's preview: no button. */
  onDismiss?: () => void;
}

/** Height of the bar on screen, for what is FIXED to the window's top edge (the rail's open button). */
const HEIGHT_VAR = "--notice-bar-height";

export default function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  const preview = !onDismiss;
  const bar = useRef<HTMLElement | null>(null);

  // The rail's open button (phones; a collapsed desktop rail) is fixed to the
  // window's top-left corner, where this bar now is — so the bar publishes its
  // height and the button moves down by it (styles.css `.rail-open-toggle`).
  // A ResizeObserver, not a measurement in the mount commit: the text wraps
  // differently per width, and it reports after layout without forcing one.
  useEffect(() => {
    const element = bar.current;
    if (preview || !element || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight;
      root.style.setProperty(HEIGHT_VAR, `${Math.ceil(height)}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(HEIGHT_VAR);
    };
  }, [preview]);

  return (
    <aside
      ref={bar}
      className={cx("notice-bar cmp-notice-bar", `level-${notice.level}`, preview && "preview")}
      aria-label={preview ? "공지 미리 보기" : "관리자 공지"}
    >
      <span className="notice-bar-icon">
        <Icon name="bell" size={16} />
      </span>
      {/* The level is TEXT as well as a colour. */}
      <strong className="notice-bar-level">{ADMIN_NOTICE_LEVEL_LABELS[notice.level]}</strong>
      {/* A notice that appears while the page is open is announced; an urgent one interrupts. */}
      <p className="notice-bar-text" role={preview ? undefined : notice.level === "urgent" ? "alert" : "status"}>
        {notice.text}
      </p>
      {onDismiss ? (
        <button className="icon-button notice-bar-close" type="button" aria-label="공지 닫기" title="공지 닫기" onClick={onDismiss}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </aside>
  );
}
