// First, before any component module: the dev server's Fast Refresh preamble,
// loaded as a module because the app's CSP allows no inline script (see
// vite.config.ts). Empty in a production build.
import "@vitejs/plugin-react/preamble";
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyMotionPref } from "./lib/motion";
import { initNotifications } from "./lib/notifications";

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app not found");
}

// 움직임 줄이기 is the app's own device-local setting (never the OS's). Applied
// before the first component mounts so no entrance plays for a viewer who
// turned motion down.
applyMotionPref();

// No <StrictMode>: its development-only second run of every effect would boot
// the app twice and re-run effects that consume one-shot state.
createRoot(target).render(<App />);

// Register the minimal service worker that backs OS notifications (answer-complete
// and input-needed). Permission itself is requested later, on a user gesture.
initNotifications();
