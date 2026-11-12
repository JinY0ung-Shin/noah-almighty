import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The React plugin's dev-server preamble (Fast Refresh) is normally an INLINE
// <script> added to every HTML page — which the app's CSP (`script-src 'self'`)
// blocks, and which the browser specs that run under that CSP count as a
// violation. So the HTML injection is dropped and main.tsx imports the
// same preamble as a module instead (`@vitejs/plugin-react/preamble`, empty in a
// production build).
function reactPlugins() {
  return react({ include: /\.tsx$/ }).map((plugin) =>
    plugin.name === "vite:react-refresh" ? { ...plugin, transformIndexHtml: undefined } : plugin,
  );
}

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  plugins: [reactPlugins()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:48787",
      "/users": "http://localhost:48787",
      "/fonts": "http://localhost:48787",
      // pi-gateway's admin panel, served by Noah (routes/piAdminProxy.ts).
      "/admin": "http://localhost:48787",
      "/settings/pi": "http://localhost:48787",
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    // Mermaid is loaded only when a Mermaid canvas is opened. Its upstream
    // @mermaid-js/parser ships one pre-bundled 596 kB module (about 138 kB gzip),
    // which Rolldown cannot split further at module boundaries. Keep warnings
    // meaningful for every other chunk while allowing that verified lazy module.
    chunkSizeWarningLimit: 650,
  },
});
