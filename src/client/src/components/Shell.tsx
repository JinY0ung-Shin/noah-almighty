// NOT PORTED YET — replace with the React port of Shell.svelte.
import NotPorted from "./NotPorted";
import type { ThemePref } from "../lib/theme";
import type { User, ViewName } from "../lib/types";

export interface ShellProps {
  user: User;
  view: ViewName;
  streaming?: boolean;
  unreadCount?: number;
  themePref?: ThemePref;
  railCollapsed?: boolean;
  onRailCollapsedChange?: (collapsed: boolean) => void;
  onMobileRailOpenChange?: (open: boolean) => void;
}

export default function Shell(_props: ShellProps) {
  return <NotPorted name="Shell" />;
}
