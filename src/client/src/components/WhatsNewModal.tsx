// NOT PORTED YET — replace with the React port of WhatsNewModal.svelte.
import type { ReleaseNote } from "../../../server/releaseNotes";

export interface WhatsNewModalProps {
  /** Unseen release entries, newest first (App computes via unseenReleases). */
  releases: ReleaseNote[];
  onClose?: () => void;
}

export default function WhatsNewModal(_props: WhatsNewModalProps) {
  return null;
}
