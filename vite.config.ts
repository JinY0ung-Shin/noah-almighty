import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  // Both compilers while the client moves from Svelte to React: `index.html`
  // is still the Svelte app (the one `vite build` ships); `react.html` is the
  // React app as far as it has been ported — dev server only, same hash routes
  // (http://localhost:5173/react.html#/chat).
  plugins: [svelte(), react({ include: /\.tsx$/ })],
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
