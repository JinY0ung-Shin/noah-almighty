import Modal from "./Modal";
import { updateState } from "../lib/state";
import { goView } from "../lib/nav";
import { releaseDateLabel, type ReleaseNote, type ReleaseNoteAction } from "../../../server/releaseNotes";

export interface WhatsNewModalProps {
  /** Unseen release entries, newest first (App computes via unseenReleases). */
  releases: ReleaseNote[];
  onClose?: () => void;
}

// The dependency-free registry carries semantic action IDS; the label and the
// navigation live here. An id this build doesn't know simply renders no
// button (an older client can safely show a newer note).
const ACTION_LABELS: Partial<Record<ReleaseNoteAction, string>> = {
  "browser-guide": "브라우저 확장 설치 가이드 열기 →",
};

// One-time "what's new" notice after a deploy. Every dismissal path (button,
// backdrop, Esc, mobile swipe) funnels through `close`, and App marks the
// release seen server-side — so it can never nag on the next load.
export default function WhatsNewModal({ releases, onClose }: WhatsNewModalProps) {
  function done() {
    onClose?.();
  }

  function runAction(action: ReleaseNoteAction | undefined): void {
    if (!action || !ACTION_LABELS[action]) return;
    // Dismiss through the normal close path first (App marks the release seen),
    // THEN jump — the flag is one-shot state the target tab consumes.
    done();
    if (action === "browser-guide") {
      // Go through goView (like ChatView.openBrowserBridgeGuide) so the hash +
      // history entry stay consistent — a raw updateState left location.hash on
      // the previous route, so reload/Back landed on the wrong view.
      updateState((state) => {
        state.browserGuideRequested = true;
      });
      goView("settings", "access");
    }
  }

  return (
    <Modal cardClass="whats-new-card" ariaLabelledby="whats-new-title" onClose={done}>
      <h2 id="whats-new-title">새로워진 기능</h2>
      <p className="muted">최근 업데이트로 달라진 점을 소개해요.</p>

      {releases.map((release) => (
        <section key={release.id} className="whats-new-release" aria-label={`${releaseDateLabel(release.id)} 업데이트`}>
          <h3>{releaseDateLabel(release.id)}</h3>
          <ul className="whats-new-list">
            {release.items.map((item) => (
              <li key={item.title}>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
                {item.example ? <span className="whats-new-example">{item.example}</span> : null}
                {item.action && ACTION_LABELS[item.action] ? (
                  <button type="button" className="whats-new-action" onClick={() => runAction(item.action)}>
                    {ACTION_LABELS[item.action]}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="whats-new-actions">
        <button className="primary" type="button" data-modal-autofocus="" onClick={done}>
          확인
        </button>
      </div>
    </Modal>
  );
}
