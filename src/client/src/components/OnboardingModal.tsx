// NOT PORTED YET — replace with the React port of OnboardingModal.svelte.
import type { User } from "../lib/types";

export interface OnboardingModalProps {
  user: User;
  confluenceConfigured?: boolean;
  githubHost?: string;
  onClose?: () => void;
}

export default function OnboardingModal(_props: OnboardingModalProps) {
  return null;
}
