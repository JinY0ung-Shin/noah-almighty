import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// NOAH_CLIENT=react serves (and builds) the React app from `/` instead of the
// Svelte one, so the browser specs and a full-stack run can be pointed at the
// port without a second set of URLs. Unset = the Svelte app, as shipped.
const reactAtRoot = process.env.NOAH_CLIENT === "react";

// The React plugin's dev-server preamble (Fast Refresh) is normally an INLINE
// <script> added to every HTML page — which the app's CSP (`script-src 'self'`)
// blocks, and which the browser specs that run under that CSP count as a
// violation. So the HTML injection is dropped and main.react.tsx imports the
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
  // Both compilers while the client moves from Svelte to React: `index.html`
  // is still the Svelte app (the one `vite build` ships); `react.html` is the
  // React app as far as it has been ported — dev server only, same hash routes
  // (http://localhost:5173/react.html#/chat).
  plugins: [
    svelte(),
    reactPlugins(),
    reactAtRoot && {
      name: "noah-react-at-root",
      transformIndexHtml: {
        order: "pre" as const,
        handler: (html: string, ctx: { path: string }) =>
          ctx.path.endsWith("/index.html") ? html.replace("/src/main.ts", "/src/main.react.tsx") : html,
      },
    },
  ],
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
