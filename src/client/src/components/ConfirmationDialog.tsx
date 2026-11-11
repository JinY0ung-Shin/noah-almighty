import Modal from "./Modal";
import { confirmation as confirmationStore, resolveConfirmation } from "../lib/confirm";
import { cx, useStore } from "../lib/hooks";
import { Presence } from "../lib/presence";

export default function ConfirmationDialog() {
  const confirmation = useStore(confirmationStore);
  const lines = confirmation?.message.split("\n").filter(Boolean) ?? [];

  return (
    <Presence>
      {confirmation && (
        <Modal
          key="confirm"
          cardClass="confirm-card"
          ariaLabelledby={`confirm-title-${confirmation.id}`}
          ariaDescribedby={`confirm-copy-${confirmation.id}`}
          onClose={() => resolveConfirmation(false)}
        >
          <div className={cx("confirm-symbol", confirmation.tone === "danger" && "danger")} aria-hidden="true">
            {confirmation.tone === "danger" ? "!" : "✓"}
          </div>
          <div className="confirm-content">
            <h2 id={`confirm-title-${confirmation.id}`}>{confirmation.title}</h2>
            <div id={`confirm-copy-${confirmation.id}`} className="confirm-copy">
              {lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </div>
          <div className="confirm-actions">
            <button className="ghost-sm" type="button" data-modal-autofocus="" onClick={() => resolveConfirmation(false)}>
              {confirmation.cancelLabel}
            </button>
            <button
              className={confirmation.tone === "danger" ? "confirm-danger" : "primary"}
              type="button"
              onClick={() => resolveConfirmation(true)}
            >
              {confirmation.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </Presence>
  );
}
