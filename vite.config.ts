import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:48787",
      "/users": "http://localhost:48787",
      "/fonts": "http://localhost:48787",
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
